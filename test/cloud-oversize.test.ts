/**
 * An operation larger than the service accepts is refused where the human is, and never
 * blocks the queue behind it.
 *
 * The service refuses an oversized payload for the WHOLE batch (`worker/src/envelope.ts`,
 * `MAX_OP_BYTES`, 512 KiB on every plan). Before this, one `putDocument` of a large file
 * on a connected workspace was journaled, the next push was refused, and so was every push
 * after it: nothing that device wrote ever left the machine again, and the only symptom
 * was a `payload_too_large` a person could do nothing about.
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bindJournal } from "../src/core/journal.js";
import { openWorkspace } from "../src/core/open.js";
import { connectionPath } from "../src/core/cloud/connection.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000b2";
const BIG = "x".repeat(600 * 1024);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function count(db: import("node:sqlite").DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function refusal(work: () => unknown): StapleError | null {
  try {
    work();
    return null;
  } catch (error) {
    return error as StapleError;
  }
}

describe("at write time", () => {
  it("refuses a document revision larger than the service takes, on a connected workspace, and writes nothing", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const issue = a.store.createIssue({ title: "Has a large plan" });
    const outboxBefore = count(a.db, "SELECT COUNT(*) AS n FROM sync_outbox");

    const error = refusal(() => a.store.putDocument(issue.id, "plan", BIG));
    expect(error).toBeInstanceOf(StapleError);
    expect(error!.detail?.cloudCode).toBe("payload_too_large");
    expect(error!.message).toContain("Nothing was written");
    expect(count(a.db, "SELECT COUNT(*) AS n FROM document_revisions")).toBe(0);
    expect(count(a.db, "SELECT COUNT(*) AS n FROM sync_outbox")).toBe(outboxBefore);
  });

  it("refuses it on a workspace that has synchronized and been disconnected since: its queue still goes", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    rmSync(connectionPath(a.home, REPO));
    const issue = a.store.createIssue({ title: "Has a large plan" });
    expect(refusal(() => a.store.putDocument(issue.id, "plan", BIG))?.detail?.cloudCode).toBe("payload_too_large");
  });

  it("takes it in a workspace that is not connected and has never synchronized: that queue goes nowhere", () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const prepared = fleet.prepare("a");
    const opened = openWorkspace(`${prepared.dir}/.staple/staple.db`);
    // Armed — a device id and a repository identity — which is what a workspace is on a
    // machine that connected some OTHER repository.
    bindJournal(opened.store.db, "device-a");
    try {
      const issue = opened.store.createIssue({ title: "Has a large plan" });
      opened.store.putDocument(issue.id, "plan", BIG);
      expect(count(opened.store.db, "SELECT COUNT(*) AS n FROM document_revisions")).toBe(1);
    } finally {
      opened.store.db.close();
    }
  });
});

describe("at push time, for a queue written before the journal refused", () => {
  /** A service that takes less than the journal allows: the journal's check cannot catch these. */
  function smallService(): FakeSyncServer {
    return new FakeSyncServer({ repositoryId: REPO, maxOpBytes: 4 * 1024 });
  }
  const LARGE = "y".repeat(8 * 1024);

  it("leaves an oversized revision and comment behind, names them, and sends everything else", async () => {
    const server = smallService();
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    const issue = a.store.createIssue({ title: "Before" });
    a.store.putDocument(issue.id, "plan", LARGE);
    a.store.addComment(issue.id, LARGE);
    const after = a.store.createIssue({ title: "After" });

    const report = await a.sync();
    expect(report.withheld.map((op) => op.entity).sort()).toEqual(["comment", "documentRevision"]);
    expect(report.pending).toBe(0);
    // Everything queued behind them reached the service.
    expect(server.ops.map((op) => op.entityId)).toEqual(expect.arrayContaining([issue.id, after.id]));

    const b = fleet.machine("b");
    await b.sync();
    expect(count(b.db, "SELECT COUNT(*) AS n FROM issues")).toBe(2);
  });

  it("refuses an oversized issue by name, and sends it once it has been edited below the limit", async () => {
    const server = smallService();
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    const issue = a.store.createIssue({ title: "Pasted a log", description: LARGE });

    const stopped = await a.sync().then(() => null, (error: unknown) => error as StapleError);
    expect(stopped?.detail?.cloudCode).toBe("payload_too_large");
    expect(stopped?.message).toContain(issue.identifier);
    expect(stopped?.message).toContain("update_task");
    expect(server.ops.filter((op) => op.entity === "issue")).toHaveLength(0);

    a.store.updateIssue(issue.id, { description: "The log is attached elsewhere." });
    const report = await a.sync();
    expect(report.pending).toBe(0);
    const b = fleet.machine("b");
    await b.sync();
    expect(b.db.prepare("SELECT description FROM issues WHERE id = ?").get(issue.id)).toEqual({
      description: "The log is attached elsewhere.",
    });
  });
});
