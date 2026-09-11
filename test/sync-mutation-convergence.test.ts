/**
 * Every public store mutation, and every conflict resolution, leaves every synchronized
 * column identical on the device that made it, a device that read it in the ordered tail,
 * and a device that hydrated afterwards from the snapshot.
 *
 * One generic property instead of a test per path. Paths were fixed one at a time — a
 * derived move, a gate, a checkout — and each round found the next one that journaled
 * fewer columns than it wrote: a release's `status_version`, a partial approval's
 * `gate_released`, an assignment's `updated_at`, a resolution's `normalized_title`. The
 * journal now records every synchronized column a mutation changed (`journal.ts`), and
 * this is what holds it to that: the registry below names every public mutation of the
 * four stores, a new one fails the first test until it is listed, and each is run and
 * compared column for column over every synchronized table (`docs/sync.md`, "What
 * synchronizes").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict, type ResolutionChoice } from "../src/core/cloud/conflicts.js";
import { acquireClaim, releaseClaim } from "../src/core/cloud/lease.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000180";
const ROOT = join(import.meta.dirname, "..");

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

// ------------------------------------------------------------------ the registry

const SOURCES = {
  WorkspaceStore: "src/core/store.ts",
  MilestoneStore: "src/core/milestone-store.ts",
  QueueStore: "src/core/queue-store.ts",
  ProjectStore: "src/core/project-store.ts",
} as const;
type StoreName = keyof typeof SOURCES;

/** Every public method a store declares, read from its source: TypeScript's `private` is not visible at run time. */
function publicMethods(store: StoreName): string[] {
  const text = readFileSync(join(ROOT, SOURCES[store]), "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/^ {2}(private |protected |static |readonly )*(async )?(get |set )?([a-zA-Z_][a-zA-Z0-9_]*)\s*(<[^>\n]*>)?\(/gm)) {
    if (match[1] || match[3]) continue;
    const name = match[4]!;
    if (["constructor", "if", "for", "while", "switch", "return"].includes(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

/** Public methods that write nothing: reads, and the scope helper every mutation runs in. */
const READS: Record<StoreName, readonly string[]> = {
  WorkspaceStore: [
    "journaled", "getStatuses", "getKinds", "kindAppearance", "getKindsWithAppearance", "kindOrder", "defaultKind",
    "statusOrder", "openStatusOrder", "inboxPickupOrder", "checkoutExpectedStatuses", "categoryOf", "isResolvedStatus",
    "isActiveStatus", "primaryStatusFor", "assertConfiguredStatus", "assertConfiguredKind", "statusUsageCount",
    "kindUsageCount", "getSetting", "settingValue", "settingValues", "unknownSettingKeys", "movedOff", "getIssue",
    "listEvents", "blockersOf", "dependentsOf", "unresolvedBlockersOf", "unresolvedBlockersFor", "openDependentsFor",
    "blockingChildrenOf", "gate", "gateFor", "queuedByFor", "gateQueueOf", "queuedBy", "claimActivity",
    "claimActivityFor", "worklogSummaryFor", "timingFor", "timing", "detailTiming", "listComments", "listCommentsPage",
    "getDocument", "listDocuments", "listDocumentRevisions", "listIssues", "listIssuesPage", "inbox", "context", "tree",
    "edges", "milestones", "queue", "projects", "writeTarget",
  ],
  MilestoneStore: ["queueSeam", "get", "list", "milestoneOf"],
  QueueStore: ["revision", "entries", "effectiveQueue", "view"],
  ProjectStore: ["list", "get", "issueCounts"],
};

interface World {
  readonly a: Machine;
  /** The tail device, which can write too — before it has heard of what A just wrote. */
  readonly b: Machine;
  readonly fleet: Fleet;
  /** Named rows the scenarios share, by id. */
  readonly ids: Record<string, string>;
}

interface Scenario {
  /** A store's public method, or a lease verb (`cloud/lease.ts`), which claims through the store. */
  readonly method: `${StoreName | "lease"}.${string}`;
  readonly name: string;
  /** Run on A, then synchronized with B before `run` — so `run` edits rows every device holds. */
  readonly prep?: (world: World) => void;
  readonly run: (world: World) => void | Promise<void>;
}

const issue = (w: World, title: string, extra: Record<string, unknown> = {}): string => {
  const created = w.a.store.createIssue({ title, ...extra } as never);
  w.ids[title] = created.id;
  return created.id;
};
const milestoneIdOf = (w: World, view: unknown): string =>
  w.a.store.getIssue((view as { milestone: { identifier: string } }).milestone.identifier).id;

const SCENARIOS: readonly Scenario[] = [
  // ---- vocabulary
  { method: "WorkspaceStore.addStatus", name: "add a status after another", run: (w) => void w.a.store.addStatus({ id: "qa", category: "review", label: "QA", after: "in_progress" }, "alice") },
  { method: "WorkspaceStore.renameStatus", name: "rename a status", run: (w) => void w.a.store.renameStatus("qa", "Quality", "alice") },
  { method: "WorkspaceStore.recategorizeStatus", name: "recategorize a status", run: (w) => void w.a.store.recategorizeStatus("qa", "active", "alice") },
  {
    method: "WorkspaceStore.reorderStatuses",
    name: "reorder the statuses",
    run: (w) => {
      const order = w.a.store.getStatuses().map((status) => status.id);
      w.a.store.reorderStatuses([...order.slice(1), order[0]!], "alice");
    },
  },
  {
    method: "WorkspaceStore.removeStatus",
    name: "remove a status an issue holds",
    prep: (w) => void w.a.store.updateIssue(issue(w, "In QA", { assignee: "alice" }), { status: "qa" }, "alice"),
    run: (w) => void w.a.store.removeStatus("qa", { migrateTo: "todo" }, "alice"),
  },
  { method: "WorkspaceStore.addKind", name: "add a kind", run: (w) => void w.a.store.addKind({ id: "research", label: "Research" }, "alice") },
  { method: "WorkspaceStore.renameKind", name: "rename a kind", run: (w) => void w.a.store.renameKind("research", "Study", "alice") },
  {
    method: "WorkspaceStore.reorderKinds",
    name: "reorder the kinds",
    run: (w) => {
      const order = w.a.store.getKinds().map((kind) => kind.id);
      w.a.store.reorderKinds([...order].reverse(), "alice");
    },
  },
  {
    method: "WorkspaceStore.removeKind",
    name: "remove a kind an issue holds",
    prep: (w) => void issue(w, "A study", { kind: "research" }),
    run: (w) => void w.a.store.removeKind("research", { migrateTo: "task" }, "alice"),
  },
  {
    method: "WorkspaceStore.applyStatusOps",
    name: "a status batch",
    run: (w) =>
      void w.a.store.applyStatusOps(
        [
          { op: "add", id: "triage", category: "unstarted", label: "Triage" },
          { op: "rename", id: "triage", label: "Triaging" },
        ],
        "alice",
      ),
  },
  {
    method: "WorkspaceStore.applyKindOps",
    name: "a kind batch",
    run: (w) => void w.a.store.applyKindOps([{ op: "add", id: "discovery" }, { op: "rename", id: "discovery", label: "Discovery!" }], "alice"),
  },
  { method: "WorkspaceStore.setSetting", name: "set a setting", run: (w) => void w.a.store.setSetting("queue.policy", "strict", "alice") },
  { method: "WorkspaceStore.resetSetting", name: "reset a setting", run: (w) => void w.a.store.resetSetting("queue.policy", "alice") },
  {
    method: "WorkspaceStore.applySettingOps",
    name: "a settings batch",
    run: (w) => void w.a.store.applySettingOps([{ op: "set", key: "queue.policy", value: "advisory" }], "alice"),
  },

  // ---- issues
  {
    method: "WorkspaceStore.createIssue",
    name: "create an issue with every field",
    prep: (w) => void w.a.store.projects().create({ name: "Web" }, "alice"),
    run: (w) =>
      void issue(w, "Everything", {
        description: "All of it",
        priority: "high",
        assignee: "bob",
        createdBy: "alice",
        labels: ["x", "y"],
        acceptanceCriteria: ["one", "two"],
        estimatedSeconds: 3600,
        originKind: "github",
        originId: "gh-1",
        idempotencyKey: "create-everything",
        project: "web",
        status: "blocked",
        unblockOwner: "carol",
        unblockAction: "review",
        blockedBy: [issue(w, "Its blocker")],
      }),
  },
  {
    method: "WorkspaceStore.createIssueResult",
    name: "create by retry key, then replay it",
    run: (w) => {
      w.ids["Retried"] = w.a.store.createIssueResult({ title: "Retried", idempotencyKey: "retry-1" }).issue.id;
      w.a.store.createIssueResult({ title: "Retried", idempotencyKey: "retry-1" });
    },
  },
  { method: "WorkspaceStore.createChild", name: "create a child", prep: (w) => void issue(w, "The epic", { kind: "epic" }), run: (w) => void (w.ids["The child"] = w.a.store.createChild(w.ids["The epic"]!, { title: "The child", assignee: "alice" }).id) },
  { method: "WorkspaceStore.setBlockedBy", name: "set blockers", run: (w) => void w.a.store.setBlockedBy(w.ids["Everything"]!, [w.ids["Retried"]!], "alice") },
  { method: "WorkspaceStore.updateIssue", name: "retitle", run: (w) => void w.a.store.updateIssue(w.ids["Everything"]!, { title: "Everything, renamed" }, "alice") },
  { method: "WorkspaceStore.updateIssue", name: "start work", run: (w) => void w.a.store.updateIssue(w.ids["The child"]!, { status: "in_progress" }, "alice") },
  { method: "WorkspaceStore.updateIssue", name: "finish work, moving the epic", run: (w) => void w.a.store.updateIssue(w.ids["The child"]!, { status: "done" }, "alice") },
  { method: "WorkspaceStore.updateIssue", name: "reopen", run: (w) => void w.a.store.updateIssue(w.ids["The child"]!, { status: "todo" }, "alice") },
  {
    method: "WorkspaceStore.updateIssue",
    name: "edit every other field, with a comment",
    run: (w) =>
      void w.a.store.updateIssue(
        w.ids["Everything"]!,
        {
          description: "Changed",
          priority: "low",
          assignee: null,
          labels: ["z"],
          acceptanceCriteria: ["three"],
          estimatedSeconds: 7200,
          kind: "bug",
          unblockOwner: null,
          unblockAction: null,
          comment: "Edited it all",
        },
        "alice",
      ),
  },
  {
    method: "WorkspaceStore.gateIssue",
    name: "gate an epic",
    prep: (w) => {
      const epic = issue(w, "Gated epic", { kind: "epic" });
      w.ids["Gated child one"] = w.a.store.createChild(epic, { title: "Gated child one" }).id;
      w.ids["Gated child two"] = w.a.store.createChild(epic, { title: "Gated child two" }).id;
    },
    run: (w) => void w.a.store.gateIssue(w.ids["Gated epic"]!, { owner: "VP", comment: "Hold" }, "alice"),
  },
  { method: "WorkspaceStore.approveGate", name: "approve one child of a gate", run: (w) => void w.a.store.approveGate(w.ids["Gated epic"]!, { children: [w.ids["Gated child one"]!] }, "VP") },
  { method: "WorkspaceStore.approveGate", name: "approve a gate", run: (w) => void w.a.store.approveGate(w.ids["Gated epic"]!, {}, "VP") },
  {
    method: "WorkspaceStore.requestChanges",
    name: "send a gate back",
    prep: (w) => { w.ids["Sent back child"] = w.a.store.createChild(issue(w, "Sent back", { kind: "epic" }), { title: "Sent back child" }).id; w.a.store.gateIssue(w.ids["Sent back"]!, { owner: "VP" }, "alice"); },
    run: (w) => void w.a.store.requestChanges(w.ids["Sent back"]!, { comment: "Not yet" }, "VP"),
  },
  { method: "WorkspaceStore.checkoutIssue", name: "check out", prep: (w) => void issue(w, "Claimed"), run: (w) => void w.a.store.checkoutIssue(w.ids["Claimed"]!, "agent-a") },
  { method: "WorkspaceStore.releaseIssue", name: "release", run: (w) => void w.a.store.releaseIssue(w.ids["Claimed"]!, "agent-a") },
  {
    method: "WorkspaceStore.releaseIssue",
    name: "release an idle claim",
    prep: (w) => void w.a.store.checkoutIssue(issue(w, "Idle claim"), "agent-a"),
    run: (w) => void w.a.store.releaseIssue(w.ids["Idle claim"]!, "agent-b", { ifIdleSeconds: 0 }),
  },
  { method: "WorkspaceStore.addComment", name: "comment", run: (w) => void w.a.store.addComment(w.ids["Everything"]!, "A comment", "alice") },
  {
    method: "WorkspaceStore.addCommentResult",
    name: "comment by retry key, twice",
    run: (w) => {
      w.a.store.addCommentResult(w.ids["Everything"]!, "Once", "alice", "user", { idempotencyKey: "comment-1" } as never);
      w.a.store.addCommentResult(w.ids["Everything"]!, "Once", "alice", "user", { idempotencyKey: "comment-1" } as never);
    },
  },
  { method: "WorkspaceStore.putDocument", name: "write a document", run: (w) => void w.a.store.putDocument(w.ids["Everything"]!, "spec", "v1", { author: "alice", title: "Spec" }) },
  { method: "WorkspaceStore.putDocument", name: "revise a document", run: (w) => void w.a.store.putDocument(w.ids["Everything"]!, "spec", "v2", { author: "bob", changeSummary: "second" }) },
  {
    method: "WorkspaceStore.putDocument",
    name: "write the same revision on two devices at once",
    run: (w) => {
      w.b.use();
      w.b.store.putDocument(w.ids["Everything"]!, "concurrent", "B's text", { author: "bob" });
      w.a.use();
      w.a.store.putDocument(w.ids["Everything"]!, "concurrent", "A's text", { author: "alice" });
    },
  },
  { method: "WorkspaceStore.restoreDocumentRevision", name: "restore a revision", run: (w) => void w.a.store.restoreDocumentRevision(w.ids["Everything"]!, "spec", 1, "carol") },

  // ---- milestones
  {
    method: "MilestoneStore.create",
    name: "create a milestone",
    prep: (w) => void w.a.store.addKind({ id: "milestone", label: "Milestone" }, "alice"),
    run: (w) => void (w.ids["M1"] = milestoneIdOf(w, w.a.store.milestones().create({ title: "M1", targetDate: "2026-11-01" }, "alice"))),
  },
  {
    method: "MilestoneStore.create",
    name: "create a milestone from an epic",
    prep: (w) => {
      const epic = issue(w, "Shipped epic", { kind: "epic" });
      w.a.store.createChild(epic, { title: "Shipped child" });
    },
    run: (w) => void (w.ids["M2"] = milestoneIdOf(w, w.a.store.milestones().create({ title: "M2", fromEpic: w.ids["Shipped epic"]! }, "alice"))),
  },
  { method: "MilestoneStore.update", name: "move a milestone's dates", run: (w) => void w.a.store.milestones().update(w.ids["M1"]!, { targetDate: "2026-12-01", startDate: "2026-10-01" }, "alice") },
  {
    method: "MilestoneStore.addMember",
    name: "add milestone members",
    prep: (w) => {
      issue(w, "Member one");
      issue(w, "Member two");
    },
    run: (w) => {
      w.a.store.milestones().addMember(w.ids["M1"]!, w.ids["Member one"]!, { note: "first" }, "alice");
      w.a.store.milestones().addMember(w.ids["M1"]!, w.ids["Member two"]!, {}, "alice");
    },
  },
  { method: "MilestoneStore.moveMember", name: "move a member", run: (w) => void w.a.store.milestones().moveMember(w.ids["Member two"]!, { at: 1 }, "alice") },
  { method: "MilestoneStore.reorderMembers", name: "reorder members", run: (w) => void w.a.store.milestones().reorderMembers(w.ids["M1"]!, [w.ids["Member one"]!, w.ids["Member two"]!], {}, "alice") },
  { method: "MilestoneStore.removeMember", name: "remove a member", run: (w) => void w.a.store.milestones().removeMember(w.ids["M1"]!, w.ids["Member one"]!, {}, "alice") },

  // ---- the plan
  {
    method: "QueueStore.enqueue",
    name: "queue work",
    prep: (w) => {
      issue(w, "Queued one");
      issue(w, "Queued two");
    },
    run: (w) => {
      w.a.store.queue().enqueue(w.ids["Queued one"]!, { note: "first" }, "alice");
      w.a.store.queue().enqueue(w.ids["Queued two"]!, {}, "alice");
    },
  },
  { method: "QueueStore.move", name: "move queued work", run: (w) => void w.a.store.queue().move(w.ids["Queued two"]!, { at: 1 }, "alice") },
  { method: "QueueStore.reorder", name: "reorder the plan", run: (w) => void w.a.store.queue().reorder([w.ids["Queued one"]!, w.ids["Queued two"]!], {}, "alice") },
  { method: "QueueStore.dequeue", name: "take work off the plan", run: (w) => void w.a.store.queue().dequeue(w.ids["Queued one"]!, {}, "alice") },
  {
    method: "QueueStore.prune",
    name: "prune finished work",
    prep: (w) => void w.a.store.updateIssue(w.ids["Queued two"]!, { status: "done" }, "alice"),
    run: (w) => void w.a.store.queue().prune({}, "alice"),
  },
  { method: "QueueStore.mutate", name: "a queue verb", prep: (w) => void issue(w, "Queued by verb"), run: (w) => void w.a.store.queue().mutate("add", { ref: w.ids["Queued by verb"]!, note: "verb" }, "alice") },

  // ---- projects
  { method: "ProjectStore.create", name: "create a project", run: (w) => void (w.ids["Docs"] = w.a.store.projects().create({ name: "Docs" }, "alice").id) },
  { method: "ProjectStore.update", name: "rename a project", run: (w) => void w.a.store.projects().update(w.ids["Docs"]!, { name: "Documentation" }, "alice") },
  { method: "ProjectStore.assign", name: "file an issue under a project", prep: (w) => void issue(w, "Filed"), run: (w) => void w.a.store.projects().assign(w.ids["Filed"]!, w.ids["Docs"]!, "alice") },
  { method: "ProjectStore.assign", name: "take an issue out of a project", run: (w) => void w.a.store.projects().assign(w.ids["Filed"]!, null, "alice") },
  {
    method: "ProjectStore.remove",
    name: "remove a project issues are filed under",
    prep: (w) => void w.a.store.projects().assign(w.ids["Filed"]!, w.ids["Docs"]!, "alice"),
    run: (w) => void w.a.store.projects().remove(w.ids["Docs"]!, "alice"),
  },

  // ---- a claim through the service's lease, which checks out and releases through the store
  {
    method: "lease.acquireClaim",
    name: "claim under a lease",
    prep: (w) => void issue(w, "Leased"),
    run: async (w) => {
      // The service's clock is not this device's: the lease is granted a minute "earlier".
      const clock = w.fleet.server.now;
      w.fleet.server.now = () => Date.now() - 60_000;
      try {
        await acquireClaim(w.a.store, REPO, w.ids["Leased"]!, "agent-a", { home: w.a.home, fetchImpl: w.fleet.server.fetch });
      } finally {
        w.fleet.server.now = clock;
      }
    },
  },
  {
    method: "lease.releaseClaim",
    name: "release a leased claim",
    run: async (w) => void (await releaseClaim(w.a.store, REPO, w.ids["Leased"]!, { home: w.a.home, fetchImpl: w.fleet.server.fetch })),
  },
];

// ------------------------------------------------------------ synchronized state

/** Every synchronized column of every synchronized table, by natural key (`docs/sync.md`). */
const TABLES: Record<string, { readonly key: readonly string[]; readonly sql: string; readonly ordered?: boolean }> = {
  issues: {
    key: ["id"],
    sql: `SELECT id, identifier, title, normalized_title, description, status, status_version, priority, parent_id, depth,
                 assignee, created_by, labels, acceptance_criteria, block_parent_until_done, unblock_owner, unblock_action,
                 origin_kind, origin_id, idempotency_key, estimated_seconds, kind, project_id, gate_state, gate_owner,
                 gate_requested_by, gate_requested_at, gate_resolved_by, gate_resolved_at, gate_released, started_at,
                 blocked_transition_at, completed_at, cancelled_at, checkout_agent, checkout_at, created_at, updated_at
            FROM issues ORDER BY id`,
  },
  comments: {
    key: ["id"],
    sql: "SELECT id, issue_id, author, author_type, body, idempotency_key, deleted_at, created_at FROM comments ORDER BY id",
  },
  documents: { key: ["issue_id", "key"], sql: "SELECT issue_id, key, current_revision, title, updated_at FROM documents ORDER BY issue_id, key" },
  document_revisions: {
    key: ["issue_id", "key", "revision"],
    sql: "SELECT issue_id, key, revision, body, author, change_summary, created_at FROM document_revisions ORDER BY issue_id, key, revision",
  },
  relations: {
    key: ["blocker_id", "blocked_id", "type"],
    sql: "SELECT blocker_id, blocked_id, type, created_by, created_at FROM relations ORDER BY blocker_id, blocked_id, type",
  },
  projects: {
    key: ["id"],
    sql: `SELECT id, slug, name, kind, source_kind, CASE WHEN source_kind = 'local' THEN NULL ELSE source END AS source,
                 created_at, updated_at FROM projects ORDER BY id`,
  },
  workspace_statuses: { key: ["id"], ordered: true, sql: "SELECT id, label, category, is_builtin FROM workspace_statuses ORDER BY sort_order, id" },
  workspace_kinds: { key: ["id"], ordered: true, sql: "SELECT id, label, is_builtin FROM workspace_kinds ORDER BY sort_order, id" },
  milestone_meta: { key: ["issue_id"], sql: "SELECT issue_id, target_date, start_date, updated_at FROM milestone_meta ORDER BY issue_id" },
  settings: { key: ["key"], sql: "SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key" },
  queue_entries: { key: ["issue_id"], ordered: true, sql: "SELECT issue_id, added_by, added_at, note FROM queue_entries ORDER BY rank" },
  milestone_members: {
    key: ["issue_id"],
    ordered: true,
    sql: "SELECT milestone_id, issue_id, added_by, added_at, note FROM milestone_members ORDER BY milestone_id, rank",
  },
};

type State = Record<string, Map<string, Record<string, unknown>>>;

function stateOf(db: DatabaseSync): State {
  const state: State = {};
  for (const [table, spec] of Object.entries(TABLES)) {
    const rows = db.prepare(spec.sql).all() as Array<Record<string, unknown>>;
    state[table] = new Map(
      rows.map((row, position) => [spec.key.map((column) => String(row[column])).join("/"), spec.ordered ? { ...row, position } : { ...row }]),
    );
  }
  return state;
}

/** Every difference between two devices' synchronized state, one line each. */
function differences(label: string, expected: State, actual: State): string[] {
  const out: string[] = [];
  for (const table of Object.keys(TABLES)) {
    const want = expected[table]!;
    const got = actual[table]!;
    for (const [key, row] of want) {
      const other = got.get(key);
      if (!other) {
        out.push(`${label}: ${table}[${key}] missing`);
        continue;
      }
      for (const column of Object.keys(row)) {
        if (JSON.stringify(row[column]) !== JSON.stringify(other[column])) {
          out.push(`${label}: ${table}[${key}].${column} writer=${JSON.stringify(row[column])} here=${JSON.stringify(other[column])}`);
        }
      }
    }
    for (const key of got.keys()) if (!want.has(key)) out.push(`${label}: ${table}[${key}] not on the writer`);
  }
  return out;
}

// -------------------------------------------------------------------- the tests

describe("the mutation registry", () => {
  it("names every public mutation of every store, and nothing that is not one", () => {
    const problems: string[] = [];
    for (const store of Object.keys(SOURCES) as StoreName[]) {
      const declared = publicMethods(store);
      const reads = new Set(READS[store]);
      const mutations = new Set(SCENARIOS.filter((s) => s.method.startsWith(`${store}.`)).map((s) => s.method.slice(store.length + 1)));
      for (const name of declared) {
        if (!reads.has(name) && !mutations.has(name)) problems.push(`${store}.${name} is neither a listed read nor a mutation with a scenario`);
      }
      for (const name of [...reads, ...mutations]) {
        if (!declared.includes(name)) problems.push(`${store}.${name} is listed but not declared`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("every public mutation", () => {
  it("leaves every synchronized column the same on the writer, a tail device and a fresh device", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const world: World = { a, b, fleet, ids: {} };
    const failures: string[] = [];
    // A difference is reported against the scenario that made it, once.
    const seen = new Set<string>();
    const fresh = (lines: string[]): string[] =>
      lines.filter((line) => {
        const where = line.replace(/^.*\) (tail|fresh): /, "$1 ").replace(/ writer=.*$/, "");
        if (seen.has(where)) return false;
        seen.add(where);
        return true;
      });

    for (const [index, scenario] of SCENARIOS.entries()) {
      const label = `${scenario.method} (${scenario.name})`;
      try {
        if (scenario.prep) {
          a.use();
          scenario.prep(world);
          await a.sync();
          await b.sync();
        }
        await tick();
        a.use();
        await scenario.run(world);
        await a.sync();
        await b.sync();
        await a.sync();
        const hydrated = fleet.machine(`fresh-${index}`);
        await hydrated.sync();
        const writer = stateOf(a.db);
        failures.push(...fresh(differences(`${label} tail`, writer, stateOf(b.db))));
        failures.push(...fresh(differences(`${label} fresh`, writer, stateOf(hydrated.db))));
      } catch (error) {
        failures.push(`${label} threw: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe("an older build's milestone write, which says nothing of when", () => {
  it("is dated by its own time in the log, on a tail device and on a fresh one alike", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.addKind({ id: "milestone", label: "Milestone" }, "alice");
    const view = a.store.milestones().create({ title: "M", targetDate: "2026-11-01" }, "alice") as { milestone: { identifier: string } };
    const milestone = a.store.getIssue(view.milestone.identifier).id;
    await a.sync();
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const version = (a.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = 'milestone' AND entity_id = ?").get(milestone) as { version: number }).version;
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      { entity: "milestone", entityId: milestone, verb: "update", baseVersion: version, payload: { targetDate: "2027-01-01" }, createdAt: "2026-09-01T00:00:00.000Z" },
    ]);
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const meta = (db: DatabaseSync): unknown => db.prepare("SELECT target_date, updated_at FROM milestone_meta WHERE issue_id = ?").get(milestone);
    expect(meta(a.db)).toEqual({ target_date: "2027-01-01", updated_at: "2026-09-01T00:00:00.000Z" });
    expect(meta(fresh.db)).toEqual(meta(a.db));
  });
});

// ------------------------------------------------------------ conflict resolutions

interface ConflictKind {
  readonly name: string;
  readonly entity: string;
  readonly field: string;
  readonly setup: (a: Machine) => Record<string, string>;
  readonly edit: (machine: Machine, ids: Record<string, string>, which: "a" | "b") => void;
}

const CONFLICTS: readonly ConflictKind[] = [
  {
    name: "issue title",
    entity: "issue",
    field: "title",
    setup: (a) => ({ issue: a.store.createIssue({ title: "Before" }).id }),
    edit: (m, x, which) => void m.store.updateIssue(x.issue!, { title: `Title from ${which}` }, which),
  },
  {
    name: "issue status",
    entity: "issue",
    field: "status",
    setup: (a) => ({ issue: a.store.createIssue({ title: "Moved", assignee: "alice" }).id }),
    edit: (m, x, which) => void m.store.updateIssue(x.issue!, { status: which === "a" ? "in_progress" : "done" }, which),
  },
  {
    name: "the plan",
    entity: "queue",
    field: "order",
    setup: (a) => {
      const one = a.store.createIssue({ title: "One" }).id;
      a.store.queue().enqueue(one, { note: "first" }, "alice");
      return { one };
    },
    edit: (m, _x, which) => void m.store.queue().enqueue(m.store.createIssue({ title: `Queued on ${which}` }).id, { note: which }, which),
  },
  {
    name: "milestone members",
    entity: "milestone",
    field: "members",
    setup: (a) => {
      a.store.addKind({ id: "milestone", label: "Milestone" });
      const milestone = a.store.getIssue(
        (a.store.milestones().create({ title: "M1" }, "alice") as { milestone: { identifier: string } }).milestone.identifier,
      ).id;
      return { milestone };
    },
    edit: (m, x, which) => void m.store.milestones().addMember(x.milestone!, m.store.createIssue({ title: `Member from ${which}` }).id, {}, which),
  },
  {
    name: "milestone target date",
    entity: "milestone",
    field: "target_date",
    setup: (a) => {
      a.store.addKind({ id: "milestone", label: "Milestone" });
      const view = a.store.milestones().create({ title: "M2", targetDate: "2026-11-01" }, "alice") as { milestone: { identifier: string } };
      return { milestone: a.store.getIssue(view.milestone.identifier).id };
    },
    edit: (m, x, which) => void m.store.milestones().update(x.milestone!, { targetDate: which === "a" ? "2026-10-01" : "2026-12-01" }, which),
  },
  {
    name: "status label",
    entity: "status",
    field: "label",
    setup: (a) => (a.store.addStatus({ id: "qa", category: "review", label: "QA" }), {}),
    edit: (m, _x, which) => void m.store.renameStatus("qa", `QA by ${which}`),
  },
  {
    name: "kind label",
    entity: "kind",
    field: "label",
    setup: (a) => (a.store.addKind({ id: "research" }), {}),
    edit: (m, _x, which) => void m.store.renameKind("research", `Research by ${which}`),
  },
  {
    name: "setting",
    entity: "setting",
    field: "value",
    setup: () => ({}),
    edit: (m, _x, which) => void m.store.setSetting("queue.policy", which === "a" ? "strict" : "advisory"),
  },
  {
    name: "project name",
    entity: "project",
    field: "name",
    setup: (a) => ({ project: a.store.projects().create({ name: "Web" }, "alice").id }),
    edit: (m, x, which) => void m.store.projects().update(x.project!, { name: `Web by ${which}` }, which),
  },
];

describe("every conflict resolution", () => {
  for (const kind of CONFLICTS) {
    for (const choice of ["local", "remote"] as const satisfies readonly ResolutionChoice[]) {
      it(`leaves every synchronized column the same everywhere: ${kind.name}, resolved ${choice}`, async () => {
        fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
        const a = fleet.machine("a");
        a.use();
        const x = kind.setup(a);
        await a.sync();
        const b = fleet.machine("b");
        await b.sync();

        await tick();
        a.use();
        kind.edit(a, x, "a");
        await tick();
        b.use();
        kind.edit(b, x, "b");
        await a.sync();
        await b.sync();
        await a.sync();
        const open = listConflicts(a.db).filter((c) => c.resolvedAt === null && c.entity === kind.entity && c.field === kind.field);
        expect(open.length, kind.name).toBeGreaterThan(0);

        await tick();
        a.use();
        for (const conflict of open) resolveConflict(a.db, { id: conflict.id, choice, actor: "alice" });
        await a.sync();
        await b.sync();
        await a.sync();
        const fresh = fleet.machine("fresh");
        await fresh.sync();
        const writer = stateOf(a.db);
        expect([...differences("tail", writer, stateOf(b.db)), ...differences("fresh", writer, stateOf(fresh.db))]).toEqual([]);
      });
    }
  }
});
