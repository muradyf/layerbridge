/**
 * Layered layout for generate_diagram, in the Sugiyama style:
 *
 *   1. break cycles by reversing DFS back edges,
 *   2. rank by longest path, then pull each source down next to its children,
 *   3. order each rank by barycentre sweeps, keeping the order with the fewest
 *      crossings between adjacent ranks,
 *   4. keep every subgraph in its own band across the ranks, so a section's
 *      rectangle never covers a node that is not in it,
 *   5. size ranks and bands from each node's estimated text size.
 *
 * Figma-free so it runs under `bun test`. Coordinates start at 0,0.
 */
import type { Direction, FlowNode, Flowchart, NodeShape } from "./mermaid";

export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };
export type NodePlacement = Box & { rank: number; order: number };
export type SectionPlacement = Box & { depth: number };

export type DiagramLayout = {
  direction: Direction;
  nodes: Record<string, NodePlacement>;
  sections: Record<string, SectionPlacement>;
  /** Node ids per rank, in drawing order. */
  ranks: string[][];
  /** Crossings between edges of adjacent ranks, after ordering. */
  crossings: number;
  width: number;
  height: number;
};

export const SPACING = {
  nodeGap: 56,
  rankGap: 96,
  /** Extra rank gap when any edge carries a label. */
  labelGap: 48,
  sectionPad: 32,
  sectionTitle: 40,
};

const SWEEPS = 16;

export function wrapLabel(label: string, maxChars = 28): string[] {
  const lines: string[] = [];
  for (const paragraph of label.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Rough size for a FigJam shape holding this label at its default text size. */
export function estimateNodeSize(label: string, shape: NodeShape): Size {
  const lines = wrapLabel(label);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  let width = Math.min(400, Math.max(144, longest * 9 + 56));
  let height = Math.max(80, lines.length * 24 + 48);
  switch (shape) {
    case "diamond":
      width *= 1.5;
      height *= 1.5;
      break;
    case "circle":
    case "doubleCircle":
      width = height = Math.max(width, height);
      break;
    case "hexagon":
    case "parallelogram":
    case "parallelogramAlt":
    case "trapezoid":
    case "trapezoidAlt":
    case "asymmetric":
      width *= 1.25;
      break;
    case "cylinder":
      height += 24;
      break;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

type Item = { kind: "cluster"; id: string } | { kind: "loose" };

export function layoutFlowchart(
  chart: Flowchart,
  sizeOf: (node: FlowNode) => Size = (node) => estimateNodeSize(node.label, node.shape)
): DiagramLayout {
  const direction = chart.direction;
  const ids = chart.nodes.map((node) => node.id);
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const sizes = chart.nodes.map((node) => sizeOf(node));

  /* 1. edges between two distinct nodes, cycles broken */
  const out: number[][] = Array.from({ length: n }, () => []);
  const seenPair = new Set<string>();
  const hasIncoming = new Array<boolean>(n).fill(false);
  for (const edge of chart.edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b || seenPair.has(`${a}>${b}`)) continue;
    seenPair.add(`${a}>${b}`);
    out[a].push(b);
    hasIncoming[b] = true;
  }

  const preds: number[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  const state = new Uint8Array(n); // 0 unvisited, 1 on the DFS stack, 2 finished
  const addDag = (a: number, b: number) => {
    if (succs[a].includes(b)) return;
    succs[a].push(b);
    preds[b].push(a);
  };
  const visit = (u: number) => {
    state[u] = 1;
    for (const v of out[u]) {
      if (state[v] === 1) addDag(v, u);
      else {
        addDag(u, v);
        if (state[v] === 0) visit(v);
      }
    }
    state[u] = 2;
  };
  // Start from true sources so the reversed edges are the ones that loop back.
  for (let u = 0; u < n; u++) if (!hasIncoming[u] && state[u] === 0) visit(u);
  for (let u = 0; u < n; u++) if (state[u] === 0) visit(u);

  /* 2. ranks */
  const rank = new Array<number>(n).fill(0);
  const indegree = preds.map((p) => p.length);
  const queue: number[] = [];
  for (let u = 0; u < n; u++) if (indegree[u] === 0) queue.push(u);
  const topo: number[] = [];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    topo.push(u);
    for (const v of succs[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (--indegree[v] === 0) queue.push(v);
    }
  }
  for (const u of topo) {
    if (preds[u].length === 0 && succs[u].length > 0) {
      rank[u] = Math.min(...succs[u].map((v) => rank[v])) - 1;
    }
  }
  const minRank = n ? Math.min(...rank) : 0;
  for (let u = 0; u < n; u++) rank[u] -= minRank;
  const rankCount = n ? Math.max(...rank) + 1 : 0;

  /* 3. order within ranks */
  let layers: number[][] = Array.from({ length: rankCount }, () => []);
  for (let u = 0; u < n; u++) layers[rank[u]].push(u);

  const pos = new Float64Array(n);
  const refresh = (ls: number[][]) =>
    ls.forEach((layer) => layer.forEach((u, i) => (pos[u] = (i + 0.5) / layer.length)));

  const countCrossings = (ls: number[][]): number => {
    const order = new Int32Array(n);
    ls.forEach((layer) => layer.forEach((u, i) => (order[u] = i)));
    let crossings = 0;
    for (let r = 0; r + 1 < ls.length; r++) {
      const segs: Array<[number, number]> = [];
      for (const u of ls[r]) for (const v of succs[u]) if (rank[v] === r + 1) segs.push([order[u], order[v]]);
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) crossings++;
        }
      }
    }
    return crossings;
  };

  refresh(layers);
  let best = layers.map((l) => [...l]);
  let bestCrossings = countCrossings(layers);
  for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep++) {
    const down = sweep % 2 === 0;
    for (let step = 0; step < rankCount; step++) {
      const r = down ? step : rankCount - 1 - step;
      const neighbours = down ? preds : succs;
      const bary = new Map<number, number>();
      for (const u of layers[r]) {
        const ns = neighbours[u];
        bary.set(u, ns.length ? ns.reduce((sum, v) => sum + pos[v], 0) / ns.length : pos[u]);
      }
      layers[r].sort((a, b) => bary.get(a)! - bary.get(b)! || pos[a] - pos[b]);
      layers[r].forEach((u, i) => (pos[u] = (i + 0.5) / layers[r].length));
    }
    const crossings = countCrossings(layers);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = layers.map((l) => [...l]);
    }
  }
  layers = best;
  refresh(layers);

  /* 4. subgraph bands */
  const subgraphs = new Map(chart.subgraphs.map((s) => [s.id, s]));
  const clusterOf = (u: number): string | null => {
    const sg = chart.nodes[u].subgraph;
    return sg && subgraphs.has(sg) ? sg : null;
  };
  const directNodes = new Map<string | null, number[]>();
  for (let u = 0; u < n; u++) {
    const key = clusterOf(u);
    if (!directNodes.has(key)) directNodes.set(key, []);
    directNodes.get(key)!.push(u);
  }
  const childClusters = new Map<string | null, string[]>();
  for (const sg of chart.subgraphs) {
    const key = sg.parent && subgraphs.has(sg.parent) ? sg.parent : null;
    if (!childClusters.has(key)) childClusters.set(key, []);
    childClusters.get(key)!.push(sg.id);
  }
  const descendantMemo = new Map<string | null, number[]>();
  const descendants = (c: string | null): number[] => {
    if (!descendantMemo.has(c)) {
      const all = [...(directNodes.get(c) ?? [])];
      for (const child of childClusters.get(c) ?? []) all.push(...descendants(child));
      descendantMemo.set(c, all);
    }
    return descendantMemo.get(c)!;
  };
  const liveChildren = (c: string | null) => (childClusters.get(c) ?? []).filter((k) => descendants(k).length > 0);
  const heightMemo = new Map<string | null, number>();
  const heightBelow = (c: string | null): number => {
    if (!heightMemo.has(c)) {
      const kids = liveChildren(c);
      heightMemo.set(c, kids.length ? 1 + Math.max(...kids.map(heightBelow)) : 0);
    }
    return heightMemo.get(c)!;
  };
  const mean = (us: number[]) => us.reduce((s, u) => s + pos[u], 0) / us.length;
  const itemsMemo = new Map<string | null, Item[]>();
  const itemsOf = (c: string | null): Item[] => {
    if (!itemsMemo.has(c)) {
      const keyed: Array<{ item: Item; key: number }> = liveChildren(c).map((id) => ({
        item: { kind: "cluster", id },
        key: mean(descendants(id)),
      }));
      const direct = directNodes.get(c) ?? [];
      if (direct.length) keyed.push({ item: { kind: "loose" }, key: mean(direct) });
      keyed.sort((a, b) => a.key - b.key);
      itemsMemo.set(c, keyed.map((k) => k.item));
    }
    return itemsMemo.get(c)!;
  };

  // Regroup each rank so a cluster's nodes are contiguous and clusters keep
  // one order across all ranks.
  const byRank = layers.map((layer) => new Set(layer));
  const orderIndex = new Map<number, number>();
  layers.forEach((layer) => layer.forEach((u, i) => orderIndex.set(u, i)));
  const regroup = (c: string | null, r: number, into: number[]) => {
    for (const item of itemsOf(c)) {
      if (item.kind === "cluster") regroup(item.id, r, into);
      else {
        into.push(
          ...(directNodes.get(c) ?? [])
            .filter((u) => byRank[r].has(u))
            .sort((a, b) => orderIndex.get(a)! - orderIndex.get(b)!)
        );
      }
    }
  };
  layers = layers.map((_, r) => {
    const into: number[] = [];
    regroup(null, r, into);
    return into;
  });

  /* 5. coordinates */
  const horizontal = direction === "LR" || direction === "RL";
  const across = (u: number) => (horizontal ? sizes[u].height : sizes[u].width);
  const along = (u: number) => (horizontal ? sizes[u].width : sizes[u].height);
  const pad = (c: string | null) => (c === null ? 0 : SPACING.sectionPad * (1 + heightBelow(c)));
  const title = (c: string | null) => (c === null ? 0 : SPACING.sectionTitle * (1 + heightBelow(c)));
  // The title sits at the top in screen space, which is the across axis only
  // when ranks run horizontally.
  const padStart = (c: string | null) => pad(c) + (horizontal ? title(c) : 0);
  const gap = SPACING.nodeGap;

  const looseWidth = (c: string | null) => {
    let widest = 0;
    for (const layer of layers) {
      const here = layer.filter((u) => clusterOf(u) === c);
      if (!here.length) continue;
      widest = Math.max(widest, here.reduce((s, u) => s + across(u), 0) + gap * (here.length - 1));
    }
    return widest;
  };
  const bandMemo = new Map<string | null, number>();
  const bandWidth = (c: string | null): number => {
    if (!bandMemo.has(c)) {
      const items = itemsOf(c);
      const inner =
        items.reduce((s, item) => s + (item.kind === "cluster" ? bandWidth(item.id) : looseWidth(c)), 0) +
        gap * Math.max(0, items.length - 1);
      bandMemo.set(c, padStart(c) + inner + pad(c));
    }
    return bandMemo.get(c)!;
  };

  const acrossPos = new Float64Array(n);
  const place = (c: string | null, start: number) => {
    let cursor = start + padStart(c);
    for (const item of itemsOf(c)) {
      if (item.kind === "cluster") {
        place(item.id, cursor);
        cursor += bandWidth(item.id) + gap;
        continue;
      }
      const width = looseWidth(c);
      for (const layer of layers) {
        const here = layer.filter((u) => clusterOf(u) === c);
        const total = here.reduce((s, u) => s + across(u), 0) + gap * Math.max(0, here.length - 1);
        let x = cursor + (width - total) / 2;
        for (const u of here) {
          acrossPos[u] = x;
          x += across(u) + gap;
        }
      }
      cursor += width + gap;
    }
  };
  place(null, 0);

  const rankGap = SPACING.rankGap + (chart.edges.some((e) => e.label) ? SPACING.labelGap : 0);
  const laneSize = layers.map((layer) => Math.max(0, ...layer.map(along)));
  const laneStart: number[] = [];
  laneSize.forEach((_, r) => laneStart.push(r === 0 ? 0 : laneStart[r - 1] + laneSize[r - 1] + rankGap));

  const boxes: Box[] = [];
  for (let u = 0; u < n; u++) {
    const a = laneStart[rank[u]] + (laneSize[rank[u]] - along(u)) / 2;
    const c = acrossPos[u];
    const { width, height } = sizes[u];
    if (direction === "TB") boxes[u] = { x: c, y: a, width, height };
    else if (direction === "BT") boxes[u] = { x: c, y: -(a + height), width, height };
    else if (direction === "LR") boxes[u] = { x: a, y: c, width, height };
    else boxes[u] = { x: -(a + width), y: c, width, height };
  }

  const sectionBoxes = new Map<string, SectionPlacement>();
  const depthOf = (id: string): number => {
    const parent = subgraphs.get(id)?.parent;
    return parent && subgraphs.has(parent) ? 1 + depthOf(parent) : 0;
  };
  for (const sg of chart.subgraphs) {
    const members = descendants(sg.id);
    if (!members.length) continue;
    const minX = Math.min(...members.map((u) => boxes[u].x));
    const minY = Math.min(...members.map((u) => boxes[u].y));
    const maxX = Math.max(...members.map((u) => boxes[u].x + boxes[u].width));
    const maxY = Math.max(...members.map((u) => boxes[u].y + boxes[u].height));
    const p = pad(sg.id);
    const t = title(sg.id);
    sectionBoxes.set(sg.id, {
      x: minX - p,
      y: minY - p - t,
      width: maxX - minX + 2 * p,
      height: maxY - minY + 2 * p + t,
      depth: depthOf(sg.id),
    });
  }

  const all: Box[] = [...boxes, ...sectionBoxes.values()];
  const shiftX = all.length ? Math.min(...all.map((b) => b.x)) : 0;
  const shiftY = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  const snap = (b: Box): Box => ({
    x: Math.round(b.x - shiftX),
    y: Math.round(b.y - shiftY),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });

  const nodes: Record<string, NodePlacement> = {};
  const finalOrder = new Map<number, number>();
  layers.forEach((layer) => layer.forEach((u, i) => finalOrder.set(u, i)));
  for (let u = 0; u < n; u++) nodes[ids[u]] = { ...snap(boxes[u]), rank: rank[u], order: finalOrder.get(u)! };
  const sections: Record<string, SectionPlacement> = {};
  for (const [id, box] of sectionBoxes) sections[id] = { ...snap(box), depth: box.depth };

  const snapped: Box[] = [...Object.values(nodes), ...Object.values(sections)];
  return {
    direction,
    nodes,
    sections,
    ranks: layers.map((layer) => layer.map((u) => ids[u])),
    crossings: countCrossings(layers),
    width: snapped.length ? Math.max(...snapped.map((b) => b.x + b.width)) : 0,
    height: snapped.length ? Math.max(...snapped.map((b) => b.y + b.height)) : 0,
  };
}
