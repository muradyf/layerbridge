/**
 * Pure logic behind check_accessibility, lint_design_system and
 * fix_design_system: colour math (WCAG 2.x contrast, APCA, CIEDE2000,
 * source-over compositing), background sampling from decoded pixels, target
 * size checks, design-system matching and fix planning.
 *
 * No I/O and no plugin types here, so all of it is unit-tested directly
 * (test/quality-core.test.mjs). The plugin only gathers facts; every number a
 * report shows is computed in this file.
 */

/* ── colour basics ────────────────────────────────────────────────────────── */

/** Channels 0..1. */
export type RGB = { r: number; g: number; b: number };
export type RGBA = RGB & { a: number };

export const parseHex = (hex: string): RGBA => {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`Invalid hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const toHex = (c: RGB | RGBA, withAlpha = true): string => {
  const ch = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  const alpha = withAlpha && "a" in c && c.a < 0.998 ? ch(c.a) : "";
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}${alpha}`;
};

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/* ── WCAG 2.x ─────────────────────────────────────────────────────────────── */

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export const relativeLuminance = (c: RGB) =>
  0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);

/** WCAG 2.x contrast ratio, 1..21. Unrounded: compare this against the threshold, never a rounded value. */
export const contrastRatio = (a: RGB, b: RGB) => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Reported ratios are truncated, not rounded, so 4.499 never reads as a passing 4.50. */
export const displayRatio = (ratio: number) => Math.floor(ratio * 100) / 100;

/** WCAG "large scale": at least 18pt (24px), or 14pt (18.66px) and bold. */
export const isLargeText = (fontSizePx: number, fontWeight: number) =>
  fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);

export type Level = "AA" | "AAA";

export const requiredContrast = (level: Level, large: boolean) =>
  level === "AAA" ? (large ? 4.5 : 7) : large ? 3 : 4.5;

export const contrastCriterion = (level: Level) => (level === "AAA" ? "1.4.6" : "1.4.3");

/* ── APCA (informational) ─────────────────────────────────────────────────── */

/**
 * APCA-W3 0.0.98G-4g lightness contrast Lc. Positive = dark text on light,
 * negative = light text on dark. Informational only: WCAG 2.x is the standard
 * these checks pass or fail against.
 */
export const apcaContrast = (text: RGB, background: RGB): number => {
  const y = (c: RGB) => 0.2126729 * c.r ** 2.4 + 0.7151522 * c.g ** 2.4 + 0.072175 * c.b ** 2.4;
  const clampBlack = (v: number) => (v > 0.022 ? v : v + (0.022 - v) ** 1.414);
  const yt = clampBlack(y(text));
  const yb = clampBlack(y(background));
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let out: number;
  if (yb > yt) {
    const sapc = (yb ** 0.56 - yt ** 0.57) * 1.14;
    out = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {
    const sapc = (yb ** 0.65 - yt ** 0.62) * 1.14;
    out = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return out * 100;
};

/* ── compositing ──────────────────────────────────────────────────────────── */

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** Porter-Duff source-over in sRGB-encoded space, which is how Figma and browsers blend by default. */
export const over = (top: RGBA, bottom: RGBA): RGBA => {
  const a = top.a + bottom.a * (1 - top.a);
  if (a <= 0) return { ...TRANSPARENT };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
};

/** A paint as the plugin reports it. */
export type PaintJson = {
  type: string;
  color?: string;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
};

const NORMAL_BLENDS = new Set([undefined, "NORMAL", "PASS_THROUGH"]);

/**
 * Flattens a node's fills (listed bottom to top, as Figma stores them) into one
 * colour, then applies the node's opacity. Returns null with a reason when a
 * visible fill is not a normal-blended solid.
 */
export const flattenFills = (
  fills: PaintJson[],
  opacity = 1
): { color: RGBA } | { reason: string } => {
  let acc: RGBA = { ...TRANSPARENT };
  for (const f of fills) {
    if (f.visible === false || (f.opacity ?? 1) <= 0) continue;
    if (f.type !== "SOLID" || !f.color) return { reason: `${f.type.toLowerCase().replace(/_/g, " ")} fill` };
    if (!NORMAL_BLENDS.has(f.blendMode)) return { reason: `${f.blendMode} blend on a fill` };
    const c = parseHex(f.color);
    acc = over({ ...c, a: c.a * (f.opacity ?? 1) }, acc);
  }
  return { color: { ...acc, a: acc.a * opacity } };
};

/** One painted layer behind a text, as reported by the plugin (listed top to bottom). */
export type BgLayer = {
  nodeId: string;
  name?: string;
  fills: PaintJson[];
  opacity?: number;
  blendMode?: string;
  backgroundBlur?: boolean;
  layerBlur?: boolean;
  /** The layer overlaps the text but does not cover all of it (edge, rounded corner, non-rectangular shape, mask, rotation). */
  partial?: boolean;
};

export type BackgroundResult =
  | { color: RGB; contributing: string[]; usedCanvas: boolean }
  | { needsPixelSample: true; reason: string; contributing: string[] };

/** Composites the layers behind a text down to the first opaque one, or says why that cannot be done from the layer data. */
export const resolveBackground = (layers: BgLayer[], canvas: RGB = { r: 1, g: 1, b: 1 }): BackgroundResult => {
  let acc: RGBA = { ...TRANSPARENT };
  const contributing: string[] = [];
  for (const layer of layers) {
    const flat = flattenFills(layer.fills, layer.opacity ?? 1);
    if ("color" in flat && flat.color.a <= 0.001) continue;
    contributing.push(layer.nodeId);
    const why =
      "reason" in flat ? flat.reason
      : !NORMAL_BLENDS.has(layer.blendMode) ? `${layer.blendMode} blend mode`
      : layer.backgroundBlur ? "background blur"
      : layer.layerBlur ? "layer blur"
      : layer.partial ? "a layer only partly covers the text"
      : null;
    if (why) return { needsPixelSample: true, reason: `${why} on "${layer.name ?? layer.nodeId}"`, contributing };
    acc = over(acc, (flat as { color: RGBA }).color);
    if (acc.a >= 0.999) return { color: acc, contributing, usedCanvas: false };
  }
  const color = over(acc, { ...canvas, a: 1 });
  return { color, contributing, usedCanvas: true };
};

/** Text colour from its fills and cumulative opacity; null with a reason for gradient or image text. */
export const resolveForeground = (fills: PaintJson[], opacity = 1) => flattenFills(fills, opacity);

/** What the eye sees for (possibly translucent) text over a solid background. */
export const effectiveForeground = (fg: RGBA, bg: RGB): RGB => over(fg, { ...bg, a: 1 });

/* ── CIELAB / CIEDE2000 ───────────────────────────────────────────────────── */

export type Lab = { L: number; a: number; b: number };

export const rgbToLab = (c: RGB): Lab => {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
};

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * CIEDE2000 colour difference. About 1 is a just-noticeable difference.
 * `kL` > 1 makes lightness differences count less (kC = kH = 1).
 */
export const deltaE2000 = (x: Lab, y: Lab, kL = 1): number => {
  const C1 = Math.hypot(x.a, x.b);
  const C2 = Math.hypot(y.a, y.b);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1 = (1 + G) * x.a;
  const a2 = (1 + G) * y.a;
  const c1 = Math.hypot(a1, x.b);
  const c2 = Math.hypot(a2, y.b);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h < 0 ? h + 360 : h;
  };
  const h1 = hue(x.b, a1);
  const h2 = hue(y.b, a2);
  const dL = y.L - x.L;
  const dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
  const Lbar = (x.L + y.L) / 2;
  const cbar = (c1 + c2) / 2;
  let hbar = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hbar = (h1 + h2) / 2;
    else hbar = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbar - 30)) +
    0.24 * Math.cos(rad(2 * hbar)) +
    0.32 * Math.cos(rad(3 * hbar + 6)) -
    0.2 * Math.cos(rad(4 * hbar - 63));
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * cbar;
  const Sh = 1 + 0.015 * cbar * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / (kL * Sl)) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
};

export const deltaE = (x: RGB, y: RGB, kL = 1) => deltaE2000(rgbToLab(x), rgbToLab(y), kL);

/** Same colour at 8-bit precision, alpha within 1%. */
export const sameColor = (x: RGBA, y: RGBA) =>
  Math.abs(x.r - y.r) * 255 < 0.51 &&
  Math.abs(x.g - y.g) * 255 < 0.51 &&
  Math.abs(x.b - y.b) * 255 < 0.51 &&
  Math.abs(x.a - y.a) < 0.01;

/* ── background sampling ──────────────────────────────────────────────────── */

export type Pixels = { width: number; height: number; data: Uint8Array | Buffer };
export type PxRect = { x: number; y: number; width: number; height: number };

export type Cluster = { color: RGB; share: number; count: number };

export type SampleResult = {
  clusters: Cluster[];
  worst: Cluster;
  typical: Cluster;
  samples: number;
};

const dist = (x: RGB, y: RGB) => Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);

/**
 * Estimates what is painted behind a text from a rendered image of the area.
 *
 * Glyph pixels are dropped (close to the text colour), the rest is grouped into
 * colour clusters, and clusters that are only a blend of the text colour with a
 * bigger cluster — antialiased glyph edges — are dropped too. What is left is
 * the background: `typical` is its largest cluster, `worst` the one with the
 * least contrast against the text. Transparent pixels are laid over `canvas`.
 */
export const sampleBackground = (
  pixels: Pixels,
  rect: PxRect,
  text: RGB,
  opts: { canvas?: RGB; minShare?: number; maxSamples?: number } = {}
): SampleResult | null => {
  const canvas = opts.canvas ?? { r: 1, g: 1, b: 1 };
  const minShare = opts.minShare ?? 0.03;
  const maxSamples = opts.maxSamples ?? 60_000;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(pixels.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(pixels.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const area = (x1 - x0) * (y1 - y0);
  const step = Math.max(1, Math.floor(Math.sqrt(area / maxSamples)));

  // 1. Bin non-glyph pixels at 4 bits per channel, keeping each bin's true mean.
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
  let samples = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * pixels.width + x) * 4;
      const a = pixels.data[i + 3] / 255;
      const c = {
        r: (pixels.data[i] / 255) * a + canvas.r * (1 - a),
        g: (pixels.data[i + 1] / 255) * a + canvas.g * (1 - a),
        b: (pixels.data[i + 2] / 255) * a + canvas.b * (1 - a),
      };
      samples++;
      if (dist(c, text) < 0.1) continue;
      const key = ((c.r * 15.999) << 8) | ((c.g * 15.999) << 4) | (c.b * 15.999);
      const bin = bins.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      bin.r += c.r;
      bin.g += c.g;
      bin.b += c.b;
      bin.n++;
      bins.set(key, bin);
    }
  }

  // 2. Merge neighbouring bins greedily, biggest first.
  const merged: { color: RGB; count: number }[] = [];
  for (const bin of [...bins.values()].sort((p, q) => q.n - p.n)) {
    const color = { r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n };
    const home = merged.find((m) => dist(m.color, color) < 0.06);
    if (home) {
      const n = home.count + bin.n;
      home.color = {
        r: (home.color.r * home.count + color.r * bin.n) / n,
        g: (home.color.g * home.count + color.g * bin.n) / n,
        b: (home.color.b * home.count + color.b * bin.n) / n,
      };
      home.count = n;
    } else merged.push({ color, count: bin.n });
  }
  const total = merged.reduce((s, m) => s + m.count, 0);
  if (total === 0) return null;

  // 3. Drop specks, then drop antialiasing: small clusters lying on the line
  //    between the text colour and a bigger cluster.
  const big = merged.filter((m) => m.count / total >= minShare).sort((p, q) => q.count - p.count);
  const kept = big.filter((m, index) => {
    if (index === 0 || m.count / total >= 0.25) return true;
    return !big.slice(0, index).some((bigger) => {
      const dx = { r: bigger.color.r - text.r, g: bigger.color.g - text.g, b: bigger.color.b - text.b };
      const len2 = dx.r ** 2 + dx.g ** 2 + dx.b ** 2;
      if (len2 === 0) return false;
      const t = ((m.color.r - text.r) * dx.r + (m.color.g - text.g) * dx.g + (m.color.b - text.b) * dx.b) / len2;
      if (t <= 0.02 || t >= 0.98) return false;
      const onLine = { r: text.r + t * dx.r, g: text.g + t * dx.g, b: text.b + t * dx.b };
      return dist(onLine, m.color) < 0.05;
    });
  });
  if (kept.length === 0) return null;
  const keptTotal = kept.reduce((s, m) => s + m.count, 0);
  const clusters = kept.map((m) => ({ color: m.color, count: m.count, share: m.count / keptTotal }));
  const typical = clusters[0];
  const worst = clusters.reduce((w, c) => (contrastRatio(text, c.color) < contrastRatio(text, w.color) ? c : w), typical);
  return { clusters, worst, typical, samples };
};

/* ── target size (WCAG 2.5.8 / 2.5.5) ─────────────────────────────────────── */

export type TargetBox = { nodeId: string; x: number; y: number; width: number; height: number };

export type TargetResult = {
  nodeId: string;
  undersized: boolean;
  /** Undersized but passes 2.5.8 because its circle touches no other target or undersized target's circle. */
  spacingException: boolean;
};

const circleHitsRect = (cx: number, cy: number, r: number, t: TargetBox) => {
  const dx = Math.max(t.x - cx, 0, cx - (t.x + t.width));
  const dy = Math.max(t.y - cy, 0, cy - (t.y + t.height));
  return dx * dx + dy * dy < r * r;
};

export const checkTargets = (targets: TargetBox[], minTarget: number): TargetResult[] => {
  const undersized = (t: TargetBox) => t.width < minTarget - 0.01 || t.height < minTarget - 0.01;
  const r = minTarget / 2;
  const centre = (t: TargetBox) => ({ x: t.x + t.width / 2, y: t.y + t.height / 2 });
  return targets.map((t) => {
    if (!undersized(t)) return { nodeId: t.nodeId, undersized: false, spacingException: false };
    const c = centre(t);
    const crowded = targets.some((o) => {
      if (o === t) return false;
      if (circleHitsRect(c.x, c.y, r, o)) return true;
      if (!undersized(o)) return false;
      const oc = centre(o);
      return Math.hypot(c.x - oc.x, c.y - oc.y) < 2 * r;
    });
    return { nodeId: t.nodeId, undersized: true, spacingException: !crowded };
  });
};

/* ── tokens: variables and styles ─────────────────────────────────────────── */

export type TokenCollection = { id: string; name: string; defaultModeId: string; modes: { modeId: string; name: string }[] };
export type TokenVariable = {
  id: string;
  name: string;
  collectionId: string;
  resolvedType: string;
  scopes?: string[];
  /** Colours as hex, aliases as { alias: variableId }. */
  valuesByMode: Record<string, unknown>;
};
export type TokenPaintStyle = { id: string; name: string; paints: PaintJson[] };
export type LineHeightJson = { unit: string; value?: number };
export type TokenTextStyle = {
  id: string;
  name: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight?: LineHeightJson;
  letterSpacing?: LineHeightJson;
};
export type Tokens = {
  collections: TokenCollection[];
  variables: TokenVariable[];
  paintStyles: TokenPaintStyle[];
  textStyles: TokenTextStyle[];
};

/** A variable's value for a consumer with the given modes (collectionId → modeId), following aliases. */
export const resolveVariable = (
  tokens: Tokens,
  variableId: string,
  modes: Record<string, string> = {}
): unknown => {
  let current = tokens.variables.find((v) => v.id === variableId);
  for (let hops = 0; current && hops < 16; hops++) {
    const collection = tokens.collections.find((c) => c.id === current!.collectionId);
    const modeId =
      modes[current.collectionId] && current.valuesByMode[modes[current.collectionId]] !== undefined
        ? modes[current.collectionId]
        : collection?.defaultModeId ?? Object.keys(current.valuesByMode)[0];
    const value = current.valuesByMode[modeId];
    if (value && typeof value === "object" && "alias" in (value as object)) {
      const target = (value as { alias: string }).alias;
      current = tokens.variables.find((v) => v.id === target);
      continue;
    }
    return value;
  }
  return undefined;
};

export type PaintTarget = "text-fill" | "frame-fill" | "shape-fill" | "stroke";
export type FloatTarget = "gap" | "radius";

const SCOPES: Record<PaintTarget | FloatTarget, string[]> = {
  "text-fill": ["ALL_SCOPES", "ALL_FILLS", "TEXT_FILL"],
  "frame-fill": ["ALL_SCOPES", "ALL_FILLS", "FRAME_FILL"],
  "shape-fill": ["ALL_SCOPES", "ALL_FILLS", "SHAPE_FILL"],
  stroke: ["ALL_SCOPES", "STROKE_COLOR"],
  gap: ["ALL_SCOPES", "GAP"],
  radius: ["ALL_SCOPES", "CORNER_RADIUS"],
};

/** Figma hides a variable with no scopes from every picker, so it is never suggested. Missing scopes (older data) means unrestricted. */
export const scopeAllows = (variable: TokenVariable, target: PaintTarget | FloatTarget) =>
  variable.scopes === undefined || variable.scopes.some((s) => SCOPES[target].includes(s));

export type ColorCandidate = { kind: "variable" | "style"; id: string; name: string; color: RGBA };

export type ColorMatch = ColorCandidate & { deltaE: number; exact: boolean };

export const colorCandidates = (
  tokens: Tokens,
  modes: Record<string, string>,
  target: PaintTarget | "any",
  respectScopes = true
): ColorCandidate[] => {
  const out: ColorCandidate[] = [];
  for (const v of tokens.variables) {
    if (v.resolvedType !== "COLOR") continue;
    if (respectScopes && target !== "any" && !scopeAllows(v, target)) continue;
    const value = resolveVariable(tokens, v.id, modes);
    if (typeof value !== "string") continue;
    try {
      out.push({ kind: "variable", id: v.id, name: v.name, color: parseHex(value) });
    } catch {
      // unparseable value: not a candidate
    }
  }
  for (const s of tokens.paintStyles) {
    const visible = s.paints.filter((p) => p.visible !== false);
    if (visible.length !== 1 || visible[0].type !== "SOLID" || !visible[0].color) continue;
    const c = parseHex(visible[0].color);
    out.push({ kind: "style", id: s.id, name: s.name, color: { ...c, a: c.a * (visible[0].opacity ?? 1) } });
  }
  return out;
};

/**
 * Best candidate for a colour: an exact match first (variables before styles),
 * otherwise the nearest by CIEDE2000 within maxDeltaE. Alpha must agree within
 * 1%: a variable at 100% is not a match for a 50% fill.
 */
export const matchColor = (
  color: RGBA,
  candidates: ColorCandidate[],
  maxDeltaE: number
): ColorMatch | null => {
  let best: ColorMatch | null = null;
  for (const c of candidates) {
    if (Math.abs(c.color.a - color.a) >= 0.01) continue;
    const exact = sameColor(c.color, color);
    const d = exact ? 0 : deltaE(color, c.color);
    const better =
      !best ||
      (exact && !best.exact) ||
      (exact === best.exact && (d < best.deltaE - 1e-9 || (Math.abs(d - best.deltaE) < 1e-9 && c.kind === "variable" && best.kind === "style")));
    if (better) best = { ...c, deltaE: d, exact };
  }
  return best && (best.exact || best.deltaE <= maxDeltaE) ? best : null;
};

export type FloatMatch = { id: string; name: string; value: number; exact: boolean; difference: number };

export const matchFloat = (
  tokens: Tokens,
  value: number,
  modes: Record<string, string>,
  target: FloatTarget,
  respectScopes = true
): FloatMatch | null => {
  let best: FloatMatch | null = null;
  for (const v of tokens.variables) {
    if (v.resolvedType !== "FLOAT") continue;
    if (respectScopes && !scopeAllows(v, target)) continue;
    const resolved = resolveVariable(tokens, v.id, modes);
    if (typeof resolved !== "number") continue;
    const difference = Math.abs(resolved - value);
    if (!best || difference < best.difference - 1e-9) {
      best = { id: v.id, name: v.name, value: resolved, exact: difference < 0.001, difference };
    }
  }
  return best;
};

/** Spacing or radius scale inferred from the file's FLOAT variables (default modes). */
export const inferScale = (tokens: Tokens, target: FloatTarget): number[] => {
  const byName = target === "gap" ? /spac|gap|pad|margin|gutter|inset/i : /radius|radii|corner|round/i;
  const values = new Set<number>();
  for (const v of tokens.variables) {
    if (v.resolvedType !== "FLOAT") continue;
    const scoped = v.scopes?.some((s) => SCOPES[target].slice(1).includes(s)) ?? false;
    if (!scoped && !byName.test(v.name)) continue;
    const value = resolveVariable(tokens, v.id);
    if (typeof value === "number" && value >= 0) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
};

export const nearestOnScale = (value: number, scale: number[]) =>
  scale.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), scale[0]);

/* ── text styles ──────────────────────────────────────────────────────────── */

export type TextProps = {
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight?: LineHeightJson;
  letterSpacing?: LineHeightJson;
};

const lineHeightPx = (lh: LineHeightJson | undefined, size: number): number | "AUTO" => {
  if (!lh || lh.unit === "AUTO") return "AUTO";
  return lh.unit === "PERCENT" ? ((lh.value ?? 100) / 100) * size : lh.value ?? 0;
};

const letterSpacingPx = (ls: LineHeightJson | undefined, size: number) =>
  !ls ? 0 : ls.unit === "PERCENT" ? ((ls.value ?? 0) / 100) * size : ls.value ?? 0;

export type TextStyleMatch = { id: string; name: string; exact: boolean; differences: string[] };

/**
 * Nearest text style in the same family. Exact means family, style and size are
 * equal and line height and letter spacing come out the same in pixels (so a
 * 150% line height matches 24px on 16px text).
 */
export const matchTextStyle = (props: TextProps, styles: TokenTextStyle[]): TextStyleMatch | null => {
  let best: (TextStyleMatch & { cost: number }) | null = null;
  for (const s of styles) {
    if (s.fontFamily.toLowerCase() !== props.fontFamily.toLowerCase()) continue;
    const differences: string[] = [];
    let cost = 0;
    if (s.fontStyle.toLowerCase() !== props.fontStyle.toLowerCase()) {
      differences.push(`fontStyle ${props.fontStyle} → ${s.fontStyle}`);
      cost += 3;
    }
    if (Math.abs(s.fontSize - props.fontSize) > 0.01) {
      differences.push(`fontSize ${props.fontSize} → ${s.fontSize}`);
      cost += 2 * Math.abs(s.fontSize - props.fontSize);
    }
    const lhA = lineHeightPx(props.lineHeight, props.fontSize);
    const lhB = lineHeightPx(s.lineHeight, s.fontSize);
    if (lhA === "AUTO" ? lhB !== "AUTO" : lhB === "AUTO" || Math.abs(lhA - lhB) > 0.05) {
      differences.push(`lineHeight ${lhA} → ${lhB}`);
      cost += 1;
    }
    const lsA = letterSpacingPx(props.letterSpacing, props.fontSize);
    const lsB = letterSpacingPx(s.letterSpacing, s.fontSize);
    if (Math.abs(lsA - lsB) > 0.01) {
      differences.push(`letterSpacing ${round(lsA)} → ${round(lsB)}`);
      cost += 0.5;
    }
    if (!best || cost < best.cost) best = { id: s.id, name: s.name, exact: differences.length === 0, differences, cost };
  }
  if (!best) return null;
  const { cost: _cost, ...match } = best;
  return match;
};

/* ── lint ─────────────────────────────────────────────────────────────────── */

export const LINT_RULES = [
  "unbound-color",
  "unbound-spacing",
  "unbound-radius",
  "text-without-style",
  "detached-instance",
  "off-scale-spacing",
  "off-scale-radius",
  "default-name",
  "hidden-layer",
  "empty-frame",
] as const;
export type LintRule = (typeof LINT_RULES)[number];

export const FIXABLE_RULES: LintRule[] = ["unbound-color", "unbound-spacing", "unbound-radius", "text-without-style"];

const SEVERITY: Record<LintRule, "warn" | "info"> = {
  "unbound-color": "warn",
  "unbound-spacing": "warn",
  "unbound-radius": "warn",
  "text-without-style": "warn",
  "detached-instance": "warn",
  "off-scale-spacing": "warn",
  "off-scale-radius": "warn",
  "default-name": "info",
  "hidden-layer": "info",
  "empty-frame": "info",
};

/** One layer as ds_scan reports it; only the parts that can raise an issue are present. */
export type DsNode = {
  id: string;
  name: string;
  type: string;
  path?: string;
  hidden?: boolean;
  /** Figma's auto-generated name ("Frame 12"); the plugin applies the pattern. */
  defaultName?: boolean;
  detached?: { type: string; componentId?: string; componentKey?: string };
  emptyFrame?: boolean;
  modes?: Record<string, string>;
  paints?: {
    field: "fills" | "strokes";
    index: number;
    /** Character range for a text layer with mixed fills. */
    range?: [number, number];
    paintCount: number;
    color: string;
    opacity: number;
  }[];
  spacing?: { field: string; value: number; bound: boolean }[];
  radius?: { field: string; value: number; bound: boolean }[];
  /** Unstyled text ranges. `whole`: the layer has no text style anywhere (textStyleId is ""), not a mix. */
  text?: { whole: boolean; segments: (TextProps & { start: number; end: number })[] };
};

export type LintIssue = {
  rule: LintRule;
  severity: "warn" | "info";
  nodeId: string;
  name: string;
  path?: string;
  property?: string;
  value?: unknown;
  suggestion?: Record<string, unknown>;
  /** Internal, for fix planning. */
  fix?: FixChange;
};

export type FixChange =
  | {
      kind: "paint-variable" | "paint-style";
      nodeId: string;
      field: "fills" | "strokes";
      index: number;
      range?: [number, number];
      before: { color: string; opacity: number };
      targetId: string;
      targetName: string;
      /** What the variable or style resolves to for this layer. */
      expected: { color: string; opacity: number };
      deltaE: number;
      paintCount: number;
    }
  | {
      kind: "float-variable";
      nodeId: string;
      field: string;
      before: number;
      targetId: string;
      targetName: string;
      expected: number;
    }
  | {
      kind: "text-style";
      nodeId: string;
      targetId: string;
      targetName: string;
      range: [number, number];
      wholeNode: boolean;
    };

export type LintOptions = {
  rules?: LintRule[];
  spacingScale?: number[];
  radiusScale?: number[];
  maxDeltaE?: number;
  respectScopes?: boolean;
  /** Layers the scan visited (for the score); defaults to the layers passed in. */
  nodesChecked?: number;
};

const paintTarget = (node: DsNode, field: "fills" | "strokes"): PaintTarget =>
  field === "strokes" ? "stroke"
  : node.type === "TEXT" ? "text-fill"
  : ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"].includes(node.type) ? "frame-fill"
  : "shape-fill";

export const lintDesignSystem = (nodes: DsNode[], tokens: Tokens, opts: LintOptions = {}) => {
  const rules = new Set<LintRule>(opts.rules && opts.rules.length ? opts.rules : LINT_RULES);
  const maxDeltaE = opts.maxDeltaE ?? 2;
  const respectScopes = opts.respectScopes !== false;
  const spacingScale = opts.spacingScale ?? inferScale(tokens, "gap");
  const radiusScale = opts.radiusScale ?? inferScale(tokens, "radius");
  const issues: LintIssue[] = [];
  const base = (n: DsNode, rule: LintRule) => ({ rule, severity: SEVERITY[rule], nodeId: n.id, name: n.name, ...(n.path ? { path: n.path } : {}) });

  for (const n of nodes) {
    const modes = n.modes ?? {};
    if (n.hidden && rules.has("hidden-layer")) issues.push({ ...base(n, "hidden-layer"), suggestion: { action: "delete it if it is not a deliberate variant or placeholder" } });
    if (rules.has("default-name") && n.defaultName) issues.push({ ...base(n, "default-name"), value: n.name });
    if (n.detached && rules.has("detached-instance")) {
      issues.push({ ...base(n, "detached-instance"), value: n.detached, suggestion: { action: "replace with an instance of the component", ...n.detached } });
    }
    if (n.emptyFrame && rules.has("empty-frame")) issues.push({ ...base(n, "empty-frame"), suggestion: { action: "delete it, or give it content" } });

    if (rules.has("unbound-color")) {
      for (const p of n.paints ?? []) {
        const c = parseHex(p.color);
        const color = { ...c, a: c.a * p.opacity };
        const target = paintTarget(n, p.field);
        const match = matchColor(color, colorCandidates(tokens, modes, target, respectScopes), maxDeltaE);
        const property = `${p.field}[${p.index}]${p.range ? ` chars ${p.range[0]}-${p.range[1]}` : ""}`;
        const issue: LintIssue = { ...base(n, "unbound-color"), property, value: toHex(color) };
        if (match) {
          issue.suggestion = { [match.kind === "variable" ? "variableId" : "styleId"]: match.id, name: match.name, color: toHex(match.color), exact: match.exact, deltaE: round(match.deltaE) };
          const eligible = match.kind === "variable" || (p.paintCount === 1 && !p.range);
          if (eligible) {
            issue.fix = {
              kind: match.kind === "variable" ? "paint-variable" : "paint-style",
              nodeId: n.id,
              field: p.field,
              index: p.index,
              ...(p.range ? { range: p.range } : {}),
              before: { color: p.color, opacity: p.opacity },
              targetId: match.id,
              targetName: match.name,
              expected: { color: toHex(match.color, false), opacity: match.color.a },
              deltaE: match.deltaE,
              paintCount: p.paintCount,
            };
          }
        }
        issues.push(issue);
      }
    }

    const floats: [LintRule, LintRule, FloatTarget, DsNode["spacing"], number[]][] = [
      ["unbound-spacing", "off-scale-spacing", "gap", n.spacing, spacingScale],
      ["unbound-radius", "off-scale-radius", "radius", n.radius, radiusScale],
    ];
    for (const [unboundRule, scaleRule, target, entries, scale] of floats) {
      for (const e of entries ?? []) {
        if (!e.bound && rules.has(unboundRule)) {
          const match = matchFloat(tokens, e.value, modes, target, respectScopes);
          const issue: LintIssue = { ...base(n, unboundRule), property: e.field, value: e.value };
          if (match) {
            issue.suggestion = { variableId: match.id, name: match.name, value: match.value, exact: match.exact };
            if (match.exact) {
              issue.fix = { kind: "float-variable", nodeId: n.id, field: e.field, before: e.value, targetId: match.id, targetName: match.name, expected: match.value };
            }
          }
          issues.push(issue);
        }
        // A bound value comes from a variable: if that is off-scale, the token needs fixing, not every layer using it.
        if (rules.has(scaleRule) && !e.bound && scale.length && e.value !== 0 && !scale.some((s) => Math.abs(s - e.value) < 0.01)) {
          issues.push({ ...base(n, scaleRule), property: e.field, value: e.value, suggestion: { nearest: nearestOnScale(e.value, scale), scale } });
        }
      }
    }

    if (n.text && rules.has("text-without-style")) {
      const segments = n.text.segments;
      const matches = segments.map((s) => matchTextStyle(s, tokens.textStyles));
      const sameProps = segments.every(
        (s) =>
          s.fontFamily === segments[0].fontFamily &&
          s.fontStyle === segments[0].fontStyle &&
          s.fontSize === segments[0].fontSize &&
          JSON.stringify(s.lineHeight) === JSON.stringify(segments[0].lineHeight) &&
          JSON.stringify(s.letterSpacing) === JSON.stringify(segments[0].letterSpacing)
      );
      segments.forEach((s, i) => {
        const match = matches[i];
        const issue: LintIssue = {
          ...base(n, "text-without-style"),
          property: segments.length > 1 || !n.text!.whole ? `chars ${s.start}-${s.end}` : "textStyleId",
          value: `${s.fontFamily} ${s.fontStyle} ${s.fontSize}`,
        };
        if (match) {
          issue.suggestion = { styleId: match.id, name: match.name, exact: match.exact, ...(match.differences.length ? { differences: match.differences } : {}) };
          // Only whole layers get a style: one style per layer keeps the fix predictable.
          if (match.exact && sameProps && n.text!.whole && i === 0) {
            issue.fix = { kind: "text-style", nodeId: n.id, targetId: match.id, targetName: match.name, range: [segments[0].start, segments[segments.length - 1].end], wholeNode: true };
          }
        }
        issues.push(issue);
      });
    }
  }

  const byRule: Record<string, number> = {};
  for (const r of rules) byRule[r] = 0;
  for (const i of issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
  // Each layer can lose at most one layer's worth: three warnings (or twelve infos) make it fully bad.
  const perNode = new Map<string, number>();
  for (const i of issues) perNode.set(i.nodeId, (perNode.get(i.nodeId) ?? 0) + (i.severity === "warn" ? 1 : 0.25));
  const penalty = [...perNode.values()].reduce((s, w) => s + Math.min(1, w / 3), 0);
  const checked = Math.max(opts.nodesChecked ?? nodes.length, perNode.size);
  const score = checked === 0 ? 100 : Math.max(0, Math.round(100 * (1 - penalty / checked)));
  return {
    issues,
    byRule,
    score,
    scales: {
      spacing: spacingScale.length ? spacingScale : null,
      radius: radiusScale.length ? radiusScale : null,
      ...(opts.spacingScale ? {} : { spacingInferred: true }),
      ...(opts.radiusScale ? {} : { radiusInferred: true }),
    },
  };
};

/** Splits lint issues into changes the fixer may apply and skipped items with the reason. */
export const planFixes = (issues: LintIssue[], rules: LintRule[] = FIXABLE_RULES) => {
  const wanted = new Set(rules.filter((r) => FIXABLE_RULES.includes(r)));
  const changes: FixChange[] = [];
  const skipped: { nodeId: string; name: string; rule: LintRule; property?: string; reason: string }[] = [];
  for (const issue of issues) {
    if (!wanted.has(issue.rule)) continue;
    if (issue.fix) {
      changes.push(issue.fix);
      continue;
    }
    skipped.push({
      nodeId: issue.nodeId,
      name: issue.name,
      rule: issue.rule,
      ...(issue.property ? { property: issue.property } : {}),
      reason: skipReason(issue),
    });
  }
  return { changes, skipped };
};

const skipReason = (issue: LintIssue): string => {
  const s = issue.suggestion;
  switch (issue.rule) {
    case "unbound-color":
      return s?.styleId
        ? `only the colour style "${s.name}" matches, and a style can only replace a layer's single paint, not one of several or part of a text`
        : "no variable or colour style within the ΔE tolerance";
    case "text-without-style":
      if (!s) return "no text style in this font family";
      if (s.exact) return "the layer mixes type settings, or part of it already has a style; style it by hand";
      return `nearest style "${s.name}" differs: ${((s.differences as string[] | undefined) ?? []).join(", ")}`;
    default:
      return s ? `nearest variable "${s.name}" is ${s.value}, not ${issue.value}` : "no FLOAT variable scoped for this property";
  }
};

/* ── accessibility report ─────────────────────────────────────────────────── */

export type A11yIssue = {
  severity: "fail" | "warn";
  check: "contrast" | "targets" | "textSize";
  wcag: string | null;
  nodeId: string;
  name: string;
  path?: string;
  text?: string;
  foreground?: string;
  background?: string;
  ratio?: number;
  required?: number;
  apcaLc?: number;
  method?: "computed" | "sampled" | "skipped";
  suggestion?: unknown;
  [extra: string]: unknown;
};

/**
 * Nearest file colour (by CIEDE2000 from the current text colour) that meets
 * the required ratio against this background. Variables first on ties.
 *
 * Lightness counts half (kL = 2): every passing colour has to differ in
 * lightness, so what makes a suggestion wrong is a change of hue or chroma —
 * plain CIEDE2000 prefers a saturated brand colour over near-black for grey text.
 */
export const suggestTextColor = (
  current: RGBA,
  background: RGB,
  required: number,
  candidates: ColorCandidate[]
) => {
  let best: { candidate: ColorCandidate; ratio: number; deltaE: number } | null = null;
  for (const c of candidates) {
    const ratio = contrastRatio(effectiveForeground(c.color, background), background);
    if (ratio < required) continue;
    const d = deltaE(current, c.color, 2);
    if (!best || d < best.deltaE - 1e-9 || (Math.abs(d - best.deltaE) < 1e-9 && c.kind === "variable" && best.candidate.kind === "style")) {
      best = { candidate: c, ratio, deltaE: d };
    }
  }
  if (!best) return null;
  return {
    [best.candidate.kind === "variable" ? "variableId" : "styleId"]: best.candidate.id,
    name: best.candidate.name,
    color: toHex(best.candidate.color),
    ratio: displayRatio(best.ratio),
  };
};

export const sortIssues = <T extends { severity: string; check?: string; rule?: string; ratio?: number }>(issues: T[]) => {
  const rank: Record<string, number> = { fail: 0, warn: 1, info: 2 };
  return [...issues].sort(
    (a, b) =>
      (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) ||
      String(a.check ?? a.rule).localeCompare(String(b.check ?? b.rule)) ||
      (a.ratio ?? Infinity) - (b.ratio ?? Infinity)
  );
};

export const a11yScore = (checked: number, failures: number, warnings: number) =>
  checked === 0 ? 100 : Math.max(0, Math.round((100 * (checked - failures - 0.25 * warnings)) / checked));

export const a11yMarkdown = (report: {
  root: { id: string; name: string };
  level: Level;
  summary: { checked: number; failures: number; warnings: number; score: number };
  issues: A11yIssue[];
}) => {
  const lines = [
    `# Accessibility report: ${report.root.name} (${report.root.id})`,
    "",
    `WCAG 2.2 level ${report.level}. Score ${report.summary.score}/100 — ${report.summary.checked} checked, ${report.summary.failures} failing, ${report.summary.warnings} warnings.`,
    "",
    "APCA Lc values are informational; pass and fail use WCAG 2.x contrast ratios.",
    "",
    "| Severity | Check | WCAG | Layer | Detail | Suggestion |",
    "|---|---|---|---|---|---|",
  ];
  const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const i of report.issues) {
    const detail =
      i.check === "contrast"
        ? i.ratio !== undefined
          ? `${i.ratio}:1 (needs ${i.required}:1) — ${i.foreground} on ${i.background}, ${i.method}${i.text ? ` — "${i.text}"` : ""}`
          : `${i.note ?? "not checked"}${i.text ? ` — "${i.text}"` : ""}`
        : i.check === "targets"
          ? `${i.width}×${i.height} (min ${i.minTarget})${i.spacingException ? ", passes by spacing" : ""}`
          : `${i.fontSize}px (min ${i.minFontSize})`;
    const s = i.suggestion as Record<string, unknown> | undefined;
    const suggestion = !s ? "" : typeof s === "string" ? s : s.name ? `${s.name} ${s.color ?? ""} ${s.ratio ? `(${s.ratio}:1)` : ""}` : JSON.stringify(s);
    lines.push(`| ${i.severity} | ${i.check} | ${cell(i.wcag ?? "—")} | ${cell(i.path ? `${i.path} / ${i.name}` : i.name)} \`${i.nodeId}\` | ${cell(detail)} | ${cell(suggestion)} |`);
  }
  return lines.join("\n") + "\n";
};
