/**
 * Sync module: bring the build back into Figma and check the two agree.
 *
 *   import_tokens     — DTCG / CSS / Tailwind tokens → local variables (dry run by default)
 *   compare_to_image  — a node's render against a screenshot of the built page, with
 *                       the mismatching regions and the layers most likely at fault
 *   import_url        — a local page rendered in Playwright → editable layers
 *
 * Parsing and image maths live in sync-tokens.ts / sync-image.ts (pure); the plugin
 * plans and applies token imports in plugin/src/main/sync.ts.
 */
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { allowedOutputRoots, exportNode, resolveOutputPath } from "./assets.js";
import { fileKey, nodeId, type ServerSender, type ServerToolDef } from "./common.js";
import { checkUrl, screenshotUrl, serializeUrl, type Viewport } from "./sync-browser.js";
import { compareImages, decodeImage, encodePng, findRegions, likelyLayers, scaleBox, type LayerBox } from "./sync-image.js";
import { DEFAULT_COLLECTION, parseTokens, type TokenFormat } from "./sync-tokens.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/** Reads stay inside the same folders writes may use: the working directory and FIGMA_BRIDGE_OUTPUT_ROOTS. */
export const readInputFile = async (source: string): Promise<Buffer> => {
  const roots = await Promise.all(allowedOutputRoots().map((r) => realpath(r).catch(() => r)));
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(roots[0], source));
  } catch {
    throw new Error(`File not found: ${source}`);
  }
  const inside = roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!inside) {
    throw new Error(`${resolved} is outside the allowed folders (${roots.join(", ")}). Add its folder to FIGMA_BRIDGE_OUTPUT_ROOTS to allow it.`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`Not a file: ${source}`);
  if (info.size > MAX_INPUT_BYTES) throw new Error(`${source} is larger than ${MAX_INPUT_BYTES} bytes`);
  return readFile(resolved);
};

const viewport = z
  .object({ width: z.number().int().positive().max(8000), height: z.number().int().positive().max(8000) })
  .describe("Browser window size in CSS pixels");

const send = async (sender: ServerSender, type: string, params: Record<string, unknown>, idleMs = 120_000) => {
  const resp = await sender.sendWithParams(type, undefined, params, idleMs);
  if (resp.error) throw new Error(resp.error);
  return resp.data as Record<string, unknown>;
};

const idToken = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");

/* ── import_tokens ────────────────────────────────────────────────────────── */

const importTokens: ServerToolDef = {
  description:
    "Import design tokens into the file's local variables: W3C DTCG JSON (including export_tokens output), CSS custom properties (:root is the default mode; [data-theme=\"x\"], .dark and @media (prefers-color-scheme: dark) are other modes) or Tailwind v4 @theme blocks. Matches existing variables by collection and name, creates what is missing, updates what changed, and sets aliases last. Previews by default — pass dryRun: false to apply. Never deletes; variables the import leaves out are listed as missing.",
  schema: z.object({
    source: z.string().optional().describe("Path to a .json or .css file, relative to the server's working directory"),
    content: z.string().optional().describe("The tokens themselves, instead of a file"),
    format: z.enum(["dtcg", "css", "tailwind", "auto"]).optional().describe("Default auto: JSON is DTCG, anything else CSS (which includes @theme blocks). tailwind reads only @theme blocks."),
    collection: z.string().optional().describe(`Put every token in this collection. Without it, DTCG uses each top-level group as the collection and CSS names are matched to existing variables, falling back to "${DEFAULT_COLLECTION}".`),
    modeMapping: z.record(z.string()).optional().describe('Rename source modes to Figma mode names, e.g. { "dark": "Dark", ":root": "Light" }'),
    dryRun: z.boolean().optional().describe("Default true: report the plan without changing the file"),
    deleteMissing: z.boolean().optional().describe("Not implemented: missing variables are only reported, never deleted"),
    fileKey,
  }),
  editing: true,
  async run(sender, params) {
    const source = params.source as string | undefined;
    const inline = params.content as string | undefined;
    if (!source === !inline) throw new Error("Give exactly one of source (a file path) or content");
    const text = inline ?? (await readInputFile(source!)).toString("utf8");
    const parsed = parseTokens(text, {
      format: params.format as TokenFormat | "auto" | undefined,
      collection: params.collection as string | undefined,
    });
    const warnings = [...parsed.warnings];
    if (params.deleteMissing === true) warnings.push("deleteMissing is not implemented; variables the import leaves out are listed under missing and left in place");
    const header = { format: parsed.format, ...(source ? { source } : {}), tokensParsed: parsed.tokens.length, notes: parsed.notes };
    if (parsed.tokens.length === 0) {
      return { ...header, dryRun: params.dryRun !== false, warnings, note: "No tokens found; nothing was sent to Figma." };
    }
    const result = await send(sender, "sync_import_tokens", {
      tokens: parsed.tokens,
      dryRun: params.dryRun !== false,
      modeMapping: params.modeMapping ?? {},
      defaultCollection: DEFAULT_COLLECTION,
    });
    return { ...header, ...result, warnings: [...warnings, ...((result.warnings as string[] | undefined) ?? [])] };
  },
};

/* ── compare_to_image ─────────────────────────────────────────────────────── */

const compareToImage: ServerToolDef = {
  description:
    "Compare a Figma node with the built page or component: exports the node as PNG, compares it with a local screenshot (image) or a screenshot Playwright takes of a local URL, and writes design, actual and diff PNGs. Returns the mismatch percentage and the largest mismatching regions in design coordinates, each with the layers most likely responsible. url needs the optional Playwright install.",
  schema: z.object({
    nodeId,
    image: z.string().optional().describe("Path to a PNG (or JPG, with the optional jpeg-js) of the built UI, inside the allowed folders"),
    url: z.string().optional().describe("A localhost or file URL to screenshot instead (needs Playwright)"),
    selector: z.string().optional().describe("With url: screenshot only the first element matching this CSS selector"),
    viewport: viewport.optional().describe("With url: window size in CSS pixels (default: the node's size)"),
    scale: z.number().positive().max(4).optional().describe("Pixels per design unit for both images (default 1). Use 2 for a retina screenshot."),
    threshold: z.number().min(0).max(1).optional().describe("pixelmatch colour threshold, 0–1 (default 0.1; lower is stricter)"),
    fit: z.enum(["crop", "resize"]).optional().describe("When sizes differ: crop compares the overlapping top-left area (default); resize scales the image to the design's size first"),
    maxRegions: z.number().int().min(1).max(50).optional().describe("How many regions to return (default 5)"),
    outputDir: z.string().optional().describe("Where to write the PNGs (default figma-compare), inside the allowed folders"),
    fileKey,
  }),
  async run(sender, params) {
    const id = params.nodeId as string;
    const imagePath = params.image as string | undefined;
    const rawUrl = params.url as string | undefined;
    if (!imagePath === !rawUrl) throw new Error("Give exactly one of image (a file path) or url");
    const scale = (params.scale as number | undefined) ?? 1;
    const notes: string[] = [];

    const exported = await exportNode(sender, id, { format: "PNG", scale, clip: true });
    const designBytes = Buffer.from(exported.base64, "base64");
    const design = await decodeImage(designBytes);

    let actualBytes: Buffer;
    let actualExt = "png";
    if (imagePath) {
      actualBytes = await readInputFile(imagePath);
      if (actualBytes[0] === 0xff && actualBytes[1] === 0xd8) actualExt = "jpg";
    } else {
      const url = checkUrl(rawUrl!);
      const vp: Viewport = (params.viewport as Viewport | undefined) ?? {
        width: Math.max(1, Math.ceil(exported.width)),
        height: Math.max(1, Math.ceil(exported.height)),
      };
      actualBytes = await screenshotUrl(url, vp, scale, params.selector as string | undefined);
    }
    const actual = await decodeImage(actualBytes);

    const sizesDiffer = design.width !== actual.width || design.height !== actual.height;
    const fit = (params.fit as "crop" | "resize" | undefined) ?? "crop";
    const cmp = compareImages(design, actual, { threshold: params.threshold as number | undefined, fit });
    if (sizesDiffer && fit === "crop") {
      notes.push(`Sizes differ (design ${design.width}×${design.height}px, image ${actual.width}×${actual.height}px); compared the top-left ${cmp.width}×${cmp.height}px they share. Pass fit: "resize" to scale the image instead.`);
    }
    if (cmp.resized) notes.push(`The image was resized from ${actual.width}×${actual.height}px to the design's ${design.width}×${design.height}px before comparing.`);

    const regions = findRegions(cmp.mask, cmp.width, cmp.height, {
      cell: Math.max(4, Math.round(8 * scale)),
      minPixels: Math.max(4, Math.round(4 * scale * scale)),
      maxRegions: (params.maxRegions as number | undefined) ?? 5,
    });

    let layers: LayerBox[] = [];
    try {
      const scanned = await send(sender, "scan_nodes", { rootId: id, visibleOnly: true, stopAtMatch: false, limit: 2000 });
      layers = (scanned.nodes as LayerBox[] | undefined) ?? [];
      if (scanned.truncated) notes.push("The node has more than 2000 visible layers; only the first 2000 were considered as culprits.");
    } catch (err) {
      notes.push(`Could not list the node's layers, so regions are not mapped to layers: ${err instanceof Error ? err.message : String(err)}`);
    }

    const outputDir = resolveOutputPath((params.outputDir as string | undefined) ?? "figma-compare");
    await mkdir(outputDir, { recursive: true });
    const stem = idToken(id);
    const files = {
      design: path.join(outputDir, `${stem}-design.png`),
      actual: path.join(outputDir, `${stem}-actual.${actualExt}`),
      diff: path.join(outputDir, `${stem}-diff.png`),
    };
    await Promise.all([
      writeFile(files.design, designBytes),
      writeFile(files.actual, actualBytes),
      writeFile(files.diff, encodePng(cmp.diff)),
    ]);

    return {
      nodeId: exported.nodeId,
      nodeName: exported.nodeName,
      scale,
      designSize: { width: exported.width, height: exported.height, pixels: { width: design.width, height: design.height } },
      imageSize: { width: actual.width, height: actual.height },
      compared: { width: cmp.width, height: cmp.height, fit, resized: cmp.resized },
      threshold: (params.threshold as number | undefined) ?? 0.1,
      mismatchedPixels: cmp.mismatchedPixels,
      mismatchPercent: cmp.mismatchPercent,
      files,
      regions: regions.map((r) => {
        const box = scaleBox(r.box, scale);
        return { box, mismatchedPixels: r.mismatchedPixels, percentOfRegion: r.percentOfRegion, likelyLayers: likelyLayers(box, layers) };
      }),
      notes,
    };
  },
};

/* ── import_url ───────────────────────────────────────────────────────────── */

const importUrl: ServerToolDef = {
  description:
    "Render a localhost or file URL in Playwright and import the page (or one element, via selector) as editable Figma layers — frames, text, images and SVGs — through import_html_layers. Needs the optional Playwright install.",
  schema: z.object({
    url: z.string().describe("A localhost or file URL (other hosts need FIGMA_BRIDGE_ALLOW_REMOTE_URLS=1)"),
    viewport: viewport.optional().describe("Browser window size in CSS pixels (default 1440×900)"),
    selector: z.string().optional().describe("CSS selector of the element to import (default body)"),
    name: z.string().optional().describe("Name of the wrapper frame (default: the URL's host and path)"),
    parentId: nodeId.optional().describe("Frame or section to put the wrapper in"),
    x: z.number().optional(),
    y: z.number().optional(),
    fileKey,
  }),
  editing: true,
  async run(sender, params) {
    const url = checkUrl(params.url as string);
    const vp = (params.viewport as Viewport | undefined) ?? { width: 1440, height: 900 };
    const selector = params.selector as string | undefined;
    const layers = await serializeUrl(url, vp, selector);
    if (!layers || typeof layers.type !== "string") {
      throw new Error(`Nothing to import: ${selector ? `no visible element matches ${selector}` : "the page has no visible content"} at ${url.href}`);
    }
    const name = (params.name as string | undefined) ?? (url.protocol === "file:" ? path.basename(url.pathname) : `${url.host}${url.pathname}`);
    const result = await send(sender, "import_html_layers", {
      layers,
      name,
      ...(params.parentId ? { parentId: params.parentId } : {}),
      ...(params.x !== undefined ? { x: params.x } : {}),
      ...(params.y !== undefined ? { y: params.y } : {}),
    }, 300_000);
    return { url: url.href, viewport: vp, ...(selector ? { selector } : {}), ...result };
  },
};

export const SYNC_SERVER_TOOLS: Record<string, ServerToolDef> = {
  import_tokens: importTokens,
  compare_to_image: compareToImage,
  import_url: importUrl,
};
