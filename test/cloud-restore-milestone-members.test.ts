/**
 * A milestone the log holds no membership write of holds no members (`docs/sync.md`, "A restore
 * rewinds").
 *
 * A milestone made on a device already connected reaches the log as `milestone update
 * { targetDate, startDate }`, with no `members` key, and a backup taken before its membership
 * changed restores it that way. A member added after the backup then survived the restore on
 * every device that held it: the rewind saw the milestone in the epoch, and the snapshot said
 * nothing about its members, so nothing cleared the rows. A device joining afterwards had none.
 * Now the rewind reads the absent key as what a fresh device reads it as: no members, unless this
 * device's own unsent work says otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000f10a";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

const members = (machine: Machine, milestone: string): string[] =>
  (machine.db.prepare("SELECT issue_id FROM milestone_members WHERE milestone_id = ? ORDER BY rank").all(milestone) as Array<{ issue_id: string }>).map(
    (row) => row.issue_id,
  );

describe("a restore of a milestone whose membership the backup never saw written", () => {
  for (const connectedFirst of [true, false]) {
    for (const unsent of [false, true]) {
      it(`${unsent ? "keeps an unsent" : "rewinds a pushed"} member (milestone made ${connectedFirst ? "after" : "before"} the first sync)`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        if (connectedFirst) await a.sync();
        a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
        const e1 = a.store.createIssue({ title: "E1" });
        const e2 = a.store.createIssue({ title: "E2" });
        a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "a");
        const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
        // A second milestone nobody gives a member.
        a.store.milestones().create({ title: "Quiet", targetDate: "2027-01-01" }, "a");
        const quiet = (a.db.prepare("SELECT issue_id FROM milestone_meta WHERE issue_id <> ?").get(m) as { issue_id: string }).issue_id;
        await a.sync();
        const b = fleet.machine("b");
        await sync(b);

        a.use();
        await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
        const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
        a.store.milestones().addMember(m, e1.id, {}, "a");
        await sync(a, b);
        // b's own member add, not yet sent when the restore lands.
        if (unsent) b.store.milestones().addMember(m, e2.id, {}, "b");

        const revision = (machine: Machine, milestone = m): number =>
          (machine.db.prepare("SELECT members_revision FROM milestone_meta WHERE issue_id = ?").get(milestone) as { members_revision: number }).members_revision;
        const heldBefore = revision(b);
        const quietBefore = revision(b, quiet);

        a.use();
        await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
        await sync(a);
        // b rewinds, and its push after the read fails: its own list is still b's, not only once
        // the push lands.
        b.use();
        let read = false;
        const offline: typeof fetch = async (input, init) => {
          if (String(input).includes("/snapshot")) read = true;
          if (read && (init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
          return server.fetch(input, init);
        };
        await b.sync({ fetchImpl: offline, attempts: 1 } as never).catch(() => undefined);
        // (Staged with a list, as a seed sends it, the read applies that list until the push lands.)
        if (connectedFirst) expect(members(b, m)).toEqual(unsent ? [e1.id, e2.id] : []);
        await sync(b, a, b);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = stateOf(fresh.db);
        expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
        // Not merely agreeing: E1 went with the rewind, unless b's unsent membership — the whole
        // list b held, E1 and then E2 — says otherwise, and that list reached everyone.
        for (const machine of [a, b, fresh]) expect(members(machine, m), machine.label).toEqual(unsent ? [e1.id, e2.id] : []);
        // And an editor open on b sees its members change under it.
        if (!unsent) expect(revision(b)).toBeGreaterThan(heldBefore);
        // Staged with no membership, the quiet one is not touched by the rewind. (Staged with an
        // empty list, as a seed sends it, the read applies that list, and counts it as any apply.)
        if (connectedFirst) expect(revision(b, quiet)).toBe(quietBefore);
      }, 60_000);
    }
  }
});
