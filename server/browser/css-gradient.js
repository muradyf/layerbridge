/*
 * CSS background-image gradients -> Figma gradient paints, for import_url.
 *
 * html-figma only reads url() backgrounds, so a gradient used to import as no
 * fill at all. The patched serializer (patches/html-figma@0.3.1.patch) passes
 * the computed background-image through as `cssBackgroundImage`, and the
 * browser entry turns it into paints here.
 *
 * Supported: linear-gradient at any angle or `to` keyword, and radial-gradient
 * in its default shape (a centred ellipse reaching the farthest corner).
 * Anything else (repeating, conic, positioned or sized radials, calc() stops,
 * colour hints) is skipped and named in `skipped`.
 */

/** Split at commas that are not inside parentheses. */
export const splitTopLevel = (value) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
};

const COLOR = /^(rgba?\([^)]*\)|transparent)\s*(.*)$/i;

/** Computed styles serialise colours as rgb()/rgba(); both syntaxes are accepted. */
const parseColor = (token) => {
  if (/^transparent$/i.test(token)) return { r: 0, g: 0, b: 0, a: 0 };
  const nums = token.match(/-?[\d.]+%?/g);
  if (!nums || nums.length < 3) return null;
  const channel = (n) => (n.endsWith("%") ? parseFloat(n) / 100 : parseFloat(n) / 255);
  const alpha = nums[3] === undefined ? 1 : nums[3].endsWith("%") ? parseFloat(nums[3]) / 100 : parseFloat(nums[3]);
  return { r: channel(nums[0]), g: channel(nums[1]), b: channel(nums[2]), a: alpha };
};

const ANGLE_UNITS = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/** The gradient's angle in CSS degrees (0 = up, clockwise), or null if `token` is not an angle. */
const parseDirection = (token, width, height) => {
  const angle = token.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/i);
  if (angle) return parseFloat(angle[1]) * ANGLE_UNITS[angle[2].toLowerCase()];
  const to = token.match(/^to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?$/i);
  if (!to) return null;
  const words = [to[1], to[2]].filter(Boolean).map((w) => w.toLowerCase());
  const sx = words.includes("right") ? 1 : words.includes("left") ? -1 : 0;
  const sy = words.includes("bottom") ? 1 : words.includes("top") ? -1 : 0;
  // A corner keyword points the line at that corner's side so the 50% line
  // runs through the other two corners.
  return (Math.atan2(sx * height, -sy * width) * 180) / Math.PI;
};

/**
 * Parse colour stops. `lineLength` converts px positions; pass null where px
 * has no single meaning (radial). Returns null when a stop is not understood.
 */
const parseStops = (parts, lineLength) => {
  const stops = [];
  for (const part of parts) {
    const m = part.match(COLOR);
    if (!m) return null; // a colour hint or an unsupported colour
    const color = parseColor(m[1]);
    if (!color) return null;
    const positions = m[2] ? m[2].split(/\s+/) : [];
    if (positions.length === 0) stops.push({ color, position: null });
    for (const pos of positions) {
      let value;
      if (pos.endsWith("%")) value = parseFloat(pos) / 100;
      else if (pos.endsWith("px") && lineLength) value = parseFloat(pos) / lineLength;
      else if (pos === "0") value = 0;
      else return null;
      if (!isFinite(value)) return null;
      stops.push({ color, position: value });
    }
  }
  if (stops.length < 2) return null;
  // CSS fills in missing positions: the ends default to 0% and 100%, a run of
  // unpositioned stops spreads evenly between its neighbours, and no stop may
  // sit before an earlier one.
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  let max = stops[0].position;
  for (const stop of stops) {
    if (stop.position !== null) stop.position = max = Math.max(max, stop.position);
  }
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].position !== null) continue;
    let j = i;
    while (stops[j].position === null) j++;
    const from = stops[i - 1].position;
    const step = (stops[j].position - from) / (j - i + 1);
    for (let k = i; k < j; k++) stops[k].position = from + step * (k - i + 1);
  }
  // Figma keeps stops inside the layer's 0..1 range.
  return stops.map(({ color, position }) => ({ color, position: Math.min(1, Math.max(0, position)) }));
};

/**
 * Figma's gradientTransform maps the layer's unit square (u, v) into gradient
 * space, where the gradient runs along x from 0 to 1. For a CSS angle the line
 * passes through the centre and is just long enough for the far corners to
 * reach 0% and 100%.
 */
const linearTransform = (degrees, width, height) => {
  const rad = (degrees * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  const alongCentre = (width / 2) * dx + (height / 2) * dy;
  const acrossCentre = -(width / 2) * dy + (height / 2) * dx;
  return {
    length,
    transform: [
      [(width * dx) / length, (height * dy) / length, 0.5 - alongCentre / length],
      [(-width * dy) / length, (height * dx) / length, 0.5 - acrossCentre / length],
    ],
  };
};

// Figma's untransformed radial gradient is the ellipse inscribed in the layer.
// CSS's default reaches the farthest corner with the same proportions, which is
// that ellipse scaled up by the square root of two.
const S = Math.SQRT1_2;
const RADIAL_FARTHEST_CORNER = [
  [S, 0, 0.5 - 0.5 * S],
  [0, S, 0.5 - 0.5 * S],
];

const DEFAULT_RADIAL = /^(ellipse)?\s*(farthest-corner)?\s*(at\s+(center|center center|50% 50%))?$/i;

const toPaint = (type, transform, stops) => ({
  type,
  visible: true,
  opacity: 1,
  blendMode: "NORMAL",
  gradientTransform: transform,
  gradientStops: stops.map(({ color, position }) => ({ position, color })),
});

/**
 * Paints for a computed `background-image`, bottom layer first (Figma paints
 * the last fill on top; CSS paints the first image on top). url() images are
 * left to html-figma and not reported.
 */
export const gradientPaints = (backgroundImage, width, height) => {
  const paints = [];
  const skipped = [];
  if (!backgroundImage || !(width > 0) || !(height > 0)) return { paints, skipped };
  for (const image of splitTopLevel(backgroundImage)) {
    const fn = image.match(/^([a-z-]+)\((.*)\)$/is);
    if (!fn || fn[1].toLowerCase() === "url") continue;
    const name = fn[1].toLowerCase();
    const args = splitTopLevel(fn[2]);
    let paint = null;
    if (name === "linear-gradient") {
      const degrees = parseDirection(args[0], width, height);
      const { length, transform } = linearTransform(degrees ?? 180, width, height);
      const stops = parseStops(degrees === null ? args : args.slice(1), length);
      if (stops) paint = toPaint("GRADIENT_LINEAR", transform, stops);
    } else if (name === "radial-gradient") {
      const hasPrelude = !COLOR.test(args[0]);
      if (!hasPrelude || DEFAULT_RADIAL.test(args[0])) {
        const stops = parseStops(hasPrelude ? args.slice(1) : args, null);
        if (stops) paint = toPaint("GRADIENT_RADIAL", RADIAL_FARTHEST_CORNER, stops);
      }
    }
    if (paint) paints.push(paint);
    else skipped.push(image);
  }
  return { paints: paints.reverse(), skipped };
};
