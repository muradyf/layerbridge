/**
 * Plugin side of the quality tools. Internal request types, called by the
 * server tools in server/src/quality.ts:
 *
 *   a11y_scan      text colours, what is painted behind each text, interactive targets
 *   a11y_annotate  add / replace / clear this tool's annotations (editing)
 *   ds_scan        layers with unbound paints, spacing, radii, unstyled text, and the file's tokens
 *   ds_apply       bind variables and styles planned by fix_design_system (editing)
 *
 * The plugin only gathers facts and applies explicit changes; colour math and
 * matching happen on the server. Every apply re-checks the layer against the
 * scan and reads the result back, reverting when Figma changed the value.
 */
import {
  arr,
  loadFontsFor,
  need,
  num,
  ok,
  requireEditor,
  str,
  variableValueToJson,
  type Request,
  type Response,
} from "./features";
import {
  ensurePageLoaded,
  hiddenBy,
  pageOf,
  postProgress,
  resolveSceneNode,
  withTimeout,
  yieldToFigma,
} from "./robust";
import {
  A11Y_TAG,
  DEFAULT_NAME,
  RECT_LIKE,
  containsBox,
  excerpt,
  hasClickReaction,
  intersect,
  isInteractiveName,
  isOpaqueSolid,
  isRotated,
  overlaps,
  paintJson,
  rgbHex,
  shortPath,
  visiblePaints,
  type Box,
  type PaintLike,
} from "./quality-core";

const QUALITY_TYPES = new Set(["a11y_scan", "a11y_annotate", "ds_scan", "ds_apply"]);

/* ── node accessors (the typings split these across many mixins) ──────────── */

type Loose = Record<string, unknown>;
const loose = (n: BaseNode) => n as unknown as Loose;

const boxOf = (n: BaseNode): Box | null => (loose(n).absoluteBoundingBox as Rect | null | undefined) ?? null;

const paintsOf = (n: BaseNode, key: "fills" | "strokes"): readonly Paint[] | null => {
  const v = loose(n)[key];
  return Array.isArray(v) ? (v as readonly Paint[]) : null;
};

const asPaintLike = (p: Paint) => p as unknown as PaintLike;

const effectsOf = (n: BaseNode): Effect[] =>
  ((loose(n).effects as Effect[] | undefined) ?? []).filter((e) => (e as { visible?: boolean }).visible !== false);

const radiusOf = (n: BaseNode) => {
  const r = loose(n).cornerRadius;
  if (typeof r === "number") return r;
  const corners = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"].map((k) => loose(n)[k]);
  return Math.max(0, ...corners.filter((v): v is number => typeof v === "number"));
};

const boundOf = (n: BaseNode) => (loose(n).boundVariables as Loose | undefined) ?? {};

const modesOf = (n: SceneNode): Record<string, string> | undefined => {
  try {
    return { ...n.resolvedVariableModes };
  } catch {
    return undefined;
  }
};

const topLevelOf = (n: SceneNode): SceneNode => {
  let current: SceneNode = n;
  while (current.parent && current.parent.type !== "PAGE" && current.parent.type !== "DOCUMENT") {
    current = current.parent as SceneNode;
  }
  return current;
};

/* ── tokens ───────────────────────────────────────────────────────────────── */

const collectTokens = async () => {
  const [collections, variables, paintStyles, textStyles] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
  ]);
  return {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      defaultModeId: c.defaultModeId,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
    })),
    variables: variables
      .filter((v) => v.resolvedType === "COLOR" || v.resolvedType === "FLOAT")
      .map((v) => ({
        id: v.id,
        name: v.name,
        collectionId: v.variableCollectionId,
        resolvedType: v.resolvedType,
        scopes: [...v.scopes],
        valuesByMode: Object.fromEntries(Object.entries(v.valuesByMode).map(([m, value]) => [m, variableValueToJson(value)])),
      })),
    paintStyles: paintStyles.map((s) => ({ id: s.id, name: s.name, paints: s.paints.map((p) => paintJson(asPaintLike(p))) })),
    textStyles: textStyles.map((s) => ({
      id: s.id,
      name: s.name,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
    })),
  };
};

/* ── a11y_scan ────────────────────────────────────────────────────────────── */

type Ctx = {
  opacity: number;
  clip: Box | null;
  blend: string | null;
  blur: string | null;
  masked: boolean;
  inTarget: boolean;
  path: string[];
};

type Painted = {
  node: SceneNode;
  box: Box;
  clip: Box | null;
  rect: Box;
  radius: number;
  coverable: boolean;
  /** Plain solid fills, normal blend, no blur: the server can composite it. */
  simple: boolean;
  opaque: boolean;
  layer: Loose;
};

const scanA11y = async (request: Request, p: Loose) => {
  const root = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
  await ensurePageLoaded(root);
  const hider = hiddenBy(root);
  if (hider) throw new Error(`Node ${root.id} "${root.name}" is hidden (by ${hider.id} "${hider.name}"), so nothing in it renders`);

  const checks = new Set(arr<string>(p.checks) ?? ["contrast", "targets", "textSize"]);
  const wantText = checks.has("contrast") || checks.has("textSize");
  const wantTargets = checks.has("targets");
  const maxTexts = num(p.limit) ?? 3000;
  const page = pageOf(root);
  const canvasPaint = page?.backgrounds.find((b) => b.type === "SOLID" && b.visible !== false) as SolidPaint | undefined;

  const painted: Painted[] = [];
  const texts: Loose[] = [];
  const targets: Loose[] = [];
  const tagged: string[] = [];
  let visited = 0;
  let truncated = false;

  const enter = (node: SceneNode, ctx: Ctx): Ctx | null => {
    if (node.visible === false) return null;
    const own = typeof loose(node).opacity === "number" ? (loose(node).opacity as number) : 1;
    const opacity = ctx.opacity * own;
    if (opacity <= 0.001) return null;
    const blendMode = loose(node).blendMode as string | undefined;
    const blend = ctx.blend ?? (blendMode && blendMode !== "NORMAL" && blendMode !== "PASS_THROUGH" ? blendMode : null);
    const effects = effectsOf(node);
    const layerBlur = effects.some((e) => e.type === "LAYER_BLUR");
    const backgroundBlur = effects.some((e) => e.type === "BACKGROUND_BLUR");
    const box = boxOf(node);
    const rotated = isRotated(node.absoluteTransform);

    if (node.type !== "TEXT" && box && loose(node).isMask !== true) {
      const fills = paintsOf(node, "fills");
      const visible = fills ? visiblePaints(fills.map(asPaintLike)) : [];
      const rect = visible.length ? intersect(box, ctx.clip) : null;
      if (fills && rect) {
        const plain = visible.every((f) => f.type === "SOLID" && (!f.blendMode || f.blendMode === "NORMAL"));
        painted.push({
          node,
          box,
          clip: ctx.clip,
          rect,
          radius: radiusOf(node),
          coverable: RECT_LIKE.has(node.type) && !rotated && !ctx.masked,
          simple: plain && !blend && !layerBlur && !backgroundBlur && !ctx.blur,
          opaque: isOpaqueSolid(fills.map(asPaintLike), opacity),
          layer: {
            nodeId: node.id,
            name: node.name,
            fills: fills.map((f) => paintJson(asPaintLike(f))),
            opacity,
            ...(blend ? { blendMode: blend } : {}),
            ...(backgroundBlur ? { backgroundBlur: true } : {}),
            ...(layerBlur || ctx.blur ? { layerBlur: true } : {}),
          },
        });
      }
    }

    const clips = loose(node).clipsContent === true;
    return {
      opacity,
      clip: clips && box ? intersect(ctx.clip, box) ?? { ...box, width: 0, height: 0 } : ctx.clip,
      blend,
      blur: ctx.blur ?? (layerBlur ? node.name : null),
      masked: ctx.masked,
      inTarget: ctx.inTarget,
      path: [...ctx.path, node.name],
    };
  };

  const collectText = (node: TextNode, ctx: Ctx) => {
    if (texts.length >= maxTexts) {
      truncated = true;
      return;
    }
    const box = node.absoluteRenderBounds ?? boxOf(node);
    if (!box || box.width <= 0 || box.height <= 0 || node.characters.trim() === "") return;

    const groups = new Map<string, { characters: string; fills: unknown[]; fontSize: number; fontWeight: number }>();
    for (const s of node.getStyledTextSegments(["fills", "fontSize", "fontWeight"])) {
      const fills = s.fills.map((f) => paintJson(asPaintLike(f)));
      const key = JSON.stringify([fills, s.fontSize, s.fontWeight]);
      const group = groups.get(key);
      if (group) group.characters += s.characters;
      else groups.set(key, { characters: s.characters, fills, fontSize: s.fontSize, fontWeight: s.fontWeight });
    }

    const layers: Loose[] = [];
    const contributors: SceneNode[] = [];
    let reason: string | null = ctx.blend
      ? `the text or a parent uses ${ctx.blend} blend mode`
      : ctx.blur
        ? `layer blur on "${ctx.blur}"`
        : null;
    let opaque = false;
    for (let i = painted.length - 1; i >= 0; i--) {
      const e = painted[i];
      if (!overlaps(e.rect, box)) continue;
      if (layers.length >= 16) {
        reason ??= "more than 16 overlapping layers";
        break;
      }
      const covers = e.coverable && containsBox(e.box, box, e.radius) && (!e.clip || containsBox(e.clip, box));
      layers.push(covers ? e.layer : { ...e.layer, partial: true });
      contributors.push(e.node);
      if (!e.simple) reason ??= `"${e.node.name}" is not a plain solid fill (image, gradient, blend or blur)`;
      else if (!covers) reason ??= `"${e.node.name}" only partly covers the text`;
      if (covers && e.simple && e.opaque) {
        opaque = true;
        break;
      }
    }
    // Ancestors of the checked layer are seeded, but not their earlier siblings.
    const rootIsTopLevel = !root.parent || root.parent.type === "PAGE";
    if (!opaque && !reason && !rootIsTopLevel) reason = "no opaque background inside the checked layer";

    const entry: Loose = {
      nodeId: node.id,
      name: node.name,
      path: shortPath(ctx.path.slice(0, -1)),
      characters: excerpt(node.characters),
      opacity: ctx.opacity,
      bounds: box,
      groups: [...groups.values()].map((g) => ({ ...g, characters: excerpt(g.characters) })),
      layers,
      needsPixelSample: reason !== null,
      modes: modesOf(node),
    };
    if (reason) {
      entry.sampleReason = reason;
      let exportNode: SceneNode | null = topLevelOf(node);
      if (opaque && !ctx.blend && !ctx.blur && contributors.length) {
        // Lowest common ancestor of the text and every layer that paints behind it.
        const chain: BaseNode[] = [];
        for (let a: BaseNode | null = node; a && a.type !== "PAGE" && a.type !== "DOCUMENT"; a = a.parent) chain.push(a);
        let index = 0;
        for (const c of contributors) {
          let a: BaseNode | null = c;
          while (a && !chain.includes(a)) a = a.parent;
          index = Math.max(index, a ? chain.indexOf(a) : chain.length);
        }
        exportNode = index < chain.length ? (chain[index] as SceneNode) : null;
      }
      const exportBox = exportNode ? boxOf(exportNode) : null;
      if (exportNode && exportBox) {
        entry.exportNodeId = exportNode.id;
        entry.exportBounds = exportBox;
        entry.relBounds = { x: box.x - exportBox.x, y: box.y - exportBox.y, width: box.width, height: box.height };
      }
    }
    texts.push(entry);
  };

  const targetInfo = async (node: SceneNode): Promise<Loose | null> => {
    if ("reactions" in node && hasClickReaction((node as SceneNode & ReactionMixin).reactions)) return { via: "reaction" };
    if (node.type !== "INSTANCE") return null;
    try {
      const main = await withTimeout(node.getMainComponentAsync(), 5_000, `Reading main component of ${node.id}`);
      if (!main) return null;
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : null;
      if (set ? isInteractiveName(set) : isInteractiveName(main.name)) {
        return { via: "component", component: set ? `${set} / ${main.name}` : main.name };
      }
    } catch {
      // unreadable main component: not a target
    }
    return null;
  };

  const visit = async (node: SceneNode, parent: Ctx): Promise<void> => {
    if (truncated) return;
    const box = boxOf(node);
    if (parent.clip && box && !intersect(box, parent.clip)) return; // clipped away entirely
    const ctx = enter(node, parent);
    if (!ctx) return;
    if (++visited % 300 === 0) {
      postProgress(request.requestId, `Checked ${visited} layers, ${texts.length} texts, ${targets.length} targets`);
      await yieldToFigma();
    }
    if (node.getPluginData(A11Y_TAG) !== "") tagged.push(node.id);
    if (node.type === "TEXT") {
      if (wantText) collectText(node, ctx);
      return;
    }
    if (wantTargets && !ctx.inTarget && box && box.width > 0 && box.height > 0) {
      const info = await targetInfo(node);
      if (info) {
        targets.push({ nodeId: node.id, name: node.name, path: shortPath(parent.path), x: box.x, y: box.y, width: box.width, height: box.height, ...info });
        ctx.inTarget = true;
      }
    }
    if (node.type === "BOOLEAN_OPERATION" || !("children" in node)) return;
    let masked = ctx.masked;
    for (const child of node.children) {
      if (loose(child).isMask === true && child.visible !== false) {
        masked = true;
        continue;
      }
      await visit(child, { ...ctx, masked });
    }
  };

  // Seed the paint list with the checked layer's ancestors: their fills sit behind it.
  let ctx: Ctx = { opacity: 1, clip: null, blend: null, blur: null, masked: false, inTarget: false, path: [] };
  const ancestors: SceneNode[] = [];
  for (let a = root.parent; a && a.type !== "PAGE" && a.type !== "DOCUMENT"; a = a.parent) ancestors.unshift(a as SceneNode);
  for (const a of ancestors) ctx = enter(a, ctx) ?? ctx;
  await visit(root, { ...ctx, path: [] });

  return {
    root: { id: root.id, name: root.name },
    canvas: canvasPaint ? rgbHex(canvasPaint.color) : "#ffffff",
    visited,
    truncated,
    texts,
    targets,
    tagged,
    ...(checks.has("contrast") && p.includeTokens !== false ? { tokens: await collectTokens() } : {}),
  };
};

/* ── a11y_annotate ────────────────────────────────────────────────────────── */

const annotate = async (p: Loose) => {
  const items = arr<{ nodeId: string; label: string }>(p.items) ?? [];
  const clear = arr<string>(p.clear) ?? [];
  let categoryId: string | undefined;
  try {
    const categories = await figma.annotations.getAnnotationCategoriesAsync();
    const category =
      categories.find((c) => c.label === "Accessibility") ??
      (await figma.annotations.addAnnotationCategoryAsync({ label: "Accessibility", color: "red" }));
    categoryId = category.id;
  } catch {
    // categories unavailable: plain annotations still work
  }

  const results: Loose[] = [];
  const withoutOurs = (n: SceneNode & AnnotationsMixin) => {
    const previous = n.getPluginData(A11Y_TAG);
    return {
      previous,
      others: previous ? n.annotations.filter((a) => a.label !== previous && a.labelMarkdown !== previous) : [...n.annotations],
    };
  };

  for (const item of items) {
    try {
      const node = await resolveSceneNode(item.nodeId);
      if (!("annotations" in node)) {
        results.push({ nodeId: item.nodeId, status: "skipped", reason: `${node.type} layers cannot carry annotations` });
        continue;
      }
      const n = node as SceneNode & AnnotationsMixin;
      const { previous, others } = withoutOurs(n);
      if (previous === item.label && others.length < n.annotations.length) {
        results.push({ nodeId: item.nodeId, status: "unchanged" });
        continue;
      }
      n.annotations = [...others, { label: item.label, ...(categoryId ? { categoryId } : {}) }];
      n.setPluginData(A11Y_TAG, item.label);
      results.push({ nodeId: item.nodeId, status: previous ? "replaced" : "added" });
    } catch (err) {
      results.push({ nodeId: item.nodeId, status: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const id of clear) {
    try {
      const node = await resolveSceneNode(id);
      if (!("annotations" in node)) continue;
      const n = node as SceneNode & AnnotationsMixin;
      const { others } = withoutOurs(n);
      n.annotations = others;
      n.setPluginData(A11Y_TAG, "");
      results.push({ nodeId: id, status: "cleared" });
    } catch (err) {
      results.push({ nodeId: id, status: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results };
};

/* ── ds_scan ──────────────────────────────────────────────────────────────── */

const segmentProps = (s: { start: number; end: number; fontName: FontName; fontSize: number; lineHeight: LineHeight; letterSpacing: LetterSpacing }) => ({
  start: s.start,
  end: s.end,
  fontFamily: s.fontName.family,
  fontStyle: s.fontName.style,
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  letterSpacing: s.letterSpacing,
});

const unboundPaints = (node: SceneNode) => {
  const out: Loose[] = [];
  const add = (field: "fills" | "strokes", paints: readonly Paint[], styled: boolean, range?: [number, number]) => {
    if (styled) return;
    paints.forEach((paint, index) => {
      if (paint.type !== "SOLID" || paint.visible === false) return;
      if (paint.boundVariables?.color) return;
      out.push({ field, index, ...(range ? { range } : {}), paintCount: paints.length, color: rgbHex(paint.color), opacity: paint.opacity ?? 1 });
    });
  };
  const fills = loose(node).fills;
  const fillStyleId = loose(node).fillStyleId;
  if (node.type === "TEXT" && (fills === figma.mixed || fillStyleId === figma.mixed)) {
    for (const s of node.getStyledTextSegments(["fills", "fillStyleId"])) add("fills", s.fills, s.fillStyleId !== "", [s.start, s.end]);
  } else if (Array.isArray(fills)) {
    add("fills", fills as Paint[], typeof fillStyleId === "string" && fillStyleId !== "");
  }
  const strokes = paintsOf(node, "strokes");
  if (strokes && strokes.length && loose(node).strokeWeight !== 0) {
    const strokeStyleId = loose(node).strokeStyleId;
    add("strokes", strokes, typeof strokeStyleId === "string" && strokeStyleId !== "");
  }
  return out;
};

const PADDINGS = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"] as const;
const CORNERS = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] as const;

const scanDs = async (request: Request, p: Loose) => {
  const root = await resolveSceneNode(need(str(p.nodeId), "nodeId"));
  await ensurePageLoaded(root);
  const rules = new Set(arr<string>(p.rules) ?? []);
  const want = (rule: string) => rules.size === 0 || rules.has(rule);
  const limit = num(p.limit) ?? 5000;
  const includeInstanceChildren = p.includeInstanceChildren === true;
  const nodes: Loose[] = [];
  let visited = 0;
  let truncated = false;

  const visit = async (node: SceneNode, path: string[]): Promise<void> => {
    if (truncated) return;
    if (++visited % 300 === 0) {
      postProgress(request.requestId, `Linted ${visited} layers, ${nodes.length} with findings`);
      await yieldToFigma();
    }
    const rec: Loose = { id: node.id, name: node.name, type: node.type, ...(path.length ? { path: shortPath(path) } : {}) };
    const push = () => {
      if (nodes.length >= limit) truncated = true;
      else nodes.push(rec);
    };
    if (node.visible === false) {
      if (want("hidden-layer") && node !== root) {
        rec.hidden = true;
        push();
      }
      return; // nothing inside a hidden layer renders
    }
    let found = false;
    if (want("default-name") && DEFAULT_NAME.test(node.name)) {
      rec.defaultName = true;
      found = true;
    }
    if (node.type === "FRAME") {
      if (want("detached-instance") && node.detachedInfo) {
        rec.detached = node.detachedInfo;
        found = true;
      }
      if (
        want("empty-frame") &&
        node.children.length === 0 &&
        visiblePaints((paintsOf(node, "fills") ?? []).map(asPaintLike)).length === 0 &&
        visiblePaints((paintsOf(node, "strokes") ?? []).map(asPaintLike)).length === 0 &&
        effectsOf(node).length === 0
      ) {
        rec.emptyFrame = true;
        found = true;
      }
    }
    if (want("unbound-color")) {
      const paints = unboundPaints(node);
      if (paints.length) {
        rec.paints = paints;
        found = true;
      }
    }
    const bound = boundOf(node);
    if ((want("unbound-spacing") || want("off-scale-spacing")) && "layoutMode" in node) {
      const f = node as FrameNode;
      if (f.layoutMode === "HORIZONTAL" || f.layoutMode === "VERTICAL") {
        const spacing: Loose[] = [];
        const add = (field: string, value: unknown) => {
          if (typeof value === "number" && value !== 0) spacing.push({ field, value, bound: !!bound[field] });
        };
        if (f.primaryAxisAlignItems !== "SPACE_BETWEEN") add("itemSpacing", f.itemSpacing);
        if (f.layoutWrap === "WRAP") add("counterAxisSpacing", f.counterAxisSpacing);
        for (const field of PADDINGS) add(field, f[field]);
        if (spacing.length) {
          rec.spacing = spacing;
          found = true;
        }
      }
    }
    if ((want("unbound-radius") || want("off-scale-radius")) && "cornerRadius" in node) {
      const r = loose(node).cornerRadius;
      const radius: Loose[] = [];
      if (typeof r === "number") {
        if (r > 0) radius.push({ field: "cornerRadius", value: r, bound: !!(bound.cornerRadius || bound.topLeftRadius) });
      } else {
        for (const field of CORNERS) {
          const value = loose(node)[field];
          if (typeof value === "number" && value > 0) radius.push({ field, value, bound: !!bound[field] });
        }
      }
      if (radius.length) {
        rec.radius = radius;
        found = true;
      }
    }
    if (want("text-without-style") && node.type === "TEXT" && node.characters.length > 0) {
      if (node.textStyleId === "") {
        const segments = node.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "letterSpacing"]).map(segmentProps);
        if (segments.length) {
          rec.text = { whole: true, segments };
          found = true;
        }
      } else if (node.textStyleId === figma.mixed) {
        const segments = node
          .getStyledTextSegments(["textStyleId", "fontName", "fontSize", "lineHeight", "letterSpacing"])
          .filter((s) => s.textStyleId === "")
          .map(segmentProps);
        if (segments.length) {
          rec.text = { whole: false, segments };
          found = true;
        }
      }
    }
    if (rec.paints || rec.spacing || rec.radius) rec.modes = modesOf(node);
    if (found) push();
    if (node.type === "BOOLEAN_OPERATION" || !("children" in node)) return;
    // An instance's insides come from its main component: lint the component, not every copy.
    if (node.type === "INSTANCE" && node !== root && !includeInstanceChildren) return;
    for (const child of node.children) await visit(child, [...path, node.name]);
  };

  await visit(root, []);
  return { root: { id: root.id, name: root.name }, visited, truncated, nodes, tokens: await collectTokens() };
};

/* ── ds_apply ─────────────────────────────────────────────────────────────── */

type Change = {
  kind: "paint-variable" | "paint-style" | "float-variable" | "text-style";
  nodeId: string;
  field?: string;
  index?: number;
  range?: [number, number];
  before?: { color: string; opacity: number } | number;
  targetId: string;
  targetName?: string;
  expected?: { color: string; opacity: number } | number;
};

class Skip extends Error {}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const applyOne = async (c: Change): Promise<Loose> => {
  const node = await resolveSceneNode(c.nodeId);
  await ensurePageLoaded(node);

  if (c.kind === "paint-variable" || c.kind === "paint-style") {
    const field = c.field === "strokes" ? "strokes" : "fills";
    const index = c.index ?? 0;
    const before = c.before as { color: string; opacity: number };
    const expected = c.expected as { color: string; opacity: number };
    const text = c.range ? (node as TextNode) : null;
    const read = (): readonly Paint[] => {
      const v = text ? text.getRangeFills(c.range![0], c.range![1]) : loose(node)[field];
      if (!Array.isArray(v)) throw new Skip(`${field} are mixed now; re-run the scan`);
      return v as readonly Paint[];
    };
    const current = read();
    const paint = current[index];
    if (!paint || paint.type !== "SOLID" || !sameHex(rgbHex(paint.color), before.color) || Math.abs((paint.opacity ?? 1) - before.opacity) > 0.005) {
      throw new Skip("the paint changed since the scan");
    }
    if (paint.boundVariables?.color) throw new Skip("already bound to a variable");
    const matches = (p: Paint | undefined) =>
      !!p && p.type === "SOLID" && sameHex(rgbHex(p.color), expected.color) && Math.abs((p.opacity ?? 1) - expected.opacity) <= 0.01;
    const write = async (paints: readonly Paint[]) => {
      if (text) {
        await loadFontsFor(text);
        text.setRangeFills(c.range![0], c.range![1], [...paints]);
      } else loose(node)[field] = paints;
    };

    if (c.kind === "paint-variable") {
      const variable = await figma.variables.getVariableByIdAsync(c.targetId);
      if (!variable) throw new Skip("variable no longer exists");
      const resolved = variable.resolveForConsumer(node).value;
      if (typeof resolved !== "object" || resolved === null || !("r" in resolved)) throw new Skip("variable does not resolve to a colour here");
      const resolvedHex = rgbHex(resolved as RGB);
      const resolvedAlpha = "a" in resolved ? (resolved as RGBA).a : 1;
      if (!sameHex(resolvedHex, expected.color) || Math.abs(resolvedAlpha - expected.opacity) > 0.01) {
        throw new Skip(`variable resolves to ${resolvedHex} at ${Math.round(resolvedAlpha * 100)}% in this layer's mode, not the planned ${expected.color}`);
      }
      const next = [...current];
      next[index] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
      await write(next);
      const after = read()[index];
      if (!matches(after) || !(after as SolidPaint).boundVariables?.color) {
        await write(current);
        throw new Skip("Figma changed the colour or opacity when binding; reverted");
      }
      return { nodeId: c.nodeId, kind: c.kind, property: `${field}[${index}]`, variable: variable.name };
    }

    if (text || current.length !== 1) throw new Skip("a colour style replaces all paints; this layer has several");
    const styleId = loose(node)[field === "fills" ? "fillStyleId" : "strokeStyleId"];
    if (typeof styleId !== "string" || styleId !== "") throw new Skip("already uses a style");
    const style = await figma.getStyleByIdAsync(c.targetId);
    if (!style || style.type !== "PAINT") throw new Skip("paint style no longer exists");
    const setter = field === "fills" ? "setFillStyleIdAsync" : "setStrokeStyleIdAsync";
    await (loose(node)[setter] as (id: string) => Promise<void>).call(node, c.targetId);
    if (!matches(read()[0])) {
      await (loose(node)[setter] as (id: string) => Promise<void>).call(node, "");
      await write(current);
      throw new Skip("the style's colour differs from the plan now; reverted");
    }
    return { nodeId: c.nodeId, kind: c.kind, property: field, style: style.name };
  }

  if (c.kind === "float-variable") {
    const field = need(c.field, "field");
    const before = c.before as number;
    const value = loose(node)[field];
    if (typeof value !== "number" || Math.abs(value - before) > 0.001) throw new Skip("the value changed since the scan");
    const bound = boundOf(node);
    if (bound[field] || (field === "cornerRadius" && bound.topLeftRadius)) throw new Skip("already bound to a variable");
    const variable = await figma.variables.getVariableByIdAsync(c.targetId);
    if (!variable) throw new Skip("variable no longer exists");
    const resolved = variable.resolveForConsumer(node).value;
    if (typeof resolved !== "number" || Math.abs(resolved - (c.expected as number)) > 0.001) {
      throw new Skip(`variable resolves to ${String(resolved)} in this layer's mode, not ${c.expected}`);
    }
    const target = node as unknown as { setBoundVariable(f: VariableBindableNodeField, v: Variable | null): void };
    target.setBoundVariable(field as VariableBindableNodeField, variable);
    if (typeof loose(node)[field] !== "number" || Math.abs((loose(node)[field] as number) - before) > 0.001) {
      target.setBoundVariable(field as VariableBindableNodeField, null);
      loose(node)[field] = before;
      throw new Skip("binding changed the value; reverted");
    }
    return { nodeId: c.nodeId, kind: c.kind, property: field, variable: variable.name };
  }

  if (c.kind === "text-style") {
    if (node.type !== "TEXT") throw new Skip(`is a ${node.type}, not TEXT`);
    if (node.textStyleId !== "") throw new Skip("already uses a text style");
    const style = await figma.getStyleByIdAsync(c.targetId);
    if (!style || style.type !== "TEXT") throw new Skip("text style no longer exists");
    await loadFontsFor(node);
    await figma.loadFontAsync((style as TextStyle).fontName);
    await node.setTextStyleIdAsync(c.targetId);
    return { nodeId: c.nodeId, kind: c.kind, property: "textStyleId", style: style.name };
  }

  throw new Skip(`unknown change kind ${String((c as { kind?: unknown }).kind)}`);
};

const applyChanges = async (request: Request, p: Loose) => {
  const changes = need(arr<Change>(p.changes), "changes");
  const applied: Loose[] = [];
  const skipped: Loose[] = [];
  for (const [i, change] of changes.entries()) {
    if (i > 0 && i % 25 === 0) {
      postProgress(request.requestId, `Applied ${i}/${changes.length}`, i, changes.length);
      await yieldToFigma();
    }
    try {
      applied.push(await applyOne(change));
    } catch (err) {
      skipped.push({
        nodeId: change.nodeId,
        kind: change.kind,
        ...(change.field ? { property: change.field } : {}),
        reason: err instanceof Error ? err.message : String(err),
        ...(err instanceof Skip ? {} : { error: true }),
      });
    }
  }
  return { applied, skipped };
};

/* ── dispatcher ───────────────────────────────────────────────────────────── */

export const handleQualityRequest = async (request: Request): Promise<Response | null> => {
  if (!QUALITY_TYPES.has(request.type)) return null;
  const p = (request.params ?? {}) as Loose;
  switch (request.type) {
    case "a11y_scan":
      return ok(request, await scanA11y(request, p));
    case "a11y_annotate":
      requireEditor(request.type);
      return ok(request, await annotate(p));
    case "ds_scan":
      return ok(request, await scanDs(request, p));
    case "ds_apply":
      requireEditor(request.type);
      return ok(request, await applyChanges(request, p));
    default:
      return null;
  }
};
