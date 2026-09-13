/**
 * Pure helpers for the quality scans (a11y_scan, ds_scan): rectangle geometry,
 * interactive-target detection, paint classification. No `figma` global, so
 * they are tested with `bun test`. Colour math lives on the server
 * (server/src/quality-core.ts); the plugin only decides structure.
 */

export type Box = { x: number; y: number; width: number; height: number };

export const intersect = (a: Box | null, b: Box | null): Box | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

export const overlaps = (a: Box, b: Box) => intersect(a, b) !== null;

const EPS = 0.01;

/** Whether `outer`, a rectangle with corner radius `radius`, contains all of `inner`. */
export const containsBox = (outer: Box, inner: Box, radius = 0): boolean => {
  if (
    inner.x < outer.x - EPS ||
    inner.y < outer.y - EPS ||
    inner.x + inner.width > outer.x + outer.width + EPS ||
    inner.y + inner.height > outer.y + outer.height + EPS
  ) {
    return false;
  }
  const r = Math.min(Math.max(0, radius), outer.width / 2, outer.height / 2);
  if (r <= 0) return true;
  // A rounded rectangle is convex, so it contains a box iff it contains the box's corners.
  const corners = [
    [inner.x, inner.y],
    [inner.x + inner.width, inner.y],
    [inner.x, inner.y + inner.height],
    [inner.x + inner.width, inner.y + inner.height],
  ];
  return corners.every(([px, py]) => {
    const cx = Math.min(Math.max(px, outer.x + r), outer.x + outer.width - r);
    const cy = Math.min(Math.max(py, outer.y + r), outer.y + outer.height - r);
    return Math.hypot(px - cx, py - cy) <= r + EPS;
  });
};

/** Whole words only, after splitting camelCase: "PrimaryButton" and "Tabs" match, "Table" and "Selection" don't. */
export const INTERACTIVE_NAME = /(^|[^a-z])(icon[- ]?button|button|link|toggle|switch|checkbox|radio|tab|chip|input|select)s?(?![a-z])/i;

export const isInteractiveName = (name: string) =>
  INTERACTIVE_NAME.test(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));

/** Figma's auto-generated layer names. */
export const DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Text|Line|Polygon|Star|Section|Image) \d+$/;

const CLICK_TRIGGERS = new Set(["ON_CLICK", "ON_PRESS", "MOUSE_DOWN", "MOUSE_UP"]);

export const hasClickReaction = (reactions: ReadonlyArray<{ trigger: { type: string } | null }> | undefined) =>
  !!reactions && reactions.some((r) => r.trigger !== null && CLICK_TRIGGERS.has(r.trigger.type));

/** Shapes whose own box we can trust as the painted area (with a corner radius). */
export const RECT_LIKE = new Set(["FRAME", "RECTANGLE", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

/** Anything but a pure translation/scale in an absolute transform. */
export const isRotated = (t: ReadonlyArray<ReadonlyArray<number>>) => Math.abs(t[0][1]) > 1e-6 || Math.abs(t[1][0]) > 1e-6;

export type PaintLike = {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: { r: number; g: number; b: number };
  boundVariables?: { color?: unknown };
};

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
export const rgbHex = (c: { r: number; g: number; b: number }) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** Paint as JSON for the server: colour as hex, visibility and blend kept. */
export const paintJson = (p: PaintLike) => ({
  type: p.type,
  ...(p.type === "SOLID" && p.color ? { color: rgbHex(p.color) } : {}),
  opacity: p.opacity ?? 1,
  ...(p.visible === false ? { visible: false } : {}),
  ...(p.blendMode && p.blendMode !== "NORMAL" ? { blendMode: p.blendMode } : {}),
});

export const visiblePaints = <P extends PaintLike>(paints: ReadonlyArray<P>) =>
  paints.filter((p) => p.visible !== false && (p.opacity ?? 1) > 0);

/** A layer is an opaque, fully-covering solid when it can end the background search on its own. */
export const isOpaqueSolid = (paints: ReadonlyArray<PaintLike>, opacity: number) =>
  opacity >= 0.999 &&
  visiblePaints(paints).some(
    (p) => p.type === "SOLID" && (p.opacity ?? 1) >= 0.999 && (!p.blendMode || p.blendMode === "NORMAL")
  ) &&
  visiblePaints(paints).every((p) => p.type === "SOLID" && (!p.blendMode || p.blendMode === "NORMAL"));

export const shortPath = (names: string[], keep = 6) =>
  (names.length > keep ? ["…", ...names.slice(-keep)] : names).join(" / ");

export const excerpt = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

export const A11Y_TAG = "quality:a11y";
