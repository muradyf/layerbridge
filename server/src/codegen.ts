/**
 * Design-to-code tools: get_code_context, run_script, generate_component_docs.
 * The plugin half is plugin/src/main/codegen.ts; the renderers are pure and
 * live in codegenRender.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveOutputPath } from "./assets.js";
import { fileKey, nodeId, type PluginToolDef, type ServerToolDef } from "./common.js";
import { renderCodeContext, renderComponentDocs, annotateDocsVariables, type CodeContext, type CodeFormat, type DocsData } from "./codegenRender.js";

export const SCRIPTS_ENV = "FIGMA_BRIDGE_ALLOW_SCRIPTS";
export const scriptsAllowed = () => process.env[SCRIPTS_ENV] === "1";
export const SCRIPTS_DISABLED =
  `run_script is turned off. It runs any JavaScript inside the Figma plugin with full access to the open file, so it can read everything and change or delete anything — and a script written from untrusted input (text inside a design, a pasted snippet) could do the same. ` +
  `To turn it on, set ${SCRIPTS_ENV}=1 in the environment of the MCP server (every server process sharing the Figma connection, since the one holding the plugin checks it too) and restart your AI tool.`;

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const writeText = async (outputPath: string, text: string, overwrite: boolean) => {
  const file = resolveOutputPath(outputPath);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: overwrite ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`File already exists: ${file} (pass overwrite: true)`);
    throw err;
  }
  return file;
};

/**
 * The plugin half of run_script, declared so the leader's /rpc validates it:
 * without this, a direct /rpc call (scripts/rpc.mjs, a follower) would reach the
 * plugin without the environment check.
 */
export const CODEGEN_PLUGIN_TOOLS: Record<string, PluginToolDef> = {
  codegen_run_script: {
    description: "Internal: the plugin half of run_script. Call run_script instead.",
    schema: z.object({
      code: z.string().min(1).refine(() => scriptsAllowed(), { message: SCRIPTS_DISABLED }),
      timeoutMs: z.number().int().min(1).max(60_000).optional(),
      fileKey,
    }),
    editing: true,
  },
};

export const CODEGEN_SERVER_TOOLS: Record<string, ServerToolDef> = {
  get_code_context: {
    description:
      "Design-to-code context for one layer, read in a single walk. format \"json\" (default) returns a compact tree — each layer's flex/grid layout (mode, gap, padding, justify/align, fixed/hug/fill sizing, absolute position with constraints), a ref into a deduped styles table (fills, strokes, radius, effects, opacity) and textStyles table, text with mixed-style segments, component instances with variant and property values, icons collapsed to { type: ICON, assetHint }, image fills as imageRef — plus tokens used and assets to export. Every variable-bound value carries the variable name, its CSS custom property (the same name export_tokens writes) and the resolved value. \"jsx-tailwind\" and \"html-css\" return starter code built from that tree, headed by the tokens, components, icons and images it needs.",
    schema: z.object({
      nodeId,
      format: z.enum(["json", "jsx-tailwind", "html-css"]).optional().describe('"json" (default), "jsx-tailwind" or "html-css"'),
      maxDepth: z.number().int().min(0).max(100).optional().describe("Levels of children to read; deeper layers are summarised with a childCount. Default: no limit"),
      includeHidden: z.boolean().optional().describe("Include layers turned off in the design (default false)"),
      expandInstances: z.boolean().optional().describe("Read inside component instances instead of treating each as a component placeholder (default false; the requested layer is always read)"),
      inlineSvgMaxBytes: z.number().int().min(0).max(200_000).optional().describe("Inline each icon's SVG when it is at most this many bytes (default 0: never; up to 60 icons)"),
      maxNodes: z.number().int().min(1).max(20_000).optional().describe("Stop after this many layers (default 3000)"),
      fileKey,
    }),
    async run(sender, params) {
      const resp = await sender.sendWithParams(
        "codegen_scan",
        undefined,
        clean({
          nodeId: params.nodeId,
          maxDepth: params.maxDepth,
          includeHidden: params.includeHidden,
          expandInstances: params.expandInstances,
          inlineSvgMaxBytes: params.inlineSvgMaxBytes,
          maxNodes: params.maxNodes,
        }),
        120_000
      );
      if (resp.error) throw new Error(resp.error);
      return renderCodeContext(resp.data as CodeContext, (params.format as CodeFormat | undefined) ?? "json");
    },
  },

  run_script: {
    description:
      `Run JavaScript inside the Figma plugin with \`figma\` (the Plugin API) in scope, as the body of an async function: use await, and return a JSON-serialisable value. Returns { result, logs (console.log/info/warn/error/debug during the run), durationMs }; nodes in the result become {id, name, type}, cycles are cut and results over ~200KB are truncated. The script can change or delete anything in the file. In Dev Mode only reading works. A timed-out script cannot be stopped and may keep running. Off unless the server runs with ${SCRIPTS_ENV}=1.`,
    schema: z.object({
      code: z.string().min(1).describe("Body of an async function, e.g. \"const n = await figma.getNodeByIdAsync('1:2'); return n.name\""),
      timeoutMs: z.number().int().min(1).max(60_000).optional().describe("Default 10000, max 60000"),
      fileKey,
    }),
    editing: true,
    async run(sender, params) {
      if (!scriptsAllowed()) throw new Error(SCRIPTS_DISABLED);
      const timeoutMs = (params.timeoutMs as number | undefined) ?? 10_000;
      const resp = await sender.sendWithParams("codegen_run_script", undefined, { code: params.code, timeoutMs }, timeoutMs + 15_000);
      if (resp.error) throw new Error(resp.error);
      const data = resp.data as { error?: string; logs?: { level: string; message: string }[] } & Record<string, unknown>;
      if (data?.error) {
        const logs = (data.logs ?? []).map((l) => `  [${l.level}] ${l.message}`);
        throw new Error(logs.length ? `${data.error}\nConsole output before the failure:\n${logs.join("\n")}` : data.error);
      }
      return data;
    },
  },

  generate_component_docs: {
    description:
      "Document a component or component set (an instance documents its main component): name, description, documentation links, property definitions with types, defaults and variant options, the variants, every variable (with its CSS custom property) and style used inside it, and optionally how many instances the file has. Returns markdown (default) or JSON; outputPath also writes it to a file, writeToCanvas also places a documentation frame beside the component (needs the design editor).",
    schema: z.object({
      nodeId,
      format: z.enum(["markdown", "json"]).optional().describe('"markdown" (default) or "json"'),
      countInstances: z.boolean().optional().describe("Count instances across the file (can be slow on big files; default false)"),
      outputPath: z.string().optional().describe("Also write the result here (inside the allowed output folders)"),
      overwrite: z.boolean().optional().describe("Replace an existing file at outputPath (default false)"),
      writeToCanvas: z.boolean().optional().describe("Also create a documentation frame next to the component (default false)"),
      fileKey,
    }),
    async run(sender, params) {
      const resp = await sender.sendWithParams(
        "codegen_component_docs",
        undefined,
        clean({ nodeId: params.nodeId, countInstances: params.countInstances }),
        params.countInstances ? 300_000 : 120_000
      );
      if (resp.error) throw new Error(resp.error);
      const data = annotateDocsVariables(resp.data as DocsData);
      const markdown = renderComponentDocs(data);
      const format = (params.format as string | undefined) ?? "markdown";
      const notes: Record<string, unknown> = {};
      if (typeof params.outputPath === "string") {
        notes.outputPath = await writeText(params.outputPath, format === "json" ? JSON.stringify(data, null, 2) : markdown, params.overwrite === true);
      }
      if (params.writeToCanvas === true) {
        const written = await sender.sendWithParams("codegen_component_docs_write", undefined, { nodeId: params.nodeId, markdown }, 60_000);
        notes.canvas = written.error ? { error: written.error } : written.data;
      }
      if (format === "json") return { ...data, ...notes };
      if (!Object.keys(notes).length) return markdown;
      return `${markdown}\n<!-- ${JSON.stringify(notes).replace(/--/g, "- -")} -->\n`;
    },
  },
};
