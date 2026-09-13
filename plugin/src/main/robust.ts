/**
 * Guards for the two ways a Figma plugin call goes wrong without saying so:
 *
 *   1. It never settles. `getNodeByIdAsync`, `page.loadAsync` and above all
 *      `exportAsync` can hang with no error — exportAsync needs Figma's renderer,
 *      which Figma throttles when its window is minimized or covered. Upstream
 *      awaited them bare, so the only symptom was a server-side timeout that
 *      named nothing. Every such call goes through `withTimeout` here and fails
 *      with the node and the likely cause.
 *
 *   2. It is asked for something that cannot render. Exporting a node whose
 *      ancestor is hidden fails with Figma's opaque "no visible layers"; we
 *      check visibility first and say which ancestor hid it.
 */

export const PLUGIN_VERSION = "ours-1";

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`${label} did not finish within ${Math.round(ms / 100) / 10}s`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

export const LOOKUP_TIMEOUT_MS = 10_000;
export const PAGE_LOAD_TIMEOUT_MS = 30_000;
export const EXPORT_TIMEOUT_MS = 30_000;

export const resolveNode = async (nodeId: string): Promise<BaseNode> => {
  const node = await withTimeout(
    figma.getNodeByIdAsync(nodeId),
    LOOKUP_TIMEOUT_MS,
    `Looking up node ${nodeId}`
  );
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
};

export const resolveSceneNode = async (nodeId: string): Promise<SceneNode> => {
  const node = await resolveNode(nodeId);
  if (node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error(`Node ${nodeId} is a ${node.type}, not a layer`);
  }
  return node as SceneNode;
};

export const pageOf = (node: BaseNode): PageNode | null => {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current as PageNode | null;
};

/** Under documentAccess "dynamic-page" another page's subtree is only safe to walk once loaded. */
export const ensurePageLoaded = async (node: BaseNode): Promise<void> => {
  const page = pageOf(node);
  if (!page || page === figma.currentPage) return;
  await withTimeout(page.loadAsync(), PAGE_LOAD_TIMEOUT_MS, `Loading page "${page.name}"`);
};

/** The node itself or the nearest ancestor that is hidden, or null when it renders. */
export const hiddenBy = (node: BaseNode): SceneNode | null => {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if ("visible" in current && (current as SceneNode).visible === false) {
      return current as SceneNode;
    }
    current = current.parent;
  }
  return null;
};

/* ── Export health ───────────────────────────────────────────────────────────
   Once one export times out we remember it. The next export still runs (the
   renderer may simply have been un-throttled) and clears the flag on success;
   `health` reports it so a stall is diagnosable without guessing. */

let stuckExport: { nodeId: string; nodeName: string; at: number } | null = null;

export const getStuckExport = () => stuckExport;

export const EXPORT_STALL_HINT =
  "Figma stops rendering exports while its window is minimized or covered by another window — bring Figma to the front. If it is already in front, close and re-run the plugin.";

export const exportWithTimeout = async (
  node: SceneNode,
  settings: ExportSettings,
  timeoutMs: number = EXPORT_TIMEOUT_MS
): Promise<Uint8Array> => {
  try {
    const bytes = await withTimeout(
      node.exportAsync(settings),
      timeoutMs,
      `Exporting ${node.id} "${node.name}"`
    );
    stuckExport = null;
    return bytes;
  } catch (err) {
    if (err instanceof TimeoutError) {
      stuckExport = { nodeId: node.id, nodeName: node.name, at: Date.now() };
      throw new TimeoutError(`${err.message}. ${EXPORT_STALL_HINT}`);
    }
    throw err;
  }
};

export type ExportFormat = "PNG" | "SVG" | "JPG" | "PDF";

export type ExportOptions = {
  format: ExportFormat;
  scale?: number;
  clip?: boolean;
  svgOutlineText?: boolean;
  svgIdAttribute?: boolean;
  svgSimplifyStroke?: boolean;
};

export const buildExportSettings = (opts: ExportOptions): ExportSettings => {
  const common = opts.clip ? { contentsOnly: true, useAbsoluteBounds: true } : {};
  const scale = typeof opts.scale === "number" && opts.scale > 0 ? opts.scale : 2;
  switch (opts.format) {
    case "SVG":
      return {
        format: "SVG",
        ...common,
        ...(opts.svgOutlineText !== undefined ? { svgOutlineText: opts.svgOutlineText } : {}),
        ...(opts.svgIdAttribute !== undefined ? { svgIdAttribute: opts.svgIdAttribute } : {}),
        ...(opts.svgSimplifyStroke !== undefined
          ? { svgSimplifyStroke: opts.svgSimplifyStroke }
          : {}),
      };
    case "PDF":
      return { format: "PDF", ...common };
    case "JPG":
      return { format: "JPG", constraint: { type: "SCALE", value: scale }, ...common };
    default:
      return { format: "PNG", constraint: { type: "SCALE", value: scale }, ...common };
  }
};

/** Lets the plugin UI (and through it the server) see that a long job is still alive. */
export const postProgress = (requestId: string, message: string, done?: number, total?: number) => {
  figma.ui.postMessage({ type: "progress", requestId, message, done, total });
};

export const yieldToFigma = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
