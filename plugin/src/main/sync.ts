/**
 * Plugin side of the sync module. One internal request, `sync_import_tokens`:
 * the server parses DTCG / CSS / Tailwind into normalised tokens, this reads the
 * file's variables, plans the import (syncPlan.ts, pure) and — unless it is a dry
 * run — applies it: collections and modes, then variables, then literal values,
 * then aliases last so every target already exists.
 */
import { hexToRgba, ok, requireEditor, toHex, type Request, type Response } from "./features";
import { postProgress, yieldToFigma } from "./robust";
import {
  planTokenImport,
  summarisePlan,
  type ExistingCollection,
  type ExistingValue,
  type ImportToken,
  type TokenPlan,
  type TokenType,
} from "./syncPlan";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const k = (collection: string, name: string) => `${collection} ${name}`;

const toExisting = (value: VariableValue | undefined): ExistingValue => {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "VARIABLE_ALIAS") return { aliasId: value.id };
    if ("r" in value) return toHex(value as RGBA);
    return null;
  }
  return value;
};

const snapshot = async () => {
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  const byCollection = new Map<string, Variable[]>();
  for (const v of variables) {
    const list = byCollection.get(v.variableCollectionId) ?? [];
    list.push(v);
    byCollection.set(v.variableCollectionId, list);
  }
  const existing: ExistingCollection[] = collections.map((c) => ({
    id: c.id,
    name: c.name,
    defaultModeId: c.defaultModeId,
    modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
    variables: (byCollection.get(c.id) ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      type: v.resolvedType as TokenType,
      description: v.description,
      valuesByModeId: Object.fromEntries(c.modes.map((m) => [m.modeId, toExisting(v.valuesByMode[m.modeId])])),
    })),
  }));
  return {
    existing,
    collections: new Map(collections.map((c) => [c.id, c])),
    variables: new Map(variables.map((v) => [v.id, v])),
  };
};

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

const apply = async (plan: TokenPlan, snap: Snapshot, requestId: string) => {
  const done = { collectionsCreated: 0, modesCreated: 0, variablesCreated: 0, valuesWritten: 0, aliasesSet: 0 };
  const errors: string[] = [];
  const collectionByName = new Map<string, VariableCollection>();
  const modeIds = new Map<string, string>();
  const variableByKey = new Map<string, Variable>();
  for (const c of snap.existing) {
    for (const v of c.variables) {
      const handle = snap.variables.get(v.id);
      if (handle) variableByKey.set(k(c.name, v.name), handle);
    }
  }

  let ops = 0;
  const tick = async (label: string) => {
    if (++ops % 200 === 0) {
      postProgress(requestId, `${label} (${ops} changes)`);
      await yieldToFigma();
    }
  };

  // 1. Collections and modes.
  for (const pc of plan.collections) {
    try {
      let collection = pc.id ? snap.collections.get(pc.id) : undefined;
      if (!collection) {
        collection = figma.variables.createVariableCollection(pc.name);
        done.collectionsCreated++;
        // A new collection starts with one mode ("Mode 1"); it becomes the planned default.
        const first = pc.modes.find((m) => m.isDefault) ?? pc.modes[0];
        if (first) {
          collection.renameMode(collection.modes[0].modeId, first.name);
          modeIds.set(k(pc.name, first.name), collection.modes[0].modeId);
        }
      }
      collectionByName.set(pc.name, collection);
      for (const mode of pc.modes) {
        const key = k(pc.name, mode.name);
        if (mode.modeId) modeIds.set(key, mode.modeId);
        if (modeIds.has(key)) continue;
        try {
          modeIds.set(key, collection.addMode(mode.name));
          done.modesCreated++;
        } catch (err) {
          // Figma's plan limits the number of modes per collection.
          errors.push(`Adding mode ${pc.name}/${mode.name}: ${message(err)}`);
        }
      }
    } catch (err) {
      errors.push(`Collection ${pc.name}: ${message(err)}`);
    }
  }

  // 2. Variables.
  for (const pv of plan.variables) {
    const label = `${pv.collection}/${pv.name}`;
    try {
      let variable = pv.id ? snap.variables.get(pv.id) : undefined;
      if (!variable) {
        const collection = collectionByName.get(pv.collection);
        if (!collection) throw new Error("its collection could not be created");
        variable = figma.variables.createVariable(pv.name, collection, pv.type);
        done.variablesCreated++;
      }
      if (pv.setDescription && pv.description !== undefined) variable.description = pv.description;
      variableByKey.set(k(pv.collection, pv.name), variable);
    } catch (err) {
      errors.push(`Variable ${label}: ${message(err)}`);
    }
    await tick("Creating variables");
  }

  const target = (collection: string, name: string, mode: string) => {
    const variable = variableByKey.get(k(collection, name));
    const modeId = modeIds.get(k(collection, mode));
    if (!variable) throw new Error("the variable does not exist");
    if (!modeId) throw new Error(`mode ${mode} does not exist`);
    return { variable, modeId };
  };

  // 3. Literal values.
  for (const pv of plan.values) {
    try {
      const { variable, modeId } = target(pv.collection, pv.name, pv.mode);
      variable.setValueForMode(modeId, variable.resolvedType === "COLOR" ? hexToRgba(String(pv.value)) : pv.value);
      done.valuesWritten++;
    } catch (err) {
      errors.push(`${pv.collection}/${pv.name} (${pv.mode}): ${message(err)}`);
    }
    await tick("Writing values");
  }

  // 4. Aliases, now that every target exists.
  for (const pa of plan.aliases) {
    try {
      const { variable, modeId } = target(pa.collection, pa.name, pa.mode);
      const aliasTo = variableByKey.get(k(pa.target.collection, pa.target.name));
      if (!aliasTo) throw new Error(`alias target ${pa.target.collection}/${pa.target.name} does not exist`);
      variable.setValueForMode(modeId, figma.variables.createVariableAlias(aliasTo));
      done.aliasesSet++;
    } catch (err) {
      errors.push(`${pa.collection}/${pa.name} (${pa.mode}): ${message(err)}`);
    }
    await tick("Setting aliases");
  }

  return { done, errors };
};

export const handleSyncRequest = async (request: Request): Promise<Response | null> => {
  if (request.type !== "sync_import_tokens") return null;
  const p = request.params ?? {};
  const tokens = p.tokens;
  if (!Array.isArray(tokens)) throw new Error("tokens (an array of normalised tokens) is required");
  const dryRun = p.dryRun !== false;
  if (!dryRun) requireEditor("import_tokens");

  postProgress(request.requestId, "Reading the file's variables");
  const snap = await snapshot();
  const plan = planTokenImport(snap.existing, tokens as ImportToken[], {
    modeMapping: (p.modeMapping as Record<string, string> | undefined) ?? {},
    defaultCollection: typeof p.defaultCollection === "string" ? p.defaultCollection : undefined,
  });
  const summary = summarisePlan(plan);
  if (dryRun) return ok(request, { dryRun: true, ...summary });

  const { done, errors } = await apply(plan, snap, request.requestId);
  return ok(request, { dryRun: false, ...summary, applied: done, errors: [...summary.errors, ...errors] });
};
