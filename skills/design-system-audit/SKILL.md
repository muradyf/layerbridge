---
name: design-system-audit
description: Audit a Figma page or frame for accessibility problems and design-system drift (hard-coded colours, text and spacing instead of styles and variables, detached instances), then fix with a dry run first. Use when the user asks to audit, lint, clean up or check a design.
---

# Design-system and accessibility audit

## 1. Scope

Ask which page or frame if the user did not say. Get its node ID from `get_selection` or a link (`node-id=12-345` → `12:345`). Audit one frame at a time on big files.

## 2. Accessibility

- `check_accessibility` on the node when the server has it.
- Otherwise: `scan_nodes` with `types: ["TEXT"]` on the frame gives each text layer, its font and bounds; `get_nodes` gives fills. Check contrast (4.5:1 body text, 3:1 for text ≥ 18.66px bold / 24px), text smaller than 12px, and interactive elements smaller than 44×44.

## 3. Design-system use

- `lint_design_system` on the node when the server has it.
- Otherwise compare the layers from `get_nodes` with `get_styles` and `get_variable_defs`: fills and strokes with no bound variable or style, text with no text style, one-off spacing and radius values, effects with no effect style. `get_selection_colors` summarises colours in a selection. `scan_nodes` with `types: ["INSTANCE"]` plus `get_local_components` finds instances of missing or detached components.

## 4. Report

Group by severity. For each finding: node ID, layer name, what is wrong, the style or variable it should use. Keep it scannable; offer the full list as a file if it is long.

## 5. Fix — only after the user agrees

- With `fix_design_system`: run it with `dryRun: true`, show the planned changes, apply with `dryRun: false` only after the user confirms.
- Without it: `bind_variable` and `apply_style` per node, after confirmation.
- Needs the design editor (Dev Mode is read-only). Consider `save_version` first.
- After fixing, `get_screenshot` the frame and confirm nothing moved or changed colour unexpectedly.
