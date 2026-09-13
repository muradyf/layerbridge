// Sync module: token parsers, import_tokens / compare_to_image / import_url
// against the built server (dist/) with a fake plugin. Playwright tests run only
// when Playwright can be loaded (installed, or FIGMA_BRIDGE_PLAYWRIGHT set).
// Run: bun run build && BRIDGE_TEST_PORT=1999 node --test test/sync.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pngjs from "pngjs";
import WebSocket from "ws";

const { PNG } = pngjs;
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { readToken, TOKEN_HEADER } = await load("auth.js");
const { parseTokens, parseCssColor } = await load("sync-tokens.js");
const { tokensToJson, tokensToCss } = await load("assets.js");
const { loadChromium } = await load("sync-browser.js");

const PORT = Number(process.env.BRIDGE_TEST_PORT ?? 1999);
const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-sync-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let plugin;
const seen = {};

const playwrightAvailable = await loadChromium().then(() => true, () => false);

/** Solid white W×H with optional coloured rectangles [{x,y,w,h,rgb}]. */
const makePng = (width, height, rects = []) => {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (const { x, y, w, h, rgb } of rects) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const o = (yy * width + xx) * 4;
        png.data[o] = rgb[0];
        png.data[o + 1] = rgb[1];
        png.data[o + 2] = rgb[2];
        png.data[o + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
};

const DESIGN = { width: 80, height: 60 };
const BLUE = [37, 99, 235];

function fakePlugin() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?fileKey=sync&fileName=Sync&pluginVersion=test`, { origin: "null" });
  ws.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    seen[req.type] = req;
    const reply = (data, error) => ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data, error }));
    switch (req.type) {
      case "sync_import_tokens":
        return reply({ dryRun: req.params.dryRun, created: { collections: ["Tokens"], modes: [], variables: [] }, updated: [], unchanged: 0, aliasesSet: 1, missing: [], warnings: ["from plugin"], errors: [] });
      case "get_screenshot": {
        const scale = req.params?.scale ?? 1;
        const bytes = makePng(DESIGN.width * scale, DESIGN.height * scale);
        return reply({ exports: [{ nodeId: req.nodeIds[0], nodeName: "Card", format: "PNG", base64: bytes.toString("base64"), width: DESIGN.width, height: DESIGN.height }] });
      }
      case "scan_nodes":
        return reply({
          rootId: "2:1",
          rootName: "Card",
          truncated: false,
          nodes: [
            { id: "2:2", name: "Body", type: "FRAME", depth: 1, relativeToRoot: { x: 0, y: 0, width: 80, height: 60 } },
            { id: "2:3", name: "Title", type: "TEXT", depth: 2, relativeToRoot: { x: 4, y: 4, width: 30, height: 10 } },
            { id: "2:4", name: "Badge", type: "RECTANGLE", depth: 2, relativeToRoot: { x: 40, y: 20, width: 20, height: 20 } },
          ],
        });
      case "import_html_layers":
        return reply({ nodeId: "9:9", layerCount: 1, expectedLayerCount: 1, receivedType: req.params.layers?.type });
      default:
        return reply({ echoed: req.type });
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const rpc = async (tool, params) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOKEN_HEADER]: readToken(PORT) },
    body: JSON.stringify({ tool, params }),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  server = spawn(process.execPath, [path.join(dist, "index.js")], {
    cwd,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_ALLOW_REMOTE_URLS: "" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let log = "";
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("Leader listening"); i++) await sleep(100);
  assert.match(log, /Leader listening/, "server should become leader");
  plugin = await fakePlugin();
});

after(async () => {
  plugin?.close();
  server?.stdin.end();
  await sleep(300);
  server?.kill();
  rmSync(cwd, { recursive: true, force: true });
});

/* ── parsers (pure) ───────────────────────────────────────────────────────── */

const exported = {
  fileName: "T",
  collections: [{ name: "Color", modes: ["Light", "Dark"] }, { name: "Space", modes: ["Base"] }],
  variables: [
    { id: "v1", name: "brand/500", collection: "Color", type: "COLOR", values: { Light: "#7c3aed", Dark: "#a78bfa80" } },
    { id: "v2", name: "text/accent", collection: "Color", type: "COLOR", values: { Light: { alias: "v1" }, Dark: { alias: "v1" } } },
    { id: "v3", name: "gap/md", collection: "Space", type: "FLOAT", values: { Base: 12 } },
    { id: "v4", name: "font", collection: "Space", type: "STRING", values: { Base: "Geist" } },
  ],
  paintStyles: [{ name: "Surface", paints: [{ type: "SOLID", color: "#ffffff" }] }],
  textStyles: [],
  effectStyles: [],
};

test("DTCG from export_tokens parses back to the same collections, modes, values and aliases", () => {
  const { format, tokens, warnings } = parseTokens(JSON.stringify(tokensToJson(exported)));
  assert.equal(format, "dtcg");
  assert.deepEqual(tokens.map((t) => [t.collection, t.name, t.type]), [
    ["Color", "brand/500", "COLOR"], ["Color", "text/accent", "COLOR"], ["Space", "gap/md", "FLOAT"], ["Space", "font", "STRING"],
  ]);
  assert.deepEqual(tokens[0].valuesByMode, { Light: "#7c3aed", Dark: "#a78bfa80" });
  assert.deepEqual(tokens[1].valuesByMode.Dark, { alias: "Color/brand/500" });
  assert.deepEqual(tokens[2].valuesByMode, { ":default": 12 });
  assert.match(warnings.join("\n"), /styles/);
});

test("CSS from export_tokens parses :root and [data-theme] into modes, var() into aliases, and skips --style-*", () => {
  const { tokens, warnings } = parseTokens(tokensToCss(exported));
  const brand = tokens.find((t) => t.name === "color/brand/500");
  assert.deepEqual(brand.valuesByMode, { ":default": "#7c3aed", dark: "#a78bfa80" });
  assert.deepEqual(tokens.find((t) => t.name === "color/text/accent").valuesByMode[":default"], { alias: "color/brand/500" });
  assert.equal(tokens.some((t) => t.name.startsWith("style")), false);
  assert.match(warnings.join("\n"), /--style-/);
  const scoped = parseTokens(tokensToCss(exported), { collection: "Color" }).tokens;
  assert.ok(scoped.some((t) => t.collection === "Color" && t.name === "brand/500"));
});

test("CSS modes: .dark, @media prefers-color-scheme, component rules skipped, units converted", () => {
  const css = `:root { --bg: #fff; --radius: 0.5rem; --dur: .2s; --fg: var(--bg, red); }
    @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: rgb(0 0 0 / 50%); } }
    .high-contrast-theme { --bg: black; }
    .button { --pad: 4px; }
    :root { --shadow: 0 1px 2px red; --mix: color-mix(in srgb, red, blue); }`;
  const { tokens, warnings, notes } = parseTokens(css);
  const bg = tokens.find((t) => t.name === "bg");
  assert.deepEqual(bg.valuesByMode, { ":default": "#ffffff", dark: "#00000080", "high-contrast-theme": "#000000" });
  assert.equal(tokens.find((t) => t.name === "radius").valuesByMode[":default"], 8);
  assert.equal(tokens.find((t) => t.name === "dur").valuesByMode[":default"], 200);
  assert.equal(tokens.find((t) => t.name === "fg").type, "COLOR");
  assert.equal(tokens.some((t) => t.name === "pad"), false);
  assert.match(warnings.join("\n"), /color-mix/);
  assert.match(notes.join("\n"), /16px per rem/);
});

test("Tailwind v4 @theme: only @theme blocks, resets ignored, oklch converted", () => {
  const css = `@import "tailwindcss";
    @theme { --color-*: initial; --color-brand-500: oklch(0.6279 0.2577 29.23); --breakpoint-sm: 40rem; --font-sans: "Geist", sans-serif; }
    @theme inline { --color-sky-500: oklch(0.685 0.169 237.323); }
    :root { --not-theme: #123456; }`;
  const { format, tokens, notes } = parseTokens(css, { format: "tailwind" });
  assert.equal(format, "tailwind");
  assert.deepEqual(tokens.map((t) => t.name), ["color/brand/500", "breakpoint/sm", "font/sans", "color/sky/500"]);
  assert.equal(tokens[0].valuesByMode[":default"], "#ff0000");
  assert.equal(tokens[1].valuesByMode[":default"], 640);
  assert.match(notes.join("\n"), /outside sRGB.*--color-sky-500/);
});

test("colour parsing: hex, rgb, hsl, oklch in and out of gamut", () => {
  assert.equal(parseCssColor("#ABC").hex, "#aabbcc");
  assert.equal(parseCssColor("#aabbccff").hex, "#aabbcc");
  assert.equal(parseCssColor("rgba(0, 0, 0, .1)").hex, "#0000001a");
  assert.equal(parseCssColor("hsl(0 100% 50%)").hex, "#ff0000");
  assert.equal(parseCssColor("oklch(1 0 0)").hex, "#ffffff");
  assert.equal(parseCssColor("oklch(63.7% 0.237 25.331)").hex, "#fb2c36");
  const wide = parseCssColor("oklch(0.7 0.4 150)");
  assert.equal(wide.outOfGamut, true);
  assert.match(wide.hex, /^#[0-9a-f]{6}$/);
  assert.equal(parseCssColor("not-a-colour"), null);
});

test("DTCG: group $type, dimension objects, colour objects, typography skipped", () => {
  const { tokens, warnings } = parseTokens(JSON.stringify({
    space: { $type: "dimension", sm: { $value: "0.25rem" }, md: { $value: { value: 8, unit: "px" } } },
    color: { accent: { $type: "color", $value: { colorSpace: "srgb", components: [1, 0, 0], alpha: 0.5 } }, link: { $value: "{color.accent}" } },
    type: { body: { $type: "typography", $value: { fontSize: "16px" } } },
  }), { collection: "Tokens" });
  assert.deepEqual(tokens.map((t) => [t.collection, t.name, t.valuesByMode[":default"]]), [
    ["Tokens", "space/sm", 4], ["Tokens", "space/md", 8], ["Tokens", "color/accent", "#ff000080"], ["Tokens", "color/link", { alias: "color/accent" }],
  ]);
  assert.equal(tokens[3].type, "COLOR");
  assert.match(warnings.join("\n"), /typography/);
});

/* ── import_tokens through the bridge ─────────────────────────────────────── */

test("import_tokens sends normalised tokens to the plugin as a dry run by default", async () => {
  mkdirSync(path.join(cwd, "tokens"), { recursive: true });
  writeFileSync(path.join(cwd, "tokens/theme.css"), `:root { --brand: #7c3aed; --link: var(--brand); } [data-theme="dark"] { --brand: #a78bfa; }`);
  const { body } = await rpc("import_tokens", { source: "tokens/theme.css", modeMapping: { dark: "Dark" } });
  assert.equal(body.error, undefined, body.error);
  const sent = seen.sync_import_tokens.params;
  assert.equal(sent.dryRun, true);
  assert.deepEqual(sent.modeMapping, { dark: "Dark" });
  assert.deepEqual(sent.tokens[0], { name: "brand", type: "COLOR", valuesByMode: { ":default": "#7c3aed", dark: "#a78bfa" } });
  assert.equal(body.data.format, "css");
  assert.equal(body.data.tokensParsed, 2);
  assert.equal(body.data.aliasesSet, 1);
  assert.deepEqual(body.data.warnings, ["from plugin"]);
});

test("import_tokens: dryRun false passes through, deleteMissing only warns, bad input is refused", async () => {
  const applied = await rpc("import_tokens", { content: '{"a":{"b":{"$value":1}}}', dryRun: false, deleteMissing: true });
  assert.equal(seen.sync_import_tokens.params.dryRun, false);
  assert.match(applied.body.data.warnings.join("\n"), /deleteMissing is not implemented/);
  const both = await rpc("import_tokens", { content: "{}", source: "x.json" });
  assert.match(both.body.error, /exactly one/);
  const outside = await rpc("import_tokens", { source: path.join(os.homedir(), "..", "nope.json") });
  assert.match(outside.body.error, /outside the allowed|not found/);
  const badJson = await rpc("import_tokens", { content: "{ nope", format: "dtcg" });
  assert.match(badJson.body.error, /not valid JSON/);
});

/* ── compare_to_image ─────────────────────────────────────────────────────── */

test("compare_to_image finds the changed rectangle and blames the layer under it", async () => {
  mkdirSync(path.join(cwd, "shots"), { recursive: true });
  writeFileSync(path.join(cwd, "shots/actual.png"), makePng(80, 60, [{ x: 40, y: 20, w: 20, h: 20, rgb: BLUE }]));
  const { body } = await rpc("compare_to_image", { nodeId: "2:1", image: "shots/actual.png", outputDir: "out/compare" });
  assert.equal(body.error, undefined, body.error);
  const d = body.data;
  assert.equal(d.mismatchedPixels, 400);
  assert.equal(d.mismatchPercent, 8.33);
  assert.equal(d.regions.length, 1);
  assert.deepEqual(d.regions[0].box, { x: 40, y: 20, width: 20, height: 20 });
  assert.equal(d.regions[0].percentOfRegion, 100);
  assert.equal(d.regions[0].likelyLayers[0].id, "2:4");
  assert.equal(d.regions[0].likelyLayers[0].name, "Badge");
  assert.equal(seen.get_screenshot.params.clip, true);
  for (const file of Object.values(d.files)) assert.ok(existsSync(file), file);
});

test("compare_to_image: different sizes crop by default and resize on request, in design coordinates", async () => {
  writeFileSync(path.join(cwd, "shots/wide.png"), makePng(100, 60, [{ x: 40, y: 20, w: 20, h: 20, rgb: BLUE }]));
  const cropped = await rpc("compare_to_image", { nodeId: "2:1", image: "shots/wide.png", outputDir: "out/compare" });
  assert.deepEqual([cropped.body.data.compared.width, cropped.body.data.compared.height], [80, 60]);
  assert.match(cropped.body.data.notes.join("\n"), /Sizes differ/);

  writeFileSync(path.join(cwd, "shots/retina.png"), makePng(160, 120, [{ x: 80, y: 40, w: 40, h: 40, rgb: BLUE }]));
  const retina = await rpc("compare_to_image", { nodeId: "2:1", image: "shots/retina.png", scale: 2, outputDir: "out/compare" });
  assert.deepEqual(retina.body.data.regions[0].box, { x: 40, y: 20, width: 20, height: 20 });

  const resized = await rpc("compare_to_image", { nodeId: "2:1", image: "shots/retina.png", fit: "resize", outputDir: "out/compare" });
  assert.equal(resized.body.data.compared.resized, true);
  const box = resized.body.data.regions[0].box;
  assert.ok(Math.abs(box.x - 40) <= 1 && Math.abs(box.width - 20) <= 2, JSON.stringify(box));
});

test("compare_to_image refuses remote URLs and needs exactly one of image or url", async () => {
  const none = await rpc("compare_to_image", { nodeId: "2:1" });
  assert.match(none.body.error, /exactly one/);
  const remote = await rpc("compare_to_image", { nodeId: "2:1", url: "https://example.com/" });
  assert.match(remote.body.error, /not on this machine/);
});

/* ── Playwright modes ─────────────────────────────────────────────────────── */

test("url modes explain how to install Playwright when it is missing", { skip: playwrightAvailable && "Playwright is available" }, async () => {
  const compare = await rpc("compare_to_image", { nodeId: "2:1", url: "http://localhost:9/" });
  assert.match(compare.body.error, /npx playwright install chromium/);
  const imported = await rpc("import_url", { url: "http://127.0.0.1:9/" });
  assert.match(imported.body.error, /bun add playwright/);
});

test("import_url refuses remote URLs before starting a browser", async () => {
  const { body } = await rpc("import_url", { url: "https://example.com/" });
  assert.match(body.error, /not on this machine/);
});

const PAGE = `<!doctype html><html><head><style>html,body{margin:0;background:#fff}
  #badge{position:absolute;left:40px;top:20px;width:20px;height:20px;background:rgb(${BLUE.join(",")})}</style></head>
  <body><div id="card" style="width:80px;height:60px;position:relative"><div id="badge"></div><p style="margin:0">Hi</p></div></body></html>`;

const withPageServer = async (fn) => {
  const srv = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE));
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/`);
  } finally {
    srv.close();
  }
};

test("compare_to_image with a local URL screenshots the page at the node's size", { skip: !playwrightAvailable && "Playwright not available", timeout: 90_000 }, async () => {
  await withPageServer(async (url) => {
    const { body } = await rpc("compare_to_image", { nodeId: "2:1", url, outputDir: "out/url" });
    assert.equal(body.error, undefined, body.error);
    assert.deepEqual([body.data.imageSize.width, body.data.imageSize.height], [80, 60]);
    const badge = body.data.regions.find((r) => r.likelyLayers[0]?.id === "2:4");
    assert.ok(badge, JSON.stringify(body.data.regions));
  });
});

test("import_url serialises the page with html-figma and sends it to import_html_layers", { skip: !playwrightAvailable && "Playwright not available", timeout: 90_000 }, async () => {
  await withPageServer(async (url) => {
    const { body } = await rpc("import_url", { url, selector: "#card", viewport: { width: 400, height: 300 }, x: 10 });
    assert.equal(body.error, undefined, body.error);
    const sent = seen.import_html_layers.params;
    assert.equal(sent.x, 10);
    assert.equal(typeof sent.layers.type, "string");
    assert.ok(Array.isArray(sent.layers.children) && sent.layers.children.length >= 1, JSON.stringify(sent.layers).slice(0, 400));
    assert.equal(body.data.receivedType, sent.layers.type);
  });
});
