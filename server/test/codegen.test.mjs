// codegen module: pure renderers from dist/, then the three tools end to end
// against a fake plugin. Run: bun run build && BRIDGE_TEST_PORT=1997 node --test test/codegen.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { readToken, TOKEN_HEADER } = await load("auth.js");
const R = await load("codegenRender.js");

const PORT = Number(process.env.BRIDGE_TEST_PORT ?? 1997);
const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-codegen-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let plugin;

/* ── fixture: what codegen_scan returns for a small card ───────────────────── */

const scanPayload = () => ({
  root: {
    id: "1:1",
    name: "Card",
    type: "FRAME",
    style: "s1",
    layout: {
      mode: "column",
      gap: { value: 16, var: "md", collection: "Spacing" },
      padding: [24, 24, 24, 24],
      align: "start",
      clip: true,
      sizing: { w: "fixed", h: "hug" },
      width: 360,
      height: 420,
    },
    children: [
      {
        id: "1:2",
        name: "Header",
        type: "FRAME",
        layout: { mode: "row", justify: "space-between", align: "center", sizing: { w: "fill", h: "hug" }, width: 312, height: 28 },
        children: [
          { id: "1:3", name: "Title", type: "TEXT", layout: { sizing: { w: "hug", h: "hug" }, noWrap: true, width: 120, height: 28 }, text: { content: "Weekly report", style: "t1" } },
          { id: "1:4", name: "Icon / Bell", type: "ICON", assetHint: "icon-bell.svg", component: { name: "Name=Bell", set: "Icon" }, layout: { sizing: { w: "fixed", h: "fixed" }, width: 24, height: 24 } },
        ],
      },
      { id: "1:5", name: "Photo", type: "IMAGE", imageRef: "img123", style: "s2", layout: { sizing: { w: "fill", h: "fixed" }, width: 312, height: 160 } },
      {
        id: "1:6",
        name: "Body",
        type: "TEXT",
        layout: { sizing: { w: "fill", h: "hug" }, width: 312, height: 20 },
        text: { content: "Hello world", style: "t2", segments: [{ content: "Hello ", style: "t2" }, { content: "world", style: "t3" }] },
      },
      {
        id: "1:7",
        name: "Button",
        type: "INSTANCE",
        childCount: 2,
        layout: { sizing: { w: "hug", h: "hug" }, width: 96, height: 40 },
        component: {
          name: "Size=Large, State=Default",
          set: "Button",
          componentKey: "key-button",
          variantProps: { Size: "Large", State: "Default" },
          props: { Label: "Save", "Show icon": true, Icon: { swap: "Icon / Arrow" } },
        },
      },
      {
        id: "1:8",
        name: "Badge",
        type: "RECTANGLE",
        style: "s3",
        layout: { sizing: { w: "fixed", h: "fixed" }, width: 12, height: 12, position: { x: 340, y: 8, right: 8, bottom: 400, h: "end", v: "start" } },
      },
    ],
  },
  styles: {
    s1: {
      fills: [{ color: { value: "#7c3aed", var: "brand/500", collection: "Color" } }],
      fillStyle: "Brand/Primary",
      radius: 12,
      effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "#0000001a" }],
    },
    s2: { fills: [{ image: "img123", scale: "fill" }], radius: 8 },
    s3: { fills: [{ color: "#ef4444" }], radius: "50%" },
  },
  textStyles: {
    t1: { family: "Inter", weight: 600, fontStyle: "Semi Bold", size: 20, lineHeight: 28, color: { value: "#111827", var: "text/primary", collection: "Color" }, textStyle: "Heading/H3" },
    t2: { family: "Inter", weight: 400, size: 14, lineHeight: "auto", color: "#374151" },
    t3: { family: "Inter", weight: 700, size: 14, lineHeight: "auto", color: "#374151" },
  },
  meta: { fileName: "Test", page: "Page 1", nodeCount: 8, depthTruncated: false },
});

const docsPayload = {
  id: "2:1",
  name: "Button",
  type: "COMPONENT_SET",
  key: "key-button",
  description: "Primary action.",
  documentationLinks: ["https://example.com/button"],
  page: "Components",
  width: 240,
  height: 100,
  properties: [
    { name: "Size", key: "Size", type: "VARIANT", default: "Large", options: ["Small", "Large"] },
    { name: "Label", key: "Label#1:0", type: "TEXT", default: "Button" },
    { name: "Show icon", key: "Show icon#1:1", type: "BOOLEAN", default: true },
  ],
  variantCount: 2,
  variants: [
    { id: "2:2", name: "Size=Small", props: { Size: "Small" } },
    { id: "2:3", name: "Size=Large", props: { Size: "Large" } },
  ],
  defaultVariant: "Size=Small",
  variables: [{ name: "brand/500", collection: "Color", type: "COLOR", fields: ["fills"], uses: 2 }],
  styles: [{ name: "Label/Medium", type: "TEXT", uses: 2 }],
  instances: { count: 5, byPage: { Home: 3, Settings: 2 } },
};

/* ── unit: renderers ──────────────────────────────────────────────────────── */

test("cssValue: px, zero, strings, bound values with fallback", () => {
  assert.equal(R.cssValue(12), "12px");
  assert.equal(R.cssValue(0), "0");
  assert.equal(R.cssValue(0.5, ""), "0.5");
  assert.equal(R.cssValue("50%"), "50%");
  assert.equal(R.cssValue({ value: 16, var: "md", collection: "Spacing", css: "--spacing-md" }), "var(--spacing-md, 16px)");
  assert.equal(R.cssValue({ value: 16, varId: "VariableID:1" }), "16px");
});

test("variable names match export_tokens", () => {
  assert.equal(R.variableCssName("Color", "brand/500"), "--color-brand-500");
  assert.equal(R.variableCssName("Color", "Text / Primary"), "--color-text-primary");
});

test("toTailwind: spacing scale, arbitrary values, padding collapse", () => {
  assert.deepEqual(R.toTailwind([["padding-top", "8px"], ["padding-right", "8px"], ["padding-bottom", "8px"], ["padding-left", "8px"]]), ["p-2"]);
  assert.deepEqual(R.toTailwind([["padding-top", "4px"], ["padding-right", "12px"], ["padding-bottom", "4px"], ["padding-left", "12px"]]), ["py-1", "px-3"]);
  assert.deepEqual(R.toTailwind([["padding-top", "4px"], ["padding-left", "13px"]]), ["pt-1", "pl-[13px]"]);
  assert.deepEqual(R.toTailwind([["width", "312px"], ["height", "160px"], ["gap", "var(--spacing-md, 16px)"]]), ["w-[312px]", "h-40", "gap-[var(--spacing-md,16px)]"]);
  assert.deepEqual(R.toTailwind([["top", "-4px"], ["left", "1px"]]), ["-top-1", "left-px"]);
});

test("toTailwind: colours, type, radius, effects, truncation", () => {
  assert.deepEqual(R.toTailwind([["background-color", "var(--color-brand-500, #7c3aed)"]]), ["bg-[var(--color-brand-500,#7c3aed)]"]);
  assert.deepEqual(R.toTailwind([["color", "var(--c, #111)"], ["font-size", "var(--s, 13px)"]]), ["text-[color:var(--c,#111)]", "text-[length:var(--s,13px)]"]);
  assert.deepEqual(R.toTailwind([["font-size", "14px"], ["font-weight", "450"], ["font-family", '"SF Pro"']]), ["text-sm", "font-[450]", "font-['SF_Pro']"]);
  assert.deepEqual(R.toTailwind([["border-radius", "4px"], ["border-top-left-radius", "8px"], ["border-radius", "50%"]]), ["rounded-[4px]", "rounded-tl-lg", "rounded-full"]);
  assert.deepEqual(R.toTailwind([["box-shadow", "0 4px 12px 0 #0000001a, inset 0 1px 0 0 #fff"]]), ["shadow-[0_4px_12px_0_#0000001a,inset_0_1px_0_0_#fff]"]);
  assert.deepEqual(R.toTailwind([["opacity", "0.5"], ["opacity", "0.33"]]), ["opacity-50", "opacity-[0.33]"]);
  assert.deepEqual(R.toTailwind(R.textDecls({ truncate: 1 })), ["truncate"]);
  assert.deepEqual(R.toTailwind(R.textDecls({ truncate: 3 })), ["line-clamp-3"]);
  assert.deepEqual(R.toTailwind([["transform", "rotate(-45deg)"], ["unknown-prop", "a b"]]), ["-rotate-[45deg]", "[unknown-prop:a_b]"]);
  assert.equal(R.arb("a_b c"), "a\\_b_c");
});

test("layoutDecls: fill and fixed depend on the parent's direction", () => {
  const row = { id: "p", name: "p", type: "FRAME", layout: { mode: "row" } };
  const col = { id: "p", name: "p", type: "FRAME", layout: { mode: "column" } };
  const child = { id: "c", name: "c", type: "FRAME", layout: { sizing: { w: "fill", h: "fixed" }, width: 10, height: 20 } };
  assert.deepEqual(R.layoutDecls(child, row), [["flex", "1 1 0%"], ["height", "20px"]]);
  assert.deepEqual(R.layoutDecls(child, col), [["align-self", "stretch"], ["height", "20px"], ["flex-shrink", "0"]]);
  assert.deepEqual(R.layoutDecls(child, null), [["width", "100%"], ["height", "20px"]]);
  const stretched = { ...child, layout: { ...child.layout, position: { x: 4, y: 6, right: 8, bottom: 10, h: "both", v: "end" } } };
  assert.deepEqual(R.layoutDecls(stretched, col), [["position", "absolute"], ["left", "4px"], ["right", "8px"], ["bottom", "10px"], ["height", "20px"]]);
});

test("styleDecls: gradients, image layers, outside strokes, blur", () => {
  const decls = R.styleDecls({
    fills: [{ color: "#ffffff" }, { gradient: { kind: "linear", angle: 90, stops: [{ at: 0, color: "#000000" }, { at: 100, color: "#ffffff00" }] } }],
    stroke: { paints: [{ color: "#e5e7eb" }], weight: 2, align: "outside", dash: [4, 4] },
    effects: [{ type: "layer-blur", radius: 8 }, { type: "background-blur", radius: 20 }],
  });
  assert.deepEqual(decls, [
    ["background-image", "linear-gradient(90deg, #000000 0%, #ffffff00 100%), linear-gradient(#ffffff, #ffffff)"],
    ["outline-width", "2px"],
    ["outline-style", "dashed"],
    ["outline-color", "#e5e7eb"],
    ["filter", "blur(4px)"],
    ["backdrop-filter", "blur(10px)"],
  ]);
  const bound = R.styleDecls({ fills: [{ color: { value: "#7c3aed80", var: "a", collection: "C", css: "--c-a" }, opacity: 0.5 }] });
  assert.deepEqual(bound, [["background-color", "color-mix(in srgb, var(--c-a, #7c3aed80) 50%, transparent)"]]);
});

test("textDecls: percent line height and letter spacing, case, decoration", () => {
  assert.deepEqual(R.textDecls({ size: 16, lineHeight: "150%", letterSpacing: "-2%", case: "upper", decoration: "strikethrough", italic: true }), [
    ["font-size", "16px"],
    ["font-style", "italic"],
    ["line-height", "1.5"],
    ["letter-spacing", "-0.02em"],
    ["text-transform", "uppercase"],
    ["text-decoration-line", "line-through"],
  ]);
});

test("svgToJsx camel-cases attributes and adds the class", () => {
  const out = R.svgToJsx('<?xml version="1.0"?><svg viewBox="0 0 24 24"><path fill-rule="evenodd" stroke-width="2" data-x="1" xlink:href="#a"/></svg>', "w-6 h-6");
  assert.equal(out, '<svg className="w-6 h-6" viewBox="0 0 24 24"><path fillRule="evenodd" strokeWidth="2" data-x="1" xlinkHref="#a"/></svg>');
});

test("names", () => {
  assert.equal(R.pascal("icon-bell"), "IconBell");
  assert.equal(R.pascal("2 up card"), "C2UpCard");
  assert.equal(R.componentName({ name: "Size=Large", set: "Forms/Text field" }), "TextField");
  assert.equal(R.iconName({ id: "", name: "", type: "ICON", assetHint: "arrow-right.svg" }), "IconArrowRight");
});

test("component docs markdown", () => {
  const md = R.renderComponentDocs(structuredClone(docsPayload));
  assert.match(md, /^# Button\n\nPrimary action\./);
  assert.match(md, /- \*\*Kind:\*\* Component set, 2 variants \(default: Size=Small\)/);
  assert.match(md, /\| Size \| Variant \| Large \| Small, Large \|  \|/);
  assert.match(md, /\| Label \| Text \| "Button" \|/);
  assert.match(md, /\| Size \| Node \|\n\|---\|---\|\n\| Small \| `2:2` \|/);
  assert.match(md, /<Button size="Large" label="Button" showIcon \/>/);
  assert.match(md, /\| brand\/500 \| `--color-brand-500` \| Color \| COLOR \| fills \| 2 \|/);
  assert.match(md, /Used 5 times in the file: Home \(3\), Settings \(2\)\./);
  const bare = R.renderComponentDocs({ id: "3:1", name: "Chip", type: "COMPONENT", properties: [] });
  assert.match(bare, /## Properties\n\nNone\./);
  assert.match(bare, /Not counted \(pass countInstances: true\)\./);
});

/* ── end to end ───────────────────────────────────────────────────────────── */

function fakePlugin() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?fileKey=test&fileName=Test&pluginVersion=codegen`, { origin: "null" });
  ws.requests = [];
  ws.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    if (req.type === "progress") return;
    ws.requests.push(req);
    const reply = (data, error) => ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data, error }));
    switch (req.type) {
      case "codegen_scan":
        return reply(scanPayload());
      case "codegen_run_script":
        if (req.params.code.includes("throw")) return reply({ error: "boom", logs: [{ level: "log", message: "before" }] });
        return reply({ result: { ok: true }, logs: [{ level: "log", message: "hi" }], durationMs: 3, editorType: "figma" });
      case "codegen_component_docs":
        return reply(structuredClone(docsPayload));
      case "codegen_component_docs_write":
        return reply({ frameId: "9:9", name: "Button — Docs", blocks: 12 });
      default:
        return reply({ echoed: req.type });
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const last = (type) => [...plugin.requests].reverse().find((r) => r.type === type);

const rpc = async (tool, params) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOKEN_HEADER]: readToken(PORT) },
    body: JSON.stringify({ tool, params }),
  });
  return { status: res.status, body: await res.json() };
};

async function startServer(env) {
  const proc = spawn(process.execPath, [path.join(dist, "index.js")], {
    cwd,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_ALLOW_SCRIPTS: "", ...env },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("Leader listening"); i++) await sleep(100);
  assert.match(log, /Leader listening/, "server should become leader");
  return proc;
}

async function stopServer(proc) {
  if (!proc) return;
  const exited = new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.once("exit", resolve)));
  proc.stdin.end();
  await sleep(300);
  proc.kill();
  await exited;
}

before(async () => {
  server = await startServer({});
  plugin = await fakePlugin();
});

after(async () => {
  plugin?.close();
  await stopServer(server);
  rmSync(cwd, { recursive: true, force: true });
});

test("get_code_context json: tokens named, assets listed, compact, params forwarded", async () => {
  const { body } = await rpc("get_code_context", { nodeId: "1:1", maxDepth: 4, includeHidden: false });
  const d = body.data;
  assert.deepEqual(last("codegen_scan").params, { nodeId: "1:1", maxDepth: 4, includeHidden: false });
  assert.equal(d.styles.s1.fills[0].color.css, "--color-brand-500");
  assert.equal(d.root.layout.gap.css, "--spacing-md");
  assert.equal(d.textStyles.t1.color.css, "--color-text-primary");
  assert.deepEqual(d.tokens.map((t) => t.css), ["--color-brand-500", "--color-text-primary", "--spacing-md"]);
  assert.deepEqual(d.assets.icons, [{ file: "icon-bell.svg", name: "Icon / Bell", nodeIds: ["1:4"], inlined: false }]);
  assert.deepEqual(d.assets.images, [{ imageRef: "img123", nodeIds: ["1:5"] }]);
  assert.equal(d.assets.components[0].component, "Button");
  assert.ok(d.meta.tokenEstimate > 100 && d.meta.nodeCount === 8);
});

test("get_code_context jsx-tailwind", async () => {
  const { body } = await rpc("get_code_context", { nodeId: "1:1", format: "jsx-tailwind" });
  const code = body.data;
  assert.equal(typeof code, "string");
  assert.doesNotMatch(code, /TOKEN_ESTIMATE/);
  assert.match(code, /A starting point, not finished code/);
  assert.match(code, /--color-brand-500  Color \/ brand\/500 = #7c3aed/);
  assert.match(code, /export_assets \{ nodeIds: \["1:4"\], format: "SVG"/);
  assert.match(code, /export_image_fills/);
  assert.match(code, /export function Card\(\) \{/);
  assert.match(code, /<div className="p-6 flex flex-col gap-\[var\(--spacing-md,16px\)\] items-start relative w-\[360px\] overflow-hidden bg-\[var\(--color-brand-500,#7c3aed\)\] rounded-xl shadow-\[0_4px_12px_0_#0000001a\]">/);
  // A layer named "Header" becomes <header>.
  assert.match(code, /<header className="flex justify-between items-center self-stretch">/);
  assert.match(code, /<p className="whitespace-nowrap font-\['Inter'\] text-xl font-semibold leading-\[28px\] text-\[color:var\(--color-text-primary,#111827\)\]">Weekly report<\/p>/);
  assert.match(code, /\{\/\* icon-bell\.svg: export node 1:4 \*\/\}\n\s+<IconBell className="w-6 shrink-0 h-6" \/>/);
  assert.match(code, /<img src="img123" alt="" className="self-stretch h-40 shrink-0 rounded-lg object-cover" \/>/);
  assert.match(code, /<p className="self-stretch font-\['Inter'\] text-sm font-normal leading-normal text-\[#374151\]">Hello <span className="font-bold">world<\/span><\/p>/);
  assert.match(code, /<Button size="Large" state="Default" label="Save" showIcon icon=\{<Arrow \/>\} \/>/);
  assert.match(code, /<div className="absolute right-2 top-2 w-3 h-3 bg-\[#ef4444\] rounded-full" \/>/);
});

test("get_code_context html-css", async () => {
  const { body } = await rpc("get_code_context", { nodeId: "1:1", format: "html-css" });
  const code = body.data;
  assert.match(code, /^<style>\n\/\*\n \* Generated by get_code_context \(html-css\)/);
  assert.match(code, /:root \{\n  --color-brand-500: #7c3aed;/);
  assert.match(code, /\.s1 \{\n  background-color: var\(--color-brand-500, #7c3aed\);\n  border-radius: 12px;\n  box-shadow: 0 4px 12px 0 #0000001a;\n\}/);
  assert.match(code, /\.card \{\n  display: flex;\n  flex-direction: column;/);
  assert.match(code, /<div class="card s1">/);
  assert.match(code, /<p class="title t1">Weekly report<\/p>/);
  assert.match(code, /<img class="photo s2" src="img123" alt="">/);
  assert.match(code, /<p class="body t2">Hello <span class="t3">world<\/span><\/p>/);
  assert.match(code, /<!-- component Button: Size=Large, State=Default, Label=Save, Show icon=true, Icon=Icon \/ Arrow -->/);
  assert.match(code, /<span class="icon-bell" data-asset="icon-bell.svg" aria-hidden="true"><\/span>/);
});

test("get_code_context rejects an unknown format", async () => {
  const { status } = await rpc("get_code_context", { nodeId: "1:1", format: "swiftui" });
  assert.equal(status, 400);
});

test("generate_component_docs: markdown, file, canvas, json", async () => {
  const { body } = await rpc("generate_component_docs", { nodeId: "2:1", outputPath: "docs/button.md", writeToCanvas: true, countInstances: true });
  assert.deepEqual(last("codegen_component_docs").params, { nodeId: "2:1", countInstances: true });
  assert.match(body.data, /^# Button/);
  assert.match(body.data, /<!-- \{"outputPath":.*"canvas":\{"frameId":"9:9"/);
  const file = readFileSync(path.join(cwd, "docs/button.md"), "utf8");
  assert.match(file, /`--color-brand-500`/);
  assert.doesNotMatch(file, /<!--/);
  assert.match(last("codegen_component_docs_write").params.markdown, /^# Button/);

  const again = await rpc("generate_component_docs", { nodeId: "2:1", outputPath: "docs/button.md" });
  assert.match(again.body.error, /already exists/);
  const outside = await rpc("generate_component_docs", { nodeId: "2:1", outputPath: path.join(os.homedir(), "evil.md") });
  assert.match(outside.body.error, /outside the allowed/);

  const json = await rpc("generate_component_docs", { nodeId: "2:1", format: "json", outputPath: "docs/button.json" });
  assert.equal(json.body.data.variables[0].css, "--color-brand-500");
  assert.ok(existsSync(path.join(cwd, "docs/button.json")));
});

test("run_script is refused without FIGMA_BRIDGE_ALLOW_SCRIPTS, at the tool and at /rpc", async () => {
  const before = plugin.requests.length;
  const tool = await rpc("run_script", { code: "return 1" });
  assert.match(tool.body.error, /FIGMA_BRIDGE_ALLOW_SCRIPTS=1/);
  const direct = await rpc("codegen_run_script", { code: "return 1" });
  assert.equal(direct.status, 400);
  assert.match(direct.body.error, /turned off/);
  assert.equal(plugin.requests.length, before, "nothing reached the plugin");
});

test("run_script runs once FIGMA_BRIDGE_ALLOW_SCRIPTS=1", async () => {
  plugin.close();
  await stopServer(server);
  server = await startServer({ FIGMA_BRIDGE_ALLOW_SCRIPTS: "1" });
  plugin = await fakePlugin();

  const { body } = await rpc("run_script", { code: "console.log('hi'); return { ok: true }", timeoutMs: 2000 });
  assert.deepEqual(body.data.result, { ok: true });
  assert.deepEqual(body.data.logs, [{ level: "log", message: "hi" }]);
  assert.deepEqual(last("codegen_run_script").params, { code: "console.log('hi'); return { ok: true }", timeoutMs: 2000 });

  const failed = await rpc("run_script", { code: "throw new Error('x')" });
  assert.match(failed.body.error, /boom\nConsole output before the failure:\n  \[log\] before/);

  const tooLong = await rpc("run_script", { code: "return 1", timeoutMs: 120000 });
  assert.equal(tooLong.status, 400);
});
