/**
 * Tools that run on the SERVER and call the plugin one node at a time:
 * save_screenshots (upstream, now with overwrite / SVG options / stall abort)
 * and export_assets (new — scan a frame and write every matching layer to disk).
 *
 * One node per plugin request is deliberate. A request that exports forty nodes
 * can only fail as a whole and only after its timeout; forty requests fail one
 * at a time, name the node, and let the run stop early once exports stall.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerSender } from "./common.js";

export type { ServerSender } from "./common.js";

export type ExportFormat = "PNG" | "SVG" | "JPG" | "PDF";

export const SERVER_SIDE_TOOLS = new Set([
  "save_screenshots",
  "export_assets",
  "export_tokens",
  "export_frames_to_pdf",
  "export_image_fills",
]);

/* ── output paths ─────────────────────────────────────────────────────────── */

/**
 * Writes must land inside the server's working directory, or inside one of the
 * directories listed in FIGMA_BRIDGE_OUTPUT_ROOTS (separated by the platform's
 * path delimiter — `;` on Windows).
 */
export const allowedOutputRoots = (): string[] => {
  const extra = (process.env.FIGMA_BRIDGE_OUTPUT_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [process.cwd(), ...extra].map((root) => path.resolve(root));
};

export const resolveOutputPath = (outputPath: string): string => {
  const roots = allowedOutputRoots();
  const candidate = path.isAbsolute(outputPath)
    ? path.resolve(outputPath)
    : path.resolve(roots[0], outputPath);
  const inside = roots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!inside) {
    throw new Error(
      `Output path ${candidate} is outside the allowed directories (${roots.join(", ")}). Add its folder to FIGMA_BRIDGE_OUTPUT_ROOTS to allow it.`
    );
  }
  return candidate;
};

const writeBytes = async (
  bytes: Buffer,
  outputPath: string,
  overwrite: boolean
): Promise<"written" | "exists"> => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, bytes, { flag: overwrite ? "w" : "wx" });
    return "written";
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
};

const inferFormat = (outputPath: string): ExportFormat | null => {
  switch (path.extname(outputPath).toLowerCase()) {
    case ".png":
      return "PNG";
    case ".svg":
      return "SVG";
    case ".jpg":
    case ".jpeg":
      return "JPG";
    case ".pdf":
      return "PDF";
    default:
      return null;
  }
};

const EXTENSION: Record<ExportFormat, string> = { PNG: "png", SVG: "svg", JPG: "jpg", PDF: "pdf" };

/* ── shared export call ───────────────────────────────────────────────────── */

export interface ExportOptions {
  format?: ExportFormat;
  scale?: number;
  clip?: boolean;
  svgOutlineText?: boolean;
  svgIdAttribute?: boolean;
  svgSimplifyStroke?: boolean;
  allowHidden?: boolean;
  timeoutMs?: number;
}

interface ExportedNode {
  nodeId: string;
  nodeName: string;
  format: ExportFormat;
  base64: string;
  width: number;
  height: number;
  absoluteBounds?: { x: number; y: number; width: number; height: number } | null;
}

const EXPORT_TIMEOUT_DEFAULT_MS = 30_000;

const exportParams = (opts: ExportOptions): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined && key !== "nodeId" && key !== "outputPath") params[key] = value;
  }
  return params;
};

/**
 * Figma's own exportAsync rejects with "Unable to establish connection to Figma
 * after 10 seconds. Please check your internet connection" when the app briefly
 * loses its server connection. Seen on 2026-09-13 mid-run: two whole screens
 * failed, the third half, and the same nodes exported fine a minute later. It is
 * transient, so retry it rather than report it.
 */
const TRANSIENT = /Unable to establish connection to Figma/i;
const RETRY_DELAYS_MS = [3_000, 8_000, 15_000];

const exportNode = async (
  sender: ServerSender,
  nodeId: string,
  opts: ExportOptions
): Promise<ExportedNode> => {
  const timeoutMs = opts.timeoutMs ?? EXPORT_TIMEOUT_DEFAULT_MS;
  // The plugin's own export timeout fires first and names the node; the idle
  // timeout only catches a plugin that stopped answering altogether.
  let resp = await sender.sendWithParams("get_screenshot", [nodeId], exportParams(opts), timeoutMs + 20_000);
  for (const delay of RETRY_DELAYS_MS) {
    if (!resp.error || !TRANSIENT.test(resp.error)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    resp = await sender.sendWithParams("get_screenshot", [nodeId], exportParams(opts), timeoutMs + 20_000);
  }
  if (resp.error) throw new Error(resp.error);
  const exports = (resp.data as { exports?: ExportedNode[] } | undefined)?.exports;
  if (!Array.isArray(exports) || exports.length === 0 || typeof exports[0].base64 !== "string") {
    throw new Error("The plugin returned no export");
  }
  return exports[0];
};

/** Stall = the export never finished, as opposed to failing with a reason. */
const isStall = (message: string) =>
  message.includes("did not finish within") || message.includes("without answering");

const STALLS_BEFORE_ABORT = 2;

/* ── save_screenshots ─────────────────────────────────────────────────────── */

export interface SaveScreenshotItem extends ExportOptions {
  nodeId: string;
  outputPath: string;
}

export async function executeSaveScreenshots(
  sender: ServerSender,
  params: Record<string, unknown>
) {
  const items = (params.items as SaveScreenshotItem[] | undefined) ?? [];
  const overwrite = params.overwrite === true;
  const defaults: ExportOptions = {
    format: params.format as ExportFormat | undefined,
    scale: params.scale as number | undefined,
    clip: params.clip as boolean | undefined,
    svgOutlineText: params.svgOutlineText as boolean | undefined,
    svgIdAttribute: params.svgIdAttribute as boolean | undefined,
    svgSimplifyStroke: params.svgSimplifyStroke as boolean | undefined,
    allowHidden: params.allowHidden as boolean | undefined,
    timeoutMs: params.timeoutMs as number | undefined,
  };

  const results: Record<string, unknown>[] = [];
  let stalls = 0;
  let abortedReason: string | undefined;

  for (const [index, item] of items.entries()) {
    if (abortedReason) {
      results.push({ index, nodeId: item.nodeId, outputPath: item.outputPath, success: false, error: "not attempted: run stopped after exports stalled" });
      continue;
    }
    try {
      const outputPath = resolveOutputPath(item.outputPath);
      const inferred = inferFormat(outputPath);
      const requested = item.format ?? defaults.format;
      if (requested && inferred && requested !== inferred) {
        throw new Error(`format ${requested} conflicts with the ${path.extname(outputPath)} extension`);
      }
      const format = requested ?? inferred ?? "PNG";
      const exported = await exportNode(sender, item.nodeId, { ...defaults, ...stripUndefined(item), format });
      const status = await writeBytes(Buffer.from(exported.base64, "base64"), outputPath, overwrite);
      stalls = 0;
      results.push({
        index,
        nodeId: exported.nodeId,
        nodeName: exported.nodeName,
        outputPath,
        format,
        width: exported.width,
        height: exported.height,
        success: status === "written",
        ...(status === "exists" ? { error: "file already exists (pass overwrite: true to replace it)" } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ index, nodeId: item.nodeId, outputPath: item.outputPath, success: false, error: message });
      if (isStall(message) && ++stalls >= STALLS_BEFORE_ABORT) abortedReason = message;
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    hasErrors: succeeded < results.length,
    ...(abortedReason ? { stoppedEarly: abortedReason } : {}),
    results,
  };
}

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/* ── export_assets ────────────────────────────────────────────────────────── */

interface ScannedNode {
  id: string;
  name: string;
  type: string;
  path?: string;
  componentName?: string;
  absoluteBounds?: { x: number; y: number; width: number; height: number };
  relativeToRoot?: { x: number; y: number; width: number; height: number };
}

const slug = (value: string) =>
  value
    .normalize("NFKD")
    // "media/icon/book" → "media-icon-book", not "mediaiconbook"
    .replace(/[/=,.:]+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "node";

const idToken = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");

/** Figma writes generated ids (clip0_12_34, paint0_linear…) that differ per node; ignore them when comparing. */
const contentKey = (bytes: Buffer, format: ExportFormat) => {
  let material: Buffer | string = bytes;
  if (format === "SVG") {
    material = bytes
      .toString("utf8")
      .replace(/\b(id|xlink:href|href)="#?[^"]*"/g, '$1=""')
      .replace(/url\(#[^)]*\)/g, "url()");
  }
  return createHash("sha1").update(material).digest("hex");
};

export async function executeExportAssets(sender: ServerSender, params: Record<string, unknown>) {
  const rootId = params.rootId as string | undefined;
  const explicitIds = params.nodeIds as string[] | undefined;
  if (!rootId && (!explicitIds || explicitIds.length === 0)) {
    throw new Error("export_assets needs rootId (to scan) or nodeIds (to export exactly those)");
  }

  const format = (params.format as ExportFormat | undefined) ?? "SVG";
  const overwrite = params.overwrite === true;
  const dedupe = params.dedupe !== false;
  const limit = (params.limit as number | undefined) ?? 500;
  const template = (params.fileName as string | undefined) ?? "{name}__{id}";
  const outputDir = resolveOutputPath(params.outputDir as string);
  await mkdir(outputDir, { recursive: true });

  const opts: ExportOptions = {
    format,
    scale: params.scale as number | undefined,
    clip: params.clip as boolean | undefined,
    svgOutlineText: params.svgOutlineText as boolean | undefined,
    svgIdAttribute: params.svgIdAttribute as boolean | undefined,
    svgSimplifyStroke: params.svgSimplifyStroke as boolean | undefined,
    allowHidden: params.includeHidden === true,
    timeoutMs: params.timeoutMs as number | undefined,
  };

  // 1. Decide which nodes.
  let root: { id: string; name: string; absoluteBounds?: ScannedNode["absoluteBounds"] } | undefined;
  let targets: ScannedNode[];
  let truncated = false;
  if (explicitIds && explicitIds.length > 0) {
    targets = explicitIds.map((id) => ({ id, name: "", type: "" }));
    if (rootId) {
      const resp = await sender.sendWithParams("get_node", [rootId], { depth: 0 });
      if (resp.error) throw new Error(resp.error);
      const data = resp.data as { id: string; name: string; absoluteBounds?: ScannedNode["absoluteBounds"] };
      root = { id: data.id, name: data.name, absoluteBounds: data.absoluteBounds };
    }
  } else {
    const resp = await sender.sendWithParams(
      "scan_nodes",
      undefined,
      stripUndefined({
        rootId,
        types: params.types,
        namePattern: params.namePattern,
        minSize: params.minSize,
        maxSize: params.maxSize,
        maxDepth: params.maxDepth,
        stopAtMatch: params.stopAtMatch ?? true,
        visibleOnly: params.includeHidden !== true,
        limit,
      }),
      120_000
    );
    if (resp.error) throw new Error(resp.error);
    const data = resp.data as { rootId: string; rootName: string; nodes: ScannedNode[]; truncated: boolean };
    targets = data.nodes;
    root = { id: data.rootId, name: data.rootName };
    truncated = data.truncated === true;
  }
  if (targets.length > limit) truncated = true;
  targets = targets.slice(0, limit);

  // 2. Export them one at a time.
  const seen = new Map<string, string>();
  const usedNames = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  let written = 0;
  let deduped = 0;
  let existed = 0;
  let failed = 0;
  let stalls = 0;
  let stoppedEarly: string | undefined;

  for (const [index, target] of targets.entries()) {
    const base: Record<string, unknown> = {
      id: target.id,
      name: target.name,
      type: target.type,
      ...(target.componentName ? { componentName: target.componentName } : {}),
      ...(target.path ? { path: target.path } : {}),
    };
    if (stoppedEarly) {
      entries.push({ ...base, error: "not attempted: run stopped after exports stalled" });
      failed++;
      continue;
    }
    try {
      const exported = await exportNode(sender, target.id, opts);
      stalls = 0;
      const abs = exported.absoluteBounds ?? target.absoluteBounds;
      const rel =
        target.relativeToRoot ??
        (abs && root?.absoluteBounds
          ? {
              x: Math.round((abs.x - root.absoluteBounds.x) * 100) / 100,
              y: Math.round((abs.y - root.absoluteBounds.y) * 100) / 100,
              width: abs.width,
              height: abs.height,
            }
          : undefined);
      const name = target.name || exported.nodeName;
      Object.assign(base, { name, width: exported.width, height: exported.height, absoluteBounds: abs, relativeToRoot: rel });

      const bytes = Buffer.from(exported.base64, "base64");
      const key = dedupe ? contentKey(bytes, format) : `${index}`;
      const earlier = seen.get(key);
      if (earlier) {
        entries.push({ ...base, file: earlier, sameAs: earlier });
        deduped++;
        continue;
      }

      let stem = template
        .replace(/\{name\}/g, slug(name))
        .replace(/\{id\}/g, idToken(target.id))
        .replace(/\{index\}/g, String(index).padStart(3, "0"))
        .replace(/\{type\}/g, (target.type || "node").toLowerCase())
        .replace(/\{x\}/g, rel ? String(Math.round(rel.x)) : "")
        .replace(/\{y\}/g, rel ? String(Math.round(rel.y)) : "")
        .replace(/[<>:"/\\|?*]/g, "-");
      if (usedNames.has(stem)) {
        let n = 2;
        while (usedNames.has(`${stem}-${n}`)) n++;
        stem = `${stem}-${n}`;
      }
      usedNames.add(stem);
      const file = `${stem}.${EXTENSION[format]}`;
      const status = await writeBytes(bytes, path.join(outputDir, file), overwrite);
      if (status === "written") written++;
      else existed++;
      seen.set(key, file);
      entries.push({ ...base, file, ...(status === "exists" ? { note: "file already existed and was left untouched" } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ ...base, error: message });
      failed++;
      if (isStall(message) && ++stalls >= STALLS_BEFORE_ABORT) stoppedEarly = message;
    }
  }

  let manifestPath: string | undefined;
  if (params.manifest !== false) {
    manifestPath = path.join(outputDir, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ root, format, exportedAt: new Date().toISOString(), entries }, null, 2)
    );
  }

  return {
    outputDir,
    manifestPath,
    matched: targets.length,
    ...(truncated ? { truncatedAt: limit } : {}),
    written,
    dedupedIdentical: deduped,
    leftExisting: existed,
    failed,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    failures: entries.filter((e) => e.error).slice(0, 20).map((e) => ({ id: e.id, name: e.name, error: e.error })),
  };
}

/* ── export_tokens ────────────────────────────────────────────────────────── */

interface TokenData {
  fileName: string;
  collections: { name: string; modes: string[] }[];
  variables: { name: string; collection: string; type: string; description?: string; values: Record<string, unknown> }[];
  paintStyles: { name: string; paints: { type: string; color?: string; opacity?: number }[] }[];
  textStyles: { name: string; fontFamily: string; fontStyle: string; fontSize: number; lineHeight: unknown; letterSpacing: unknown }[];
  effectStyles: { name: string; effects: Record<string, unknown>[] }[];
}

const tokenPath = (name: string) => name.split("/").map((s) => s.trim()).filter(Boolean);
const cssName = (parts: string[]) =>
  "--" + parts.join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const W3C_TYPE: Record<string, string> = { COLOR: "color", FLOAT: "number", STRING: "string", BOOLEAN: "boolean" };

const setDeep = (obj: Record<string, unknown>, parts: string[], value: unknown) => {
  let cur = obj;
  for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
};

export function tokensToJson(data: TokenData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ref = (value: unknown, _collection: string) => {
    if (value && typeof value === "object" && "alias" in (value as object)) {
      const target = data.variables.find((v) => (v as unknown as { id?: string }).id === (value as { alias: string }).alias);
      return target ? `{${[target.collection, ...tokenPath(target.name)].join(".")}}` : value;
    }
    return value;
  };
  for (const v of data.variables) {
    const col = data.collections.find((c) => c.name === v.collection);
    const modes = col?.modes ?? Object.keys(v.values);
    const $value = modes.length === 1 ? ref(v.values[modes[0]], v.collection) : undefined;
    const token: Record<string, unknown> = { $type: W3C_TYPE[v.type] ?? "string" };
    if ($value !== undefined) token.$value = $value;
    else {
      token.$value = ref(v.values[modes[0]], v.collection);
      token.$extensions = { modes: Object.fromEntries(modes.map((m) => [m, ref(v.values[m], v.collection)])) };
    }
    if (v.description) token.$description = v.description;
    setDeep(out, [v.collection, ...tokenPath(v.name)], token);
  }
  for (const s of data.paintStyles) {
    const solid = s.paints.find((p) => p.type === "SOLID");
    if (solid?.color) setDeep(out, ["styles", "color", ...tokenPath(s.name)], { $type: "color", $value: solid.color });
  }
  for (const s of data.textStyles) {
    setDeep(out, ["styles", "typography", ...tokenPath(s.name)], {
      $type: "typography",
      $value: { fontFamily: s.fontFamily, fontWeight: s.fontStyle, fontSize: `${s.fontSize}px`, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing },
    });
  }
  for (const s of data.effectStyles) {
    setDeep(out, ["styles", "shadow", ...tokenPath(s.name)], { $type: "shadow", $value: s.effects });
  }
  return out;
}

export function tokensToCss(data: TokenData): string {
  const lines: string[] = [];
  const modesByCollection = new Map(data.collections.map((c) => [c.name, c.modes]));
  const varRef = (value: unknown): string => {
    if (value && typeof value === "object" && "alias" in (value as object)) {
      const target = data.variables.find((v) => (v as unknown as { id?: string }).id === (value as { alias: string }).alias);
      return target ? `var(${cssName([target.collection, ...tokenPath(target.name)])})` : "initial";
    }
    if (typeof value === "number") return `${value}`;
    if (typeof value === "string" && !value.startsWith("#")) return JSON.stringify(value);
    return String(value);
  };
  const blocks = new Map<string, string[]>();
  for (const v of data.variables) {
    const modes = modesByCollection.get(v.collection) ?? Object.keys(v.values);
    modes.forEach((mode, i) => {
      const selector = i === 0 ? ":root" : `[data-theme="${mode.toLowerCase().replace(/\s+/g, "-")}"]`;
      const block = blocks.get(selector) ?? [];
      block.push(`  ${cssName([v.collection, ...tokenPath(v.name)])}: ${varRef(v.values[mode])};`);
      blocks.set(selector, block);
    });
  }
  const root = blocks.get(":root") ?? [];
  for (const s of data.paintStyles) {
    const solid = s.paints.find((p) => p.type === "SOLID");
    if (solid?.color) root.push(`  ${cssName(["style", ...tokenPath(s.name)])}: ${solid.color};`);
  }
  blocks.set(":root", root);
  lines.push(`/* Design tokens exported from "${data.fileName}". First mode of each collection is :root. */`);
  for (const [selector, body] of blocks) lines.push(`${selector} {`, ...body, "}", "");
  return lines.join("\n");
}

export async function executeExportTokens(sender: ServerSender, params: Record<string, unknown>) {
  const resp = await sender.sendWithParams("get_tokens", undefined, undefined, 120_000);
  if (resp.error) throw new Error(resp.error);
  const data = resp.data as TokenData;
  const format = (params.format as string | undefined) ?? "json";
  const overwrite = params.overwrite === true;
  const written: string[] = [];
  const target = params.outputPath as string;
  if (format === "json" || format === "both") {
    const file = resolveOutputPath(format === "both" ? target.replace(/\.(json|css)$/i, "") + ".json" : target);
    if ((await writeBytes(Buffer.from(JSON.stringify(tokensToJson(data), null, 2)), file, overwrite)) === "exists") {
      throw new Error(`File already exists: ${file} (pass overwrite: true)`);
    }
    written.push(file);
  }
  if (format === "css" || format === "both") {
    const file = resolveOutputPath(format === "both" ? target.replace(/\.(json|css)$/i, "") + ".css" : target);
    if ((await writeBytes(Buffer.from(tokensToCss(data)), file, overwrite)) === "exists") {
      throw new Error(`File already exists: ${file} (pass overwrite: true)`);
    }
    written.push(file);
  }
  return {
    written,
    variables: data.variables.length,
    collections: data.collections.length,
    paintStyles: data.paintStyles.length,
    textStyles: data.textStyles.length,
    effectStyles: data.effectStyles.length,
  };
}

/* ── export_frames_to_pdf ─────────────────────────────────────────────────── */

export async function executeExportFramesToPdf(sender: ServerSender, params: Record<string, unknown>) {
  const { PDFDocument } = await import("pdf-lib");
  const ids = (params.nodeIds as string[] | undefined) ?? [];
  if (ids.length === 0) throw new Error("nodeIds is required");
  const outputPath = resolveOutputPath(params.outputPath as string);
  const merged = await PDFDocument.create();
  const pages: { nodeId: string; nodeName?: string; error?: string }[] = [];
  for (const id of ids) {
    const resp = await sender.sendWithParams("export_node_pdf", undefined, { nodeId: id, timeoutMs: params.timeoutMs }, 120_000);
    if (resp.error) {
      pages.push({ nodeId: id, error: resp.error });
      continue;
    }
    const { base64, nodeName } = resp.data as { base64: string; nodeName: string };
    const doc = await PDFDocument.load(Buffer.from(base64, "base64"));
    const copied = await merged.copyPages(doc, doc.getPageIndices());
    copied.forEach((page) => merged.addPage(page));
    pages.push({ nodeId: id, nodeName });
  }
  if (merged.getPageCount() === 0) throw new Error(`No page exported: ${pages.map((p) => p.error).join("; ")}`);
  if (typeof params.title === "string") merged.setTitle(params.title);
  const bytes = Buffer.from(await merged.save());
  if ((await writeBytes(bytes, outputPath, params.overwrite === true)) === "exists") {
    throw new Error(`File already exists: ${outputPath} (pass overwrite: true)`);
  }
  return { outputPath, pages: merged.getPageCount(), bytesWritten: bytes.length, results: pages };
}

/* ── export_image_fills ───────────────────────────────────────────────────── */

const imageExtension = (b: Buffer) =>
  b[0] === 0x89 && b[1] === 0x50 ? "png"
  : b[0] === 0xff && b[1] === 0xd8 ? "jpg"
  : b.slice(0, 3).toString("ascii") === "GIF" ? "gif"
  : b.slice(8, 12).toString("ascii") === "WEBP" ? "webp"
  : "bin";

export async function executeExportImageFills(sender: ServerSender, params: Record<string, unknown>) {
  const resp = await sender.sendWithParams("get_image_fills", undefined, { nodeId: params.nodeId }, 120_000);
  if (resp.error) throw new Error(resp.error);
  const { images } = resp.data as { images: { hash: string; base64: string; nodes: { id: string; name: string }[] }[] };
  const outputDir = resolveOutputPath(params.outputDir as string);
  await mkdir(outputDir, { recursive: true });
  const entries: Record<string, unknown>[] = [];
  for (const img of images) {
    const bytes = Buffer.from(img.base64, "base64");
    const file = `${img.hash}.${imageExtension(bytes)}`;
    const status = await writeBytes(bytes, path.join(outputDir, file), params.overwrite === true);
    entries.push({ hash: img.hash, file, bytes: bytes.length, nodes: img.nodes, ...(status === "exists" ? { note: "existed" } : {}) });
  }
  const manifestPath = path.join(outputDir, "images.json");
  await writeFile(manifestPath, JSON.stringify({ images: entries }, null, 2));
  return { outputDir, manifestPath, images: entries.length };
}

export async function runServerSideTool(
  tool: string,
  sender: ServerSender,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (tool) {
    case "save_screenshots":
      return executeSaveScreenshots(sender, params);
    case "export_assets":
      return executeExportAssets(sender, params);
    case "export_tokens":
      return executeExportTokens(sender, params);
    case "export_frames_to_pdf":
      return executeExportFramesToPdf(sender, params);
    case "export_image_fills":
      return executeExportImageFills(sender, params);
    default:
      throw new Error(`${tool} is not a server-side tool`);
  }
}
