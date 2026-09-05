/**
 * The create dialog's state -> one `{ type: "create" }` ActionPayload. Owned by U5,
 * widened by R7 (STA-103).
 *
 * Split out of the dialog because this is the only part of creating a task that can be
 * wrong in a way nobody sees. Two rules run through all of it:
 *
 *  1. ABSENT is not EMPTY. `store.createIssue` reads `undefined` as "use the default"
 *     and a value as "use this", so an untouched field has to disappear from the payload
 *     rather than arrive as `""` or `[]`. A description of `""` would overwrite nothing
 *     today and would be a lie tomorrow.
 *  2. This module validates NOTHING. A blank title is sent blank, so `createIssue`
 *     throws its own "Title is required" and the dialog renders that sentence. Every
 *     rule about what a task may be lives in the store; a copy here is a second rule
 *     that can drift from the first.
 *
 * R7 changed the SHAPE and not the CONTRACT. `labels` and `blockedBy` are lists now that
 * they come from a dropdown rather than a text box, and `blocking` joined them — but
 * what reaches `store.createIssue` is what it always was, plus one key.
 *
 * Pure and DOM-free on purpose — it is unit-tested next door without React.
 */
import type { SelectOption } from "./ui/searchable-select";
import { DEFAULT_ISSUE_KIND, type ActionPayload, type IssueKind, type IssuePriority, type IssueRow } from "../lib/types";

/** Exactly what the dialog holds in state. */
export interface CreateFormState {
  title: string;
  description: string;
  priority: IssuePriority;
  /**
   * The declared kind — O1b (STA-125). Always a real value, never "": the control is a
   * select over the workspace's vocabulary, so there is no "untouched" state to
   * distinguish, exactly as with `priority`.
   */
  kind: IssueKind;
  /** A single ref, or "". Single-select, because a task has one parent. */
  parent: string;
  labels: string[];
  /** Refs that must finish before this task can start. */
  blockedBy: string[];
  /**
   * Refs this task will block — the INVERSE relation, new in R7.
   *
   * Nothing in the store takes this as create input. See the `create` branch of
   * src/ui/server.ts: it is applied after the insert by rewriting each target's
   * blocked-by set, because `setBlockedBy` replaces rather than appends. That
   * read-modify-write lives on the server so it cannot straddle a round trip.
   */
  blocking: string[];
  /**
   * The project to file it under — a `Project.id`, or "" for none. Single-select for the
   * reason `parent` is: an issue is in one project or none.
   */
  project: string;
}

/** Medium is the store's own create-time default, so an untouched form agrees with it. */
export const EMPTY_CREATE_FORM: CreateFormState = {
  title: "",
  description: "",
  priority: "medium",
  // Same rule as `priority`: the store's own create-time default, so an untouched form
  // agrees with what a `staple new` with no flags would have produced. The DIALOG
  // reconciles this against the served vocabulary — see createFormDefaultKind().
  kind: DEFAULT_ISSUE_KIND,
  parent: "",
  labels: [],
  blockedBy: [],
  blocking: [],
  project: "",
};

/**
 * Which kind a fresh form starts on, given the workspace's served vocabulary — O1b
 * (STA-125).
 *
 * `task` when it is there, which is the ticket's requirement and is true of every
 * workspace that has not been reconfigured. The fallback is the FIRST served kind, and
 * only ever reached when the operator has removed `task` — at which point defaulting to
 * it anyway would put a value in the form that `store.assertConfiguredKind()` is
 * guaranteed to refuse, i.e. a control that cannot be used correctly.
 *
 * This deliberately does NOT mirror `store.defaultKind()` by rederiving its rule; it
 * mirrors its OUTCOME from the list the server sent, which is the only thing the browser
 * actually knows. An empty list (settings not fetched yet) answers the constant, because
 * a form that opens in the first 40ms of a cold page must still open on something.
 */
export function createFormDefaultKind(kinds: readonly string[]): IssueKind {
  if (kinds.length === 0) return DEFAULT_ISSUE_KIND;
  return kinds.includes(DEFAULT_ISSUE_KIND) ? DEFAULT_ISSUE_KIND : kinds[0]!;
}

/** Trim, drop blanks, de-duplicate — keeping the order they were first chosen in. */
function tidy(parts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Commas only. "needs review, ui" is two labels, not three — splitting on whitespace
 * as well would quietly shred every multi-word label an agent already wrote.
 *
 * Since R7 this is the CREATE path rather than the typing path: it splits what was
 * typed into the label search box when the "create «x»" offer is taken, so one enter
 * on "api, infra" makes two labels.
 */
export function splitLabels(raw: string): string[] {
  return tidy(raw.split(","));
}

/**
 * Commas and/or whitespace, because "STA-1 STA-2" and "STA-1, STA-2" are both what a
 * person types. Case is left alone: resolving a ref is the store's job, and lowercasing
 * here would decide something this form has no business deciding.
 *
 * Since R7 this is the PASTE path: dropping a list of refs into a relation search box
 * adds all of them rather than searching for one long string that matches nothing.
 */
export function splitRefs(raw: string): string[] {
  return tidy(raw.split(/[\s,]+/));
}

/**
 * What survives a change of target workspace. The parent cannot: a parent in the old
 * workspace has nowhere to be stored in the new one. Neither can the project: it is a
 * row of the old workspace, the select would show "No project" while the payload still
 * carried its id, and the server would refuse with not_found. The relations DO survive —
 * a blocker chosen before the switch is still a real task, just a cross-workspace one now.
 */
export function forWorkspaceSwitch(state: CreateFormState): CreateFormState {
  return { ...state, parent: "", project: "" };
}

/** The payload the dialog POSTs. Empty optional fields are omitted, not emptied. */
export function buildCreatePayload(state: CreateFormState): Extract<ActionPayload, { type: "create" }> {
  const payload: Extract<ActionPayload, { type: "create" }> = {
    type: "create",
    // Trimmed but never rejected — see rule 2 above.
    title: state.title.trim(),
    priority: state.priority,
  };

  /**
   * O1b (STA-125). Sent the way `priority` is — always, because the select always holds
   * a real value and there is no "untouched" to distinguish. The one guard is a blank,
   * which cannot come from the control and CAN come from a caller building this state by
   * hand: omitting it there is what makes the store apply its own default rather than
   * refusing an empty string, and rule 1 at the top of this file is exactly that.
   */
  const kind = state.kind.trim();
  if (kind) payload.kind = kind;

  const description = state.description.trim();
  if (description) payload.description = description;

  const parent = state.parent.trim();
  if (parent) payload.parent = parent;

  // Still tidied even though these arrive from a dropdown: a chip can be added,
  // removed and re-added against a stale option list, and the dialog should not be
  // the reason the store sees the same ref twice.
  const labels = tidy(state.labels);
  if (labels.length > 0) payload.labels = labels;

  const blockedBy = tidy(state.blockedBy);
  if (blockedBy.length > 0) payload.blockedBy = blockedBy;

  const blocking = tidy(state.blocking);
  if (blocking.length > 0) payload.blocking = blocking;

  // Omitted when untouched, for rule 1: an absent project is "none", and sending "" would
  // ask the server to look up a project called nothing.
  const project = state.project.trim();
  if (project) payload.project = project;

  return payload;
}

// ------------------------------------------------------------------ options

/** One row -> one option. The pill is its OWN workspace, never the target's. */
function toOption(row: IssueRow): SelectOption {
  return {
    value: row.issue.identifier,
    label: row.issue.identifier,
    hint: row.issue.title,
    pill: row.workspace,
    status: row.issue.status,
  };
}

/**
 * Options for PARENT — restricted to the target workspace, and this one stays restricted.
 *
 * R8 (STA-110) lifted the restriction on the blocking relations and deliberately left it
 * here, because a cross-workspace parent is not a policy we declined to allow — it is a
 * thing with nowhere to live:
 *
 *   - `issues.parent_id` holds a LOCAL row id. `createIssue` sets it from
 *     `this.requireRow(input.parent).id`, which resolves inside one workspace file;
 *   - `depth` is derived as `parent.depth + 1` and checked against MAX_TREE_DEPTH in the
 *     same transaction, so the parent's depth must be readable there too;
 *   - the hub's `cross_links` table has exactly one `type`, `'blocks'`. There is no
 *     parent edge in the hub schema, and `Hub.graph()` rebuilds parents from
 *     `issue.parentId` strictly within a workspace.
 *
 * Offering a foreign parent would mean a dangling id or a hub concept invented on the
 * way past. The field says so instead.
 */
export function parentOptions(rows: readonly IssueRow[], workspace: string): SelectOption[] {
  if (!workspace) return [];
  return rows.filter((row) => row.workspace === workspace).map(toOption);
}

/**
 * Options for BLOCKED BY and BLOCKING — every workspace in scope.
 *
 * This is the R8 correction, and R7 had it wrong. Cross-referencing across workspaces is
 * what a hub is FOR: a task in `staple` waiting on a task in `workshop` is the normal
 * case, not an edge case. The edge has always been storable — `Hub.addCrossLink` resolves
 * both identifiers through the registry, checks each side exists, and guards its own
 * cycles — it simply had no HTTP route until now, which R7 mistook for "unsupported".
 *
 * The two kinds of edge stay distinct all the way down, and the hub insists on it:
 * `addCrossLink` REFUSES a same-workspace pair with "use the workspace-local blocked-by
 * instead". So the server routes same-workspace picks to local relations and foreign
 * picks to hub links; this function's only job is to stop hiding the foreign ones.
 *
 * Target workspace first. Same-workspace remains the common case and stays one glance
 * away, and grouping by workspace is what makes the pill scannable rather than a badge
 * sprinkled through a list in arbitrary order.
 */
export function relationOptions(rows: readonly IssueRow[], workspace: string): SelectOption[] {
  const here = rows.filter((row) => row.workspace === workspace);
  const elsewhere = rows.filter((row) => row.workspace !== workspace);
  return [...here, ...elsewhere].map(toOption);
}

/**
 * The same options minus a set already spoken for — how Blocked by and Blocking stay
 * out of each other's way.
 *
 * This is NOT a copy of a store rule, which is the bar this file's header sets. The
 * store owns cycle detection (`assertNoCycle`, BFS over the whole blocks graph) and
 * still refuses anything this misses. What this removes is the ONE contradiction the
 * form can see in itself: naming the same task as both a blocker and a blockee is a
 * two-node cycle by construction, and the store can only say so AFTER the task has been
 * created — at which point the refusal arrives attached to a task that now exists.
 *
 * A control that cannot express the contradiction is better than a refusal that arrives
 * too late to undo. Found by evidence, not by reading: the shot list picked the first
 * option in each list, they collided, and the create came back 409 with the task
 * already written.
 */
export function withoutValues(
  options: readonly SelectOption[],
  taken: readonly string[],
): SelectOption[] {
  if (taken.length === 0) return [...options];
  const excluded = new Set(taken);
  return options.filter((option) => !excluded.has(option.value));
}

/**
 * Every distinct label in scope, commonest first.
 *
 * Gathered across ALL rows, not just the target workspace — and the asymmetry with
 * `issueOptions` is the point. A label is a plain string on the issue row: no join, no
 * foreign key, nothing to resolve. Reusing a name another project already uses is free
 * and is usually what you want, which is exactly what is NOT true of a ref.
 *
 * Ordered by count then alphabetically. The tiebreak is not cosmetic: without it the
 * list would reshuffle on every 1.5s poll that changed a count, under a cursor.
 */
export function labelOptions(rows: readonly IssueRow[]): SelectOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const label of row.issue.labels) {
      const value = label.trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}
