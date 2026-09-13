# Changelog

Derived from [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) at `ef0cf04` (MIT).

## 0.3.0 — unreleased

### Added
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
- **Tests:** a fake plugin over a real socket exercises auth, timeouts, progress, exports and window replacement.
- **CI** on Linux, Windows and macOS.

### Changed
- The plugin bundles Inter instead of loading Google Fonts, so its only network access is localhost.
- A file keeps one stable key in its own plugin data instead of a new key every session.

### Fixed
- `health` always probed the page's first frame: the probe node was stripped by validation.
- Figma's transient "Unable to establish connection" export error is retried instead of reported.
- Six type errors carried over from upstream.

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
