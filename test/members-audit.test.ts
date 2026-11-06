/**
 * Findings from a read-only audit of the member client, each pinned by a test that failed
 * before its fix: a rename that left tickets on the old name, a member-list refresh that
 * outlived a disconnect, and Ctrl-C during the read that collects the credential.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { readConnection, writeConnection } from "../src/core/cloud/connection.js";
import { performDisconnect } from "../src/core/cloud/connect.js";
import { buildJoinPreview } from "../src/core/cloud/join-preview.js";
import { performJoin } from "../src/core/cloud/join.js";
import { refreshMembersCache } from "../src/core/cloud/members.js";
import { membersCachePath } from "../src/core/cloud/members-cache.js";
import { reassignMember } from "../src/core/member-assignees.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
import { MembersServer, OWNER_DEVICE, OWNER_TOKEN, REPO_ID } from "./fixtures/fake-members-server.js";

const ENDPOINT = "https://sync.members.example";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-audit-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function connectAsOwner(): void {
  credentialStoreFor(home, "file").write(REPO_ID, OWNER_TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId: OWNER_DEVICE,
    label: "studio",
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 4,
  });
}

describe("a rename carries the member's tickets with it, on every device", () => {
  let fleet: Fleet;
  afterEach(() => fleet?.close());

  it("rewrites assignees from the old name to the new one, case-insensitively, through the journal", async () => {
    const server = new FakeSyncServer({ repositoryId: "0e77fa01-1111-4222-8333-444455556677" });
    fleet = new Fleet(server, "0e77fa01-1111-4222-8333-444455556677");
    const a = fleet.machine("a");
    const b = fleet.machine("b");

    a.use();
    const mine = a.store.createIssue({ title: "marko's ticket", assignee: "marko", createdBy: "vp" });
    const shouty = a.store.createIssue({ title: "same person, other case", assignee: "MARKO", createdBy: "vp" });
    const other = a.store.createIssue({ title: "someone else's", assignee: "markov", createdBy: "vp" });
    const done = a.store.createIssue({ title: "finished work", assignee: "marko", createdBy: "vp" });
    a.store.updateIssue(done.identifier, { status: "done" }, "vp");
    await a.sync();
    b.use();
    await b.sync();

    // The renaming device rewrites, and the change is an ordinary journaled edit.
    a.use();
    const changed = reassignMember(a.store, "marko", "Mark", "vp");
    expect(changed.sort()).toEqual([mine.identifier, shouty.identifier, done.identifier].sort());
    await a.sync();
    b.use();
    await b.sync();

    for (const machine of [a, b]) {
      machine.use();
      expect(machine.store.getIssue(mine.identifier).assignee).toBe("Mark");
      expect(machine.store.getIssue(shouty.identifier).assignee).toBe("Mark");
      expect(machine.store.getIssue(done.identifier).assignee).toBe("Mark");
      expect(machine.store.getIssue(other.identifier).assignee).toBe("markov");
    }
    // A second run finds nothing left to move.
    a.use();
    expect(reassignMember(a.store, "marko", "Mark", "vp")).toEqual([]);
  });
});

describe("a member-list refresh that finishes after a disconnect writes nothing", () => {
  it("does not recreate the cache the disconnect deleted", async () => {
    connectAsOwner();
    const server = new MembersServer();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      // The person disconnects while the list is on its way back.
      if (url.pathname.endsWith("/members")) performDisconnect(home, REPO_ID);
      return server.fetch(input, init);
    }) as typeof fetch;

    await refreshMembersCache(home, REPO_ID, { fetchImpl }).catch(() => undefined);
    expect(readConnection(home, REPO_ID)).toBeNull();
    expect(existsSync(membersCachePath(home, REPO_ID))).toBe(false);
  });
});

describe("Ctrl-C during the read that collects the credential", () => {
  it("reports what happened, joined, and never says cancelled about a stored credential", async () => {
    const server = new MembersServer();
    const controller = new AbortController();
    let code = "";
    let collecting = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (collecting && url.pathname.includes("/join-requests/")) controller.abort();
      return server.fetch(input, init);
    }) as typeof fetch;

    const outcome = await performJoin(
      buildJoinPreview({ home, repositoryId: REPO_ID, endpoint: ENDPOINT, endpointSource: "flag", label: "laptop", credential: { forceFile: true } }),
      {
        home,
        credential: { forceFile: true },
        fetchImpl,
        signal: controller.signal,
        now: () => server.now,
        onCode: (ticket) => (code = ticket.code),
        sleep: async () => {
          server.approve(code, { name: "buddy" });
          collecting = true;
        },
      },
    );
    // The credential arrived on the read Ctrl-C interrupted, so it is stored and said so.
    expect(outcome.status).toBe("joined");
    expect(readConnection(home, REPO_ID)).not.toBeNull();
  });
});
