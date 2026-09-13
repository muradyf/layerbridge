import { describe, expect, test } from "bun:test";
import { MermaidError, cleanLabel, parseMermaid, splitStatements, type NodeShape } from "./mermaid";

const edgePairs = (src: string) => parseMermaid(src).edges.map((e) => `${e.from}>${e.to}`);

describe("header", () => {
  test("directions, TD as TB, graph and lowercase", () => {
    expect(parseMermaid("flowchart TD\nA-->B").direction).toBe("TB");
    expect(parseMermaid("graph LR\nA-->B").direction).toBe("LR");
    expect(parseMermaid("flowchart rl\nA-->B").direction).toBe("RL");
    expect(parseMermaid("graph BT\nA-->B").direction).toBe("BT");
    expect(parseMermaid("flowchart\nA-->B").direction).toBe("TB");
  });

  test("the caller's direction wins", () => {
    expect(parseMermaid("flowchart TD\nA-->B", "LR").direction).toBe("LR");
  });

  test("statements may follow the header after a semicolon", () => {
    expect(edgePairs("graph TD; A-->B; B-->C")).toEqual(["A>B", "B>C"]);
  });

  test("comments, blank lines and front matter are skipped", () => {
    const chart = parseMermaid("---\ntitle: x\n---\n\n%% a comment\nflowchart LR\n  %% another\n  A --> B\n");
    expect(chart.direction).toBe("LR");
    expect(chart.edges).toHaveLength(1);
    expect(chart.warnings.some((w) => w.includes("Front matter"))).toBe(true);
  });

  test("other diagram types are refused and the supported ones listed", () => {
    for (const src of ["sequenceDiagram\nA->>B: hi", "pie title Pets\n\"Dogs\": 3", "erDiagram\nA ||--o{ B : has"]) {
      expect(() => parseMermaid(src)).toThrow(MermaidError);
      expect(() => parseMermaid(src)).toThrow(/not supported. Supported: Mermaid flowcharts only/);
    }
  });

  test("a missing or wrong header fails clearly", () => {
    expect(() => parseMermaid("")).toThrow(/empty/);
    expect(() => parseMermaid("%% only a comment")).toThrow(/empty/);
    expect(() => parseMermaid("A --> B")).toThrow(/Expected a Mermaid flowchart/);
    expect(() => parseMermaid("flowchart XY\nA-->B")).toThrow(/Unknown flowchart direction "XY"/);
  });
});

describe("nodes", () => {
  const shapes: Array<[string, NodeShape, string]> = [
    ["A[Box]", "rect", "Box"],
    ["A(Round)", "round", "Round"],
    ["A([Stadium])", "stadium", "Stadium"],
    ["A[[Sub]]", "subroutine", "Sub"],
    ["A[(DB)]", "cylinder", "DB"],
    ["A((Circle))", "circle", "Circle"],
    ["A(((Double)))", "doubleCircle", "Double"],
    ["A>Flag]", "asymmetric", "Flag"],
    ["A{Choice}", "diamond", "Choice"],
    ["A{{Hex}}", "hexagon", "Hex"],
    ["A[/In/]", "parallelogram", "In"],
    ["A[\\Out\\]", "parallelogramAlt", "Out"],
    ["A[/Trap\\]", "trapezoid", "Trap"],
    ["A[\\Trap/]", "trapezoidAlt", "Trap"],
  ];
  for (const [src, shape, label] of shapes) {
    test(`${src} is a ${shape}`, () => {
      const [node] = parseMermaid(`flowchart TD\n${src}`).nodes;
      expect(node).toEqual({ id: "A", label, shape });
    });
  }

  test("a bare id is a rectangle labelled with its id", () => {
    expect(parseMermaid("flowchart TD\nstart").nodes[0]).toEqual({ id: "start", label: "start", shape: "rect" });
  });

  test("quoted labels keep brackets; <br> becomes a newline; entity codes decode", () => {
    const nodes = parseMermaid('flowchart TD\nA["List [draft]"]\nB[One<br/>Two]\nC["say #quot;hi#quot; #35;1"]').nodes;
    expect(nodes.map((n) => n.label)).toEqual(["List [draft]", "One\nTwo", 'say "hi" #1']);
  });

  test("a later definition sets the label and shape of an earlier reference", () => {
    const nodes = parseMermaid("flowchart TD\nA --> B\nB{Decide}").nodes;
    expect(nodes.find((n) => n.id === "B")).toEqual({ id: "B", label: "Decide", shape: "diamond" });
  });

  test("ids may contain dashes, underscores and non-ASCII letters", () => {
    expect(edgePairs("flowchart LR\napi-gateway --> user_db\nCafé-->Ω")).toEqual(["api-gateway>user_db", "Café>Ω"]);
  });

  test(":::class suffixes are skipped with a warning", () => {
    const chart = parseMermaid("flowchart TD\nA[Go]:::hot --> B:::cold");
    expect(chart.edges).toHaveLength(1);
    expect(chart.nodes[0].label).toBe("Go");
    expect(chart.warnings.join()).toContain(":::class");
  });

  test('@{ } node syntax keeps its label', () => {
    const chart = parseMermaid('flowchart TD\nA@{ shape: diamond, label: "Pick" } --> B');
    expect(chart.nodes[0].label).toBe("Pick");
    expect(chart.edges).toHaveLength(1);
    expect(chart.warnings.join()).toContain("@{");
  });
});

describe("edges", () => {
  const cases: Array<[string, { line: string; startHead: string; endHead: string }]> = [
    ["A-->B", { line: "solid", startHead: "none", endHead: "arrow" }],
    ["A --- B", { line: "solid", startHead: "none", endHead: "none" }],
    ["A-.->B", { line: "dotted", startHead: "none", endHead: "arrow" }],
    ["A -.- B", { line: "dotted", startHead: "none", endHead: "none" }],
    ["A ==> B", { line: "thick", startHead: "none", endHead: "arrow" }],
    ["A === B", { line: "thick", startHead: "none", endHead: "none" }],
    ["A --o B", { line: "solid", startHead: "none", endHead: "circle" }],
    ["A --x B", { line: "solid", startHead: "none", endHead: "cross" }],
    ["A <--> B", { line: "solid", startHead: "arrow", endHead: "arrow" }],
    ["A o--o B", { line: "solid", startHead: "circle", endHead: "circle" }],
    ["A ---> B", { line: "solid", startHead: "none", endHead: "arrow" }],
  ];
  for (const [src, expected] of cases) {
    test(src, () => {
      const [edge] = parseMermaid(`flowchart TD\n${src}`).edges;
      expect(edge).toMatchObject({ from: "A", to: "B", ...expected });
      expect(edge.label).toBeUndefined();
    });
  }

  test("labels in every form", () => {
    const chart = parseMermaid(
      'flowchart TD\nA -->|yes| B\nA -- no --> C\nB -. maybe .-> D\nC == sure ==> D\nD -->|"quoted | pipe"| E\nE -- plain --- F'
    );
    expect(chart.edges.map((e) => [e.label, e.line, e.endHead])).toEqual([
      ["yes", "solid", "arrow"],
      ["no", "solid", "arrow"],
      ["maybe", "dotted", "arrow"],
      ["sure", "thick", "arrow"],
      ["quoted | pipe", "solid", "arrow"],
      ["plain", "solid", "none"],
    ]);
  });

  test("chains and & make every pairing", () => {
    expect(edgePairs("flowchart TD\nA --> B --> C")).toEqual(["A>B", "B>C"]);
    expect(edgePairs("flowchart TD\nA & B --> C & D")).toEqual(["A>C", "A>D", "B>C", "B>D"]);
    expect(edgePairs("flowchart TD\nA[Start] -->|go| B{Ok?} -- yes --> C((Done))")).toEqual(["A>B", "B>C"]);
  });

  test("semicolons inside labels do not split statements", () => {
    expect(splitStatements('A["a;b"] --> B; B -->|x;y| C')).toEqual(['A["a;b"] --> B', "B -->|x;y| C"]);
    expect(parseMermaid('flowchart TD\nA["a;b"] -->|x;y| B').nodes[0].label).toBe("a;b");
  });
});

describe("subgraphs", () => {
  test("titles, nesting and membership", () => {
    const chart = parseMermaid(`flowchart TB
      subgraph outer [Outer box]
        a1 --> a2
        subgraph inner["Inner box"]
          b1
        end
      end
      subgraph Plain title
        c1
      end
      a2 --> b1 --> c1 --> d`);
    expect(chart.subgraphs).toEqual([
      { id: "outer", title: "Outer box", parent: undefined, nodeIds: ["a1", "a2"] },
      { id: "inner", title: "Inner box", parent: "outer", nodeIds: ["b1"] },
      { id: "Plain title", title: "Plain title", parent: undefined, nodeIds: ["c1"] },
    ]);
    expect(chart.nodes.find((n) => n.id === "d")?.subgraph).toBeUndefined();
    expect(chart.warnings).toEqual([]);
  });

  test("a node declared at the top can be grouped later", () => {
    const chart = parseMermaid("flowchart TD\nA[Start] --> B\nsubgraph S\n  A\nend");
    expect(chart.subgraphs[0].nodeIds).toEqual(["A"]);
  });

  test("the first subgraph to mention a node keeps it", () => {
    const chart = parseMermaid("flowchart TD\nsubgraph one\n x\nend\nsubgraph two\n x --> y\nend");
    expect(chart.subgraphs.map((s) => s.nodeIds)).toEqual([["x"], ["y"]]);
  });

  test("an edge to a subgraph id targets the subgraph, not a new node", () => {
    const chart = parseMermaid("flowchart LR\nsubgraph one\n a\nend\nsubgraph two\n b\nend\none --> two\nc --> one");
    expect(chart.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(chart.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["one>two", "c>one"]);
  });

  test("problems are warnings, not failures", () => {
    const chart = parseMermaid("flowchart TD\nend\nsubgraph empty\nend\nsubgraph open\n direction LR\n a");
    const text = chart.warnings.join("\n");
    expect(text).toContain('"end" without a matching subgraph');
    expect(text).toContain('Subgraph "empty" has no nodes');
    expect(text).toContain('Subgraph "open" is missing its "end"');
    expect(text).toContain("Direction inside a subgraph is ignored");
    expect(chart.direction).toBe("TB");
    expect(chart.subgraphs[1].nodeIds).toEqual(["a"]);
  });

  test("duplicate subgraph ids are renamed", () => {
    const chart = parseMermaid("flowchart TD\nsubgraph S\n a\nend\nsubgraph S\n b\nend");
    expect(chart.subgraphs.map((s) => s.id)).toEqual(["S", "S_2"]);
  });
});

describe("unsupported statements", () => {
  test("styling statements are skipped once each", () => {
    const chart = parseMermaid(
      "flowchart TD\nA-->B\nclassDef hot fill:#f00\nclass A hot\nclass B hot\nstyle A fill:#0f0\nlinkStyle 0 stroke:#000\nclick A callback"
    );
    expect(chart.edges).toHaveLength(1);
    expect(chart.warnings).toHaveLength(5);
  });

  test("an unreadable statement is reported by line and the rest still parses", () => {
    const chart = parseMermaid("flowchart TD\nA --> B\nA -> B ??\nB --> C");
    expect(chart.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["A>B", "B>C"]);
    expect(chart.warnings).toEqual(['Line 3: could not read "A -> B ??", left out']);
  });

  test("a half-read statement adds nothing", () => {
    const chart = parseMermaid("flowchart TD\nX --> Y -->");
    expect(chart.nodes).toEqual([]);
    expect(chart.edges).toEqual([]);
  });
});

test("cleanLabel strips quotes and markdown backticks", () => {
  expect(cleanLabel(' "hello" ')).toBe("hello");
  expect(cleanLabel("`**bold**`")).toBe("**bold**");
});
