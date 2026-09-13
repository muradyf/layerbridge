/**
 * Every user-facing name in one place. The product name is not decided yet
 * (see RENAME.md): change these, then the files RENAME.md lists that cannot
 * import from here (JSON manifests, skills, workflows).
 *
 * Figma's brand rules: a product name may not contain "Figma" or "Fig";
 * "<Name> for Figma" is allowed.
 */

/** Human-readable product name. */
export const DISPLAY_NAME = "Figma Bridge";

/** npm package name, also the `bin` and the `npx` argument. */
export const PACKAGE_NAME = "figma-bridge-ours";

/**
 * What client configs pass to `npx -y`. `@latest` so npx re-resolves on each
 * start instead of running whatever version it cached first — the server and
 * the Figma plugin copy have to move together (`setup` refreshes the plugin).
 */
export const NPX_SPEC = `${PACKAGE_NAME}@latest`;

/** Key under which MCP clients register the server (`claude mcp add <key>`). */
export const SERVER_KEY = "figma-bridge";

/** The plugin's name as it appears in Figma's Plugins → Development menu. */
export const PLUGIN_MENU_NAME = "Figma Bridge (ours)";

/** Folder name for per-user data (the stable copy of the Figma plugin). */
export const DATA_DIR_NAME = "figma-bridge";

/** PLACEHOLDER — GitHub owner/repo is not confirmed. */
export const REPO_SLUG = "muradyf/REPLACE-ME";
