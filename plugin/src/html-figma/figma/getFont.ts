/*
 * Vendored from sergcen/html-to-figma (https://github.com/sergcen/html-to-figma), MIT License,
 * Copyright (c) Sergei Savelev; via gethopp/figma-mcp-bridge, Copyright (c) 2026 GETHOPP LTD.
 * Modifications Copyright (c) 2026 Murad Yousuf. See ./NOTICE.md and the root NOTICE.md.
 */
import { pickStyle } from "./fontMatch";

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

// TODO: keep list of fonts not found
/**
 * Figma addresses weights by style name, and the names vary by family, so the
 * style is picked by reading names as weights (see fontMatch.ts). Without a
 * weight the nearest style to 400 is used.
 */
export async function getMatchingFont(fontStr: string, fontWeight?: number, italic = false): Promise<FontName> {
  const cacheKey = `${fontStr}|${fontWeight ?? ""}|${italic ? "italic" : ""}`;
  const cached = fontCache[cacheKey];
  if (cached) {
    return cached;
  }

  const availableFonts = await getAvailableFonts();

  for (const family of fontStr.split(/\s*,\s*/)) {
    const normalized = normalizeName(family);
    const familyFonts = availableFonts.filter(
      (font: Font) => normalizeName(font.fontName.family) === normalized
    );
    const style = pickStyle(familyFonts.map((font: Font) => font.fontName.style), fontWeight, italic);
    const match = style && familyFonts.find((font: Font) => font.fontName.style === style);
    if (!match) {
      continue;
    }
    await figma.loadFontAsync(match.fontName);
    fontCache[cacheKey] = match.fontName;
    return match.fontName;
  }

  await figma.loadFontAsync(defaultFont);
  fontCache[cacheKey] = defaultFont;
  return defaultFont;
}
