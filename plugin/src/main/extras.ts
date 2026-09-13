/**
 * Request types this fork adds or replaces. `code.ts` asks here first, so a
 * type handled here shadows upstream's case of the same name (get_screenshot).
 * Kept in its own file so upstream's code.ts stays easy to diff and merge.
 */
import { serializeNode } from "./serializer";
import {
  PLUGIN_VERSION,
  EXPORT_TIMEOUT_MS,
  TimeoutError,
  buildExportSettings,
  ensurePageLoaded,
  exportWithTimeout,
  getStuckExport,
  hiddenBy,
  postProgress,
  resolveNode,
  resolveSceneNode,
  withTimeout,
  yieldToFigma,
  type ExportFormat,
} from "./robust";

type Request = {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
};

type Response = { type: string; requestId: string; data?: unknown; error?: string };

const ok = (request: Request, data: unknown): Response => ({
  type: request.type,
  requestId: request.requestId,
  data,
});

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const FORMATS: ExportFormat[] = ["PNG", "SVG", "JPG", "PDF"];

/* ── export_node ──────────────────────────────────────────────────────────── */

const exportOne = async (nodeId: string, params: Record<string, unknown>) => {
  const node = await resolveSceneNode(nodeId);
  await ensurePageLoaded(node);
  if (params.allowHidden !== true) {
    const hider = hiddenBy(node);
    if (hider) {
      throw new Error(
        hider === node
          ? `Node ${node.id} "${node.name}" is hidden (visible: false), so it has nothing to render`
          : `Node ${node.id} "${node.name}" is inside hidden layer ${hider.id} "${hider.name}", so it has nothing to render`
      );
    }
  }
  const format = FORMATS.includes(params.format as ExportFormat)
    ? (params.format as ExportFormat)
    : "PNG";
  const settings = buildExportSettings({
    format,
    scale: num(params.scale),
    clip: params.clip === true,
    svgOutlineText: bool(params.svgOutlineText),
    svgIdAttribute: bool(params.svgIdAttribute),
    svgSimplifyStroke: bool(params.svgSimplifyStroke),
  });
  const bytes = await exportWithTimeout(
    node,
    settings,
    num(params.timeoutMs) ?? EXPORT_TIMEOUT_MS
  );
  return {
    nodeId: node.id,
    nodeName: node.name,
    format,
    base64: figma.base64Encode(bytes),
    width: node.width,
    height: node.height,
    absoluteBounds: node.absoluteBoundingBox,
  };
};

/* ── scan_nodes ───────────────────────────────────────────────────────────── */

type ScanFilter = {
  types?: string[];
  namePattern?: RegExp;
  textPattern?: RegExp;
  visibleOnly: boolean;
  maxDepth?: number;
  stopAtMatch: boolean;
  minSize?: number;
  maxSize?: number;
  limit: number;
};

const compileRegex = (source: unknown, field: string): RegExp | undefined => {
  if (typeof source !== "string" || source === "") return undefined;
  try {
    return new RegExp(source, "i");
  } catch (err) {
    throw new Error(`${field} is not a valid regular expression: ${String(err)}`);
  }
};

const matches = (node: SceneNode, filter: ScanFilter): boolean => {
  if (filter.types && !filter.types.includes(node.type)) return false;
  if (filter.namePattern && !filter.namePattern.test(node.name)) return false;
  if (filter.textPattern) {
    if (node.type !== "TEXT" || !filter.textPattern.test(node.characters)) return false;
  }
  if (filter.minSize !== undefined || filter.maxSize !== undefined) {
    const size = "width" in node ? Math.max(node.width, node.height) : 0;
    if (filter.minSize !== undefined && size < filter.minSize) return false;
    if (filter.maxSize !== undefined && size > filter.maxSize) return false;
  }
  return true;
};

const describe = async (node: SceneNode, root: SceneNode, depth: number, path: string[]) => {
  const abs = node.absoluteBoundingBox;
  const rootAbs = root.absoluteBoundingBox;
  const entry: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: hiddenBy(node) === null,
    depth,
    path: path.join(" / "),
  };
  if (abs) {
    entry.absoluteBounds = abs;
    if (rootAbs) {
      entry.relativeToRoot = {
        x: Math.round((abs.x - rootAbs.x) * 100) / 100,
        y: Math.round((abs.y - rootAbs.y) * 100) / 100,
        width: abs.width,
        height: abs.height,
      };
    }
  }
  if (node.type === "TEXT") {
    entry.characters = node.characters.length > 200 ? node.characters.slice(0, 200) + "…" : node.characters;
    entry.fontFamily = typeof node.fontName === "symbol" ? "mixed" : node.fontName.family;
    entry.fontStyle = typeof node.fontName === "symbol" ? "mixed" : node.fontName.style;
    entry.fontSize = typeof node.fontSize === "symbol" ? "mixed" : node.fontSize;
  }
  if (node.type === "INSTANCE") {
    try {
      const main = await withTimeout(node.getMainComponentAsync(), 5_000, "Reading main component");
      if (main) {
        entry.componentId = main.id;
        entry.componentName =
          main.parent && main.parent.type === "COMPONENT_SET"
            ? `${main.parent.name} / ${main.name}`
            : main.name;
      }
    } catch {
      // leave it out rather than fail the scan
    }
  }
  return entry;
};

const scan = async (request: Request, root: SceneNode, filter: ScanFilter) => {
  const results: Record<string, unknown>[] = [];
  let visited = 0;
  let truncated = false;

  const walk = async (node: SceneNode, depth: number, path: string[]): Promise<void> => {
    if (truncated) return;
    if (filter.visibleOnly && node.visible === false) return;
    visited++;
    if (visited % 400 === 0) {
      postProgress(request.requestId, `Scanned ${visited} layers, ${results.length} matches`);
      await yieldToFigma();
    }
    const isMatch = depth > 0 && matches(node, filter);
    if (isMatch) {
      if (results.length >= filter.limit) {
        truncated = true;
        return;
      }
      results.push(await describe(node, root, depth, path));
      if (filter.stopAtMatch) return;
    }
    if (filter.maxDepth !== undefined && depth >= filter.maxDepth) return;
    if ("children" in node) {
      for (const child of node.children) {
        await walk(child, depth + 1, [...path, node.name]);
      }
    }
  };

  await walk(root, 0, []);
  return { rootId: root.id, rootName: root.name, visited, count: results.length, truncated, nodes: results };
};

/* ── dispatcher ───────────────────────────────────────────────────────────── */

export const handleExtraRequest = async (request: Request): Promise<Response | null> => {
  const params = request.params ?? {};
  switch (request.type) {
    case "health": {
      const stuck = getStuckExport();
      let probe: Record<string, unknown> = { skipped: "no nodeId given and the current page is empty" };
      const probeId = request.nodeIds?.[0] ?? str(params.nodeId);
      const candidate = probeId
        ? await resolveSceneNode(probeId)
        : figma.currentPage.children.find((child) => child.visible !== false);
      if (candidate) {
        const size = Math.max(candidate.width, candidate.height, 1);
        const t0 = Date.now();
        try {
          await exportWithTimeout(
            candidate,
            { format: "PNG", constraint: { type: "SCALE", value: Math.min(1, 32 / size) } },
            5_000
          );
          probe = { ok: true, ms: Date.now() - t0, nodeId: candidate.id };
        } catch (err) {
          probe = {
            ok: false,
            ms: Date.now() - t0,
            nodeId: candidate.id,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return ok(request, {
        pluginVersion: PLUGIN_VERSION,
        fileName: figma.root.name,
        editorType: figma.editorType,
        currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
        selectionCount: figma.currentPage.selection.length,
        exportProbe: probe,
        lastStuckExport: stuck
          ? { ...stuck, secondsAgo: Math.round((Date.now() - stuck.at) / 1000) }
          : null,
      });
    }

    case "get_pages":
      return ok(request, {
        currentPageId: figma.currentPage.id,
        pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })),
      });

    case "navigate_to_page": {
      const pageId = str(params.pageId);
      const pageName = str(params.pageName);
      const page = figma.root.children.find(
        (candidate) => candidate.id === pageId || (pageName !== undefined && candidate.name === pageName)
      );
      if (!page) throw new Error(`Page not found: ${pageId ?? pageName}`);
      await withTimeout(figma.setCurrentPageAsync(page), 30_000, `Switching to page "${page.name}"`);
      return ok(request, { id: page.id, name: page.name });
    }

    case "get_node":
    case "get_nodes": {
      const ids = request.nodeIds ?? [];
      if (ids.length === 0) throw new Error(`nodeIds is required for ${request.type}`);
      const options = { includeHidden: params.includeHidden === true, depth: num(params.depth) };
      const out: unknown[] = [];
      for (const id of ids) {
        try {
          const node = await resolveSceneNode(id);
          await ensurePageLoaded(node);
          out.push(serializeNode(node, options));
        } catch (err) {
          if (request.type === "get_node") throw err;
          out.push({ id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok(request, request.type === "get_node" ? out[0] : { nodes: out });
    }

    case "scan_nodes": {
      const rootId = str(params.rootId) ?? request.nodeIds?.[0];
      if (!rootId) throw new Error("rootId is required for scan_nodes");
      const root = await resolveSceneNode(rootId);
      await ensurePageLoaded(root);
      const filter: ScanFilter = {
        types: Array.isArray(params.types) ? (params.types as string[]) : undefined,
        namePattern: compileRegex(params.namePattern, "namePattern"),
        textPattern: compileRegex(params.textPattern, "textPattern"),
        visibleOnly: params.visibleOnly !== false,
        maxDepth: num(params.maxDepth),
        stopAtMatch: params.stopAtMatch === true,
        minSize: num(params.minSize),
        maxSize: num(params.maxSize),
        limit: num(params.limit) ?? 2000,
      };
      return ok(request, await scan(request, root, filter));
    }

    case "get_screenshot": {
      // Upstream exported every node at once with Promise.all and no timeout, so
      // one stuck export hid which node was at fault. One at a time, each guarded.
      let ids = request.nodeIds ?? [];
      if (ids.length === 0) ids = figma.currentPage.selection.map((node) => node.id);
      if (ids.length === 0) throw new Error("No nodes to export. Select nodes or provide nodeIds.");
      const exports: unknown[] = [];
      const errors: { nodeId: string; error: string }[] = [];
      for (const [index, id] of ids.entries()) {
        if (ids.length > 1) postProgress(request.requestId, `Exporting ${index + 1}/${ids.length}`, index, ids.length);
        try {
          exports.push(await exportOne(id, params));
        } catch (err) {
          if (ids.length === 1) throw err;
          errors.push({ nodeId: id, error: err instanceof Error ? err.message : String(err) });
          if (err instanceof TimeoutError) break;
        }
      }
      return ok(request, { exports, errors });
    }

    default:
      return null;
  }
};

export { resolveNode };
