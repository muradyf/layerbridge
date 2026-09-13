/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
// --- Serialized paint types (discriminated union) ---
type SerializedSolidPaint = {
  type: "SOLID";
  color: string;
  opacity?: number;
};

type SerializedGradientPaint = {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientStops: { color: string; opacity: number; position: number }[];
  gradientTransform: Transform;
  opacity?: number;
};

type SerializedImagePaint = {
  type: "IMAGE";
  scaleMode: string;
  imageHash?: string | null;
  imageTransform?: Transform;
  opacity?: number;
};

type SerializedPaint = SerializedSolidPaint | SerializedGradientPaint | SerializedImagePaint;

// --- Serialized effect types ---
type SerializedShadowEffect = {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: string;
  opacity: number;
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
  blendMode: string;
};

type SerializedBlurEffect = {
  type: "LAYER_BLUR" | "BACKGROUND_BLUR";
  radius: number;
};

type SerializedEffect = SerializedShadowEffect | SerializedBlurEffect;

// --- Serialized auto-layout ---
type SerializedAutoLayout = {
  direction: "HORIZONTAL" | "VERTICAL";
  gap: number;
  primaryAxisAlign: string;
  counterAxisAlign: string;
  primaryAxisSizing: string;
  counterAxisSizing: string;
  wrap?: string;
  counterAxisSpacing?: number;
};

// --- Serialized styles ---
type SerializedStyles = {
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
  fills?: SerializedPaint[] | "mixed";
  strokes?: SerializedPaint[] | "mixed";
  strokeWeight?: number | "mixed";
  strokeAlign?: string;
  dashPattern?: number[];
  effects?: SerializedEffect[];
  cornerRadius?: number | "mixed";
  cornerRadii?: {
    topLeft: number;
    topRight: number;
    bottomRight: number;
    bottomLeft: number;
  };
  cornerSmoothing?: number;
  autoLayout?: SerializedAutoLayout;
  padding?: { top: number; right: number; bottom: number; left: number };
  clipsContent?: boolean;
  rotation?: number;
  constraints?: { horizontal: string; vertical: string };
};

type SerializedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SerializedNode = {
  id: string;
  name: string;
  type: string;
  bounds?: SerializedBounds;
  characters?: string;
  styles?: SerializedStyles;
  children?: SerializedNode[];
  childCount?: number;
};

const isMixed = (value: unknown): value is symbol => typeof value === "symbol";

const toHex = (color: RGB): string => {
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value * 255)));
  const [r, g, b] = [clamp(color.r), clamp(color.g), clamp(color.b)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const serializeGradientStops = (
  stops: readonly ColorStop[]
): { color: string; opacity: number; position: number }[] =>
  stops.map((stop) => ({
    color: toHex(stop.color),
    opacity: stop.color.a,
    position: stop.position,
  }));

const serializePaints = (
  paints: readonly Paint[] | symbol | undefined
): SerializedPaint[] | "mixed" => {
  if (isMixed(paints)) return "mixed";
  if (!paints || !Array.isArray(paints)) return [];

  return paints
    .filter((paint) => paint.visible !== false)
    .flatMap((paint): SerializedPaint[] => {
      switch (paint.type) {
        case "SOLID":
          return [
            {
              type: "SOLID",
              color: toHex(paint.color),
              opacity: paint.opacity,
            },
          ];
        case "GRADIENT_LINEAR":
        case "GRADIENT_RADIAL":
        case "GRADIENT_ANGULAR":
        case "GRADIENT_DIAMOND":
          return [
            {
              type: paint.type,
              gradientStops: serializeGradientStops(paint.gradientStops),
              gradientTransform: paint.gradientTransform,
              opacity: paint.opacity,
            },
          ];
        case "IMAGE":
          return [
            {
              type: "IMAGE",
              scaleMode: paint.scaleMode,
              imageHash: paint.imageHash,
              imageTransform: paint.imageTransform,
              opacity: paint.opacity,
            },
          ];
        default:
          return [];
      }
    });
};

const serializeEffects = (effects: readonly Effect[]): SerializedEffect[] =>
  effects
    .filter((effect) => effect.visible !== false)
    .flatMap((effect): SerializedEffect[] => {
      switch (effect.type) {
        case "DROP_SHADOW":
        case "INNER_SHADOW":
          return [
            {
              type: effect.type,
              color: toHex(effect.color),
              opacity: effect.color.a,
              offset: effect.offset,
              radius: effect.radius,
              spread: effect.spread,
              blendMode: effect.blendMode,
            },
          ];
        case "LAYER_BLUR":
        case "BACKGROUND_BLUR":
          return [{ type: effect.type, radius: effect.radius }];
        default:
          return [];
      }
    });

const serializeLineHeight = (lineHeight: LineHeight | symbol) => {
  if (isMixed(lineHeight)) return "mixed";
  if ("value" in lineHeight) {
    return { value: lineHeight.value, unit: lineHeight.unit };
  }
  return { unit: lineHeight.unit };
};

const serializeLetterSpacing = (letterSpacing: LetterSpacing | symbol) => {
  if (isMixed(letterSpacing)) return "mixed";
  return { value: letterSpacing.value, unit: letterSpacing.unit };
};

const getBounds = (node: SceneNode): SerializedBounds | undefined => {
  if ("x" in node && "y" in node && "width" in node && "height" in node) {
    return {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
  }
  return undefined;
};

const serializeText = (node: TextNode, base: SerializedNode) => {
  let fontFamily: string | undefined;
  let fontStyle: string | undefined;
  if (typeof node.fontName === "symbol") {
    fontFamily = "mixed";
    fontStyle = "mixed";
  } else if (node.fontName) {
    fontFamily = node.fontName.family;
    fontStyle = node.fontName.style;
  }
  return {
    ...base,
    characters: node.characters,
    styles: {
      ...base.styles,
      fontSize: isMixed(node.fontSize) ? "mixed" : node.fontSize,
      fontFamily,
      fontStyle,
      fontWeight: isMixed(node.fontWeight) ? "mixed" : node.fontWeight,
      textDecoration: isMixed(node.textDecoration) ? "mixed" : node.textDecoration,
      lineHeight: serializeLineHeight(node.lineHeight),
      letterSpacing: serializeLetterSpacing(node.letterSpacing),
      textAlignHorizontal: isMixed(node.textAlignHorizontal) ? "mixed" : node.textAlignHorizontal,
      textAlignVertical: isMixed(node.textAlignVertical) ? "mixed" : node.textAlignVertical,
      textAutoResize: node.textAutoResize,
    },
  };
};

const serializeStyles = (node: SceneNode): SerializedStyles => {
  const styles: SerializedStyles = {};

  if ("opacity" in node) {
    styles.opacity = node.opacity as number;
  }
  if ("blendMode" in node) {
    styles.blendMode = node.blendMode as string;
  }
  if ("visible" in node) {
    styles.visible = node.visible;
  }

  if ("fills" in node) {
    styles.fills = serializePaints(node.fills);
  }
  if ("strokes" in node) {
    styles.strokes = serializePaints(node.strokes);
  }
  if ("strokeWeight" in node) {
    styles.strokeWeight = isMixed(node.strokeWeight) ? "mixed" : (node.strokeWeight as number);
  }
  if ("strokeAlign" in node) {
    styles.strokeAlign = node.strokeAlign as string;
  }
  if ("dashPattern" in node) {
    const pattern = node.dashPattern as readonly number[];
    if (pattern.length > 0) {
      styles.dashPattern = [...pattern];
    }
  }

  if ("effects" in node) {
    const effects = node.effects as readonly Effect[];
    if (effects.length > 0) {
      styles.effects = serializeEffects(effects);
    }
  }

  if ("cornerRadius" in node) {
    styles.cornerRadius = isMixed(node.cornerRadius) ? "mixed" : (node.cornerRadius as number);
  }
  if ("topLeftRadius" in node) {
    const tl = node.topLeftRadius as number;
    const tr = node.topRightRadius as number;
    const br = node.bottomRightRadius as number;
    const bl = node.bottomLeftRadius as number;
    if (tl !== tr || tr !== br || br !== bl) {
      styles.cornerRadii = {
        topLeft: tl,
        topRight: tr,
        bottomRight: br,
        bottomLeft: bl,
      };
    }
  }
  if ("cornerSmoothing" in node) {
    const smoothing = node.cornerSmoothing as number;
    if (smoothing > 0) {
      styles.cornerSmoothing = smoothing;
    }
  }

  if ("layoutMode" in node) {
    const mode = node.layoutMode as string;
    if (mode !== "NONE") {
      styles.autoLayout = {
        direction: mode as "HORIZONTAL" | "VERTICAL",
        gap: (node as FrameNode).itemSpacing,
        primaryAxisAlign: (node as FrameNode).primaryAxisAlignItems as string,
        counterAxisAlign: (node as FrameNode).counterAxisAlignItems as string,
        primaryAxisSizing: (node as FrameNode).primaryAxisSizingMode as string,
        counterAxisSizing: (node as FrameNode).counterAxisSizingMode as string,
        wrap: "layoutWrap" in node ? (node.layoutWrap as string) : undefined,
        counterAxisSpacing:
          "counterAxisSpacing" in node ? (node.counterAxisSpacing as number) : undefined,
      };
    }
  }

  if ("paddingLeft" in node) {
    const top = node.paddingTop as number;
    const right = node.paddingRight as number;
    const bottom = node.paddingBottom as number;
    const left = node.paddingLeft as number;
    if (top > 0 || right > 0 || bottom > 0 || left > 0) {
      styles.padding = { top, right, bottom, left };
    }
  }

  if ("clipsContent" in node) {
    styles.clipsContent = node.clipsContent as boolean;
  }
  if ("rotation" in node) {
    const rotation = node.rotation as number;
    if (rotation !== 0) {
      styles.rotation = rotation;
    }
  }
  if ("constraints" in node) {
    const c = node.constraints as Constraints;
    styles.constraints = { horizontal: c.horizontal, vertical: c.vertical };
  }

  return styles;
};

export type SerializeOptions = {
  /** Keep children the design turns off (visible: false). Upstream always dropped them. */
  includeHidden?: boolean;
  /** Levels of children to include; deeper children are replaced by a childCount. */
  depth?: number;
};

/* Fields a recreation needs that upstream left out: where the node sits on the
   canvas, how it sizes inside auto-layout, which component an instance came from
   and its property values, and per-range type when a text node mixes styles. */
const serializeExtras = (node: SceneNode, base: SerializedNode): SerializedNode => {
  const extra: Record<string, unknown> = {};
  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    extra.absoluteBounds = node.absoluteBoundingBox;
  }
  if ("layoutSizingHorizontal" in node) {
    try {
      extra.layoutSizing = {
        horizontal: (node as FrameNode).layoutSizingHorizontal,
        vertical: (node as FrameNode).layoutSizingVertical,
      };
    } catch {
      // only valid inside auto-layout
    }
  }
  if ("layoutPositioning" in node && (node as FrameNode).layoutPositioning === "ABSOLUTE") {
    extra.layoutPositioning = "ABSOLUTE";
  }
  if (node.type === "INSTANCE") {
    try {
      extra.componentProperties = node.componentProperties;
    } catch {
      // unavailable for some remote components
    }
  }
  if (node.type === "TEXT") {
    try {
      if (!isMixed(node.textCase) && node.textCase !== "ORIGINAL") extra.textCase = node.textCase;
      if (
        isMixed(node.fontName) ||
        isMixed(node.fontSize) ||
        isMixed(node.fills) ||
        isMixed(node.letterSpacing) ||
        isMixed(node.lineHeight)
      ) {
        extra.textSegments = node
          .getStyledTextSegments([
            "fontName",
            "fontSize",
            "fontWeight",
            "fills",
            "letterSpacing",
            "lineHeight",
            "textDecoration",
            "textCase",
          ])
          .map((segment) => ({
            start: segment.start,
            end: segment.end,
            characters: segment.characters,
            fontFamily: segment.fontName.family,
            fontStyle: segment.fontName.style,
            fontWeight: segment.fontWeight,
            fontSize: segment.fontSize,
            fills: serializePaints(segment.fills),
            letterSpacing: serializeLetterSpacing(segment.letterSpacing),
            lineHeight: serializeLineHeight(segment.lineHeight),
            textDecoration: segment.textDecoration,
            textCase: segment.textCase,
          }));
      }
    } catch {
      // segments are best-effort
    }
  }
  return { ...base, ...extra };
};

export const serializeNode = (
  node: SceneNode,
  options: SerializeOptions = {},
  level = 0
): SerializedNode => {
  const base: SerializedNode = serializeExtras(node, {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: getBounds(node),
    styles: serializeStyles(node),
  });

  if (node.type === "TEXT") {
    return serializeText(node, base);
  }

  if ("children" in node) {
    const children = node.children.filter(
      (child) => options.includeHidden === true || child.visible !== false
    );
    if (options.depth !== undefined && level >= options.depth) {
      return { ...base, childCount: children.length };
    }
    return {
      ...base,
      children: children.map((child) => serializeNode(child, options, level + 1)),
    };
  }

  return base;
};
