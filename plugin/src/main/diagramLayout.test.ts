import { describe, expect, test } from "bun:test";
import { estimateNodeSize, layoutFlowchart, wrapLabel, type Box } from "./diagramLayout";
import { parseMermaid } from "./mermaid";

const layout = (src: string) => layoutFlowchart(parseMermaid(src));
const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe("ranking", () => {
  test("a chain gets one rank per step and lines up", () => {
    const l = layout("flowchart TD\nA-->B-->C");
    expect([l.nodes.A.rank, l.nodes.B.rank, l.nodes.C.rank]).toEqual([0, 1, 2]);
    expect(center(l.nodes.A).x).toBe(center(l.nodes.C).x);
    expect(l.nodes.A.y).toBeLessThan(l.nodes.B.y);
    expect(l.nodes.B.y).toBeLessThan(l.nodes.C.y);
  });

  test("longest path: a shortcut edge does not pull its target up", () => {
    const l = layout("flowchart TD\nA-->B-->C-->D\nA-->D");
    expect(l.nodes.D.rank).toBe(3);
  });

  test("a source sits just above its child, not at the top", () => {
    const l = layout("flowchart TD\nA-->B-->C-->D\nX-->D");
    expect(l.nodes.X.rank).toBe(2);
  });

  test("cycles are broken and every node still gets a rank", () => {
    const l = layout("flowchart TD\nA-->B-->C-->A\nC-->D");
    expect(new Set(Object.values(l.nodes).map((p) => p.rank)).size).toBe(4);
    expect(l.nodes.A.rank).toBe(0);
  });

  test("self-loops, duplicate edges and disconnected nodes are harmless", () => {
    const l = layout("flowchart TD\nA-->A\nA-->B\nA-->B\nlonely");
    expect(l.nodes.B.rank).toBe(1);
    expect(l.nodes.lonely.rank).toBe(0);
  });

  test("edges to a subgraph do not affect ranks", () => {
    const l = layout("flowchart TD\nsubgraph S\n a\nend\nb --> S");
    expect(l.nodes.a.rank).toBe(0);
    expect(l.nodes.b.rank).toBe(0);
  });
});

describe("directions", () => {
  const src = (dir: string) => `flowchart ${dir}\nA-->B`;
  test("TB grows down, BT up, LR right, RL left", () => {
    const tb = layout(src("TB"));
    expect(tb.nodes.B.y).toBeGreaterThan(tb.nodes.A.y);
    const bt = layout(src("BT"));
    expect(bt.nodes.B.y).toBeLessThan(bt.nodes.A.y);
    const lr = layout(src("LR"));
    expect(lr.nodes.B.x).toBeGreaterThan(lr.nodes.A.x);
    expect(lr.nodes.B.y).toBe(lr.nodes.A.y);
    const rl = layout(src("RL"));
    expect(rl.nodes.B.x).toBeLessThan(rl.nodes.A.x);
  });

  test("coordinates start at zero and the size covers everything", () => {
    for (const dir of ["TB", "BT", "LR", "RL"]) {
      const l = layout(`flowchart ${dir}\nsubgraph S\nA-->B\nend\nB-->C`);
      const boxes = [...Object.values(l.nodes), ...Object.values(l.sections)];
      expect(Math.min(...boxes.map((b) => b.x))).toBe(0);
      expect(Math.min(...boxes.map((b) => b.y))).toBe(0);
      for (const b of boxes) {
        expect(b.x + b.width).toBeLessThanOrEqual(l.width);
        expect(b.y + b.height).toBeLessThanOrEqual(l.height);
      }
    }
  });

  test("rank gap leaves room for edge labels", () => {
    const plain = layout("flowchart TD\nA-->B");
    const labelled = layout("flowchart TD\nA-->|yes|B");
    expect(labelled.nodes.B.y - plain.nodes.B.y).toBeGreaterThan(0);
  });
});

describe("ordering", () => {
  test("barycentre sweeps remove an avoidable crossing", () => {
    // Declared order puts c before d, which crosses a→d and b→c.
    const l = layout("flowchart TD\na\nb\nc\nd\na-->d\nb-->c");
    expect(l.crossings).toBe(0);
    expect(l.nodes.d.x < l.nodes.c.x).toBe(l.nodes.a.x < l.nodes.b.x);
  });

  test("a tangle gets fewer crossings than its declared order", () => {
    const src = "flowchart TD\nr1\nr2\nr3\nr4\nx1\nx2\nx3\nx4\nr1-->x4\nr2-->x3\nr3-->x2\nr4-->x1\nr1-->x3";
    const l = layout(src);
    expect(l.crossings).toBeLessThanOrEqual(1);
  });

  test("siblings of a diamond share a rank without overlapping", () => {
    const l = layout("flowchart TD\nA-->B & C\nB & C-->D");
    expect(l.nodes.B.rank).toBe(l.nodes.C.rank);
    expect(overlaps(l.nodes.B, l.nodes.C)).toBe(false);
    expect(l.ranks[1]).toHaveLength(2);
  });
});

describe("subgraphs", () => {
  const src = `flowchart TD
    start --> auth
    subgraph api [API]
      auth --> users & orders
      subgraph data [Data]
        users --> db[(DB)]
        orders --> db
      end
    end
    subgraph web [Web]
      page --> start
      page --> cdn
    end
    orders --> mail
    cdn --> mail
    db --> report
    page --> report`;

  for (const dir of ["TB", "LR", "BT", "RL"] as const) {
    test(`${dir}: no two nodes overlap, sections hold their nodes and nothing else`, () => {
      const chart = parseMermaid(src, dir);
      const l = layoutFlowchart(chart);
      const ids = Object.keys(l.nodes);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          expect(overlaps(l.nodes[ids[i]], l.nodes[ids[j]])).toBe(false);
        }
      }
      const members = (sg: string): string[] => {
        const s = chart.subgraphs.find((x) => x.id === sg)!;
        return [...s.nodeIds, ...chart.subgraphs.filter((c) => c.parent === sg).flatMap((c) => members(c.id))];
      };
      for (const sg of chart.subgraphs) {
        const rect = l.sections[sg.id];
        const inside = new Set(members(sg.id));
        for (const id of ids) {
          if (inside.has(id)) expect(contains(rect, l.nodes[id])).toBe(true);
          else expect(overlaps(rect, l.nodes[id])).toBe(false);
        }
      }
      expect(contains(l.sections.api, l.sections.data)).toBe(true);
      expect(overlaps(l.sections.api, l.sections.web)).toBe(false);
      expect(l.sections.data.depth).toBe(1);
      expect(l.sections.api.depth).toBe(0);
    });
  }

  test("an empty subgraph gets no section", () => {
    const l = layout("flowchart TD\nsubgraph E\nend\nA-->B");
    expect(l.sections.E).toBeUndefined();
  });

  test("a subgraph's nodes stay together in each rank", () => {
    const l = layout("flowchart TD\nsubgraph S\n s1\n s2\nend\nt1\nroot --> t1 & s1 & s2");
    const row = l.ranks[1];
    expect(Math.abs(row.indexOf("s1") - row.indexOf("s2"))).toBe(1);
  });
});

describe("sizes", () => {
  test("longer text makes a wider shape, up to a cap, then wraps taller", () => {
    const short = estimateNodeSize("Hi", "rect");
    const long = estimateNodeSize("A considerably longer label here", "rect");
    const huge = estimateNodeSize("word ".repeat(60), "rect");
    expect(long.width).toBeGreaterThan(short.width);
    expect(huge.width).toBeLessThanOrEqual(400);
    expect(huge.height).toBeGreaterThan(long.height);
  });

  test("diamonds are larger than rectangles; circles are round", () => {
    const rect = estimateNodeSize("Decide", "rect");
    const diamond = estimateNodeSize("Decide", "diamond");
    const circle = estimateNodeSize("A longer circle label", "circle");
    expect(diamond.width).toBeGreaterThan(rect.width);
    expect(diamond.height).toBeGreaterThan(rect.height);
    expect(circle.width).toBe(circle.height);
  });

  test("wrapLabel keeps explicit newlines and wraps words", () => {
    expect(wrapLabel("one\ntwo")).toEqual(["one", "two"]);
    expect(wrapLabel("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
  });

  test("a custom size function is used for spacing", () => {
    const l = layoutFlowchart(parseMermaid("flowchart LR\nA-->B"), () => ({ width: 10, height: 10 }));
    expect(l.nodes.B.x - l.nodes.A.x).toBe(10 + 96);
  });
});

test("an empty chart lays out to nothing", () => {
  const l = layoutFlowchart({ direction: "TB", nodes: [], edges: [], subgraphs: [], warnings: [] });
  expect(l).toMatchObject({ width: 0, height: 0, ranks: [], crossings: 0 });
});
