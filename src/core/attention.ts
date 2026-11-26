/**
 * The attention list: the work waiting on a PERSON, as rows.
 *
 * The inbox and the pickup queue answer what an agent may take. This answers the other half:
 * what only a person can move. Every surface reads these rows and nothing else: `staple
 * attention`, the `attention` MCP tool and the web view's `/api/attention` all call
 * `attentionList`, so the three cannot disagree about what is on it.
 *
 * ## One registry of kinds
 *
 * `ATTENTION_KINDS` is the list. Each entry says what its rows are called, whether a person
 * may dismiss one, and how to collect them from one workspace. The array order IS the
 * presentation order: gates and person-owned blockers first, then the rest. Adding a kind is
 * one entry here (and its label wherever a surface words it); no surface switches on kinds to
 * decide membership or order.
 *
 * ## What is never on it
 *
 * A ready ticket is not on it because it is in the pickup queue: the queue is the plan, and
 * repeating it here would turn the list into a second inbox. Every kind below is a fact that
 * stays true until a person acts, and the list is empty when none of them hold.
 *
 * ## Who is a person
 *
 * A gate owner is a person by definition (`staple gate --owner` names who must act). For an
 * unblock owner the codebase has no stored flag, so the rule is the evidence the workspace
 * already holds, in this order:
 *
 *  1. A name the workspace already treats as a person is one: this machine's `humanName`, a
 *     member of the shared workspace, or the owner of any gate.
 *  2. Otherwise a name the workspace has seen ACTING as an agent is not one: a claim holder,
 *     an attempt's agent, a run's actor, or the author of an agent comment.
 *  3. Anything else is a person: `staple block --owner` names who must act, and the run
 *     rules already read a named owner as a person (`vp_blocked`).
 *
 * Names are compared trimmed and case-insensitively, the way member names are.
 *
 * ## Dismissal
 *
 * Two kinds report something that happened rather than a state that holds: a ticket made
 * ready because its cross-repository blockers closed, and a stopped autopilot run. Each stays
 * until the state moves on (the ticket is claimed, a new run starts on the same scope) or a
 * person dismisses it. A dismissal is an `attention_dismissed` event naming the row's key, a
 * local fact like the `cross_blockers_resolved` event it answers.
 */
import { userInfo } from "node:os";
import { readConfig } from "../config/file.js";
import { stapleHome } from "../config/home.js";
import { listConflicts } from "./cloud/conflicts.js";
import { currentMembers } from "./cloud/members-cache.js";
import { insertEvent } from "./event-log.js";
import { Hub } from "./hub.js";
import { holdingCrossBlockers } from "./hub-cross-blockers.js";
import { isGoalRunGate } from "./milestones.js";
import { databaseFile, readDriver } from "./run-attachment.js";
import { LIVE_RUN_STATES } from "./run-store.js";
import type { Run, RunStopReason } from "./run-store.js";
import type { WorkspaceStore } from "./store.js";
import { type Issue, StapleError, formatAgo, nowIso } from "./types.js";

/** The setting that says how long a claim's holder may stay silent before the list shows it. */
export const SILENT_CLAIM_SETTING = "queue.silentClaimMinutes";

/** The event a dismissal writes. */
export const ATTENTION_DISMISSED_EVENT = "attention_dismissed";

/** Who a stop was recorded by when `staple run drive` itself stopped the run (not a person). */
const DRIVER_ACTOR = "staple run drive";

export type AttentionVerb = "review" | "open" | "unblock" | "inspect" | "resolve";

/** The one thing a person does with a row: what it is called, and the command that does it. */
export interface AttentionAction {
  verb: AttentionVerb;
  label: string;
  command: string;
}

export interface AttentionRow {
  /** Stable across reads: `<workspace>/<kind>/<id>`. What a dismissal and a notification key on. */
  key: string;
  workspace: string;
  kind: AttentionKind;
  /** The kind's heading, so a surface never keeps its own copy of the words. */
  label: string;
  /** The ticket the row is about; null for a run over the whole queue. */
  ref: string | null;
  /** Set on a stopped-run row. */
  runId: string | null;
  /** Set on a cloud-conflict row. */
  conflictId: string | null;
  /** A cloud-conflict row's two values, as values (the detail line truncates them); null on every other row. */
  conflict: AttentionConflict | null;
  title: string;
  /** One line saying why it waits: "awaiting VP", "held by eng-1 · silent 2h". */
  detail: string;
  /** When it started waiting. */
  since: string;
  ageSeconds: number;
  action: AttentionAction;
  /** A person may take it off the list without acting on it. */
  dismissible: boolean;
}

/** What two devices disagree about: one field of one record, and each side's value. */
export interface AttentionConflict {
  entity: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
}

/** What a kind's collector gets: one workspace, read at one instant. */
export interface AttentionContext {
  store: WorkspaceStore;
  workspace: string;
  now: string;
  home: string;
  /** The open issues, read once and shared by every collector. */
  issues: Issue[];
  /** `<kind>/<id>` of every row a person dismissed. */
  dismissed: ReadonlySet<string>;
  isPerson(name: string): boolean;
}

type RowDraft = Omit<AttentionRow, "key" | "workspace" | "kind" | "label" | "ageSeconds" | "dismissible" | "runId" | "conflictId" | "conflict"> & {
  id: string;
  runId?: string;
  conflictId?: string;
  conflict?: AttentionConflict;
};

export interface AttentionKindSpec {
  kind: string;
  /** The section heading every surface prints. */
  label: string;
  dismissible: boolean;
  collect(context: AttentionContext): RowDraft[];
}

const ws = (context: AttentionContext): string => `--ws ${context.workspace}`;

/** When the issue last moved into the status it has now, from the event log; else its last update. */
function enteredStatusAt(context: AttentionContext, issue: Issue): string {
  const row = context.store.db
    .prepare(
      "SELECT MAX(created_at) AS at FROM events WHERE issue_id = ? AND kind = 'status_changed' AND json_extract(payload, '$.to') = ?",
    )
    .get(issue.id, issue.status) as { at: string | null } | undefined;
  return row?.at ?? issue.updatedAt;
}

/** Is the issue's pending gate a resubmission: was the gate request before this one answered with changes requested? */
function resubmitted(context: AttentionContext, issueId: string): boolean {
  const kinds = (
    context.store.db
      .prepare(
        "SELECT kind FROM events WHERE issue_id = ? AND kind IN ('gate_requested', 'gate_changes_requested', 'gate_approved') ORDER BY seq DESC LIMIT 2",
      )
      .all(issueId) as Array<{ kind: string }>
  ).map((row) => row.kind);
  return kinds[0] === "gate_requested" && kinds[1] === "gate_changes_requested";
}

function gateRows(context: AttentionContext, wantResubmitted: boolean): RowDraft[] {
  const gates = context.store.gateFor(context.issues.map((issue) => issue.id));
  // A goal run's gate holds its milestone while the run works; it is the person's once the run ends.
  const liveRunScopes = new Set(
    (
      context.store.db
        .prepare(`SELECT scope_issue_id FROM runs WHERE scope_issue_id IS NOT NULL AND state IN (${LIVE_RUN_STATES.map(() => "?").join(", ")})`)
        .all(...LIVE_RUN_STATES) as Array<{ scope_issue_id: string }>
    ).map((row) => row.scope_issue_id),
  );
  const rows: RowDraft[] = [];
  for (const issue of context.issues) {
    const gate = gates.get(issue.id);
    if (gate?.state !== "pending") continue;
    if (isGoalRunGate(gate.requestedBy) && liveRunScopes.has(issue.id)) continue;
    if (resubmitted(context, issue.id) !== wantResubmitted) continue;
    rows.push({
      id: issue.identifier,
      ref: issue.identifier,
      title: issue.title,
      detail: wantResubmitted ? `resubmitted for ${gate.owner} after changes were requested` : `awaiting ${gate.owner}`,
      since: gate.requestedAt || issue.updatedAt,
      action: { verb: "review", label: "Approve or request changes", command: `staple approve ${issue.identifier} ${ws(context)}` },
    });
  }
  return rows;
}

const REASON_WORDS: Readonly<Record<RunStopReason, string>> = {
  stopped_by_human: "stopped by its driver",
  touched_main_line: "a session changed master or main",
  budget: "reached its limit",
  failure_streak: "two tickets in a row failed",
  scope_gone: "its work no longer exists",
  vp_blocked: "waiting on a person",
  gate_pending: "waiting for approval",
  planning_needed: "the plan needs work",
  goal_met: "goal met",
  scope_empty: "nothing left to do",
};

/** A conflicting value, short enough for one line. */
function shortValue(value: unknown): string {
  const text = value === undefined ? "nothing" : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** `gh pr checks 12 --repo owner/repo`, from the pull request's key; its URL on another host or when the key is not that shape. */
function ghChecksCommand(pr: { key: string; url: string }): string {
  const match = /^([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(pr.key);
  return match && pr.url.startsWith("https://github.com/") ? `gh pr checks ${match[2]} --repo ${match[1]}` : `gh pr checks ${pr.url}`;
}

const scopeKey = (run: Run): string => (run.scope.kind === "queue" ? "queue" : run.scope.issueId);

/**
 * THE KINDS, in presentation order. Gates and blockers owned by a person come first.
 */
export const ATTENTION_KINDS = [
  {
    kind: "gate_pending",
    label: "Gates waiting on approval",
    dismissible: false,
    collect: (context) => gateRows(context, false),
  },
  {
    kind: "gate_resubmitted",
    label: "Gates resubmitted",
    dismissible: false,
    collect: (context) => gateRows(context, true),
  },
  {
    kind: "person_blocked",
    label: "Blocked on a person",
    dismissible: false,
    collect: (context) =>
      context.issues
        .filter((issue) => context.store.categoryOf(issue.status) === "blocked")
        .filter((issue) => (issue.unblockOwner ?? "").trim() !== "" && context.isPerson(issue.unblockOwner!))
        .map((issue) => ({
          id: issue.identifier,
          ref: issue.identifier,
          title: issue.title,
          detail: `waiting on ${issue.unblockOwner}`,
          since: issue.blockedTransitionAt ?? issue.updatedAt,
          action: { verb: "unblock", label: issue.unblockAction?.trim() || "Unblock", command: `staple show ${issue.identifier} ${ws(context)}` },
        })),
  },
  {
    kind: "in_review",
    label: "In review",
    dismissible: false,
    collect: (context) =>
      context.issues
        .filter((issue) => context.store.categoryOf(issue.status) === "review")
        .map((issue) => ({
          id: issue.identifier,
          ref: issue.identifier,
          title: issue.title,
          detail: issue.assignee ? `finished by ${issue.assignee}` : "finished, waiting for a review",
          since: enteredStatusAt(context, issue),
          action: { verb: "review", label: "Open for review", command: `staple show ${issue.identifier} ${ws(context)}` },
        })),
  },
  {
    /**
     * A pull request linked to an open ticket whose head's checks fail, from the saved copy the
     * last pull-request read left (`integrations discover`, the web UI's poll). It holds until a
     * read sees the checks pass, or the pull request merge or close.
     */
    kind: "pr_checks_failing",
    label: "Pull requests with failing checks",
    dismissible: false,
    collect: (context) => {
      const pullRequests = context.store.externalLinks().pullRequests();
      return context.issues.flatMap((issue) =>
        (pullRequests.get(issue.id) ?? [])
          .filter((pr) => pr.checks?.state === "failing" && (pr.state === "open" || pr.state === "draft"))
          .map((pr) => ({
            id: `${issue.identifier}:${pr.key}`,
            ref: issue.identifier,
            title: issue.title,
            detail: `checks failing on ${pr.key}${pr.checks!.failing.length ? `: ${pr.checks!.failing.join(", ")}` : ""}`,
            since: pr.checks!.completedAt ?? pr.fetchedAt ?? pr.linkedAt,
            // Built from the key, never the synced URL, so the command is safe to copy.
            action: { verb: "open" as const, label: "Open", command: ghChecksCommand(pr) },
          })),
      );
    },
  },
  {
    /** A ticket made ready because its cross-repository blockers closed (`cross_blockers_resolved`). */
    kind: "unblocked",
    label: "Ready again: blockers in other workspaces closed",
    dismissible: true,
    collect: (context) => {
      const open = new Map(context.issues.map((issue) => [issue.id, issue]));
      const events = context.store.db
        .prepare(
          `SELECT e.seq, e.issue_id, e.created_at FROM events e
            WHERE e.kind = 'cross_blockers_resolved'
              AND e.seq = (SELECT MAX(seq) FROM events WHERE kind = 'cross_blockers_resolved' AND issue_id = e.issue_id)
              AND NOT EXISTS (SELECT 1 FROM events c WHERE c.issue_id = e.issue_id AND c.kind = 'checkout' AND c.seq > e.seq)`,
        )
        .all() as Array<{ seq: number; issue_id: string; created_at: string }>;
      const rows: RowDraft[] = [];
      // Ready means ready now: no local blocker open, and no cross-workspace blocker holding it again.
      const local = context.store.unresolvedBlockersFor(events.map((event) => event.issue_id));
      const cross = context.store.crossBlockers(context.home);
      for (const event of events) {
        const issue = open.get(event.issue_id);
        if (!issue || issue.checkoutAgent) continue;
        if ((local.get(issue.id) ?? []).length > 0) continue;
        if (holdingCrossBlockers(cross.get(issue.identifier) ?? []).length > 0) continue;
        const category = context.store.categoryOf(issue.status);
        if (category !== "ready" && category !== "unstarted") continue;
        const id = `${issue.identifier}@${event.seq}`;
        if (context.dismissed.has(`unblocked/${id}`)) continue;
        rows.push({
          id,
          ref: issue.identifier,
          title: issue.title,
          detail: "its blockers in other workspaces closed",
          since: event.created_at,
          action: { verb: "open", label: "Open", command: `staple show ${issue.identifier} ${ws(context)}` },
        });
      }
      return rows;
    },
  },
  {
    kind: "run_stopped",
    label: "Stopped autopilot runs",
    dismissible: true,
    collect: (context) => {
      const runs = context.store.runs().list({ all: true });
      const rows: RowDraft[] = [];
      for (const run of runs) {
        if (run.state !== "stopped" || run.stop === null || run.endedAt === null) continue;
        // A person who stopped a run knows; a stop the driver recorded is the driver's.
        if (run.stop.reason === "stopped_by_human" && run.stop.by !== DRIVER_ACTOR) continue;
        // A later run on the same scope by the same actor is the person having moved on.
        const superseded = runs.some(
          (other) => other.id !== run.id && other.actor === run.actor && scopeKey(other) === scopeKey(run) && other.startedAt >= run.endedAt!,
        );
        if (superseded || context.dismissed.has(`run_stopped/${run.id}`)) continue;
        rows.push({
          id: run.id,
          runId: run.id,
          ref: run.scope.kind === "queue" ? null : run.scope.identifier,
          title: run.scope.kind === "queue" ? `Autopilot run by ${run.actor} over the queue` : `Autopilot run by ${run.actor}`,
          detail: `stopped: ${REASON_WORDS[run.stop.reason] ?? run.stop.reason}`,
          since: run.endedAt,
          action: { verb: "inspect", label: "Inspect", command: `staple run status ${run.id} ${ws(context)}` },
        });
      }
      return rows;
    },
  },
  {
    /**
     * A live run whose `staple run drive` process on this machine ended without detaching
     * (crashed, killed, the machine slept through it): the run is still live and takes nothing,
     * and nothing else says so. A run with no driver at all is not one (a stop hook or a person
     * keeps it going), nor is a driver on another machine, whose process this one cannot see.
     * It holds until a driver attaches again or a person stops the run.
     */
    kind: "run_stalled",
    label: "Autopilot runs whose driver stopped",
    dismissible: false,
    collect: (context) => {
      const dbFile = databaseFile(context.store.db);
      return context.store
        .runs()
        .list({ all: true })
        .filter((run) => LIVE_RUN_STATES.includes(run.state))
        .flatMap((run) => {
          const driver = readDriver(dbFile, run.id);
          if (driver?.alive !== false) return [];
          return [
            {
              id: run.id,
              runId: run.id,
              ref: run.scope.kind === "queue" ? null : run.scope.identifier,
              title: run.scope.kind === "queue" ? `Autopilot run by ${run.actor} over the queue` : `Autopilot run by ${run.actor}`,
              detail: `its ${driver.agent} driver stopped responding; it takes nothing until a driver attaches or it is stopped`,
              since: driver.heartbeatAt || run.updatedAt,
              action: { verb: "inspect" as const, label: "Inspect", command: `staple run status ${run.id} ${ws(context)}` },
            },
          ];
        });
    },
  },
  {
    kind: "claim_silent",
    label: "Silent claims",
    dismissible: false,
    collect: (context) => {
      const minutes = Number(context.store.getSetting(SILENT_CLAIM_SETTING));
      const threshold = minutes * 60;
      const active = context.issues.filter((issue) => issue.checkoutAgent && context.store.categoryOf(issue.status) === "active");
      const claims = context.store.claimActivityFor(active.map((issue) => issue.id));
      const rows: RowDraft[] = [];
      for (const issue of active) {
        const claim = claims.get(issue.id);
        if (!claim || claim.idleSeconds < threshold) continue;
        rows.push({
          id: issue.identifier,
          ref: issue.identifier,
          title: issue.title,
          detail: `held by ${claim.heldBy} · silent ${formatAgo(claim.idleSeconds)}`,
          since: claim.lastActivityAt,
          // Never a steal: the list shows the silence, and taking the work over stays a separate, explicit act.
          action: { verb: "open", label: "Open", command: `staple show ${issue.identifier} ${ws(context)}` },
        });
      }
      return rows;
    },
  },
  {
    kind: "cloud_conflict",
    label: "Sync conflicts",
    dismissible: false,
    collect: (context) => {
      const identifiers = new Map(
        (context.store.db.prepare("SELECT id, identifier, title FROM issues").all() as Array<{ id: string; identifier: string; title: string }>).map(
          (row) => [row.id, row],
        ),
      );
      return listConflicts(context.store.db).map((conflict) => {
        const issue = conflict.entity === "issue" ? identifiers.get(conflict.entityId) : undefined;
        return {
          id: conflict.id,
          conflictId: conflict.id,
          conflict: { entity: conflict.entity, field: conflict.field, localValue: conflict.localValue, remoteValue: conflict.remoteValue },
          ref: issue?.identifier ?? null,
          title: issue ? issue.title : `${conflict.entity} ${conflict.entityId}`,
          detail: `${conflict.field}: ${shortValue(conflict.localValue)} here, ${shortValue(conflict.remoteValue)} on another device`,
          since: conflict.detectedAt,
          action: { verb: "resolve", label: "Resolve", command: `staple cloud resolve ${conflict.id} --take local|remote ${ws(context)}` },
        };
      });
    },
  },
] as const satisfies readonly AttentionKindSpec[];

export type AttentionKind = (typeof ATTENTION_KINDS)[number]["kind"];

const KIND_RANK = new Map<string, number>(ATTENTION_KINDS.map((spec, index) => [spec.kind, index]));

/** The heading a surface prints over a kind's rows. */
export function attentionKindLabel(kind: AttentionKind): string {
  return ATTENTION_KINDS.find((spec) => spec.kind === kind)!.label;
}

const normalize = (name: string): string => name.trim().toLowerCase();

/** The person rule (see the file header), over one workspace. */
export function personRule(store: WorkspaceStore, home: string = stapleHome()): (name: string) => boolean {
  const people = new Set<string>();
  const agents = new Set<string>();
  try {
    const humanName = readConfig(home).config.humanName;
    if (humanName) people.add(normalize(humanName));
  } catch {
    // An unreadable config names nobody.
  }
  // The person at this terminal: the CLI records a claim without STAPLE_AGENT under $USER.
  try {
    people.add(normalize(userInfo().username));
  } catch {
    // No user database entry: nobody to add.
  }
  if (process.env.USER) people.add(normalize(process.env.USER));
  const lens = store.members(home);
  if (lens) for (const member of currentMembers(lens.cache)) people.add(normalize(member.name));
  const names = (sql: string): string[] => (store.db.prepare(sql).all() as Array<{ name: string | null }>).flatMap((row) => (row.name ? [row.name] : []));
  for (const name of names("SELECT DISTINCT gate_owner AS name FROM issues WHERE gate_owner IS NOT NULL")) people.add(normalize(name));
  for (const name of [
    ...names("SELECT DISTINCT checkout_agent AS name FROM issues WHERE checkout_agent IS NOT NULL"),
    ...names("SELECT DISTINCT agent AS name FROM attempts"),
    ...names("SELECT DISTINCT actor AS name FROM runs"),
    ...names("SELECT DISTINCT author AS name FROM comments WHERE author_type = 'agent'"),
  ]) {
    agents.add(normalize(name));
  }
  return (name) => {
    const key = normalize(name);
    if (people.has(key)) return true;
    return !agents.has(key);
  };
}

function dismissedKeys(store: WorkspaceStore): Set<string> {
  const rows = store.db
    .prepare(`SELECT json_extract(payload, '$.key') AS key FROM events WHERE kind = '${ATTENTION_DISMISSED_EVENT}'`)
    .all() as Array<{ key: string | null }>;
  return new Set(rows.flatMap((row) => (row.key ? [row.key] : [])));
}

const secondsBetween = (from: string, to: string): number => {
  const delta = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta)) : 0;
};

/** What a row is called on its first line: the ticket, the run, or nothing (a conflict on a non-ticket). */
export function attentionSubject(row: Pick<AttentionRow, "ref" | "runId">): string | null {
  return row.ref ?? (row.runId ? `run ${row.runId.slice(0, 8)}` : null);
}

/** One workspace's rows, in presentation order. */
export function workspaceAttention(
  store: WorkspaceStore,
  workspace: string = store.slug,
  options: { now?: string; home?: string } = {},
): AttentionRow[] {
  const now = options.now ?? nowIso();
  const home = options.home ?? stapleHome();
  const context: AttentionContext = {
    store,
    workspace,
    now,
    home,
    issues: store.listIssues({}),
    dismissed: dismissedKeys(store),
    isPerson: personRule(store, home),
  };
  const rows: AttentionRow[] = [];
  for (const spec of ATTENTION_KINDS as readonly AttentionKindSpec[]) {
    for (const { id, runId, conflictId, conflict, ...draft } of spec.collect(context)) {
      rows.push({
        key: `${workspace}/${spec.kind}/${id}`,
        workspace,
        kind: spec.kind as AttentionKind,
        label: spec.label,
        runId: runId ?? null,
        conflictId: conflictId ?? null,
        conflict: conflict ?? null,
        ...draft,
        ageSeconds: secondsBetween(draft.since, now),
        dismissible: spec.dismissible,
      });
    }
  }
  return sortAttention(rows);
}

/** Kind order first; within a kind the longest waiting first. */
export function sortAttention(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort(
    (a, b) =>
      KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)! ||
      b.ageSeconds - a.ageSeconds ||
      a.workspace.localeCompare(b.workspace) ||
      a.key.localeCompare(b.key),
  );
}

export interface AttentionList {
  rows: AttentionRow[];
  /** The workspaces read. */
  workspaces: string[];
  /** Workspaces that could not be read, each with why. Their rows are missing, never guessed. */
  failed: Array<{ workspace: string; message: string }>;
  now: string;
}

/** A workspace to read: its store, or how to open it (so one that cannot be opened is reported, not fatal). */
export type AttentionSource = { slug: string; store: WorkspaceStore } | { slug: string; open: () => WorkspaceStore };

/**
 * Every available workspace this machine's hub knows, each opened only when it is read, so a
 * workspace whose database cannot be opened lands in `failed` instead of failing the list.
 */
export function hubAttentionSources(open: (slug: string) => WorkspaceStore): AttentionSource[] {
  const hub = Hub.open();
  try {
    return hub.list().filter((entry) => entry.available).map((entry) => ({ slug: entry.slug, open: () => open(entry.slug) }));
  } finally {
    hub.close();
  }
}

/** Every given workspace's rows, merged into one list in presentation order. */
export function attentionList(sources: ReadonlyArray<AttentionSource>, options: { now?: string; home?: string } = {}): AttentionList {
  const now = options.now ?? nowIso();
  const rows: AttentionRow[] = [];
  const failed: AttentionList["failed"] = [];
  for (const source of sources) {
    try {
      const store = "store" in source ? source.store : source.open();
      rows.push(...workspaceAttention(store, source.slug, { ...options, now }));
    } catch (error) {
      failed.push({ workspace: source.slug, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows: sortAttention(rows), workspaces: sources.map((source) => source.slug), failed, now };
}

/**
 * Take a row off the list without acting on it: a ticket made ready by its cross-repository
 * blockers, or a stopped run. `target` is the row's key, its ticket, or its run id. Refuses a
 * row of a kind a person cannot dismiss (a gate is answered, never dismissed).
 */
export function dismissAttention(store: WorkspaceStore, target: string, actor: string | null, options: { home?: string } = {}): AttentionRow {
  const rows = workspaceAttention(store, store.slug, options);
  const wanted = target.trim();
  const matches = rows.filter(
    (row) => row.key === wanted || row.runId === wanted || (row.ref !== null && row.ref.toUpperCase() === wanted.toUpperCase()),
  );
  const row = matches.find((candidate) => candidate.dismissible);
  if (!row) {
    if (matches.length > 0) {
      throw new StapleError(
        "validation",
        `${wanted} is on the attention list as ${attentionKindLabel(matches[0]!.kind).toLowerCase()}, which a person answers rather than dismisses: ${matches[0]!.action.command}`,
      );
    }
    throw new StapleError("not_found", `Nothing on the attention list matches ${wanted}. Run \`staple attention\` to see the rows.`);
  }
  const issue = row.ref && row.kind === "unblocked" ? (store.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(row.ref) as { id: string } | undefined) : undefined;
  store.journaled(() =>
    insertEvent(store.db, {
      kind: ATTENTION_DISMISSED_EVENT,
      issueId: issue?.id ?? null,
      actor,
      payload: { key: row.key.slice(row.workspace.length + 1), kind: row.kind, ref: row.ref, runId: row.runId },
    }),
  );
  return row;
}

/** The list as the terminal prints it, and as the MCP tool's text answer reads. */
export function attentionText(list: AttentionList): string {
  const lines: string[] = [];
  if (list.rows.length === 0) {
    lines.push(`Nothing is waiting on a person${list.workspaces.length > 1 ? ` in ${list.workspaces.length} workspaces` : ""}.`);
  }
  const subjectOf = (row: AttentionRow): string => attentionSubject(row) ?? "-";
  const wsWidth = Math.max(0, ...list.rows.map((row) => row.workspace.length));
  const subjectWidth = Math.max(0, ...list.rows.map((row) => subjectOf(row).length));
  const indent = " ".repeat(2 + subjectWidth + 2 + wsWidth + 2 + 4 + 2);
  let kind: string | null = null;
  for (const row of list.rows) {
    if (row.kind !== kind) {
      kind = row.kind;
      if (lines.length > 0) lines.push("");
      lines.push(`${attentionKindLabel(row.kind).toUpperCase()} (${list.rows.filter((other) => other.kind === row.kind).length})`);
    }
    lines.push(`  ${subjectOf(row).padEnd(subjectWidth)}  ${row.workspace.padEnd(wsWidth)}  ${formatAgo(row.ageSeconds).padStart(4)}  ${row.title}`);
    lines.push(`${indent}${row.detail}`);
    lines.push(`${indent}${row.action.label}: ${row.action.command}`);
  }
  for (const failure of list.failed) lines.push(`(could not read ${failure.workspace}: ${failure.message})`);
  return lines.join("\n");
}
