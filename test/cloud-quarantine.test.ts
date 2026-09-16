/**
 * RW1(c). No entity can stop a sync (`quarantine.ts`, `docs/sync.md` "No entity can stop a sync").
 *
 * An entity naming what never arrived used to fail its page — of the ordered tail or of a
 * snapshot — whole, and every later sync met the same page: one device's write stopped every
 * other device, and every join, for good. Now it is set aside, the rest applies, the position
 * moves on, and it lands once what it names arrives. `cloud status` and `doctor` report it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runDiagnostics } from "../src/commands/doctor.js";
import { countQuarantined, readQuarantine } from "../src/core/cloud/quarantine.js";
import { cloudSurfaceReport } from "../src/core/cloud/surface.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000018f";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const comments = (machine: Machine): string[] =>
  (machine.db.prepare("SELECT body FROM comments ORDER BY body").all() as Array<{ body: string }>).map((row) => row.body);

describe("an entity naming what never arrived", () => {
  it("is set aside from a tail page and a snapshot, the rest applies, and it lands when what it names arrives", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    // A build that sends a comment on an issue whose create it never sent.
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const older = new OlderBuildDevice(server, REPO, "device-older", schema);
    const missing = randomUUID();
    await older.push([
      { entity: "comment", entityId: randomUUID(), verb: "create", payload: { issueId: missing, author: "older", authorType: "agent", body: "on an issue nobody sent" } },
    ]);
    a.use();
    a.store.createIssue({ title: "After it" });
    await a.sync();

    // The tail page: B applies the rest and moves on.
    b.use();
    const report = await b.sync();
    expect(report.quarantined).toBe(1);
    expect((b.db.prepare("SELECT title FROM issues ORDER BY title").all() as Array<{ title: string }>).map((row) => row.title)).toEqual(["After it", "Shared"]);
    expect(readQuarantine(b.db)[0]).toMatchObject({ entity: "comment", what: expect.stringContaining(missing) });
    // And a device joins through the snapshot that holds it.
    const joining = fleet.machine("joining");
    await joining.sync();
    expect(countQuarantined(joining.db)).toBe(1);
    expect((joining.db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n).toBe(2);

    // Status and doctor say so.
    joining.use();
    const surface = cloudSurfaceReport(
      { state: "manual", repositoryId: REPO, endpoint: null, deviceId: null, label: null, credentialMechanism: null, credentialPresent: false, auto: false, backup: false, connectedAt: null, checked: false, warnings: [] } as never,
      joining.db,
    );
    expect(surface.quarantined).toBe(1);
    const check = runDiagnostics({ dir: joining.dir }).checks.find((candidate) => candidate.id === "sync-quarantine")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(missing);

    // The create arrives: everything set aside lands.
    await older.push([
      {
        entity: "issue",
        entityId: missing,
        verb: "create",
        payload: { identifier: "TRA-90", title: "Sent at last", normalizedTitle: "sent at last", status: "backlog", kind: "task", priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    ]);
    for (const machine of [a, b, joining]) {
      machine.use();
      await machine.sync();
      expect(countQuarantined(machine.db), machine.label).toBe(0);
      expect(comments(machine), machine.label).toEqual(["on an issue nobody sent"]);
    }
    expect(runDiagnostics({ dir: joining.dir }).checks.find((candidate) => candidate.id === "sync-quarantine")!.status).toBe("pass");
  });
});
