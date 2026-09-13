/**
 * Tool schemas and registrations for the features upstream lacked: components,
 * styles, variables, prototyping, annotations, fonts, tokens, pages, editing,
 * dev resources and a few extras. Every feature tool carries its ids inside
 * `params`, so the server forwards them to the plugin untouched.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirm, fileKey, hex, nodeId, type PluginToolDef } from "./common.js";
import { MODULE_PLUGIN_TOOLS, MODULE_SERVER_TOOLS } from "./modules.js";
import type { Node } from "./node.js";
import type { BridgeResponse } from "./types.js";

type Def = PluginToolDef;

export const FEATURE_TOOLS: Record<string, Def> = {
  /* components */
  get_local_components: {
    description:
      "List the file's own components and component sets with id, key, description, page and property definitions. Scans every page unless pageId is given.",
    schema: z.object({
      pageId: z.string().optional().describe("Only this page (faster on big files)"),
      includeVariants: z.boolean().optional().describe("Also list each variant inside a set (default false)"),
      fileKey,
    }),
  },
  create_component: {
    description: "Turn an existing layer into a main component.",
    schema: z.object({ nodeId, name: z.string().optional(), description: z.string().optional(), fileKey }),
    editing: true,
  },
  combine_as_variants: {
    description: "Combine two or more components into a component set (variants).",
    schema: z.object({ nodeIds: z.array(nodeId).min(2), name: z.string().optional(), parentId: nodeId.optional(), fileKey }),
    editing: true,
  },
  create_instance: {
    description: "Place an instance of a local component (componentId) or a published library component (componentKey).",
    schema: z.object({
      componentId: nodeId.optional(),
      componentKey: z.string().optional().describe("Key of a published library component"),
      parentId: nodeId.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      fileKey,
    }),
    editing: true,
  },
  swap_component: {
    description: "Swap an instance to another component, keeping overrides where Figma can.",
    schema: z.object({ nodeId, componentId: nodeId.optional(), componentKey: z.string().optional(), fileKey }),
    editing: true,
  },
  detach_instance: {
    description: "Detach instances into plain frames.",
    schema: z.object({ nodeIds: z.array(nodeId).min(1), fileKey }),
    editing: true,
  },
  set_instance_properties: {
    description:
      "Set an instance's component properties (variant values, boolean toggles, text, instance swaps). Keys can be plain names ('Label') or Figma's suffixed keys ('Label#12:0').",
    schema: z.object({ nodeId, properties: z.record(z.union([z.string(), z.boolean()])), fileKey }),
    editing: true,
  },
  add_component_property: {
    description: "Add a component property to a component or component set.",
    schema: z.object({
      nodeId,
      name: z.string(),
      propertyType: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]),
      defaultValue: z.union([z.string(), z.boolean()]),
      fileKey,
    }),
    editing: true,
  },

  /* styles */
  create_paint_style: {
    description: "Create a local colour style from one hex colour or a stack of solid paints.",
    schema: z.object({
      name: z.string(),
      hex: hex.optional(),
      opacity: z.number().min(0).max(1).optional(),
      paints: z.array(z.object({ hex, opacity: z.number().min(0).max(1).optional() })).optional(),
      description: z.string().optional(),
      fileKey,
    }),
    editing: true,
  },
  create_text_style: {
    description: "Create a local text style. The font must be available to Figma.",
    schema: z.object({
      name: z.string(),
      fontFamily: z.string(),
      fontStyle: z.string().optional().describe("e.g. Regular, Medium, Bold (default Regular)"),
      fontSize: z.number().positive(),
      lineHeight: z.number().optional().describe("Pixels"),
      letterSpacing: z.number().optional().describe("Pixels"),
      description: z.string().optional(),
      fileKey,
    }),
    editing: true,
  },
  create_effect_style: {
    description: "Create a local effect style (shadows / blurs). Shadow colours may be hex.",
    schema: z.object({ name: z.string(), effects: z.array(z.record(z.unknown())).min(1), fileKey }),
    editing: true,
  },
  create_grid_style: {
    description: "Create a local layout-grid style using Figma's LayoutGrid objects.",
    schema: z.object({ name: z.string(), layoutGrids: z.array(z.record(z.unknown())).min(1), fileKey }),
    editing: true,
  },
  update_style: {
    description: "Update a local style's name, description, colour, type settings, effects or grids.",
    schema: z.object({
      styleId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      hex: hex.optional(),
      opacity: z.number().min(0).max(1).optional(),
      fontFamily: z.string().optional(),
      fontStyle: z.string().optional(),
      fontSize: z.number().positive().optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional(),
      effects: z.array(z.record(z.unknown())).optional(),
      layoutGrids: z.array(z.record(z.unknown())).optional(),
      fileKey,
    }),
    editing: true,
  },
  delete_style: {
    description: "Delete a local style. Requires confirm: true.",
    schema: z.object({ styleId: z.string(), confirm, fileKey }),
    editing: true,
  },
  apply_style: {
    description: "Apply a style to a layer as its fill, stroke, text, effect or grid style.",
    schema: z.object({ nodeId, styleId: z.string(), target: z.enum(["fill", "stroke", "text", "effect", "grid"]).optional(), fileKey }),
    editing: true,
  },

  /* variables */
  create_variable_collection: {
    description: "Create a local variable collection.",
    schema: z.object({ name: z.string(), fileKey }),
    editing: true,
  },
  add_variable_mode: {
    description: "Add a mode (e.g. Dark) to a variable collection.",
    schema: z.object({ collectionId: z.string(), name: z.string(), fileKey }),
    editing: true,
  },
  rename_variable_mode: {
    description: "Rename a mode in a variable collection.",
    schema: z.object({ collectionId: z.string(), modeId: z.string(), name: z.string(), fileKey }),
    editing: true,
  },
  create_variable: {
    description:
      "Create a variable in a collection, optionally with values per mode. Values: hex for COLOR, number for FLOAT, boolean, string, or { alias: variableId }. Modes may be named by id or name.",
    schema: z.object({
      collectionId: z.string(),
      name: z.string(),
      variableType: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
      values: z.record(z.unknown()).optional(),
      fileKey,
    }),
    editing: true,
  },
  set_variable_value: {
    description: "Set a variable's value for one mode (mode id or name).",
    schema: z.object({ variableId: z.string(), modeId: z.string(), value: z.unknown(), fileKey }),
    editing: true,
  },
  delete_variable: {
    description: "Delete a variable. Requires confirm: true.",
    schema: z.object({ variableId: z.string(), confirm, fileKey }),
    editing: true,
  },
  delete_variable_collection: {
    description: "Delete a variable collection and everything in it. Requires confirm: true.",
    schema: z.object({ collectionId: z.string(), confirm, fileKey }),
    editing: true,
  },
  bind_variable: {
    description:
      "Bind a variable to a layer property (width, height, itemSpacing, paddingLeft, cornerRadius, opacity, visible, characters…) or to a fill/stroke colour (field 'fill' or 'stroke'). Omit variableId to unbind.",
    schema: z.object({ nodeId, field: z.string(), variableId: z.string().optional(), paintIndex: z.number().int().min(0).optional(), fileKey }),
    editing: true,
  },

  /* prototyping */
  get_reactions: {
    description: "Read a layer's prototype interactions (triggers and actions).",
    schema: z.object({ nodeId, fileKey }),
  },
  set_reactions: {
    description: "Replace or append a layer's prototype interactions, using Figma's Reaction objects.",
    schema: z.object({ nodeId, reactions: z.array(z.record(z.unknown())), mode: z.enum(["replace", "append"]).optional(), fileKey }),
    editing: true,
  },
  remove_reactions: {
    description: "Remove all of a layer's interactions, or the one at index.",
    schema: z.object({ nodeId, index: z.number().int().min(0).optional(), fileKey }),
    editing: true,
  },

  /* annotations */
  get_annotations: {
    description: "Read Dev Mode annotations in a subtree (default: current page), with the file's annotation categories.",
    schema: z.object({ nodeId: nodeId.optional(), fileKey }),
  },
  set_annotations: {
    description: "Replace or append a layer's annotations ({ label | labelMarkdown, properties?, categoryId? }). Works in Dev Mode too.",
    schema: z.object({ nodeId, annotations: z.array(z.record(z.unknown())), mode: z.enum(["replace", "append"]).optional(), fileKey }),
  },

  /* fonts */
  get_fonts: {
    description: "Fonts used in a subtree (default: current page) with how many text layers use each; optionally the fonts available to Figma.",
    schema: z.object({
      nodeId: nodeId.optional(),
      includeAvailable: z.boolean().optional(),
      family: z.string().optional().describe("Filter available fonts by family"),
      fileKey,
    }),
  },

  /* pages, editing */
  create_section: {
    description: "Create a section, either at a given box or wrapped around existing layers (nodeIds).",
    schema: z.object({
      name: z.string().optional(),
      nodeIds: z.array(nodeId).optional(),
      padding: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fileKey,
    }),
    editing: true,
  },
  set_constraints: {
    description: "Set a layer's resizing constraints.",
    schema: z.object({
      nodeId,
      horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
      vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
      fileKey,
    }),
    editing: true,
  },
  reorder_nodes: {
    description: "Move layers in their parent's stacking order.",
    schema: z.object({
      nodeIds: z.array(nodeId).min(1),
      position: z.enum(["front", "back", "forward", "backward", "index"]),
      index: z.number().int().min(0).optional(),
      fileKey,
    }),
    editing: true,
  },
  lock_nodes: {
    description: "Lock or unlock layers.",
    schema: z.object({ nodeIds: z.array(nodeId).min(1), locked: z.boolean().optional().describe("Default true"), fileKey }),
    editing: true,
  },
  batch_rename_nodes: {
    description:
      "Rename many layers: regex find/replace, or a template with {name} {index} {type}. Target explicit nodeIds or every layer under rootId.",
    schema: z.object({
      nodeIds: z.array(nodeId).optional(),
      rootId: nodeId.optional(),
      find: z.string().optional(),
      replace: z.string().optional(),
      template: z.string().optional(),
      startIndex: z.number().int().optional(),
      caseSensitive: z.boolean().optional(),
      fileKey,
    }),
    editing: true,
  },
  find_replace_text: {
    description: "Find and replace text in every text layer of a subtree (default: current page). dryRun previews.",
    schema: z.object({
      rootId: nodeId.optional(),
      find: z.string(),
      replace: z.string().optional(),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      dryRun: z.boolean().optional(),
      fileKey,
    }),
    editing: true,
  },
  rename_page: {
    description: "Rename a page.",
    schema: z.object({ pageId: z.string(), name: z.string(), fileKey }),
    editing: true,
  },
  delete_page: {
    description: "Delete a page and everything on it. Requires confirm: true.",
    schema: z.object({ pageId: z.string(), confirm, fileKey }),
    editing: true,
  },
  get_viewport: {
    description: "The canvas viewport: centre, zoom and visible bounds.",
    schema: z.object({ fileKey }),
  },
  create_from_svg: {
    description: "Create editable vector layers from an SVG string.",
    schema: z.object({ svg: z.string().min(1), name: z.string().optional(), parentId: nodeId.optional(), x: z.number().optional(), y: z.number().optional(), fileKey }),
    editing: true,
  },
  save_version: {
    description: "Save a named version to the file's version history. Figma notes very recent edits may not be included.",
    schema: z.object({ title: z.string(), description: z.string().optional(), fileKey }),
    editing: true,
  },
  notify: {
    description: "Show a toast message inside Figma.",
    schema: z.object({ message: z.string(), error: z.boolean().optional(), timeoutMs: z.number().positive().optional(), fileKey }),
  },
  get_rest_json: {
    description: "A layer in the REST API's JSON shape (exportAsync JSON_REST_V1), without using the REST API.",
    schema: z.object({ nodeId, fileKey }),
  },
  get_selection_colors: {
    description: "The colours and colour styles used in the current selection.",
    schema: z.object({ fileKey }),
  },
  get_dev_resources: {
    description: "Dev resources (links) attached to a layer, optionally its children too.",
    schema: z.object({ nodeId, includeChildren: z.boolean().optional(), fileKey }),
  },
  add_dev_resource: {
    description: "Attach a dev resource link to a layer. Works in Dev Mode.",
    schema: z.object({ nodeId, url: z.string().url(), name: z.string().optional(), fileKey }),
  },
  delete_dev_resource: {
    description: "Remove a dev resource link from a layer.",
    schema: z.object({ nodeId, url: z.string(), fileKey }),
  },
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const render = async (fn: () => Promise<BridgeResponse>): Promise<ToolResult> => {
  try {
    const resp = await fn();
    if (resp.error) return { content: [{ type: "text", text: resp.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(resp.data) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

export function registerFeatureTools(server: McpServer, node: Node): void {
  for (const [name, def] of Object.entries({ ...FEATURE_TOOLS, ...MODULE_PLUGIN_TOOLS })) {
    server.tool(name, def.description, def.schema.shape, async (args: Record<string, unknown>) => {
      const { fileKey: key, ...params } = args;
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
      return render(() => node.sendWithParams(name, undefined, clean, key as string | undefined, 120_000));
    });
  }
}

/** For the leader's RPC path: validate a feature or module tool's params, keeping ids. */
export function validateFeatureRpc(
  tool: string,
  params?: Record<string, unknown>
): { error: string | null; params?: Record<string, unknown> } | null {
  const def = FEATURE_TOOLS[tool] ?? MODULE_PLUGIN_TOOLS[tool] ?? MODULE_SERVER_TOOLS[tool];
  if (!def) return null;
  const result = def.schema.safeParse(params ?? {});
  if (!result.success) return { error: result.error.issues[0].message };
  const { fileKey: _fileKey, ...rest } = result.data as Record<string, unknown>;
  return { error: null, params: rest };
}
