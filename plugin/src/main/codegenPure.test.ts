import { describe, expect, test } from "bun:test";
import {
  StyleTable,
  alignOf,
  assetHint,
  capScriptResult,
  formatLogArgs,
  gradientAngle,
  justifyOf,
  layoutModeOf,
  letterSpacingOf,
  lineHeightOf,
  looksLikeIcon,
  markdownBlocks,
  scriptSource,
  slug,
  stableKey,
  toPlainJson,
  utf8Decode,
} from "./codegenPure";

describe("StyleTable", () => {
  test("dedupes regardless of key order and skips empty styles", () => {
    const t = new StyleTable("s");
    expect(t.add({ fill: "#fff", radius: 8 })).toBe("s1");
    expect(t.add({ radius: 8, fill: "#fff" })).toBe("s1");
    expect(t.add({ radius: 4 })).toBe("s2");
    expect(t.add({ opacity: undefined })).toBeUndefined();
    expect(t.entries).toEqual({ s1: { fill: "#fff", radius: 8 }, s2: { radius: 4 } });
  });
  test("stableKey sorts nested keys", () => {
    expect(stableKey({ b: [{ y: 1, x: 2 }], a: 1 })).toBe('{"a":1,"b":[{"x":2,"y":1}]}');
  });
});

describe("layout mapping", () => {
  test("modes", () => {
    expect(layoutModeOf("HORIZONTAL")).toBe("row");
    expect(layoutModeOf("HORIZONTAL", "WRAP")).toBe("wrap");
    expect(layoutModeOf("VERTICAL")).toBe("column");
    expect(layoutModeOf("GRID")).toBe("grid");
    expect(layoutModeOf("NONE")).toBe("none");
  });
  test("justify and align", () => {
    expect(justifyOf("MIN")).toBeUndefined();
    expect(justifyOf("SPACE_BETWEEN")).toBe("space-between");
    expect(alignOf("MAX")).toBe("end");
    expect(alignOf("BASELINE")).toBe("baseline");
  });
  test("line height and letter spacing", () => {
    expect(lineHeightOf({ unit: "PIXELS", value: 20.004 })).toBe(20);
    expect(lineHeightOf({ unit: "PERCENT", value: 150 })).toBe("150%");
    expect(lineHeightOf({ unit: "AUTO" })).toBe("auto");
    expect(letterSpacingOf({ unit: "PERCENT", value: -2 })).toBe("-2%");
    expect(letterSpacingOf({ unit: "PIXELS", value: 0 })).toBe(0);
  });
});

describe("icons", () => {
  const probe = { type: "INSTANCE", name: "Bell", width: 24, height: 24, vectorOnly: true, hasVectorDescendant: true };
  test("small vector-only instances are icons", () => expect(looksLikeIcon(probe)).toBe(true));
  test("vectors always are", () => expect(looksLikeIcon({ ...probe, type: "VECTOR", width: 400 })).toBe(true));
  test("big or mixed containers are not", () => {
    expect(looksLikeIcon({ ...probe, width: 56 })).toBe(false);
    expect(looksLikeIcon({ ...probe, name: "Icon / Bell", width: 56 })).toBe(true);
    expect(looksLikeIcon({ ...probe, vectorOnly: false })).toBe(false);
    expect(looksLikeIcon({ ...probe, type: "TEXT" })).toBe(false);
  });
  test("asset hint matches export_assets slugs", () => {
    expect(slug("media/icon/book")).toBe("media-icon-book");
    expect(assetHint("Icon / Bell")).toBe("icon-bell.svg");
  });
});

test("utf8Decode handles multibyte", () => {
  const bytes = new Uint8Array([60, 116, 62, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
  expect(utf8Decode(bytes)).toBe("<t>é€😀");
});

test("markdownBlocks", () => {
  const md = "# Button\n\nA **primary** action.\nSecond line.\n\n## Properties\n| Name | Type |\n|---|---|\n| `Size` | VARIANT |\n- one\n```\ncode\n```\n<!-- note -->";
  expect(markdownBlocks(md)).toEqual([
    { kind: "h1", text: "Button" },
    { kind: "p", text: "A primary action. Second line." },
    { kind: "h2", text: "Properties" },
    { kind: "code", text: "Name  ·  Type" },
    { kind: "code", text: "Size  ·  VARIANT" },
    { kind: "li", text: "one" },
    { kind: "code", text: "code" },
  ]);
});

describe("gradientAngle", () => {
  test("identity runs left to right = 90deg", () => expect(gradientAngle([[1, 0, 0], [0, 1, 0]])).toBe(90));
  test("top to bottom = 180deg", () => expect(gradientAngle([[0, 1, 0], [-1, 0, 1]])).toBe(180));
});

describe("run_script result", () => {
  test("nodes, mixed, cycles, typed arrays", () => {
    const node = { id: "1:2", name: "Card", type: "FRAME", parent: null, children: [] };
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const out = toPlainJson({ node, mixed: Symbol("figma.mixed"), cyc, bytes: new Uint8Array(4), fn: () => 1, u: undefined, n: NaN });
    expect(out).toEqual({
      node: { id: "1:2", name: "Card", type: "FRAME" },
      mixed: "mixed",
      cyc: { a: 1, self: "[circular]" },
      bytes: { bytes: 4 },
      fn: "[function]",
      n: "NaN",
    });
  });
  test("dates become ISO strings, as JSON.stringify would write them (a real run returned {})", () => {
    expect(toPlainJson({ d: new Date(0), bad: new Date("nope") })).toEqual({ d: "1970-01-01T00:00:00.000Z", bad: "Invalid Date" });
  });
  test("shared references are not treated as cycles", () => {
    const shared = { x: 1 };
    expect(toPlainJson([shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
  });
  test("caps size", () => {
    const big = "x".repeat(500);
    const r = capScriptResult({ big }, 100);
    expect(typeof r.result).toBe("string");
    expect((r.result as string).length).toBe(100);
    expect(r.truncated).toContain("characters");
    expect(capScriptResult({ a: 1 }).truncated).toBeUndefined();
  });
  test("log formatting", () => {
    expect(formatLogArgs(["n", 3, { a: 1 }])).toBe('n 3 {"a":1}');
    expect(formatLogArgs(["y".repeat(20)], 5)).toBe("yyyyy…");
  });
  test("script source is an async body", async () => {
    const fn = new Function("figma", "console", scriptSource("await null; return figma.x + 1;"));
    expect(await fn({ x: 1 }, console)).toBe(2);
  });
});
