# Figma Bridge

> **Name pending.** The project will be renamed before its first public release; commands below use the current `figma-bridge` identifiers.

A Figma plugin and a local MCP server that let AI tools — Claude Code, Cursor, VS Code, anything that speaks the Model Context Protocol — read, edit and export the Figma file you have open. Everything runs on your computer. There are no API rate limits and no Figma account token is needed.

Derived from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) (MIT). See [CHANGELOG.md](CHANGELOG.md) for what changed.

Not affiliated with, endorsed or sponsored by Figma, Inc.

## How it works

```
AI tool ──stdio──▶ MCP server (Node, 127.0.0.1:1995) ◀──WebSocket── Figma plugin ──Plugin API──▶ your open file
```

The plugin can only reach the file it is running in, and only while it is open. The server only listens on your own machine.

## Setup

Requires Node 20+ and [Bun](https://bun.sh) to build, and **Figma desktop** (recommended — see [Limits](#limits)).

1. **Build**
   ```bash
   git clone <repo-url> && cd <repo>
   cd server && bun install && bun run build && cd ..
   cd plugin && bun install && bun run build && cd ..
   ```
2. **Add the plugin to Figma:** Figma desktop → any design file → Plugins → Development → **Import plugin from manifest…** → choose `plugin/manifest.json`. This is a one-time step.
3. **Add the server to your AI tool**
   - Claude Code:
     ```bash
     claude mcp add -s user figma-bridge -- node /absolute/path/to/server/dist/index.js
     ```
   - Cursor, VS Code, Windsurf and others — add to their MCP config:
     ```json
     { "mcpServers": { "figma-bridge": { "command": "node", "args": ["/absolute/path/to/server/dist/index.js"] } } }
     ```
   Restart the AI tool.

## Every session

1. Open the Figma file.
2. Plugins → Development → **Figma Bridge**. The panel shows a green dot when connected.
3. Ask your AI tool to work on the file. Keep the plugin window open; it can be collapsed.

## Tools

About 95 tools, plus 6 optional REST tools.

| Area | Tools |
|---|---|
| Read | `get_document`, `get_pages`, `get_selection`, `get_node`, `get_nodes`, `get_metadata`, `get_design_context`, `scan_nodes`, `get_styles`, `get_variable_defs`, `get_fonts`, `get_viewport`, `get_selection_colors`, `get_rest_json`, `list_files`, `health` |
| Export | `get_screenshot`, `save_screenshots`, `export_assets` (bulk SVG/PNG with dedupe and a manifest), `export_tokens` (W3C JSON / CSS), `export_frames_to_pdf`, `export_image_fills` |
| Create & edit | `create_frame`, `create_text`, `create_shape`, `create_image`, `create_section`, `create_from_svg`, `import_html_layers`, `set_node_properties`, `set_text_content`, `set_text_properties`, `set_solid_fill`, `set_gradient_fill`, `set_stroke_properties`, `set_effects`, `set_auto_layout`, `set_constraints`, `set_node_visibility`, `duplicate_nodes`, `reparent_nodes`, `reorder_nodes`, `group_nodes`, `ungroup_node`, `lock_nodes`, `batch_rename_nodes`, `find_replace_text`, `delete_nodes` |
| Components | `get_local_components`, `create_component`, `combine_as_variants`, `create_instance`, `swap_component`, `detach_instance`, `set_instance_properties`, `add_component_property` |
| Styles | `create_paint_style`, `create_text_style`, `create_effect_style`, `create_grid_style`, `update_style`, `apply_style`, `delete_style` |
| Variables | `create_variable_collection`, `add_variable_mode`, `rename_variable_mode`, `create_variable`, `set_variable_value`, `bind_variable`, `delete_variable`, `delete_variable_collection` |
| Prototype & motion | `get_reactions`, `set_reactions`, `remove_reactions`, `get_motion_styles`, `get_node_motion`, `apply_animation_style`, `remove_animation_style`, `apply_manual_keyframe_track`, `remove_manual_keyframe_track`, `set_timeline_duration` |
| Handoff | `get_annotations`, `set_annotations`, `get_dev_resources`, `add_dev_resource`, `delete_dev_resource` |
| Pages & canvas | `create_page`, `rename_page`, `delete_page`, `navigate_to_page`, `set_selection`, `scroll_and_zoom_into_view`, `save_version`, `notify` |
| REST (optional) | `rest_get_comments`, `rest_post_comment`, `rest_get_versions`, `rest_list_team_projects`, `rest_list_project_files`, `rest_render_nodes` |

Deleting pages, styles or variables requires `confirm: true`.

### Optional REST tools

Comments, reading version history, listing a team's files, and rendering files that aren't open are not possible from a plugin. To enable them, create a personal access token (Figma → Settings → Security) and set `FIGMA_ACCESS_TOKEN` in the server's environment. These calls count against [Figma's REST rate limits](https://developers.figma.com/docs/rest-api/rate-limits/), which are very low for files on the Starter plan and for View/Collab seats.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FIGMA_BRIDGE_PORT` | `1995` | Port, 1995–1999. Pick the same port in the plugin panel. |
| `FIGMA_BRIDGE_OUTPUT_ROOTS` | — | Extra folders tools may write to, separated by `;` on Windows and `:` elsewhere. By default only the server's working directory. |
| `FIGMA_ACCESS_TOKEN` | — | Enables the REST tools. |

Several AI-tool windows can share one Figma connection: the first server becomes the leader and the others forward to it.

## Limits

- **One file at a time per plugin window**, and only while the plugin is open. A plugin cannot see other files, your file list or comments (use the REST tools).
- **Figma desktop is recommended.** In the browser, Chrome asks for permission before a page can reach `localhost` (Local Network Access); allow it, or use desktop.
- **Dev Mode is read-only**, except annotations, dev resources and exports.
- **Library components** can be used once they are in the file; a plugin cannot browse a team library's components.
- **Not in Figma Community.** Figma's review guidelines do not accept plugins that expose an MCP server, so the plugin is installed from its manifest.

## Privacy and security

- Nothing leaves your computer except, when you enable them, REST calls to `api.figma.com` with your own token.
- The server listens on `127.0.0.1` only. Its RPC endpoint needs a token stored in a per-user temp folder, rejects browser requests, and the WebSocket refuses connections from web pages.
- File-writing tools can only write inside the allowed folders.
- The plugin's network access is limited to `ws://localhost:1995`–`1999`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says disconnected | Restart your AI tool so the server starts; check the plugin and server use the same port. |
| Panel says "Taken over" | The same file opened the plugin in another window, which now holds the connection. Close one. |
| An export times out | Run `health`: it exports a small node and tells a stuck export from a closed plugin. The error names the node that stalled. |
| Tools missing after an update | Rebuild both folders, re-run the plugin, restart the AI tool. |

From a terminal, `node scripts/rpc.mjs <tool> '<json>'` calls any tool through the running server.

## Development

```bash
cd server && bun run build && bun run test     # fake plugin over a real socket
cd plugin && bunx tsc --noEmit && bun run build
```

Windows-only diagnostics live in `scripts/windows/`.

## License

MIT — see [LICENSE.md](LICENSE.md). Original work © GETHOPP LTD; changes © Murad Yousuf.
