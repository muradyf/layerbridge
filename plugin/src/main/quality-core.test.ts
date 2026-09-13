// @ts-expect-error bun provides bun:test at runtime; the plugin's tsconfig only loads Figma's typings.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NAME,
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
} from "./quality-core";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("geometry", () => {
  test("intersect and overlap", () => {
    expect(intersect(box(0, 0, 10, 10), box(5, 5, 10, 10))).toEqual(box(5, 5, 5, 5));
    expect(intersect(box(0, 0, 10, 10), box(10, 0, 5, 5))).toBeNull(); // touching edges do not overlap
    expect(intersect(null, box(1, 2, 3, 4))).toEqual(box(1, 2, 3, 4));
    expect(overlaps(box(0, 0, 10, 10), box(9, 9, 2, 2))).toBe(true);
  });

  test("containsBox without radius", () => {
    expect(containsBox(box(0, 0, 100, 40), box(10, 10, 80, 20))).toBe(true);
    expect(containsBox(box(0, 0, 100, 40), box(10, 10, 95, 20))).toBe(false);
  });

  test("containsBox respects rounded corners", () => {
    const pill = box(0, 0, 100, 40); // radius 20: a pill
    expect(containsBox(pill, box(20, 5, 60, 30), 20)).toBe(true);
    // A box reaching into the corner arc is not covered.
    expect(containsBox(pill, box(1, 1, 98, 38), 20)).toBe(false);
    // Radius larger than half the height is clamped.
    expect(containsBox(pill, box(20, 0, 60, 40), 999)).toBe(true);
  });

  test("rotation detection", () => {
    expect(isRotated([[1, 0, 5], [0, 1, 5]])).toBe(false);
    expect(isRotated([[2, 0, 5], [0, 2, 5]])).toBe(false);
    expect(isRotated([[0.7071, -0.7071, 0], [0.7071, 0.7071, 0]])).toBe(true);
  });
});

describe("interactive detection", () => {
  test("component names", () => {
    for (const yes of ["Button", "PrimaryButton", "Icon Button", "IconButton", "Tabs", "Checkbox / Checked", "Text input", "Link", "Toggle-switch", "chip"]) {
      expect(isInteractiveName(yes)).toBe(true);
    }
    for (const no of ["Table", "Selection", "Avatar", "Card", "Tablet frame", "Unlinked"]) {
      expect(isInteractiveName(no)).toBe(false);
    }
  });

  test("click reactions", () => {
    expect(hasClickReaction([{ trigger: { type: "ON_CLICK" } }])).toBe(true);
    expect(hasClickReaction([{ trigger: { type: "ON_HOVER" } }, { trigger: null }])).toBe(false);
    expect(hasClickReaction([{ trigger: { type: "ON_PRESS" } }])).toBe(true);
    expect(hasClickReaction(undefined)).toBe(false);
  });
});

describe("paints", () => {
  test("paintJson keeps colour, opacity, visibility and blend", () => {
    expect(paintJson({ type: "SOLID", color: { r: 1, g: 0, b: 0.5 }, opacity: 0.5 })).toEqual({ type: "SOLID", color: "#ff0080", opacity: 0.5 });
    expect(paintJson({ type: "IMAGE", visible: false, blendMode: "MULTIPLY" })).toEqual({ type: "IMAGE", opacity: 1, visible: false, blendMode: "MULTIPLY" });
    expect(rgbHex({ r: 0.4627, g: 0.4627, b: 0.4627 })).toBe("#767676");
  });

  test("opaque solid", () => {
    const white = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
    expect(isOpaqueSolid([white], 1)).toBe(true);
    expect(isOpaqueSolid([white], 0.9)).toBe(false);
    expect(isOpaqueSolid([{ ...white, opacity: 0.5 }], 1)).toBe(false);
    expect(isOpaqueSolid([white, { type: "GRADIENT_LINEAR" }], 1)).toBe(false);
    expect(isOpaqueSolid([white, { type: "GRADIENT_LINEAR", visible: false }], 1)).toBe(true);
    expect(isOpaqueSolid([{ ...white, blendMode: "MULTIPLY" }], 1)).toBe(false);
    expect(visiblePaints([white, { ...white, opacity: 0 }])).toHaveLength(1);
  });
});

describe("names", () => {
  test("default names", () => {
    expect(DEFAULT_NAME.test("Frame 12")).toBe(true);
    expect(DEFAULT_NAME.test("Rectangle 3")).toBe(true);
    expect(DEFAULT_NAME.test("Frame")).toBe(false);
    expect(DEFAULT_NAME.test("Header Frame 2")).toBe(false);
  });

  test("paths and excerpts", () => {
    expect(shortPath(["a", "b"])).toBe("a / b");
    expect(shortPath(["1", "2", "3", "4"], 2)).toBe("… / 3 / 4");
    expect(excerpt("  hello\n  world ")).toBe("hello world");
    expect(excerpt("abcdef", 4)).toBe("abc…");
  });
});
