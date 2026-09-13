/**
 * FigJam tools: read a board, create stickies, shapes, connectors, tables and
 * code blocks, and draw a Mermaid flowchart. Slides tools live in ./slides and
 * are dispatched from here so the module registers once.
 *
 * Every tool refuses to run outside FigJam (see ./editors) because the Plugin
 * API calls it needs only exist there.
 */
import { layoutFlowchart } from "./diagramLayout";
import { FIGJAM_TOOLS, SLIDES_TOOLS, editorRefusal } from "./editors";
import { arr, bool, need, num, ok, parentOf, requireEditor, solidPaint, str, toHex, type Request, type Response } from "./features";
import { clip, nearestColorName, resolvePaletteColor, tableCells } from "./boardsPure";
import { parseMermaid, type Direction, type EdgeHead, type NodeShape } from "./mermaid";
import { postProgress, resolveSceneNode, withTimeout, yieldToFigma } from "./robust";
import { handleSlidesRequest } from "./slides";

const MAX_DIAGRAM_NODES = 300;
const MAX_DIAGRAM_EDGES = 600;

type FontCache = Set<string>;

const figjamPalette = (): Record<string, string> => {
  try {
    return { ...figma.constants.colors.figJamBase };
  } catch {
    return {};
  }
};

const paintFrom = (input: string): SolidPaint => {
  const palette = figjamPalette();
  const hex = resolvePaletteColor(input, palette);
  if (!hex) {
    throw new Error(`Unknown colour "${input}". Use a hex colour or a FigJam colour: ${Object.keys(palette).join(", ")}`);
  }
  return solidPaint(hex);
};

const loadFont = async (font: FontName, cache: FontCache) => {
  const key = `${font.family}::${font.style}`;
  if (cache.has(key)) return;
  await withTimeout(figma.loadFontAsync(font), 15_000, `Loading font ${font.family} ${font.style}`);
  cache.add(key);
};

/** Sets the text inside a sticky, shape, connector label or table cell. */
const setText = async (layer: TextSublayerNode, text: string, cache: FontCache) => {
  if (layer.fontName !== figma.mixed) await loadFont(layer.fontName as FontName, cache);
  else for (const font of layer.getRangeAllFontNames(0, layer.characters.length)) await loadFont(font, cache);
  layer.characters = text;
};

const fillHex = (node: BaseNode): string | undefined => {
  const fills = (node as Partial<MinimalFillsMixin>).fills;
  if (!Array.isArray(fills)) return undefined;
  const solid = (fills as Paint[]).find((f) => f.type === "SOLID" && f.visible !== false) as SolidPaint | undefined;
  return solid ? toHex(solid.color) : undefined;
};

const bounds = (node: SceneNode) => {
  const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  return box
    ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    : {};
};

const endpoint = (end: ConnectorEndpoint) => ({
  ...("endpointNodeId" in end ? { nodeId: end.endpointNodeId } : {}),
  ...("magnet" in end ? { magnet: end.magnet } : {}),
  ...("position" in end ? { position: end.position } : {}),
});

/** Appends to parentId if given; with no position and no parent, centres in the viewport. */
const place = async (node: SceneNode, p: Record<string, unknown>) => {
  const parentId = str(p.parentId);
  if (parentId) (await parentOf(parentId)).appendChild(node);
  const x = num(p.x);
  const y = num(p.y);
  if (x === undefined && y === undefined && !parentId) {
    const center = figma.viewport.center;
    node.x = Math.round(center.x - node.width / 2);
    node.y = Math.round(center.y - node.height / 2);
    return;
  }
  if (x !== undefined) node.x = x;
  if (y !== undefined) node.y = y;
};

const created = (node: SceneNode, extra: Record<string, unknown> = {}) => ({
  nodeId: node.id,
  type: node.type,
  parentId: node.parent?.id,
  x: node.x,
  y: node.y,
  width: node.width,
  height: node.height,
  ...extra,
});

/** Runs `build` on a fresh node and removes the node again if it throws. */
const creating = async <T extends SceneNode>(node: T, build: (node: T) => Promise<void>): Promise<T> => {
  try {
    await build(node);
    return node;
  } catch (err) {
    if (!node.removed) node.remove();
    throw err;
  }
};

const SHAPE_FOR: Record<NodeShape, ShapeWithTextNode["shapeType"]> = {
  rect: "SQUARE",
  round: "ROUNDED_RECTANGLE",
  stadium: "ROUNDED_RECTANGLE",
  subroutine: "PREDEFINED_PROCESS",
  cylinder: "ENG_DATABASE",
  circle: "ELLIPSE",
  doubleCircle: "ELLIPSE",
  asymmetric: "SQUARE",
  diamond: "DIAMOND",
  hexagon: "HEXAGON",
  parallelogram: "PARALLELOGRAM_RIGHT",
  parallelogramAlt: "PARALLELOGRAM_LEFT",
  trapezoid: "TRAPEZOID",
  trapezoidAlt: "TRAPEZOID",
};

const CAP_FOR: Record<EdgeHead, ConnectorStrokeCap> = {
  none: "NONE",
  arrow: "ARROW_LINES",
  circle: "CIRCLE_FILLED",
  cross: "NONE",
};

/* ── get_board ────────────────────────────────────────────────────────────── */

const readBoard = async (request: Request, p: Record<string, unknown>) => {
  const pageId = str(p.pageId);
  const page = pageId ? figma.root.children.find((pg) => pg.id === pageId) : figma.currentPage;
  if (!page) throw new Error(`Page not found: ${pageId}`);
  await withTimeout(page.loadAsync(), 30_000, `Loading page "${page.name}"`);

  const maxItems = num(p.maxItems) ?? 500;
  const palette = figjamPalette();
  const counts: Record<string, number> = {};
  const lists: Record<string, unknown[]> = {
    stickies: [],
    shapes: [],
    connectors: [],
    sections: [],
    tables: [],
    codeBlocks: [],
    texts: [],
    stamps: [],
  };
  let listed = 0;
  let visited = 0;
  let truncated = false;

  const add = (list: string, item: Record<string, unknown>) => {
    if (listed >= maxItems) {
      truncated = true;
      return;
    }
    listed++;
    lists[list].push(item);
  };

  const visit = async (node: SceneNode) => {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
    if (++visited % 400 === 0) {
      postProgress(request.requestId, `Read ${visited} layers`);
      await yieldToFigma();
    }
    const parentId = node.parent && node.parent.type !== "PAGE" ? node.parent.id : undefined;
    const base = { id: node.id, ...(parentId ? { parentId } : {}) };

    switch (node.type) {
      case "STICKY": {
        const hex = fillHex(node);
        add("stickies", {
          ...base,
          text: clip(node.text.characters, 2000),
          color: hex ? nearestColorName(hex, palette) : undefined,
          fill: hex,
          author: node.authorVisible && node.authorName ? node.authorName : undefined,
          wide: node.isWideWidth || undefined,
          ...bounds(node),
        });
        break;
      }
      case "SHAPE_WITH_TEXT":
        add("shapes", {
          ...base,
          shapeType: node.shapeType,
          text: clip(node.text.characters, 2000),
          fill: fillHex(node),
          ...bounds(node),
        });
        break;
      case "CONNECTOR":
        add("connectors", {
          ...base,
          start: endpoint(node.connectorStart),
          end: endpoint(node.connectorEnd),
          label: node.text.characters || undefined,
          lineType: node.connectorLineType,
          startCap: node.connectorStartStrokeCap,
          endCap: node.connectorEndStrokeCap,
        });
        break;
      case "SECTION":
        add("sections", { ...base, name: node.name, childIds: node.children.map((c) => c.id), ...bounds(node) });
        break;
      case "TABLE": {
        const cells: string[][] = [];
        for (let r = 0; r < node.numRows; r++) {
          const row: string[] = [];
          for (let c = 0; c < node.numColumns; c++) row.push(clip(node.cellAt(r, c).text.characters, 500));
          cells.push(row);
        }
        add("tables", { ...base, rows: node.numRows, columns: node.numColumns, cells, ...bounds(node) });
        break;
      }
      case "CODE_BLOCK":
        add("codeBlocks", {
          ...base,
          language: node.codeLanguage,
          code: clip(node.code, 4000),
          ...(node.code.length > 4000 ? { codeLength: node.code.length } : {}),
          ...bounds(node),
        });
        break;
      case "TEXT":
        add("texts", { ...base, text: clip(node.characters, 2000), ...bounds(node) });
        break;
      case "STAMP": {
        let author: string | undefined;
        try {
          author = (await withTimeout(node.getAuthorAsync(), 3_000, "Reading stamp author"))?.name;
        } catch {
          author = undefined;
        }
        add("stamps", { ...base, name: node.name, author, ...bounds(node) });
        break;
      }
    }
    if ("children" in node) for (const child of node.children) await visit(child);
  };

  for (const child of page.children) await visit(child);

  const nonEmpty = Object.fromEntries(Object.entries(lists).filter(([, items]) => items.length > 0));
  return { page: { id: page.id, name: page.name }, counts, listed, truncated, ...nonEmpty };
};

/* ── generate_diagram ─────────────────────────────────────────────────────── */

const drawDiagram = async (request: Request, p: Record<string, unknown>) => {
  const source = str(p.mermaid);
  if (!source || !source.trim()) throw new Error("mermaid is required");
  const rawDirection = str(p.direction)?.toUpperCase();
  const direction = rawDirection === "TD" ? "TB" : (rawDirection as Direction | undefined);

  const chart = parseMermaid(source, direction);
  const warnings = [...chart.warnings];
  if (chart.nodes.length === 0) {
    throw new Error(`The diagram has no nodes to draw.${warnings.length ? ` Warnings: ${warnings.join("; ")}` : ""}`);
  }
  if (chart.nodes.length > MAX_DIAGRAM_NODES || chart.edges.length > MAX_DIAGRAM_EDGES) {
    throw new Error(
      `The diagram has ${chart.nodes.length} nodes and ${chart.edges.length} edges; the limit is ${MAX_DIAGRAM_NODES} and ${MAX_DIAGRAM_EDGES}. Split it into smaller diagrams.`
    );
  }
  if (chart.nodes.some((n) => n.shape === "asymmetric")) warnings.push("Asymmetric (>text]) shapes are drawn as rectangles");
  if (chart.edges.some((e) => e.startHead === "cross" || e.endHead === "cross")) {
    warnings.push("x line ends are drawn without a cap; FigJam connectors have no cross cap");
  }

  const layout = layoutFlowchart(chart);
  const center = figma.viewport.center;
  const originX = num(p.x) ?? Math.round(center.x - layout.width / 2);
  const originY = num(p.y) ?? Math.round(center.y - layout.height / 2);

  const fonts: FontCache = new Set();
  const made: SceneNode[] = [];
  const topLevel: SceneNode[] = [];
  const nodeIds: Record<string, string> = {};
  const sectionIds: Record<string, string> = {};
  const connectorIds: string[] = [];
  const total = chart.nodes.length + chart.edges.length;
  let done = 0;
  const tick = async (what: string) => {
    if (++done % 25 === 0) {
      postProgress(request.requestId, `Drew ${done}/${total} ${what}`, done, total);
      await yieldToFigma();
    }
  };

  try {
    const sections = new Map<string, { node: SectionNode; x: number; y: number }>();
    const ordered = chart.subgraphs
      .filter((sg) => layout.sections[sg.id])
      .sort((a, b) => layout.sections[a.id].depth - layout.sections[b.id].depth);
    for (const sg of ordered) {
      const box = layout.sections[sg.id];
      const section = figma.createSection();
      made.push(section);
      section.name = sg.title || sg.id;
      section.resizeWithoutConstraints(box.width, box.height);
      const x = originX + box.x;
      const y = originY + box.y;
      const parent = sg.parent ? sections.get(sg.parent) : undefined;
      if (parent) {
        parent.node.appendChild(section);
        section.x = x - parent.x;
        section.y = y - parent.y;
      } else {
        section.x = x;
        section.y = y;
        topLevel.push(section);
      }
      sections.set(sg.id, { node: section, x, y });
      sectionIds[sg.id] = section.id;
    }

    for (const flowNode of chart.nodes) {
      const box = layout.nodes[flowNode.id];
      const shape = figma.createShapeWithText();
      made.push(shape);
      shape.shapeType = SHAPE_FOR[flowNode.shape];
      shape.resize(box.width, box.height);
      await setText(shape.text, flowNode.label, fonts);
      const x = originX + box.x;
      const y = originY + box.y;
      const parent = flowNode.subgraph ? sections.get(flowNode.subgraph) : undefined;
      if (parent) {
        parent.node.appendChild(shape);
        shape.x = x - parent.x;
        shape.y = y - parent.y;
      } else {
        shape.x = x;
        shape.y = y;
        topLevel.push(shape);
      }
      nodeIds[flowNode.id] = shape.id;
      await tick("shapes");
    }

    for (const edge of chart.edges) {
      const from = nodeIds[edge.from] ?? sectionIds[edge.from];
      const to = nodeIds[edge.to] ?? sectionIds[edge.to];
      if (!from || !to) {
        warnings.push(`Edge ${edge.from} → ${edge.to} skipped: ${!from ? edge.from : edge.to} is an empty subgraph`);
        continue;
      }
      if (from === to) {
        warnings.push(`Edge ${edge.from} → ${edge.to} skipped: FigJam connectors cannot loop back to the same shape`);
        continue;
      }
      const connector = figma.createConnector();
      made.push(connector);
      connector.connectorStart = { endpointNodeId: from, magnet: "AUTO" };
      connector.connectorEnd = { endpointNodeId: to, magnet: "AUTO" };
      connector.connectorLineType = "ELBOWED";
      connector.connectorStartStrokeCap = CAP_FOR[edge.startHead];
      connector.connectorEndStrokeCap = CAP_FOR[edge.endHead];
      if (edge.line === "dotted") connector.dashPattern = [8, 8];
      if (edge.line === "thick") {
        const weight = typeof connector.strokeWeight === "number" ? connector.strokeWeight : 2;
        connector.strokeWeight = Math.max(4, weight * 2);
      }
      if (edge.label) await setText(connector.text, edge.label, fonts);
      connectorIds.push(connector.id);
      topLevel.push(connector);
      await tick("shapes and connectors");
    }
  } catch (err) {
    for (const node of [...made].reverse()) {
      try {
        if (!node.removed) node.remove();
      } catch {
        // Already gone with its section.
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`generate_diagram stopped and removed the ${made.length} layers it had drawn: ${message}`);
  }

  if (topLevel.length) {
    figma.currentPage.selection = topLevel;
    figma.viewport.scrollAndZoomIntoView(topLevel);
  }

  return {
    direction: layout.direction,
    counts: {
      shapes: Object.keys(nodeIds).length,
      connectors: connectorIds.length,
      sections: Object.keys(sectionIds).length,
    },
    bounds: { x: originX, y: originY, width: layout.width, height: layout.height },
    crossings: layout.crossings,
    nodeIds,
    sectionIds,
    connectorIds,
    warnings,
  };
};

/* ── dispatcher ───────────────────────────────────────────────────────────── */

export const handleBoardsRequest = async (request: Request): Promise<Response | null> => {
  if (SLIDES_TOOLS.has(request.type)) return handleSlidesRequest(request);
  if (!FIGJAM_TOOLS.has(request.type)) return null;
  const refusal = editorRefusal(request.type, figma.editorType);
  if (refusal) throw new Error(refusal);
  const p = request.params ?? {};
  const fonts: FontCache = new Set();

  switch (request.type) {
    case "get_board":
      return ok(request, await readBoard(request, p));

    case "create_sticky": {
      requireEditor(request.type);
      const text = str(p.text);
      if (text === undefined) throw new Error("text is required");
      const sticky = await creating(figma.createSticky(), async (node) => {
        if (bool(p.wide) !== undefined) node.isWideWidth = bool(p.wide)!;
        if (str(p.color)) node.fills = [paintFrom(str(p.color)!)];
        await setText(node.text, text, fonts);
        await place(node, p);
      });
      const hex = fillHex(sticky);
      return ok(request, created(sticky, { color: hex ? nearestColorName(hex, figjamPalette()) : undefined }));
    }

    case "create_shape_with_text": {
      requireEditor(request.type);
      const shapeType = need(str(p.shapeType), "shapeType") as ShapeWithTextNode["shapeType"];
      const shape = await creating(figma.createShapeWithText(), async (node) => {
        node.shapeType = shapeType;
        const width = num(p.width);
        const height = num(p.height);
        if (width !== undefined || height !== undefined) node.resize(width ?? node.width, height ?? node.height);
        if (str(p.fill)) node.fills = [paintFrom(str(p.fill)!)];
        await setText(node.text, str(p.text) ?? "", fonts);
        await place(node, p);
      });
      return ok(request, created(shape, { shapeType: shape.shapeType }));
    }

    case "create_connector": {
      requireEditor(request.type);
      const start = await resolveSceneNode(need(str(p.startNodeId), "startNodeId"));
      const end = await resolveSceneNode(need(str(p.endNodeId), "endNodeId"));
      const connector = await creating(figma.createConnector(), async (node) => {
        node.connectorStart = {
          endpointNodeId: start.id,
          magnet: (str(p.startMagnet) ?? "AUTO") as ConnectorEndpointEndpointNodeIdAndMagnet["magnet"],
        };
        node.connectorEnd = {
          endpointNodeId: end.id,
          magnet: (str(p.endMagnet) ?? "AUTO") as ConnectorEndpointEndpointNodeIdAndMagnet["magnet"],
        };
        if (str(p.lineType)) node.connectorLineType = str(p.lineType) as ConnectorNode["connectorLineType"];
        if (str(p.startCap)) node.connectorStartStrokeCap = str(p.startCap) as ConnectorStrokeCap;
        if (str(p.endCap)) node.connectorEndStrokeCap = str(p.endCap) as ConnectorStrokeCap;
        if (str(p.label)) await setText(node.text, str(p.label)!, fonts);
      });
      return ok(request, {
        nodeId: connector.id,
        start: endpoint(connector.connectorStart),
        end: endpoint(connector.connectorEnd),
        lineType: connector.connectorLineType,
        startCap: connector.connectorStartStrokeCap,
        endCap: connector.connectorEndStrokeCap,
        label: connector.text.characters || undefined,
      });
    }

    case "create_table": {
      requireEditor(request.type);
      const rows = need(num(p.rows), "rows");
      const columns = need(num(p.columns), "columns");
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) {
        throw new Error("rows and columns must be whole numbers of at least 1");
      }
      const cells = tableCells(rows, columns, arr<string[]>(p.cells));
      const table = await creating(figma.createTable(rows, columns), async (node) => {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < columns; c++) {
            if (cells[r][c]) await setText(node.cellAt(r, c).text, cells[r][c], fonts);
          }
        }
        await place(node, p);
      });
      return ok(request, created(table, { rows: table.numRows, columns: table.numColumns }));
    }

    case "create_code_block": {
      requireEditor(request.type);
      const code = str(p.code);
      if (code === undefined) throw new Error("code is required");
      const block = await creating(figma.createCodeBlock(), async (node) => {
        node.code = code;
        if (str(p.language)) node.codeLanguage = str(p.language) as CodeBlockNode["codeLanguage"];
        await place(node, p);
      });
      return ok(request, created(block, { language: block.codeLanguage }));
    }

    case "generate_diagram":
      requireEditor(request.type);
      return ok(request, await drawDiagram(request, p));

    default:
      return null;
  }
};
