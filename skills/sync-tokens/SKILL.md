---
name: sync-tokens
description: Move design tokens between Figma and code — export the open file's variables (every mode) and styles as W3C design-token JSON and CSS custom properties, or import tokens from code into Figma variables. Use when the user mentions tokens, variables, theme values or keeping Figma and CSS in sync.
---

# Sync design tokens

## Figma → code

1. `get_variable_defs` to see collections and modes (e.g. Light/Dark) before writing anything.
2. `export_tokens` with:
   - `outputPath`: e.g. `tokens/figma.json`. With `format: "both"` the extension is swapped to write `.json` and `.css` side by side.
   - `format`: `"json"` (W3C design tokens, default), `"css"` (custom properties) or `"both"`.
   - `overwrite: true` only when the user wants the existing file replaced.
   It includes every mode, keeps aliases as references, and adds colour, text and effect styles.
3. The path must be inside the server's working directory or a folder in `FIGMA_BRIDGE_OUTPUT_ROOTS`. If refused, tell the user which folder to add.
4. Diff against the project's current tokens and summarise added / removed / changed values. Do not rewrite the project's own token files without asking.

## Code → Figma

1. Read the project's token file and `get_variable_defs`. Show which collections, modes and variables would be created or changed.
2. After the user confirms:
   - `import_tokens` when the server has it (use its dry run first if offered).
   - Otherwise `create_variable_collection`, `add_variable_mode` / `rename_variable_mode`, `create_variable`, `set_variable_value` (per mode, by mode ID or name).
3. `get_variable_defs` again and report the result.

Importing needs the design editor (Dev Mode is read-only). Deleting variables or collections needs `confirm: true` — ask first.
