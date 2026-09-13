/**
 * Which tools work in which Figma editor. The plugin loads in Figma design,
 * Dev Mode, FigJam and Figma Slides; a tool used in the wrong one is refused
 * up front with the editor named, instead of failing on whatever Plugin API
 * call happens to be missing. Figma-free so it runs under `bun test`.
 */

export type Editor = "figma" | "figjam" | "dev" | "slides" | "buzz";

const EDITOR_NAMES: Record<Editor, string> = {
  figma: "Figma design",
  figjam: "FigJam",
  dev: "Dev Mode",
  slides: "Figma Slides",
  buzz: "Figma Buzz",
};

export const editorName = (editor: string): string => EDITOR_NAMES[editor as Editor] ?? editor;

export const FIGJAM_TOOLS = new Set([
  "get_board",
  "create_sticky",
  "create_shape_with_text",
  "create_connector",
  "create_table",
  "create_code_block",
  "generate_diagram",
]);

export const SLIDES_TOOLS = new Set([
  "get_slides",
  "create_slide",
  "reorder_slides",
  "delete_slide",
  "set_slide_transition",
  "focus_slide",
]);

/** The plugin typings mark these APIs "only available in Figma Design". */
const DESIGN_ONLY = new Set([
  "create_component",
  "combine_as_variants",
  "create_paint_style",
  "create_text_style",
  "create_effect_style",
  "create_grid_style",
]);

/** Figma's Slides guide: no components, styles, variables, libraries or sections. */
const NOT_IN_SLIDES = new Set([
  "create_instance",
  "swap_component",
  "set_instance_properties",
  "add_component_property",
  "update_style",
  "delete_style",
  "apply_style",
  "create_variable_collection",
  "add_variable_mode",
  "rename_variable_mode",
  "create_variable",
  "set_variable_value",
  "bind_variable",
  "delete_variable",
  "delete_variable_collection",
  "create_section",
]);

/** A refusal message when `tool` cannot work in `editor`, else null. */
export function editorRefusal(tool: string, editor: string): string | null {
  const here = editorName(editor);
  if (FIGJAM_TOOLS.has(tool) && editor !== "figjam") {
    return `${tool} works in FigJam boards, but the plugin is running in ${here}. Open a FigJam file and run the plugin there.`;
  }
  if (SLIDES_TOOLS.has(tool) && editor !== "slides") {
    return `${tool} works in Figma Slides, but the plugin is running in ${here}. Open a Slides file and run the plugin there.`;
  }
  if (DESIGN_ONLY.has(tool) && editor !== "figma" && editor !== "dev") {
    return `${tool} only works in Figma design; the plugin is running in ${here}.`;
  }
  if (NOT_IN_SLIDES.has(tool) && editor === "slides") {
    return `${tool} is not available in Figma Slides, which has no components, styles, variables or sections.`;
  }
  return null;
}

/**
 * Adds the editor to an error from a design tool run outside Figma design, so
 * a missing Plugin API reads as "wrong editor" rather than as a bug.
 */
export function withEditorHint(tool: string, message: string, editor: string): string {
  if (editor === "figma" || editor === "dev") return message;
  if (FIGJAM_TOOLS.has(tool) || SLIDES_TOOLS.has(tool)) return message;
  return `${message} (The plugin is running in ${editorName(editor)}; ${tool} may only work in Figma design.)`;
}
