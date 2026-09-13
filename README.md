# Figma Bridge (ours)

A fork of [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge)
(MIT, imported at `ef0cf04`; licence kept in `LICENSE.md`). A Figma plugin plus a
local MCP server, so Claude reads and exports from Figma desktop with no API rate
limit.

## Setup

1. Build: `cd server && bun install && bun run build`, then `cd ../plugin && bun install && bun run build`.
2. Figma desktop → Plugins → Development → **Import plugin from manifest** → `plugin/manifest.json`.
3. Claude Code: `claude mcp add -s user figma-bridge -- node <repo>/server/dist/index.js`, then restart Claude Code.
4. In the Figma file: Plugins → Development → **Figma Bridge (ours)**.

Port **1995** (upstream and figma-mcp-go both use 1994). Override with
`FIGMA_BRIDGE_PORT`, and rebuild the plugin with `VITE_FIGMA_BRIDGE_WS` plus a
matching `allowedDomains` entry.

## What changed from upstream, and why

| Problem | Fix |
|---|---|
| A stuck Figma call (export, node lookup, page load) hung with no error, then a flat 3-minute server timeout named nothing | Every such call has its own timeout in the plugin and fails naming the node and the likely cause |
| Exports hang while Figma's window is minimized or covered | Can't be fixed in code. `health` runs a live test export so this is told apart from a dead plugin, and batch exports stop after two stalls instead of burning a timeout per node |
| Multi-node exports ran all at once (`Promise.all`) | One node at a time, each reported separately |
| Hidden nodes failed with Figma's opaque "no visible layers" | Checked first; the error names the hidden ancestor |
| Long jobs hit the timeout while still working | The timeout is an *idle* timeout, re-armed by `progress` messages from the plugin |
| Two plugin windows on one file evicted each other forever | The server closes the older one with code 4000 and the plugin does not reconnect after it |
| `get_design_context` re-serialized every subtree at every level (quadratic) | Serialized once with a depth limit |
| Reads dropped hidden children and absolute positions | `includeHidden`, `depth`, `absoluteBounds`, auto-layout sizing, instance properties, mixed-text segments |
| `save_screenshots` refused to overwrite and could only write under the server's cwd | `overwrite` flag; extra roots via `FIGMA_BRIDGE_OUTPUT_ROOTS` |

## Added tools

- **`export_assets`** — scan a frame (by type, name, size, `stopAtMatch`) or take explicit ids, and write every visible match to a folder, SVG by default. Identical exports are written once; `manifest.json` records each node's bounds relative to the frame and its file.
- **`scan_nodes`** — flat list of matches in a subtree with bounds, layer path, text and component name.
- **`get_nodes`** — several nodes in one call; failures reported per node.
- **`health`**, **`get_pages`**, **`navigate_to_page`**.

`scripts/rpc.mjs` calls any tool from a terminal through the running server.
