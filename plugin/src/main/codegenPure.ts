/**
 * Pure helpers for the codegen module: no `figma` global, so `bun test` can run
 * them. The Figma-facing walk lives in codegen.ts.
 */

export const round = (n: number, places = 2): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Same rules as server/src/assets.ts `slug`, so asset hints match export_assets file stems. */
export const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[/=,.:]+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "node";

export const assetHint = (name: string): string => `${slug(name)}.svg`;

/** JSON with sorted keys, so two equal objects give the same key whatever their key order. */
export const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Dedupes style objects into `{ s1: {...}, s2: {...} }`; empty objects get no id. */
export class StyleTable {
  private ids = new Map<string, string>();
  readonly entries: Record<string, Record<string, unknown>> = {};
  constructor(private prefix: string) {}
  add(style: Record<string, unknown>): string | undefined {
    const clean = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) return undefined;
    const key = stableKey(clean);
    const found = this.ids.get(key);
    if (found) return found;
    const id = `${this.prefix}${this.ids.size + 1}`;
    this.ids.set(key, id);
    this.entries[id] = clean;
    return id;
  }
  get size() {
    return this.ids.size;
  }
}

export type LayoutMode = "row" | "column" | "wrap" | "grid" | "none";

export const layoutModeOf = (layoutMode: string, layoutWrap?: string): LayoutMode => {
  switch (layoutMode) {
    case "HORIZONTAL":
      return layoutWrap === "WRAP" ? "wrap" : "row";
    case "VERTICAL":
      return "column";
    case "GRID":
      return "grid";
    default:
      return "none";
  }
};

export const justifyOf = (primary: string): string | undefined =>
  ({ MIN: undefined, CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" } as Record<string, string | undefined>)[primary];

export const alignOf = (counter: string): string =>
  ({ MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" } as Record<string, string>)[counter] ?? "start";

export const sizingOf = (value: string | undefined): "fixed" | "hug" | "fill" | undefined =>
  value === "FIXED" ? "fixed" : value === "HUG" ? "hug" : value === "FILL" ? "fill" : undefined;

export const constraintOf = (c: string): string =>
  ({ MIN: "start", MAX: "end", CENTER: "center", STRETCH: "both", SCALE: "scale" } as Record<string, string>)[c] ?? "start";

export const blendOf = (mode: string | undefined): string | undefined =>
  !mode || mode === "NORMAL" || mode === "PASS_THROUGH" ? undefined : mode.toLowerCase().replace(/_/g, "-");

/** px number, "150%", or "auto". */
export const lineHeightOf = (lh: { unit: string; value?: number }): number | string =>
  lh.unit === "PIXELS" ? round(lh.value ?? 0) : lh.unit === "PERCENT" ? `${round(lh.value ?? 0)}%` : "auto";

/** px number, or "2%" (Figma's percent of font size). Zero stays 0. */
export const letterSpacingOf = (ls: { unit: string; value: number }): number | string =>
  ls.value === 0 ? 0 : ls.unit === "PIXELS" ? round(ls.value) : `${round(ls.value)}%`;

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);
export const isVectorType = (type: string) => VECTOR_TYPES.has(type);

/** What codegen.ts learns about a small container before deciding it is an icon. */
export type IconProbe = {
  type: string;
  name: string;
  width: number;
  height: number;
  /** Every visible descendant is a vector shape, ellipse, rectangle, line or a group of those. */
  vectorOnly: boolean;
  hasVectorDescendant: boolean;
};

export const ICON_MAX_SIZE = 48;

export const looksLikeIcon = (p: IconProbe): boolean => {
  if (isVectorType(p.type)) return true;
  if (!["INSTANCE", "FRAME", "GROUP", "COMPONENT"].includes(p.type)) return false;
  const named = /\b(icon|ico|glyph|logo)\b|^ic[-_ ]/i.test(p.name);
  const limit = named ? 64 : ICON_MAX_SIZE;
  return Math.max(p.width, p.height) <= limit && p.vectorOnly && p.hasVectorDescendant;
};

/** Minimal UTF-8 decoder: the plugin sandbox has no TextDecoder. */
export const utf8Decode = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b >= 0xc0 && b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b >= 0xe0 && b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
};

type Matrix = [[number, number, number], [number, number, number]];

/**
 * CSS angle for a Figma linear gradient. gradientTransform maps node space to
 * gradient space, where the gradient runs from (0, 0.5) to (1, 0.5); invert it
 * to find those points in the node's unit square. Exact for square nodes.
 */
export const gradientAngle = (t: Matrix): number => {
  const [[a, b, c], [d, e, f]] = t;
  const det = a * e - b * d;
  if (det === 0) return 180;
  const inv = (x: number, y: number) => [(e * (x - c) - b * (y - f)) / det, (-d * (x - c) + a * (y - f)) / det];
  const [x0, y0] = inv(0, 0.5);
  const [x1, y1] = inv(1, 0.5);
  const deg = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI + 90;
  return round(((deg % 360) + 360) % 360, 1);
};

/* ── run_script result serialisation ───────────────────────────────────────── */

export const SCRIPT_RESULT_MAX_CHARS = 200_000;

const looksLikeNode = (v: Record<string, unknown>) =>
  typeof v.id === "string" && typeof v.type === "string" && "name" in v && ("parent" in v || "children" in v);

/**
 * Turns whatever a script returned into plain JSON: Figma nodes become
 * {id, name, type}, figma.mixed becomes "mixed", cycles are cut, typed arrays
 * are summarised, and depth is capped.
 */
export const toPlainJson = (value: unknown, maxDepth = 12): unknown => {
  const seen = new Set<unknown>();
  const go = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "undefined") return undefined;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "symbol") return v.description === "figma.mixed" || String(v).includes("mixed") ? "mixed" : String(v);
    if (typeof v === "function") return "[function]";
    if (v instanceof Error) return { error: v.message };
    if (v instanceof Uint8Array) return { bytes: v.length };
    // A Date has no own keys, so the object walk below would return {}.
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (typeof v !== "object") return String(v);
    const obj = v as Record<string, unknown>;
    try {
      if (looksLikeNode(obj)) return { id: obj.id, name: obj.name, type: obj.type };
    } catch {
      // a removed node throws on access; fall through
    }
    if (seen.has(v)) return "[circular]";
    if (depth >= maxDepth) return "[max depth]";
    seen.add(v);
    try {
      if (v instanceof Map) return Array.from(v.entries()).map(([k, x]) => [go(k, depth + 1), go(x, depth + 1)]);
      if (v instanceof Set) return Array.from(v.values()).map((x) => go(x, depth + 1));
      if (Array.isArray(v)) return v.map((x) => {
        const r = go(x, depth + 1);
        return r === undefined ? null : r;
      });
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        let item: unknown;
        try {
          item = obj[key];
        } catch (err) {
          item = { error: err instanceof Error ? err.message : String(err) };
        }
        const r = go(item, depth + 1);
        if (r !== undefined) out[key] = r;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return go(value, 0);
};

/** Plain JSON of the value, replaced by a truncated preview when it is too large. */
export const capScriptResult = (value: unknown, maxChars = SCRIPT_RESULT_MAX_CHARS): { result: unknown; truncated?: string } => {
  const plain = toPlainJson(value);
  const json = plain === undefined ? undefined : JSON.stringify(plain);
  if (json === undefined || json.length <= maxChars) return { result: plain };
  return {
    result: json.slice(0, maxChars),
    truncated: `The result was ${json.length} characters of JSON; only the first ${maxChars} are returned, as a string. Return less (e.g. map nodes to ids).`,
  };
};

export const formatLogArgs = (args: unknown[], maxChars = 2000): string => {
  const text = args
    .map((a) => (typeof a === "string" ? a : (() => {
      try {
        return JSON.stringify(toPlainJson(a, 6));
      } catch {
        return String(a);
      }
    })()))
    .join(" ");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
};

/* ── markdown → canvas text blocks ─────────────────────────────────────────── */

export type DocBlock = { kind: "h1" | "h2" | "h3" | "p" | "li" | "code"; text: string };

/** Just enough markdown for a docs frame: headings, bullets, fenced code, tables kept as text. */
export const markdownBlocks = (markdown: string): DocBlock[] => {
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const inline = (s: string) => s.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]*)\*\*/g, "$1").replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)");
  for (const line of markdown.split(/\r?\n/)) {
    if (code) {
      if (line.startsWith("```")) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      flush();
      code = [];
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: `h${heading[1].length}` as DocBlock["kind"], text: inline(heading[2]) });
    } else if (/^\s*[-*]\s+/.test(line)) {
      flush();
      blocks.push({ kind: "li", text: inline(line.replace(/^\s*[-*]\s+/, "")) });
    } else if (line.trim().startsWith("|")) {
      flush();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      blocks.push({ kind: "code", text: cells.join("  ·  ") });
    } else if (line.trim() === "" || line.startsWith("<!--")) {
      flush();
    } else {
      para.push(inline(line.trim()));
    }
  }
  flush();
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
};

/** Wraps user code as an async function body; the async arrow is parsed at run time, never transpiled. */
export const scriptSource = (code: string) => `"use strict";\nreturn (async () => {\n${code}\n})();`;
