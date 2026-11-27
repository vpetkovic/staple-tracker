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
import type { CostModelHome, CostModelResponse, CostModelValue, CostModelWrite } from "./contract.js";
import { AGENT_TYPES } from "./agent-type.js";
import { COST_MODEL_KEYS, COST_MODEL_PARTS, DEFAULT_COST_MODEL, type CostModel, type CostModelPart } from "./cost-model.js";

/** A registered workspace that could hold the model. */
export interface HomeCandidate {
  readonly slug: string;
  readonly prefix: string;
  readonly store: WorkspaceStore;
}

interface HeldModel {
  readonly model: CostModel;
  readonly source: Record<CostModelPart, "saved" | "default">;
  /** True when any part is saved here. */
  readonly saved: boolean;
  /**
   * When the newest saved part here was saved, as an instant: compared numerically, so an
   * offset stamp (`…+05:00`) ranks by the moment it names. A saved part without a usable
   * stamp (written by hand with `staple settings set`) ranks as the oldest save, not as none.
   */
  readonly savedAtMs: number;
  readonly savedAt: string | null;
}

/** The model one workspace holds: each part saved there, or its default. `assumed` is always present. */
function readHeldModel(store: WorkspaceStore): HeldModel {
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
  const stamps = COST_MODEL_PARTS.filter((part) => source[part] === "saved").map((part) => Date.parse(model[part].savedAt ?? ""));
  const savedAtMs = stamps.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(0, ...stamps.filter((at) => Number.isFinite(at)));
  return { model, source, saved: stamps.length > 0, savedAtMs, savedAt: stamps.length === 0 ? null : new Date(savedAtMs).toISOString() };
}

/** True when this machine holds a live cloud connection for the workspace: its saves reach other devices. */
function isSynced(store: WorkspaceStore, home: string): boolean {
  const repositoryId = readStoredRepositoryId(store.db);
  if (repositoryId === null) return false;
  const connection = readConnection(home, repositoryId);
  return connection !== null && connection.removed === undefined;
}

interface Resolved {
  readonly home: (HomeCandidate & HeldModel) | null;
  /** Every candidate with what it holds. */
  readonly held: readonly (HomeCandidate & HeldModel)[];
  readonly view: CostModelHome;
}

/**
 * The home among `candidates`, and the rest that also hold a save. `scopeSlug` is the workspace
 * the page is about (null for the hub): where a first save is suggested to go.
 */
function resolveHome(candidates: readonly HomeCandidate[], scopeSlug: string | null, home: string): Resolved {
  const held = candidates.map((candidate) => ({ ...candidate, ...readHeldModel(candidate.store) }));
  const saved = held.filter((candidate) => candidate.saved).sort((a, b) => b.savedAtMs - a.savedAtMs || a.slug.localeCompare(b.slug));
  const chosen = saved[0] ?? null;
  const inScope = scopeSlug === null ? undefined : candidates.find((candidate) => candidate.slug === scopeSlug);
  const suggested = chosen?.slug ?? inScope?.slug ?? candidates.find((candidate) => isSynced(candidate.store, home))?.slug ?? candidates[0]?.slug ?? null;
  return {
    home: chosen,
    held,
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
  // Every default carries `assumed`, and `readHeldModel` filled it for a save without one.
  return { model: held.model as unknown as CostModelValue, source: held.source, home: resolved.view, agentTypes: [...AGENT_TYPES] };
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
 *
 * Every write leaves exactly one workspace holding the model. The target (the named home, else
 * the current one) is written to hold the effective model with this write on top: a part this
 * write sets, a part the current home holds, or the default, in that order. Any other workspace
 * still holding a saved part (the old home after a move, or an older save that arrived by sync)
 * has it reset, so a later reset or move can never bring a superseded value back. No workspace
 * is touched while any part it would change has an open cloud conflict.
 */
export function writeCostModel(
  candidates: readonly HomeCandidate[],
  write: CostModelWrite,
  options: { readonly scopeSlug: string | null; readonly actor: string | null; readonly now: string; readonly home?: string },
): { response: CostModelResponse; written: string[] } {
  if (write === null || typeof write !== "object" || Array.isArray(write)) throw new StapleError("validation", "The cost model write must be an object.");
  if (write.reset !== undefined && !Array.isArray(write.reset)) throw new StapleError("validation", `reset must be a list of parts (${COST_MODEL_PARTS.join(", ")}).`);
  if (write.home !== undefined && typeof write.home !== "string") throw new StapleError("validation", "home must name a workspace slug.");
  const stapleHomeDir = options.home ?? stapleHome();
  const before = resolveHome(candidates, options.scopeSlug, stapleHomeDir);
  const reset = [...new Set(write.reset ?? [])];
  for (const part of reset) {
    if (!(COST_MODEL_PARTS as readonly unknown[]).includes(part)) throw new StapleError("validation", `reset names ${JSON.stringify(part)}, which is not a part (${COST_MODEL_PARTS.join(", ")}).`);
  }
  const parts = partsOf(write, options.now);
  const named = write.home === undefined ? null : candidates.find((candidate) => candidate.slug === write.home);
  if (write.home !== undefined && !named) throw new StapleError("not_found", `No registered workspace "${write.home}" to save the cost model in.`);
  const targetSlug = named?.slug ?? before.home?.slug ?? null;
  if (targetSlug === null) {
    throw new StapleError("validation", `Nothing is saved yet: name the workspace to save the cost model in (home). Suggested: ${before.view.suggested ?? "none"}.`);
  }
  const target = before.held.find((candidate) => candidate.slug === targetSlug)!;
  const basis = before.home;

  type Op = { op: "set"; key: string; value: unknown } | { op: "reset"; key: string };
  const plan: Array<{ candidate: HomeCandidate & HeldModel; ops: Op[]; parts: CostModelPart[] }> = [];
  const targetOps: Op[] = [];
  const targetParts: CostModelPart[] = [];
  for (const part of COST_MODEL_PARTS) {
    const key = COST_MODEL_KEYS[part];
    const carried = basis !== null && basis.slug !== target.slug && basis.source[part] === "saved" ? basis.model[part] : undefined;
    const value = reset.includes(part) ? undefined : (parts[part] ?? carried);
    if (value !== undefined) targetOps.push({ op: "set", key, value });
    // A part the effective model holds at its default must not survive as an older save here.
    else if (target.source[part] === "saved" && (reset.includes(part) || basis === null || basis.slug !== target.slug)) targetOps.push({ op: "reset", key });
    else continue;
    targetParts.push(part);
  }
  plan.push({ candidate: target, ops: targetOps, parts: targetParts });
  for (const other of before.held) {
    if (other.slug === target.slug || !other.saved) continue;
    const held = COST_MODEL_PARTS.filter((part) => other.source[part] === "saved");
    plan.push({ candidate: other, ops: held.map((part) => ({ op: "reset" as const, key: COST_MODEL_KEYS[part] })), parts: held });
  }
  for (const step of plan) assertNoConflict(step.candidate.store, step.parts);
  const written: string[] = [];
  for (const step of plan) {
    if (step.ops.length === 0 && step.candidate.slug !== target.slug) continue;
    if (step.ops.length > 0) step.candidate.store.applySettingOps(step.ops, options.actor);
    written.push(step.candidate.slug);
  }
  return { response: readCostModel(candidates, options.scopeSlug, stapleHomeDir), written };
}
