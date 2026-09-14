// CSS background-image gradients -> Figma paints (browser/css-gradient.js, used by import_url).
// Run: node --test test/css-gradient.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradientPaints, splitTopLevel } from "../browser/css-gradient.js";

/** Where a point of the layer's unit square lands on the gradient (0 = start, 1 = end). */
const along = ([[a, b, c]], u, v) => a * u + b * v + c;
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

test("splitTopLevel ignores commas inside functions", () => {
  assert.deepEqual(splitTopLevel("linear-gradient(rgb(1, 2, 3), red), url(a.png)"), ["linear-gradient(rgb(1, 2, 3), red)", "url(a.png)"]);
});

test("90deg runs left to right with Figma's identity row", () => {
  const { paints, skipped } = gradientPaints("linear-gradient(90deg, rgb(253, 186, 116), rgb(249, 115, 22))", 260, 120);
  assert.deepEqual(skipped, []);
  assert.equal(paints.length, 1);
  assert.equal(paints[0].type, "GRADIENT_LINEAR");
  const [a, b, c] = paints[0].gradientTransform[0];
  near(a, 1, "a");
  near(b, 0, "b");
  near(c, 0, "c");
  assert.deepEqual(paints[0].gradientStops.map((s) => s.position), [0, 1]);
  near(paints[0].gradientStops[0].color.r, 253 / 255, "start red");
  assert.equal(paints[0].gradientStops[1].color.a, 1);
});

test("no direction means top to bottom", () => {
  const { paints } = gradientPaints("linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))", 100, 40);
  const t = paints[0].gradientTransform;
  near(along(t, 0.3, 0), 0, "top");
  near(along(t, 0.7, 1), 1, "bottom");
});

test("an angle reaches 0 and 1 exactly at the far corners", () => {
  const { paints } = gradientPaints("linear-gradient(45deg, rgb(0, 0, 0), rgb(255, 255, 255))", 200, 100);
  const t = paints[0].gradientTransform;
  near(along(t, 0, 1), 0, "bottom-left");
  near(along(t, 1, 0), 1, "top-right");
  near(along(t, 0.5, 0.5), 0.5, "centre");
});

test("a corner keyword puts the other two corners on the 50% line", () => {
  const { paints } = gradientPaints("linear-gradient(to top right, rgb(0, 0, 0), rgb(255, 255, 255))", 200, 100);
  const t = paints[0].gradientTransform;
  near(along(t, 0, 1), 0, "bottom-left");
  near(along(t, 1, 0), 1, "top-right");
  near(along(t, 0, 0), 0.5, "top-left");
  near(along(t, 1, 1), 0.5, "bottom-right");
});

test("side keywords and turn units", () => {
  const left = gradientPaints("linear-gradient(to left, rgb(0, 0, 0), rgb(255, 255, 255))", 50, 50).paints[0].gradientTransform;
  near(along(left, 1, 0.5), 0, "right edge starts");
  const turn = gradientPaints("linear-gradient(0.25turn, rgb(0, 0, 0), rgb(255, 255, 255))", 50, 80).paints[0].gradientTransform;
  near(along(turn, 1, 0.2), 1, "quarter turn ends on the right");
});

test("stop positions: %, px against the line length, unpositioned stops spread evenly, alpha kept", () => {
  const { paints } = gradientPaints("linear-gradient(90deg, rgb(255, 0, 0) 20%, rgba(0, 0, 255, 0.5), rgb(0, 255, 0) 100px)", 200, 50);
  const stops = paints[0].gradientStops;
  assert.deepEqual(stops.map((s) => Number(s.position.toFixed(6))), [0.2, 0.35, 0.5]);
  assert.equal(stops[1].color.a, 0.5);
});

test("a stop placed before an earlier one is pulled forward, and out-of-range positions clamp", () => {
  const { paints } = gradientPaints("linear-gradient(90deg, rgb(0, 0, 0) -10%, rgb(1, 1, 1) 60%, rgb(2, 2, 2) 30%, rgb(3, 3, 3) 120%)", 100, 100);
  assert.deepEqual(paints[0].gradientStops.map((s) => s.position), [0, 0.6, 0.6, 1]);
});

test("a colour stop with two positions becomes two stops", () => {
  const { paints } = gradientPaints("linear-gradient(90deg, rgb(0, 0, 0) 0% 40%, rgb(255, 255, 255))", 100, 100);
  assert.deepEqual(paints[0].gradientStops.map((s) => s.position), [0, 0.4, 1]);
});

test("stacked images: CSS's first image ends up as Figma's last (top) fill; url() is left alone", () => {
  const { paints, skipped } = gradientPaints(
    "linear-gradient(90deg, rgb(255, 0, 0), rgb(255, 0, 0)), url(\"a.png\"), linear-gradient(rgb(0, 0, 255), rgb(0, 0, 255))",
    10,
    10
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(paints.map((p) => p.gradientStops[0].color.b), [1, 0]);
});

test("the default radial gradient maps; positioned radials and other kinds are reported, not guessed", () => {
  const plain = gradientPaints("radial-gradient(rgb(255, 255, 255), rgb(0, 0, 0))", 100, 50);
  assert.equal(plain.paints[0].type, "GRADIENT_RADIAL");
  assert.equal(gradientPaints("radial-gradient(ellipse at center, rgb(255, 255, 255), rgb(0, 0, 0))", 100, 50).paints.length, 1);
  const bad = [
    "radial-gradient(circle at 10% 20%, rgb(255, 255, 255), rgb(0, 0, 0))",
    "repeating-linear-gradient(90deg, rgb(0, 0, 0) 0px, rgb(255, 255, 255) 10px)",
    "conic-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
    "linear-gradient(90deg, rgb(0, 0, 0) calc(10% + 2px), rgb(255, 255, 255))",
    "linear-gradient(90deg, rgb(0, 0, 0), 30%, rgb(255, 255, 255))",
  ];
  for (const css of bad) {
    const { paints, skipped } = gradientPaints(css, 100, 50);
    assert.equal(paints.length, 0, css);
    assert.deepEqual(skipped, [css]);
  }
});

test("transparent and a zero-size layer", () => {
  const { paints } = gradientPaints("linear-gradient(transparent, rgb(0, 0, 0))", 10, 10);
  assert.deepEqual(paints[0].gradientStops[0].color, { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(gradientPaints("linear-gradient(rgb(0, 0, 0), rgb(1, 1, 1))", 0, 10), { paints: [], skipped: [] });
});
