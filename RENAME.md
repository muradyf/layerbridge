# Renamed to Layerbridge

Chosen 2026-09-14, replacing the working identifiers. Search the repo for `figma-bridge`, `Figma Bridge` and `REPLACE-ME` before a release to catch anything added since; none should remain.

**Figma's brand rule:** a product name may not contain "Figma" or "Fig". "Layerbridge — MCP server for Figma" is allowed as a descriptor. The upstream project's own name, `gethopp/figma-mcp-bridge`, stays wherever it is credited.

**Name check (2026-09-14):** `layerbridge` was free on npm, the MCP Registry, Glama, Figma Community and GitHub repo names; `layerbridge.dev` and `layerbridge.app` were unregistered. LayerBridge SRL, a Romanian hosting company, holds `layerbridge.com`; no trademark registration was found. Kept knowingly.

| Where | Was | Now |
|---|---|---|
| `server/src/brand.ts` `DISPLAY_NAME` | `Figma Bridge` | `Layerbridge` |
| `PACKAGE_NAME` (npm, npx, `bin`) | `figma-bridge-ours` | `layerbridge` |
| `SERVER_KEY` (MCP client key, server `name`, Claude Code plugin name) | `figma-bridge` | `layerbridge` |
| `PLUGIN_MENU_NAME` / `plugin/manifest.json` `name` | `Figma Bridge (ours)` | `Layerbridge` |
| `plugin/manifest.boards.json` `name` | `Figma Bridge (ours) — FigJam & Slides` | `Layerbridge — FigJam & Slides` |
| `plugin/manifest.json` `id` | `figma-bridge-ours` | `layerbridge` |
| `plugin/manifest.boards.json` `id` | `figma-bridge-ours-boards` | `layerbridge-boards` |
| `DATA_DIR_NAME` (per-user plugin copy) | `figma-bridge` | `layerbridge` |
| `REPO_SLUG`, every repository URL | `muradyf/REPLACE-ME` | `muradyf/layerbridge` |
| `mcpName` / `server.json` `name` | `io.github.muradyf/REPLACE-ME` | `io.github.muradyf/layerbridge` |
| Claude Code marketplace `name` | `figma-bridge-ours` | `layerbridge` (install: `/plugin install layerbridge@layerbridge`) |
| `server/src/auth.ts` token folder | `figma-bridge-<user>` | `layerbridge-<user>` |
| `.mcpb` file | `figma-bridge-ours-v….mcpb` | `layerbridge-v….mcpb` |

Unchanged on purpose: the `FIGMA_BRIDGE_*` environment variables (configuration names, not the product name) and the plugin's `PLUGIN_VERSION` marker.

## What the rename means for anyone already running it

- **Servers:** the token folder moved, so every running server must restart onto this version together; an old leader and a new follower cannot authenticate to each other.
- **Figma:** the plugin ids changed, so Figma treats both manifests as new development plugins. Import `plugin/manifest.json` and `plugin/manifest.boards.json` again and remove the old "Figma Bridge (ours)" entries.
- **AI tools:** an existing server entry keyed `figma-bridge` keeps working; re-run `npx -y layerbridge@latest setup` to get the new key and plugin folder.
- **npm / MCP Registry:** nothing was published under the old names, so there is nothing to deprecate.
