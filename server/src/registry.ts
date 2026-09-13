/**
 * The one list of tools that run on the server: the built-in exporters in
 * assets.ts plus every module's server tools.
 */
import { SERVER_SIDE_TOOLS as ASSET_TOOLS, runServerSideTool as runAssetTool } from "./assets.js";
import type { ServerSender } from "./common.js";
import { MODULE_SERVER_TOOLS } from "./modules.js";

export const SERVER_SIDE_TOOLS = new Set([...ASSET_TOOLS, ...Object.keys(MODULE_SERVER_TOOLS)]);

export async function runServerSideTool(
  tool: string,
  sender: ServerSender,
  params: Record<string, unknown>
): Promise<unknown> {
  const def = MODULE_SERVER_TOOLS[tool];
  return def ? def.run(sender, params) : runAssetTool(tool, sender, params);
}
