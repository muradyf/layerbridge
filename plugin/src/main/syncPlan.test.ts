import { describe, expect, test } from "bun:test";
import { DEFAULT_MODE, planTokenImport, summarisePlan, type ExistingCollection, type ImportToken } from "./syncPlan";

const colorCollection = (): ExistingCollection => ({
  id: "c1",
  name: "Color",
  defaultModeId: "m1",
  modes: [
    { modeId: "m1", name: "Light" },
    { modeId: "m2", name: "Dark" },
  ],
  variables: [
    { id: "v1", name: "brand/500", type: "COLOR", valuesByModeId: { m1: "#7c3aed", m2: "#a78bfa" } },
    { id: "v2", name: "text/accent", type: "COLOR", valuesByModeId: { m1: { aliasId: "v1" }, m2: { aliasId: "v1" } } },
    { id: "v3", name: "legacy", type: "COLOR", valuesByModeId: { m1: "#000000", m2: "#000000" } },
  ],
});

describe("planTokenImport", () => {
  test("a new collection gets its modes, variables, values and aliases", () => {
    const tokens: ImportToken[] = [
      { collection: "Color", name: "brand/500", type: "COLOR", valuesByMode: { Light: "#7C3AED", Dark: "#a78bfa" } },
      { collection: "Color", name: "text/accent", type: "COLOR", valuesByMode: { Light: { alias: "Color/brand/500" }, Dark: { alias: "Color/brand/500" } } },
    ];
    const plan = planTokenImport([], tokens);
    expect(plan.collections).toHaveLength(1);
    expect(plan.collections[0].modes.map((m) => [m.name, m.isDefault])).toEqual([["Light", true], ["Dark", false]]);
    expect(plan.variables.map((v) => v.name)).toEqual(["brand/500", "text/accent"]);
    expect(plan.values).toHaveLength(2);
    expect(plan.values[0].value).toBe("#7c3aed");
    expect(plan.aliases).toHaveLength(2);
    expect(plan.errors).toEqual([]);
    const summary = summarisePlan(plan);
    expect(summary.created.collections).toEqual(["Color"]);
    expect(summary.created.modes).toEqual(["Color/Light", "Color/Dark"]);
    expect(summary.updated).toEqual([]);
  });

  test("re-importing what the file already holds changes nothing and lists what the import left out", () => {
    const tokens: ImportToken[] = [
      { collection: "Color", name: "brand/500", type: "COLOR", valuesByMode: { Light: "#7c3aed", Dark: "#a78bfa" } },
      { collection: "Color", name: "text/accent", type: "COLOR", valuesByMode: { Light: { alias: "Color/brand/500" }, Dark: { alias: "Color/brand/500" } } },
    ];
    const plan = planTokenImport([colorCollection()], tokens);
    expect(plan.values).toEqual([]);
    expect(plan.aliases).toEqual([]);
    expect(plan.unchanged).toBe(4);
    expect(plan.variables.every((v) => v.id)).toBe(true);
    expect(plan.missing).toEqual(["Color/legacy"]);
  });

  test("CSS names match by slug, :root is the default mode and dark matches Dark", () => {
    const tokens: ImportToken[] = [
      { name: "color/brand/500", type: "COLOR", valuesByMode: { [DEFAULT_MODE]: "#7c3aed", dark: "#ffffff" } },
      { name: "color/text/accent", type: "COLOR", valuesByMode: { [DEFAULT_MODE]: { alias: "color/brand/500" } } },
    ];
    const plan = planTokenImport([colorCollection()], tokens);
    expect(plan.collections.filter((c) => !c.id)).toEqual([]);
    expect(plan.values).toEqual([{ collection: "Color", name: "brand/500", mode: "Dark", value: "#ffffff", from: "#a78bfa" }]);
    expect(plan.aliases).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  test("a CSS name whose first segment is an existing collection lands in it; others go to the default collection", () => {
    const plan = planTokenImport([colorCollection()], [
      { name: "color/brand/600", type: "COLOR", valuesByMode: { [DEFAULT_MODE]: "#6d28d9" } },
      { name: "radius/lg", type: "FLOAT", valuesByMode: { [DEFAULT_MODE]: 8 } },
    ]);
    expect(plan.variables.map((v) => `${v.collection}/${v.name}`)).toEqual(["Color/brand/600", "Tokens/radius/lg"]);
    expect(plan.collections.find((c) => c.name === "Tokens")?.modes).toEqual([{ name: "Default", isDefault: true }]);
    expect(plan.values.find((v) => v.name === "brand/600")?.mode).toBe("Light");
  });

  test("modeMapping renames source modes, and unknown modes are added", () => {
    const plan = planTokenImport([colorCollection()], [
      { collection: "Color", name: "brand/500", type: "COLOR", valuesByMode: { day: "#7c3aed", hc: "#000000" } },
    ], { modeMapping: { day: "Light" } });
    expect(plan.values).toEqual([{ collection: "Color", name: "brand/500", mode: "hc", value: "#000000" }]);
    expect(summarisePlan(plan).created.modes).toEqual(["Color/hc"]);
  });

  test("an alias-only token takes its type from the file's variable", () => {
    const plan = planTokenImport([colorCollection()], [
      { collection: "Color", name: "link", valuesByMode: { Light: { alias: "brand/500" } } },
    ]);
    expect(plan.variables).toEqual([{ collection: "Color", name: "link", type: "COLOR" }]);
    expect(plan.aliases[0].target).toEqual({ collection: "Color", name: "brand/500" });
  });

  test("errors: type clash with the file, alias to nothing, value of the wrong type", () => {
    const plan = planTokenImport([colorCollection()], [
      { collection: "Color", name: "brand/500", type: "FLOAT", valuesByMode: { Light: 1 } },
      { collection: "Color", name: "ghost", type: "COLOR", valuesByMode: { Light: { alias: "Nope/x" } } },
      { collection: "Color", name: "bad", type: "COLOR", valuesByMode: { Light: 12 } },
    ]);
    expect(plan.errors).toHaveLength(3);
    expect(plan.errors[0]).toMatch(/is COLOR but the token is FLOAT/);
    expect(plan.errors[1]).toMatch(/matches no token or variable/);
    expect(plan.errors[2]).toMatch(/not a COLOR value/);
  });

  test("FLOAT values compare with float32 tolerance", () => {
    const existing: ExistingCollection[] = [{
      id: "c2", name: "Space", defaultModeId: "m", modes: [{ modeId: "m", name: "Base" }],
      variables: [{ id: "s", name: "gap", type: "FLOAT", valuesByModeId: { m: 0.10000000149011612 } }],
    }];
    const plan = planTokenImport(existing, [{ collection: "Space", name: "gap", type: "FLOAT", valuesByMode: { [DEFAULT_MODE]: 0.1 } }]);
    expect(plan.unchanged).toBe(1);
    expect(plan.values).toEqual([]);
  });
});
