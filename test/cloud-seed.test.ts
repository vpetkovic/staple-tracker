/**
 * A workspace's history reaches the service when it first synchronizes (STA-293).
 *
 * Contract: `docs/sync.md`, "A workspace's history reaches the service when it first
 * synchronizes".
 *
 * Every repository that existed before it connected was written while the journal was
 * disarmed, so it has no outbox rows and no version rows. Before the seed, connecting
 * such a workspace and syncing reported *"Pushed nothing"*, a second device hydrated an
 * empty repository, and the first later edit to a pre-connect issue reached that device
 * as an operation on an entity it never received — deferred for ever.
 *
 * So the pre-connect state here is made the way a real one is: by the CLI, in a staple
 * home that has never connected anything, so the journal is disarmed and nothing is
 * journaled. A fixture that already had outbox rows would test a workspace nobody has.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bindJournal, deriveOpId } from "../src/core/journal.js";
import { openWorkspace } from "../src/core/open.js";
import { forkRepositoryId } from "../src/core/repo-identity.js";
import { initWorkspace } from "../src/core/workspace.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { hydrate } from "../src/core/cloud/hydrate.js";
import { ReferentMissing, applyToDatabase } from "../src/core/cloud/apply.js";
import { describeSeed, readSeedMarker, workspaceHoldings } from "../src/core/cloud/seed.js";
import { syncRepository, type SyncOptions, type SyncReport } from "../src/core/cloud/sync.js";
import { readSyncState } from "../src/core/cloud/sync-state.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const ENDPOINT = "https://sync.test.example";

let hubHome: string;
let template: string;
let repositoryId: string;
let prefix: string;
const cleanup: string[] = [];
const open: DatabaseSync[] = [];

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-seed-${label}-`));
  cleanup.push(dir);
  return dir;
}

/** The real CLI, in a home that has never connected: the journal is disarmed. */
function staple(cwd: string, home: string, args: string[], input?: string): string {
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd,
    env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "seed-test", STAPLE_DEVICE_ID: "", NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(`staple ${args.join(" ")} exited ${result.status}:\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

function dbPathOf(dir: string): string {
  return join(dir, ".staple", "staple.db");
}

/** A byte copy of the template workspace, taken with VACUUM INTO rather than a file copy. */
function copyOfTemplate(): string {
  const dir = tmp("ws");
  mkdirSync(join(dir, ".staple"), { recursive: true });
  writeFileSync(join(dir, ".staple", "repository.json"), readFileSync(join(template, ".staple", "repository.json")));
  const source = new DatabaseSync(dbPathOf(template));
  source.exec(`VACUUM INTO '${dbPathOf(dir).replace(/'/g, "''")}'`);
  source.close();
  return dir;
}

/**
 * A machine: a staple home of its own. Every device is a different machine, with its
 * own hub, credential and device id — two devices sharing a home would be one device.
 */
function machine(label: string): string {
  const home = tmp(`home-${label}`);
  process.env.STAPLE_HOME = home;
  return home;
}

/** A fresh clone on `home`'s machine: the tracked manifest and nothing else, then `staple init`. */
function freshClone(home: string): string {
  const dir = tmp("clone");
  mkdirSync(join(dir, ".staple"), { recursive: true });
  writeFileSync(join(dir, ".staple", "repository.json"), readFileSync(join(template, ".staple", "repository.json")));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir, slug: "seedtest" });
  ws.store.db.close();
  return dir;
}

interface Device {
  store: WorkspaceStore;
  db: DatabaseSync;
  deviceId: string;
  sync: (extra?: Partial<SyncOptions>) => Promise<SyncReport>;
}

/** Connect a workspace directory on `home`'s machine. */
function connect(server: FakeSyncServer, dir: string, deviceId: string, home: string): Device {
  process.env.STAPLE_HOME = home;
  const opened = openWorkspace(dbPathOf(dir));
  open.push(opened.store.db);
  bindJournal(opened.store.db, deviceId);
  const token = `token-${deviceId}`;
  credentialStoreFor(home, "file").write(repositoryId, token);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-10T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, token);
  return {
    store: opened.store,
    db: opened.store.db,
    deviceId,
    sync: (extra = {}) =>
      syncRepository(opened.store.db, repositoryId, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
        ...extra,
      }),
  };
}

/** A machine holding a copy of the CLI-made, never-connected workspace. */
function onTemplate(server: FakeSyncServer, deviceId: string): Device {
  const home = machine(deviceId);
  return connect(server, copyOfTemplate(), deviceId, home);
}

/** A machine holding a fresh clone of the repository. */
function onClone(server: FakeSyncServer, deviceId: string): Device {
  const home = machine(deviceId);
  return connect(server, freshClone(home), deviceId, home);
}

function id(db: DatabaseSync, identifier: string): string {
  return (db.prepare("SELECT id FROM issues WHERE identifier = ?").get(identifier) as { id: string }).id;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/**
 * Everything two converged devices must agree about, keyed by the sync identity and
 * never by the display allocation.
 */
function shape(db: DatabaseSync): unknown {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    issues: all(
      `SELECT id, identifier, title, description, status, priority, parent_id, depth, kind, labels,
              acceptance_criteria, assignee, created_by, origin_kind, created_at, started_at
         FROM issues ORDER BY id`,
    ),
    comments: all("SELECT id, issue_id, author, author_type, body, created_at FROM comments ORDER BY id"),
    relations: all("SELECT blocker_id, blocked_id, type FROM relations ORDER BY blocker_id, blocked_id"),
    documents: all("SELECT issue_id, key, current_revision, title FROM documents ORDER BY issue_id, key"),
    revisions: all(
      `SELECT issue_id, key, revision, body, author, change_summary, created_at
         FROM document_revisions ORDER BY issue_id, key, revision`,
    ),
    queue: all("SELECT issue_id FROM queue_entries ORDER BY rank"),
    members: all("SELECT milestone_id, issue_id FROM milestone_members ORDER BY milestone_id, rank"),
    milestones: all("SELECT issue_id, target_date, start_date FROM milestone_meta ORDER BY issue_id"),
    statuses: all("SELECT id, label, category FROM workspace_statuses ORDER BY sort_order, id"),
    kinds: all("SELECT id, label FROM workspace_kinds ORDER BY sort_order, id"),
    settings: all("SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key"),
  };
}

beforeAll(() => {
  hubHome = mkdtempSync(join(tmpdir(), "staple-seed-hub-"));
  process.env.STAPLE_HOME = hubHome;
  delete process.env.STAPLE_DEVICE_ID;

  template = mkdtempSync(join(tmpdir(), "staple-seed-template-"));
  const cliHome = mkdtempSync(join(tmpdir(), "staple-seed-cli-home-"));
  cleanup.push(cliHome);
  staple(template, cliHome, ["init", "--yes", "--slug", "seedtest"]);
  const db = new DatabaseSync(dbPathOf(template));
  prefix = (db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string }).value;
  db.close();
  const ref = (n: number) => `${prefix}-${n}`;

  staple(template, cliHome, ["kinds", "add", "milestone"]);
  staple(template, cliHome, ["statuses", "add", "qa", "--category", "review", "--after", "in_progress"]);
  staple(template, cliHome, ["new", "Parent epic", "--kind", "epic", "-d", "the epic, before connect"]);
  staple(template, cliHome, ["new", "Child task", "--parent", ref(1), "-p", "high"]);
  staple(template, cliHome, ["new", "The blocker"]);
  staple(template, cliHome, ["new", "The blocked one", "--blocked-by", ref(3)]);
  staple(template, cliHome, ["comment", ref(2), "a comment written before connect"]);
  staple(template, cliHome, ["comment", ref(4), "and another"]);
  staple(template, cliHome, ["doc", ref(2), "plan", "--put", "-"], "first draft\n");
  staple(template, cliHome, ["doc", ref(2), "plan", "--put", "-"], "second draft\n");
  staple(template, cliHome, ["queue", "add", ref(2)]);
  staple(template, cliHome, ["queue", "add", ref(4)]);
  staple(template, cliHome, ["milestone", "new", "First milestone", "--target", "2026-12-01"]);
  staple(template, cliHome, ["milestone", "add", ref(5), ref(4)]);
  staple(template, cliHome, ["settings", "set", "queue.policy", "strict"]);

  repositoryId = (
    JSON.parse(readFileSync(join(template, ".staple", "repository.json"), "utf8")) as { repositoryId: string }
  ).repositoryId;
}, 120_000);

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

afterAll(() => {
  for (const dir of [...cleanup, template, hubHome]) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- first device

describe("the first device uploads everything it held before connecting", () => {
  it("uploads the pre-connect state, and a fresh second device hydrates all of it", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");

    // The premise: however much it holds, a workspace made before connecting has
    // journaled nothing at all.
    expect(count(a.db, "SELECT COUNT(*) AS n FROM issues")).toBe(5);
    expect(count(a.db, "SELECT COUNT(*) AS n FROM sync_outbox")).toBe(0);
    expect(count(a.db, "SELECT COUNT(*) AS n FROM sync_entity_versions")).toBe(0);
    // And what `staple cloud connect` says the first sync will upload, before it does.
    expect(workspaceHoldings(a.db)).toEqual({
      total: 12,
      summary: "5 issues, 2 comments, 2 document revisions, 1 blocker set, 1 milestone, 1 plan",
    });

    const first = await a.sync();
    expect(first.seed, "the first sync owed a seed").not.toBeNull();
    expect(first.seed!.mode).toBe("join");
    expect(first.seed!.repositoryEntities).toBe(0);
    expect(first.seed!.uploadedByEntity).toMatchObject({
      issue: 5,
      comment: 2,
      documentRevision: 2,
      relation: 1,
      milestone: 1,
      queue: 1,
      status: 1,
      kind: 1,
      setting: 1,
    });
    expect(first.pushed.applied, "everything the seed journaled was accepted").toBe(first.seed!.uploaded + 1);
    expect(first.pending).toBe(0);

    const b = onClone(server, "device-b");
    const joined = await b.sync();
    expect(joined.seed!.repositoryEntities).toBeGreaterThan(0);
    expect(joined.seed!.uploaded, "a fresh clone has nothing of its own to add").toBe(0);

    // What each device is told, in the words `staple cloud sync` prints.
    expect(describeSeed(first.seed!).summary).toBe(
      "Uploaded 15 existing items (5 issues, 2 comments, 2 document revisions, 1 blocker set, " +
        "1 status, 1 kind, 1 setting, 1 milestone, 1 plan). The repository was empty, so this " +
        "workspace's history is now the repository's.",
    );
    expect(describeSeed(joined.seed!).summary).toBe(
      `This repository already had data (${joined.seed!.repositoryEntities} items); bootstrapped from ` +
        "it, and this workspace had no items of its own to add.",
    );

    expect(shape(b.db)).toEqual(shape(a.db));
  });

  it("carries the status order a custom status was inserted into", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();
    const b = onClone(server, "device-b");
    await b.sync();
    const order = (db: DatabaseSync) =>
      (db.prepare("SELECT id FROM workspace_statuses ORDER BY sort_order").all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
    expect(order(a.db).indexOf("qa")).toBe(order(a.db).indexOf("in_progress") + 1);
    expect(order(b.db)).toEqual(order(a.db));
  });
});

// ------------------------------------------------------------- the old defect

describe("an edit to a pre-connect issue reaches a device that joined after the seed", () => {
  it("is applied, rather than deferred for ever as an operation on an unknown entity", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();
    const b = onClone(server, "device-b");
    await b.sync();

    a.store.updateIssue(`${prefix}-2`, { title: "Edited after connecting" }, "device-a-agent");
    a.store.addComment(`${prefix}-4`, "a comment after connecting", "device-a-agent", "agent");
    a.store.putDocument(`${prefix}-2`, "plan", "third draft, after connecting", { author: "device-a-agent" });
    const pushed = await a.sync();
    expect(pushed.pushed.applied).toBeGreaterThan(0);

    const pulled = await b.sync();
    expect(pulled.pulled.operations).toBeGreaterThan(0);
    expect(
      (b.db.prepare("SELECT title FROM issues WHERE identifier = ?").get(`${prefix}-2`) as { title: string }).title,
    ).toBe("Edited after connecting");
    expect(shape(b.db)).toEqual(shape(a.db));

    // And a device that arrives later hydrates the pre-connect history and the
    // post-connect edits alike from the snapshot, with the times and authors they
    // were written with rather than the moment it hydrated.
    const d = onClone(server, "device-d");
    await d.sync();
    expect(shape(d.db)).toEqual(shape(a.db));
  });

  it("reaches a device that joined BEFORE the seed, through the ordered tail, one operation per page", async () => {
    const server = new FakeSyncServer({ repositoryId, maxBatchSize: 4 });
    // C joins an empty repository first, so the whole seed reaches it as the tail.
    const c = onClone(server, "device-c");
    await c.sync();
    const a = onTemplate(server, "device-a");
    await a.sync();

    /**
     * One operation per page is the hardest case for order: the pull loop defers a
     * missing referent only to the end of its own page, so any operation that reached
     * the log ahead of what it names fails its page for ever. It completes only if the
     * seed went up dependencies first.
     */
    const report = await c.sync({ pullLimit: 1 });
    expect(report.pulled.operations).toBeGreaterThan(0);
    expect(shape(c.db)).toEqual(shape(a.db));
  });
});

// ----------------------------------------------------------------- exactly once

describe("the seed happens exactly once per repository per database", () => {
  it("does not seed again on the next sync", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();
    const logged = server.ops.length;

    const again = await a.sync();
    expect(again.seed).toBeNull();
    expect(again.pushed.attempted).toBe(0);
    expect(server.ops.length).toBe(logged);
    expect(readSeedMarker(a.db)!.repositoryId).toBe(repositoryId);
  });

  it("sends a seed whose push was cut off, exactly once, on the next sync", async () => {
    const server = new FakeSyncServer({ repositoryId, maxBatchSize: 5 });
    const a = onTemplate(server, "device-a");

    // The first batch lands and its acknowledgement is lost; the process dies there.
    let posts = 0;
    const dying: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if ((init?.method ?? "GET") === "POST") {
        posts += 1;
        throw new Error("the process died after the first batch reached the service");
      }
      return response;
    };
    await expect(a.sync({ fetchImpl: dying, attempts: 1 })).rejects.toThrow();
    expect(posts).toBe(1);
    expect(readSeedMarker(a.db), "the seed committed before anything was sent").not.toBeNull();

    const resumed = await a.sync();
    expect(resumed.seed, "and is not taken twice").toBeNull();
    expect(resumed.pushed.duplicate, "the batch that already landed was absorbed").toBe(5);
    expect(resumed.pending).toBe(0);

    const keys = server.ops.map((op) => `${op.entity} ${op.entityId}`);
    expect(new Set(keys).size, "no entity was created twice").toBe(keys.length);
  });
});

// ------------------------------------------------------------- the op model

describe("seeded operations are ordinary operations", () => {
  it("allocate client sequences monotonically and derive epoch-scoped ids, with versions the service agrees with", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();

    const rows = a.db
      .prepare("SELECT op_id, client_seq, entity, entity_id, verb, base_version FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{ op_id: string; client_seq: number; entity: string; entity_id: string; verb: string; base_version: number | null }>;
    const state = readSyncState(a.db)!;
    rows.forEach((row, index) => {
      expect(row.client_seq).toBe(index + 1);
      expect(row.op_id).toBe(deriveOpId(repositoryId, state.epoch, "device-a", row.client_seq));
    });
    expect(state.clientSeqHighWater).toBe(rows.length);

    // A create is its entity's first operation on the service, so its version is 1
    // here, and it leaves no provenance: a create was never one of "the operations in
    // between".
    for (const row of rows.filter((candidate) => candidate.verb === "create")) {
      expect(row.base_version).toBeNull();
      const version = a.db
        .prepare("SELECT version FROM sync_entity_versions WHERE entity = ? AND entity_id = ?")
        .get(row.entity, row.entity_id) as { version: number };
      expect(version.version).toBe(1);
    }
    expect(count(a.db, "SELECT COUNT(*) AS n FROM sync_field_writes")).toBe(0);
  });

  it("sizes its batches from what the service advertises", async () => {
    const server = new FakeSyncServer({ repositoryId, maxBatchSize: 3 });
    const a = onTemplate(server, "device-a");
    const report = await a.sync();
    const posts = server.calls.filter((call) => call === "POST /v1/repos/:id/ops").length;
    expect(report.pushed.attempted).toBeGreaterThan(15);
    expect(posts).toBe(Math.ceil(report.pushed.attempted / 3));
  });

  it("goes up dependencies first: nothing in the log names an entity that has not been created before it", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();

    expect(server.ops.length).toBeGreaterThan(15);
    const created = new Set<string>();
    for (const op of [...server.ops].sort((x, y) => x.seq - y.seq)) {
      const p = op.payload as Record<string, unknown>;
      const named: string[] = [];
      if (op.entity === "comment" || op.entity === "documentRevision") named.push(p.issueId as string);
      if (op.entity === "issue" && typeof p.parentId === "string") named.push(p.parentId);
      if (op.entity === "relation") named.push(op.entityId, ...(p.blockedBy as string[]));
      if (op.entity === "queue") named.push(...(p.order as string[]));
      if (op.entity === "milestone") named.push(op.entityId, ...(p.members as string[]));
      for (const referent of named) expect(created.has(referent), `${op.entity} ${op.entityId} names ${referent}`).toBe(true);
      if (op.verb === "create") created.add(op.entityId);
    }
  });

  it("keeps conflict detection field-scoped afterwards: disjoint edits converge, a shared field is contested on both sides", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();
    const b = onClone(server, "device-b");
    await b.sync();

    const ref = `${prefix}-3`;
    a.store.updateIssue(ref, { priority: "critical" }, "a");
    b.store.updateIssue(ref, { estimatedSeconds: 3600 }, "b");
    await a.sync();
    await b.sync();
    await a.sync();
    expect(listConflicts(a.db)).toHaveLength(0);
    expect(listConflicts(b.db)).toHaveLength(0);
    expect(shape(b.db)).toEqual(shape(a.db));

    a.store.updateIssue(ref, { title: "A's title" }, "a");
    b.store.updateIssue(ref, { title: "B's title" }, "b");
    await a.sync();
    await b.sync();
    await a.sync();
    expect(listConflicts(a.db).filter((c) => c.field === "title")).toHaveLength(1);
    expect(listConflicts(b.db).filter((c) => c.field === "title")).toHaveLength(1);
  });
});

// -------------------------------------------------------------- joining device

describe("a device joining a repository that already has data", () => {
  it("bootstraps from it, adds its own items, and renumbers the ones whose identifiers the repository uses", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();

    // B made its own tracker for the same repository before connecting.
    const bHome = machine("device-b");
    const dir = freshClone(bHome);
    const cliHome = tmp("b-cli-home");
    staple(dir, cliHome, ["new", "B's own first issue"]);
    staple(dir, cliHome, ["new", "B's own second issue"]);
    staple(dir, cliHome, ["comment", `${prefix}-1`, "B's comment on its own issue"]);
    staple(dir, cliHome, ["queue", "add", `${prefix}-2`]);

    const b = connect(server, dir, "device-b", bHome);
    const ownFirst = id(b.db, `${prefix}-1`);
    const report = await b.sync();

    expect(report.seed!.repositoryEntities).toBeGreaterThan(0);
    expect(report.seed!.uploadedByEntity.issue).toBe(2);
    expect(report.seed!.renamed.map((r) => [r.from, r.to])).toEqual([
      [`${prefix}-1`, `${prefix}-6`],
      [`${prefix}-2`, `${prefix}-7`],
    ]);
    expect(report.seed!.merged.map((m) => m.label)).toEqual(["the plan"]);
    const told = describeSeed(report.seed!);
    expect(told.summary).toMatch(
      /^This repository already had data \(\d+ items\); bootstrapped from it, and 5 items of this workspace's were added \(2 issues, 3 comments\)\.$/,
    );
    expect(told.details).toContain(`renumbered ${prefix}-1 -> ${prefix}-6: the repository already had a ${prefix}-1`);
    expect(told.details).toContain("appended this workspace's items to the plan");
    // B's plan item survived, after the repository's: nothing of B's was replaced.
    expect(report.seed!.replaced).toEqual([]);

    // The repository's issues keep the numbers every other device already uses.
    expect(listConflicts(b.db), "no identifier was contested").toHaveLength(0);
    expect(count(b.db, "SELECT COUNT(*) AS n FROM issues WHERE identifier LIKE '%+%'")).toBe(0);
    expect((b.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(ownFirst) as { identifier: string }).identifier).toBe(
      `${prefix}-6`,
    );
    // The old number is on the record, on the issue, everywhere it goes.
    expect(
      count(b.db, `SELECT COUNT(*) AS n FROM comments WHERE issue_id = '${ownFirst}' AND author = 'staple' AND body LIKE '%Renumbered from ${prefix}-1 to ${prefix}-6%'`),
    ).toBe(1);

    await a.sync();
    expect(shape(a.db)).toEqual(shape(b.db));
    // B's queued item joined the repository's plan rather than replacing it.
    const plan = (a.db.prepare("SELECT i.identifier FROM queue_entries q JOIN issues i ON i.id = q.issue_id ORDER BY q.rank").all() as Array<{ identifier: string }>).map((r) => r.identifier);
    expect(plan).toEqual([`${prefix}-2`, `${prefix}-4`, `${prefix}-7`]);
    expect(listConflicts(a.db)).toHaveLength(0);
  });

  it("takes the repository's value for anything both hold, and says which of its own values were replaced", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    await a.sync();

    const bHome = machine("device-b");
    const dir = freshClone(bHome);
    const cliHome = tmp("b-cli-home");
    staple(dir, cliHome, ["settings", "set", "queue.policy", "advisory"]);
    staple(dir, cliHome, ["statuses", "add", "qa", "--category", "review", "--label", "Quality"]);
    const b = connect(server, dir, "device-b", bHome);
    const report = await b.sync();

    const replaced = report.seed!.replaced.map((r) => [r.entity, r.entityId, r.field, r.local, r.repository]);
    expect(replaced).toContainEqual(["setting", "queue.policy", "value", "advisory", "strict"]);
    expect(replaced).toContainEqual(["status", "qa", "label", "Quality", "Qa"]);
    expect(shape(b.db)).toEqual(shape(a.db));
  });

  it("reports a plan it held in another order, and takes the repository's", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    bindJournal(a.db, null);
    a.store.addComment(`${prefix}-2`, "handoff, A's", "a", "agent", { idempotencyKey: "handoff-1" });
    bindJournal(a.db, "device-a");
    await a.sync();

    // A copied database: the same issues by id, with the plan reordered before joining,
    // and its own comment under a retry key A's comment on the same issue already uses.
    const bHome = machine("device-b");
    const dir = copyOfTemplate();
    staple(dir, tmp("b-cli-home"), ["queue", "reorder", `${prefix}-4,${prefix}-2`]);
    const b = connect(server, dir, "device-b", bHome);
    bindJournal(b.db, null);
    b.store.addComment(`${prefix}-2`, "handoff, B's", "b", "agent", { idempotencyKey: "handoff-1" });
    bindJournal(b.db, "device-b");
    const report = await b.sync();

    expect(report.seed!.uploadedByEntity).toEqual({ comment: 1 });
    expect(report.seed!.cleared).toEqual([
      expect.objectContaining({ entity: "comment", field: "idempotencyKey", value: "handoff-1" }),
    ]);
    expect(report.seed!.replaced).toEqual([
      expect.objectContaining({
        entity: "queue",
        field: "order",
        local: [`${prefix}-4`, `${prefix}-2`],
        repository: [`${prefix}-2`, `${prefix}-4`],
      }),
    ]);
    await a.sync();
    expect(shape(b.db)).toEqual(shape(a.db));
  });

  it("yields a project slug and a retry key the repository already holds, instead of wedging either side", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onTemplate(server, "device-a");
    bindJournal(a.db, null);
    const aProject = a.store.projects().create({ name: "Web" }, "a");
    a.store.createIssue({ title: "Nightly report", idempotencyKey: "nightly-2026-09-10", createdBy: "a" });
    a.store.createIssue({ title: "Imported", originKind: "github", originId: "octo/repo#42", createdBy: "a" });
    bindJournal(a.db, "device-a");
    await a.sync();

    const b = onClone(server, "device-b");
    bindJournal(b.db, null);
    const bProject = b.store.projects().create({ name: "Web" }, "b");
    b.store.createIssue({ title: "Nightly report, B's", idempotencyKey: "nightly-2026-09-10", createdBy: "b" });
    b.store.createIssue({ title: "Imported, B's copy", originKind: "github", originId: "octo/repo#42", createdBy: "b" });
    bindJournal(b.db, "device-b");
    const report = await b.sync();

    expect(report.seed!.renamed).toContainEqual(
      expect.objectContaining({ entity: "project", entityId: bProject.id, from: "web", to: "web-2" }),
    );
    expect(report.seed!.cleared).toContainEqual(
      expect.objectContaining({ field: "idempotencyKey", value: "nightly-2026-09-10" }),
    );
    // Two live imports of one external item: the repository's keeps the link.
    expect(report.seed!.cleared).toContainEqual(expect.objectContaining({ field: "originId", value: "octo/repo#42" }));
    await a.sync();
    expect(count(a.db, "SELECT COUNT(*) AS n FROM issues WHERE origin_id = 'octo/repo#42'")).toBe(1);
    expect(a.db.prepare("SELECT slug FROM projects ORDER BY slug").all()).toEqual([{ slug: "web" }, { slug: "web-2" }]);
    expect((a.db.prepare("SELECT slug FROM projects WHERE id = ?").get(aProject.id) as { slug: string }).slug).toBe("web");
  });
});

// -------------------------------------------------------------- partial journal

describe("a workspace whose journal was armed for part of its life", () => {
  it("replaces the partial pre-connect journal with the seed, so nothing is sent ahead of what it names", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const c = onClone(server, "device-c");
    await c.sync();

    /**
     * The template was made disarmed. This machine then connected some OTHER repository
     * — which mints the device id every workspace on the machine arms with — and edited
     * a pre-connect issue and commented on it. The outbox now holds an update and a
     * comment for an issue whose create was never journaled.
     */
    const aHome = machine("device-a");
    const dir = copyOfTemplate();
    const armed = openWorkspace(dbPathOf(dir));
    bindJournal(armed.store.db, "device-a");
    armed.store.updateIssue(`${prefix}-1`, { title: "Edited while armed, before connecting" }, "a");
    armed.store.addComment(`${prefix}-1`, "commented while armed, before connecting", "a", "agent");
    expect(count(armed.store.db, "SELECT COUNT(*) AS n FROM sync_outbox")).toBeGreaterThan(0);
    armed.store.db.close();

    const a = connect(server, dir, "device-a", aHome);
    await a.sync();
    const report = await c.sync({ pullLimit: 1 });
    expect(report.pulled.operations).toBeGreaterThan(0);
    expect(shape(c.db)).toEqual(shape(a.db));
  });
});

// ------------------------------------------------------------------------ fork

describe("a fork owes a seed of its own", () => {
  it("uploads the whole workspace into the repository `fork-id` minted", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const aHome = machine("device-a");
    const dir = copyOfTemplate();
    const a = connect(server, dir, "device-a", aHome);
    await a.sync();

    const forked = forkRepositoryId(a.db, join(dir, ".staple"));
    const forkServer = new FakeSyncServer({ repositoryId: forked.repositoryId });
    credentialStoreFor(aHome, "file").write(forked.repositoryId, "token-fork");
    writeConnection(aHome, {
      schemaVersion: 1,
      repositoryId: forked.repositoryId,
      endpoint: ENDPOINT,
      deviceId: "device-a",
      label: "device-a",
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    forkServer.enroll("device-a", "token-fork");

    const report = await syncRepository(a.db, forked.repositoryId, {
      home: aHome,
      fetchImpl: forkServer.fetch,
      sleep: async () => undefined,
    });
    expect(report.seed!.repositoryId).toBe(forked.repositoryId);
    expect(report.seed!.uploadedByEntity.issue).toBe(5);
    expect(forkServer.ops.filter((op) => op.entity === "issue")).toHaveLength(5);
  });
});

// ------------------------------------------------------------------------ heal

describe("a database that synchronized under a build that did not seed", () => {
  it("uploads what it never sent, once, and gives the repository's issue its number back", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    a.store.createIssue({ title: "The repository's first issue", createdBy: "a" });
    await a.sync();

    // B's own issue, written disarmed, sits on the number A's issue will arrive with.
    const b = onClone(server, "device-b");
    bindJournal(b.db, null);
    b.store.createIssue({ title: "B's pre-connect issue", createdBy: "b" });
    b.store.createIssue({ title: "B's second pre-connect issue", createdBy: "b" });
    b.store.createIssue({ title: "B's third, edited once armed", createdBy: "b" });
    bindJournal(b.db, "device-b");
    const own = id(b.db, `${prefix}-1`);
    const second = id(b.db, `${prefix}-2`);
    const third = id(b.db, `${prefix}-3`);
    // Armed now, so this edit is journaled — as an update to an issue whose create never
    // was. The old build pushed exactly that: the service holds updates and no create.
    b.store.updateIssue(`${prefix}-3`, { priority: "high" }, "b");

    // What the old build did: synchronize without seeding. Emulated by a marker that
    // says the seed already happened, removed again once the sync is done.
    b.db.prepare("INSERT INTO meta (key, value) VALUES ('sync_seed', ?)").run(JSON.stringify({ repositoryId }));
    await b.sync();
    b.db.prepare("DELETE FROM meta WHERE key = 'sync_seed'").run();
    expect(count(b.db, "SELECT COUNT(*) AS n FROM issues WHERE identifier LIKE '%+%'"), "the old collision").toBe(1);
    expect(listConflicts(b.db).filter((c) => c.resolvedAt === null)).toHaveLength(1);

    // And an edit, journaled now, to a pre-connect issue the service has never seen:
    // an update with no create anywhere, which a push would send ahead of its entity.
    b.store.updateIssue(`${prefix}-2`, { title: "edited after connecting" }, "b");

    const healed = await b.sync();
    expect(healed.seed!.mode).toBe("heal");
    expect(healed.seed!.uploadedByEntity.issue).toBe(3);
    expect(healed.seed!.renamed.map((r) => [r.from, r.to])).toEqual([[`${prefix}-1`, `${prefix}-4`]]);
    expect(count(b.db, "SELECT COUNT(*) AS n FROM issues WHERE identifier LIKE '%+%'")).toBe(0);
    expect(listConflicts(b.db).filter((c) => c.resolvedAt === null)).toHaveLength(0);
    expect((b.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(own) as { identifier: string }).identifier).toBe(`${prefix}-4`);
    // The issue the service held only as an update now has its create, as that entity's
    // second operation on the service.
    expect(
      (b.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = 'issue' AND entity_id = ?").get(third) as { version: number }).version,
    ).toBe(2);
    // The unsent update travelled inside the create, which is the entity's first and
    // only operation on the service — so that is the version this device holds.
    expect(
      b.db.prepare("SELECT verb FROM sync_outbox WHERE entity = 'issue' AND entity_id = ? ORDER BY client_seq").all(second),
    ).toEqual([{ verb: "create" }]);
    expect(
      (b.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = 'issue' AND entity_id = ?").get(second) as { version: number }).version,
    ).toBe(1);

    /**
     * A was connected all along, so its tail holds the old build's update to B's third
     * issue many operations ahead of the create the heal just sent. One operation per
     * page puts them on different pages, beyond the reach of the pull loop's end-of-page
     * retry: the page fails, and the sync answers it with one read of the snapshot.
     */
    const recovered = await a.sync({ pullLimit: 1 });
    expect(recovered.bootstrap, "the stuck tail was answered by the snapshot").not.toBeNull();
    expect(shape(a.db)).toEqual(shape(b.db));
    expect((await b.sync()).seed).toBeNull();

    // And a device arriving now hydrates the issue the service used to hold as an update
    // with no create — which a bootstrap refuses, for want of an identifier.
    const d = onClone(server, "device-d");
    await d.sync();
    expect(shape(d.db)).toEqual(shape(a.db));
  });

  it("moves its unsent edits behind the upload, so none reaches the service ahead of what it names", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    const blocked = a.store.createIssue({ title: "A's blocked issue", createdBy: "a" });
    const blocker = a.store.createIssue({ title: "A's blocker", createdBy: "a" });
    a.store.setBlockedBy(blocked.identifier, [blocker.identifier], "a");
    await a.sync();

    const b = onClone(server, "device-b");
    bindJournal(b.db, null);
    const mine = b.store.createIssue({ title: "B's pre-connect blocker", createdBy: "b" });
    bindJournal(b.db, "device-b");
    b.db.prepare("INSERT INTO meta (key, value) VALUES ('sync_seed', ?)").run(JSON.stringify({ repositoryId }));
    await b.sync();
    b.db.prepare("DELETE FROM meta WHERE key = 'sync_seed'").run();

    /**
     * An edit to an entity the repository DOES hold — A's blocker set — that names one it
     * does not. The edit was allocated before the seed, and a push sends in allocation
     * order; left where it is, it reaches the service ahead of the create it names.
     */
    b.store.setBlockedBy(blocked.id, [blocker.id, mine.id], "b");

    const healed = await b.sync();
    expect(healed.seed!.resequenced).toBe(1);

    // One operation per page, so the pull loop's end-of-page retry cannot rescue an
    // operation that arrived ahead of its referent.
    await a.sync({ pullLimit: 1 });
    expect(
      (a.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? ORDER BY blocker_id").all(blocked.id) as Array<{ blocker_id: string }>)
        .map((row) => row.blocker_id)
        .sort(),
    ).toEqual([blocker.id, mine.id].sort());
  });
});

// ------------------------------------------------------------- paged bootstrap

describe("a paged bootstrap applies a snapshot in an order a database can take", () => {
  /**
   * `GET /snapshot` pages by entity key, and `comment …` and `documentRevision …` sort
   * before `issue …`. Pages of ONE entity put every dependency on a later page than its
   * dependent, and an interruption in the middle means the dependents that were parked
   * must survive the process that parked them.
   */
  it("parks what names a later page, keeps it across an interruption, and lands it", async () => {
    const server = new FakeSyncServer({ repositoryId, maxSnapshotPageSize: 1 });
    const b = onClone(server, "device-b");
    await b.sync();
    server.bumpEpoch();
    const c = onTemplate(server, "device-c");
    await c.sync();

    let pages = 0;
    const dying: typeof fetch = async (input, init) => {
      if (String(input).includes("/snapshot")) {
        pages += 1;
        if (pages > 4) throw new Error("the process died here");
      }
      return server.fetch(input, init);
    };
    await expect(b.sync({ fetchImpl: dying })).rejects.toThrow();
    const midway = readSyncState(b.db)!.bootstrap!;
    expect(midway.parked!.map((entity) => entity.entity).sort()).toEqual([
      "comment",
      "comment",
      "documentRevision",
      "documentRevision",
    ]);
    expect(count(b.db, "SELECT COUNT(*) AS n FROM comments"), "nothing was applied ahead of its issue").toBe(0);

    const report = await b.sync();
    expect(report.bootstrap!.resumed).toBe(true);
    expect(shape(b.db)).toEqual(shape(c.db));
  });
});

describe("an update whose create never arrived", () => {
  /**
   * What a build before the seed pushed for every pre-connect row it edited. Each of
   * these used to be written anyway — an issue refused with a validation error that no
   * sync could recover from, a comment as a raw NOT NULL failure, a project with its UUID
   * for a slug, a status under a category that does not exist. Each is a missing
   * referent: the page defers it, and a sync recovers by reading the snapshot.
   */
  it("is a missing referent, and nothing is invented for it", () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    const at = "2026-09-10T00:00:00.000Z";
    const orphan = (entity: string, entityId: string, payload: Record<string, unknown>) => () =>
      applyToDatabase(a.db, { entity, entityId, verb: "update", payload, actor: null, deviceId: "old", at, opId: "op" });

    expect(orphan("issue", "3f0c0000-0000-4000-8000-000000000001", { priority: "high" })).toThrow(ReferentMissing);
    expect(orphan("comment", "3f0c0000-0000-4000-8000-000000000002", { deletedAt: at })).toThrow(ReferentMissing);
    expect(orphan("project", "3f0c0000-0000-4000-8000-000000000003", { name: "Renamed" })).toThrow(ReferentMissing);
    expect(orphan("status", "review", { label: "Review" })).toThrow(ReferentMissing);
    expect(count(a.db, "SELECT COUNT(*) AS n FROM projects")).toBe(0);
    expect(count(a.db, "SELECT COUNT(*) AS n FROM workspace_statuses WHERE id = 'review'")).toBe(0);
  });
});

describe("re-reading the timeline a device is already on", () => {
  /**
   * The recovery a stuck tail takes reads the snapshot of the SAME epoch, so the fold's
   * per-field numbers and this device's counter count the same operations. Lifting each
   * inherited write to the counter, as a re-bootstrap into a new epoch must, would claim
   * `priority` was written at version 3 when it was written at 1 — and contest a later
   * edit made by a device that had seen that write.
   */
  it("keeps inherited provenance at the fold's own numbers", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    const issue = a.store.createIssue({ title: "Held already", createdBy: "a" });
    await a.sync();
    a.db.prepare("UPDATE sync_entity_versions SET version = 3 WHERE entity = 'issue' AND entity_id = ?").run(issue.id);

    const folded = {
      entity: "issue",
      entityId: issue.id,
      version: 3,
      deletedAt: null,
      lastSeq: 3,
      verb: "create",
      state: { identifier: issue.identifier, title: "Held already", priority: "high" },
      fieldWrites: { priority: { baseVersion: 1, opId: "op-that-set-priority", at: "2026-09-10T00:00:00.000Z" } },
    };
    const baseOf = () =>
      (a.db.prepare("SELECT base_version FROM sync_field_writes WHERE entity_id = ? AND field = 'priority'").get(issue.id) as { base_version: number }).base_version;

    a.db.exec("BEGIN");
    hydrate(a.db, bindJournal(a.db, "device-a"), [folded], [], 3, "2026-09-10T00:00:00.000Z", true, true);
    expect(baseOf(), "same timeline: the fold's number").toBe(1);
    a.db.exec("ROLLBACK");

    a.db.exec("BEGIN");
    hydrate(a.db, bindJournal(a.db, "device-a"), [folded], [], 4, "2026-09-10T00:00:00.000Z", true, false);
    expect(baseOf(), "a new epoch: lifted to the counter this device keeps").toBe(3);
    a.db.exec("ROLLBACK");
  });
});

// ------------------------------------------------------------------ oversized

describe("an item larger than the service takes", () => {
  it("leaves an oversized document revision behind and names it, and uploads the rest", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    bindJournal(a.db, null);
    const issue = a.store.createIssue({ title: "Has a huge log attached", createdBy: "a" });
    a.store.putDocument(issue.identifier, "log", "x".repeat(600 * 1024));
    a.store.putDocument(issue.identifier, "log", "a short summary instead");
    bindJournal(a.db, "device-a");

    const report = await a.sync();
    expect(report.seed!.skipped.map((s) => s.label)).toEqual([`${issue.identifier} log r1`]);
    expect(report.seed!.uploadedByEntity.documentRevision).toBe(1);
    expect(report.pending).toBe(0);
  });

  it("refuses to seed at all when an issue is too large, and writes nothing", async () => {
    const server = new FakeSyncServer({ repositoryId });
    const a = onClone(server, "device-a");
    bindJournal(a.db, null);
    a.store.createIssue({ title: "Enormous", description: "y".repeat(600 * 1024), createdBy: "a" });
    bindJournal(a.db, "device-a");

    await expect(a.sync()).rejects.toThrow(/Shorten it and run sync again/);
    expect(readSeedMarker(a.db)).toBeNull();
    expect(count(a.db, "SELECT COUNT(*) AS n FROM sync_outbox")).toBe(0);
    expect(server.ops).toHaveLength(0);
  });
});
