/**
 * MCP prompts: reusable workflows a client can offer to the user (clients
 * typically surface them as slash commands). Each returns a single user
 * message naming the tools to call, in order.
 *
 * Tools named here that another module provides (get_code_context,
 * check_accessibility, lint_design_system, fix_design_system, import_tokens)
 * are referred to with a fallback, so a prompt still works on a server built
 * without that module.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NPX_SPEC } from "./brand.js";

const nodeArg = z
  .string()
  .optional()
  .describe("Node ID like 12:345, or a Figma link with ?node-id=12-345. Leave empty to use the current selection.");
const fileKeyArg = z.string().optional().describe("fileKey, when several Figma files are connected (see list_files)");

const message = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: text.trim() } }],
});

/** Normalises a node ID or a figma.com link's node-id (12-345) to 12:345. */
export function nodeTarget(node: string | undefined): string {
  if (!node || node.trim() === "") return "the current selection (call get_selection to find it)";
  const fromUrl = node.match(/[?&]node-id=([0-9]+)[-:]([0-9]+)/);
  const id = fromUrl ? `${fromUrl[1]}:${fromUrl[2]}` : node.trim().replace(/^(\d+)-(\d+)$/, "$1:$2");
  return `node ${id}`;
}

const fileNote = (fileKey: string | undefined) =>
  fileKey ? `Pass fileKey "${fileKey}" to every tool call.` : "If a call says several files are connected, run list_files and pass the right fileKey.";

export const PROMPTS = {
  "implement-design": {
    title: "Implement a Figma design in code",
    description: "Turn a Figma frame or component into code that matches it: read structure, tokens and assets, then build and compare.",
    argsSchema: {
      node: nodeArg,
      framework: z.string().optional().describe("Target stack, e.g. React + Tailwind (default: whatever this project uses)"),
      assetsDir: z.string().optional().describe("Folder for exported icons and images (default: the project's assets folder)"),
      fileKey: fileKeyArg,
    },
    build: ({ node, framework, assetsDir, fileKey }: Record<string, string | undefined>) =>
      message(`
Implement ${nodeTarget(node)} from the open Figma file in code${framework ? ` using ${framework}` : ", following this project's existing stack and conventions"}.

1. Read the design. Call get_code_context for the node if it is available; otherwise use get_design_context and get_nodes (bounds, auto layout, text segments, component properties). Call get_screenshot on the node to see it.
2. Tokens: call get_variable_defs, or export_tokens (format "both") to write W3C JSON and CSS custom properties. Map colours, spacing, radii and type to the project's existing tokens before inventing values.
3. Assets: call scan_nodes on the node (types INSTANCE/VECTOR, stopAtMatch true) to find icons, then export_assets with outputDir "${assetsDir ?? "<the project's assets folder>"}" and format SVG. Use its manifest.json to place each asset. Use export_image_fills for photos.
4. Build the component. Reuse existing components where they match a Figma instance's main component.
5. Compare your result with the screenshot and list any differences you could not resolve.

${fileNote(fileKey)} Do not change the Figma file.`),
  },

  "audit-design": {
    title: "Audit a design for accessibility and design-system use",
    description: "Check contrast, text sizes and hard-coded values against the file's styles and variables; propose fixes and apply them only after a dry run.",
    argsSchema: { node: nodeArg, fileKey: fileKeyArg },
    build: ({ node, fileKey }: Record<string, string | undefined>) =>
      message(`
Audit ${nodeTarget(node)} in the open Figma file.

1. Accessibility: call check_accessibility on it if available. Otherwise use scan_nodes (types TEXT) and get_nodes to check text contrast against its background, text below 12px, and tap targets below 44×44.
2. Design system: call lint_design_system if available. Otherwise compare fills, strokes, text and effects from get_nodes against get_styles and get_variable_defs and list values that are hard-coded instead of bound to a style or variable.
3. Report findings grouped by severity, each with the node ID, layer name, what is wrong and the proposed fix.
4. Fixes: if fix_design_system is available, run it with dryRun: true first and show me the planned changes. Apply them (dryRun: false) only after I confirm. Without it, use bind_variable / apply_style per node, also only after I confirm.
5. After applying, call get_screenshot to confirm nothing visibly broke.

${fileNote(fileKey)}`),
  },

  "build-in-figma": {
    title: "Build a screen or component in Figma",
    description: "Create frames and components with auto layout, the file's variables and styles, then verify with screenshots.",
    argsSchema: {
      description: z.string().describe("What to build, e.g. 'a settings screen with a profile card and three toggles'"),
      parent: z.string().optional().describe("Node ID of the frame, section or page to build in (default: current page)"),
      fileKey: fileKeyArg,
    },
    build: ({ description, parent, fileKey }: Record<string, string | undefined>) =>
      message(`
Build this in the open Figma file: ${description}

1. Look before creating: get_pages, get_local_components, get_styles and get_variable_defs. Reuse existing components (create_instance) and bind colours, spacing and radii to variables (bind_variable) or styles (apply_style) instead of raw values.
2. Plan the layer tree (frames, auto layout direction, gaps, padding) and tell me the plan in a few lines before creating anything.
3. Create it${parent ? ` inside ${nodeTarget(parent)}` : " on the current page"}: create_frame, then set_auto_layout on every container; create_text, create_shape, create_instance for content. Name every layer.
4. Verify: call get_screenshot on the top frame after each major section and fix spacing, overflow or missing fonts before moving on.
5. Never delete or restructure existing layers without asking me; delete_nodes needs confirm: true and I want to approve it first.

Figma must be in the design editor: Dev Mode is read-only. ${fileNote(fileKey)}`),
  },

  "sync-tokens": {
    title: "Sync design tokens between Figma and code",
    description: "Export the file's variables and styles as W3C JSON / CSS, or import tokens from code into Figma variables.",
    argsSchema: {
      direction: z.string().optional().describe("'export' (Figma → code, default) or 'import' (code → Figma)"),
      path: z.string().optional().describe("Token file to write or read, e.g. tokens/figma.json"),
      fileKey: fileKeyArg,
    },
    build: ({ direction, path, fileKey }: Record<string, string | undefined>) =>
      direction?.toLowerCase().startsWith("imp")
        ? message(`
Import design tokens from ${path ?? "this project's token file (find it first)"} into Figma variables.

1. Read the token file and get_variable_defs, then show me which collections, modes and variables would be created, changed or left alone.
2. After I confirm, call import_tokens if the server has it (run it with a dry run first if it offers one). Otherwise use create_variable_collection, add_variable_mode, create_variable and set_variable_value.
3. Call get_variable_defs again and report what changed.

Figma must be in the design editor. ${fileNote(fileKey)}`)
        : message(`
Export the open Figma file's design tokens to ${path ?? "tokens/figma.json"}.

1. Call export_tokens with outputPath "${path ?? "tokens/figma.json"}" and format "both" (W3C JSON plus CSS custom properties, every mode, aliases kept). Use overwrite: true only if I said to replace the existing file.
2. If the path is outside the server's working directory and the call is refused, tell me to add the folder to FIGMA_BRIDGE_OUTPUT_ROOTS.
3. Compare the result with the project's existing tokens and summarise added, removed and changed values.

${fileNote(fileKey)}`),
  },

  troubleshoot: {
    title: "Troubleshoot the Figma bridge",
    description: "Find out why tools fail or time out: server, plugin connection, port, Dev Mode, stuck exports.",
    argsSchema: { symptom: z.string().optional().describe("What went wrong, e.g. the error message") },
    build: ({ symptom }: Record<string, string | undefined>) =>
      message(`
The Figma bridge is not working${symptom ? `: ${symptom}` : ""}. Diagnose it.

1. Call health. It reports the server version, role (leader or follower), port, connected files and a live test export.
2. If files is empty: the plugin is not connected. Tell me to open the file in Figma and run Plugins → Development → the bridge plugin, keep its window open, and check the plugin panel's Port matches the server's port. In a browser, Chrome asks for local network access; allow it or use Figma desktop.
3. If the panel says "Taken over": the same file opened the plugin in another window, which now holds the connection; close one.
4. If an edit fails with "Dev Mode is read-only": switch Figma to the design editor.
5. If an export times out but health's test export works: the node itself is stuck (often hidden or huge); try a smaller node or a lower scale.
6. If calls fail with "several files are connected": call list_files and pass fileKey.
7. If tools are missing after an update: restart the AI tool, re-run setup (npx -y ${NPX_SPEC} setup) and re-run the plugin.
8. From a terminal, the doctor command (npx -y ${NPX_SPEC} doctor) checks the port, token and plugin install without an AI tool.

Report what you found and the one next step.`),
  },
} as const;

export function registerPrompts(server: McpServer): void {
  for (const [name, def] of Object.entries(PROMPTS)) {
    server.registerPrompt(
      name,
      { title: def.title, description: def.description, argsSchema: def.argsSchema },
      // Every argument is an optional or required string; the SDK validates them.
      (args: Record<string, string | undefined>) => def.build(args)
    );
  }
}
