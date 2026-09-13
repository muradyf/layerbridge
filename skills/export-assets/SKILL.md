---
name: export-assets
description: Export icons, illustrations, images, screenshots and PDFs from the open Figma file to disk with the Figma bridge tools — bulk SVG/PNG with dedupe and a manifest, original image fills, multi-page PDFs. Use when the user asks to export, download or save assets from Figma.
---

# Export assets from Figma

All export tools write files **inside the MCP server's working directory**, or inside a folder listed in `FIGMA_BRIDGE_OUTPUT_ROOTS` (`;`-separated on Windows, `:` elsewhere). Relative paths resolve against the working directory. If a call fails with "outside the allowed directories", tell the user which folder to add rather than trying another path.

## Which tool

| Need | Tool |
|---|---|
| Every icon in a screen | `export_assets` with `rootId` |
| Specific layers | `export_assets` with `nodeIds` (plus `rootId` for relative positions), or `save_screenshots` |
| A picture to look at, not a file | `get_screenshot` |
| The original uploaded photos | `export_image_fills` |
| Several frames as one PDF | `export_frames_to_pdf` (one page per frame, in the order given) |

## Bulk icons

1. Find them first: `scan_nodes` on the frame with `types: ["INSTANCE"]`, `maxSize: 48` (or the icon size), `stopAtMatch: true` so an icon instance is kept whole rather than split into its vectors.
2. `export_assets` with the same filter plus:
   - `outputDir`: e.g. `src/assets/icons`
   - `format`: `"SVG"` (default) or `"PNG"` with `scale` (default 2)
   - `fileName`: template with `{name} {id} {index} {type} {x} {y}`; default `{name}__{id}`
   - `overwrite: true` only if replacing files is intended
3. It exports each layer as it appears on that screen (overrides included), skips hidden layers, writes identical exports once, and writes `manifest.json` with every node's bounds relative to `rootId` and its file.
4. If exports stall it stops early and names the node — report that node rather than retrying the whole batch.

## Tips

- Node IDs use a colon (`12:345`); a link's `node-id=12-345` is the same node.
- `clip: true` exports a node's logical bounds instead of its render bounds (shadows excluded).
- A hidden node renders nothing; `set_node_visibility` returns previous visibility so you can show it, export, and restore.
- Exports work in Dev Mode.
