/**
 * A run's name and the issues it names (core/run-references.ts), against runs made by the
 * real store through the real `run continue`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { recordIdentifierMove } from "../src/core/identifier-moves.js";
import { runReferences } from "../src/core/run-references.js";
import type { RunStore } from "../src/core/run-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

const BOT = "bot";
let store: WorkspaceStore;
let runs: RunStore;

beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  runs = store.runs();
});

const issue = (title: string, input: Record<string, unknown> = {}) => store.createIssue({ title, ...input }).identifier;
const cont = (input: Parameters<RunStore["continue"]>[0] = {}) => runs.continue({ actor: BOT, ...input });
const refsOf = (runId: string) => runReferences(store, runs.status(runId));
const idOf = (ref: string) => store.getIssue(ref).id;

describe("a run's title", () => {
  it("is its epic's title, not an identifier", () => {
    const epic = issue("R3 OpenAPI and SDKs", { kind: "epic" });
    issue("Generate the C# client", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    expect(refsOf(run.id).title).toBe("R3 OpenAPI and SDKs");
  });

  it("over the queue: the whole queue before it takes anything, then the parents of what it took, in order", () => {
    const sdk = issue("R3 OpenAPI and SDKs", { kind: "epic" });
    const docs = issue("Docs site", { kind: "epic" });
    const a = issue("Generate the C# client", { parent: sdk });
    const b = issue("Generate the TS client", { parent: sdk });
    const c = issue("Write the quickstart", { parent: docs });
    const lone = issue("Fix the favicon");
    for (const ref of [a, b, c, lone]) store.queue().mutate("add", { ref }, "vp");
    const run = runs.start({ actor: BOT, scope: "queue" });
    expect(refsOf(run.id).title).toBe("The whole queue");

    expect(cont()).toMatchObject({ action: "take", ref: a });
    expect(refsOf(run.id).title).toBe("Queue: R3 OpenAPI and SDKs");
    store.updateIssue(a, { status: "in_review" }, BOT);
    expect(cont()).toMatchObject({ action: "take", ref: b });
    // A second ticket under the same parent adds no name.
    expect(refsOf(run.id).title).toBe("Queue: R3 OpenAPI and SDKs");
    store.updateIssue(b, { status: "in_review" }, BOT);
    expect(cont()).toMatchObject({ action: "take", ref: c });
    store.updateIssue(c, { status: "in_review" }, BOT);
    expect(cont()).toMatchObject({ action: "take", ref: lone });
    // A ticket with no parent is named itself.
    expect(refsOf(run.id).title).toBe("Queue: R3 OpenAPI and SDKs and 2 more");
  });

  it("over the queue, a ticket with no parent names the run by its own title", () => {
    const lone = issue("Fix the favicon");
    store.queue().mutate("add", { ref: lone }, "vp");
    const run = runs.start({ actor: BOT, scope: "queue" });
    cont();
    expect(refsOf(run.id).title).toBe("Queue: Fix the favicon");
  });
});

describe("the issues a run names", () => {
  it("carries the scope and every ticket with its current status, category, title and kind", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    const b = issue("B", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    store.updateIssue(a, { status: "in_review" }, BOT);
    cont();
    const byId = new Map(refsOf(run.id).issues.map((entry) => [entry.issueId, entry]));
    expect(byId.get(idOf(epic))).toMatchObject({ identifier: epic, title: "Epic", kind: "epic" });
    expect(byId.get(idOf(a))).toMatchObject({ identifier: a, title: "A", status: "in_review", category: "review" });
    expect(byId.get(idOf(b))).toMatchObject({ identifier: b, title: "B", status: "in_progress", category: "active" });
  });

  it("names a ticket by its identifier now, not the one it had when it was taken", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    store.updateIssue(a, { status: "in_review" }, BOT);
    cont();
    runs.stop(run.id, "vp");
    // Ended, the run reads no facts: only the ticket's issueId names it.
    expect(runs.status(run.id).facts).toBeNull();
    // What a renumber from another device does to the row (fixture: an in-memory database).
    store.db.prepare("UPDATE issues SET identifier = 'TST-90' WHERE id = ?").run(idOf(a));
    const status = runs.status(run.id);
    expect(status.run.tickets[0]!.identifier).toBe(a);
    const ticket = runReferences(store, status).issues.find((entry) => entry.issueId === status.run.tickets[0]!.issueId);
    expect(ticket).toMatchObject({ identifier: "TST-90", title: "A" });
  });

  it("never lends a ticket's old identifier to the issue that holds that number now", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    issue("B", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    cont({ outcome: "failed", reason: "one" });
    cont({ outcome: "failed", reason: "two" });
    // Sync renumbers the ticket the run took, and another issue arrives on its old number.
    store.db.prepare("UPDATE issues SET identifier = 'TST-90' WHERE id = ?").run(idOf(a));
    const other = store.createIssue({ title: "Someone else's" });
    store.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(a, other.id);
    const references = runReferences(store, runs.status(run.id));
    expect(references.issues.some((entry) => entry.issueId === other.id)).toBe(false);
    expect(references.issues.find((entry) => entry.issueId === idOf("TST-90"))).toMatchObject({ identifier: "TST-90", title: "A" });
  });

  it("resolves the identifiers a stop names, and leaves out what no longer exists", () => {
    const epic = issue("Epic", { kind: "epic" });
    const a = issue("A", { parent: epic });
    issue("B", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    cont({ outcome: "failed", reason: "one" });
    expect(cont({ outcome: "failed", reason: "two" })).toMatchObject({ action: "stop", reason: "failure_streak" });
    const status = runs.status(run.id);
    expect(status.run.stop?.detail).toMatchObject({ tickets: [a, a] });
    const references = runReferences(store, status);
    expect(references.issues.filter((entry) => entry.identifier === a)).toHaveLength(1);
    // A stop naming an identifier nobody has any more (deleted since) resolves to nothing.
    const gone = runReferences(store, { ...status, run: { ...status.run, stop: { ...status.run.stop!, detail: { tickets: ["TST-404"] } } } });
    expect(gone.issues.some((entry) => entry.identifier === "TST-404")).toBe(false);
    // One that moved here, held by nobody now: the issue that moved off it.
    const moved = store.createIssue({ title: "Moved" });
    recordIdentifierMove(store.db, { issueId: moved.id, from: "TST-405", to: moved.identifier, at: "2026-11-26T00:00:00.000Z" });
    const followed = runReferences(store, { ...status, run: { ...status.run, stop: { ...status.run.stop!, detail: { gates: ["TST-405"] } } } });
    expect(followed.issues.find((entry) => entry.issueId === moved.id)).toMatchObject({ identifier: moved.identifier, title: "Moved" });
  });
});
