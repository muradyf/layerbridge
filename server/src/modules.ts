/**
 * Server-side tool modules. To add a module, write `src/<module>.ts` exporting
 * a `Record<string, PluginToolDef>` (forwarded to the plugin) and/or a
 * `Record<string, ServerToolDef>` (run here), and spread them in below.
 * Registration with MCP, RPC validation and scripts/rpc.mjs all read these.
 */
import { CODEGEN_PLUGIN_TOOLS, CODEGEN_SERVER_TOOLS } from "./codegen.js";
import type { PluginToolDef, ServerToolDef } from "./common.js";
import { SYNC_SERVER_TOOLS } from "./sync.js";

export const MODULE_PLUGIN_TOOLS: Record<string, PluginToolDef> = { ...CODEGEN_PLUGIN_TOOLS };

export const MODULE_SERVER_TOOLS: Record<string, ServerToolDef> = {
  ...SYNC_SERVER_TOOLS,
  ...CODEGEN_SERVER_TOOLS,
};
