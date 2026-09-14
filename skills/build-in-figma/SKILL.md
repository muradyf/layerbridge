---
name: build-in-figma
description: Create or change screens, frames and components in the open Figma file safely with Layerbridge tools — look first, plan, build with auto layout and the file's variables, verify with screenshots, confirm before deleting. Use when the user asks to draw, mock up, lay out or edit something in Figma.
---

# Build in Figma safely

## Before creating anything

1. The plugin must be open in the **design editor**. In Dev Mode every editing tool fails with "Dev Mode is read-only" — ask the user to switch.
2. Look at what exists: `get_pages`, `get_design_context` (or `get_selection` for where the user is), `get_local_components`, `get_styles`, `get_variable_defs`, `get_fonts`.
3. Tell the user the plan in a few lines: where it goes (page / parent frame ID), the layer tree, which components, styles and variables it reuses.

## Build

- **Containers:** `create_frame` (use `parentId` to nest; `create_page` returns an ID usable as a parent), then `set_auto_layout` with direction, gap, padding, alignment and sizing. Prefer auto layout to absolute x/y.
- **Content:** `create_text` (the font must be available — check `get_fonts`), `create_shape`, `create_image` (local file inside the working directory, URL or data URI), `create_from_svg` for vector icons.
- **Reuse:** `create_instance` with `componentId` (local) or `componentKey` (published library component already used in the file); `set_instance_properties` for variants, text and boolean props.
- **Tokens, not raw values:** `bind_variable` for colours, spacing and radii; `apply_style` for text, colour and effect styles.
- **Components:** `create_component` turns a frame into a component; `combine_as_variants` makes a set; `add_component_property` adds props.
- Name every layer (`set_node_properties` or `batch_rename_nodes`).

## Verify as you go

After each section, `get_screenshot` on the top-level frame. Fix overflow, clipped text, wrong sizing modes and missing fonts before continuing. `scroll_and_zoom_into_view` shows the user the result.

## Destructive changes

- `delete_nodes` needs `confirm: true`; so do `delete_page`, `delete_style`, `delete_variable` and `delete_variable_collection`. **Ask the user before any of them**, naming what will be removed.
- Before restructuring existing layers (`reparent_nodes`, `ungroup_node`, `detach_instance`, `find_replace_text`), say what will change. `find_replace_text` has `dryRun` — use it first.
- For a large change, `save_version` with a title first so the user can roll back from version history.
