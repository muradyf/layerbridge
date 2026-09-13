#!/usr/bin/env node
// Call any bridge tool from a terminal, through the running leader's /rpc:
//
//   node scripts/rpc.mjs health
//   node scripts/rpc.mjs scan_nodes '{"rootId":"2971:37675","types":["INSTANCE"],"maxSize":48,"stopAtMatch":true}'
//   node scripts/rpc.mjs export_assets '{"rootId":"2971:37675","types":["INSTANCE"],"maxSize":48,"outputDir":".scratch/icons"}'
//
// ⚠️ Tools that WRITE FILES (export_assets, save_screenshots) run HERE, in this
// process, and only ask the leader for one plugin call at a time. Forwarding the
// whole tool to /rpc made the leader write the files — resolving relative paths
// against ITS working directory, which is whatever project started it. On
// 2026-09-13 that put a portfolio export inside another repo.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: rpc.mjs <tool> [json-params]");
  process.exit(2);
}
const port = process.env.FIGMA_BRIDGE_PORT ?? "1995";
const params = JSON.parse(json);
const { nodeId, nodeIds, fileKey, idleMs, ...rest } = params;

const call = async (body) => {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.error(`No bridge leader on 127.0.0.1:${port} (${err.cause?.code ?? err.message})`);
    process.exit(1);
  });
  return res.json();
};

let out;
const LOCAL_TOOLS = new Set(["export_assets", "save_screenshots"]);
if (LOCAL_TOOLS.has(tool)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { runServerSideTool } = await import(
    pathToFileURL(path.join(here, "..", "server", "dist", "assets.js")).href
  );
  const sender = {
    sendWithParams: async (type, ids, sendParams, idle) => {
      const r = await call({
        tool: type,
        ...(ids && ids.length ? { nodeIds: ids } : {}),
        ...(sendParams ? { params: sendParams } : {}),
        ...(fileKey ? { fileKey } : {}),
        ...(idle ? { idleMs: idle } : {}),
      });
      return { type, requestId: "", data: r.data, error: r.error };
    },
  };
  try {
    out = { data: await runServerSideTool(tool, sender, { ...rest, ...(nodeIds ? { nodeIds } : {}) }) };
  } catch (err) {
    out = { error: err instanceof Error ? err.message : String(err) };
  }
} else {
  out = await call({
    tool,
    params: rest,
    ...(nodeIds ? { nodeIds } : nodeId ? { nodeIds: [nodeId] } : {}),
    ...(fileKey ? { fileKey } : {}),
    ...(idleMs ? { idleMs } : {}),
  });
}

if (out.error) {
  console.error(out.error);
  process.exit(1);
}
console.log(JSON.stringify(out.data, null, 2));
