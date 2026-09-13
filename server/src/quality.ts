/**
 * Quality tools that run on the server:
 *
 *   check_accessibility  WCAG contrast (computed from layers, or sampled from a render
 *                        when the background is an image, gradient, blur or blend),
 *                        target size, small text; optional report files and annotations
 *   lint_design_system   unbound colours / spacing / radii, unstyled text, detached
 *                        instances, off-scale values, default names, hidden and empty layers
 *   fix_design_system    binds the variables and styles the lint found (dry run by default)
 *
 * The plugin gathers facts (a11y_scan, ds_scan) and applies explicit changes
 * (a11y_annotate, ds_apply). The math is in quality-core.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pngjs from "pngjs";
import { z } from "zod";
import { resolveOutputPath } from "./assets.js";
import { fileKey, nodeId, type ServerSender, type ServerToolDef } from "./common.js";
import {
  FIXABLE_RULES,
  LINT_RULES,
  a11yMarkdown,
  a11yScore,
  apcaContrast,
  checkTargets,
  colorCandidates,
  contrastCriterion,
  contrastRatio,
  displayRatio,
  effectiveForeground,
  isLargeText,
  lintDesignSystem,
  parseHex,
  planFixes,
  requiredContrast,
  resolveBackground,
  resolveForeground,
  sampleBackground,
  sortIssues,
  suggestTextColor,
  toHex,
  type A11yIssue,
  type BgLayer,
  type DsNode,
  type FixChange,
  type Level,
  type LintRule,
  type PaintJson,
  type Pixels,
  type PxRect,
  type RGB,
  type RGBA,
  type TargetBox,
  type Tokens,
} from "./quality-core.js";

const { PNG } = pngjs;

/* ── plugin payloads ──────────────────────────────────────────────────────── */

type A11yGroup = { characters: string; fills: PaintJson[]; fontSize: number; fontWeight: number };
type A11yText = {
  nodeId: string;
  name: string;
  path?: string;
  characters: string;
  opacity?: number;
  groups: A11yGroup[];
  layers: BgLayer[];
  needsPixelSample?: boolean;
  sampleReason?: string;
  exportNodeId?: string;
  exportBounds?: { width: number; height: number };
  relBounds?: PxRect;
  modes?: Record<string, string>;
};
type A11yTarget = TargetBox & { name: string; path?: string; via?: string; component?: string };
type A11yScan = {
  root: { id: string; name: string };
  canvas?: string;
  visited: number;
  truncated?: boolean;
  texts: A11yText[];
  targets: A11yTarget[];
  tagged?: string[];
  tokens?: Tokens;
};
type DsScan = { root: { id: string; name: string }; visited: number; truncated?: boolean; nodes: DsNode[]; tokens: Tokens };

const EMPTY_TOKENS: Tokens = { collections: [], variables: [], paintStyles: [], textStyles: [] };
const ALL_CHECKS = ["contrast", "targets", "textSize"] as const;
/** A render bigger than this is scaled down; 36M pixels is a 6000×6000 image. */
const MAX_EXPORT_PIXELS = 36_000_000;
const FIX_DELTA_E = 2;

const call = async (sender: ServerSender, type: string, params: Record<string, unknown>, idleMs = 120_000) => {
  const resp = await sender.sendWithParams(type, undefined, params, idleMs);
  if (resp.error) throw new Error(resp.error);
  return resp.data;
};

const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
const idToken = (id: string) => id.replace(/:/g, "-").replace(/;/g, "_");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* ── check_accessibility ──────────────────────────────────────────────────── */

async function checkAccessibility(sender: ServerSender, params: Record<string, unknown>) {
  const checks = new Set<string>((params.checks as string[] | undefined) ?? ALL_CHECKS);
  const level = (params.level as Level | undefined) ?? "AA";
  const minTarget = (params.minTarget as number | undefined) ?? (level === "AAA" ? 44 : 24);
  const minFontSize = (params.minFontSize as number | undefined) ?? 12;
  const maxExports = (params.maxExports as number | undefined) ?? 25;
  const maxIssues = (params.maxIssues as number | undefined) ?? 200;

  const scan = (await call(sender, "a11y_scan", { nodeId: params.nodeId, checks: [...checks] })) as A11yScan;
  const tokens = scan.tokens ?? EMPTY_TOKENS;
  const canvas = parseHex(scan.canvas ?? "#ffffff");
  const issues: A11yIssue[] = [];
  const notes: string[] = [];
  let checked = 0;
  if (scan.truncated) notes.push(`Stopped after ${scan.texts.length} text layers; check a smaller layer for the rest.`);

  const where = (t: { nodeId: string; name: string; path?: string }) => ({ nodeId: t.nodeId, name: t.name, ...(t.path ? { path: t.path } : {}) });

  const judge = (t: A11yText, g: A11yGroup, fg: RGBA, bg: RGB, method: "computed" | "sampled", extra: Record<string, unknown> = {}) => {
    const eff = effectiveForeground(fg, bg);
    const ratio = contrastRatio(eff, bg);
    const large = isLargeText(g.fontSize, g.fontWeight);
    const required = requiredContrast(level, large);
    if (ratio >= required) return;
    issues.push({
      severity: "fail",
      check: "contrast",
      wcag: contrastCriterion(level),
      ...where(t),
      text: g.characters,
      foreground: toHex(fg),
      background: toHex(bg),
      ratio: displayRatio(ratio),
      required,
      largeText: large,
      fontSize: g.fontSize,
      fontWeight: g.fontWeight,
      apcaLc: round(apcaContrast(eff, bg), 1),
      method,
      ...extra,
      suggestion:
        suggestTextColor(fg, bg, required, colorCandidates(tokens, t.modes ?? {}, "text-fill")) ??
        "no colour variable or style in this file reaches the ratio on this background",
    });
  };

  const skip = (t: A11yText, g: A11yGroup, note: string) =>
    issues.push({ severity: "warn", check: "contrast", wcag: contrastCriterion(level), ...where(t), text: g.characters, method: "skipped", note });

  // 1. Text size, and contrast wherever the layers alone decide it.
  type Pending = { t: A11yText; g: A11yGroup; fg: RGBA; reason: string };
  const toSample = new Map<string, { bounds: { width: number; height: number }; items: Pending[] }>();
  for (const t of scan.texts) {
    for (const g of t.groups) {
      if (checks.has("textSize")) {
        checked++;
        if (g.fontSize < minFontSize) {
          issues.push({
            severity: "warn",
            check: "textSize",
            wcag: null,
            ...where(t),
            text: g.characters,
            fontSize: g.fontSize,
            minFontSize,
            note: "not a WCAG criterion; text this small is hard to read",
          });
        }
      }
      if (!checks.has("contrast")) continue;
      const fgResult = resolveForeground(g.fills, t.opacity ?? 1);
      if (!("color" in fgResult)) {
        checked++;
        skip(t, g, `the text has a ${fgResult.reason}; check it by eye`);
        continue;
      }
      if (fgResult.color.a <= 0.001) continue; // invisible text is not read by anyone
      checked++;
      const bg = t.needsPixelSample ? null : resolveBackground(t.layers, canvas);
      if (bg && "color" in bg) {
        judge(t, g, fgResult.color, bg.color, "computed", bg.usedCanvas ? { note: "nothing opaque behind the text; used the page background" } : {});
        continue;
      }
      const reason = t.sampleReason ?? (bg && "reason" in bg ? bg.reason : "the background is not a plain solid colour");
      if (!t.exportNodeId || !t.exportBounds || !t.relBounds) {
        skip(t, g, `${reason}, and there is no layer to render it from`);
        continue;
      }
      const entry = toSample.get(t.exportNodeId) ?? { bounds: t.exportBounds, items: [] };
      entry.items.push({ t, g, fg: fgResult.color, reason });
      toSample.set(t.exportNodeId, entry);
    }
  }

  // 2. The rest: render each containing layer once and sample behind every text in it.
  let exportsUsed = 0;
  for (const [exportId, entry] of toSample) {
    if (exportsUsed >= maxExports) {
      for (const it of entry.items) skip(it.t, it.g, `${it.reason}; not sampled because maxExports (${maxExports}) was reached`);
      continue;
    }
    exportsUsed++;
    const smallest = Math.min(...entry.items.map((it) => it.g.fontSize));
    const area = Math.max(entry.bounds.width * entry.bounds.height, 1);
    let scale = smallest < 16 ? 2 : 1;
    if (area * scale * scale > MAX_EXPORT_PIXELS) scale = Math.max(0.25, Math.sqrt(MAX_EXPORT_PIXELS / area));
    let pixels: Pixels;
    try {
      const resp = await sender.sendWithParams("get_screenshot", [exportId], { format: "PNG", scale, clip: true, timeoutMs: 60_000 }, 80_000);
      if (resp.error) throw new Error(resp.error);
      const exported = (resp.data as { exports?: { base64: string }[] } | undefined)?.exports?.[0];
      if (!exported) throw new Error("the plugin returned no image");
      const png = PNG.sync.read(Buffer.from(exported.base64, "base64"));
      pixels = { width: png.width, height: png.height, data: png.data };
    } catch (err) {
      for (const it of entry.items) skip(it.t, it.g, `${it.reason}; rendering ${exportId} failed: ${errorText(err)}`);
      continue;
    }
    const sx = pixels.width / Math.max(entry.bounds.width, 1e-6);
    const sy = pixels.height / Math.max(entry.bounds.height, 1e-6);
    for (const it of entry.items) {
      const r = it.t.relBounds!;
      const sample = sampleBackground(pixels, { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy }, it.fg, { canvas });
      if (!sample) {
        skip(it.t, it.g, `${it.reason}; the render did not show enough background around the text to measure`);
        continue;
      }
      const typical = contrastRatio(effectiveForeground(it.fg, sample.typical.color), sample.typical.color);
      judge(it.t, it.g, it.fg, sample.worst.color, "sampled", {
        typicalRatio: displayRatio(typical),
        typicalBackground: toHex(sample.typical.color),
        backgroundColours: sample.clusters.length,
        sampleReason: it.reason,
        renderedFrom: exportId,
      });
    }
  }

  // 3. Targets.
  if (checks.has("targets")) {
    const wcag = minTarget >= 44 ? "2.5.5" : "2.5.8";
    const results = checkTargets(scan.targets, minTarget);
    checked += results.length;
    results.forEach((result, i) => {
      if (!result.undersized) return;
      const t = scan.targets[i];
      const common = {
        check: "targets" as const,
        wcag,
        ...where(t),
        width: round(t.width),
        height: round(t.height),
        minTarget,
        ...(t.via ? { detectedBy: t.via } : {}),
        ...(t.component ? { component: t.component } : {}),
      };
      if (result.spacingException && wcag === "2.5.8") {
        issues.push({ severity: "warn", ...common, spacingException: true, note: `smaller than ${minTarget}×${minTarget}, but far enough from other targets to pass 2.5.8` });
      } else {
        issues.push({
          severity: "fail",
          ...common,
          spacingException: false,
          suggestion: `make the hit area at least ${minTarget}×${minTarget}${wcag === "2.5.8" ? ", or move it away from the targets next to it" : ""}`,
        });
      }
    });
  }

  const sorted = sortIssues(issues);
  const failures = sorted.filter((i) => i.severity === "fail").length;
  const warnings = sorted.filter((i) => i.severity === "warn").length;
  const report = {
    root: scan.root,
    level,
    minTarget,
    minFontSize,
    summary: { checked, failures, warnings, score: a11yScore(checked, failures, warnings) },
    issues: sorted,
    ...(notes.length ? { notes } : {}),
  };

  // 4. Annotations: one per failing layer, replacing what this tool wrote before.
  let annotations: Record<string, unknown> | undefined;
  if (params.annotate === true) {
    const byNode = new Map<string, string[]>();
    for (const i of sorted) {
      if (i.severity !== "fail") continue;
      const line = i.check === "contrast" ? `Contrast ${i.ratio}:1, needs ${i.required}:1 (WCAG ${i.wcag})` : `Target ${i.width}×${i.height}, needs ${minTarget}×${minTarget} (WCAG ${i.wcag})`;
      byNode.set(i.nodeId, [...new Set([...(byNode.get(i.nodeId) ?? []), line])]);
    }
    const items = [...byNode].map(([id, lines]) => ({ nodeId: id, label: `Accessibility: ${lines.join("; ")}` }));
    // Only a full run knows a layer is clean again; a contrast-only run must not clear a target note.
    const fullRun = ALL_CHECKS.every((c) => checks.has(c));
    const clear = fullRun ? (scan.tagged ?? []).filter((id) => !byNode.has(id)) : [];
    const tally: Record<string, number> = {};
    const errors: unknown[] = [];
    if (items.length || clear.length) {
      const data = (await call(sender, "a11y_annotate", { items, clear })) as { results: { nodeId: string; status: string; reason?: string }[] };
      for (const r of data.results) {
        tally[r.status] = (tally[r.status] ?? 0) + 1;
        if (r.status === "error" || r.status === "skipped") errors.push(r);
      }
    }
    annotations = { ...tally, ...(errors.length ? { problems: errors.slice(0, 20) } : {}), ...(fullRun ? {} : { note: "stale annotations are only cleared when all checks run" }) };
  }

  // 5. Files.
  let files: { json: string; markdown: string } | undefined;
  if (typeof params.outputDir === "string") {
    const dir = resolveOutputPath(params.outputDir);
    await mkdir(dir, { recursive: true });
    const stem = `accessibility-${idToken(scan.root.id)}`;
    files = { json: path.join(dir, `${stem}.json`), markdown: path.join(dir, `${stem}.md`) };
    await writeFile(files.json, JSON.stringify(report, null, 2));
    await writeFile(files.markdown, a11yMarkdown(report));
  }

  return {
    ...report,
    issues: sorted.slice(0, maxIssues),
    ...(sorted.length > maxIssues ? { issuesTruncated: `showing ${maxIssues} of ${sorted.length}${files ? "; the report files list all of them" : ""}` } : {}),
    ...(files ? { files } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

/* ── lint_design_system / fix_design_system ───────────────────────────────── */

const scanDesignSystem = async (sender: ServerSender, params: Record<string, unknown>, rules: LintRule[] | undefined) =>
  (await call(
    sender,
    "ds_scan",
    defined({ nodeId: params.nodeId, rules, limit: params.limit, includeInstanceChildren: params.includeInstanceChildren })
  )) as DsScan;

async function lintTool(sender: ServerSender, params: Record<string, unknown>) {
  const rules = params.rules as LintRule[] | undefined;
  const maxIssues = (params.maxIssues as number | undefined) ?? 300;
  const scan = await scanDesignSystem(sender, params, rules);
  const result = lintDesignSystem(scan.nodes, scan.tokens, {
    rules,
    spacingScale: params.spacingScale as number[] | undefined,
    radiusScale: params.radiusScale as number[] | undefined,
    maxDeltaE: (params.maxDeltaE as number | undefined) ?? 5,
    respectScopes: params.respectScopes as boolean | undefined,
    nodesChecked: scan.visited,
  });
  const issues = sortIssues(result.issues).map(({ fix, ...rest }) => ({
    ...rest,
    fixable: !!fix && (fix.kind === "paint-variable" || fix.kind === "paint-style" ? fix.deltaE <= FIX_DELTA_E : true),
  }));
  return {
    root: scan.root,
    summary: { layersChecked: scan.visited, issues: issues.length, fixable: issues.filter((i) => i.fixable).length, score: result.score, byRule: result.byRule },
    scales: result.scales,
    ...(scan.truncated ? { truncated: "stopped at the layer limit; lint a smaller layer or raise limit" } : {}),
    issues: issues.slice(0, maxIssues),
    ...(issues.length > maxIssues ? { issuesTruncated: `showing ${maxIssues} of ${issues.length}` } : {}),
  };
}

const describeChange = (c: FixChange, names: Map<string, string>) => {
  const common = { nodeId: c.nodeId, name: names.get(c.nodeId), kind: c.kind, to: c.targetName };
  switch (c.kind) {
    case "paint-variable":
    case "paint-style":
      return {
        ...common,
        property: `${c.field}[${c.index}]${c.range ? ` chars ${c.range[0]}-${c.range[1]}` : ""}`,
        from: c.before.opacity < 1 ? `${c.before.color} at ${Math.round(c.before.opacity * 100)}%` : c.before.color,
        toColor: c.expected.opacity < 1 ? `${c.expected.color} at ${Math.round(c.expected.opacity * 100)}%` : c.expected.color,
        deltaE: round(c.deltaE),
      };
    case "float-variable":
      return { ...common, property: c.field, from: c.before, toValue: c.expected };
    case "text-style":
      return { ...common, property: "textStyleId" };
  }
};

async function fixTool(sender: ServerSender, params: Record<string, unknown>) {
  const requested = (params.rules as LintRule[] | undefined) ?? FIXABLE_RULES;
  const rules = requested.filter((r) => FIXABLE_RULES.includes(r));
  if (rules.length === 0) throw new Error(`fix_design_system only fixes ${FIXABLE_RULES.join(", ")}`);
  const maxDeltaE = (params.maxDeltaE as number | undefined) ?? FIX_DELTA_E;
  const dryRun = params.dryRun !== false;
  const maxItems = (params.maxItems as number | undefined) ?? 300;

  const scan = await scanDesignSystem(sender, params, rules);
  const result = lintDesignSystem(scan.nodes, scan.tokens, {
    rules,
    maxDeltaE,
    respectScopes: params.respectScopes as boolean | undefined,
    nodesChecked: scan.visited,
  });
  const names = new Map(scan.nodes.map((n) => [n.id, n.name]));
  const { changes, skipped } = planFixes(result.issues, rules);
  const ignored = requested.filter((r) => !FIXABLE_RULES.includes(r));
  const shared = {
    root: scan.root,
    ...(ignored.length ? { ignoredRules: ignored } : {}),
    ...(scan.truncated ? { truncated: "stopped at the layer limit; fix a smaller layer or raise limit" } : {}),
  };

  if (dryRun) {
    return {
      ...shared,
      dryRun: true,
      planned: changes.length,
      notPlanned: skipped.length,
      changes: changes.slice(0, maxItems).map((c) => describeChange(c, names)),
      skipped: skipped.slice(0, maxItems),
      note: "Nothing was changed. Run again with dryRun: false to apply these changes.",
    };
  }

  const applied: Record<string, unknown>[] = [];
  const notApplied: Record<string, unknown>[] = [];
  for (let i = 0; i < changes.length; i += 100) {
    const data = (await call(sender, "ds_apply", { changes: changes.slice(i, i + 100) })) as {
      applied: Record<string, unknown>[];
      skipped: Record<string, unknown>[];
    };
    applied.push(...data.applied);
    notApplied.push(...data.skipped);
  }
  return {
    ...shared,
    dryRun: false,
    applied: applied.length,
    notApplied: notApplied.length,
    notPlanned: skipped.length,
    changes: applied.slice(0, maxItems),
    notAppliedDetails: notApplied.slice(0, maxItems),
    skipped: skipped.slice(0, maxItems),
  };
}

/* ── tool definitions ─────────────────────────────────────────────────────── */

const rulesSchema = z.array(z.enum(LINT_RULES)).min(1).optional();
const limit = z.number().int().positive().optional().describe("Most layers with findings to collect (default 5000)");
const includeInstanceChildren = z
  .boolean()
  .optional()
  .describe("Also look inside instances (default false: their insides come from the main component, so lint that instead)");

export const QUALITY_SERVER_TOOLS: Record<string, ServerToolDef> = {
  check_accessibility: {
    description:
      "Check a frame for WCAG 2.2 accessibility problems: text contrast (1.4.3 AA / 1.4.6 AAA), target size (2.5.8, or 2.5.5 at 44px) and very small text. Contrast is computed from the layers behind each text; when the background is an image, gradient, blur or blend it renders the containing layer as a PNG and samples the pixels behind the text, reporting the worst background colour (method: sampled). Returns a 0-100 score and issues sorted by severity, each with the node, colours, ratio, required ratio, informational APCA Lc, and the nearest colour variable or style that would pass. Optional: write JSON + Markdown reports to outputDir, and annotate failing layers in Figma (annotate: true changes the file; re-running replaces its own annotations). Cost: one scan, plus one export per containing layer that needs sampling (capped by maxExports).",
    schema: z.object({
      nodeId,
      checks: z.array(z.enum(ALL_CHECKS)).min(1).optional().describe("Which checks to run (default all three)"),
      level: z.enum(["AA", "AAA"]).optional().describe("WCAG level (default AA)"),
      minTarget: z.number().positive().optional().describe("Minimum target size in px (default 24 for AA per WCAG 2.5.8; 44 for AAA 2.5.5 and Apple's HIG)"),
      minFontSize: z.number().positive().optional().describe("Warn below this font size in px (default 12)"),
      annotate: z.boolean().optional().describe("Add a Figma annotation to each failing layer (changes the file; design editor only)"),
      outputDir: z.string().optional().describe("Write accessibility-<node>.json and .md here (inside the allowed output folders)"),
      maxExports: z.number().int().min(0).max(200).optional().describe("Most layers to render for pixel sampling (default 25)"),
      maxIssues: z.number().int().positive().optional().describe("Most issues in the reply (default 200; files list all)"),
      fileKey,
    }),
    run: checkAccessibility,
  },
  lint_design_system: {
    description:
      "Lint a frame against the file's design system. Rules: unbound-color (solid fill/stroke with no variable or style; suggests the matching local colour variable in the layer's mode, respecting variable scopes, or paint style — exact first, else nearest by CIEDE2000 within maxDeltaE), unbound-spacing and unbound-radius (auto-layout gap/padding and corner radius not bound to a number variable; suggests one), text-without-style (suggests the nearest text style in the same family), detached-instance, off-scale-spacing / off-scale-radius (against spacingScale/radiusScale, or a scale inferred from the file's number variables), default-name, hidden-layer, empty-frame. Returns issues with node, path, property, value, suggestion and whether fix_design_system can apply it, plus counts per rule and a 0-100 score. Read-only; one scan of the frame.",
    schema: z.object({
      nodeId,
      rules: rulesSchema.describe("Rules to run (default all)"),
      spacingScale: z.array(z.number().min(0)).min(1).optional().describe("Allowed spacing values in px"),
      radiusScale: z.array(z.number().min(0)).min(1).optional().describe("Allowed corner radii in px"),
      maxDeltaE: z.number().min(0).max(50).optional().describe("Colour distance (CIEDE2000) for suggestions (default 5; fixes use 2)"),
      respectScopes: z.boolean().optional().describe("Only suggest variables whose scopes allow the property (default true)"),
      includeInstanceChildren,
      limit,
      maxIssues: z.number().int().positive().optional().describe("Most issues in the reply (default 300)"),
      fileKey,
    }),
    run: lintTool,
  },
  fix_design_system: {
    description:
      "Apply lint_design_system's suggestions: bind solid fills/strokes to matching colour variables (or a paint style when the layer has one paint), bind auto-layout spacing/padding and corner radius to number variables with exactly the same value, and give unstyled text a text style whose font, size, line height and letter spacing match. Only binds when the variable resolves, in that layer's mode, to the same value (colours within maxDeltaE, default 2); re-checks each layer before changing it and reverts if Figma changed the result. dryRun defaults to true and returns the plan without changing anything; dryRun: false applies it and returns what changed and what was skipped and why. Changes the file when applied (design editor only).",
    schema: z.object({
      nodeId,
      rules: z.array(z.enum(FIXABLE_RULES as [LintRule, ...LintRule[]])).min(1).optional().describe("Which fixes (default all four)"),
      maxDeltaE: z.number().min(0).max(10).optional().describe("Largest colour change allowed when binding (CIEDE2000, default 2; 0 = exact only)"),
      dryRun: z.boolean().optional().describe("Default true: plan only. Pass false to change the file."),
      respectScopes: z.boolean().optional().describe("Only bind variables whose scopes allow the property (default true)"),
      includeInstanceChildren,
      limit,
      maxItems: z.number().int().positive().optional().describe("Most changes/skips listed in the reply (default 300)"),
      fileKey,
    }),
    editing: true,
    run: fixTool,
  },
};
