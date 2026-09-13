// End-to-end tests against the built server (dist/) with a fake plugin.
// Run: bun run build && node --test test/
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
const { readToken, TOKEN_HEADER } = await import(pathToFileURL(path.join(dist, "auth.js")).href);

const PORT = 1998;
const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
let server;
let plugin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const svg = (body) => Buffer.from(`<svg id="clip${Math.random()}">${body}</svg>`).toString("base64");

/** A plugin stand-in: answers the request types the tests need. */
function fakePlugin(name, origin = "null") {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?fileKey=test&fileName=Test&pluginVersion=${name}`, { origin });
  ws.lastRequest = null;
  ws.on("message", async (raw) => {
    const req = JSON.parse(raw.toString());
    ws.lastRequest = req;
    const reply = (data, error) => ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data, error }));
    switch (req.type) {
      case "health":
        return reply({ probedNodeIds: req.nodeIds ?? null });
      case "scan_nodes":
        return reply({
          rootId: "1:0",
          rootName: "Screen",
          truncated: false,
          nodes: [
            { id: "1:1", name: "Icon / Bell", type: "INSTANCE", relativeToRoot: { x: 10, y: 20, width: 24, height: 24 } },
            { id: "1:2", name: "Icon / Bell", type: "INSTANCE", relativeToRoot: { x: 50, y: 20, width: 24, height: 24 } },
            { id: "1:3", name: "Hidden thing", type: "VECTOR" },
            { id: "1:4", name: "Stall A", type: "VECTOR" },
            { id: "1:5", name: "Stall B", type: "VECTOR" },
            { id: "1:6", name: "After stall", type: "VECTOR" },
          ],
        });
      case "get_screenshot": {
        const id = req.nodeIds[0];
        if (id === "1:3") return reply(undefined, `Node 1:3 "Hidden thing" is hidden (visible: false), so it has nothing to render`);
        if (id === "1:4" || id === "1:5") return reply(undefined, `Exporting ${id} did not finish within 30s.`);
        return reply({ exports: [{ nodeId: id, nodeName: `n${id}`, format: "SVG", base64: svg(id === "1:6" ? "<path d='x'/>" : "<path d='bell'/>"), width: 24, height: 24 }] });
      }
      case "get_tokens":
        return reply({
          fileName: "Test",
          collections: [{ id: "c1", name: "Color", modes: ["Light", "Dark"] }],
          variables: [
            { id: "v1", name: "brand/500", collection: "Color", type: "COLOR", values: { Light: "#7c3aed", Dark: "#a78bfa" } },
            { id: "v2", name: "text/accent", collection: "Color", type: "COLOR", values: { Light: { alias: "v1" }, Dark: { alias: "v1" } } },
          ],
          paintStyles: [{ name: "Surface/Base", paints: [{ type: "SOLID", color: "#ffffff", opacity: 1 }] }],
          textStyles: [],
          effectStyles: [],
        });
      case "slow_with_progress":
        for (let i = 0; i < 4; i++) {
          await sleep(700);
          ws.send(JSON.stringify({ type: "progress", requestId: req.requestId, message: `step ${i}` }));
        }
        return reply({ done: true });
      case "never_answers":
        return;
      default:
        return reply({ echoed: req.type, params: req.params ?? null });
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error("refused"), { status: res.statusCode })));
    ws.on("error", reject);
  });
}

const rpc = async (tool, params, extra = {}, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [TOKEN_HEADER]: readToken(PORT), ...headers },
    body: JSON.stringify({ tool, params, ...extra }),
  });
  return { status: res.status, body: await res.json() };
};

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
  plugin = await fakePlugin("test");
});

after(async () => {
  plugin?.close();
  server?.stdin.end();
  await sleep(300);
  server?.kill();
  rmSync(cwd, { recursive: true, force: true });
});

test("rpc needs the token file's token", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("rpc refuses browser requests and non-JSON bodies", async () => {
  const fromPage = await rpc("list_files", undefined, {}, { Origin: "https://evil.example" });
  assert.equal(fromPage.status, 403);
  const plain = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", [TOKEN_HEADER]: readToken(PORT) },
    body: JSON.stringify({ tool: "list_files" }),
  });
  assert.equal(plain.status, 415);
});

test("a web page cannot pose as the plugin", async () => {
  await assert.rejects(fakePlugin("evil", "https://evil.example"), (err) => err.status === 403);
});

test("health forwards the node to probe", async () => {
  const { body } = await rpc("health", undefined, { nodeIds: ["12:34"] });
  assert.deepEqual(body.data.probedNodeIds, ["12:34"]);
});

test("feature tools keep their ids and are validated", async () => {
  const ok = await rpc("get_reactions", { nodeId: "5:6" });
  assert.equal(ok.body.data.params.nodeId, "5:6");
  const missingConfirm = await rpc("delete_page", { pageId: "0:1" });
  assert.equal(missingConfirm.status, 400);
});

test("a silent plugin fails after the idle timeout", async () => {
  const t0 = Date.now();
  const { body } = await rpc("never_answers", undefined, { idleMs: 1200 });
  assert.match(body.error, /without answering/);
  assert.ok(Date.now() - t0 < 3000);
});

test("progress keeps a long job alive", async () => {
  const { body } = await rpc("slow_with_progress", undefined, { idleMs: 1200 });
  assert.equal(body.data.done, true);
});

test("export_assets dedupes, reports hidden layers, stops after stalls, writes a manifest", async () => {
  const { body } = await rpc("export_assets", { rootId: "1:0", outputDir: "out/icons", overwrite: true });
  const d = body.data;
  assert.equal(d.written, 1);
  assert.equal(d.dedupedIdentical, 1);
  assert.equal(d.failed, 4);
  assert.match(d.stoppedEarly, /did not finish/);
  const manifest = JSON.parse(readFileSync(path.join(cwd, "out/icons/manifest.json"), "utf8"));
  assert.equal(manifest.entries.length, 6);
  assert.equal(manifest.entries[1].sameAs, manifest.entries[0].file);
});

test("save_screenshots leaves existing files alone and stays inside allowed roots", async () => {
  await rpc("save_screenshots", { items: [{ nodeId: "1:1", outputPath: "out/one.svg" }] });
  const again = await rpc("save_screenshots", { items: [{ nodeId: "1:1", outputPath: "out/one.svg" }] });
  assert.match(again.body.data.results[0].error, /already exists/);
  const outside = await rpc("save_screenshots", { items: [{ nodeId: "1:1", outputPath: path.join(os.homedir(), "evil.svg") }] });
  assert.match(outside.body.data.results[0].error, /outside the allowed/);
});

test("export_tokens writes W3C JSON and CSS with aliases", async () => {
  const { body } = await rpc("export_tokens", { outputPath: "out/tokens", format: "both", overwrite: true });
  assert.equal(body.data.written.length, 2);
  const json = JSON.parse(readFileSync(path.join(cwd, "out/tokens.json"), "utf8"));
  assert.equal(json.Color.brand["500"].$value, "#7c3aed");
  assert.equal(json.Color.text.accent.$value, "{Color.brand.500}");
  const css = readFileSync(path.join(cwd, "out/tokens.css"), "utf8");
  assert.match(css, /--color-brand-500: #7c3aed;/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /--color-text-accent: var\(--color-brand-500\);/);
  assert.ok(existsSync(path.join(cwd, "out/tokens.css")));
});

test("a newer plugin window for the same file replaces the older one with code 4000", async () => {
  const closed = new Promise((resolve) => plugin.once("close", (code) => resolve(code)));
  const newer = await fakePlugin("newer");
  assert.equal(await closed, 4000);
  plugin = newer;
});
