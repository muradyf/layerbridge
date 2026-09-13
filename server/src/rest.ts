/**
 * Optional REST API tools, for the things a plugin cannot do (verified against
 * Figma's docs, 2026-09): comments, reading version history, listing a team's
 * projects and files, and rendering nodes of files that are not open.
 *
 * Registered only when FIGMA_ACCESS_TOKEN (or FIGMA_TOKEN) is set. Every call
 * counts against Figma's REST rate limits, which depend on the plan the FILE
 * lives in and the token owner's seat — on Starter-plan files rendering and
 * file reads are limited to a handful per month. Prefer the plugin tools for
 * anything they can do.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveOutputPath } from "./assets.js";

const API = "https://api.figma.com";

export const restToken = () => process.env.FIGMA_ACCESS_TOKEN ?? process.env.FIGMA_TOKEN;

/** Accepts a file key or any figma.com file / design / proto / board URL. */
export function parseFileKey(input: string): string {
  const m = input.match(/figma\.com\/(?:file|design|proto|board|slides|deck)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{10,}$/.test(input)) return input;
  throw new Error(`Not a Figma file key or URL: ${input}`);
}

async function call(method: string, pathname: string, body?: unknown): Promise<unknown> {
  const token = restToken();
  if (!token) throw new Error("Set FIGMA_ACCESS_TOKEN to use REST tools");
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { "X-Figma-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    const tier = res.headers.get("x-figma-plan-tier");
    const kind = res.headers.get("x-figma-rate-limit-type");
    throw new Error(
      `Figma REST rate limit hit${tier ? ` (file plan: ${tier}, limit: ${kind})` : ""}.` +
        `${retry ? ` Retry after ${retry}s.` : ""} Plugin tools have no such limit.`
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Figma REST ${res.status}: ${(data as { err?: string; message?: string }).err ?? (data as { message?: string }).message ?? text.slice(0, 200)}`);
  }
  return data;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const run = async (fn: () => Promise<unknown>): Promise<ToolResult> => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

const file = z.string().describe("Figma file URL or file key (the key is the part after /design/ or /file/ in the URL)");

export function registerRestTools(server: McpServer): boolean {
  if (!restToken()) return false;

  server.tool(
    "rest_get_comments",
    "REST: read a file's comments and replies (with the node each is pinned to). Uses your FIGMA_ACCESS_TOKEN and its rate limits.",
    { file },
    async ({ file }) => run(() => call("GET", `/v1/files/${parseFileKey(file)}/comments?as_md=true`))
  );

  server.tool(
    "rest_post_comment",
    "REST: post a comment, optionally pinned to a node or replying to another comment. ⚠️ Visible to everyone with access to the file, posted as the token's owner.",
    {
      file,
      message: z.string().min(1),
      nodeId: z.string().optional().describe("Pin the comment to this node"),
      x: z.number().optional().describe("Offset inside the node, px"),
      y: z.number().optional(),
      replyTo: z.string().optional().describe("Comment id to reply to"),
    },
    async ({ file, message, nodeId, x, y, replyTo }) =>
      run(() =>
        call("POST", `/v1/files/${parseFileKey(file)}/comments`, {
          message,
          ...(replyTo ? { comment_id: replyTo } : {}),
          ...(nodeId ? { client_meta: { node_id: nodeId, node_offset: { x: x ?? 0, y: y ?? 0 } } } : {}),
        })
      )
  );

  server.tool(
    "rest_get_versions",
    "REST: list a file's saved versions (who, when, label). The plugin can save a version (save_version) but cannot read history.",
    { file },
    async ({ file }) => run(() => call("GET", `/v1/files/${parseFileKey(file)}/versions`))
  );

  server.tool(
    "rest_list_team_projects",
    "REST: list a team's projects. The team id is in the team page URL (figma.com/files/team/<id>).",
    { teamId: z.string() },
    async ({ teamId }) => run(() => call("GET", `/v1/teams/${teamId}/projects`))
  );

  server.tool(
    "rest_list_project_files",
    "REST: list the files in a project.",
    { projectId: z.string() },
    async ({ projectId }) => run(() => call("GET", `/v1/projects/${projectId}/files`))
  );

  server.tool(
    "rest_render_nodes",
    "REST: render nodes of any file you can access — no need to open it — and save the images to disk. Heavily rate-limited on Starter-plan files; prefer export_assets / save_screenshots for open files.",
    {
      file,
      nodeIds: z.array(z.string()).min(1),
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
      outputDir: z.string().min(1),
    },
    async ({ file, nodeIds, format = "png", scale, outputDir }) =>
      run(async () => {
        const key = parseFileKey(file);
        const q = new URLSearchParams({ ids: nodeIds.join(","), format, ...(scale ? { scale: String(scale) } : {}) });
        const data = (await call("GET", `/v1/images/${key}?${q}`)) as { images: Record<string, string | null> };
        const dir = resolveOutputPath(outputDir);
        await mkdir(dir, { recursive: true });
        const results: unknown[] = [];
        for (const [id, url] of Object.entries(data.images ?? {})) {
          if (!url) {
            results.push({ nodeId: id, error: "Figma returned no image (invisible or empty node)" });
            continue;
          }
          const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          const bytes = Buffer.from(await img.arrayBuffer());
          const out = path.join(dir, `${id.replace(/[:;]/g, "-")}.${format}`);
          await writeFile(out, bytes);
          results.push({ nodeId: id, file: out, bytes: bytes.length });
        }
        return { outputDir: dir, results };
      })
  );

  return true;
}
