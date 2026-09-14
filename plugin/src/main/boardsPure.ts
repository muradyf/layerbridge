/**
 * Figma-free helpers for the FigJam and Slides tools, kept apart so they run
 * under `bun test`.
 */

const normalizeName = (name: string) => name.toLowerCase().replace(/[\s_-]/g, "");

const parseHex = (hex: string): [number, number, number] | null => {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full) || (h.length !== 3 && h.length !== 6 && h.length !== 8)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

/**
 * A FigJam colour name ("yellow", "Light Gray") to its hex from the palette, or
 * a hex passed through. Undefined when it is neither.
 */
export const resolvePaletteColor = (input: string, palette: Record<string, string>): string | undefined => {
  const wanted = normalizeName(input);
  for (const [name, hex] of Object.entries(palette)) {
    if (normalizeName(name) === wanted) return hex;
  }
  return parseHex(input) ? (input.startsWith("#") ? input : `#${input}`) : undefined;
};

/** The palette name closest to a colour; exact matches win. */
export const nearestColorName = (hex: string, palette: Record<string, string>): string | undefined => {
  const target = parseHex(hex);
  if (!target) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const [name, value] of Object.entries(palette)) {
    const rgb = parseHex(value);
    if (!rgb) continue;
    const distance = rgb.reduce((sum, channel, i) => sum + (channel - target[i]) ** 2, 0);
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best?.name;
};

/**
 * Checks a new slide order against the current one: every slide exactly once,
 * no unknown ids, no empty rows. Returns a message, or null when it is valid.
 */
export const validateSlideGrid = (current: string[][], next: string[][]): string | null => {
  if (next.length === 0) return "grid must have at least one row";
  const known = new Set(current.flat());
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown: string[] = [];
  const emptyRows: number[] = [];
  next.forEach((row, r) => {
    if (row.length === 0) emptyRows.push(r);
    for (const id of row) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
      if (!known.has(id)) unknown.push(id);
    }
  });
  const missing = [...known].filter((id) => !seen.has(id));
  const list = (ids: string[]) => ids.slice(0, 10).join(", ") + (ids.length > 10 ? ` and ${ids.length - 10} more` : "");
  const problems: string[] = [];
  if (missing.length) problems.push(`missing slides: ${list(missing)}`);
  if (unknown.length) problems.push(`not slides in this deck: ${list(unknown)}`);
  if (duplicates.size) problems.push(`listed more than once: ${list([...duplicates])}`);
  if (emptyRows.length) problems.push(`empty rows: ${emptyRows.join(", ")}`);
  return problems.length ? `The grid must list every slide exactly once — ${problems.join("; ")}` : null;
};

/** Pads or rejects table cell text so it fits rows × columns. */
export const tableCells = (rows: number, columns: number, cells?: string[][]): string[][] => {
  if (cells && cells.length > rows) throw new Error(`cells has ${cells.length} rows but the table has ${rows}`);
  cells?.forEach((row, r) => {
    if (row.length > columns) throw new Error(`cells row ${r} has ${row.length} entries but the table has ${columns} columns`);
  });
  return Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => cells?.[r]?.[c] ?? ""));
};

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** FigJam's own text font, for a label that has none yet. */
export const DEFAULT_LABEL_FONT = { family: "Inter", style: "Medium" } as const;

/**
 * The font to load before writing a label. A new connector's label reports
 * { family: "" }, which loadFontAsync refuses, so it gets FigJam's font.
 */
export const labelFont = (font: { family: string; style: string }): { family: string; style: string } =>
  font.family ? font : DEFAULT_LABEL_FONT;

type TreeNode<T> = { type: string; children?: readonly T[] };

/**
 * The deck's rows of slides, read from the page's SLIDE_GRID → SLIDE_ROW →
 * SLIDE layers. Null when the page has no slide grid.
 */
export const slideRowsOf = <T extends TreeNode<T>>(page: TreeNode<T>): T[][] | null => {
  const grid = page.children?.find((node) => node.type === "SLIDE_GRID");
  if (!grid) return null;
  return (grid.children ?? [])
    .filter((row) => row.type === "SLIDE_ROW")
    .map((row) => (row.children ?? []).filter((node) => node.type === "SLIDE"));
};
