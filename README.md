# Layerbridge

A Figma plugin and a local MCP server that let AI tools — Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex, anything that speaks the Model Context Protocol — read, edit, check and export the Figma file you have open. Everything runs on your computer: no API rate limits, no Figma token needed.

- **116 tools** for Figma design files, FigJam boards and Slides decks, plus 6 optional REST tools.
- **Quality checks nobody else ships together:** WCAG contrast (also over images and gradients), target size, design-system lint and one-step fixes that bind raw values to your variables.
- **Design ↔ code:** compact code context (JSON, JSX + Tailwind, HTML + CSS), token export and import, pixel diffs between a design and the page you built, a local page imported as layers.
- **Reliable on big files:** every call has a timeout that names the stuck layer, long jobs report progress, bulk exports dedupe and write a manifest.

Derived from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (MIT). See [CHANGELOG.md](CHANGELOG.md) and [NOTICE.md](NOTICE.md). Not affiliated with, endorsed or sponsored by Figma, Inc.

## How it works

```
AI tool ──stdio──▶ MCP server (Node, 127.0.0.1:1995) ◀──WebSocket── Figma plugin ──Plugin API──▶ your open file
```

The plugin can only reach the file it is running in, and only while it is open. The server only listens on your own machine.

## Install

Requires Node 20+ and **Figma desktop** (recommended — see [Limits](#limits)).

1. **Add the server to your AI tool**
   - **Claude Code (server + skills):** `/plugin marketplace add muradyf/layerbridge`, then `/plugin install layerbridge@layerbridge`
   - **Claude Code (server only):**
     ```bash
     claude mcp add --transport stdio --scope user layerbridge -- npx -y layerbridge@latest
     ```
   - **Claude Desktop:** open the `.mcpb` file from the latest release.
   - **Cursor, VS Code, Windsurf, Codex:** `npx -y layerbridge@latest setup --client <name>` prints the config. Add `--write` to write it for Cursor, Windsurf or Claude Desktop (it shows the diff and keeps a backup).
2. **Add the plugin to Figma (once):** run `npx -y layerbridge@latest setup`. It prints a manifest path. In Figma desktop: Plugins → Development → **Import plugin from manifest…** → that path. For FigJam boards and Slides decks, also import the second manifest it prints (Figma won't let one plugin run in both Dev Mode and FigJam). Re-run `setup` after updating.
3. **Restart the AI tool.**

Something not working? `npx -y layerbridge@latest doctor` checks Node, the port, the access token, connected files and the installed plugin.

### Every session

1. Open the Figma file.
2. Plugins → Development → **Layerbridge**. The panel shows a green dot when connected.
3. Ask your AI tool to work on the file. Keep the plugin window open; it can be collapsed.

The server also offers prompts — `implement-design`, `audit-design`, `build-in-figma`, `sync-tokens`, `troubleshoot` — and the Claude Code plugin adds skills for the same workflows plus asset export.

## Tools

| Area | Tools |
|---|---|
| Read | `get_document`, `get_pages`, `get_selection`, `get_node`, `get_nodes`, `get_metadata`, `get_design_context`, `scan_nodes`, `get_styles`, `get_variable_defs`, `get_fonts`, `get_viewport`, `get_selection_colors`, `get_rest_json`, `list_files`, `health` |
| Code | `get_code_context` (layout tree with deduped styles and tokens as JSON, or starter JSX + Tailwind / HTML + CSS), `generate_component_docs`, `run_script` (off by default) |
| Quality | `check_accessibility`, `lint_design_system`, `fix_design_system` |
| Export | `get_screenshot`, `save_screenshots`, `export_assets` (bulk SVG/PNG with dedupe and a manifest), `export_tokens` (W3C JSON / CSS), `export_frames_to_pdf`, `export_image_fills` |
| Sync | `import_tokens` (DTCG / CSS / Tailwind `@theme` → variables), `compare_to_image` (design vs. built page), `import_url` (local page → layers) |
| Create & edit | `create_frame`, `create_text`, `create_shape`, `create_image`, `create_section`, `create_from_svg`, `import_html_layers`, `set_node_properties`, `set_text_content`, `set_text_properties`, `set_solid_fill`, `set_gradient_fill`, `set_stroke_properties`, `set_effects`, `set_auto_layout`, `set_constraints`, `set_node_visibility`, `duplicate_nodes`, `reparent_nodes`, `reorder_nodes`, `group_nodes`, `ungroup_node`, `lock_nodes`, `batch_rename_nodes`, `find_replace_text`, `delete_nodes` |
| Components | `get_local_components`, `create_component`, `combine_as_variants`, `create_instance`, `swap_component`, `detach_instance`, `set_instance_properties`, `add_component_property` |
| Styles | `create_paint_style`, `create_text_style`, `create_effect_style`, `create_grid_style`, `update_style`, `apply_style`, `delete_style` |
| Variables | `create_variable_collection`, `add_variable_mode`, `rename_variable_mode`, `create_variable`, `set_variable_value`, `bind_variable`, `delete_variable`, `delete_variable_collection` |
| Prototype & motion | `get_reactions`, `set_reactions`, `remove_reactions`, `get_motion_styles`, `get_node_motion`, `apply_animation_style`, `remove_animation_style`, `apply_manual_keyframe_track`, `remove_manual_keyframe_track`, `set_timeline_duration` |
| Handoff | `get_annotations`, `set_annotations`, `get_dev_resources`, `add_dev_resource`, `delete_dev_resource` |
| Pages & canvas | `create_page`, `rename_page`, `delete_page`, `navigate_to_page`, `set_selection`, `scroll_and_zoom_into_view`, `save_version`, `notify` |
| FigJam | `get_board`, `create_sticky`, `create_shape_with_text`, `create_connector`, `create_table`, `create_code_block`, `generate_diagram` (Mermaid flowchart → shapes, connectors, sections) |
| Slides | `get_slides`, `create_slide`, `reorder_slides`, `delete_slide`, `set_slide_transition`, `focus_slide`; edit slide content with the design tools, using the slide id as `parentId` |
| REST (optional) | `rest_get_comments`, `rest_post_comment`, `rest_get_versions`, `rest_list_team_projects`, `rest_list_project_files`, `rest_render_nodes` |

Deleting pages, slides, styles or variables requires `confirm: true`. Bulk changes (`fix_design_system`, `import_tokens`) show what they would do unless you pass `dryRun: false`.

### Quality checks

- **`check_accessibility`** — WCAG 2.2 text contrast (1.4.3 AA / 1.4.6 AAA), target size (2.5.8 at 24px with the spacing exception, 2.5.5 at 44px) and very small text. Contrast is computed from the layers behind each text; over images, gradients, blurs or blend modes the containing layer is rendered and the pixels behind the text are sampled, reporting the worst background. Each failure names the nearest colour variable or style in the file that would pass. `outputDir` writes JSON and Markdown reports; `annotate: true` adds Figma annotations to failing layers (works in Dev Mode) and replaces its own on re-runs. APCA Lc is included for information.
- **`lint_design_system`** — unbound colours, spacing and radii (with the matching variable or style, respecting scopes and modes), text without a style, detached instances, values off your spacing/radius scale, default layer names, hidden and empty layers. Counts per rule and a score.
- **`fix_design_system`** — applies the lint's safe fixes: binds variables that resolve to the same value in the layer's mode (colours within ΔE 2), single-paint styles and exactly matching text styles, and reports what it skipped and why.

### Design ↔ code

- **`get_code_context`** reads a layer once and returns a compact tree: flex/grid layout, deduped style tables, mixed-text segments, instances with variant props, icons collapsed to an asset hint, images as refs. Every variable-bound value carries its variable name and the same CSS custom property `export_tokens` writes. `format: "jsx-tailwind"` or `"html-css"` returns starter code headed by the tokens, components, icons and images it needs.
- **`import_tokens`** brings W3C DTCG JSON, CSS custom properties or Tailwind v4 `@theme` into local variables. `:root` is the default mode; `[data-theme="x"]`, `.dark` and `@media (prefers-color-scheme: dark)` are other modes. It round-trips `export_tokens` output and never deletes.
- **`compare_to_image`** diffs a layer against a screenshot of what you built, writes design, actual and diff images, and lists the areas that differ with the layers under each.
- **`import_url`** turns a page running on your machine into editable layers.
- The URL options of `compare_to_image` and `import_url` need Playwright, which is not installed by default: in `server/` run `bun add playwright` then `npx playwright install chromium`, or point `FIGMA_BRIDGE_PLAYWRIGHT` at an existing install. JPG screenshots need `jpeg-js`.

### Optional REST tools

Comments, reading version history, listing a team's files and rendering files that aren't open are not possible from a plugin. To enable them, create a personal access token (Figma → Settings → Security) and set `FIGMA_ACCESS_TOKEN` in the server's environment. These calls count against [Figma's REST rate limits](https://developers.figma.com/docs/rest-api/rate-limits/), which are very low for files on the Starter plan and for View/Collab seats.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_BRIDGE_PORT` | `1995` | Port, 1995–1999. Pick the same port in the plugin panel. |
| `FIGMA_BRIDGE_OUTPUT_ROOTS` | — | Extra folders tools may write to, separated by `;` on Windows and `:` elsewhere. By default only the server's working directory. The Claude Code plugin sets it to the project folder. |
| `FIGMA_ACCESS_TOKEN` | — | Enables the REST tools. |
| `FIGMA_BRIDGE_ALLOW_SCRIPTS` | — | Set to `1` to enable `run_script`, which runs any JavaScript in the plugin with full access to the open file. Set it on every server process sharing the connection. |
| `FIGMA_BRIDGE_PLAYWRIGHT` | — | Folder of an existing Playwright install for the URL tools. |
| `FIGMA_BRIDGE_ALLOW_REMOTE_URLS` | — | Set to `1` to let the URL tools open non-local URLs. |

Several AI-tool windows can share one Figma connection: the first server becomes the leader and the others forward to it.

## Limits

- **One file at a time per plugin window**, and only while the plugin is open. A plugin cannot see other files, your file list or comments (use the REST tools).
- **Figma desktop is recommended.** In the browser, Chrome asks for permission before a page can reach `localhost` (Local Network Access); allow it, or use desktop.
- **Dev Mode is read-only**, except annotations, dev resources and exports.
- **Library components** can be used once they are in the file; a plugin cannot browse a team library's components.
- **Not in Figma Community.** Figma's review guidelines do not accept plugins that expose an MCP server, so the plugin is installed from its manifest.

## Privacy and security

- Nothing leaves your computer except, when you enable them, REST calls to `api.figma.com` with your own token.
- The server listens on `127.0.0.1` only. Its RPC endpoint needs a token stored in a per-user temp folder and rejects browser requests; the WebSocket refuses connections from web pages.
- File-writing tools can only write inside the allowed folders. `run_script` is off unless you turn it on. The URL tools open only local pages unless you allow others.
- The plugin's network access is limited to `ws://localhost:1995`–`1999`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says disconnected | Run `doctor`. Restart your AI tool so the server starts; check the plugin and server use the same port. |
| Panel says "Taken over" | The same file opened the plugin in another window, which now holds the connection. Close one. |
| An export times out | Run `health`: it exports a small node and tells a stuck export from a closed plugin. The error names the node that stalled. |
| A FigJam or Slides tool is refused | Run the FigJam & Slides plugin (the second manifest) in that file. |
| Tools missing after an update | Re-run `setup`, re-run the plugin, restart the AI tool. |

From a terminal, `node scripts/rpc.mjs <tool> '<json>'` calls any tool through the running server.

## Development

Requires [Bun](https://bun.sh).

```bash
cd plugin && bun install && bunx tsc --noEmit && bun run test && bun run build
cd server && bun install && bun run build && bun run test   # fake plugin over a real socket
node scripts/bundle-plugin.mjs                                # (in server/) copy the built plugin into the npm package
```

To run from a checkout, import `plugin/manifest.json` (and `plugin/manifest.boards.json`) in Figma and point your AI tool at `node <repo>/server/dist/index.js`. Windows-only diagnostics live in `scripts/windows/`.

## License

MIT — see [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md). Original work © GETHOPP LTD; changes © Murad Yousuf.
