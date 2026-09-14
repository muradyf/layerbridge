import { describe, expect, test } from "bun:test";
import { parseStyleName, pickStyle } from "./fontMatch";

const INTER = [
  "Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black",
  "Thin Italic", "Italic", "Medium Italic", "Semi Bold Italic", "Bold Italic",
];

describe("pickStyle", () => {
  test("Inter's spaced names match CSS weights (600 used to fall back to Regular)", () => {
    expect(pickStyle(INTER, 600)).toBe("Semi Bold");
    expect(pickStyle(INTER, 800)).toBe("Extra Bold");
    expect(pickStyle(INTER, 200)).toBe("Extra Light");
    expect(pickStyle(INTER, 400)).toBe("Regular");
  });

  test("italic picks the italic of the nearest weight, and falls back to upright when the family has none", () => {
    expect(pickStyle(INTER, 600, true)).toBe("Semi Bold Italic");
    expect(pickStyle(INTER, 400, true)).toBe("Italic");
    expect(pickStyle(["Regular", "Bold"], 700, true)).toBe("Bold");
  });

  test("missing weights follow CSS matching order", () => {
    const roboto = ["Regular", "Medium", "Bold"];
    expect(pickStyle(roboto, 600)).toBe("Bold");
    expect(pickStyle(roboto, 450)).toBe("Medium");
    expect(pickStyle(roboto, 300)).toBe("Regular");
    expect(pickStyle(["Light", "Bold"], 450)).toBe("Light");
    expect(pickStyle(["Regular", "Black"], 800)).toBe("Black");
  });

  test("other spellings", () => {
    expect(pickStyle(["Regular", "SemiBold"], 600)).toBe("SemiBold");
    expect(pickStyle(["Book", "Demibold", "Heavy"], 900)).toBe("Heavy");
    expect(pickStyle(["Book", "Demibold"], 600)).toBe("Demibold");
  });

  test("width and optical-size styles are not candidates", () => {
    expect(pickStyle(["Condensed Bold", "Display"], 700)).toBeNull();
    expect(pickStyle(["Condensed Bold", "Regular"], 700)).toBe("Regular");
    expect(parseStyleName("Oblique")).toEqual({ style: "Oblique", weight: 400, italic: true });
  });
});
