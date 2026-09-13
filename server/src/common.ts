/**
 * Schema pieces and tool-definition types shared by every tool module.
 * Kept free of imports from other modules so nothing here can form a cycle.
 */
import { z } from "zod";
import type { BridgeResponse } from "./types.js";

export const nodeId = z
  .string()
  .regex(/^(\d+:\d+|I\d+:\d+(;\d+:\d+)+)$/, "Node ID must use colon format, e.g. '4029:12345'")
  .describe("Figma node ID, e.g. '4029:12345'");
export const fileKey = z
  .string()
  .optional()
  .describe("The fileKey of the Figma file. Required when several files are connected; see list_files.");
export const confirm = z.literal(true).describe("Must be true — this cannot be undone from here");
export const hex = z.string().regex(/^#?[0-9a-fA-F]{3,8}$/, "Colour must be hex, e.g. '#7C3AED'");

export interface ServerSender {
  sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    idleMs?: number
  ): Promise<BridgeResponse>;
}

/** A tool the server forwards to the plugin as-is (ids inside params). */
export type PluginToolDef = {
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Changes the file; the plugin refuses it in Dev Mode. */
  editing?: boolean;
};

/** A tool that runs on the server and calls the plugin through `sender`. */
export type ServerToolDef = PluginToolDef & {
  run(sender: ServerSender, params: Record<string, unknown>): Promise<unknown>;
};
