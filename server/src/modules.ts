/**
 * Server-side tool modules. To add a module, write `src/<module>.ts` exporting
 * a `Record<string, PluginToolDef>` (forwarded to the plugin) and/or a
 * `Record<string, ServerToolDef>` (run here), and spread them in below.
 * Registration with MCP, RPC validation and scripts/rpc.mjs all read these.
 */
import type { PluginToolDef, ServerToolDef } from "./common.js";
import { QUALITY_SERVER_TOOLS } from "./quality.js";

export const MODULE_PLUGIN_TOOLS: Record<string, PluginToolDef> = {};

export const MODULE_SERVER_TOOLS: Record<string, ServerToolDef> = {
  ...QUALITY_SERVER_TOOLS,
};
