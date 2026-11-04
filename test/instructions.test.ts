/**
 * Instruction documents (`core/instructions.ts`, migration 019): the flag on a revision,
 * which tickets a document reaches and in what order, a run's own instructions, the
 * `instructions_changed` news a live run reports, the brief a driven session reads, and the
 * flag surviving every path a revision travels between devices.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { localInventory } from "../src/core/cloud/seed.js";
import { renderInstructions, runInstructionKey } from "../src/core/instructions.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { buildBrief } from "../src/core/run-brief.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError, nowIso, setClock } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const BOT = "bot";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});
afterEach(() => setClock(null));

function issue(title: string, input: Record<string, unknown> = {}): string {
  return store.createIssue({ title, ...input }).identifier;
}

function changes(): Array<Record<string, unknown>> {
  return store
    .listEvents(0, 1000)
    .filter((event) => event.kind === "instructions_changed")
    .map((event) => ({ ...event.payload, issueId: event.issueId }));
}

/** Source and key of each instruction, nearest first, with whether it is in effect. */
function shape(ref: string, runId?: string): Array<[string, string | null, string, boolean]> {
  return store.instructions(ref, { runId }).map((entry) => [entry.source.kind, entry.source.ref, entry.key, entry.effective]);
}

describe("the flag on a revision", () => {
  it("is set by instructions: true, kept by a write that leaves it out, and cleared by instructions: false", () => {
    const epic = issue("Epic", { kind: "epic" });
    expect(store.putDocument(epic, "rules", "one", { instructions: true, author: "vp" })).toEqual({ key: "rules", revision: 1, instructions: true });
    expect(store.listDocuments(epic)).toMatchObject([{ key: "rules", currentRevision: 1, instructions: true }]);
    // Somebody who never heard of the flag edits it: still instructions.
    expect(store.putDocument(epic, "rules", "two", { author: "agent" }).instructions).toBe(true);
    expect(store.getDocument(epic, "rules")).toMatchObject({ revision: 2, body: "two", instructions: true });
    expect(store.putDocument(epic, "rules", "three", { instructions: false }).instructions).toBe(false);
    expect(store.listDocuments(epic)[0]!.instructions).toBe(false);
    // History keeps what each revision was.
    expect([1, 2, 3].map((revision) => store.getDocument(epic, "rules", revision).instructions)).toEqual([true, true, false]);
  });

  it("is off for a plain document, which reaches nobody", () => {
    const epic = issue("Epic", { kind: "epic" });
    const child = issue("Child", { parent: epic });
    store.putDocument(epic, "plan", "a plan");
    expect(store.listDocuments(epic)[0]!.instructions).toBe(false);
    expect(store.instructions(child)).toEqual([]);
    expect(changes()).toEqual([]);
  });
});

describe("which instructions reach a ticket", () => {
  it("walks the parent chain nearest first, the ticket's own before its parents'", () => {
    const epic = issue("Epic", { kind: "epic" });
    const mid = issue("Mid", { parent: epic });
    const leaf = issue("Leaf", { parent: mid });
    store.putDocument(epic, "rules", "epic rules", { instructions: true });
    store.putDocument(mid, "review", "mid review", { instructions: true });
    store.putDocument(leaf, "local", "leaf only", { instructions: true });
    expect(shape(leaf)).toEqual([
      ["self", leaf, "local", true],
      ["parent", mid, "review", true],
      ["parent", epic, "rules", true],
    ]);
    // The epic's own list is its own; nothing below it reaches up.
    expect(shape(epic)).toEqual([["self", epic, "rules", true]]);
    const [own] = store.instructions(leaf);
    expect(own).toMatchObject({ body: "leaf only", revision: 1, source: { kind: "self", ref: leaf, title: "Leaf", runId: null }, shadowedBy: null });
  });

  it("reaches a milestone's members and a member epic's descendants, which membership alone would not", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    const epic = issue("Epic", { kind: "epic" });
    const child = issue("Child", { parent: epic });
    const direct = issue("Direct");
    const outside = issue("Outside");
    store.milestones().addMember(milestone, epic, {}, "vp");
    store.milestones().addMember(milestone, direct, {}, "vp");
    store.putDocument(milestone, "rules", "milestone rules", { instructions: true });
    expect(shape(child)).toEqual([["milestone", milestone, "rules", true]]);
    expect(shape(epic)).toEqual([["milestone", milestone, "rules", true]]);
    expect(shape(direct)).toEqual([["milestone", milestone, "rules", true]]);
    expect(shape(outside)).toEqual([]);
  });

  it("lets the nearest source win a key, and lists the farther one shadowed by it", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    const epic = issue("Epic", { kind: "epic" });
    const child = issue("Child", { parent: epic });
    store.milestones().addMember(milestone, epic, {}, "vp");
    store.putDocument(milestone, "rules", "milestone rules", { instructions: true });
    store.putDocument(milestone, "stacking", "stack PRs", { instructions: true });
    store.putDocument(epic, "rules", "epic rules win", { instructions: true });
    expect(shape(child)).toEqual([
      ["parent", epic, "rules", true],
      ["milestone", milestone, "rules", false],
      ["milestone", milestone, "stacking", true],
    ]);
    const shadowed = store.instructions(child).find((entry) => !entry.effective)!;
    expect(shadowed.shadowedBy).toMatchObject({ kind: "parent", ref: epic });
    const text = renderInstructions(store.instructions(child));
    expect(text).toContain("epic rules win");
    expect(text).toContain("stack PRs");
    expect(text).not.toContain("milestone rules");
    expect(text).toContain(`rules from milestone ${milestone}, overridden by parent ${epic}`);
  });

  it("does not read a milestone twice when the ticket is filed under it", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    const child = issue("Child", { parent: milestone });
    store.putDocument(milestone, "rules", "milestone rules", { instructions: true });
    expect(shape(child)).toEqual([["parent", milestone, "rules", true]]);
  });

  it("is on the detail every surface reads", () => {
    const epic = issue("Epic", { kind: "epic" });
    const child = issue("Child", { parent: epic });
    store.putDocument(epic, "rules", "epic rules", { instructions: true });
    expect(store.context(child).instructions.map((entry) => entry.key)).toEqual(["rules"]);
  });
});

describe("instructions_changed", () => {
  it("is raised when an instruction document is written, and when one stops being one", () => {
    const epic = issue("Epic", { kind: "epic" });
    const epicId = store.getIssue(epic).id;
    store.putDocument(epic, "rules", "one", { instructions: true, author: "vp" });
    store.putDocument(epic, "rules", "two");
    store.putDocument(epic, "rules", "off", { instructions: false });
    store.putDocument(epic, "rules", "still off");
    expect(changes()).toEqual([
      { key: "rules", revision: 1, instructions: true, was: false, issueId: epicId },
      { key: "rules", revision: 2, instructions: true, was: true, issueId: epicId },
      { key: "rules", revision: 3, instructions: false, was: true, issueId: epicId },
    ]);
  });
});

describe("a run's own instructions", () => {
  function epicWithTwo(): { epic: string; a: string; b: string } {
    const epic = issue("Epic", { kind: "epic" });
    return { epic, a: issue("A", { parent: epic }), b: issue("B", { parent: epic }) };
  }

  it("ride every take after the ticket's own sources, and a document with the same key wins", () => {
    const { epic, a } = epicWithTwo();
    store.putDocument(epic, "rules", "epic rules", { instructions: true });
    const run = store.runs().start({
      actor: BOT,
      scope: epic,
      instructions: [
        { key: "rules", body: "run rules" },
        { key: "gates", body: "npm test" },
      ],
    });
    expect(run.instructions).toEqual([
      { key: "rules", body: "run rules" },
      { key: "gates", body: "npm test" },
    ]);
    const take = store.runs().continue({ actor: BOT });
    if (take.action !== "take") throw new Error(`expected a take, got ${take.action}`);
    expect(take.ref).toBe(a);
    expect(take.instructions.map((entry) => [entry.source.kind, entry.key, entry.effective])).toEqual([
      ["parent", "rules", true],
      ["run", "rules", false],
      ["run", "gates", true],
    ]);
    expect(take.instructions[2]!.source).toEqual({ kind: "run", ref: null, issueId: null, title: null, runId: run.id });
    expect(take.instructionsChanged).toEqual([]);
    // The detail read for the run adds them too; without the run it does not.
    expect(shape(a, run.id).map(([kind, , key]) => `${kind}:${key}`)).toEqual(["parent:rules", "run:rules", "run:gates"]);
    expect(shape(a).map(([kind, , key]) => `${kind}:${key}`)).toEqual(["parent:rules"]);
  });

  it("refuses two with one key, an empty one, and a bad key", () => {
    const { epic } = epicWithTwo();
    const refuse = (instructions: Array<{ key: string; body: string }>): string => {
      try {
        store.runs().start({ actor: BOT, scope: epic, instructions });
      } catch (error) {
        expect(error).toBeInstanceOf(StapleError);
        expect((error as StapleError).code).toBe("validation");
        return (error as StapleError).message;
      }
      throw new Error("expected a refusal");
    };
    expect(refuse([{ key: "rules", body: "a" }, { key: "Rules", body: "b" }])).toMatch(/share the key "rules"/);
    expect(refuse([{ key: "rules", body: "  " }])).toMatch(/is empty/);
    expect(refuse([{ key: "no spaces", body: "x" }])).toMatch(/key must be/);
    expect(store.runs().list({ all: true })).toEqual([]);
  });

  it("are keyed by the file name they came from", () => {
    expect(runInstructionKey("/tmp/x/rules.md")).toBe("rules");
    expect(runInstructionKey("Review Policy.txt")).toBe("review-policy");
    expect(runInstructionKey(".md")).toBe("run");
  });
});

describe("a live run hears that its instructions changed", () => {
  it("reports an edit made since its last take on the next take, once, and in run status before that", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    const b = issue("B", { parent: epic });
    const elsewhere = issue("Elsewhere", { kind: "epic" });
    store.putDocument(epic, "rules", "v1", { instructions: true, author: "vp" });
    const runs = store.runs();
    const run = runs.start({ actor: BOT, scope: epic });
    const first = runs.continue({ actor: BOT });
    if (first.action !== "take") throw new Error("expected a take");
    expect(first.ref).toBe(a);
    // Written before the run started: not news.
    expect(first.instructionsChanged).toEqual([]);

    store.putDocument(epic, "rules", "v2", { author: "vp" });
    // Outside the run's scope: not news to it.
    store.putDocument(elsewhere, "rules", "other", { instructions: true, author: "vp" });
    expect(runs.status(run.id).instructionsChanged.map((change) => [change.ref, change.key, change.revision])).toEqual([[epic, "rules", 2]]);

    store.updateIssue(a, { status: "done" }, BOT);
    const second = runs.continue({ actor: BOT });
    if (second.action !== "take") throw new Error(`expected a take, got ${second.action}`);
    expect(second.ref).toBe(b);
    expect(second.instructionsChanged).toMatchObject([{ ref: epic, key: "rules", revision: 2, instructions: true, actor: "vp" }]);
    expect(second.instructions.find((entry) => entry.key === "rules")?.body).toBe("v2");
    expect(runs.status(run.id).instructionsChanged).toEqual([]);
  });
});

describe("a change the run has not reached yet", () => {
  it("is on the next take, as run status promised, and is not lost when the watermark moves", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    const b = issue("B", { parent: epic });
    const c = issue("C", { parent: epic });
    store.putDocument(c, "rules", "v1", { instructions: true, author: "vp" });
    const runs = store.runs();
    const run = runs.start({ actor: BOT, scope: epic });
    const first = runs.continue({ actor: BOT });
    if (first.action !== "take") throw new Error("expected a take");
    expect(first.ref).toBe(a);
    store.putDocument(c, "rules", "v2", { author: "vp" });
    const promised = runs.status(run.id).instructionsChanged.map((change) => [change.ref, change.key, change.revision]);
    expect(promised).toEqual([[c, "rules", 2]]);
    store.updateIssue(a, { status: "done" }, BOT);
    const second = runs.continue({ actor: BOT });
    if (second.action !== "take") throw new Error(`expected a take, got ${second.action}`);
    expect(second.ref).toBe(b);
    // B does not read C's rules, but the run's rules moved: the take says so, once.
    expect(second.instructionsChanged.map((change) => [change.ref, change.key, change.revision])).toEqual(promised);
    expect(runs.status(run.id).instructionsChanged).toEqual([]);
  });
});

describe("the brief a driven session reads", () => {
  it("carries every instruction in effect with its source, what changed, and the file", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    store.putDocument(epic, "rules", "Never merge to master.", { instructions: true });
    const brief = buildBrief({
      ref: a,
      title: "A",
      workspace: "/w",
      db: "/w/.staple/staple.db",
      runId: "run-1",
      actor: BOT,
      finish: "in_review",
      instructions: null,
      ticketInstructions: store.instructions(a),
      instructionsChanged: [{ seq: 9, ref: epic, issueId: "x", key: "rules", revision: 1, instructions: true, actor: "vp", at: nowIso() }],
      instructionsFile: "/w/.staple/runs/run-1/001.instructions.json",
    });
    expect(brief).toContain("## Instructions for this ticket");
    expect(brief).toContain(`### rules (parent ${epic}, r1)`);
    expect(brief).toContain("Never merge to master.");
    expect(brief).toContain(`Changed since the run's last ticket: ${epic} rules r1`);
    expect(brief).toContain("$STAPLE_RUN_INSTRUCTIONS (/w/.staple/runs/run-1/001.instructions.json)");
  });

  it("has no instructions section when none apply", () => {
    const brief = buildBrief({ ref: "TST-1", title: "t", workspace: "/w", db: "/w/db", runId: "r", actor: BOT, finish: "done", instructions: null, ticketInstructions: [] });
    expect(brief).not.toContain("## Instructions for this ticket");
  });
});

// ------------------------------------------------------------------ sync

const REPO = "5eed0000-0000-4000-8000-000000000385";
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function flags(db: DatabaseSync, issueId: string): unknown {
  return db.prepare("SELECT revision, instructions FROM document_revisions WHERE issue_id = ? AND key = 'rules' ORDER BY revision").all(issueId);
}

describe("the flag travels with the revision", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`reaches another device, the tail and a fresh device, and raises instructions_changed on the device it lands on (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a: Machine = fleet.machine("a");
      const b: Machine = fleet.machine("b");
      a.use();
      const epic = a.store.createIssue({ title: "Epic", kind: "epic" });
      const child = a.store.createIssue({ title: "Child", parent: epic.identifier });
      await a.sync();
      b.use();
      await b.sync();

      a.use();
      a.store.putDocument(epic.id, "rules", "one", { instructions: true, author: "vp" });
      a.store.putDocument(epic.id, "rules", "two", { author: "vp" });
      a.store.putDocument(epic.id, "rules", "off", { instructions: false, author: "vp" });
      await a.sync();
      b.use();
      await b.sync();
      const expected = [
        { revision: 1, instructions: 1 },
        { revision: 2, instructions: 1 },
        { revision: 3, instructions: 0 },
      ];
      expect(flags(b.db, epic.id)).toEqual(expected);
      const received = b.store
        .listEvents(0, 1000)
        .filter((event) => event.kind === "instructions_changed")
        .map((event) => [event.payload.revision, event.payload.instructions]);
      // One per head the pulled page moved: the device that wrote them is not the only one a run lives on.
      expect(received.at(-1)).toEqual([3, false]);
      expect(received.length).toBeGreaterThanOrEqual(1);

      const fresh = fleet.machine("fresh");
      fresh.use();
      await fresh.sync();
      expect(flags(fresh.db, epic.id)).toEqual(expected);

      // Turned back on, on B: A hears it and the child reads it.
      b.use();
      b.store.putDocument(epic.id, "rules", "on again", { instructions: true, author: "bob" });
      await b.sync();
      a.use();
      await a.sync();
      expect(a.store.instructions(child.id).map((entry) => [entry.key, entry.body, entry.revision])).toEqual([["rules", "on again", 4]]);
    });
  }

  it("is in the entity a seed uploads", () => {
    const epic = issue("Epic", { kind: "epic" });
    store.putDocument(epic, "rules", "one", { instructions: true });
    store.putDocument(epic, "plan", "a plan");
    const revisions = localInventory(store.db, nowIso()).filter((entity) => entity.entity === "documentRevision");
    expect(revisions.map((entity) => [entity.payload.key, entity.payload.instructions])).toEqual([
      ["plan", false],
      ["rules", true],
    ]);
  });
});
