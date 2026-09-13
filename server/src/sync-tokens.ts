/**
 * Pure token parsers for import_tokens: W3C DTCG JSON, CSS custom properties and
 * Tailwind v4 `@theme` blocks, normalised to one shape the plugin can diff
 * against the file's variables. No Figma, no I/O — tested directly.
 *
 * Naming is the inverse of assets.ts's exporters, so export → import lands on
 * the same variables: tokensToJson nests `Collection.path.to.token`, and
 * tokensToCss writes `--collection-path-to-token` (lowercased, so the plugin
 * matches CSS names by that same slug rather than exactly).
 */

export type TokenType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
/** `alias` is a slash path; its first segment may be a collection name. */
export type TokenAlias = { alias: string };
export type TokenValue = string | number | boolean | TokenAlias;

export interface NormalisedToken {
  /** Undefined when the source does not say (CSS without `collection`); the plugin decides. */
  collection?: string;
  name: string;
  /** Undefined only for an alias whose target is not in this file; the plugin resolves it. */
  type?: TokenType;
  valuesByMode: Record<string, TokenValue>;
  description?: string;
}

export type TokenFormat = "dtcg" | "css" | "tailwind";

export interface ParseResult {
  format: TokenFormat;
  tokens: NormalisedToken[];
  warnings: string[];
  notes: string[];
}

/** The collection's default mode: `$value` without modes, `:root`, `@theme`. */
export const DEFAULT_MODE = ":default";
export const DEFAULT_COLLECTION = "Tokens";

export const isAlias = (v: unknown): v is TokenAlias =>
  typeof v === "object" && v !== null && typeof (v as TokenAlias).alias === "string";

/** Same slug as assets.ts cssName, minus the leading `--`. */
export const slug = (parts: string[]) =>
  parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/* ── colours ──────────────────────────────────────────────────────────────── */

export interface ParsedColor {
  hex: string;
  outOfGamut?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");

export const rgbaToHex = (r: number, g: number, b: number, a = 1) =>
  `#${hex2(r)}${hex2(g)}${hex2(b)}${Math.round(clamp01(a) * 255) < 255 ? hex2(a) : ""}`;

/** `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd` → lowercase 6 or 8 digit hex (alpha dropped when opaque). */
export const normaliseHex = (value: string): string | null => {
  const h = value.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  const full = (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h).toLowerCase();
  return full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`;
};

const NAMED: Record<string, string> = {
  transparent: "#00000000", black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff",
  fuchsia: "#ff00ff", gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000",
  olive: "#808000", lime: "#00ff00", teal: "#008080", navy: "#000080", purple: "#800080", orange: "#ffa500",
};

const splitArgs = (inner: string): { parts: string[]; alpha?: string } => {
  const [main, alpha] = inner.split("/").map((s) => s.trim());
  const parts = main.includes(",") ? main.split(",").map((s) => s.trim()) : main.split(/\s+/);
  // Legacy comma syntax carries alpha as a fourth argument.
  if (alpha === undefined && parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
  return { parts, alpha };
};

const alphaOf = (s: string | undefined) =>
  s === undefined || s === "none" ? 1 : s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s);

const hueDeg = (s: string) => {
  if (s === "none") return 0;
  const v = parseFloat(s);
  if (s.endsWith("turn")) return v * 360;
  if (s.endsWith("grad")) return v * 0.9;
  if (s.endsWith("rad")) return (v * 180) / Math.PI;
  return v;
};

const GAMUT_TOLERANCE = 0.002;

/** OKLab → gamma-encoded sRGB, unclamped. */
export const oklabToSrgb = (L: number, a: number, b: number): [number, number, number] => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((x) => {
    const sign = x < 0 ? -1 : 1;
    const abs = Math.abs(x);
    return sign * (abs <= 0.0031308 ? 12.92 * abs : 1.055 * abs ** (1 / 2.4) - 0.055);
  }) as [number, number, number];
};

export const oklchToSrgb = (L: number, C: number, H: number) => {
  const rad = (H * Math.PI) / 180;
  return oklabToSrgb(L, C * Math.cos(rad), C * Math.sin(rad));
};

const fromSrgb = (rgb: [number, number, number], a: number): ParsedColor => {
  const outOfGamut = rgb.some((v) => v < -GAMUT_TOLERANCE || v > 1 + GAMUT_TOLERANCE);
  return { hex: rgbaToHex(rgb[0], rgb[1], rgb[2], a), ...(outOfGamut ? { outOfGamut } : {}) };
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
};

/** A CSS colour string → hex, or null when it is not a colour we understand. */
export const parseCssColor = (input: string): ParsedColor | null => {
  const value = input.trim().toLowerCase();
  if (value.startsWith("#")) {
    const hex = normaliseHex(value);
    return hex ? { hex } : null;
  }
  if (NAMED[value]) return { hex: normaliseHex(NAMED[value])! };
  const fn = value.match(/^(rgba?|hsla?|oklch|oklab)\((.*)\)$/);
  if (!fn) return null;
  const { parts, alpha } = splitArgs(fn[2]);
  if (parts.length !== 3) return null;
  const a = alphaOf(alpha);
  const pct = (s: string, full: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * full : parseFloat(s));
  let result: ParsedColor;
  switch (fn[1]) {
    case "rgb":
    case "rgba":
      result = fromSrgb(parts.map((p) => pct(p, 255) / 255) as [number, number, number], a);
      break;
    case "hsl":
    case "hsla":
      result = fromSrgb(hslToRgb(hueDeg(parts[0]), pct(parts[1], 100) / 100, pct(parts[2], 100) / 100), a);
      break;
    case "oklch":
      result = fromSrgb(oklchToSrgb(pct(parts[0], 1), pct(parts[1], 0.4), hueDeg(parts[2])), a);
      break;
    default:
      result = fromSrgb(oklabToSrgb(pct(parts[0], 1), pct(parts[1], 0.4), pct(parts[2], 0.4)), a);
  }
  return [result.hex].some((h) => h.includes("NaN")) || Number.isNaN(a) ? null : result;
};

/* ── shared value conversion ──────────────────────────────────────────────── */

interface Collector {
  warnings: string[];
  remCount: number;
  secondsCount: number;
  gamut: string[];
}

const newCollector = (): Collector => ({ warnings: [], remCount: 0, secondsCount: 0, gamut: [] });

const notesOf = (c: Collector): string[] => {
  const notes: string[] = [];
  if (c.remCount) notes.push(`${c.remCount} rem/em value(s) converted to px at 16px per rem.`);
  if (c.secondsCount) notes.push(`${c.secondsCount} duration(s) in seconds converted to milliseconds.`);
  if (c.gamut.length) {
    notes.push(
      `${c.gamut.length} colour(s) are outside sRGB and were clamped: ${c.gamut.slice(0, 10).join(", ")}${c.gamut.length > 10 ? ", …" : ""}.`
    );
  }
  return notes;
};

const DIMENSION = /^(-?\d*\.?\d+)(px|rem|em|ms|s)?$/;

/** "16px" / "1rem" / "200ms" / "12" → a number (px or ms), or null. */
const parseDimension = (raw: string, c: Collector): number | null => {
  const m = raw.trim().match(DIMENSION);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === "rem" || m[2] === "em") {
    c.remCount++;
    return n * 16;
  }
  if (m[2] === "s") {
    c.secondsCount++;
    return n * 1000;
  }
  return n;
};

const colorValue = (raw: string, where: string, c: Collector): string | null => {
  const parsed = parseCssColor(raw);
  if (!parsed) return null;
  if (parsed.outOfGamut) c.gamut.push(where);
  return parsed.hex;
};

/* ── DTCG ─────────────────────────────────────────────────────────────────── */

const DTCG_ALIAS = /^\{([^{}]+)\}$/;

const dtcgTypeOf = (t: string | undefined): TokenType | "skip" | undefined => {
  switch (t) {
    case undefined:
      return undefined;
    case "color":
      return "COLOR";
    case "number":
    case "dimension":
    case "fontWeight":
    case "duration":
      return "FLOAT";
    case "string":
    case "fontFamily":
      return "STRING";
    case "boolean":
      return "BOOLEAN";
    default:
      return "skip";
  }
};

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, "extra-light": 200, "ultra-light": 200, light: 300, normal: 400, regular: 400,
  book: 400, medium: 500, "semi-bold": 600, "demi-bold": 600, bold: 700, "extra-bold": 800, "ultra-bold": 800,
  black: 900, heavy: 900,
};

const dtcgValue = (
  raw: unknown,
  type: TokenType | undefined,
  dtcgType: string | undefined,
  where: string,
  c: Collector
): { value: TokenValue; type: TokenType | undefined } | string => {
  if (typeof raw === "string") {
    const alias = raw.match(DTCG_ALIAS);
    if (alias) return { value: { alias: alias[1].split(".").join("/") }, type };
  }
  const inferred =
    type ??
    (typeof raw === "number" ? "FLOAT" : typeof raw === "boolean" ? "BOOLEAN" : typeof raw === "string" ? (parseCssColor(raw) ? "COLOR" : "STRING") : undefined);
  switch (inferred) {
    case "COLOR": {
      if (typeof raw === "string") {
        const hex = colorValue(raw, where, c);
        return hex ? { value: hex, type: "COLOR" } : `"${raw}" is not a colour this importer understands`;
      }
      if (raw && typeof raw === "object") {
        const o = raw as { colorSpace?: string; components?: unknown[]; alpha?: number; hex?: string };
        const a = typeof o.alpha === "number" ? o.alpha : 1;
        const comps = (o.components ?? []).map((v) => (v === "none" ? 0 : Number(v)));
        if (o.colorSpace === "srgb" && comps.length === 3) return { value: rgbaToHex(comps[0], comps[1], comps[2], a), type: "COLOR" };
        if ((o.colorSpace === "oklch" || o.colorSpace === "oklab") && comps.length === 3) {
          const rgb = o.colorSpace === "oklch" ? oklchToSrgb(comps[0], comps[1], comps[2]) : oklabToSrgb(comps[0], comps[1], comps[2]);
          const parsed = fromSrgb(rgb, a);
          if (parsed.outOfGamut) c.gamut.push(where);
          return { value: parsed.hex, type: "COLOR" };
        }
        if (typeof o.hex === "string" && normaliseHex(o.hex)) {
          const base = normaliseHex(o.hex)!.slice(0, 7);
          return { value: a < 1 ? rgbaToHex(...(hexChannels(base) as [number, number, number]), a) : base, type: "COLOR" };
        }
      }
      return `unsupported colour value ${JSON.stringify(raw)}`;
    }
    case "FLOAT": {
      if (typeof raw === "number") return { value: raw, type: "FLOAT" };
      if (typeof raw === "string") {
        if (dtcgType === "fontWeight" && FONT_WEIGHTS[raw.toLowerCase()]) return { value: FONT_WEIGHTS[raw.toLowerCase()], type: "FLOAT" };
        const n = parseDimension(raw, c);
        return n === null ? `"${raw}" is not a number` : { value: n, type: "FLOAT" };
      }
      if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "number") {
        const { value, unit } = raw as { value: number; unit?: string };
        const n = parseDimension(`${value}${unit ?? ""}`, c);
        return n === null ? `unsupported unit ${unit}` : { value: n, type: "FLOAT" };
      }
      return `unsupported number value ${JSON.stringify(raw)}`;
    }
    case "STRING":
      if (typeof raw === "string") return { value: raw, type: "STRING" };
      if (Array.isArray(raw)) return { value: raw.map(String).join(", "), type: "STRING" };
      return `unsupported string value ${JSON.stringify(raw)}`;
    case "BOOLEAN":
      return typeof raw === "boolean" ? { value: raw, type: "BOOLEAN" } : `"${String(raw)}" is not true/false`;
    default:
      return `cannot tell the type of ${JSON.stringify(raw)}`;
  }
};

const hexChannels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Our tokensToJson writes paint/text/effect styles under a top-level `styles` group. */
const isExporterStylesGroup = (key: string, node: unknown) =>
  key === "styles" &&
  !!node &&
  typeof node === "object" &&
  Object.keys(node).every((k) => ["color", "typography", "shadow"].includes(k));

export function parseDtcg(content: string | Record<string, unknown>, options: { collection?: string } = {}): ParseResult {
  const doc = typeof content === "string" ? (JSON.parse(content) as Record<string, unknown>) : content;
  const c = newCollector();
  const tokens: NormalisedToken[] = [];

  const visit = (node: Record<string, unknown>, path: string[], inheritedType: string | undefined) => {
    const groupType = typeof node.$type === "string" ? node.$type : inheritedType;
    if ("$value" in node) {
      const where = path.join(".");
      const mapped = dtcgTypeOf(groupType);
      if (mapped === "skip") {
        c.warnings.push(`${where}: $type "${groupType}" has no Figma variable equivalent; skipped`);
        return;
      }
      // Collection: the top-level group, as tokensToJson writes it — unless the
      // caller names one, in which case a matching top-level group is dropped.
      let collection: string;
      let nameParts: string[];
      if (options.collection) {
        collection = options.collection;
        nameParts = path.length > 1 && slug([path[0]]) === slug([options.collection]) ? path.slice(1) : path;
      } else if (path.length > 1) {
        collection = path[0];
        nameParts = path.slice(1);
      } else {
        collection = DEFAULT_COLLECTION;
        nameParts = path;
      }
      const ext = node.$extensions as { modes?: Record<string, unknown> } | undefined;
      const rawModes: Record<string, unknown> =
        ext?.modes && typeof ext.modes === "object" && Object.keys(ext.modes).length
          ? ext.modes
          : { [DEFAULT_MODE]: node.$value };
      const valuesByMode: Record<string, TokenValue> = {};
      let type: TokenType | undefined = mapped;
      for (const [mode, raw] of Object.entries(rawModes)) {
        const converted = dtcgValue(raw, type, groupType, where, c);
        if (typeof converted === "string") {
          c.warnings.push(`${where}${mode === DEFAULT_MODE ? "" : ` (${mode})`}: ${converted}; skipped`);
          continue;
        }
        valuesByMode[mode] = converted.value;
        type = type ?? converted.type;
      }
      if (Object.keys(valuesByMode).length === 0) return;
      tokens.push({
        collection,
        name: nameParts.join("/"),
        ...(type ? { type } : {}),
        valuesByMode,
        ...(typeof node.$description === "string" ? { description: node.$description } : {}),
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || !child || typeof child !== "object" || Array.isArray(child)) continue;
      if (path.length === 0 && isExporterStylesGroup(key, child)) {
        c.warnings.push("`styles` holds paint, text and effect styles, not variables; skipped");
        continue;
      }
      visit(child as Record<string, unknown>, [...path, key], groupType);
    }
  };
  visit(doc, [], undefined);
  resolveAliasTypes(tokens, c);
  return { format: "dtcg", tokens, warnings: c.warnings, notes: notesOf(c) };
}

/* ── CSS / Tailwind ───────────────────────────────────────────────────────── */

interface Block {
  prelude: string;
}

interface Declaration {
  name: string;
  value: string;
  blocks: string[];
}

/** Custom-property declarations with the preludes of every enclosing block. */
export const scanCssDeclarations = (css: string): Declaration[] => {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: Block[] = [];
  const out: Declaration[] = [];
  let buffer = "";
  let quote: string | null = null;
  let parens = 0;

  const flushDeclaration = () => {
    const text = buffer.trim();
    buffer = "";
    const m = text.match(/^(--[\w-]+)\s*:\s*([\s\S]*)$/);
    if (m && stack.length) out.push({ name: m[1], value: m[2].replace(/!important\s*$/i, "").trim(), blocks: stack.map((b) => b.prelude) });
  };

  for (const ch of src) {
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === "(") parens++;
    if (ch === ")") parens = Math.max(0, parens - 1);
    if (parens > 0) {
      buffer += ch;
      continue;
    }
    if (ch === "{") {
      stack.push({ prelude: buffer.trim() });
      buffer = "";
    } else if (ch === "}") {
      flushDeclaration();
      stack.pop();
    } else if (ch === ";") {
      flushDeclaration();
    } else {
      buffer += ch;
    }
  }
  return out;
};

/**
 * Which mode a declaration belongs to, from its enclosing blocks.
 * Returns null for rules that are not theme scopes (e.g. `.button { --x }`).
 */
export const modeForBlocks = (blocks: string[]): { mode: string; tailwind: boolean } | null => {
  let media: string | null = null;
  let selector: string | null = null;
  let tailwind = false;
  for (const prelude of blocks) {
    if (/^@theme\b/.test(prelude)) tailwind = true;
    else if (/^@media\b/.test(prelude)) {
      const scheme = prelude.match(/prefers-color-scheme\s*:\s*(dark|light)/);
      if (scheme) media = scheme[1];
    } else if (!prelude.startsWith("@")) selector = prelude;
  }
  if (tailwind && !selector) return { mode: DEFAULT_MODE, tailwind: true };
  if (!selector) return null;
  for (const part of selector.split(",")) {
    const s = part.replace(/:not\([^)]*\)/g, "").replace(/:(where|is)\(([^)]*)\)/g, "$2").trim();
    const attr = s.match(/\[data-[\w-]+\s*=\s*["']?([^"'\]]+)["']?\s*\]/);
    if (attr) return { mode: attr[1], tailwind };
    const classes = s.match(/\.([\w-]+)/g);
    // `.dark` and `:root.dark` are theme scopes; `.button` is a component's own variable.
    const scoped = /^(:root|html|:host|body)(\.[\w-]+)+$/.test(s);
    const themeish = /^\.([\w-]*(dark|light|theme|mode)[\w-]*)$/i.test(s);
    if (classes && (scoped || themeish)) return { mode: classes[classes.length - 1].slice(1), tailwind };
    if (/^(:root|html|:host)$/.test(s)) return { mode: media ?? DEFAULT_MODE, tailwind };
  }
  return null;
};

const CSS_VAR_ALIAS = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/;

const cssNameParts = (name: string) => name.replace(/^--/, "").split("-").filter(Boolean);

const cssValue = (raw: string, where: string, c: Collector): { value: TokenValue; type?: TokenType } | string | null => {
  const value = raw.trim();
  if (value === "" || value === "initial" || value === "inherit" || value === "unset") return null;
  const alias = value.match(CSS_VAR_ALIAS);
  if (alias) return { value: { alias: cssNameParts(alias[1]).join("/") } };
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return { value: JSON.parse(value) as string, type: "STRING" };
  if (/^'[^']*'$/.test(value)) return { value: value.slice(1, -1), type: "STRING" };
  if (value === "true" || value === "false") return { value: value === "true", type: "BOOLEAN" };
  const color = parseCssColor(value);
  if (color) {
    if (color.outOfGamut) c.gamut.push(where);
    return { value: color.hex, type: "COLOR" };
  }
  const n = parseDimension(value, c);
  if (n !== null) return { value: n, type: "FLOAT" };
  if (/^[\w-]+\(/.test(value)) return `${value.slice(0, 60)} is a CSS function this importer cannot evaluate`;
  if (/^-?\d/.test(value)) return `${value} has a unit Figma variables cannot hold`;
  return { value, type: "STRING" };
};

export function parseCss(content: string, options: { collection?: string; tailwindOnly?: boolean } = {}): ParseResult {
  const c = newCollector();
  const byName = new Map<string, NormalisedToken>();
  let unscoped = 0;
  // tokensToCss also writes paint styles as `--style-*`; they are styles, not variables.
  const fromOurExporter = /\/\*\s*Design tokens exported from/.test(content);
  let styleLines = 0;

  for (const decl of scanCssDeclarations(content)) {
    if (decl.name.includes("*")) continue;
    if (fromOurExporter && decl.name.startsWith("--style-")) {
      styleLines++;
      continue;
    }
    const scope = modeForBlocks(decl.blocks);
    if (options.tailwindOnly && !scope?.tailwind) continue;
    if (!scope) {
      unscoped++;
      continue;
    }
    const where = decl.name;
    const converted = cssValue(decl.value, where, c);
    if (converted === null) continue;
    if (typeof converted === "string") {
      c.warnings.push(`${where}: ${converted}; skipped`);
      continue;
    }
    let parts = cssNameParts(decl.name);
    let collection: string | undefined;
    if (options.collection) {
      collection = options.collection;
      const prefix = cssNameParts(`--${slug([options.collection])}`);
      if (parts.length > prefix.length && prefix.every((p, i) => parts[i] === p)) parts = parts.slice(prefix.length);
    }
    const key = parts.join("/");
    const token = byName.get(key) ?? { ...(collection ? { collection } : {}), name: key, valuesByMode: {} };
    if (converted.type && token.type && token.type !== converted.type && !isAlias(converted.value)) {
      c.warnings.push(`${where}: ${scope.mode} is ${converted.type} but another mode is ${token.type}; skipped`);
      continue;
    }
    token.type = token.type ?? converted.type;
    token.valuesByMode[scope.mode] = converted.value;
    byName.set(key, token);
  }
  if (styleLines) c.warnings.push(`${styleLines} --style-* paint style(s) from export_tokens skipped; they are styles, not variables`);
  if (unscoped) c.warnings.push(`${unscoped} custom propert${unscoped === 1 ? "y is" : "ies are"} set inside rules that are not a theme scope (:root, [data-theme], .dark, @media prefers-color-scheme, @theme); skipped`);
  const tokens = [...byName.values()];
  resolveAliasTypes(tokens, c);
  return { format: options.tailwindOnly ? "tailwind" : "css", tokens, warnings: c.warnings, notes: notesOf(c) };
}

/* ── aliases, auto-detect ─────────────────────────────────────────────────── */

const fullPath = (t: NormalisedToken) => (t.collection ? `${t.collection}/${t.name}` : t.name);

/** Find an alias target among parsed tokens: exact full path, same collection, then slug. */
export const findAliasTarget = <T extends { collection?: string; name: string }>(
  alias: string,
  from: { collection?: string },
  candidates: T[]
): T | undefined => {
  const exact = candidates.find((t) => (t.collection ? `${t.collection}/${t.name}` : t.name) === alias);
  if (exact) return exact;
  const sameCollection = candidates.find((t) => t.collection === from.collection && t.name === alias);
  if (sameCollection) return sameCollection;
  const key = slug(alias.split("/"));
  const bySlug = candidates.filter((t) => slug([...(t.collection ? [t.collection] : []), ...t.name.split("/")]) === key);
  if (bySlug.length === 1) return bySlug[0];
  const byName = candidates.filter((t) => slug(t.name.split("/")) === key);
  return byName.length === 1 ? byName[0] : undefined;
};

const resolveAliasTypes = (tokens: NormalisedToken[], c: Collector) => {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const t of tokens) {
      if (t.type) continue;
      for (const v of Object.values(t.valuesByMode)) {
        if (!isAlias(v)) continue;
        const target = findAliasTarget(v.alias, t, tokens);
        if (target?.type) {
          t.type = target.type;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  const unresolved = tokens.filter((t) => !t.type).map(fullPath);
  if (unresolved.length) {
    c.warnings.push(`${unresolved.length} alias token(s) point outside this file; their type comes from the Figma variable they point to: ${unresolved.slice(0, 10).join(", ")}`);
  }
};

export function parseTokens(
  content: string,
  options: { format?: TokenFormat | "auto"; collection?: string } = {}
): ParseResult {
  let format = options.format ?? "auto";
  if (format === "auto") {
    const trimmed = content.trimStart();
    format = trimmed.startsWith("{") ? "dtcg" : "css";
  }
  switch (format) {
    case "dtcg":
      try {
        return parseDtcg(content, options);
      } catch (err) {
        if (err instanceof SyntaxError) throw new Error(`Tokens are not valid JSON: ${err.message}`);
        throw err;
      }
    case "tailwind":
      return parseCss(content, { collection: options.collection, tailwindOnly: true });
    default:
      return parseCss(content, { collection: options.collection });
  }
}
