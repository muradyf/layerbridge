// Unit tests for the pure quality logic (colour math, sampling, targets, lint).
// Run: bun run build && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const q = await import(pathToFileURL(path.join(here, "..", "dist", "quality-core.js")).href);

const hex = (h) => q.parseHex(h);
const near = (actual, expected, tol, label = "") =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ${expected} ± ${tol}, got ${actual}`);

test("WCAG contrast ratios match known values", () => {
  assert.equal(q.displayRatio(q.contrastRatio(hex("#767676"), hex("#ffffff"))), 4.54);
  assert.equal(q.displayRatio(q.contrastRatio(hex("#777777"), hex("#ffffff"))), 4.47);
  assert.equal(q.contrastRatio(hex("#000000"), hex("#ffffff")), 21);
  assert.equal(q.contrastRatio(hex("#123456"), hex("#123456")), 1);
  // Order does not matter.
  assert.equal(q.contrastRatio(hex("#ffffff"), hex("#767676")), q.contrastRatio(hex("#767676"), hex("#ffffff")));
  // #595959 on white is the classic AAA-passing grey (7.0:1).
  assert.equal(q.displayRatio(q.contrastRatio(hex("#595959"), hex("#ffffff"))), 7);
});

test("ratios are truncated, never rounded up to a pass", () => {
  assert.equal(q.displayRatio(4.4999), 4.49);
  assert.equal(q.displayRatio(2.849), 2.84);
});

test("large text and required ratios", () => {
  assert.equal(q.isLargeText(24, 400), true);
  assert.equal(q.isLargeText(18.66, 700), true);
  assert.equal(q.isLargeText(18.66, 400), false);
  assert.equal(q.isLargeText(18, 700), false);
  assert.equal(q.requiredContrast("AA", false), 4.5);
  assert.equal(q.requiredContrast("AA", true), 3);
  assert.equal(q.requiredContrast("AAA", false), 7);
  assert.equal(q.requiredContrast("AAA", true), 4.5);
  assert.equal(q.contrastCriterion("AAA"), "1.4.6");
});

test("APCA Lc matches the reference implementation", () => {
  near(q.apcaContrast(hex("#888888"), hex("#ffffff")), 63.06, 0.1, "#888 on #fff");
  near(q.apcaContrast(hex("#ffffff"), hex("#888888")), -68.54, 0.1, "#fff on #888");
  near(q.apcaContrast(hex("#000000"), hex("#ffffff")), 106.04, 0.1, "#000 on #fff");
  assert.equal(q.apcaContrast(hex("#777777"), hex("#777777")), 0);
});

test("source-over compositing", () => {
  const half = q.over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 1 });
  near(half.r, 0.5, 1e-9);
  assert.equal(half.a, 1);
  const twoHalves = q.over({ r: 1, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 1, a: 0.5 });
  near(twoHalves.a, 0.75, 1e-9);
  near(twoHalves.r, 0.5 / 0.75, 1e-9);
  assert.deepEqual(q.over(q.TRANSPARENT, q.TRANSPARENT), q.TRANSPARENT);
});

test("fills flatten bottom to top and refuse gradients and blends", () => {
  const flat = q.flattenFills([{ type: "SOLID", color: "#ffffff" }, { type: "SOLID", color: "#000000", opacity: 0.5 }], 1);
  near(flat.color.r, 0.5, 1e-9);
  const faded = q.flattenFills([{ type: "SOLID", color: "#000000" }], 0.4);
  near(faded.color.a, 0.4, 1e-9);
  assert.match(q.flattenFills([{ type: "GRADIENT_LINEAR" }]).reason, /gradient linear/);
  assert.match(q.flattenFills([{ type: "SOLID", color: "#000", blendMode: "MULTIPLY" }]).reason, /MULTIPLY/);
  assert.equal(q.flattenFills([{ type: "IMAGE", visible: false }, { type: "SOLID", color: "#fff" }]).color.a, 1);
});

test("background resolution composites down to the first opaque layer", () => {
  const scrim = { nodeId: "1", fills: [{ type: "SOLID", color: "#000000", opacity: 0.5 }] };
  const card = { nodeId: "2", fills: [{ type: "SOLID", color: "#ffffff" }] };
  const photo = { nodeId: "3", fills: [{ type: "IMAGE" }] };
  const bg = q.resolveBackground([scrim, card, photo]);
  near(bg.color.r, 0.5, 1e-9);
  assert.deepEqual(bg.contributing, ["1", "2"]); // the photo is hidden by the opaque card
  assert.equal(bg.usedCanvas, false);

  const sample = q.resolveBackground([scrim, photo]);
  assert.equal(sample.needsPixelSample, true);
  assert.match(sample.reason, /image fill/);
  assert.equal(q.resolveBackground([{ ...card, partial: true }]).needsPixelSample, true);
  assert.equal(q.resolveBackground([{ ...card, backgroundBlur: true }]).needsPixelSample, true);
  assert.equal(q.resolveBackground([{ ...card, blendMode: "MULTIPLY" }]).needsPixelSample, true);

  const canvas = q.resolveBackground([scrim], { r: 0, g: 0, b: 1 });
  assert.equal(canvas.usedCanvas, true);
  near(canvas.color.b, 0.5, 1e-9);
  // Invisible layers do not count, even when they are partial.
  assert.equal(q.resolveBackground([{ nodeId: "x", fills: [{ type: "IMAGE", visible: false }], partial: true }, card]).color.r, 1);
});

test("translucent text is judged by what it looks like", () => {
  const eff = q.effectiveForeground({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1 });
  near(eff.r, 0.5, 1e-9);
});

test("CIELAB conversion", () => {
  const white = q.rgbToLab(hex("#ffffff"));
  near(white.L, 100, 1e-3);
  near(white.a, 0, 1e-2);
  near(white.b, 0, 1e-2);
  const black = q.rgbToLab(hex("#000000"));
  near(black.L, 0, 1e-9);
  const red = q.rgbToLab(hex("#ff0000"));
  near(red.L, 53.24, 0.01);
  near(red.a, 80.09, 0.02);
  near(red.b, 67.2, 0.02);
});

test("CIEDE2000 matches Sharma, Wu and Dalal's test data", () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  ];
  for (const [[L1, a1, b1], [L2, a2, b2], expected] of pairs) {
    near(q.deltaE2000({ L: L1, a: a1, b: b1 }, { L: L2, a: a2, b: b2 }), expected, 1e-4, `pair ${L1},${a1},${b1}`);
    near(q.deltaE2000({ L: L2, a: a2, b: b2 }, { L: L1, a: a1, b: b1 }), expected, 1e-4, "symmetric");
  }
  assert.equal(q.deltaE(hex("#336699"), hex("#336699")), 0);
  // kL = 2 halves a pure lightness difference's weight.
  const grey = [q.rgbToLab(hex("#999999")), q.rgbToLab(hex("#333333"))];
  near(q.deltaE2000(grey[0], grey[1], 2), q.deltaE2000(grey[0], grey[1]) / 2, 1e-9);
});

const tokens = {
  collections: [
    { id: "c1", name: "Color", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Light" }, { modeId: "m2", name: "Dark" }] },
    { id: "c2", name: "Space", defaultModeId: "s1", modes: [{ modeId: "s1", name: "Base" }] },
  ],
  variables: [
    { id: "v1", name: "brand/500", collectionId: "c1", resolvedType: "COLOR", scopes: ["ALL_FILLS"], valuesByMode: { m1: "#7c3aed", m2: "#a78bfa" } },
    { id: "v2", name: "text/primary", collectionId: "c1", resolvedType: "COLOR", scopes: ["TEXT_FILL"], valuesByMode: { m1: { alias: "v3" }, m2: "#ffffff" } },
    { id: "v3", name: "gray/900", collectionId: "c1", resolvedType: "COLOR", scopes: [], valuesByMode: { m1: "#111111", m2: "#111111" } },
    { id: "v4", name: "space/16", collectionId: "c2", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { s1: 16 } },
    { id: "v5", name: "radius/8", collectionId: "c2", resolvedType: "FLOAT", scopes: ["CORNER_RADIUS"], valuesByMode: { s1: 8 } },
    { id: "v6", name: "space/8", collectionId: "c2", resolvedType: "FLOAT", scopes: ["GAP"], valuesByMode: { s1: 8 } },
    { id: "v7", name: "overlay", collectionId: "c1", resolvedType: "COLOR", scopes: ["ALL_SCOPES"], valuesByMode: { m1: "#00000080", m2: "#00000080" } },
  ],
  paintStyles: [{ id: "S:1", name: "Surface", paints: [{ type: "SOLID", color: "#ffffff", opacity: 1 }] }],
  textStyles: [
    { id: "S:t1", name: "Body/16", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PERCENT", value: 150 }, letterSpacing: { unit: "PIXELS", value: 0 } },
    { id: "S:t2", name: "Body/14", fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 } },
  ],
};

test("variables resolve through aliases in the consumer's mode", () => {
  assert.equal(q.resolveVariable(tokens, "v2"), "#111111");
  assert.equal(q.resolveVariable(tokens, "v2", { c1: "m2" }), "#ffffff");
  assert.equal(q.resolveVariable(tokens, "v1", { c1: "unknown-mode" }), "#7c3aed");
  assert.equal(q.resolveVariable(tokens, "nope"), undefined);
  const loop = { ...tokens, variables: [{ id: "a", collectionId: "c1", resolvedType: "COLOR", valuesByMode: { m1: { alias: "a" } } }] };
  assert.equal(q.resolveVariable(loop, "a"), undefined);
});

test("scopes decide which variables are offered", () => {
  assert.equal(q.scopeAllows(tokens.variables[0], "frame-fill"), true);
  assert.equal(q.scopeAllows(tokens.variables[0], "stroke"), false);
  assert.equal(q.scopeAllows(tokens.variables[2], "text-fill"), false); // no scopes: hidden from pickers
  assert.equal(q.scopeAllows({ ...tokens.variables[0], scopes: undefined }, "stroke"), true);
});

test("colour matching: exact first, variables over styles, alpha must agree, ΔE limit", () => {
  const frame = q.colorCandidates(tokens, {}, "frame-fill");
  assert.equal(q.matchColor(hex("#7c3aed"), frame, 2).id, "v1");
  const almostWhite = q.matchColor(hex("#fefefe"), frame, 2);
  assert.equal(almostWhite.id, "S:1");
  assert.equal(almostWhite.exact, false);
  assert.ok(almostWhite.deltaE > 0 && almostWhite.deltaE < 1);
  assert.equal(q.matchColor(hex("#f0f0f0"), frame, 2), null);
  assert.equal(q.matchColor({ ...hex("#7c3aed"), a: 0.5 }, frame, 2), null);
  assert.equal(q.matchColor({ r: 0, g: 0, b: 0, a: 128 / 255 }, frame, 2).id, "v7");
  const text = q.colorCandidates(tokens, { c1: "m1" }, "text-fill");
  assert.equal(q.matchColor(hex("#111111"), text, 2).id, "v2");
  const both = [{ kind: "style", id: "s", name: "s", color: hex("#123456") }, { kind: "variable", id: "v", name: "v", color: hex("#123456") }];
  assert.equal(q.matchColor(hex("#123456"), both, 2).id, "v");
});

test("float matching and scales", () => {
  assert.deepEqual(q.matchFloat(tokens, 16, {}, "gap"), { id: "v4", name: "space/16", value: 16, exact: true, difference: 0 });
  assert.equal(q.matchFloat(tokens, 8, {}, "gap").id, "v6");
  assert.equal(q.matchFloat(tokens, 8, {}, "radius").id, "v5");
  assert.equal(q.matchFloat(tokens, 13, {}, "gap").exact, false);
  assert.deepEqual(q.inferScale(tokens, "gap"), [8, 16]);
  assert.deepEqual(q.inferScale(tokens, "radius"), [8]);
  assert.equal(q.nearestOnScale(11, [4, 8, 16]), 8);
  assert.equal(q.nearestOnScale(13, [4, 8, 16]), 16);
});

test("text style matching compares line height and spacing in pixels", () => {
  const exact = q.matchTextStyle({ fontFamily: "inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PIXELS", value: 24 }, letterSpacing: { unit: "PERCENT", value: 0 } }, tokens.textStyles);
  assert.deepEqual(exact, { id: "S:t1", name: "Body/16", exact: true, differences: [] });
  const near14 = q.matchTextStyle({ fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeight: { unit: "PIXELS", value: 20 } }, tokens.textStyles);
  assert.equal(near14.id, "S:t2");
  assert.equal(near14.exact, false);
  assert.match(near14.differences[0], /lineHeight/);
  assert.equal(q.matchTextStyle({ fontFamily: "Roboto", fontStyle: "Regular", fontSize: 16 }, tokens.textStyles), null);
});

test("target size: undersized, spacing exception, and crowding", () => {
  const results = q.checkTargets(
    [
      { nodeId: "a", x: 0, y: 0, width: 20, height: 20 },
      { nodeId: "b", x: 22, y: 0, width: 20, height: 20 },
      { nodeId: "c", x: 300, y: 300, width: 16, height: 16 },
      { nodeId: "d", x: 500, y: 0, width: 48, height: 48 },
      { nodeId: "e", x: 520, y: 52, width: 10, height: 10 },
    ],
    24
  );
  const by = Object.fromEntries(results.map((r) => [r.nodeId, r]));
  assert.deepEqual(by.a, { nodeId: "a", undersized: true, spacingException: false });
  assert.equal(by.b.spacingException, false);
  assert.equal(by.c.spacingException, true);
  assert.equal(by.d.undersized, false);
  assert.equal(by.e.spacingException, false); // its circle reaches the 48px target above
});

/** RGBA pixels: `paint(x, y)` returns [r, g, b, a] in 0..255. */
const image = (width, height, paint) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
};

test("background sampling ignores glyphs and antialiasing and finds the worst background", () => {
  const px = image(100, 40, (x, y) => {
    if (y >= 18 && y <= 21 && x >= 10 && x < 90) return [255, 255, 255, 255]; // glyphs
    if ((y === 17 || y === 22) && x >= 10 && x < 90) return x < 70 ? [187, 187, 187, 255] : [153, 204, 255, 255]; // antialiasing
    return x < 70 ? [0x76, 0x76, 0x76, 255] : [0x33, 0x99, 0xff, 255];
  });
  const s = q.sampleBackground(px, { x: 0, y: 0, width: 100, height: 40 }, hex("#ffffff"));
  assert.equal(s.clusters.length, 2);
  assert.equal(q.toHex(s.typical.color), "#767676");
  assert.equal(q.toHex(s.worst.color), "#3399ff");
  near(s.typical.share, 0.7, 0.03);
});

test("background sampling composites transparency over the canvas and handles empty areas", () => {
  const clear = image(10, 10, () => [0, 0, 0, 0]);
  const s = q.sampleBackground(clear, { x: 0, y: 0, width: 10, height: 10 }, hex("#000000"), { canvas: hex("#1e1e1e") });
  assert.equal(q.toHex(s.typical.color), "#1e1e1e");
  assert.equal(q.sampleBackground(clear, { x: 20, y: 20, width: 5, height: 5 }, hex("#000000")), null);
  const allText = image(10, 10, () => [0, 0, 0, 255]);
  assert.equal(q.sampleBackground(allText, { x: 0, y: 0, width: 10, height: 10 }, hex("#000000")), null);
});

test("a large translucent-over-grey gradient keeps its real clusters", () => {
  // A background that is genuinely two greys covering half each is not antialiasing.
  const px = image(40, 10, (x) => (x < 20 ? [0x40, 0x40, 0x40, 255] : [0x80, 0x80, 0x80, 255]));
  const s = q.sampleBackground(px, { x: 0, y: 0, width: 40, height: 10 }, hex("#ffffff"));
  assert.equal(s.clusters.length, 2);
  assert.equal(q.toHex(s.worst.color), "#808080");
});

test("text colour suggestion picks the nearest file colour that passes", () => {
  const candidates = q.colorCandidates(tokens, {}, "any", false);
  const s = q.suggestTextColor(hex("#999999"), hex("#ffffff"), 4.5, candidates);
  assert.equal(s.variableId, "v2"); // text/primary (#111111) is nearer to #999 than brand/500
  assert.equal(q.suggestTextColor(hex("#999999"), hex("#ffffff"), 22, candidates), null);
});

const nodes = [
  {
    id: "1:1", name: "Frame 12", type: "FRAME", defaultName: true,
    paints: [{ field: "fills", index: 0, paintCount: 1, color: "#7c3aed", opacity: 1 }],
    spacing: [{ field: "itemSpacing", value: 16, bound: false }, { field: "paddingLeft", value: 12, bound: false }, { field: "paddingTop", value: 8, bound: true }],
    radius: [{ field: "cornerRadius", value: 8, bound: false }],
  },
  {
    id: "1:2", name: "Title", type: "TEXT", modes: { c1: "m1" },
    paints: [{ field: "fills", index: 0, paintCount: 1, color: "#111111", opacity: 1 }],
    text: { whole: true, segments: [{ start: 0, end: 5, fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PIXELS", value: 24 }, letterSpacing: { unit: "PERCENT", value: 0 } }] },
  },
  { id: "1:3", name: "Card bg", type: "RECTANGLE", paints: [{ field: "fills", index: 0, paintCount: 1, color: "#fefefe", opacity: 1 }] },
  { id: "1:4", name: "Old button", type: "FRAME", detached: { type: "local", componentId: "9:9" } },
  { id: "1:5", name: "Spare", type: "FRAME", hidden: true },
  { id: "1:6", name: "Two paints", type: "RECTANGLE", paints: [{ field: "fills", index: 1, paintCount: 2, color: "#ffffff", opacity: 1 }] },
  {
    id: "1:7", name: "Caption", type: "TEXT",
    text: { whole: false, segments: [{ start: 3, end: 9, fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: { unit: "PERCENT", value: 150 } }] },
  },
];

test("lint reports every rule with suggestions and a score", () => {
  const r = q.lintDesignSystem(nodes, tokens);
  assert.equal(r.byRule["unbound-color"], 4);
  assert.equal(r.byRule["unbound-spacing"], 2);
  assert.equal(r.byRule["off-scale-spacing"], 1);
  assert.equal(r.byRule["unbound-radius"], 1);
  assert.equal(r.byRule["off-scale-radius"], 0);
  assert.equal(r.byRule["default-name"], 1);
  assert.equal(r.byRule["detached-instance"], 1);
  assert.equal(r.byRule["hidden-layer"], 1);
  assert.equal(r.byRule["text-without-style"], 2);
  assert.deepEqual(r.scales.spacing, [8, 16]);
  assert.ok(r.score > 0 && r.score < 100);
  const title = r.issues.find((i) => i.nodeId === "1:2" && i.rule === "unbound-color");
  assert.equal(title.suggestion.variableId, "v2");
  assert.equal(title.suggestion.exact, true);
  const padding = r.issues.find((i) => i.property === "paddingLeft" && i.rule === "unbound-spacing");
  assert.equal(padding.suggestion.exact, false);
  assert.equal(padding.fix, undefined);
  const offScale = r.issues.find((i) => i.rule === "off-scale-spacing");
  assert.equal(offScale.suggestion.nearest, 8);

  const onlyNames = q.lintDesignSystem(nodes, tokens, { rules: ["default-name"] });
  assert.equal(onlyNames.issues.length, 1);
  const givenScale = q.lintDesignSystem(nodes, tokens, { rules: ["off-scale-spacing"], spacingScale: [4, 12, 16] });
  assert.equal(givenScale.issues.length, 0);
});

test("fix planning keeps safe changes and explains the rest", () => {
  const { issues } = q.lintDesignSystem(nodes, tokens);
  const { changes, skipped } = q.planFixes(issues);
  const kinds = changes.map((c) => `${c.kind}:${c.nodeId}:${c.field ?? ""}`).sort();
  assert.deepEqual(kinds, [
    "float-variable:1:1:cornerRadius",
    "float-variable:1:1:itemSpacing",
    "paint-style:1:3:fills",
    "paint-variable:1:1:fills",
    "paint-variable:1:2:fills",
    "text-style:1:2:",
  ]);
  const style = changes.find((c) => c.kind === "paint-style");
  assert.deepEqual(style.expected, { color: "#ffffff", opacity: 1 });
  assert.deepEqual(style.before, { color: "#fefefe", opacity: 1 });
  const reasons = Object.fromEntries(skipped.map((s) => [`${s.nodeId}:${s.property}`, s.reason]));
  assert.match(reasons["1:1:paddingLeft"], /nearest variable "space\/16" is 16, not 12/);
  assert.match(reasons["1:6:fills[1]"], /only the colour style "Surface" matches/);
  assert.match(reasons["1:7:chars 3-9"], /part of it already has a style/);
  // Rules outside the fixable set are ignored.
  assert.equal(q.planFixes(issues, ["default-name"]).changes.length, 0);
});

test("report helpers sort failures first and render markdown", () => {
  const sorted = q.sortIssues([
    { severity: "warn", check: "targets" },
    { severity: "fail", check: "contrast", ratio: 3 },
    { severity: "fail", check: "contrast", ratio: 2 },
  ]);
  assert.deepEqual(sorted.map((i) => `${i.severity}:${i.ratio ?? ""}`), ["fail:2", "fail:3", "warn:"]);
  assert.equal(q.a11yScore(10, 4, 2), 55);
  assert.equal(q.a11yScore(0, 0, 0), 100);
  const md = q.a11yMarkdown({
    root: { id: "1:0", name: "Screen" },
    level: "AA",
    summary: { checked: 1, failures: 1, warnings: 0, score: 0 },
    issues: [{ severity: "fail", check: "contrast", wcag: "1.4.3", nodeId: "1:1", name: "A|B", ratio: 2.84, required: 4.5, foreground: "#999999", background: "#ffffff", method: "computed" }],
  });
  assert.match(md, /2\.84:1 \(needs 4\.5:1\)/);
  assert.match(md, /A\\\|B/);
});
