// End-to-end tests for check_accessibility, lint_design_system and
// fix_design_system: the built server (dist/) with a fake plugin over a real socket.
// Run: bun run build && BRIDGE_TEST_PORT=1996 node --test test/quality.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pngjs from "pngjs";
import WebSocket from "ws";

const { PNG } = pngjs;
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const { readToken, TOKEN_HEADER } = await import(pathToFileURL(path.join(dist, "auth.js")).href);
const q = await import(pathToFileURL(path.join(dist, "quality-core.js")).href);

const PORT = Number(process.env.BRIDGE_TEST_PORT ?? 1996);
const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-quality-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let plugin;
const seen = [];

/** 200×100 render of node 6:9 at scale 2: grey with a blue right part, white glyph rows and antialiased edges. */
const renderPng = () => {
  const png = new PNG({ width: 200, height: 100 });
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 200; x++) {
      let c = x >= 132 ? [0x33, 0x99, 0xff] : [0x76, 0x76, 0x76];
      if (x >= 30 && x < 170 && y >= 45 && y <= 50) c = [255, 255, 255];
      else if (x >= 30 && x < 170 && (y === 44 || y === 51)) c = x >= 132 ? [0x99, 0xcc, 0xff] : [0xbb, 0xbb, 0xbb];
      png.data.set([...c, 255], (y * 200 + x) * 4);
    }
  }
  return PNG.sync.write(png).toString("base64");
};

const tokens = {
  collections: [
    { id: "c1", name: "Color", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Light" }] },
    { id: "c2", name: "Space", defaultModeId: "s1", modes: [{ modeId: "s1", name: "Base" }] },
  ],
  variables: [
    { id: "v1", name: "brand/500", collectionId: "c1", resolvedType: "COLOR", scopes: ["ALL_FILLS"], valuesByMode: { m1: "#7c3aed" } },
    { id: "v2", name: "text/primary", collectionId: "c1", resolvedType: "COLOR", scopes: ["TEXT_FILL"], valuesByMode: { m1: "#111111" } },
    { id: "v4", name: "space/16", collectionId: "c2", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { s1: 16 } },
    { id: "v5", name: "radius/8", collectionId: "c2", resolvedType: "FLOAT", scopes: ["CORNER_RADIUS"], valuesByMode: { s1: 8 } },
  ],
  paintStyles: [{ id: "S:1", name: "Surface", paints: [{ type: "SOLID", color: "#ffffff", opacity: 1 }] }],
  textStyles: [{ id: "S:t1", name: "Body/16", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PERCENT", value: 150 }, letterSpacing: { unit: "PIXELS", value: 0 } }],
};

const white = { type: "SOLID", color: "#ffffff", opacity: 1 };
const a11yScan = {
  root: { id: "1:0", name: "Screen" },
  canvas: "#f5f5f5",
  visited: 42,
  truncated: false,
  texts: [
    {
      nodeId: "5:1", name: "Muted", path: "Card", characters: "Muted", opacity: 1,
      groups: [{ characters: "Muted", fills: [{ type: "SOLID", color: "#999999", opacity: 1 }], fontSize: 16, fontWeight: 400 }],
      layers: [{ nodeId: "5:0", name: "Card", fills: [white], opacity: 1 }],
      needsPixelSample: false, modes: {},
    },
    {
      nodeId: "6:1", name: "Hero title", path: "Hero", characters: "Hello", opacity: 1,
      groups: [{ characters: "Hello", fills: [white], fontSize: 14, fontWeight: 400 }],
      layers: [{ nodeId: "6:0", name: "Photo", fills: [{ type: "IMAGE", opacity: 1 }], opacity: 1 }],
      needsPixelSample: true, sampleReason: '"Photo" is not a plain solid fill',
      exportNodeId: "6:9", exportBounds: { x: 0, y: 0, width: 100, height: 50 }, relBounds: { x: 10, y: 10, width: 80, height: 30 },
    },
    {
      nodeId: "5:3", name: "Fine print", characters: "Legal", opacity: 1,
      groups: [{ characters: "Legal", fills: [{ type: "SOLID", color: "#000000", opacity: 1 }], fontSize: 10, fontWeight: 400 }],
      layers: [{ nodeId: "5:0", name: "Card", fills: [white], opacity: 1 }],
      needsPixelSample: false,
    },
  ],
  targets: [
    { nodeId: "7:1", name: "Close", x: 0, y: 0, width: 20, height: 20, via: "component", component: "Icon Button / Small" },
    { nodeId: "7:2", name: "Menu", x: 22, y: 0, width: 20, height: 20, via: "reaction" },
    { nodeId: "7:3", name: "Lonely", x: 300, y: 300, width: 16, height: 16, via: "reaction" },
    { nodeId: "7:4", name: "Big", x: 500, y: 0, width: 48, height: 48, via: "reaction" },
  ],
  tagged: ["8:1", "5:1"],
  tokens,
};

const dsScan = {
  root: { id: "2:0", name: "Settings" },
  visited: 20,
  truncated: false,
  tokens,
  nodes: [
    {
      id: "2:1", name: "Frame 3", type: "FRAME", defaultName: true,
      paints: [{ field: "fills", index: 0, paintCount: 1, color: "#7c3aed", opacity: 1 }],
      spacing: [{ field: "itemSpacing", value: 16, bound: false }, { field: "paddingTop", value: 10, bound: false }],
      radius: [{ field: "cornerRadius", value: 8, bound: false }],
    },
    {
      id: "2:2", name: "Label", type: "TEXT",
      text: { whole: true, segments: [{ start: 0, end: 5, fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PIXELS", value: 24 }, letterSpacing: { unit: "PIXELS", value: 0 } }] },
    },
    { id: "2:3", name: "Old card", type: "FRAME", detached: { type: "local", componentId: "9:9" } },
  ],
};

function fakePlugin() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?fileKey=test&fileName=Test&pluginVersion=quality`, { origin: "null" });
  ws.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    seen.push(req);
    const reply = (data, error) => ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data, error }));
    switch (req.type) {
      case "a11y_scan":
        return reply(a11yScan);
      case "get_screenshot":
        return reply({ exports: [{ nodeId: req.nodeIds[0], nodeName: "Hero", format: "PNG", base64: renderPng(), width: 100, height: 50 }] });
      case "a11y_annotate":
        return reply({ results: [...req.params.items.map((i) => ({ nodeId: i.nodeId, status: "added" })), ...req.params.clear.map((id) => ({ nodeId: id, status: "cleared" }))] });
      case "ds_scan":
        return reply(dsScan);
      case "ds_apply":
        return reply({ applied: req.params.changes.map((c) => ({ nodeId: c.nodeId, kind: c.kind })), skipped: [] });
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

const lastOf = (type) => [...seen].reverse().find((r) => r.type === type);

before(async () => {
  server = spawn(process.execPath, [path.join(dist, "index.js")], {
    cwd,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) },
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

test("check_accessibility computes solid contrast, samples image backgrounds, measures targets", async () => {
  const { status, body } = await rpc("check_accessibility", { nodeId: "1:0", annotate: true, outputDir: "out/a11y" });
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data;
  assert.deepEqual(d.summary, { checked: 10, failures: 4, warnings: 2, score: 55 });
  assert.equal(d.issues[0].severity, "fail");

  const muted = d.issues.find((i) => i.nodeId === "5:1");
  assert.equal(muted.method, "computed");
  assert.equal(muted.ratio, 2.84);
  assert.equal(muted.required, 4.5);
  assert.equal(muted.wcag, "1.4.3");
  assert.equal(muted.foreground, "#999999");
  assert.equal(muted.background, "#ffffff");
  assert.equal(typeof muted.apcaLc, "number");
  assert.equal(muted.suggestion.name, "text/primary");
  assert.equal(muted.suggestion.variableId, "v2");

  const hero = d.issues.find((i) => i.nodeId === "6:1");
  const expected = q.displayRatio(q.contrastRatio(q.parseHex("#ffffff"), q.parseHex("#3399ff")));
  assert.equal(hero.method, "sampled");
  assert.ok(Math.abs(hero.ratio - expected) <= 0.02, `sampled ratio ${hero.ratio} vs ${expected}`);
  assert.equal(hero.background, "#3399ff");
  assert.equal(hero.typicalRatio, 4.54);
  assert.equal(hero.typicalBackground, "#767676");
  assert.equal(hero.renderedFrom, "6:9");
  const shot = lastOf("get_screenshot");
  assert.deepEqual(shot.nodeIds, ["6:9"]);
  assert.equal(shot.params.format, "PNG");
  assert.equal(shot.params.clip, true);
  assert.equal(shot.params.scale, 2); // 14px text renders at 2x

  const small = d.issues.find((i) => i.check === "textSize");
  assert.equal(small.nodeId, "5:3");
  assert.equal(small.severity, "warn");
  assert.equal(d.issues.filter((i) => i.nodeId === "5:3" && i.check === "contrast").length, 0);

  const targets = Object.fromEntries(d.issues.filter((i) => i.check === "targets").map((i) => [i.nodeId, i]));
  assert.equal(targets["7:1"].severity, "fail");
  assert.equal(targets["7:1"].wcag, "2.5.8");
  assert.equal(targets["7:1"].component, "Icon Button / Small");
  assert.equal(targets["7:2"].severity, "fail");
  assert.equal(targets["7:3"].severity, "warn");
  assert.equal(targets["7:3"].spacingException, true);
  assert.equal(targets["7:4"], undefined);

  const annotate = lastOf("a11y_annotate");
  assert.deepEqual(annotate.params.items.map((i) => i.nodeId).sort(), ["5:1", "6:1", "7:1", "7:2"]);
  assert.match(annotate.params.items.find((i) => i.nodeId === "5:1").label, /^Accessibility: Contrast 2\.84:1, needs 4\.5:1 \(WCAG 1\.4\.3\)$/);
  assert.deepEqual(annotate.params.clear, ["8:1"]); // 5:1 still fails, so its note stays
  assert.deepEqual(d.annotations, { added: 4, cleared: 1 });

  const json = JSON.parse(readFileSync(path.join(cwd, "out/a11y/accessibility-1-0.json"), "utf8"));
  assert.equal(json.issues.length, 6);
  const md = readFileSync(path.join(cwd, "out/a11y/accessibility-1-0.md"), "utf8");
  assert.match(md, /Score 55\/100/);
  assert.ok(existsSync(d.files.markdown));
});

test("check_accessibility honours level, minTarget and the check list, and validates input", async () => {
  const before = seen.length;
  const { body } = await rpc("check_accessibility", { nodeId: "1:0", checks: ["targets"], level: "AAA" });
  const d = body.data;
  assert.equal(d.minTarget, 44);
  assert.ok(d.issues.every((i) => i.check === "targets"));
  assert.equal(d.issues.find((i) => i.nodeId === "7:3").severity, "fail"); // 2.5.5 has no spacing exception
  assert.equal(d.issues.find((i) => i.nodeId === "7:1").wcag, "2.5.5");
  assert.equal(d.issues.find((i) => i.nodeId === "7:4"), undefined); // 48px passes 44
  assert.equal(seen.slice(before).filter((r) => r.type === "get_screenshot").length, 0);
  assert.deepEqual(lastOf("a11y_scan").params.checks, ["targets"]);

  const bad = await rpc("check_accessibility", { nodeId: "1:0", level: "A" });
  assert.equal(bad.status, 400);
  const outside = await rpc("check_accessibility", { nodeId: "1:0", checks: ["contrast"], outputDir: path.join(os.homedir(), "evil-report") });
  assert.match(outside.body.error, /outside the allowed/);
});

test("lint_design_system reports rules, suggestions and fixability", async () => {
  const { status, body } = await rpc("lint_design_system", { nodeId: "2:0", spacingScale: [4, 8, 16] });
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data;
  assert.equal(d.summary.layersChecked, 20);
  assert.equal(d.summary.byRule["unbound-color"], 1);
  assert.equal(d.summary.byRule["unbound-spacing"], 2);
  assert.equal(d.summary.byRule["off-scale-spacing"], 1);
  assert.equal(d.summary.byRule["text-without-style"], 1);
  assert.equal(d.summary.byRule["detached-instance"], 1);
  assert.equal(d.summary.byRule["default-name"], 1);
  assert.ok(d.summary.score > 0 && d.summary.score < 100);
  const color = d.issues.find((i) => i.rule === "unbound-color");
  assert.equal(color.suggestion.variableId, "v1");
  assert.equal(color.fixable, true);
  const padding = d.issues.find((i) => i.property === "paddingTop" && i.rule === "unbound-spacing");
  assert.equal(padding.fixable, false);
  assert.equal(d.issues.find((i) => i.rule === "off-scale-spacing").suggestion.nearest, 8);
  assert.equal(d.issues.every((i) => !("fix" in i)), true);
  assert.equal(lastOf("ds_scan").params.nodeId, "2:0");
});

test("fix_design_system plans by default and applies only when asked", async () => {
  const before = seen.length;
  const plan = (await rpc("fix_design_system", { nodeId: "2:0" })).body.data;
  assert.equal(plan.dryRun, true);
  assert.equal(plan.planned, 4); // fill → brand/500, itemSpacing → space/16, radius → radius/8, text → Body/16
  assert.equal(plan.notPlanned, 1); // paddingTop 10 has no variable
  assert.equal(seen.slice(before).filter((r) => r.type === "ds_apply").length, 0);
  assert.deepEqual(lastOf("ds_scan").params.rules, ["unbound-color", "unbound-spacing", "unbound-radius", "text-without-style"]);
  const fill = plan.changes.find((c) => c.kind === "paint-variable");
  assert.equal(fill.to, "brand/500");
  assert.equal(fill.name, "Frame 3");

  const done = (await rpc("fix_design_system", { nodeId: "2:0", dryRun: false, rules: ["unbound-color", "text-without-style"] })).body.data;
  assert.equal(done.dryRun, false);
  assert.equal(done.applied, 2);
  const sent = lastOf("ds_apply").params.changes;
  assert.deepEqual(sent.map((c) => c.kind).sort(), ["paint-variable", "text-style"]);
  assert.deepEqual(sent.find((c) => c.kind === "paint-variable").expected, { color: "#7c3aed", opacity: 1 });

  const refused = await rpc("fix_design_system", { nodeId: "2:0", rules: ["default-name"] });
  assert.equal(refused.status, 400);
});
