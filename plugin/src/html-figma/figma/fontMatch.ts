/**
 * Pure font-style matching for html-figma imports: a CSS font-weight and italic
 * flag -> the closest style name a Figma font family ships. No `figma` here, so
 * it runs under `bun test`.
 *
 * Style names vary by family ("Semi Bold" in Inter, "SemiBold" in others,
 * "Demibold", "Heavy"), so names are read as words rather than compared as
 * strings. Styles that carry anything else (a width like "Condensed", an
 * optical size like "Display") are not candidates.
 */

const WEIGHT_WORDS: [RegExp, number][] = [
  [/^(thin|hairline)$/, 100],
  [/^(extralight|ultralight)$/, 200],
  [/^light$/, 300],
  [/^(regular|normal|book|roman|)$/, 400],
  [/^medium$/, 500],
  [/^(semibold|demibold)$/, 600],
  [/^bold$/, 700],
  [/^(extrabold|ultrabold)$/, 800],
  [/^(black|heavy)$/, 900],
];

export type StyleInfo = { style: string; weight: number; italic: boolean };

export const parseStyleName = (style: string): StyleInfo | null => {
  const words = style.toLowerCase().replace(/[^a-z]/g, "");
  const italic = /(italic|oblique)$/.test(words);
  const base = words.replace(/(italic|oblique)$/, "");
  const hit = WEIGHT_WORDS.find(([pattern]) => pattern.test(base));
  return hit ? { style, weight: hit[1], italic } : null;
};

/**
 * CSS font matching order (CSS Fonts 4, §5.2): for 400-500 try heavier up to
 * 500, then lighter, then heavier past 500; below 400 lighter first; above
 * 500 heavier first. Lower rank wins.
 */
const weightRank = (want: number, have: number): number => {
  if (want >= 400 && want <= 500) {
    if (have >= want && have <= 500) return have - want;
    if (have < want) return 1000 + (want - have);
    return 2000 + (have - 500);
  }
  if (want < 400) return have <= want ? want - have : 1000 + (have - want);
  return have >= want ? have - want : 1000 + (want - have);
};

/** The style name to use, or null when none of the family's styles is a plain weight. */
export const pickStyle = (styles: string[], weight = 400, italic = false): string | null => {
  const parsed = styles.map(parseStyleName).filter((s): s is StyleInfo => s !== null);
  if (!parsed.length) return null;
  const sameSlant = parsed.filter((s) => s.italic === italic);
  const pool = sameSlant.length ? sameSlant : parsed;
  return pool.reduce((best, s) => (weightRank(weight, s.weight) < weightRank(weight, best.weight) ? s : best)).style;
};
