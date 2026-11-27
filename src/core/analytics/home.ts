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
import { settingMetaKey } from "../settings-registry.js";
import { StapleError } from "../types.js";
import type { CostModelHome, CostModelResponse, CostModelValue, CostModelWrite } from "./contract.js";
import { AGENT_TYPES } from "./agent-type.js";
import { COST_MODEL_KEYS, COST_MODEL_PARTS, DEFAULT_COST_MODEL, DEFAULT_ROLE_RATE, kindOf, type CostModel, type CostModelPart, type ProfileValue } from "./cost-model.js";

/** A registered workspace that could hold the model. */
export interface HomeCandidate {
  readonly slug: string;
  readonly prefix: string;
  readonly store: WorkspaceStore;
}

/** One part as one workspace holds it. */
interface HeldPart {
  readonly status: "saved" | "default" | "unreadable";
  /** The stored value (raw, as written), or the default. */
  readonly value: unknown;
  /**
   * When it was saved, as an instant: compared numerically, so an offset stamp (`…+05:00`)
   * ranks by the moment it names. A save without a usable stamp (written by hand with
   * `staple settings set`) ranks as the oldest save, not as none. -Infinity when not saved.
   */
  readonly stampMs: number;
  readonly error: StapleError | null;
}

interface Held extends HomeCandidate {
  readonly parts: Readonly<Record<CostModelPart, HeldPart>>;
  /** True when any part is saved here (readable or not). */
  readonly saved: boolean;
  /** The newest save here. */
  readonly stampMs: number;
}

/** What one workspace holds, part by part. `assumed` is always present on a value. */
function readHeld(candidate: HomeCandidate): Held {
  const parts = {} as Record<CostModelPart, HeldPart>;
  for (const part of COST_MODEL_PARTS) {
    try {
      const view = candidate.store.settingValue(COST_MODEL_KEYS[part]);
      if (view.source === "workspace") {
        const value = view.value as { assumed?: readonly string[]; savedAt?: string | null };
        const at = Date.parse(value.savedAt ?? "");
        parts[part] = { status: "saved", value: { ...value, assumed: value.assumed ?? [] }, stampMs: Number.isFinite(at) ? at : 0, error: null };
      } else {
        parts[part] = { status: "default", value: DEFAULT_COST_MODEL[part], stampMs: Number.NEGATIVE_INFINITY, error: null };
      }
    } catch (error) {
      if (!(error instanceof StapleError)) throw error;
      // Never carried or reset; ranked by the stamp its raw row still names.
      const at = rawSavedAt(candidate.store, part);
      parts[part] = { status: "unreadable", value: DEFAULT_COST_MODEL[part], stampMs: Number.isFinite(at) ? at : 0, error };
    }
  }
  const stamps = COST_MODEL_PARTS.map((part) => parts[part].stampMs);
  const stampMs = Math.max(...stamps);
  return { ...candidate, parts, saved: stampMs > Number.NEGATIVE_INFINITY, stampMs };
}

/** The `savedAt` a stored row names, read from its raw JSON (for a row the registry cannot read), as epoch ms; NaN when none. */
function rawSavedAt(store: WorkspaceStore, part: CostModelPart): number {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(settingMetaKey(COST_MODEL_KEYS[part])) as { value: string } | undefined;
  try {
    const savedAt = (JSON.parse(row?.value ?? "null") as { value?: { savedAt?: unknown } } | null)?.value?.savedAt;
    return typeof savedAt === "string" ? Date.parse(savedAt) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** True when this machine holds a live cloud connection for the workspace: its saves reach other devices. */
function isSynced(store: WorkspaceStore, home: string): boolean {
  const repositoryId = readStoredRepositoryId(store.db);
  if (repositoryId === null) return false;
  const connection = readConnection(home, repositoryId);
  return connection !== null && connection.removed === undefined;
}

/** The effective value of one part: its newest save in any workspace, else the default. */
interface EffectivePart {
  readonly value: unknown;
  /** The workspace holding that save, or null for the default. */
  readonly from: Held | null;
  readonly unreadable: StapleError | null;
}

interface Resolved {
  readonly held: readonly Held[];
  readonly effective: Readonly<Record<CostModelPart, EffectivePart>>;
  /** The workspace holding the newest save of any part, or null when nothing is saved. */
  readonly home: Held | null;
  readonly view: CostModelHome;
}

/**
 * The effective model and where it lives. Each part is read from its own newest save, in
 * whichever registered workspace holds it, so two devices saving different parts (one the
 * company profile, the other a move of the whole model) can never hide one another's parts.
 * The home is the workspace holding the newest save of all; `others` are the rest that still
 * hold a save, which the next write gathers into the home. `scopeSlug` is the workspace the
 * page is about (null for the hub): where a first save is suggested to go.
 */
function resolveHome(candidates: readonly HomeCandidate[], scopeSlug: string | null, home: string): Resolved {
  const held = candidates.map(readHeld);
  const effective = {} as Record<CostModelPart, EffectivePart>;
  for (const part of COST_MODEL_PARTS) {
    const newest = held
      .filter((candidate) => candidate.parts[part].status !== "default")
      .sort((a, b) => b.parts[part].stampMs - a.parts[part].stampMs || a.slug.localeCompare(b.slug))[0];
    effective[part] = newest
      ? { value: newest.parts[part].value, from: newest, unreadable: newest.parts[part].error }
      : { value: { ...(DEFAULT_COST_MODEL[part] as object) }, from: null, unreadable: null };
  }
  const saved = held.filter((candidate) => candidate.saved).sort((a, b) => b.stampMs - a.stampMs || a.slug.localeCompare(b.slug));
  const chosen = saved[0] ?? null;
  const inScope = scopeSlug === null ? undefined : candidates.find((candidate) => candidate.slug === scopeSlug);
  const suggested = chosen?.slug ?? inScope?.slug ?? candidates.find((candidate) => isSynced(candidate.store, home))?.slug ?? candidates[0]?.slug ?? null;
  return {
    held,
    effective,
    home: chosen,
    view: {
      slug: chosen?.slug ?? null,
      prefix: chosen?.prefix ?? null,
      synced: chosen !== null && isSynced(chosen.store, home),
      others: saved.slice(1).map((candidate) => ({ slug: candidate.slug, prefix: candidate.prefix, savedAt: new Date(candidate.stampMs).toISOString() })),
      suggested,
    },
  };
}

function responseOf(resolved: Resolved): CostModelResponse {
  // A part whose newest save this build cannot read: say so rather than mix in a default.
  for (const part of COST_MODEL_PARTS) {
    const refusal = resolved.effective[part].unreadable;
    if (refusal) throw refusal;
  }
  const model = Object.fromEntries(COST_MODEL_PARTS.map((part) => [part, resolved.effective[part].value])) as unknown as CostModel;
  const source = Object.fromEntries(COST_MODEL_PARTS.map((part) => [part, resolved.effective[part].from === null ? "default" : "saved"])) as Record<CostModelPart, "saved" | "default">;
  // The read-time defaults below are applied here only, so a write carries stored values as they are.
  const view = { ...model, solo: profileView(model.solo, model), company: profileView(model.company, model) };
  return { model: view as unknown as CostModelValue, source, home: resolved.view, agentTypes: [...AGENT_TYPES] };
}

const own = (record: Readonly<Record<string, number>>, key: string): number | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * A profile as a read answers it: exactly the roles in the list have a rate (one the profile
 * does not set reads at `DEFAULT_ROLE_RATE` and is listed as assumed; a removed role's rate is
 * left out, so the read can be echoed back as a valid write), and every entry has its kind, its
 * quantity (null for an API bill) and its role (null for shared spend).
 */
function profileView(profile: ProfileValue, model: CostModel): ProfileValue {
  const ids = model.roles.roles.map((role) => role.id);
  const missing = ids.filter((id) => own(profile.rates, id) === undefined);
  const rates = Object.fromEntries(ids.map((id) => [id, own(profile.rates, id) ?? DEFAULT_ROLE_RATE]));
  const assumed = [...new Set([...(profile.assumed ?? []), ...missing.map((id) => `roles.${id}.hourlyRate`)])];
  const entries = profile.entries.map((entry) => {
    const kind = kindOf(entry);
    return { ...entry, kind, quantity: kind === "subscription" ? (entry.quantity ?? 1) : null, roleId: entry.roleId ?? null };
  });
  return { ...profile, rates, assumed, entries } as unknown as ProfileValue;
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
 * Every write gathers the model into one workspace, the target (the named home, else the
 * current one): each part is written there as this write sets it, else as its newest save
 * anywhere, else left at (or reset to) its default. Every other workspace still holding a saved
 * part has it reset, so a later reset or move can never bring a superseded value back. No
 * workspace is touched while a part it would change has an open cloud conflict, and a part
 * whose newest save this build cannot read is refused unless the write replaces it.
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

  type Op = { op: "set"; key: string; value: unknown } | { op: "reset"; key: string };
  const targetOps: Op[] = [];
  const targetParts: CostModelPart[] = [];
  for (const part of COST_MODEL_PARTS) {
    const key = COST_MODEL_KEYS[part];
    const effective = before.effective[part];
    const heldHere = target.parts[part].status === "saved";
    let op: Op | null = null;
    if (reset.includes(part)) op = heldHere ? { op: "reset", key } : null;
    else if (parts[part] !== undefined) op = { op: "set", key, value: parts[part] };
    else if (effective.unreadable) throw effective.unreadable;
    else if (effective.from !== null && effective.from.slug !== target.slug) op = { op: "set", key, value: effective.value };
    else if (effective.from === null && heldHere) op = { op: "reset", key };
    if (op === null) continue;
    targetOps.push(op);
    targetParts.push(part);
  }
  const plan: Array<{ candidate: Held; ops: Op[]; parts: CostModelPart[] }> = [{ candidate: target, ops: targetOps, parts: targetParts }];
  for (const other of before.held) {
    if (other.slug === target.slug) continue;
    const held = COST_MODEL_PARTS.filter((part) => other.parts[part].status === "saved");
    if (held.length > 0) plan.push({ candidate: other, ops: held.map((part) => ({ op: "reset" as const, key: COST_MODEL_KEYS[part] })), parts: held });
  }
  for (const step of plan) assertNoConflict(step.candidate.store, step.parts);
  const written: string[] = [];
  for (const step of plan) {
    if (step.ops.length > 0) step.candidate.store.applySettingOps(step.ops, options.actor);
    written.push(step.candidate.slug);
  }
  return { response: readCostModel(candidates, options.scopeSlug, stapleHomeDir), written };
}
