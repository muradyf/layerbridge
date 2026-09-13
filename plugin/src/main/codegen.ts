/**
 * Design-to-code context. Internal request types driven by server/src/codegen.ts:
 *
 *   codegen_scan                  one walk of a subtree → compact layout tree,
 *                                 deduped style tables, variable names on values
 *   codegen_run_script            run JavaScript with `figma` in scope
 *   codegen_component_docs        a component's properties, variants, variables,
 *                                 styles and (optionally) instance count
 *   codegen_component_docs_write  put a documentation frame next to it
 */
import { need, num, ok, requireEditor, str, toHex, walk, type Request, type Response } from "./features";
import { ensurePageLoaded, exportWithTimeout, pageOf, postProgress, resolveSceneNode, withTimeout, yieldToFigma } from "./robust";
import {
  StyleTable,
  alignOf,
  assetHint,
  blendOf,
  capScriptResult,
  constraintOf,
  formatLogArgs,
  gradientAngle,
  isVectorType,
  justifyOf,
  layoutModeOf,
  letterSpacingOf,
  lineHeightOf,
  looksLikeIcon,
  markdownBlocks,
  round,
  scriptSource,
  sizingOf,
  utf8Decode,
} from "./codegenPure";

const TYPES = new Set(["codegen_scan", "codegen_run_script", "codegen_component_docs", "codegen_component_docs_write"]);

type Json = Record<string, unknown>;
/** A raw value, or the same value tagged with the variable it is bound to. */
type Val = number | string | { value: number | string; var: string; collection: string } | { value: number | string; varId: string };

const isMixed = (v: unknown): v is symbol => typeof v === "symbol";

/* ── lookups, cached per request ──────────────────────────────────────────── */

class Lookups {
  private vars = new Map<string, Promise<{ name: string; collection: string; type: string } | null>>();
  private collections = new Map<string, Promise<string>>();
  private styles = new Map<string, Promise<{ name: string; type: string } | null>>();

  variable(id: string) {
    let found = this.vars.get(id);
    if (!found) {
      found = (async () => {
        try {
          const v = await withTimeout(figma.variables.getVariableByIdAsync(id), 5_000, `Reading variable ${id}`);
          if (!v) return null;
          let collection = this.collections.get(v.variableCollectionId);
          if (!collection) {
            collection = withTimeout(figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId), 5_000, "Reading collection")
              .then((c) => c?.name ?? "")
              .catch(() => "");
            this.collections.set(v.variableCollectionId, collection);
          }
          return { name: v.name, collection: await collection, type: v.resolvedType };
        } catch {
          return null;
        }
      })();
      this.vars.set(id, found);
    }
    return found;
  }

  async ref(alias: VariableAlias | readonly VariableAlias[] | undefined, value: number | string): Promise<Val> {
    const a = Array.isArray(alias) ? (alias as VariableAlias[])[0] : (alias as VariableAlias | undefined);
    if (!a?.id) return value;
    const v = await this.variable(a.id);
    return v ? { value, var: v.name, collection: v.collection } : { value, varId: a.id };
  }

  style(id: unknown) {
    if (typeof id !== "string" || id === "") return Promise.resolve(null);
    let found = this.styles.get(id);
    if (!found) {
      found = withTimeout(figma.getStyleByIdAsync(id), 5_000, `Reading style ${id}`)
        .then((s) => (s ? { name: s.name, type: s.type } : null))
        .catch(() => null);
      this.styles.set(id, found);
    }
    return found;
  }

  async styleName(id: unknown): Promise<string | undefined> {
    return (await this.style(id))?.name;
  }
}

/* ── paints, strokes, effects ─────────────────────────────────────────────── */

const paintJson = async (p: Paint, look: Lookups): Promise<Json | undefined> => {
  if (p.visible === false) return undefined;
  const opacity = p.opacity ?? 1;
  const blend = blendOf(p.blendMode);
  if (p.type === "SOLID") {
    const color = await look.ref(p.boundVariables?.color, toHex({ ...p.color, a: opacity }));
    return { color, ...(typeof color === "object" && opacity < 1 ? { opacity: round(opacity) } : {}), ...(blend ? { blend } : {}) };
  }
  if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_ANGULAR" || p.type === "GRADIENT_DIAMOND") {
    const stops = await Promise.all(
      p.gradientStops.map(async (s) => ({
        at: round(s.position * 100, 1),
        color: await look.ref(s.boundVariables?.color, toHex({ ...s.color, a: s.color.a * opacity })),
      }))
    );
    const kind = p.type.slice("GRADIENT_".length).toLowerCase();
    return { gradient: { kind, ...(kind === "linear" ? { angle: gradientAngle(p.gradientTransform as never) } : {}), stops }, ...(blend ? { blend } : {}) };
  }
  if (p.type === "IMAGE") {
    return { image: p.imageHash, scale: p.scaleMode.toLowerCase(), ...(opacity < 1 ? { opacity: round(opacity) } : {}) };
  }
  return { unsupported: p.type.toLowerCase() };
};

const paintsJson = async (paints: readonly Paint[] | symbol, look: Lookups): Promise<Json[] | "mixed" | undefined> => {
  if (isMixed(paints)) return "mixed";
  const out = (await Promise.all(paints.map((p) => paintJson(p, look)))).filter((p): p is Json => p !== undefined);
  return out.length ? out : undefined;
};

const effectsJson = async (effects: readonly Effect[], look: Lookups): Promise<Json[] | undefined> => {
  const out: Json[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const b = e.boundVariables ?? {};
      out.push({
        type: e.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow",
        x: await look.ref(b.offsetX, round(e.offset.x)),
        y: await look.ref(b.offsetY, round(e.offset.y)),
        blur: await look.ref(b.radius, round(e.radius)),
        spread: await look.ref(b.spread, round(e.spread ?? 0)),
        color: await look.ref(b.color, toHex(e.color)),
      });
    } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      out.push({ type: e.type === "LAYER_BLUR" ? "layer-blur" : "background-blur", radius: await look.ref(e.boundVariables?.radius, round(e.radius)) });
    }
  }
  return out.length ? out : undefined;
};

/* ── node style (everything but layout and text) ──────────────────────────── */

const styleOf = async (node: SceneNode, look: Lookups): Promise<Json> => {
  const s: Json = {};
  const n = node as SceneNode & Json;
  const bv = ((node as FrameNode).boundVariables ?? {}) as Record<string, VariableAlias | VariableAlias[] | undefined>;

  if (node.type !== "TEXT" && "fills" in node) {
    s.fills = await paintsJson((node as GeometryMixin).fills, look);
    if (s.fills) s.fillStyle = await look.styleName(n.fillStyleId);
  }
  if ("strokes" in node) {
    const strokes = await paintsJson((node as GeometryMixin).strokes, look);
    if (strokes) {
      const stroke: Json = { paints: strokes, align: String(n.strokeAlign ?? "CENTER").toLowerCase() };
      if ("strokeTopWeight" in node) {
        const f = node as FrameNode;
        const sides = [f.strokeTopWeight, f.strokeRightWeight, f.strokeBottomWeight, f.strokeLeftWeight];
        if (sides.some((w) => w !== sides[0])) {
          stroke.weight = [
            await look.ref(bv.strokeTopWeight, round(sides[0])),
            await look.ref(bv.strokeRightWeight, round(sides[1])),
            await look.ref(bv.strokeBottomWeight, round(sides[2])),
            await look.ref(bv.strokeLeftWeight, round(sides[3])),
          ];
        }
      }
      if (!stroke.weight && typeof n.strokeWeight === "number") stroke.weight = await look.ref(bv.strokeWeight, round(n.strokeWeight));
      const dash = n.dashPattern as readonly number[] | undefined;
      if (dash && dash.length) stroke.dash = [...dash];
      stroke.style = await look.styleName(n.strokeStyleId);
      s.stroke = stroke;
    }
  }
  if (node.type === "ELLIPSE") {
    s.radius = "50%";
  } else if ("cornerRadius" in node) {
    const f = node as RectangleNode;
    if ("topLeftRadius" in node && (isMixed(f.cornerRadius) || [f.topRightRadius, f.bottomRightRadius, f.bottomLeftRadius].some((r) => r !== f.topLeftRadius))) {
      s.radius = [
        await look.ref(bv.topLeftRadius, round(f.topLeftRadius)),
        await look.ref(bv.topRightRadius, round(f.topRightRadius)),
        await look.ref(bv.bottomRightRadius, round(f.bottomRightRadius)),
        await look.ref(bv.bottomLeftRadius, round(f.bottomLeftRadius)),
      ];
    } else if (typeof f.cornerRadius === "number" && f.cornerRadius > 0) {
      s.radius = await look.ref(bv.topLeftRadius ?? bv.cornerRadius, round(f.cornerRadius));
    }
  }
  if ("effects" in node) {
    s.effects = await effectsJson((node as BlendMixin).effects, look);
    if (s.effects) s.effectStyle = await look.styleName(n.effectStyleId);
  }
  if ("opacity" in node && typeof n.opacity === "number" && n.opacity < 1) s.opacity = await look.ref(bv.opacity, round(n.opacity));
  if ("blendMode" in node) s.blend = blendOf(n.blendMode as string);
  return s;
};

/* ── text ─────────────────────────────────────────────────────────────────── */

type TextSource = {
  fontName: FontName;
  fontSize: number;
  fontWeight: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  textCase: TextCase;
  textDecoration: TextDecoration;
  fills: readonly Paint[];
  textStyleId?: string;
  fillStyleId?: string;
};

const textStyleOf = async (src: TextSource, bound: Record<string, VariableAlias | undefined>, look: Lookups): Promise<Json> => {
  const color = await paintsJson(src.fills, look);
  const first = Array.isArray(color) ? color[0] : undefined;
  return {
    family: await look.ref(bound.fontFamily, src.fontName.family),
    weight: await look.ref(bound.fontWeight, src.fontWeight),
    fontStyle: src.fontName.style,
    italic: /italic|oblique/i.test(src.fontName.style) || undefined,
    size: await look.ref(bound.fontSize, round(src.fontSize)),
    lineHeight: src.lineHeight.unit === "PIXELS" ? await look.ref(bound.lineHeight, lineHeightOf(src.lineHeight)) : lineHeightOf(src.lineHeight),
    letterSpacing:
      src.letterSpacing.value === 0 ? undefined : src.letterSpacing.unit === "PIXELS" ? await look.ref(bound.letterSpacing, letterSpacingOf(src.letterSpacing)) : letterSpacingOf(src.letterSpacing),
    case: src.textCase === "ORIGINAL" ? undefined : src.textCase.toLowerCase().replace(/_/g, "-"),
    decoration: src.textDecoration === "NONE" ? undefined : src.textDecoration.toLowerCase(),
    color: first?.color ?? (first ? first : undefined),
    colorOpacity: first?.opacity,
    textStyle: await look.styleName(src.textStyleId),
    colorStyle: await look.styleName(src.fillStyleId),
  };
};

const SEGMENT_FIELDS = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textCase", "textDecoration", "fills", "textStyleId", "fillStyleId", "boundVariables"] as const;

const textOf = async (node: TextNode, textStyles: StyleTable, look: Lookups): Promise<Json> => {
  const content = node.characters.length > 5000 ? `${node.characters.slice(0, 5000)}…` : node.characters;
  const align = isMixed(node.textAlignHorizontal) || node.textAlignHorizontal === "LEFT" ? undefined : node.textAlignHorizontal === "JUSTIFIED" ? "justify" : node.textAlignHorizontal.toLowerCase();
  const extra: Json = { align };
  if (node.textTruncation === "ENDING") extra.truncate = node.maxLines ?? 1;

  const mixed = [node.fontName, node.fontSize, node.fontWeight, node.lineHeight, node.letterSpacing, node.textCase, node.textDecoration, node.fills, node.textStyleId, node.fillStyleId].some(isMixed);
  if (!mixed) {
    const nb = (node.boundVariables ?? {}) as Record<string, VariableAlias[] | undefined>;
    const bound = Object.fromEntries(Object.entries(nb).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v as VariableAlias | undefined)]));
    const style = await textStyleOf(node as unknown as TextSource, bound, look);
    return { content, style: textStyles.add({ ...style, ...extra }) };
  }
  const segments = node.getStyledTextSegments([...SEGMENT_FIELDS]);
  let longest = segments[0];
  const out: Json[] = [];
  for (const seg of segments) {
    if (seg.characters.length > longest.characters.length) longest = seg;
    const style = await textStyleOf(seg as unknown as TextSource, (seg.boundVariables ?? {}) as Record<string, VariableAlias | undefined>, look);
    out.push({ content: seg.characters, style: textStyles.add({ ...style, ...extra }) });
  }
  const base = out[segments.indexOf(longest)];
  return { content, style: base?.style, segments: out };
};

/* ── layout ───────────────────────────────────────────────────────────────── */

const track = (t: GridTrackSize) => (t.type === "FIXED" ? `${round(t.value ?? 0)}px` : t.type === "FLEX" ? `${round(t.value ?? 1)}fr` : "auto");

const layoutOf = async (node: SceneNode, parent: SceneNode | null, look: Lookups): Promise<Json> => {
  const L: Json = {};
  const n = node as SceneNode & Json;
  const bv = ((node as FrameNode).boundVariables ?? {}) as Record<string, VariableAlias | undefined>;
  const hasChildren = "children" in node && (node as ChildrenMixin).children.length > 0;

  if ("layoutMode" in node) {
    const f = node as FrameNode;
    const mode = layoutModeOf(f.layoutMode, f.layoutWrap);
    if (mode !== "none" || hasChildren) L.mode = mode;
    if (mode === "row" || mode === "column" || mode === "wrap") {
      if (f.primaryAxisAlignItems !== "SPACE_BETWEEN" && f.itemSpacing) L.gap = await look.ref(bv.itemSpacing, round(f.itemSpacing));
      if (mode === "wrap" && f.counterAxisSpacing) L.rowGap = await look.ref(bv.counterAxisSpacing, round(f.counterAxisSpacing));
      L.justify = justifyOf(f.primaryAxisAlignItems);
      L.align = alignOf(f.counterAxisAlignItems);
    } else if (mode === "grid") {
      if (f.gridColumnGap) L.gap = await look.ref(bv.gridColumnGap, round(f.gridColumnGap));
      if (f.gridRowGap) L.rowGap = await look.ref(bv.gridRowGap, round(f.gridRowGap));
      L.columns = f.gridColumnSizes.map(track);
      L.rows = f.gridRowSizes.map(track);
    }
    if (mode !== "none") {
      const pad = [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft];
      if (pad.some((v) => v > 0)) {
        L.padding = [
          await look.ref(bv.paddingTop, round(pad[0])),
          await look.ref(bv.paddingRight, round(pad[1])),
          await look.ref(bv.paddingBottom, round(pad[2])),
          await look.ref(bv.paddingLeft, round(pad[3])),
        ];
      }
    }
    if (f.clipsContent) L.clip = true;
  } else if (hasChildren) {
    L.mode = "none";
  }

  let w: string | undefined;
  let h: string | undefined;
  try {
    w = sizingOf((node as FrameNode).layoutSizingHorizontal);
    h = sizingOf((node as FrameNode).layoutSizingVertical);
  } catch {
    // not applicable to this node type
  }
  const parentAuto = !!parent && "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (node.type === "TEXT" && !parentAuto) {
    if (node.textAutoResize === "WIDTH_AND_HEIGHT") [w, h] = ["hug", "hug"];
    else if (node.textAutoResize === "HEIGHT") h = "hug";
  }
  L.sizing = { w: w ?? "fixed", h: h ?? "fixed" };
  if (node.type === "TEXT" && node.textAutoResize === "WIDTH_AND_HEIGHT") L.noWrap = true;
  if ("width" in node) {
    L.width = await look.ref(bv.width, round(node.width));
    L.height = await look.ref(bv.height, round(node.height));
  }
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const v = n[key];
    if (typeof v === "number") L[key] = await look.ref(bv[key], round(v));
  }

  if (parent) {
    const absolute = !parentAuto || n.layoutPositioning === "ABSOLUTE";
    if (absolute && "x" in node) {
      const origin = parent.type === "GROUP" || parent.type === "BOOLEAN_OPERATION" ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
      const x = round(node.x - origin.x);
      const y = round(node.y - origin.y);
      const c = "constraints" in node ? (node as FrameNode).constraints : undefined;
      L.position = {
        x,
        y,
        right: round(parent.width - x - node.width),
        bottom: round(parent.height - y - node.height),
        h: constraintOf(c?.horizontal ?? "MIN"),
        v: constraintOf(c?.vertical ?? "MIN"),
      };
    }
    if (parentAuto && (parent as FrameNode).layoutMode === "GRID") {
      try {
        const g = node as FrameNode;
        L.cell = { row: g.gridRowAnchorIndex, column: g.gridColumnAnchorIndex, rowSpan: g.gridRowSpan, columnSpan: g.gridColumnSpan };
      } catch {
        // older files without grid children
      }
    }
  }
  if ("rotation" in node && Math.abs(n.rotation as number) > 0.01) L.rotation = round(n.rotation as number);
  return L;
};

/* ── the walk ─────────────────────────────────────────────────────────────── */

type ScanOptions = { includeHidden: boolean; maxDepth?: number; expandInstances: boolean; inlineSvgMaxBytes: number; maxNodes: number };

type ScanState = {
  look: Lookups;
  styles: StyleTable;
  textStyles: StyleTable;
  nodeCount: number;
  depthTruncated: boolean;
  nodeLimitHit: boolean;
  svgExports: number;
  requestId: string;
};

const MAX_INLINE_SVGS = 60;

const iconProbe = (node: SceneNode) => {
  let vectorOnly = true;
  let hasVector = false;
  let seen = 0;
  const visit = (n: SceneNode) => {
    if (!vectorOnly || n.visible === false) return;
    if (++seen > 200 || n.type === "TEXT") {
      vectorOnly = false;
      return;
    }
    if (isVectorType(n.type) || n.type === "LINE") hasVector = true;
    if ("fills" in n && Array.isArray((n as GeometryMixin).fills) && ((n as GeometryMixin).fills as Paint[]).some((p) => p.type === "IMAGE" && p.visible !== false)) {
      vectorOnly = false;
      return;
    }
    if ("children" in n) for (const c of (n as ChildrenMixin).children) visit(c);
  };
  if ("children" in node) for (const c of (node as ChildrenMixin).children) visit(c);
  return { vectorOnly, hasVectorDescendant: hasVector };
};

const isIcon = (node: SceneNode) => {
  if (isVectorType(node.type)) return true;
  if (!("width" in node) || Math.max(node.width, node.height) > 64 || !("children" in node)) return false;
  return looksLikeIcon({ type: node.type, name: node.name, width: node.width, height: node.height, ...iconProbe(node) });
};

const componentOf = async (inst: InstanceNode) => {
  const main = await withTimeout(inst.getMainComponentAsync(), 5_000, "Reading main component").catch(() => null);
  const set = main?.parent?.type === "COMPONENT_SET" ? (main.parent as ComponentSetNode) : null;
  const out: Json = { name: main?.name ?? inst.name };
  if (set) out.set = set.name;
  try {
    out.componentKey = (set ?? main)?.key;
  } catch {
    // key is unavailable on some soft-deleted components
  }
  if (main) out.componentId = main.id;
  try {
    const variantProps: Json = {};
    const props: Json = {};
    for (const [key, prop] of Object.entries(inst.componentProperties)) {
      const name = key.split("#")[0];
      if (prop.type === "VARIANT") variantProps[name] = prop.value;
      else if (prop.type === "INSTANCE_SWAP" && typeof prop.value === "string") {
        const swapped = await withTimeout(figma.getNodeByIdAsync(prop.value), 5_000, "Reading swapped component").catch(() => null);
        const swapSet = swapped?.parent?.type === "COMPONENT_SET" ? swapped.parent : null;
        props[name] = { swap: swapSet?.name ?? swapped?.name ?? prop.value };
      } else props[name] = prop.value;
    }
    if (Object.keys(variantProps).length) out.variantProps = variantProps;
    if (Object.keys(props).length) out.props = props;
  } catch {
    // remote components can refuse componentProperties
  }
  return out;
};

const topImage = (node: SceneNode): string | null | undefined => {
  if (!("fills" in node) || isMixed((node as GeometryMixin).fills)) return undefined;
  const visible = ((node as GeometryMixin).fills as Paint[]).filter((p) => p.visible !== false);
  const top = visible[visible.length - 1];
  return top?.type === "IMAGE" ? top.imageHash : undefined;
};

const visit = async (node: SceneNode, parent: SceneNode | null, depth: number, opts: ScanOptions, st: ScanState): Promise<Json | null> => {
  // The node asked for is always read, even when it is hidden itself.
  if (parent && !opts.includeHidden && node.visible === false) return null;
  if (st.nodeCount >= opts.maxNodes) {
    st.nodeLimitHit = true;
    return null;
  }
  if (++st.nodeCount % 200 === 0) {
    postProgress(st.requestId, `Read ${st.nodeCount} layers`);
    await yieldToFigma();
  }
  const out: Json = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) out.hidden = true;
  if ("isMask" in node && (node as FrameNode).isMask) out.mask = true;
  out.layout = await layoutOf(node, parent, st.look);

  if (parent && isIcon(node)) {
    out.type = "ICON";
    let hintName = node.name;
    if (node.type === "INSTANCE") {
      const component = await componentOf(node);
      out.component = component;
      hintName = String(component.set ?? component.name);
    }
    out.assetHint = assetHint(hintName);
    const style = await styleOf(node, st.look);
    out.style = st.styles.add(style);
    if (opts.inlineSvgMaxBytes > 0 && st.svgExports < MAX_INLINE_SVGS) {
      st.svgExports++;
      try {
        const bytes = await exportWithTimeout(node, { format: "SVG" }, 10_000);
        if (bytes.length <= opts.inlineSvgMaxBytes) out.svg = utf8Decode(bytes);
        else out.svgBytes = bytes.length;
      } catch (err) {
        out.svgError = err instanceof Error ? err.message : String(err);
      }
    }
    return out;
  }

  const image = node.type === "TEXT" || ("children" in node && (node as ChildrenMixin).children.length > 0) ? undefined : topImage(node);
  if (image !== undefined) {
    out.type = "IMAGE";
    out.imageRef = image;
  }
  out.style = st.styles.add(await styleOf(node, st.look));
  if (node.type === "TEXT") out.text = await textOf(node, st.textStyles, st.look);
  if (node.type === "INSTANCE") out.component = await componentOf(node);

  if ("children" in node) {
    const kids = (node as ChildrenMixin).children.filter((c) => opts.includeHidden || c.visible !== false);
    const expand = node.type !== "INSTANCE" || parent === null || opts.expandInstances;
    if (!expand) {
      if (kids.length) out.childCount = kids.length;
    } else if (opts.maxDepth !== undefined && depth >= opts.maxDepth) {
      if (kids.length) {
        out.childCount = kids.length;
        st.depthTruncated = true;
      }
    } else {
      const children: Json[] = [];
      for (const child of kids) {
        const c = await visit(child, node, depth + 1, opts, st);
        if (c) children.push(c);
      }
      if (children.length) out.children = children;
    }
  }
  return out;
};

/* ── component docs ───────────────────────────────────────────────────────── */

const docsTarget = async (node: SceneNode): Promise<ComponentNode | ComponentSetNode> => {
  let target: SceneNode | null = node;
  if (node.type === "INSTANCE") {
    target = await withTimeout(node.getMainComponentAsync(), 10_000, "Reading main component");
    if (!target) throw new Error(`Instance ${node.id} has no main component`);
  }
  if (target.type === "COMPONENT" && target.parent?.type === "COMPONENT_SET") return target.parent;
  if (target.type === "COMPONENT" || target.type === "COMPONENT_SET") return target;
  throw new Error(`Node ${node.id} is a ${node.type}; generate_component_docs needs a COMPONENT, COMPONENT_SET or INSTANCE`);
};

const collectUsage = async (root: SceneNode, requestId: string, look: Lookups) => {
  const vars = new Map<string, { fields: Set<string>; uses: number }>();
  const styles = new Map<string, number>();
  const addVar = (alias: unknown, field: string) => {
    const a = alias as VariableAlias | undefined;
    if (!a || typeof a.id !== "string") return;
    const e = vars.get(a.id) ?? { fields: new Set<string>(), uses: 0 };
    e.fields.add(field);
    e.uses++;
    vars.set(a.id, e);
  };
  const addStyle = (id: unknown) => {
    if (typeof id === "string" && id) styles.set(id, (styles.get(id) ?? 0) + 1);
  };
  const paints = (list: unknown, field: string) => {
    if (!Array.isArray(list)) return;
    for (const p of list as Paint[]) {
      if (p.type === "SOLID") addVar(p.boundVariables?.color, field);
      if ("gradientStops" in p) for (const s of p.gradientStops) addVar(s.boundVariables?.color, field);
    }
  };
  await walk(
    root,
    (node) => {
      const n = node as SceneNode & Json;
      const bv = (n.boundVariables ?? {}) as Record<string, unknown>;
      for (const [field, value] of Object.entries(bv)) {
        if (Array.isArray(value)) value.forEach((a) => addVar(a, field));
        else if (field === "componentProperties" && value && typeof value === "object") Object.values(value).forEach((a) => addVar(a, field));
        else addVar(value, field);
      }
      if ("fills" in n) paints(n.fills, "fills");
      if ("strokes" in n) paints(n.strokes, "strokes");
      if (Array.isArray(n.effects)) for (const e of n.effects as Effect[]) for (const [f, a] of Object.entries((e as DropShadowEffect).boundVariables ?? {})) addVar(a, `effects.${f}`);
      for (const key of ["fillStyleId", "strokeStyleId", "effectStyleId", "gridStyleId", "textStyleId"]) addStyle(n[key]);
      if (node.type === "TEXT" && (isMixed(node.textStyleId) || isMixed(node.fillStyleId))) {
        for (const seg of node.getStyledTextSegments(["textStyleId", "fillStyleId"])) {
          addStyle(seg.textStyleId);
          addStyle(seg.fillStyleId);
        }
      }
    },
    requestId
  );
  const variables = [];
  for (const [id, e] of vars) {
    const v = await look.variable(id);
    variables.push({ ...(v ?? { id, name: `(unresolved ${id})`, collection: "" }), fields: [...e.fields].sort(), uses: e.uses });
  }
  const styleList = [];
  for (const [id, uses] of styles) {
    const s = await look.style(id);
    styleList.push({ ...(s ?? { name: `(unresolved ${id})`, type: "" }), uses });
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { variables: variables.sort(byName), styles: styleList.sort(byName) };
};

const FONT_CANDIDATES: FontName[] = [
  { family: "Inter", style: "Regular" },
  { family: "Roboto", style: "Regular" },
  { family: "Arial", style: "Regular" },
];

const loadDocFonts = async (): Promise<{ regular: FontName; bold: FontName }> => {
  const errors: string[] = [];
  for (const regular of FONT_CANDIDATES) {
    try {
      await withTimeout(figma.loadFontAsync(regular), 10_000, `Loading ${regular.family}`);
    } catch (err) {
      errors.push(`${regular.family}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const bold = { family: regular.family, style: "Bold" };
    try {
      await withTimeout(figma.loadFontAsync(bold), 10_000, `Loading ${bold.family} Bold`);
      return { regular, bold };
    } catch {
      return { regular, bold: regular };
    }
  }
  throw new Error(`Could not load a font for the docs frame (${errors.join("; ")})`);
};

/* ── dispatcher ───────────────────────────────────────────────────────────── */

export const handleCodegenRequest = async (request: Request): Promise<Response | null> => {
  if (!TYPES.has(request.type)) return null;
  const p = request.params ?? {};

  switch (request.type) {
    case "codegen_scan": {
      const root = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(root);
      const opts: ScanOptions = {
        includeHidden: p.includeHidden === true,
        maxDepth: num(p.maxDepth),
        expandInstances: p.expandInstances === true,
        inlineSvgMaxBytes: num(p.inlineSvgMaxBytes) ?? 0,
        maxNodes: num(p.maxNodes) ?? 3000,
      };
      const st: ScanState = {
        look: new Lookups(),
        styles: new StyleTable("s"),
        textStyles: new StyleTable("t"),
        nodeCount: 0,
        depthTruncated: false,
        nodeLimitHit: false,
        svgExports: 0,
        requestId: request.requestId,
      };
      const tree = await visit(root, null, 0, opts, st);
      return ok(request, {
        root: tree,
        styles: st.styles.entries,
        textStyles: st.textStyles.entries,
        meta: {
          fileName: figma.root.name,
          page: pageOf(root)?.name,
          nodeCount: st.nodeCount,
          depthTruncated: st.depthTruncated,
          ...(st.nodeLimitHit ? { nodeLimitHit: opts.maxNodes } : {}),
        },
      });
    }

    case "codegen_run_script": {
      const code = need(str(p.code), "code");
      const timeoutMs = Math.min(Math.max(num(p.timeoutMs) ?? 10_000, 1), 60_000);
      const logs: { level: string; message: string }[] = [];
      let dropped = 0;
      const capture =
        (level: "log" | "info" | "warn" | "error" | "debug") =>
        (...args: unknown[]) => {
          if (logs.length < 200) logs.push({ level, message: formatLogArgs(args) });
          else dropped++;
        };
      const scriptConsole = { log: capture("log"), info: capture("info"), warn: capture("warn"), error: capture("error"), debug: capture("debug") };
      let fn: (figmaApi: PluginAPI, console: unknown) => Promise<unknown>;
      try {
        fn = new Function("figma", "console", scriptSource(code)) as typeof fn;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SyntaxError) return ok(request, { error: `The script does not parse: ${message}`, logs });
        return ok(request, { error: `This Figma plugin sandbox would not compile the script (${message}), so run_script cannot work in it.`, logs });
      }
      const t0 = Date.now();
      try {
        const value = await withTimeout(Promise.resolve().then(() => fn(figma, scriptConsole)), timeoutMs, "The script");
        const { result, truncated } = capScriptResult(value);
        return ok(request, {
          result,
          ...(truncated ? { truncated } : {}),
          logs,
          ...(dropped ? { logsDropped: dropped } : {}),
          durationMs: Date.now() - t0,
          editorType: figma.editorType,
        });
      } catch (err) {
        let message = err instanceof Error ? err.message : String(err);
        if (message.includes("did not finish within")) message += ". It may still be running in the plugin; a synchronous loop cannot be stopped, so close and re-run the plugin if Figma stays busy";
        if (figma.editorType === "dev") message += ". (Dev Mode is read-only: scripts that change the file need the design editor.)";
        return ok(request, { error: message, logs, ...(dropped ? { logsDropped: dropped } : {}), durationMs: Date.now() - t0 });
      }
    }

    case "codegen_component_docs": {
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(node);
      const target = await docsTarget(node);
      const look = new Lookups();
      const out: Json = {
        id: target.id,
        name: target.name,
        type: target.type,
        description: target.description || undefined,
        documentationLinks: target.documentationLinks.map((l) => l.uri),
        page: pageOf(target)?.name,
        width: round(target.width),
        height: round(target.height),
      };
      if (target.id !== node.id) out.requestedNodeId = node.id;
      try {
        out.key = target.key;
      } catch {
        // unpublished soft-deleted components
      }
      try {
        const properties = [];
        for (const [key, d] of Object.entries(target.componentPropertyDefinitions)) {
          let defaultValue: unknown = d.defaultValue;
          if (d.type === "INSTANCE_SWAP" && typeof d.defaultValue === "string") {
            const swapped = await withTimeout(figma.getNodeByIdAsync(d.defaultValue), 5_000, "Reading default instance").catch(() => null);
            defaultValue = swapped?.name ?? d.defaultValue;
          }
          properties.push({
            name: key.split("#")[0],
            key,
            type: d.type,
            default: defaultValue,
            ...(d.variantOptions ? { options: d.variantOptions } : {}),
            ...(d.description ? { description: d.description } : {}),
            ...(d.preferredValues?.length ? { preferredValues: d.preferredValues.length } : {}),
          });
        }
        out.properties = properties;
      } catch (err) {
        out.propertiesError = err instanceof Error ? err.message : String(err);
      }
      if (target.type === "COMPONENT_SET") {
        const variants = target.children.filter((c): c is ComponentNode => c.type === "COMPONENT");
        out.variantCount = variants.length;
        out.variants = variants.slice(0, 300).map((v) => ({
          id: v.id,
          name: v.name,
          props: v.variantProperties ?? undefined,
          ...(v.description ? { description: v.description } : {}),
        }));
        try {
          out.defaultVariant = target.defaultVariant.name;
        } catch {
          // empty sets
        }
      }
      Object.assign(out, await collectUsage(target, request.requestId, look));

      if (p.countInstances === true) {
        const components = target.type === "COMPONENT_SET" ? target.children.filter((c): c is ComponentNode => c.type === "COMPONENT") : [target];
        let total = 0;
        const byPage: Record<string, number> = {};
        const errors: string[] = [];
        for (const [i, c] of components.entries()) {
          postProgress(request.requestId, `Counting instances ${i + 1}/${components.length}`, i, components.length);
          try {
            const instances = await withTimeout(c.getInstancesAsync(), 60_000, `Finding instances of "${c.name}"`);
            total += instances.length;
            for (const inst of instances) {
              const page = pageOf(inst)?.name ?? "?";
              byPage[page] = (byPage[page] ?? 0) + 1;
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
            break;
          }
        }
        out.instances = { count: total, byPage, ...(errors.length ? { incomplete: errors[0] } : {}) };
      }
      return ok(request, out);
    }

    case "codegen_component_docs_write": {
      requireEditor("generate_component_docs with writeToCanvas");
      const node = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
      await ensurePageLoaded(node);
      const anchor = await docsTarget(node);
      const markdown = need(str(p.markdown), "markdown");
      const fonts = await loadDocFonts();
      const frame = figma.createFrame();
      frame.name = `${anchor.name} — Docs`;
      frame.layoutMode = "VERTICAL";
      frame.primaryAxisSizingMode = "AUTO";
      frame.counterAxisSizingMode = "FIXED";
      frame.resize(560, 100);
      frame.itemSpacing = 8;
      frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = 32;
      frame.cornerRadius = 12;
      frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      const host = anchor.parent && "appendChild" in anchor.parent && anchor.parent.type !== "INSTANCE" ? (anchor.parent as BaseNode & ChildrenMixin) : pageOf(anchor);
      (host ?? figma.currentPage).appendChild(frame);
      frame.x = anchor.x + anchor.width + 80;
      frame.y = anchor.y;
      const SIZE = { h1: 24, h2: 18, h3: 15, p: 13, li: 13, code: 12 } as const;
      const blocks = markdownBlocks(markdown);
      for (const block of blocks) {
        const t = figma.createText();
        t.fontName = block.kind.startsWith("h") ? fonts.bold : fonts.regular;
        t.fontSize = SIZE[block.kind];
        t.characters = block.kind === "li" ? `•  ${block.text}` : block.text;
        if (block.kind === "code") t.fills = [{ type: "SOLID", color: { r: 0.3, g: 0.3, b: 0.35 } }];
        frame.appendChild(t);
        t.layoutSizingHorizontal = "FILL";
        t.textAutoResize = "HEIGHT";
      }
      return ok(request, { frameId: frame.id, name: frame.name, blocks: blocks.length, font: fonts.regular.family });
    }
  }
  return null;
};
