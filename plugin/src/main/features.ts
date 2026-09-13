/**
 * Components, styles, variables, prototyping, annotations, fonts, pages and
 * editing tools — the surface upstream did not have. Each case reads its
 * inputs from `params` (ids included) so the server forwards them untouched.
 *
 * Kept apart from upstream's code.ts so that file stays easy to merge.
 */
import {
  EXPORT_TIMEOUT_MS,
  ensurePageLoaded,
  exportWithTimeout,
  postProgress,
  resolveNode,
  resolveSceneNode,
  withTimeout,
  yieldToFigma,
} from "./robust";

type Request = { type: string; requestId: string; nodeIds?: string[]; params?: Record<string, unknown> };
type Response = { type: string; requestId: string; data?: unknown; error?: string };

const ok = (request: Request, data: unknown): Response => ({ type: request.type, requestId: request.requestId, data });

/* ── small helpers ────────────────────────────────────────────────────────── */

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const arr = <T = unknown>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v as T[]) : undefined);

const need = <T>(value: T | undefined, name: string): T => {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
};

const hexToRgba = (hex: string): RGBA => {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`Invalid hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
};

const toHex = (c: RGB | RGBA): string => {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  const a = "a" in c && c.a < 1 ? ch(c.a) : "";
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}${a}`;
};

const solidPaint = (hex: string, opacity?: number): SolidPaint => {
  const c = hexToRgba(hex);
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity ?? c.a };
};

const paintToJson = (p: Paint) =>
  p.type === "SOLID"
    ? { type: p.type, color: toHex(p.color), opacity: p.opacity ?? 1 }
    : p.type.startsWith("GRADIENT")
      ? { type: p.type, stops: (p as GradientPaint).gradientStops.map((s) => ({ position: s.position, color: toHex(s.color) })) }
      : { type: p.type };

const requireEditor = (tool: string) => {
  if (figma.editorType === "dev") {
    throw new Error(`${tool} changes the file, and Dev Mode is read-only. Open the plugin in the design editor.`);
  }
};

const parentOf = async (parentId: string | undefined): Promise<BaseNode & ChildrenMixin> => {
  if (!parentId) return figma.currentPage;
  const parent = await resolveNode(parentId);
  if (!("appendChild" in parent)) throw new Error(`Node ${parentId} cannot contain children`);
  if (parent.type === "PAGE") await withTimeout((parent as PageNode).loadAsync(), 30_000, "Loading page");
  return parent as BaseNode & ChildrenMixin;
};

const componentFrom = async (params: Record<string, unknown>): Promise<ComponentNode> => {
  const id = str(params.componentId);
  const key = str(params.componentKey);
  if (id) {
    const node = await resolveNode(id);
    if (node.type !== "COMPONENT") throw new Error(`Node ${id} is a ${node.type}, not a COMPONENT`);
    return node as ComponentNode;
  }
  if (key) return withTimeout(figma.importComponentByKeyAsync(key), 30_000, `Importing library component ${key}`);
  throw new Error("componentId or componentKey is required");
};

const variableById = async (id: string) => {
  const v = await figma.variables.getVariableByIdAsync(id);
  if (!v) throw new Error(`Variable not found: ${id}`);
  return v;
};

const collectionById = async (id: string) => {
  const c = await figma.variables.getVariableCollectionByIdAsync(id);
  if (!c) throw new Error(`Variable collection not found: ${id}`);
  return c;
};

const variableValueToJson = (value: VariableValue): unknown => {
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "VARIABLE_ALIAS") return { alias: value.id };
    if ("r" in value) return toHex(value as RGBA);
  }
  return value;
};

const parseVariableValue = async (variable: Variable, value: unknown): Promise<VariableValue> => {
  if (typeof value === "object" && value !== null && "alias" in value) {
    const target = await variableById(String((value as { alias: string }).alias));
    return figma.variables.createVariableAlias(target);
  }
  switch (variable.resolvedType) {
    case "COLOR":
      if (typeof value !== "string") throw new Error("COLOR variables take a hex string or { alias }");
      return hexToRgba(value);
    case "FLOAT":
      if (typeof value !== "number") throw new Error("FLOAT variables take a number or { alias }");
      return value;
    case "BOOLEAN":
      if (typeof value !== "boolean") throw new Error("BOOLEAN variables take true/false or { alias }");
      return value;
    default:
      return String(value);
  }
};

const walk = async (root: BaseNode, visit: (n: SceneNode) => void | Promise<void>, requestId: string) => {
  let count = 0;
  const go = async (n: BaseNode) => {
    if (n.type !== "DOCUMENT" && n.type !== "PAGE") await visit(n as SceneNode);
    if (++count % 400 === 0) {
      postProgress(requestId, `Visited ${count} layers`);
      await yieldToFigma();
    }
    if ("children" in n) for (const c of (n as ChildrenMixin).children) await go(c);
  };
  await go(root);
  return count;
};

const loadFontsFor = async (node: TextNode) => {
  const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
};

/* ── dispatcher ───────────────────────────────────────────────────────────── */

export const FEATURE_TYPES = new Set([
  "get_local_components", "create_component", "combine_as_variants", "create_instance", "swap_component",
  "detach_instance", "set_instance_properties", "add_component_property",
  "create_paint_style", "create_text_style", "create_effect_style", "create_grid_style", "update_style",
  "delete_style", "apply_style",
  "create_variable_collection", "add_variable_mode", "rename_variable_mode", "create_variable",
  "set_variable_value", "delete_variable", "delete_variable_collection", "bind_variable",
  "get_reactions", "set_reactions", "remove_reactions",
  "get_annotations", "set_annotations",
  "get_fonts", "get_tokens",
  "create_section", "set_constraints", "reorder_nodes", "lock_nodes", "batch_rename_nodes", "find_replace_text",
  "rename_page", "delete_page", "get_viewport", "create_from_svg", "get_image_fills", "save_version", "notify",
  "export_node_pdf", "get_rest_json", "get_selection_colors", "get_dev_resources", "add_dev_resource",
  "delete_dev_resource",
]);

export const handleFeatureRequest = async (request: Request): Promise<Response | null> => {
  if (!FEATURE_TYPES.has(request.type)) return null;
  const p = request.params ?? {};

  switch (request.type) {
    /* ── components ── */
    case "get_local_components": {
      const pageId = str(p.pageId);
      const roots: (PageNode | DocumentNode)[] = [];
      if (pageId) {
        const page = figma.root.children.find((pg) => pg.id === pageId);
        if (!page) throw new Error(`Page not found: ${pageId}`);
        await page.loadAsync();
        roots.push(page);
      } else {
        postProgress(request.requestId, "Loading all pages");
        await withTimeout(figma.loadAllPagesAsync(), 120_000, "Loading all pages");
        roots.push(figma.root);
      }
      const out: unknown[] = [];
      for (const root of roots) {
        const found = root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
        for (const c of found) {
          if (c.type === "COMPONENT" && c.parent?.type === "COMPONENT_SET" && p.includeVariants !== true) continue;
          let page: BaseNode | null = c;
          while (page && page.type !== "PAGE") page = page.parent;
          let definitions: unknown;
          try {
            definitions = c.type === "COMPONENT_SET" || c.parent?.type !== "COMPONENT_SET" ? c.componentPropertyDefinitions : undefined;
          } catch {
            definitions = undefined;
          }
          out.push({
            id: c.id,
            key: c.key,
            name: c.name,
            type: c.type,
            description: c.description,
            page: page?.name,
            variants: c.type === "COMPONENT_SET" ? c.children.length : undefined,
            properties: definitions,
          });
        }
      }
      return ok(request, { count: out.length, components: out });
    }

    case "create_component": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      const component = figma.createComponentFromNode(node);
      if (str(p.name)) component.name = str(p.name)!;
      if (str(p.description)) component.description = str(p.description)!;
      return ok(request, { id: component.id, key: component.key, name: component.name });
    }

    case "combine_as_variants": {
      requireEditor(request.type);
      const ids = need(arr<string>(p.nodeIds), "nodeIds");
      const comps: ComponentNode[] = [];
      for (const id of ids) {
        const n = await resolveNode(id);
        if (n.type !== "COMPONENT") throw new Error(`Node ${id} is a ${n.type}; combine_as_variants needs COMPONENTs`);
        comps.push(n as ComponentNode);
      }
      const parent = await parentOf(str(p.parentId) ?? comps[0].parent?.id);
      const set = figma.combineAsVariants(comps, parent);
      if (str(p.name)) set.name = str(p.name)!;
      return ok(request, { id: set.id, key: set.key, name: set.name, variants: set.children.length });
    }

    case "create_instance": {
      requireEditor(request.type);
      const component = await componentFrom(p);
      const instance = component.createInstance();
      const parent = await parentOf(str(p.parentId));
      parent.appendChild(instance);
      if (num(p.x) !== undefined) instance.x = num(p.x)!;
      if (num(p.y) !== undefined) instance.y = num(p.y)!;
      return ok(request, { id: instance.id, name: instance.name, componentId: component.id });
    }

    case "swap_component": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (node.type !== "INSTANCE") throw new Error(`Node ${node.id} is a ${node.type}, not an INSTANCE`);
      const component = await componentFrom(p);
      node.swapComponent(component);
      return ok(request, { id: node.id, componentId: component.id, componentName: component.name });
    }

    case "detach_instance": {
      requireEditor(request.type);
      const results: unknown[] = [];
      for (const id of need(arr<string>(p.nodeIds), "nodeIds")) {
        try {
          const node = await resolveSceneNode(id);
          if (node.type !== "INSTANCE") throw new Error(`is a ${node.type}, not an INSTANCE`);
          const frame = node.detachInstance();
          results.push({ nodeId: id, frameId: frame.id });
        } catch (err) {
          results.push({ nodeId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok(request, { results });
    }

    case "set_instance_properties": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (node.type !== "INSTANCE") throw new Error(`Node ${node.id} is a ${node.type}, not an INSTANCE`);
      const props = need(p.properties as Record<string, string | boolean> | undefined, "properties");
      // Accept plain names ("Label") as well as Figma's suffixed keys ("Label#12:0").
      const keys = Object.keys(node.componentProperties);
      const resolved: Record<string, string | boolean> = {};
      for (const [k, v] of Object.entries(props)) {
        const match = keys.find((key) => key === k || key.split("#")[0] === k);
        if (!match) throw new Error(`Instance has no property "${k}". Available: ${keys.join(", ")}`);
        resolved[match] = v;
      }
      node.setProperties(resolved);
      return ok(request, { id: node.id, componentProperties: node.componentProperties });
    }

    case "add_component_property": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
        throw new Error(`Node ${node.id} is a ${node.type}; properties live on a COMPONENT or COMPONENT_SET`);
      }
      const type = need(str(p.propertyType), "propertyType") as ComponentPropertyType;
      const key = node.addComponentProperty(need(str(p.name), "name"), type, p.defaultValue as string | boolean);
      return ok(request, { id: node.id, propertyKey: key });
    }

    /* ── styles ── */
    case "create_paint_style": {
      requireEditor(request.type);
      const style = figma.createPaintStyle();
      style.name = need(str(p.name), "name");
      const paints = arr<{ hex: string; opacity?: number }>(p.paints);
      style.paints = paints ? paints.map((x) => solidPaint(x.hex, x.opacity)) : [solidPaint(need(str(p.hex), "hex"), num(p.opacity))];
      if (str(p.description)) style.description = str(p.description)!;
      return ok(request, { id: style.id, key: style.key, name: style.name });
    }

    case "create_text_style": {
      requireEditor(request.type);
      const family = need(str(p.fontFamily), "fontFamily");
      const fontStyle = str(p.fontStyle) ?? "Regular";
      await figma.loadFontAsync({ family, style: fontStyle });
      const style = figma.createTextStyle();
      style.name = need(str(p.name), "name");
      style.fontName = { family, style: fontStyle };
      style.fontSize = need(num(p.fontSize), "fontSize");
      if (num(p.lineHeight) !== undefined) style.lineHeight = { value: num(p.lineHeight)!, unit: "PIXELS" };
      if (num(p.letterSpacing) !== undefined) style.letterSpacing = { value: num(p.letterSpacing)!, unit: "PIXELS" };
      if (str(p.description)) style.description = str(p.description)!;
      return ok(request, { id: style.id, key: style.key, name: style.name });
    }

    case "create_effect_style": {
      requireEditor(request.type);
      const style = figma.createEffectStyle();
      style.name = need(str(p.name), "name");
      style.effects = need(arr<Effect>(p.effects), "effects").map((e) => {
        const raw = e as unknown as Record<string, unknown>;
        if (typeof raw.color === "string") {
          return { ...raw, color: hexToRgba(raw.color as string), blendMode: raw.blendMode ?? "NORMAL", visible: raw.visible ?? true } as unknown as Effect;
        }
        return { visible: true, ...raw } as unknown as Effect;
      });
      return ok(request, { id: style.id, key: style.key, name: style.name });
    }

    case "create_grid_style": {
      requireEditor(request.type);
      const style = figma.createGridStyle();
      style.name = need(str(p.name), "name");
      style.layoutGrids = need(arr<LayoutGrid>(p.layoutGrids), "layoutGrids");
      return ok(request, { id: style.id, key: style.key, name: style.name });
    }

    case "update_style": {
      requireEditor(request.type);
      const style = await figma.getStyleByIdAsync(need(str(p.styleId), "styleId"));
      if (!style) throw new Error(`Style not found: ${p.styleId}`);
      if (str(p.name)) style.name = str(p.name)!;
      if (str(p.description) !== undefined) style.description = str(p.description)!;
      if (style.type === "PAINT" && str(p.hex)) (style as PaintStyle).paints = [solidPaint(str(p.hex)!, num(p.opacity))];
      if (style.type === "TEXT") {
        const t = style as TextStyle;
        if (str(p.fontFamily) || str(p.fontStyle)) {
          const font = { family: str(p.fontFamily) ?? t.fontName.family, style: str(p.fontStyle) ?? t.fontName.style };
          await figma.loadFontAsync(font);
          t.fontName = font;
        }
        if (num(p.fontSize) !== undefined) t.fontSize = num(p.fontSize)!;
        if (num(p.lineHeight) !== undefined) t.lineHeight = { value: num(p.lineHeight)!, unit: "PIXELS" };
        if (num(p.letterSpacing) !== undefined) t.letterSpacing = { value: num(p.letterSpacing)!, unit: "PIXELS" };
      }
      if (style.type === "EFFECT" && arr(p.effects)) (style as EffectStyle).effects = arr<Effect>(p.effects)!;
      if (style.type === "GRID" && arr(p.layoutGrids)) (style as GridStyle).layoutGrids = arr<LayoutGrid>(p.layoutGrids)!;
      return ok(request, { id: style.id, name: style.name, type: style.type });
    }

    case "delete_style": {
      requireEditor(request.type);
      if (p.confirm !== true) throw new Error("delete_style removes the style from the file; pass confirm: true");
      const style = await figma.getStyleByIdAsync(need(str(p.styleId), "styleId"));
      if (!style) throw new Error(`Style not found: ${p.styleId}`);
      const name = style.name;
      style.remove();
      return ok(request, { deleted: name });
    }

    case "apply_style": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      const styleId = need(str(p.styleId), "styleId");
      const target = str(p.target) ?? "fill";
      const n = node as SceneNode & Record<string, unknown>;
      const setter = { fill: "setFillStyleIdAsync", stroke: "setStrokeStyleIdAsync", text: "setTextStyleIdAsync", effect: "setEffectStyleIdAsync", grid: "setGridStyleIdAsync" }[target];
      if (!setter || typeof n[setter] !== "function") throw new Error(`Node ${node.id} (${node.type}) cannot take a ${target} style`);
      if (target === "text") await loadFontsFor(node as TextNode);
      await (n[setter] as (id: string) => Promise<void>).call(node, styleId);
      return ok(request, { id: node.id, target, styleId });
    }

    /* ── variables ── */
    case "create_variable_collection": {
      requireEditor(request.type);
      const c = figma.variables.createVariableCollection(need(str(p.name), "name"));
      return ok(request, { id: c.id, name: c.name, modes: c.modes });
    }

    case "add_variable_mode": {
      requireEditor(request.type);
      const c = await collectionById(need(str(p.collectionId), "collectionId"));
      const modeId = c.addMode(need(str(p.name), "name"));
      return ok(request, { collectionId: c.id, modeId, modes: c.modes });
    }

    case "rename_variable_mode": {
      requireEditor(request.type);
      const c = await collectionById(need(str(p.collectionId), "collectionId"));
      c.renameMode(need(str(p.modeId), "modeId"), need(str(p.name), "name"));
      return ok(request, { collectionId: c.id, modes: c.modes });
    }

    case "create_variable": {
      requireEditor(request.type);
      const c = await collectionById(need(str(p.collectionId), "collectionId"));
      const type = need(str(p.variableType), "variableType") as VariableResolvedDataType;
      const v = figma.variables.createVariable(need(str(p.name), "name"), c, type);
      const values = (p.values ?? {}) as Record<string, unknown>;
      for (const [mode, value] of Object.entries(values)) {
        const modeId = c.modes.find((m) => m.modeId === mode || m.name === mode)?.modeId;
        if (!modeId) throw new Error(`Collection has no mode "${mode}"`);
        v.setValueForMode(modeId, await parseVariableValue(v, value));
      }
      return ok(request, { id: v.id, name: v.name, resolvedType: v.resolvedType });
    }

    case "set_variable_value": {
      requireEditor(request.type);
      const v = await variableById(need(str(p.variableId), "variableId"));
      const c = await collectionById(v.variableCollectionId);
      const mode = need(str(p.modeId), "modeId");
      const modeId = c.modes.find((m) => m.modeId === mode || m.name === mode)?.modeId;
      if (!modeId) throw new Error(`Collection has no mode "${mode}"`);
      v.setValueForMode(modeId, await parseVariableValue(v, p.value));
      return ok(request, { id: v.id, modeId, value: variableValueToJson(v.valuesByMode[modeId]) });
    }

    case "delete_variable": {
      requireEditor(request.type);
      if (p.confirm !== true) throw new Error("delete_variable removes the variable and unbinds it everywhere; pass confirm: true");
      const v = await variableById(need(str(p.variableId), "variableId"));
      const name = v.name;
      v.remove();
      return ok(request, { deleted: name });
    }

    case "delete_variable_collection": {
      requireEditor(request.type);
      if (p.confirm !== true) throw new Error("delete_variable_collection removes every variable in it; pass confirm: true");
      const c = await collectionById(need(str(p.collectionId), "collectionId"));
      const name = c.name;
      c.remove();
      return ok(request, { deleted: name });
    }

    case "bind_variable": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      const field = need(str(p.field), "field");
      const variableId = str(p.variableId);
      const variable = variableId ? await variableById(variableId) : null;
      if (field === "fill" || field === "stroke") {
        const key = field === "fill" ? "fills" : "strokes";
        const n = node as SceneNode & { fills?: readonly Paint[]; strokes?: readonly Paint[] };
        const paints = n[key];
        if (!Array.isArray(paints)) throw new Error(`Node ${node.id} has no ${key}`);
        const index = num(p.paintIndex) ?? 0;
        const next = [...paints];
        const base = (next[index] as SolidPaint | undefined) ?? solidPaint("#000000");
        if (base.type !== "SOLID") throw new Error(`Paint ${index} is ${base.type}; only SOLID paints bind to a colour variable`);
        next[index] = variable
          ? figma.variables.setBoundVariableForPaint(base, "color", variable)
          : figma.variables.setBoundVariableForPaint(base, "color", null);
        (n as unknown as Record<string, unknown>)[key] = next;
      } else {
        (node as SceneNode & { setBoundVariable: (f: string, v: Variable | null) => void }).setBoundVariable(field, variable);
      }
      return ok(request, { id: node.id, field, variableId: variable?.id ?? null });
    }

    /* ── prototyping ── */
    case "get_reactions": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (!("reactions" in node)) throw new Error(`Node ${node.id} (${node.type}) has no reactions`);
      return ok(request, { id: node.id, reactions: (node as ReactionMixin).reactions });
    }

    case "set_reactions": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (!("setReactionsAsync" in node)) throw new Error(`Node ${node.id} (${node.type}) cannot take reactions`);
      const incoming = need(arr<Reaction>(p.reactions), "reactions");
      const current = (node as ReactionMixin).reactions;
      const next = str(p.mode) === "append" ? [...current, ...incoming] : incoming;
      await (node as ReactionMixin).setReactionsAsync(next);
      return ok(request, { id: node.id, reactions: (node as ReactionMixin).reactions });
    }

    case "remove_reactions": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (!("setReactionsAsync" in node)) throw new Error(`Node ${node.id} (${node.type}) has no reactions`);
      const index = num(p.index);
      const current = (node as ReactionMixin).reactions;
      await (node as ReactionMixin).setReactionsAsync(index === undefined ? [] : current.filter((_, i) => i !== index));
      return ok(request, { id: node.id, remaining: (node as ReactionMixin).reactions.length });
    }

    /* ── annotations ── */
    case "get_annotations": {
      const root = str(p.nodeId) ? await resolveNode(str(p.nodeId)!) : figma.currentPage;
      await ensurePageLoaded(root);
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      const out: unknown[] = [];
      await walk(root, (n) => {
        const a = (n as SceneNode & { annotations?: readonly Annotation[] }).annotations;
        if (a && a.length) out.push({ id: n.id, name: n.name, annotations: a });
      }, request.requestId);
      return ok(request, {
        categories: categories.map((c) => ({ id: c.id, label: c.label, color: c.color })),
        nodes: out,
      });
    }

    case "set_annotations": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (!("annotations" in node)) throw new Error(`Node ${node.id} (${node.type}) cannot carry annotations`);
      const incoming = need(arr<Annotation>(p.annotations), "annotations");
      const n = node as SceneNode & { annotations: readonly Annotation[] };
      n.annotations = str(p.mode) === "append" ? [...n.annotations, ...incoming] : incoming;
      return ok(request, { id: node.id, annotations: n.annotations });
    }

    /* ── fonts & tokens ── */
    case "get_fonts": {
      const root = str(p.nodeId) ? await resolveNode(str(p.nodeId)!) : figma.currentPage;
      await ensurePageLoaded(root);
      const used = new Map<string, { family: string; style: string; nodes: number }>();
      await walk(root, (n) => {
        if (n.type !== "TEXT") return;
        const fonts = n.characters.length ? n.getRangeAllFontNames(0, n.characters.length) : [n.fontName as FontName];
        for (const f of fonts) {
          const key = `${f.family}::${f.style}`;
          const entry = used.get(key) ?? { family: f.family, style: f.style, nodes: 0 };
          entry.nodes++;
          used.set(key, entry);
        }
      }, request.requestId);
      let available: unknown;
      if (p.includeAvailable === true) {
        const family = str(p.family)?.toLowerCase();
        const list = await figma.listAvailableFontsAsync();
        available = list.filter((f) => !family || f.fontName.family.toLowerCase().includes(family)).map((f) => f.fontName);
      }
      return ok(request, { used: [...used.values()], available });
    }

    case "get_tokens": {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables: unknown[] = [];
      for (const c of collections) {
        for (const id of c.variableIds) {
          const v = await figma.variables.getVariableByIdAsync(id);
          if (!v) continue;
          const values: Record<string, unknown> = {};
          for (const m of c.modes) values[m.name] = variableValueToJson(v.valuesByMode[m.modeId]);
          variables.push({ id: v.id, name: v.name, collection: c.name, type: v.resolvedType, description: v.description, values });
        }
      }
      const [paints, texts, effects] = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.getLocalEffectStylesAsync(),
      ]);
      return ok(request, {
        fileName: figma.root.name,
        collections: collections.map((c) => ({ id: c.id, name: c.name, modes: c.modes.map((m) => m.name) })),
        variables,
        paintStyles: paints.map((s) => ({ id: s.id, name: s.name, paints: s.paints.map(paintToJson) })),
        textStyles: texts.map((s) => ({
          id: s.id, name: s.name, fontFamily: s.fontName.family, fontStyle: s.fontName.style, fontSize: s.fontSize,
          lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, textCase: s.textCase, textDecoration: s.textDecoration,
        })),
        effectStyles: effects.map((s) => ({
          id: s.id, name: s.name,
          effects: s.effects.map((e) => ("color" in e ? { ...e, color: toHex(e.color) } : e)),
        })),
      });
    }

    /* ── editing ── */
    case "create_section": {
      requireEditor(request.type);
      const section = figma.createSection();
      section.name = str(p.name) ?? "Section";
      const ids = arr<string>(p.nodeIds);
      if (ids && ids.length) {
        const nodes = await Promise.all(ids.map((id) => resolveSceneNode(id)));
        const xs = nodes.map((n) => n.absoluteBoundingBox!);
        const pad = num(p.padding) ?? 80;
        const minX = Math.min(...xs.map((b) => b.x)) - pad;
        const minY = Math.min(...xs.map((b) => b.y)) - pad;
        const maxX = Math.max(...xs.map((b) => b.x + b.width)) + pad;
        const maxY = Math.max(...xs.map((b) => b.y + b.height)) + pad;
        section.x = minX;
        section.y = minY;
        section.resizeWithoutConstraints(maxX - minX, maxY - minY);
        for (const n of nodes) {
          const abs = n.absoluteBoundingBox!;
          section.appendChild(n);
          n.x = abs.x - minX;
          n.y = abs.y - minY;
        }
      } else {
        section.x = num(p.x) ?? 0;
        section.y = num(p.y) ?? 0;
        section.resizeWithoutConstraints(num(p.width) ?? 800, num(p.height) ?? 600);
      }
      return ok(request, { id: section.id, name: section.name, width: section.width, height: section.height });
    }

    case "set_constraints": {
      requireEditor(request.type);
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      if (!("constraints" in node)) throw new Error(`Node ${node.id} (${node.type}) has no constraints`);
      const n = node as ConstraintMixin & SceneNode;
      n.constraints = {
        horizontal: (str(p.horizontal) ?? n.constraints.horizontal) as ConstraintType,
        vertical: (str(p.vertical) ?? n.constraints.vertical) as ConstraintType,
      };
      return ok(request, { id: node.id, constraints: n.constraints });
    }

    case "reorder_nodes": {
      requireEditor(request.type);
      const position = need(str(p.position), "position");
      const results: unknown[] = [];
      for (const id of need(arr<string>(p.nodeIds), "nodeIds")) {
        const node = await resolveSceneNode(id);
        const parent = node.parent as (BaseNode & ChildrenMixin) | null;
        if (!parent) throw new Error(`Node ${id} has no parent`);
        const current = parent.children.indexOf(node);
        const last = parent.children.length - 1;
        const target =
          position === "front" ? last
          : position === "back" ? 0
          : position === "forward" ? Math.min(last, current + 1)
          : position === "backward" ? Math.max(0, current - 1)
          : Math.max(0, Math.min(last, need(num(p.index), "index")));
        parent.insertChild(target, node);
        results.push({ nodeId: id, index: parent.children.indexOf(node) });
      }
      return ok(request, { results });
    }

    case "lock_nodes": {
      requireEditor(request.type);
      const locked = p.locked !== false;
      const ids = need(arr<string>(p.nodeIds), "nodeIds");
      for (const id of ids) (await resolveSceneNode(id)).locked = locked;
      return ok(request, { nodeIds: ids, locked });
    }

    case "batch_rename_nodes": {
      requireEditor(request.type);
      const ids = arr<string>(p.nodeIds);
      const rootId = str(p.rootId);
      const targets: SceneNode[] = [];
      if (ids) for (const id of ids) targets.push(await resolveSceneNode(id));
      else if (rootId) {
        const root = await resolveSceneNode(rootId);
        await walk(root, (n) => void (n !== root && targets.push(n)), request.requestId);
      } else throw new Error("nodeIds or rootId is required");
      const find = str(p.find);
      const template = str(p.template);
      const pattern = find ? new RegExp(find, p.caseSensitive === true ? "g" : "gi") : null;
      const renamed: unknown[] = [];
      targets.forEach((n, i) => {
        const before = n.name;
        if (pattern && pattern.test(before)) {
          pattern.lastIndex = 0;
          n.name = before.replace(pattern, str(p.replace) ?? "");
        } else if (template) {
          n.name = template.replace(/\{name\}/g, before).replace(/\{index\}/g, String(i + (num(p.startIndex) ?? 1))).replace(/\{type\}/g, n.type.toLowerCase());
        }
        if (n.name !== before) renamed.push({ id: n.id, from: before, to: n.name });
      });
      return ok(request, { considered: targets.length, renamed: renamed.length, changes: renamed.slice(0, 200) });
    }

    case "find_replace_text": {
      requireEditor(request.type);
      const root = str(p.rootId) ? await resolveNode(str(p.rootId)!) : figma.currentPage;
      await ensurePageLoaded(root);
      const find = need(str(p.find), "find");
      const replace = str(p.replace) ?? "";
      const pattern = p.regex === true ? new RegExp(find, p.caseSensitive === true ? "g" : "gi") : null;
      const changes: unknown[] = [];
      const texts: TextNode[] = [];
      await walk(root, (n) => void (n.type === "TEXT" && texts.push(n)), request.requestId);
      for (const t of texts) {
        const before = t.characters;
        const after = pattern
          ? before.replace(pattern, replace)
          : p.caseSensitive === true
            ? before.split(find).join(replace)
            : before.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), replace);
        if (after === before) continue;
        if (p.dryRun !== true) {
          await loadFontsFor(t);
          t.characters = after;
        }
        changes.push({ id: t.id, from: before.slice(0, 120), to: after.slice(0, 120) });
      }
      return ok(request, { scanned: texts.length, changed: changes.length, dryRun: p.dryRun === true, changes: changes.slice(0, 200) });
    }

    case "rename_page": {
      requireEditor(request.type);
      const page = figma.root.children.find((pg) => pg.id === str(p.pageId));
      if (!page) throw new Error(`Page not found: ${p.pageId}`);
      const from = page.name;
      page.name = need(str(p.name), "name");
      return ok(request, { id: page.id, from, name: page.name });
    }

    case "delete_page": {
      requireEditor(request.type);
      if (p.confirm !== true) throw new Error("delete_page removes the page and everything on it; pass confirm: true");
      const page = figma.root.children.find((pg) => pg.id === str(p.pageId));
      if (!page) throw new Error(`Page not found: ${p.pageId}`);
      if (figma.root.children.length === 1) throw new Error("A file must keep at least one page");
      if (page === figma.currentPage) {
        await figma.setCurrentPageAsync(figma.root.children.find((pg) => pg !== page)!);
      }
      const name = page.name;
      page.remove();
      return ok(request, { deleted: name });
    }

    case "get_viewport":
      return ok(request, { center: figma.viewport.center, zoom: figma.viewport.zoom, bounds: figma.viewport.bounds });

    case "create_from_svg": {
      requireEditor(request.type);
      const node = figma.createNodeFromSvg(need(str(p.svg), "svg"));
      const parent = await parentOf(str(p.parentId));
      parent.appendChild(node);
      if (str(p.name)) node.name = str(p.name)!;
      if (num(p.x) !== undefined) node.x = num(p.x)!;
      if (num(p.y) !== undefined) node.y = num(p.y)!;
      return ok(request, { id: node.id, name: node.name, width: node.width, height: node.height });
    }

    case "get_image_fills": {
      // Raw image bytes behind IMAGE paints in a subtree, one image per hash.
      const root = await resolveNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(root);
      const byHash = new Map<string, { hash: string; nodes: { id: string; name: string }[] }>();
      await walk(root, (n) => {
        const fills = (n as SceneNode & { fills?: readonly Paint[] | symbol }).fills;
        if (!Array.isArray(fills)) return;
        for (const f of fills as readonly Paint[]) {
          if (f.type !== "IMAGE" || !f.imageHash) continue;
          const entry = byHash.get(f.imageHash) ?? { hash: f.imageHash, nodes: [] };
          entry.nodes.push({ id: n.id, name: n.name });
          byHash.set(f.imageHash, entry);
        }
      }, request.requestId);
      const images: unknown[] = [];
      let i = 0;
      for (const entry of byHash.values()) {
        postProgress(request.requestId, `Reading image ${++i}/${byHash.size}`, i, byHash.size);
        const image = figma.getImageByHash(entry.hash);
        if (!image) continue;
        const bytes = await withTimeout(image.getBytesAsync(), EXPORT_TIMEOUT_MS, `Reading image ${entry.hash}`);
        images.push({ ...entry, base64: figma.base64Encode(bytes) });
      }
      return ok(request, { count: images.length, images });
    }

    case "export_node_pdf": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(node);
      const bytes = await exportWithTimeout(node, { format: "PDF" }, num(p.timeoutMs) ?? EXPORT_TIMEOUT_MS);
      return ok(request, { nodeId: node.id, nodeName: node.name, base64: figma.base64Encode(bytes) });
    }

    case "save_version": {
      requireEditor(request.type);
      const result = await figma.saveVersionHistoryAsync(need(str(p.title), "title"), str(p.description));
      return ok(request, { id: result.id, title: str(p.title) });
    }

    case "notify":
      figma.notify(need(str(p.message), "message"), { timeout: num(p.timeoutMs) ?? 4000, error: p.error === true });
      return ok(request, { shown: true });

    case "get_rest_json": {
      // The node in the REST API's file JSON shape, straight from exportAsync —
      // useful when a pipeline already speaks that format.
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(node);
      const json = await withTimeout(node.exportAsync({ format: "JSON_REST_V1" }), EXPORT_TIMEOUT_MS, `Exporting ${node.id} as REST JSON`);
      return ok(request, json);
    }

    case "get_selection_colors": {
      const colors = figma.getSelectionColors();
      if (!colors) return ok(request, { paints: [], styles: [], note: "Nothing selected, or the selection is too large to summarise" });
      return ok(request, {
        paints: colors.paints.map(paintToJson),
        styles: colors.styles.map((s) => ({ id: s.id, name: s.name })),
      });
    }

    case "get_dev_resources": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      const resources = await node.getDevResourcesAsync({ includeChildren: p.includeChildren === true });
      return ok(request, { id: node.id, resources });
    }

    case "add_dev_resource": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await node.addDevResourceAsync(need(str(p.url), "url"), str(p.name));
      return ok(request, { id: node.id, resources: await node.getDevResourcesAsync() });
    }

    case "delete_dev_resource": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await node.deleteDevResourceAsync(need(str(p.url), "url"));
      return ok(request, { id: node.id, resources: await node.getDevResourcesAsync() });
    }

    default:
      return null;
  }
};
