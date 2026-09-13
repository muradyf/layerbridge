/**
 * Pure renderers for get_code_context and generate_component_docs. No I/O, so
 * the tests can import them straight from dist/.
 *
 * One model drives both code formats: every node becomes a list of CSS
 * declarations (layoutDecls + styleDecls + textDecls). html-css prints them;
 * jsx-tailwind maps each declaration to a class. The two formats cannot drift
 * apart on what a layer looks like.
 */
import { cssName, tokenPath } from "./assets.js";

/* ── the payload codegen_scan returns (plugin/src/main/codegen.ts) ────────── */

export type Bound = { value: number | string; var?: string; varId?: string; collection?: string; css?: string };
export type Val = number | string | Bound;

export type Paint = {
  color?: Val;
  opacity?: number;
  blend?: string;
  gradient?: { kind: string; angle?: number; stops: { at: number; color: Val }[] };
  image?: string | null;
  scale?: string;
  unsupported?: string;
};
export type Effect = { type: string; x?: Val; y?: Val; blur?: Val; spread?: Val; color?: Val; radius?: Val };
export type NodeStyle = {
  fills?: Paint[] | "mixed";
  fillStyle?: string;
  stroke?: { paints: Paint[] | "mixed"; weight?: Val | Val[]; align?: string; dash?: number[]; style?: string };
  radius?: Val | Val[];
  effects?: Effect[];
  effectStyle?: string;
  opacity?: Val;
  blend?: string;
};
export type TextStyle = {
  family?: Val;
  weight?: Val;
  fontStyle?: string;
  italic?: boolean;
  size?: Val;
  lineHeight?: Val;
  letterSpacing?: Val;
  case?: string;
  decoration?: string;
  color?: Val;
  colorOpacity?: number;
  textStyle?: string;
  colorStyle?: string;
  align?: string;
  truncate?: number;
};
export type Position = { x: number; y: number; right: number; bottom: number; h: string; v: string };
export type Layout = {
  mode?: "row" | "column" | "wrap" | "grid" | "none";
  gap?: Val;
  rowGap?: Val;
  padding?: Val[];
  justify?: string;
  align?: string;
  columns?: string[];
  rows?: string[];
  clip?: boolean;
  sizing?: { w: string; h: string };
  noWrap?: boolean;
  width?: Val;
  height?: Val;
  minWidth?: Val;
  maxWidth?: Val;
  minHeight?: Val;
  maxHeight?: Val;
  position?: Position;
  cell?: { row: number; column: number; rowSpan: number; columnSpan: number };
  rotation?: number;
};
export type Component = {
  name: string;
  set?: string;
  componentKey?: string;
  componentId?: string;
  variantProps?: Record<string, string>;
  props?: Record<string, string | boolean | { swap: string }>;
};
export type CodeNode = {
  id: string;
  name: string;
  type: string;
  hidden?: boolean;
  mask?: boolean;
  layout?: Layout;
  style?: string;
  text?: { content: string; style?: string; segments?: { content: string; style?: string }[] };
  component?: Component;
  imageRef?: string | null;
  assetHint?: string;
  svg?: string;
  svgBytes?: number;
  svgError?: string;
  childCount?: number;
  children?: CodeNode[];
};
export type CodeContext = {
  root: CodeNode;
  styles: Record<string, NodeStyle>;
  textStyles: Record<string, TextStyle>;
  meta: Record<string, unknown>;
};
export type Token = { css: string; name: string; collection: string; value: number | string };
export type CodeFormat = "json" | "jsx-tailwind" | "html-css";
export type Decl = [string, string];

/* ── values ───────────────────────────────────────────────────────────────── */

const num = (n: number) => String(Math.round(n * 100) / 100);

export const isBound = (v: unknown): v is Bound =>
  !!v && typeof v === "object" && !Array.isArray(v) && "value" in v && ("var" in v || "varId" in v);

/** The same custom-property name export_tokens writes for this variable. */
export const variableCssName = (collection: string, name: string) => cssName([collection, ...tokenPath(name)]);

/** Adds `css` to every variable-bound value and returns the tokens used, sorted. */
export function annotateVariables(ctx: CodeContext): Token[] {
  const tokens = new Map<string, Token>();
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (isBound(o)) {
      if (typeof o.var === "string") {
        o.css = variableCssName(String(o.collection ?? ""), o.var);
        if (!tokens.has(o.css)) tokens.set(o.css, { css: o.css, name: o.var, collection: String(o.collection ?? ""), value: o.value });
      }
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit(ctx.styles);
  visit(ctx.textStyles);
  visit(ctx.root);
  return [...tokens.values()].sort((a, b) => a.css.localeCompare(b.css));
}

/** `12px`, `0`, a string as-is, or `var(--token, 12px)` for a bound value. */
export const cssValue = (v: Val | undefined, unit = "px"): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return v === 0 ? "0" : `${num(v)}${unit}`;
  if (typeof v === "string") return v;
  const fallback = cssValue(v.value, unit);
  return v.css ? `var(${v.css}, ${fallback})` : fallback;
};

const rawNum = (v: Val | undefined): number | undefined =>
  typeof v === "number" ? v : isBound(v) && typeof v.value === "number" ? v.value : undefined;

const isZero = (v: Val | undefined) => v === undefined || (rawNum(v) === 0 && !(isBound(v) && v.css));

export const colorValue = (v: Val | undefined, opacity?: number): string | undefined => {
  const c = cssValue(v, "");
  if (c === undefined) return undefined;
  return opacity !== undefined && opacity < 1 && isBound(v) && v.css ? `color-mix(in srgb, ${c} ${num(opacity * 100)}%, transparent)` : c;
};

/* ── declarations ─────────────────────────────────────────────────────────── */

const FLEX = new Set(["row", "column", "wrap"]);

export function layoutDecls(node: CodeNode, parent: CodeNode | null, hasAbsoluteChild = false): Decl[] {
  const L = node.layout ?? {};
  const d: Decl[] = [];
  const push = (p: string, v: string | undefined) => {
    if (v !== undefined && v !== "") d.push([p, v]);
  };
  const mode = L.mode;
  if (node.hidden) push("display", "none");
  else if (mode && FLEX.has(mode)) push("display", "flex");
  else if (mode === "grid") push("display", "grid");

  if (mode && FLEX.has(mode)) {
    if (mode === "column") push("flex-direction", "column");
    if (mode === "wrap") push("flex-wrap", "wrap");
    if (mode === "wrap" && L.rowGap !== undefined) {
      push("column-gap", cssValue(L.gap));
      push("row-gap", cssValue(L.rowGap));
    } else push("gap", cssValue(L.gap));
    push("justify-content", ({ center: "center", end: "flex-end", "space-between": "space-between" } as Record<string, string>)[L.justify ?? ""]);
    push("align-items", ({ start: "flex-start", center: "center", end: "flex-end", baseline: "baseline" } as Record<string, string>)[L.align ?? ""]);
  } else if (mode === "grid") {
    push("grid-template-columns", L.columns?.join(" "));
    if (L.rows?.some((r) => r !== "auto")) push("grid-template-rows", L.rows.join(" "));
    push("column-gap", cssValue(L.gap));
    push("row-gap", cssValue(L.rowGap));
  }
  if (L.padding) {
    ["top", "right", "bottom", "left"].forEach((side, i) => {
      if (!isZero(L.padding![i])) push(`padding-${side}`, cssValue(L.padding![i]));
    });
  }

  const pm = parent?.layout?.mode;
  const w = L.sizing?.w;
  const h = L.sizing?.h;
  const isText = node.type === "TEXT";
  const pos = L.position;
  if (pos) {
    push("position", "absolute");
    if (pos.h === "end") push("right", cssValue(pos.right));
    else {
      push("left", cssValue(pos.x));
      if (pos.h === "both") push("right", cssValue(pos.right));
    }
    if (pos.v === "end") push("bottom", cssValue(pos.bottom));
    else {
      push("top", cssValue(pos.y));
      if (pos.v === "both") push("bottom", cssValue(pos.bottom));
    }
    if (pos.h !== "both" && w !== "hug") push("width", cssValue(L.width));
    if (pos.v !== "both" && h !== "hug" && !isText) push("height", cssValue(L.height));
  } else {
    if (hasAbsoluteChild) push("position", "relative");
    const row = pm === "row" || pm === "wrap";
    if (w === "fill") {
      if (row) push("flex", "1 1 0%");
      else if (pm === "column") push("align-self", "stretch");
      else if (pm !== "grid") push("width", "100%");
    } else if (w === "fixed") {
      push("width", cssValue(L.width));
      if (row) push("flex-shrink", "0");
    }
    if (h === "fill") {
      if (pm === "column") push("flex", "1 1 0%");
      else if (row) push("align-self", "stretch");
      else if (pm !== "grid") push("height", "100%");
    } else if (h === "fixed" && !isText) {
      push("height", cssValue(L.height));
      if (pm === "column") push("flex-shrink", "0");
    }
  }
  push("min-width", cssValue(L.minWidth));
  push("max-width", cssValue(L.maxWidth));
  push("min-height", cssValue(L.minHeight));
  push("max-height", cssValue(L.maxHeight));
  if (L.clip) push("overflow", "hidden");
  if (L.rotation) push("transform", `rotate(${num(-L.rotation)}deg)`);
  if (L.noWrap) push("white-space", "nowrap");
  if (L.cell && pm === "grid") {
    if (L.cell.columnSpan > 1) push("grid-column", `span ${L.cell.columnSpan} / span ${L.cell.columnSpan}`);
    if (L.cell.rowSpan > 1) push("grid-row", `span ${L.cell.rowSpan} / span ${L.cell.rowSpan}`);
  }
  // Keep the first of any repeated property (flex-shrink can be pushed for both axes).
  const seen = new Set<string>();
  return d.filter(([p]) => (seen.has(p) ? false : (seen.add(p), true)));
}

const stops = (g: NonNullable<Paint["gradient"]>) => g.stops.map((s) => `${colorValue(s.color)} ${num(s.at)}%`).join(", ");

const paintLayer = (p: Paint): string | undefined => {
  if (p.color !== undefined) {
    const c = colorValue(p.color, p.opacity);
    return `linear-gradient(${c}, ${c})`;
  }
  if (p.gradient) {
    const g = p.gradient;
    if (g.kind === "linear") return `linear-gradient(${num(g.angle ?? 180)}deg, ${stops(g)})`;
    if (g.kind === "angular") return `conic-gradient(${stops(g)})`;
    return `radial-gradient(circle, ${stops(g)})`;
  }
  if (p.image !== undefined) return `url("${p.image ?? ""}")`;
  return undefined;
};

export function styleDecls(style: NodeStyle | undefined, kind: { isText?: boolean; isImage?: boolean } = {}): Decl[] {
  if (!style) return [];
  const d: Decl[] = [];
  const push = (p: string, v: string | undefined) => {
    if (v !== undefined && v !== "") d.push([p, v]);
  };
  if (!kind.isText && Array.isArray(style.fills)) {
    const fills = style.fills.filter((p) => !p.unsupported && !(kind.isImage && p.image !== undefined));
    if (fills.length === 1 && fills[0].color !== undefined) push("background-color", colorValue(fills[0].color, fills[0].opacity));
    else if (fills.length) {
      const layers = [...fills].reverse();
      push("background-image", layers.map(paintLayer).filter(Boolean).join(", "));
      if (layers.some((p) => p.image !== undefined)) {
        push("background-size", layers.map((p) => (p.scale === "fit" ? "contain" : p.scale === "tile" ? "auto" : p.image !== undefined ? "cover" : "auto")).join(", "));
        push("background-position", "center");
        if (!layers.some((p) => p.scale === "tile")) push("background-repeat", "no-repeat");
      }
    }
  }
  const stroke = style.stroke;
  const strokePaint = stroke && Array.isArray(stroke.paints) ? stroke.paints.find((p) => p.color !== undefined) : undefined;
  if (stroke && strokePaint) {
    const color = colorValue(strokePaint.color, strokePaint.opacity);
    const lineStyle = stroke.dash?.length ? "dashed" : "solid";
    if (stroke.align === "outside" && !Array.isArray(stroke.weight)) {
      push("outline-width", cssValue(stroke.weight ?? 1));
      push("outline-style", lineStyle);
      push("outline-color", color);
    } else {
      if (Array.isArray(stroke.weight)) {
        ["top", "right", "bottom", "left"].forEach((side, i) => {
          if (!isZero(stroke.weight && (stroke.weight as Val[])[i])) push(`border-${side}-width`, cssValue((stroke.weight as Val[])[i]));
        });
      } else push("border-width", cssValue(stroke.weight ?? 1));
      push("border-style", lineStyle);
      push("border-color", color);
    }
  }
  if (typeof style.radius === "string") push("border-radius", style.radius);
  else if (Array.isArray(style.radius)) {
    ["top-left", "top-right", "bottom-right", "bottom-left"].forEach((corner, i) => {
      const r = (style.radius as Val[])[i];
      if (!isZero(r)) push(`border-${corner}-radius`, cssValue(r));
    });
  } else if (style.radius !== undefined) push("border-radius", cssValue(style.radius));

  const shadows = (style.effects ?? []).filter((e) => e.type.endsWith("shadow"));
  if (shadows.length) {
    if (kind.isText) {
      push("text-shadow", shadows.filter((e) => e.type === "drop-shadow").map((e) => `${cssValue(e.x)} ${cssValue(e.y)} ${cssValue(e.blur)} ${colorValue(e.color)}`).join(", "));
    } else {
      push(
        "box-shadow",
        shadows.map((e) => `${e.type === "inner-shadow" ? "inset " : ""}${cssValue(e.x)} ${cssValue(e.y)} ${cssValue(e.blur)} ${cssValue(e.spread)} ${colorValue(e.color)}`).join(", ")
      );
    }
  }
  for (const e of style.effects ?? []) {
    const r = rawNum(e.radius);
    if (r === undefined) continue;
    // Figma's blur radius is twice CSS's blur().
    if (e.type === "layer-blur") push("filter", `blur(${num(r / 2)}px)`);
    if (e.type === "background-blur") push("backdrop-filter", `blur(${num(r / 2)}px)`);
  }
  if (style.opacity !== undefined) push("opacity", cssValue(style.opacity, ""));
  push("mix-blend-mode", style.blend);
  return d;
}

export function textDecls(t: TextStyle | undefined): Decl[] {
  if (!t) return [];
  const d: Decl[] = [];
  const push = (p: string, v: string | undefined) => {
    if (v !== undefined && v !== "") d.push([p, v]);
  };
  if (t.family !== undefined) {
    const quoted = (s: unknown) => `"${String(s)}"`;
    push("font-family", isBound(t.family) && t.family.css ? `var(${t.family.css}, ${quoted(t.family.value)})` : quoted(isBound(t.family) ? t.family.value : t.family));
  }
  push("font-size", cssValue(t.size));
  push("font-weight", cssValue(t.weight, ""));
  if (t.italic) push("font-style", "italic");
  const lh = t.lineHeight;
  if (typeof lh === "string") push("line-height", lh === "auto" ? "normal" : lh.endsWith("%") ? num(parseFloat(lh) / 100) : lh);
  else push("line-height", cssValue(lh));
  const ls = t.letterSpacing;
  if (typeof ls === "string" && ls.endsWith("%")) push("letter-spacing", `${num(parseFloat(ls) / 100)}em`);
  else if (!isZero(ls)) push("letter-spacing", cssValue(ls));
  if (t.align) push("text-align", t.align);
  if (t.case === "upper") push("text-transform", "uppercase");
  else if (t.case === "lower") push("text-transform", "lowercase");
  else if (t.case === "title") push("text-transform", "capitalize");
  else if (t.case === "small-caps" || t.case === "small-caps-forced") push("font-variant", "small-caps");
  if (t.decoration === "underline") push("text-decoration-line", "underline");
  else if (t.decoration === "strikethrough") push("text-decoration-line", "line-through");
  push("color", colorValue(t.color, t.colorOpacity));
  if (t.truncate === 1) {
    push("overflow", "hidden");
    push("text-overflow", "ellipsis");
    push("white-space", "nowrap");
  } else if (t.truncate && t.truncate > 1) {
    push("display", "-webkit-box");
    push("-webkit-line-clamp", String(t.truncate));
    push("-webkit-box-orient", "vertical");
    push("overflow", "hidden");
  }
  return d;
}

/* ── Tailwind ─────────────────────────────────────────────────────────────── */

/** Tailwind's default spacing scale in px (the part v3 and v4 share). */
const SPACING: Record<number, string> = {
  0: "0", 1: "px", 2: "0.5", 4: "1", 6: "1.5", 8: "2", 10: "2.5", 12: "3", 14: "3.5", 16: "4", 20: "5", 24: "6", 28: "7",
  32: "8", 36: "9", 40: "10", 44: "11", 48: "12", 56: "14", 64: "16", 80: "20", 96: "24", 112: "28", 128: "32", 144: "36",
  160: "40", 176: "44", 192: "48", 208: "52", 224: "56", 240: "60", 256: "64", 288: "72", 320: "80", 384: "96",
};
const FONT_SIZE: Record<number, string> = { 12: "xs", 14: "sm", 16: "base", 18: "lg", 20: "xl", 24: "2xl", 30: "3xl", 36: "4xl", 48: "5xl", 60: "6xl", 72: "7xl", 96: "8xl", 128: "9xl" };
const FONT_WEIGHT: Record<string, string> = { "100": "thin", "200": "extralight", "300": "light", "400": "normal", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold", "900": "black" };
/* Only the radii v3 and v4 agree on; 2px and 4px were renamed in v4, so they stay arbitrary. */
const RADIUS: Record<number, string> = { 6: "md", 8: "lg", 12: "xl", 16: "2xl", 24: "3xl" };
const OPACITY = new Set([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]);
const PX = /^(-?\d+(?:\.\d+)?)px$/;

/** An arbitrary value: no spaces (underscores stand for them), literal underscores escaped. */
export const arb = (v: string) => v.replace(/,\s+/g, ",").replace(/_/g, "\\_").replace(/\s+/g, "_");

const spacing = (prefix: string, v: string) => {
  if (v === "0") return `${prefix}-0`;
  const m = PX.exec(v);
  if (m) {
    const n = Number(m[1]);
    const key = SPACING[Math.abs(n)];
    if (key !== undefined) return `${n < 0 ? "-" : ""}${prefix}-${key}`;
  }
  return `${prefix}-[${arb(v)}]`;
};
const isVar = (v: string) => v.startsWith("var(");
const length = (prefix: string, v: string) => (isVar(v) ? `${prefix}-[length:${arb(v)}]` : `${prefix}-[${arb(v)}]`);
const color = (prefix: string, v: string, hintVars: boolean) =>
  v.startsWith("#") || (isVar(v) && !hintVars) ? `${prefix}-[${arb(v)}]` : `${prefix}-[color:${arb(v)}]`;
const radius = (prefix: string, v: string) => {
  if (v === "50%" || (PX.test(v) && Number(PX.exec(v)![1]) >= 9999)) return `${prefix}-full`;
  const m = PX.exec(v);
  if (m && RADIUS[Number(m[1])]) return `${prefix}-${RADIUS[Number(m[1])]}`;
  return `${prefix}-[${arb(v)}]`;
};
const SIDE: Record<string, string> = { top: "t", right: "r", bottom: "b", left: "l" };
const CORNER: Record<string, string> = { "top-left": "tl", "top-right": "tr", "bottom-right": "br", "bottom-left": "bl" };

const classesFor = (prop: string, v: string): string[] => {
  let m: RegExpExecArray | null;
  if ((m = /^border-(top|right|bottom|left)-width$/.exec(prop))) return [v === "1px" ? `border-${SIDE[m[1]]}` : length(`border-${SIDE[m[1]]}`, v)];
  if ((m = /^border-(top-left|top-right|bottom-right|bottom-left)-radius$/.exec(prop))) return [radius(`rounded-${CORNER[m[1]]}`, v)];
  switch (prop) {
    case "display":
      return [v === "flex" ? "flex" : v === "grid" ? "grid" : v === "none" ? "hidden" : `[display:${arb(v)}]`];
    case "flex-direction":
      return [v === "column" ? "flex-col" : "flex-row"];
    case "flex-wrap":
      return ["flex-wrap"];
    case "gap":
      return [spacing("gap", v)];
    case "column-gap":
      return [spacing("gap-x", v)];
    case "row-gap":
      return [spacing("gap-y", v)];
    case "justify-content":
      return [({ center: "justify-center", "flex-end": "justify-end", "space-between": "justify-between" } as Record<string, string>)[v] ?? "justify-start"];
    case "align-items":
      return [({ "flex-start": "items-start", center: "items-center", "flex-end": "items-end", baseline: "items-baseline" } as Record<string, string>)[v] ?? "items-stretch"];
    case "align-self":
      return [`self-${v}`];
    case "flex":
      return [v === "1 1 0%" ? "flex-1" : `flex-[${arb(v)}]`];
    case "flex-shrink":
      return [v === "0" ? "shrink-0" : "shrink"];
    case "width":
      return [v === "100%" ? "w-full" : spacing("w", v)];
    case "height":
      return [v === "100%" ? "h-full" : spacing("h", v)];
    case "min-width":
      return [`min-w-[${arb(v)}]`];
    case "max-width":
      return [`max-w-[${arb(v)}]`];
    case "min-height":
      return [`min-h-[${arb(v)}]`];
    case "max-height":
      return [`max-h-[${arb(v)}]`];
    case "position":
      return [v];
    case "top":
    case "right":
    case "bottom":
    case "left":
      return [spacing(prop, v)];
    case "transform": {
      const r = /^rotate\((-?)([\d.]+)deg\)$/.exec(v);
      return [r ? `${r[1]}rotate-[${r[2]}deg]` : `[transform:${arb(v)}]`];
    }
    case "overflow":
      return [`overflow-${v}`];
    case "white-space":
      return [v === "nowrap" ? "whitespace-nowrap" : `whitespace-${v}`];
    case "grid-template-columns":
    case "grid-template-rows": {
      const prefix = prop.endsWith("columns") ? "grid-cols" : "grid-rows";
      const parts = v.split(/\s+/);
      return [parts.every((p) => p === "1fr") ? `${prefix}-${parts.length}` : `${prefix}-[${arb(v)}]`];
    }
    case "grid-column":
    case "grid-row": {
      const span = /^span (\d+)/.exec(v);
      return [span ? `${prop === "grid-column" ? "col" : "row"}-span-${span[1]}` : `[${prop}:${arb(v)}]`];
    }
    case "background-color":
      return [color("bg", v, false)];
    case "background-image":
      return [`bg-[${arb(v)}]`];
    case "background-size":
      return [v === "cover" ? "bg-cover" : v === "contain" ? "bg-contain" : `[background-size:${arb(v)}]`];
    case "background-position":
      return [v === "center" ? "bg-center" : `[background-position:${arb(v)}]`];
    case "background-repeat":
      return [v === "no-repeat" ? "bg-no-repeat" : "bg-repeat"];
    case "border-width":
      return [v === "1px" ? "border" : length("border", v)];
    case "border-style":
      return v === "solid" ? [] : [`border-${v}`];
    case "border-color":
      return [color("border", v, true)];
    case "outline-width":
      return ["outline", length("outline", v)];
    case "outline-style":
      return v === "solid" ? [] : [`outline-${v}`];
    case "outline-color":
      return [color("outline", v, true)];
    case "border-radius":
      return [radius("rounded", v)];
    case "box-shadow":
      return [`shadow-[${arb(v)}]`];
    case "filter":
    case "backdrop-filter": {
      const b = /^blur\((.+)\)$/.exec(v);
      const prefix = prop === "filter" ? "blur" : "backdrop-blur";
      return [b ? `${prefix}-[${arb(b[1])}]` : `[${prop}:${arb(v)}]`];
    }
    case "opacity": {
      const pct = Number(v) * 100;
      return [!isVar(v) && OPACITY.has(Math.round(pct * 100) / 100) ? `opacity-${Math.round(pct)}` : `opacity-[${arb(v)}]`];
    }
    case "mix-blend-mode":
      return [`mix-blend-${v}`];
    case "font-family":
      return [isVar(v) ? `font-[family-name:${arb(v.replace(/"/g, "'"))}]` : `font-[${arb(v.replace(/"/g, "'"))}]`];
    case "font-size": {
      const px = PX.exec(v);
      return [px && FONT_SIZE[Number(px[1])] ? `text-${FONT_SIZE[Number(px[1])]}` : length("text", v)];
    }
    case "font-weight":
      return [FONT_WEIGHT[v] ? `font-${FONT_WEIGHT[v]}` : isVar(v) ? `[font-weight:${arb(v)}]` : `font-[${v}]`];
    case "font-style":
      return [v === "italic" ? "italic" : "not-italic"];
    case "line-height":
      return [v === "normal" ? "leading-normal" : `leading-[${arb(v)}]`];
    case "letter-spacing":
      return [`tracking-[${arb(v)}]`];
    case "text-align":
      return [`text-${v}`];
    case "text-transform":
      return [v === "uppercase" ? "uppercase" : v === "lowercase" ? "lowercase" : "capitalize"];
    case "text-decoration-line":
      return [v === "line-through" ? "line-through" : "underline"];
    case "color":
      return [color("text", v, true)];
    case "object-fit":
      return [`object-${v}`];
    default:
      return [`[${prop}:${arb(v)}]`];
  }
};

/** Tailwind classes for a declaration list, with padding collapsed and truncation named. */
export function toTailwind(decls: Decl[]): string[] {
  const map = new Map(decls);
  const skip = new Set<string>();
  const out: string[] = [];
  const pad = ["top", "right", "bottom", "left"].map((s) => map.get(`padding-${s}`));
  if (pad.some(Boolean)) {
    const [t, r, b, l] = pad.map((v) => v ?? "0");
    if (t === r && r === b && b === l) out.push(spacing("p", t));
    else if (t === b && r === l) out.push(...(t !== "0" ? [spacing("py", t)] : []), ...(r !== "0" ? [spacing("px", r)] : []));
    else [["pt", t], ["pr", r], ["pb", b], ["pl", l]].forEach(([p, v]) => v !== "0" && out.push(spacing(p, v)));
    ["top", "right", "bottom", "left"].forEach((s) => skip.add(`padding-${s}`));
  }
  if (map.has("-webkit-line-clamp")) {
    out.push(`line-clamp-${map.get("-webkit-line-clamp")}`);
    ["display", "-webkit-line-clamp", "-webkit-box-orient", "overflow"].forEach((p) => skip.add(p));
  } else if (map.get("text-overflow") === "ellipsis" && map.get("white-space") === "nowrap" && map.get("overflow") === "hidden") {
    out.push("truncate");
    ["text-overflow", "white-space", "overflow"].forEach((p) => skip.add(p));
  }
  for (const [prop, value] of decls) if (!skip.has(prop)) out.push(...classesFor(prop, value));
  return [...new Set(out)];
}

/* ── naming ───────────────────────────────────────────────────────────────── */

export const pascal = (s: string) => {
  const p = s
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^\d/.test(p) ? `C${p}` : p;
};
const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0].toLowerCase() + p.slice(1) : "prop";
};
const lastSegment = (name: string) => name.split("/").pop()!.trim() || name;
export const componentName = (c: Component) => pascal(lastSegment(c.set ?? c.name)) || "Component";
export const iconName = (node: CodeNode) => {
  const p = pascal((node.assetHint ?? node.name).replace(/\.svg$/, ""));
  return /^Icon/.test(p) ? p : `Icon${p}`;
};

const cssClassSlug = (s: string) => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";
  return /^\d/.test(base) ? `n-${base}` : base;
};

const semanticTag = (name: string): string | undefined => {
  const n = name.toLowerCase().trim();
  if (/\b(button|btn|cta)\b/.test(n)) return "button";
  if (/^(nav|navbar|navigation)\b/.test(n)) return "nav";
  if (/^header\b/.test(n)) return "header";
  if (/^footer\b/.test(n)) return "footer";
  if (/^main\b/.test(n)) return "main";
  if (/^section\b/.test(n)) return "section";
  if (/^(aside|sidebar)\b/.test(n)) return "aside";
  return undefined;
};

/* ── assets and header ────────────────────────────────────────────────────── */

export type Assets = {
  icons: { file: string; name: string; nodeIds: string[]; inlined: boolean }[];
  images: { imageRef: string; nodeIds: string[] }[];
  components: { component: string; name: string; componentKey?: string; nodeIds: string[] }[];
  fonts: string[];
};

export function collectAssets(ctx: CodeContext): Assets {
  const icons = new Map<string, Assets["icons"][number]>();
  const images = new Map<string, string[]>();
  const components = new Map<string, Assets["components"][number]>();
  const visit = (node: CodeNode) => {
    if (node.type === "ICON") {
      const file = node.assetHint ?? `${cssClassSlug(node.name)}.svg`;
      const e = icons.get(file) ?? { file, name: node.name, nodeIds: [], inlined: false };
      e.nodeIds.push(node.id);
      e.inlined ||= !!node.svg;
      icons.set(file, e);
      return;
    }
    const refs = new Set<string>();
    if (node.imageRef) refs.add(node.imageRef);
    const style = node.style ? ctx.styles[node.style] : undefined;
    if (Array.isArray(style?.fills)) for (const p of style.fills) if (p.image) refs.add(p.image);
    for (const ref of refs) images.set(ref, [...(images.get(ref) ?? []), node.id]);
    if (node.type === "INSTANCE" && node.component && !node.children) {
      const name = componentName(node.component);
      const e = components.get(name) ?? { component: name, name: node.component.set ?? node.component.name, componentKey: node.component.componentKey, nodeIds: [] };
      e.nodeIds.push(node.id);
      components.set(name, e);
    }
    node.children?.forEach(visit);
  };
  visit(ctx.root);
  const fonts = new Map<string, Set<string>>();
  for (const t of Object.values(ctx.textStyles)) {
    const family = String(isBound(t.family) ? t.family.value : t.family ?? "");
    if (!family) continue;
    const set = fonts.get(family) ?? new Set<string>();
    set.add(String(isBound(t.weight) ? t.weight.value : t.weight ?? "400") + (t.italic ? " italic" : ""));
    fonts.set(family, set);
  }
  return {
    icons: [...icons.values()],
    images: [...images.entries()].map(([imageRef, nodeIds]) => ({ imageRef, nodeIds })),
    components: [...components.values()],
    fonts: [...fonts.entries()].map(([f, w]) => `${f} ${[...w].sort().join(", ")}`),
  };
}

const TOKEN_PLACEHOLDER = "{{TOKEN_ESTIMATE}}";

function headerLines(ctx: CodeContext, tokens: Token[], assets: Assets, format: CodeFormat): string[] {
  const m = ctx.meta;
  const where = [m.fileName ? `"${m.fileName}"` : "", m.page ? `page "${m.page}"` : ""].filter(Boolean).join(", ");
  const L = [
    `Generated by get_code_context (${format}) from Figma node ${ctx.root.id} "${ctx.root.name}"${where ? ` (${where})` : ""}.`,
    "A starting point, not finished code: compare it with a screenshot, swap the placeholders for your own components, and wire up real content and behaviour.",
    `Read ${m.nodeCount ?? "?"} layers; this output is about ${TOKEN_PLACEHOLDER} tokens.`,
  ];
  if (m.depthTruncated) L.push("Some layers were not read because of maxDepth; they are marked in the code. Raise maxDepth or call again on that layer.");
  if (m.nodeLimitHit) L.push(`Stopped after ${m.nodeLimitHit} layers (maxNodes); call again on a smaller layer.`);
  if (tokens.length) {
    L.push("", `Tokens (${tokens.length}): CSS custom properties, with this layer's value as the fallback. export_tokens (format "css") writes all of them, every mode.`);
    for (const t of tokens) L.push(`  ${t.css}  ${t.collection ? `${t.collection} / ` : ""}${t.name} = ${t.value}`);
  }
  if (assets.components.length) {
    L.push("", `Components (${assets.components.length}), rendered as placeholders; use your own implementation:`);
    for (const c of assets.components) L.push(`  <${c.component}> ${c.name}${c.componentKey ? ` (key ${c.componentKey})` : ""}: ${c.nodeIds.join(", ")}`);
  }
  const toExport = assets.icons.filter((i) => !i.inlined);
  if (assets.icons.length) {
    L.push("", `Icons (${assets.icons.length})${toExport.length ? `: export with export_assets { nodeIds: [${toExport.map((i) => `"${i.nodeIds[0]}"`).join(", ")}], format: "SVG", outputDir: "…" }` : ", inlined below"}:`);
    for (const i of assets.icons) L.push(`  ${i.file}${i.inlined ? " (inlined)" : ""}: ${i.nodeIds.join(", ")}`);
  }
  if (assets.images.length) {
    L.push("", `Images (${assets.images.length}): src is the Figma image hash; export_image_fills { nodeId: "${ctx.root.id}", outputDir: "…" } saves each as <hash>.<ext>:`);
    for (const i of assets.images) L.push(`  ${i.imageRef}: ${i.nodeIds.join(", ")}`);
  }
  if (assets.fonts.length) L.push("", `Fonts: ${assets.fonts.join("; ")}`);
  return L;
}

const commentBlock = (lines: string[]) => ["/*", ...lines.map((l) => (l ? ` * ${l.replace(/\*\//g, "* /")}` : " *")), " */"].join("\n");

const withEstimate = (code: string) => code.replace(TOKEN_PLACEHOLDER, String(Math.ceil(code.length / 4)));

/* ── shared per-node decls ────────────────────────────────────────────────── */

const objectFit = (style: NodeStyle | undefined) => {
  const img = Array.isArray(style?.fills) ? style!.fills.find((p) => p.image !== undefined) : undefined;
  return img?.scale === "fit" ? "contain" : "cover";
};

const hasAbsoluteChild = (node: CodeNode) => !!node.children?.some((c) => c.layout?.position && !c.hidden);

/* ── jsx-tailwind ─────────────────────────────────────────────────────────── */

const jsxText = (s: string) =>
  s.replace(/[{}<>]/g, (c) => ({ "{": "{'{'}", "}": "{'}'}", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\r?\n/g, "<br />");
const jsxAttr = (name: string, value: string) => (value ? ` ${name}="${value.replace(/"/g, "&quot;")}"` : "");

export const svgToJsx = (svg: string, className: string) =>
  svg
    .replace(/<\?xml[^>]*\?>\s*/g, "")
    .replace(/\sxlink:href=/g, " xlinkHref=")
    .replace(/\sxmlns:xlink=/g, " xmlnsXlink=")
    .replace(/\sclass=/g, " className=")
    .replace(/\s((?!data-|aria-)[a-z]+(?:-[a-z]+)+)=/g, (_, attr: string) => ` ${attr.replace(/-([a-z])/g, (__, c: string) => c.toUpperCase())}=`)
    .replace(/<svg\b/, `<svg${jsxAttr("className", className)}`)
    .trim();

const jsxProps = (c: Component) => {
  let out = "";
  for (const [k, v] of Object.entries(c.variantProps ?? {})) out += ` ${camel(k)}="${v}"`;
  for (const [k, v] of Object.entries(c.props ?? {})) {
    const key = camel(k);
    if (v === true) out += ` ${key}`;
    else if (v === false) out += ` ${key}={false}`;
    else if (typeof v === "object") out += ` ${key}={<${pascal(lastSegment(v.swap))} />}`;
    else out += /["{}]/.test(v) ? ` ${key}={${JSON.stringify(v)}}` : ` ${key}="${v}"`;
  }
  return out;
};

function renderJsxNode(node: CodeNode, parent: CodeNode | null, ctx: CodeContext, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  const style = node.style ? ctx.styles[node.style] : undefined;
  const layout = layoutDecls(node, parent, hasAbsoluteChild(node));

  if (node.type === "ICON") {
    const cls = toTailwind(layout).join(" ");
    if (node.svg) {
      out.push(...svgToJsx(node.svg, cls).split("\n").map((l) => pad + l));
    } else {
      out.push(`${pad}{/* ${node.assetHint ?? "icon"}: export node ${node.id} */}`);
      out.push(`${pad}<${iconName(node)}${jsxAttr("className", cls)} />`);
    }
    return;
  }
  if (node.type === "INSTANCE" && node.component && !node.children) {
    out.push(`${pad}<${componentName(node.component)}${jsxProps(node.component)}${jsxAttr("className", toTailwind(layout).join(" "))} />`);
    return;
  }
  const decls = [...layout, ...styleDecls(style, { isText: node.type === "TEXT", isImage: node.type === "IMAGE" })];
  if (node.type === "IMAGE" && !node.children) {
    decls.push(["object-fit", objectFit(style)]);
    out.push(`${pad}<img src="${node.imageRef ?? ""}" alt=""${jsxAttr("className", toTailwind(decls).join(" "))} />`);
    return;
  }
  if (node.type === "TEXT" && node.text) {
    const base = node.text.style ? ctx.textStyles[node.text.style] : undefined;
    const baseClasses = toTailwind(textDecls(base));
    const cls = [...toTailwind(decls), ...baseClasses];
    const content = node.text.segments
      ? node.text.segments
          .map((s) => {
            if (s.style === node.text!.style) return jsxText(s.content);
            const own = toTailwind(textDecls(s.style ? ctx.textStyles[s.style] : undefined)).filter((c) => !baseClasses.includes(c));
            return own.length ? `<span className="${own.join(" ")}">${jsxText(s.content)}</span>` : jsxText(s.content);
          })
          .join("")
      : jsxText(node.text.content);
    out.push(`${pad}<p${jsxAttr("className", [...new Set(cls)].join(" "))}>${content}</p>`);
    return;
  }

  const tag = semanticTag(node.name) ?? "div";
  const open = `<${tag}${tag === "button" ? ' type="button"' : ""}${jsxAttr("className", toTailwind(decls).join(" "))}`;
  if (node.type === "INSTANCE" && node.component) out.push(`${pad}{/* <${componentName(node.component)}> instance, expanded */}`);
  const kids = node.children ?? [];
  if (!kids.length && !node.childCount) {
    out.push(`${pad}${open} />`);
    return;
  }
  out.push(`${pad}${open}>`);
  if (node.childCount && !kids.length) out.push(`${pad}  {/* ${node.childCount} layers not read (maxDepth): call get_code_context on ${node.id} */}`);
  for (const child of kids) renderJsxNode(child, node, ctx, depth + 1, out);
  out.push(`${pad}</${tag}>`);
}

export function renderJsx(ctx: CodeContext, tokens: Token[]): string {
  const assets = collectAssets(ctx);
  const out = [commentBlock(headerLines(ctx, tokens, assets, "jsx-tailwind")), ""];
  if (assets.components.length || assets.icons.some((i) => !i.inlined)) {
    const names = [...assets.components.map((c) => c.component), ...new Set(assets.icons.filter((i) => !i.inlined).map((i) => iconName({ id: "", name: i.name, type: "ICON", assetHint: i.file })))];
    out.push(`// Placeholders to import: ${[...new Set(names)].join(", ")}`, "");
  }
  out.push(`export function ${pascal(ctx.root.name) || "FigmaLayer"}() {`, "  return (");
  renderJsxNode(ctx.root, null, ctx, 2, out);
  out.push("  );", "}", "");
  return withEstimate(out.join("\n"));
}

/* ── html-css ─────────────────────────────────────────────────────────────── */

const htmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
const htmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const rule = (selector: string, decls: Decl[]) => `${selector} {\n${decls.map(([p, v]) => `  ${p}: ${v};`).join("\n")}\n}`;

export function renderHtml(ctx: CodeContext, tokens: Token[]): string {
  const assets = collectAssets(ctx);
  const used = new Map<string, number>();
  const rules: string[] = [];
  const shared = new Map<string, string>();

  const nodeClass = (node: CodeNode) => {
    const base = cssClassSlug(node.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
  const sharedClass = (id: string, decls: Decl[]) => {
    if (!decls.length) return "";
    const key = JSON.stringify(decls);
    const found = shared.get(key);
    if (found) return found;
    const name = [...shared.values()].includes(id) ? `${id}-${shared.size + 1}` : id;
    shared.set(key, name);
    rules.push(rule(`.${name}`, decls));
    return name;
  };
  const classAttr = (...names: string[]) => {
    const list = names.filter(Boolean).join(" ");
    return list ? ` class="${list}"` : "";
  };

  const markup: string[] = [];
  const render = (node: CodeNode, parent: CodeNode | null, depth: number) => {
    const pad = "  ".repeat(depth);
    const style = node.style ? ctx.styles[node.style] : undefined;
    const layout = layoutDecls(node, parent, hasAbsoluteChild(node));
    const own = (extra: Decl[] = []) => {
      const decls = [...layout, ...extra];
      if (!decls.length) return "";
      const cls = nodeClass(node);
      rules.push(rule(`.${cls}`, decls));
      return cls;
    };

    if (node.type === "ICON") {
      const cls = own();
      if (node.svg) {
        markup.push(...node.svg.replace(/<\?xml[^>]*\?>\s*/g, "").replace(/<svg\b/, `<svg${classAttr(cls)}`).trim().split("\n").map((l) => pad + l));
      } else {
        markup.push(`${pad}<!-- icon ${node.assetHint ?? ""}: export node ${node.id} -->`);
        markup.push(`${pad}<span${classAttr(cls)} data-asset="${htmlAttr(node.assetHint ?? "")}" aria-hidden="true"></span>`);
      }
      return;
    }
    if (node.type === "INSTANCE" && node.component && !node.children) {
      const c = node.component;
      const props = [...Object.entries(c.variantProps ?? {}), ...Object.entries(c.props ?? {}).map(([k, v]) => [k, typeof v === "object" ? v.swap : String(v)])];
      markup.push(`${pad}<!-- component ${componentName(c)}${props.length ? `: ${props.map(([k, v]) => `${k}=${v}`).join(", ")}` : ""} -->`);
      markup.push(`${pad}<div${classAttr(own())} data-component="${htmlAttr(componentName(c))}"></div>`);
      return;
    }
    const isText = node.type === "TEXT";
    const isImage = node.type === "IMAGE" && !node.children;
    const sDecls = styleDecls(style, { isText, isImage });
    const styleCls = node.style ? sharedClass(node.style, sDecls) : "";
    if (isImage) {
      markup.push(`${pad}<img${classAttr(own([["object-fit", objectFit(style)]]), styleCls)} src="${htmlAttr(node.imageRef ?? "")}" alt="">`);
      return;
    }
    if (isText && node.text) {
      const textCls = node.text.style ? sharedClass(node.text.style, textDecls(ctx.textStyles[node.text.style])) : "";
      const content = node.text.segments
        ? node.text.segments
            .map((s) => {
              if (s.style === node.text!.style || !s.style) return htmlText(s.content);
              const segCls = sharedClass(s.style, textDecls(ctx.textStyles[s.style]));
              return `<span${classAttr(segCls)}>${htmlText(s.content)}</span>`;
            })
            .join("")
        : htmlText(node.text.content);
      markup.push(`${pad}<p${classAttr(own(), styleCls, textCls)}>${content}</p>`);
      return;
    }
    const tag = semanticTag(node.name) ?? "div";
    const open = `<${tag}${tag === "button" ? ' type="button"' : ""}${classAttr(own(), styleCls)}>`;
    const kids = node.children ?? [];
    if (!kids.length && !node.childCount) {
      markup.push(`${pad}${open}</${tag}>`);
      return;
    }
    markup.push(`${pad}${open}`);
    if (node.childCount && !kids.length) markup.push(`${pad}  <!-- ${node.childCount} layers not read (maxDepth): call get_code_context on ${node.id} -->`);
    for (const child of kids) render(child, node, depth + 1);
    markup.push(`${pad}</${tag}>`);
  };
  render(ctx.root, null, 0);

  const root = tokens.length ? [rule(":root", tokens.map((t) => [t.css, typeof t.value === "number" ? `${t.value}` : t.value]))] : [];
  const css = [commentBlock(headerLines(ctx, tokens, assets, "html-css")), ...root, ...rules].join("\n\n");
  return withEstimate(`<style>\n${css}\n</style>\n\n${markup.join("\n")}\n`);
}

/* ── entry point ──────────────────────────────────────────────────────────── */

export function renderCodeContext(ctx: CodeContext, format: CodeFormat = "json"): unknown {
  const tokens = annotateVariables(ctx);
  if (format === "jsx-tailwind") return renderJsx(ctx, tokens);
  if (format === "html-css") return renderHtml(ctx, tokens);
  const { fonts: _fonts, ...assets } = collectAssets(ctx);
  const out = { root: ctx.root, styles: ctx.styles, textStyles: ctx.textStyles, tokens, assets, meta: { ...ctx.meta } as Record<string, unknown> };
  out.meta.tokenEstimate = Math.ceil(JSON.stringify(out).length / 4);
  return out;
}

/* ── component docs ───────────────────────────────────────────────────────── */

export type DocsData = {
  id: string;
  name: string;
  type: string;
  key?: string;
  description?: string;
  documentationLinks?: string[];
  page?: string;
  width?: number;
  height?: number;
  requestedNodeId?: string;
  properties?: { name: string; key: string; type: string; default: unknown; options?: string[]; description?: string; preferredValues?: number }[];
  propertiesError?: string;
  variantCount?: number;
  variants?: { id: string; name: string; props?: Record<string, string>; description?: string }[];
  defaultVariant?: string;
  variables?: { name: string; collection: string; type?: string; fields: string[]; uses: number; id?: string; css?: string }[];
  styles?: { name: string; type: string; uses: number }[];
  instances?: { count: number; byPage: Record<string, number>; incomplete?: string };
};

const PROPERTY_TYPE: Record<string, string> = { VARIANT: "Variant", TEXT: "Text", BOOLEAN: "Boolean", INSTANCE_SWAP: "Instance swap", SLOT: "Slot" };
const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const table = (head: string[], rows: unknown[][]) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];

export function annotateDocsVariables(data: DocsData): DocsData {
  for (const v of data.variables ?? []) if (!v.id && v.type) v.css = variableCssName(v.collection, v.name);
  return data;
}

export function renderComponentDocs(data: DocsData): string {
  annotateDocsVariables(data);
  const L: string[] = [`# ${data.name}`, ""];
  if (data.description) L.push(data.description, "");
  const kind = data.type === "COMPONENT_SET" ? `Component set, ${data.variantCount ?? data.variants?.length ?? 0} variants${data.defaultVariant ? ` (default: ${data.defaultVariant})` : ""}` : "Component";
  L.push(`- **Kind:** ${kind}`);
  if (data.width !== undefined) L.push(`- **Size:** ${data.width} × ${data.height}`);
  if (data.page) L.push(`- **Page:** ${data.page}`);
  L.push(`- **Node:** \`${data.id}\``);
  if (data.key) L.push(`- **Key:** \`${data.key}\``);
  for (const link of data.documentationLinks ?? []) L.push(`- **Docs:** ${link}`);
  L.push("");

  const props = data.properties ?? [];
  L.push("## Properties", "");
  if (data.propertiesError) L.push(`Could not read the property definitions: ${data.propertiesError}`, "");
  else if (!props.length) L.push("None.", "");
  else {
    L.push(
      ...table(
        ["Property", "Type", "Default", "Options", "Description"],
        props.map((p) => [p.name, PROPERTY_TYPE[p.type] ?? p.type, p.type === "TEXT" ? JSON.stringify(p.default) : p.default, p.options?.join(", ") ?? (p.preferredValues ? `${p.preferredValues} preferred` : ""), p.description ?? ""])
      ),
      ""
    );
  }

  if (data.variants?.length) {
    const columns = [...new Set(data.variants.flatMap((v) => Object.keys(v.props ?? {})))];
    L.push(`## Variants (${data.variantCount ?? data.variants.length})`, "");
    L.push(...table([...columns, "Node"], data.variants.map((v) => [...columns.map((c) => v.props?.[c] ?? ""), `\`${v.id}\``])), "");
    if (data.variantCount && data.variantCount > data.variants.length) L.push(`First ${data.variants.length} listed.`, "");
  }

  const example = props
    .map((p) => {
      const key = camel(p.name);
      if (p.type === "BOOLEAN") return p.default === true ? ` ${key}` : "";
      if (p.type === "INSTANCE_SWAP") return ` ${key}={<${pascal(String(p.default))} />}`;
      return ` ${key}=${JSON.stringify(String(p.default))}`;
    })
    .join("");
  L.push("## Example", "", "```tsx", `<${pascal(lastSegment(data.name)) || "Component"}${example} />`, "```", "");

  const vars = data.variables ?? [];
  L.push(`## Variables used (${vars.length})`, "");
  if (vars.length) {
    L.push(...table(["Variable", "CSS", "Collection", "Type", "Bound to", "Uses"], vars.map((v) => [v.name, v.css ? `\`${v.css}\`` : "", v.collection, v.type ?? "", v.fields.join(", "), v.uses])), "");
  } else L.push("None.", "");

  const styles = data.styles ?? [];
  L.push(`## Styles used (${styles.length})`, "");
  if (styles.length) L.push(...table(["Style", "Type", "Uses"], styles.map((s) => [s.name, s.type, s.uses])), "");
  else L.push("None.", "");

  L.push("## Instances", "");
  if (data.instances) {
    const pages = Object.entries(data.instances.byPage).sort((a, b) => b[1] - a[1]);
    L.push(`Used ${data.instances.count} time${data.instances.count === 1 ? "" : "s"} in the file${pages.length ? `: ${pages.map(([p, n]) => `${p} (${n})`).join(", ")}` : ""}.`);
    if (data.instances.incomplete) L.push("", `Count incomplete: ${data.instances.incomplete}`);
  } else L.push("Not counted (pass countInstances: true).");
  L.push("");
  return L.join("\n");
}
