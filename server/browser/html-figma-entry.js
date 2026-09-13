/*
 * Browser entry for import_url, bundled at build time into
 * dist/vendor/html-figma.browser.js and injected into the page by Playwright.
 *
 * html-figma (sergcen/html-to-figma, MIT) publishes its browser serializer as
 * unbundled ES modules that import `file-type`, so it cannot be injected as-is.
 * Its output format is the one the plugin's vendored renderer (same package,
 * 0.3.1) reads.
 */
import { htmlToFigma } from "html-figma/browser/html-to-figma";
import { processImages } from "html-figma/browser/dom-utils";

const toBase64 = (bytes) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

window.__figmaBridgeHtmlToFigma = async (selector) => {
  const root = htmlToFigma(selector || "body");
  if (!root || Array.isArray(root)) return null;
  const layers = [];
  const collect = (layer) => {
    if (!layer || typeof layer !== "object") return;
    layers.push(layer);
    if (Array.isArray(layer.children)) layer.children.forEach(collect);
  };
  collect(root);
  // Images are fetched here, inside the page, where its cookies and origin apply.
  await Promise.all(layers.map((layer) => processImages(layer)));
  // A Uint8Array does not survive JSON; the plugin decodes this base64 back.
  for (const layer of layers) {
    for (const fill of Array.isArray(layer.fills) ? layer.fills : []) {
      if (fill && fill.intArr instanceof Uint8Array) fill.intArr = toBase64(fill.intArr);
    }
  }
  return root;
};
