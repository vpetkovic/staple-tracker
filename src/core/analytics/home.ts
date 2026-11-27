/**
 * Where the cost model lives, and how it is read and written: the storage decision agreed on
 * the Analytics epic (option B, 2026-11-27).
 *
 * ## One model, saved with one home workspace
 *
 * Costs belong to the person, not to a project, so there is one cost model, saved as the four
 * `analytics.*` workspace settings of ONE workspace, its home. Being workspace settings, they
 * journal and sync as the existing `setting` entity: no new table, no protocol change, nothing
 * for the Worker to learn. Every Analytics view, one workspace or the hub, reads the same model.
 *
 * ## Finding the home needs no machine preference
 *
 * The hub registry is machine-local, so a "which workspace is home" preference would have to
 * be set on every device. Instead the home is found from the data: the registered workspace
 * holding a saved model. Each saved part carries `savedAt`, so when several workspaces hold one
 * (two devices started independently before they synced) the newest save wins, and the others
 * are reported (`home.others`) for the page to name. With none saved, every part is a default.
 *
 * ## Moving it
 *
 * Saving with `home` naming another workspace moves the whole model: every part is written to
 * the new home (the effective value, defaults included, with this save's changes on top), and
 * then reset in the old one. The new home is written first, so a failure between the two
 * leaves two homes, which the newest-save rule already resolves, rather than none.
 */
import { stapleHome } from "../../config/home.js";
import { readConnection } from "../cloud/connection.js";
import { listConflicts } from "../cloud/conflicts.js";
import { readStoredRepositoryId } from "../repo-identity.js";
import type { WorkspaceStore } from "../store.js";
import { StapleError } from "../types.js";
import type { CostModelHome, CostModelPartId, CostModelResponse, CostModelValue, CostModelWrite } from "./contract.js";
import { AGENT_TYPES } from "./agent-type.js";
import { COST_MODEL_KEYS, COST_MODEL_PARTS, DEFAULT_COST_MODEL, costModelSavedAt, type CostModel, type CostModelPart } from "./cost-model.js";

/** A registered workspace that could hold the model. */
export interface HomeCandidate {
  readonly slug: string;
  readonly prefix: string;
  readonly store: WorkspaceStore;
}

interface HeldModel {
  readonly model: CostModel;
  readonly source: Record<CostModelPart, "saved" | "default">;
  readonly savedAt: string | null;
}

/** The model one workspace holds: each part saved there, or its default. `assumed` is always present. */
export function readHeldModel(store: WorkspaceStore): HeldModel {
  const source = {} as Record<CostModelPart, "saved" | "default">;
  const parts = {} as Record<CostModelPart, unknown>;
  for (const part of COST_MODEL_PARTS) {
    const view = store.settingValue(COST_MODEL_KEYS[part]);
    const saved = view.source === "workspace";
    source[part] = saved ? "saved" : "default";
    const value = (saved ? view.value : DEFAULT_COST_MODEL[part]) as { assumed?: readonly string[] };
    parts[part] = { ...value, assumed: value.assumed ?? [] };
  }
  const model = parts as unknown as CostModel;
  return { model, source, savedAt: costModelSavedAt(model) };
}

/** True when this machine holds a live cloud connection for the workspace: its saves reach other devices. */
export function isSynced(store: WorkspaceStore, home: string = stapleHome()): boolean {
  const repositoryId = readStoredRepositoryId(store.db);
  if (repositoryId === null) return false;
  const connection = readConnection(home, repositoryId);
  return connection !== null && connection.removed === undefined;
}

interface Resolved {
  readonly home: (HomeCandidate & HeldModel) | null;
  readonly view: CostModelHome;
}

/**
 * The home among `candidates`, and the rest that also hold a save. `scopeSlug` is the workspace
 * the page is about (null for the hub): where a first save is suggested to go.
 */
export function resolveHome(candidates: readonly HomeCandidate[], scopeSlug: string | null, home: string = stapleHome()): Resolved {
  const held = candidates.map((candidate) => ({ ...candidate, ...readHeldModel(candidate.store) }));
  const saved = held
    .filter((candidate) => candidate.savedAt !== null)
    .sort((a, b) => (a.savedAt! < b.savedAt! ? 1 : a.savedAt! > b.savedAt! ? -1 : a.slug.localeCompare(b.slug)));
  const chosen = saved[0] ?? null;
  const inScope = scopeSlug === null ? undefined : candidates.find((candidate) => candidate.slug === scopeSlug);
  const suggested = chosen?.slug ?? inScope?.slug ?? candidates.find((candidate) => isSynced(candidate.store, home))?.slug ?? candidates[0]?.slug ?? null;
  return {
    home: chosen,
    view: {
      slug: chosen?.slug ?? null,
      prefix: chosen?.prefix ?? null,
      synced: chosen !== null && isSynced(chosen.store, home),
      others: saved.slice(1).map((candidate) => ({ slug: candidate.slug, prefix: candidate.prefix, savedAt: candidate.savedAt! })),
      suggested,
    },
  };
}

function responseOf(resolved: Resolved): CostModelResponse {
  const held = resolved.home ?? { model: DEFAULT_COST_MODEL, source: Object.fromEntries(COST_MODEL_PARTS.map((part) => [part, "default"])) as Record<CostModelPart, "saved" | "default"> };
  const model = Object.fromEntries(
    COST_MODEL_PARTS.map((part) => {
      const value = held.model[part] as { assumed?: readonly string[] };
      return [part, { ...value, assumed: value.assumed ?? [] }];
    }),
  ) as unknown as CostModelValue;
  return { model, source: held.source, home: resolved.view, agentTypes: [...AGENT_TYPES] };
}

/** `GET /api/analytics/cost-model`. */
export function readCostModel(candidates: readonly HomeCandidate[], scopeSlug: string | null, home: string = stapleHome()): CostModelResponse {
  return responseOf(resolveHome(candidates, scopeSlug, home));
}

/** The parts a write names, as the values to store (`savedAt` stamped, `assumed` defaulted to confirmed). */
function partsOf(write: CostModelWrite, now: string): Partial<Record<CostModelPart, unknown>> {
  const out: Partial<Record<CostModelPart, unknown>> = {};
  for (const part of COST_MODEL_PARTS) {
    const given = write[part] as Record<string, unknown> | undefined;
    if (given === undefined) continue;
    if (given === null || typeof given !== "object" || Array.isArray(given)) {
      throw new StapleError("validation", `${part} must be an object.`);
    }
    if ("savedAt" in given) throw new StapleError("validation", `${part}.savedAt is stamped by the server; leave it out.`);
    out[part] = { ...given, assumed: given.assumed ?? [], savedAt: now };
  }
  return out;
}

/** Refuses a write to a part the home holds an unresolved cloud conflict on: resolving it is the person's choice. */
function assertNoConflict(store: WorkspaceStore, parts: readonly CostModelPart[]): void {
  const keys = new Set(parts.map((part) => COST_MODEL_KEYS[part]));
  const open = listConflicts(store.db).filter((conflict) => conflict.entity === "setting" && keys.has(conflict.entityId));
  if (open.length > 0) {
    throw new StapleError(
      "conflict",
      `Two devices changed ${open.map((conflict) => conflict.entityId).join(", ")} differently. Choose which to keep in Settings → Cloud → Conflicts, then save again.`,
      { conflicts: open.map((conflict) => conflict.id) },
    );
  }
}

/**
 * `POST /api/analytics/cost-model`: save, reset or move. Answers the model as it now stands
 * and the slugs written, so the caller can trigger their sync.
 */
export function writeCostModel(
  candidates: readonly HomeCandidate[],
  write: CostModelWrite,
  options: { readonly scopeSlug: string | null; readonly actor: string | null; readonly now: string; readonly home?: string },
): { response: CostModelResponse; written: string[] } {
  const stapleHomeDir = options.home ?? stapleHome();
  const before = resolveHome(candidates, options.scopeSlug, stapleHomeDir);
  const reset = [...new Set(write.reset ?? [])];
  for (const part of reset) {
    if (!(COST_MODEL_PARTS as readonly string[]).includes(part)) throw new StapleError("validation", `reset names "${part}", which is not a part (${COST_MODEL_PARTS.join(", ")}).`);
  }
  const parts = partsOf(write, options.now);
  const named = write.home === undefined ? null : candidates.find((candidate) => candidate.slug === write.home);
  if (write.home !== undefined && !named) throw new StapleError("not_found", `No registered workspace "${write.home}" to save the cost model in.`);
  const target = named ?? before.home;
  if (target === null) {
    throw new StapleError("validation", `Nothing is saved yet: name the workspace to save the cost model in (home). Suggested: ${before.view.suggested ?? "none"}.`);
  }
  const moving = before.home !== null && before.home.slug !== target.slug;

  const ops: Array<{ op: "set"; key: string; value: unknown } | { op: "reset"; key: string }> = [];
  for (const part of COST_MODEL_PARTS) {
    const key = COST_MODEL_KEYS[part];
    if (reset.includes(part)) ops.push({ op: "reset", key });
    else if (parts[part] !== undefined) ops.push({ op: "set", key, value: parts[part] });
    else if (moving) {
      // Carry the old home's value over; a default stays a default (nothing to write).
      if (before.home!.source[part] === "saved") ops.push({ op: "set", key, value: before.home!.model[part] });
    }
  }
  assertNoConflict(target.store, ops.map((op) => COST_MODEL_PARTS.find((part) => COST_MODEL_KEYS[part] === op.key)!));
  if (ops.length > 0) target.store.applySettingOps(ops, options.actor);
  const written = [target.slug];
  if (moving) {
    const old = before.home!;
    const held = COST_MODEL_PARTS.filter((part) => old.source[part] === "saved");
    if (held.length > 0) old.store.applySettingOps(held.map((part) => ({ op: "reset" as const, key: COST_MODEL_KEYS[part] })), options.actor);
    written.push(old.slug);
  }
  return { response: readCostModel(candidates, options.scopeSlug, stapleHomeDir), written };
}

export type { CostModelPartId };
