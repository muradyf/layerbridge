/*
 * Vendored from sergcen/html-to-figma (https://github.com/sergcen/html-to-figma), MIT License,
 * Copyright (c) Sergei Savelev; via gethopp/figma-mcp-bridge, Copyright (c) 2026 GETHOPP LTD.
 * Modifications Copyright (c) 2026 Murad Yousuf. See ./NOTICE.md and the root NOTICE.md.
 */
const fontCache: { [key: string]: FontName | undefined } = {};

const normalizeName = (str: string) => str.toLowerCase().replace(/[^a-z]/gi, "");

export const defaultFont = { family: "Roboto", style: "Regular" };

let cachedAvailableFonts: Font[] | null = null;

const getAvailableFonts = async () => {
  if (!cachedAvailableFonts) {
    cachedAvailableFonts = await figma.listAvailableFontsAsync();
  }
  return cachedAvailableFonts;
};

/**
 * Figma addresses weights by style name, and which names a family ships varies,
 * so each CSS numeric weight maps to an ordered list of candidates ending at
 * Regular. Without a weight the result is Regular, matching a serialization
 * that carries no `fontWeight`.
 */
const styleCandidates = (fontWeight?: number): string[] => {
  if (typeof fontWeight !== "number" || fontWeight < 500) return ["Regular"];
  if (fontWeight >= 900) return ["Black", "ExtraBold", "Bold", "Regular"];
  if (fontWeight >= 800) return ["ExtraBold", "Bold", "Regular"];
  if (fontWeight >= 700) return ["Bold", "SemiBold", "Regular"];
  if (fontWeight >= 600) return ["SemiBold", "Bold", "Medium", "Regular"];
  return ["Medium", "SemiBold", "Regular"];
};

// TODO: keep list of fonts not found
export async function getMatchingFont(fontStr: string, fontWeight?: number): Promise<FontName> {
  const cacheKey = `${fontStr}|${fontWeight ?? ""}`;
  const cached = fontCache[cacheKey];
  if (cached) {
    return cached;
  }

  const availableFonts = await getAvailableFonts();
  const candidates = styleCandidates(fontWeight);

  for (const family of fontStr.split(/\s*,\s*/)) {
    const normalized = normalizeName(family);
    const familyFonts = availableFonts.filter(
      (font: Font) => normalizeName(font.fontName.family) === normalized
    );
    if (!familyFonts.length) {
      continue;
    }

    for (const style of candidates) {
      const match = familyFonts.find((font: Font) => font.fontName.style === style);
      if (!match) {
        continue;
      }
      await figma.loadFontAsync(match.fontName);
      fontCache[cacheKey] = match.fontName;
      return match.fontName;
    }
  }

  await figma.loadFontAsync(defaultFont);
  fontCache[cacheKey] = defaultFont;
  return defaultFont;
}
