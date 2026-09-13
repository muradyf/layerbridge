/**
 * A Mermaid flowchart parser for generate_diagram. Figma-free so it runs under
 * `bun test`.
 *
 * Covers the flowchart / graph subset people actually write: a direction
 * header, node shapes, chained and `&`-joined edges with labels, subgraphs and
 * `%%` comments. Styling statements (classDef, style, linkStyle, click…) are
 * skipped with a warning rather than failing the diagram, and a statement that
 * cannot be read is reported by line number and left out.
 */

export type Direction = "TB" | "BT" | "LR" | "RL";

export type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "doubleCircle"
  | "asymmetric"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "parallelogramAlt"
  | "trapezoid"
  | "trapezoidAlt";

export type FlowNode = { id: string; label: string; shape: NodeShape; subgraph?: string };

export type EdgeHead = "none" | "arrow" | "circle" | "cross";
export type EdgeLine = "solid" | "dotted" | "thick";

/** `from`/`to` name a node, or a subgraph when the diagram links to one. */
export type FlowEdge = {
  from: string;
  to: string;
  label?: string;
  line: EdgeLine;
  startHead: EdgeHead;
  endHead: EdgeHead;
};

export type FlowSubgraph = { id: string; title: string; parent?: string; nodeIds: string[] };

export type Flowchart = {
  direction: Direction;
  nodes: FlowNode[];
  edges: FlowEdge[];
  subgraphs: FlowSubgraph[];
  warnings: string[];
};

export const SUPPORTED_DIAGRAMS =
  'Mermaid flowcharts only: "flowchart" or "graph" with direction TD, TB, BT, LR or RL';

const OTHER_DIAGRAMS = [
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "C4Context",
  "mindmap",
  "timeline",
  "zenuml",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "kanban",
  "architecture-beta",
  "radar-beta",
];

const ID_CHARS = "A-Za-z0-9_\\u00C0-\\uFFFF";
/** A dash may sit inside an id (`api-gateway`) but never starts a link (`A-->B`, `A-.->B`). */
const ID_RE = new RegExp(`^[${ID_CHARS}]+(?:-(?![-.>=])[${ID_CHARS}]+)*`);

type ShapeSpec = { open: string; closers: Array<[string, NodeShape]> };

/** Longest opener first, so `((` wins over `(`. */
const SHAPES: ShapeSpec[] = [
  { open: "(((", closers: [[")))", "doubleCircle"]] },
  { open: "((", closers: [["))", "circle"]] },
  { open: "([", closers: [["])", "stadium"]] },
  { open: "[[", closers: [["]]", "subroutine"]] },
  { open: "[(", closers: [[")]", "cylinder"]] },
  { open: "{{", closers: [["}}", "hexagon"]] },
  { open: "[/", closers: [["/]", "parallelogram"], ["\\]", "trapezoid"]] },
  { open: "[\\", closers: [["\\]", "parallelogramAlt"], ["/]", "trapezoidAlt"]] },
  { open: "[", closers: [["]", "rect"]] },
  { open: "(", closers: [[")", "round"]] },
  { open: "{", closers: [["}", "diamond"]] },
  { open: ">", closers: [["]", "asymmetric"]] },
];

const HEADS: Record<string, EdgeHead> = { ">": "arrow", "<": "arrow", o: "circle", x: "cross", "": "none" };

const IGNORED_KEYWORDS = /^(classDef|class|style|linkStyle|click|accTitle|accDescr|title)\b/i;

type NodeRef = { id: string; label?: string; shape?: NodeShape };
type Link = { line: EdgeLine; startHead: EdgeHead; endHead: EdgeHead; label?: string };

export class MermaidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MermaidError";
  }
}

export const cleanLabel = (raw: string): string => {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  // Markdown strings: "`**bold** text`"
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) text = text.slice(1, -1);
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#amp;/g, "&")
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">")
    .replace(/#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .trim();
};

/** Splits a line on `;` that is not inside quotes, brackets or a `|label|`. */
export const splitStatements = (line: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let inPipe = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (inQuote) continue;
    else if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "|" && depth === 0) inPipe = !inPipe;
    else if (ch === ";" && depth === 0 && !inPipe) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
};

const normalizeDirection = (raw: string | undefined): Direction | undefined => {
  if (!raw) return undefined;
  const d = raw.toUpperCase();
  if (d === "TD" || d === "TB") return "TB";
  if (d === "BT" || d === "LR" || d === "RL") return d;
  return undefined;
};

/** Reads one statement of nodes and links. Returns null when it cannot be read. */
class StatementReader {
  pos = 0;
  classesSeen = false;
  shapeSyntaxSeen = false;

  constructor(private readonly s: string) {}

  private skipWs() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  private rest() {
    return this.s.slice(this.pos);
  }

  get done() {
    this.skipWs();
    return this.pos >= this.s.length;
  }

  node(): NodeRef | null {
    this.skipWs();
    const m = ID_RE.exec(this.rest());
    if (!m) return null;
    const ref: NodeRef = { id: m[0] };
    this.pos += m[0].length;

    const rest = this.rest();
    if (rest.startsWith("@{")) {
      const close = rest.indexOf("}");
      if (close < 0) return null;
      const body = rest.slice(2, close);
      const label = /label\s*:\s*"([^"]*)"/.exec(body) ?? /label\s*:\s*([^,}]+)/.exec(body);
      if (label) ref.label = cleanLabel(label[1]);
      this.shapeSyntaxSeen = true;
      this.pos += close + 1;
    } else {
      for (const spec of SHAPES) {
        if (!rest.startsWith(spec.open)) continue;
        const shaped = this.shapeBody(spec);
        if (!shaped) return null;
        ref.label = shaped.label;
        ref.shape = shaped.shape;
        break;
      }
    }

    const cls = /^:::[A-Za-z0-9_-]+/.exec(this.rest());
    if (cls) {
      this.classesSeen = true;
      this.pos += cls[0].length;
    }
    return ref;
  }

  private shapeBody(spec: ShapeSpec): { label: string; shape: NodeShape } | null {
    let cursor = this.pos + spec.open.length;
    const text = this.s;
    let quoted: string | undefined;
    let wsAfterOpen = cursor;
    while (wsAfterOpen < text.length && text[wsAfterOpen] === " ") wsAfterOpen++;
    if (text[wsAfterOpen] === '"') {
      const endQuote = text.indexOf('"', wsAfterOpen + 1);
      if (endQuote < 0) return null;
      quoted = text.slice(wsAfterOpen + 1, endQuote);
      cursor = endQuote + 1;
      while (cursor < text.length && text[cursor] === " ") cursor++;
      for (const [closer, shape] of spec.closers) {
        if (text.startsWith(closer, cursor)) {
          this.pos = cursor + closer.length;
          return { label: cleanLabel(quoted), shape };
        }
      }
      return null;
    }
    let best: { at: number; closer: string; shape: NodeShape } | null = null;
    for (const [closer, shape] of spec.closers) {
      const at = text.indexOf(closer, cursor);
      if (at >= 0 && (!best || at < best.at)) best = { at, closer, shape };
    }
    if (!best) return null;
    this.pos = best.at + best.closer.length;
    return { label: cleanLabel(text.slice(cursor, best.at)), shape: best.shape };
  }

  group(): NodeRef[] | null {
    const first = this.node();
    if (!first) return null;
    const refs = [first];
    for (;;) {
      this.skipWs();
      if (this.s[this.pos] !== "&") return refs;
      this.pos++;
      const next = this.node();
      if (!next) return null;
      refs.push(next);
    }
  }

  link(): Link | null {
    this.skipWs();
    const rest = this.rest();
    const full = /^([<ox]?)(-{2,}|={2,}|-\.+-)([>ox]?)/.exec(rest);
    const labelOpen =
      (full && full[1] === "" && full[3] === "" && (full[2] === "--" || full[2] === "==")) ||
      (!full && /^-\.(?!\.*-)/.test(rest));

    let link: Link;
    if (labelOpen) {
      const opener = rest.startsWith("-.") ? "-." : rest.slice(0, 2);
      const closeRe = opener === "--" ? /(-{2,})([>ox])|(-{3,})/ : opener === "==" ? /(={2,})([>ox])|(={3,})/ : /(\.+-)([>ox]?)/;
      const after = rest.slice(2);
      const close = closeRe.exec(after);
      if (!close) return null;
      const label = cleanLabel(after.slice(0, close.index));
      link = {
        line: opener === "==" ? "thick" : opener === "-." ? "dotted" : "solid",
        startHead: "none",
        endHead: HEADS[close[2] ?? ""] ?? "none",
        ...(label ? { label } : {}),
      };
      this.pos += 2 + close.index + close[0].length;
    } else if (full) {
      const body = full[2];
      link = {
        line: body.startsWith("=") ? "thick" : body.includes(".") ? "dotted" : "solid",
        startHead: HEADS[full[1]],
        endHead: HEADS[full[3]],
      };
      this.pos += full[0].length;
    } else {
      return null;
    }

    this.skipWs();
    if (this.s[this.pos] === "|") {
      // A quoted label may itself contain a pipe: |"a | b"|
      let from = this.pos + 1;
      while (this.s[from] === " ") from++;
      if (this.s[from] === '"') {
        const endQuote = this.s.indexOf('"', from + 1);
        if (endQuote < 0) return null;
        from = endQuote + 1;
      }
      const end = this.s.indexOf("|", from);
      if (end < 0) return null;
      const label = cleanLabel(this.s.slice(this.pos + 1, end));
      if (label) link.label = label;
      this.pos = end + 1;
    }
    return link;
  }
}

export function parseMermaid(source: string, directionOverride?: Direction): Flowchart {
  const warnings: string[] = [];
  const warnOnce = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  let lineNo = 0;

  // Front matter (--- … ---) carries config and a title; neither is drawn.
  let firstContent = rawLines.findIndex((l) => l.trim() !== "");
  if (firstContent >= 0 && rawLines[firstContent].trim() === "---") {
    const end = rawLines.findIndex((l, i) => i > firstContent && l.trim() === "---");
    if (end < 0) throw new MermaidError("Front matter starting with --- is never closed");
    warnOnce("Front matter (--- … ---) is ignored");
    lineNo = end + 1;
  }

  let direction: Direction = "TB";
  let header: string | null = null;
  const pending: Array<{ text: string; line: number }> = [];

  for (; lineNo < rawLines.length; lineNo++) {
    const line = rawLines[lineNo].trim();
    if (!line || line.startsWith("%%")) continue;
    if (header === null) {
      header = line;
      const m = /^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL)\b)?\s*;?(.*)$/i.exec(line);
      if (!m) {
        const word = line.split(/[\s;]/)[0];
        const other = OTHER_DIAGRAMS.find((d) => d.toLowerCase() === word.toLowerCase());
        if (other) {
          throw new MermaidError(`Mermaid "${other}" diagrams are not supported. Supported: ${SUPPORTED_DIAGRAMS}.`);
        }
        throw new MermaidError(
          `Expected a Mermaid flowchart starting with e.g. "flowchart TD" or "graph LR", got "${line.slice(0, 60)}". Supported: ${SUPPORTED_DIAGRAMS}.`
        );
      }
      const afterDirection = m[3].trim();
      if (!m[2] && afterDirection && !afterDirection.startsWith(";") && /^[A-Za-z]{1,2}\b/.test(afterDirection) && !/[-=[({]/.test(afterDirection)) {
        throw new MermaidError(`Unknown flowchart direction "${afterDirection.split(/\s/)[0]}". Use TD, TB, BT, LR or RL.`);
      }
      direction = normalizeDirection(m[2]) ?? "TB";
      if (afterDirection) pending.push({ text: afterDirection.replace(/^;/, ""), line: lineNo + 1 });
      continue;
    }
    pending.push({ text: line, line: lineNo + 1 });
  }
  if (header === null) throw new MermaidError(`The diagram is empty. Supported: ${SUPPORTED_DIAGRAMS}.`);

  const nodes = new Map<string, FlowNode & { defined: boolean }>();
  const edges: FlowEdge[] = [];
  const subgraphs = new Map<string, FlowSubgraph>();
  const stack: string[] = [];

  const register = (ref: NodeRef) => {
    const inside = stack[stack.length - 1];
    let node = nodes.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: ref.id, shape: "rect", defined: false };
      nodes.set(ref.id, node);
    }
    if (ref.label !== undefined) node.label = ref.label;
    if (ref.shape !== undefined) node.shape = ref.shape;
    if (ref.label !== undefined || ref.shape !== undefined) node.defined = true;
    // A node belongs to the first subgraph that mentions it; mentions outside
    // any subgraph do not pin it, so it can be declared first and grouped later.
    if (inside && !node.subgraph) node.subgraph = inside;
  };

  for (const { text, line } of pending) {
    for (const statement of splitStatements(text)) {
      if (statement.startsWith("%%")) continue;

      const sub = /^subgraph\b\s*(.*)$/i.exec(statement);
      if (sub) {
        const rest = sub[1].trim();
        let id: string;
        let title: string;
        const bracket = /^([^\s["]+)\s*\[\s*(.*?)\s*\]$/.exec(rest);
        if (!rest) {
          id = `subgraph${subgraphs.size + 1}`;
          title = "";
        } else if (bracket) {
          id = bracket[1];
          title = cleanLabel(bracket[2]);
        } else {
          id = cleanLabel(rest);
          title = id;
        }
        if (subgraphs.has(id)) {
          warnOnce(`Line ${line}: subgraph "${id}" is declared twice; the second one is renamed`);
          let n = 2;
          while (subgraphs.has(`${id}_${n}`)) n++;
          id = `${id}_${n}`;
        }
        subgraphs.set(id, { id, title, parent: stack[stack.length - 1], nodeIds: [] });
        stack.push(id);
        continue;
      }

      if (/^end$/i.test(statement)) {
        if (stack.length === 0) warnOnce(`Line ${line}: "end" without a matching subgraph is ignored`);
        else stack.pop();
        continue;
      }

      const dir = /^direction\s+(\S+)$/i.exec(statement);
      if (dir) {
        const d = normalizeDirection(dir[1]);
        if (!d) warnOnce(`Line ${line}: unknown direction "${dir[1]}" is ignored`);
        else if (stack.length > 0) warnOnce(`Direction inside a subgraph is ignored; the whole diagram is laid out ${directionOverride ?? direction}`);
        else direction = d;
        continue;
      }

      const ignored = IGNORED_KEYWORDS.exec(statement);
      if (ignored) {
        warnOnce(`"${ignored[1]}" statements are ignored (styles, classes and click actions are not converted)`);
        continue;
      }

      const reader = new StatementReader(statement);
      const groups: NodeRef[][] = [];
      const links: Link[] = [];
      let group = reader.group();
      let ok = group !== null;
      if (group) groups.push(group);
      while (ok && !reader.done) {
        const link = reader.link();
        group = link ? reader.group() : null;
        if (!link || !group) {
          ok = false;
          break;
        }
        links.push(link);
        groups.push(group);
      }
      if (!ok) {
        warnings.push(`Line ${line}: could not read "${statement.length > 80 ? `${statement.slice(0, 77)}...` : statement}", left out`);
        continue;
      }
      if (reader.classesSeen) warnOnce('":::class" suffixes are ignored');
      if (reader.shapeSyntaxSeen) warnOnce('"@{ … }" node syntax is only partly supported: its label is used and the node is drawn as a rectangle');

      for (const g of groups) for (const ref of g) register(ref);
      links.forEach((link, i) => {
        for (const from of groups[i]) {
          for (const to of groups[i + 1]) edges.push({ from: from.id, to: to.id, ...link });
        }
      });
    }
  }

  if (stack.length > 0) warnOnce(`Subgraph "${stack[stack.length - 1]}" is missing its "end"; it was closed at the end of the diagram`);

  // `A --> someSubgraph` links to the subgraph itself, not to a new node.
  for (const id of subgraphs.keys()) {
    const node = nodes.get(id);
    if (node && !node.defined) nodes.delete(id);
  }

  for (const node of nodes.values()) {
    if (node.subgraph) subgraphs.get(node.subgraph)?.nodeIds.push(node.id);
  }
  for (const sg of subgraphs.values()) {
    const hasContent = (id: string): boolean => {
      const s = subgraphs.get(id)!;
      return s.nodeIds.length > 0 || [...subgraphs.values()].some((c) => c.parent === id && hasContent(c.id));
    };
    if (!hasContent(sg.id)) warnOnce(`Subgraph "${sg.id}" has no nodes and is not drawn`);
  }

  return {
    direction: directionOverride ?? direction,
    nodes: [...nodes.values()].map(({ defined: _defined, ...node }) => node),
    edges,
    subgraphs: [...subgraphs.values()],
    warnings,
  };
}
