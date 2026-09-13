// FigJam and Slides tools against the built server (dist/) with a fake plugin
// that echoes what it is sent. Checks registration, validation and forwarding;
// what the tools do inside Figma needs a live FigJam or Slides file.
// Run: bun run build && node --test test/boards.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const { readToken, TOKEN_HEADER } = await import(pathToFileURL(path.join(dist, "auth.js")).href);

const PORT = Number(process.env.BRIDGE_TEST_PORT ?? 1998);
const cwd = mkdtempSync(path.join(os.tmpdir(), "bridge-boards-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let plugin;
let stdoutBuffer = "";
const mcpWaiters = new Map();

const BOARD_TOOLS = [
  "get_board",
  "create_sticky",
  "create_shape_with_text",
  "create_connector",
  "create_table",
  "create_code_block",
  "generate_diagram",
  "get_slides",
  "create_slide",
  "reorder_slides",
  "delete_slide",
  "set_slide_transition",
  "focus_slide",
];

function fakePlugin(editorType) {
  const query = new URLSearchParams({ fileKey: "board", fileName: "Board", pluginVersion: "test", editorType });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${query}`, { origin: "null" });
  ws.on("message", (raw) => {
    const req = JSON.parse(raw.toString());
    ws.send(JSON.stringify({ type: req.type, requestId: req.requestId, data: { echoed: req.type, params: req.params ?? null } }));
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

const mcp = (id, method, params) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5000);
    mcpWaiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

before(async () => {
  server = spawn(process.execPath, [path.join(dist, "index.js")], {
    cwd,
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => {
    stdoutBuffer += d;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line);
        mcpWaiters.get(msg.id)?.(msg);
      } catch {
        // not a JSON-RPC line
      }
    }
  });
  let log = "";
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("Leader listening"); i++) await sleep(100);
  assert.match(log, /Leader listening/, "server should become leader");
  plugin = await fakePlugin("figjam");
});

after(async () => {
  plugin?.close();
  server?.stdin.end();
  await sleep(300);
  server?.kill();
  rmSync(cwd, { recursive: true, force: true });
});

test("board and slide tools are registered with MCP", async () => {
  await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { result } = await mcp(2, "tools/list", {});
  const names = new Set(result.tools.map((t) => t.name));
  for (const tool of BOARD_TOOLS) assert.ok(names.has(tool), `${tool} should be listed`);
  const diagram = result.tools.find((t) => t.name === "generate_diagram");
  assert.deepEqual(diagram.inputSchema.required, ["mermaid"]);
});

test("list_files says which editor the plugin runs in", async () => {
  const { body } = await rpc("list_files");
  assert.equal(body.data[0].editorType, "figjam");
});

test("generate_diagram needs Mermaid source and forwards it with the direction", async () => {
  assert.equal((await rpc("generate_diagram", {})).status, 400);
  assert.equal((await rpc("generate_diagram", { mermaid: "   " })).status, 400);
  assert.equal((await rpc("generate_diagram", { mermaid: "flowchart TD\nA-->B", direction: "UP" })).status, 400);
  const { status, body } = await rpc("generate_diagram", { mermaid: "flowchart TD\nA-->B", direction: "LR", fileKey: "board" });
  assert.equal(status, 200);
  assert.deepEqual(body.data.params, { mermaid: "flowchart TD\nA-->B", direction: "LR" });
});

test("delete_slide needs confirm: true", async () => {
  const missing = await rpc("delete_slide", { slideId: "1:2" });
  assert.equal(missing.status, 400);
  assert.equal((await rpc("delete_slide", { slideId: "1:2", confirm: false })).status, 400);
  const ok = await rpc("delete_slide", { slideId: "1:2", confirm: true });
  assert.deepEqual(ok.body.data.params, { slideId: "1:2", confirm: true });
});

test("reorder_slides takes non-empty rows of node ids", async () => {
  assert.equal((await rpc("reorder_slides", { grid: [] })).status, 400);
  assert.equal((await rpc("reorder_slides", { grid: [[]] })).status, 400);
  assert.equal((await rpc("reorder_slides", { grid: [["slide-one"]] })).status, 400);
  const ok = await rpc("reorder_slides", { grid: [["1:3", "1:2"], ["1:4"]] });
  assert.deepEqual(ok.body.data.params.grid, [["1:3", "1:2"], ["1:4"]]);
});

test("FigJam enums and ids are checked before reaching the plugin", async () => {
  assert.equal((await rpc("create_shape_with_text", { shapeType: "BLOB", text: "x" })).status, 400);
  assert.equal((await rpc("create_connector", { startNodeId: "1:2" })).status, 400);
  assert.equal((await rpc("create_connector", { startNodeId: "1:2", endNodeId: "1:3", lineType: "WAVY" })).status, 400);
  assert.equal((await rpc("create_code_block", { code: "x", language: "COBOL" })).status, 400);
  assert.equal((await rpc("create_sticky", {})).status, 400);
  const shape = await rpc("create_shape_with_text", { shapeType: "DIAMOND", text: "Ok?", fill: "yellow", x: 10 });
  assert.deepEqual(shape.body.data.params, { shapeType: "DIAMOND", text: "Ok?", fill: "yellow", x: 10 });
  const connector = await rpc("create_connector", { startNodeId: "1:2", endNodeId: "1:3", endCap: "TRIANGLE_FILLED", label: "yes" });
  assert.equal(connector.body.data.echoed, "create_connector");
});

test("create_table sizes are whole numbers of at least one", async () => {
  assert.equal((await rpc("create_table", { rows: 0, columns: 2 })).status, 400);
  assert.equal((await rpc("create_table", { rows: 1.5, columns: 2 })).status, 400);
  const ok = await rpc("create_table", { rows: 2, columns: 2, cells: [["a", "b"]] });
  assert.deepEqual(ok.body.data.params.cells, [["a", "b"]]);
});

test("set_slide_transition checks style, curve and trigger", async () => {
  assert.equal((await rpc("set_slide_transition", { slideId: "1:2" })).status, 400);
  assert.equal((await rpc("set_slide_transition", { slideId: "1:2", style: "SPIN" })).status, 400);
  assert.equal((await rpc("set_slide_transition", { slideId: "1:2", style: "DISSOLVE", curve: "WOBBLY" })).status, 400);
  const ok = await rpc("set_slide_transition", { slideId: "1:2", style: "DISSOLVE", duration: 0.4, trigger: "AFTER_DELAY", delay: 2 });
  assert.deepEqual(ok.body.data.params, { slideId: "1:2", style: "DISSOLVE", duration: 0.4, trigger: "AFTER_DELAY", delay: 2 });
});

test("create_slide and get_slides forward their options", async () => {
  assert.equal((await rpc("create_slide", { row: -1 })).status, 400);
  const created = await rpc("create_slide", { row: 1, index: 0, name: "Intro" });
  assert.deepEqual(created.body.data.params, { row: 1, index: 0, name: "Intro" });
  const read = await rpc("get_slides", { textNodesPerSlide: 3 });
  assert.deepEqual(read.body.data.params, { textNodesPerSlide: 3 });
});
