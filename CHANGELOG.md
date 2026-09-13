# Changelog

Derived from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) at `ef0cf04` (MIT).

## 0.3.0 — unreleased

### Added
- **`check_accessibility`:** WCAG contrast (computed from layers, or sampled from a render over images, gradients, blurs and blends), target size with the 2.5.8 spacing exception, small text; score, variable/style suggestions, JSON and Markdown reports, re-runnable Figma annotations.
- **`lint_design_system`:** unbound colours, spacing and radii with matching variables (scopes and modes respected, CIEDE2000 nearest), unstyled text, detached instances, off-scale values, default names, hidden and empty layers.
- **`fix_design_system`:** dry-run-by-default binding of variables, paint styles and text styles, re-checked per layer and reverted if Figma changes the result.
- **`get_code_context`:** one read of a layer gives a compact layout tree, deduped style tables and variable-bound values named like `export_tokens`' CSS properties, or starter JSX + Tailwind / HTML + CSS listing the tokens, components, icons and images it needs.
- **`generate_component_docs`:** markdown or JSON docs for a component or set (properties, variants, variables, styles, optional instance count), optionally saved to a file or placed on the canvas.
- **`run_script`:** runs JavaScript in the plugin and captures console output. Off unless `FIGMA_BRIDGE_ALLOW_SCRIPTS=1`.
- **`import_tokens`:** DTCG, CSS and Tailwind `@theme` tokens into variables, with modes and aliases; dry run by default; round-trips `export_tokens` output.
- **`compare_to_image`:** pixel diff of a layer against a screenshot or local URL, with mismatch regions mapped to likely layers.
- **`import_url`:** a local page into editable layers via Playwright and html-figma.
- **FigJam:** read a board; create stickies, shapes with text, connectors, tables and code blocks; draw Mermaid flowcharts with automatic layout.
- **Figma Slides:** read the deck, add, reorder and delete slides, set transitions, focus a slide.
- **Second plugin manifest** for FigJam and Slides; tools used in the wrong editor are refused with the editor named. `list_files` reports each file's editor.
- **One-command install:** the npm package carries the Figma plugin; `npx figma-bridge-ours setup` installs a stable copy and prints config for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf and Codex (`--write` for the three with a JSON config file, with diff and backup).
- **`doctor`:** checks Node, the port, the access token, connected files and whether the installed plugin matches the server.
- **MCP prompts:** `implement-design`, `audit-design`, `build-in-figma`, `sync-tokens`, `troubleshoot`.
- **Claude Code plugin marketplace** with six skills: implement designs, build in Figma, design-system audit, token sync, asset export, troubleshooting.
- **MCP Registry `server.json`** and a **Claude Desktop extension (.mcpb)** built by the release workflow.
- `--version` and `--help`.
- **Components:** list local components, create components and variant sets, create/swap/detach instances, set instance and component properties.
- **Styles:** create paint, text, effect and grid styles; update, apply and delete them.
- **Variables:** collections, modes, variables and values; bind variables to fills, strokes and properties; delete (with `confirm`).
- **Prototyping:** read, set and remove reactions.
- **Annotations, dev resources, fonts and tokens:** read/write annotations and dev resources (both work in Dev Mode), list fonts in use, read every variable and style.
- **Editing:** sections, constraints, layer order, locking, batch rename, find and replace text, SVG import, rename/delete pages, viewport.
- **Exports:** `export_tokens` (W3C design-token JSON and CSS custom properties, with aliases and modes), `export_frames_to_pdf` (one merged PDF), `export_image_fills` (original image bytes), `get_rest_json` (the REST API's JSON for a node, without the REST API).
- **Versions:** `save_version` writes a named entry to version history.
- **Optional REST tools** when `FIGMA_ACCESS_TOKEN` is set: comments (read and post), version history, team projects and files, rendering nodes of files that are not open. These count against Figma's REST rate limits.
- **Port picker** in the plugin (1995–1999), remembered per machine.
- **Tests:** a fake plugin over a real socket exercises auth, timeouts, progress, exports, window replacement and every module; pure logic (colour math, Mermaid layout, code rendering, token parsing) has unit tests.
- **CI** on Linux, Windows and macOS.

### Changed
- An empty `FIGMA_BRIDGE_PORT` now means the default port instead of an error.
- Server tools that return text (code, markdown) send it unescaped.
- New tool sets live in their own modules and register in one line.
- Server dependencies: `pngjs` 7.0.0, `pixelmatch` 7.2.0, `html-figma` 0.3.1 (bundled into a browser script).
- The plugin bundles Inter instead of loading Google Fonts, so its only network access is localhost.
- A file keeps one stable key in its own plugin data instead of a new key every session.

### Fixed
- `health` always probed the page's first frame: the probe node was stripped by validation.
- Figma's transient "Unable to establish connection" export error is retried instead of reported.
- Six type errors carried over from upstream.
- `import_html_layers` image fills sent as JSON now render instead of failing silently.

### Security
- `/rpc` requires a per-user token file, a JSON content type and no browser `Origin`, so a web page cannot drive the bridge.
- `/ws` refuses connections from web-page origins, so a page cannot pose as the plugin.
- The port is limited to the range the manifest allows.

## 0.2.0

- Every stuck Figma call has its own timeout and fails naming the node and the likely cause.
- Exports run one node at a time; hidden nodes are detected before exporting.
- Idle timeout re-armed by plugin progress, so long jobs finish.
- A newer plugin window on the same file replaces the older one without a reconnect loop.
- `get_design_context` serializes once with a depth limit instead of quadratically.
- `export_assets`, `scan_nodes`, `get_nodes`, `health`, `get_pages`, `navigate_to_page`.
- Plugin panel in Figma's UI3 style.
