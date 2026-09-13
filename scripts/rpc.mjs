#!/usr/bin/env node
// Call any bridge tool from a terminal, through the running leader's /rpc:
//
//   node scripts/rpc.mjs health
//   node scripts/rpc.mjs scan_nodes '{"rootId":"2971:37675","types":["INSTANCE"],"maxSize":48,"stopAtMatch":true}'
//   node scripts/rpc.mjs export_assets '{"rootId":"2971:37675","types":["INSTANCE"],"maxSize":48,"outputDir":".scratch/icons"}'
//
// Relative output paths resolve against the LEADER's working directory, not this
// shell's. Node-id tools take the ids inside params ("nodeId" / "nodeIds").
const [tool, json = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: rpc.mjs <tool> [json-params]");
  process.exit(2);
}
const port = process.env.FIGMA_BRIDGE_PORT ?? "1995";
const params = JSON.parse(json);
const { nodeId, nodeIds, fileKey, idleMs, ...rest } = params;
const body = {
  tool,
  params: rest,
  ...(nodeIds ? { nodeIds } : nodeId ? { nodeIds: [nodeId] } : {}),
  ...(fileKey ? { fileKey } : {}),
  ...(idleMs ? { idleMs } : {}),
};
if (tool === "health" && nodeId) body.params.nodeId = nodeId;

const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).catch((err) => {
  console.error(`No bridge leader on 127.0.0.1:${port} (${err.cause?.code ?? err.message})`);
  process.exit(1);
});
const out = await res.json();
if (out.error) {
  console.error(out.error);
  process.exit(1);
}
console.log(JSON.stringify(out.data, null, 2));
