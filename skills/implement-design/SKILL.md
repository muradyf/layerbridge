---
name: implement-design
description: Turn a Figma frame, component or selection into code that matches it, using the Figma bridge MCP tools to read structure, tokens and assets. Use when the user shares a Figma link or node ID, or says "implement", "build this design", "match the Figma".
---

# Implement a Figma design in code

The bridge reads the file that is **open in Figma with the bridge plugin running**. It cannot open other files or links; if a link points at a different file, ask the user to open it and run the plugin there.

## 1. Find the node

- A link like `figma.com/design/<key>/...?node-id=12-345` means node `12:345`. Node IDs always use a colon; instance children look like `I12:345;67:890`.
- No link? Call `get_selection`.
- Several files connected? `list_files`, then pass `fileKey` on every call.

## 2. Read before writing code

1. `get_code_context` on the node when the server has it — it is built for this.
2. Otherwise `get_design_context` for the tree, then `get_nodes` on the parts you need: absolute bounds, auto-layout sizing, component properties, mixed-text segments. Pass `depth` to keep large frames small.
3. `get_screenshot` with `nodeIds: [id]` so you can see what you are matching. Take it early and compare against it at the end.

## 3. Tokens

- `get_variable_defs` lists collections, modes and values. `get_styles` lists colour/text/effect styles.
- To put them in the repo, `export_tokens` with `outputPath` (e.g. `tokens/figma.json`) and `format: "both"` writes W3C JSON and CSS custom properties.
- Map to the project's existing tokens first. Only add new ones when nothing matches, and say so.

## 4. Assets

- Icons: `export_assets` with `rootId` = the frame, `types: ["INSTANCE"]`, a `maxSize` (e.g. 48), `stopAtMatch: true`, `format: "SVG"`, `outputDir` in the project. It skips hidden layers, writes identical icons once and writes `manifest.json` with each file's position relative to the frame.
- Photos: `export_image_fills` saves the original uploaded images, not a render.
- Writes must land inside the server's working directory or `FIGMA_BRIDGE_OUTPUT_ROOTS`; an "outside the allowed directories" error means the user needs to add that folder.

## 5. Build, then check

- Reuse the project's components where a Figma instance's main component matches one.
- Prefer the design's auto layout (direction, gap, padding, sizing) over absolute positions.
- Compare with the screenshot and list anything you could not match (missing fonts, effects the stack cannot do).

Do not edit the Figma file while implementing.
