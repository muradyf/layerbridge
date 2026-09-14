import { describe, expect, test } from "bun:test";
import { DEFAULT_LABEL_FONT, clip, labelFont, nearestColorName, resolvePaletteColor, slideRowsOf, tableCells, validateSlideGrid } from "./boardsPure";

const palette = { gray: "#E6E6E6", yellow: "#FFEC78", lightGray: "#F5F5F5", red: "#FFAFA3" };

describe("sticky colours", () => {
  test("names resolve regardless of case and spacing; hex passes through", () => {
    expect(resolvePaletteColor("Yellow", palette)).toBe("#FFEC78");
    expect(resolvePaletteColor("light gray", palette)).toBe("#F5F5F5");
    expect(resolvePaletteColor("light-gray", palette)).toBe("#F5F5F5");
    expect(resolvePaletteColor("#123abc", palette)).toBe("#123abc");
    expect(resolvePaletteColor("abc", palette)).toBe("#abc");
    expect(resolvePaletteColor("chartreuse", palette)).toBeUndefined();
  });

  test("the nearest palette name, exact first", () => {
    expect(nearestColorName("#ffec78", palette)).toBe("yellow");
    expect(nearestColorName("#FFA0A0", palette)).toBe("red");
    expect(nearestColorName("nope", palette)).toBeUndefined();
    expect(nearestColorName("#000", {})).toBeUndefined();
  });
});

describe("validateSlideGrid", () => {
  const current = [["1:1", "1:2"], ["1:3"]];
  test("a reordering that keeps every slide is valid", () => {
    expect(validateSlideGrid(current, [["1:3", "1:1"], ["1:2"]])).toBeNull();
    expect(validateSlideGrid(current, [["1:3", "1:1", "1:2"]])).toBeNull();
  });

  test("missing, unknown, duplicated and empty rows are all named", () => {
    const msg = validateSlideGrid(current, [["1:1", "1:1", "9:9"], []])!;
    expect(msg).toContain("missing slides: 1:2, 1:3");
    expect(msg).toContain("not slides in this deck: 9:9");
    expect(msg).toContain("listed more than once: 1:1");
    expect(msg).toContain("empty rows: 1");
    expect(validateSlideGrid(current, [])).toContain("at least one row");
  });
});

describe("tableCells", () => {
  test("fills gaps with empty strings", () => {
    expect(tableCells(2, 3, [["a"], ["b", "c"]])).toEqual([
      ["a", "", ""],
      ["b", "c", ""],
    ]);
    expect(tableCells(1, 2)).toEqual([["", ""]]);
  });

  test("refuses cells that do not fit", () => {
    expect(() => tableCells(1, 1, [["a"], ["b"]])).toThrow(/2 rows/);
    expect(() => tableCells(1, 1, [["a", "b"]])).toThrow(/2 entries/);
  });
});

test("clip", () => {
  expect(clip("hello", 10)).toBe("hello");
  expect(clip("hello world", 6)).toBe("hello…");
});

test("labelFont: a new connector's empty font becomes FigJam's; a real font is kept", () => {
  expect(labelFont({ family: "", style: "" })).toEqual(DEFAULT_LABEL_FONT);
  const kept = { family: "Roboto", style: "Bold" };
  expect(labelFont(kept)).toBe(kept);
});

describe("slideRowsOf", () => {
  type N = { type: string; id?: string; children?: N[] };
  const slide = (id: string): N => ({ type: "SLIDE", id });

  test("reads rows and slides in layer order, skipping anything that is not a slide", () => {
    const page: N = {
      type: "PAGE",
      children: [
        { type: "FRAME", id: "stray" },
        {
          type: "SLIDE_GRID",
          children: [
            { type: "SLIDE_ROW", children: [slide("1:42"), slide("1:82"), { type: "TEXT", id: "t" }] },
            { type: "SLIDE_ROW", children: [slide("1:84")] },
          ],
        },
      ],
    };
    expect(slideRowsOf(page)?.map((row) => row.map((s) => s.id))).toEqual([["1:42", "1:82"], ["1:84"]]);
  });

  test("null without a slide grid, so the caller can fall back to the API", () => {
    expect(slideRowsOf({ type: "PAGE", children: [{ type: "FRAME" }] })).toBeNull();
  });
});
