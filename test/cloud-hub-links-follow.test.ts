/**
 * A hub cross-link follows the issue it names when that issue's identifier moves.
 *
 * Cross-links name each end by identifier (`cross_links`, and the registry's link key), so
 * every renumber — sync settling two devices' claims on one number, a joining workspace
 * yielding the numbers its repository already uses, a conflict resolution moving an
 * incumbent aside — used to leave the link naming the old number: nothing, or whichever
 * issue took the number next.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { REGISTRY_PAYLOAD_FORMAT, adoptRegistry } from "../src/core/cloud/hub-registry.js";
import { initWorkspace } from "../src/core/workspace.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000f6";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

/** A second workspace on the same machine, with an issue a link can point at. */
function otherWorkspace(machine: Machine): string {
  machine.use();
  const dir = join(machine.dir, "..", "other");
  mkdirSync(join(dir, ".staple"), { recursive: true });
  writeFileSync(
    join(dir, ".staple", "repository.json"),
    `${JSON.stringify({ repositoryId: randomUUID(), format: 1 }, null, 2)}\n`,
  );
  const ws = initWorkspace({ dir, slug: "other" });
  const issue = ws.store.createIssue({ title: "Waits on the tracker" });
  ws.store.createIssue({ title: "Also waits on the tracker" });
  ws.store.db.close();
  return issue.identifier;
}

function links(machine: Machine): Array<{ blocker: string; blocked: string }> {
  const hub = Hub.openAt(machine.home);
  try {
    return hub.crossLinksFor("tracker").map((link) => ({ blocker: link.blockerIdentifier, blocked: link.blockedIdentifier }));
  } finally {
    hub.close();
  }
}

function changes(machine: Machine): Array<{ blocker: string; present: boolean }> {
  const hub = Hub.openAt(machine.home);
  try {
    return hub.listCrossLinkChanges().map((change) => ({ blocker: change.blockerIdentifier, present: change.present }));
  } finally {
    hub.close();
  }
}

function link(machine: Machine, blocker: string, blocked: string): void {
  const hub = Hub.openAt(machine.home);
  try {
    hub.addCrossLink(blocker, blocked);
  } finally {
    hub.close();
  }
}

function identifierOf(db: DatabaseSync, id: string): string {
  return (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string }).identifier;
}

describe("hub cross-links follow a renumbered issue", () => {
  it("when sync renumbers this device's issue because another device claimed its number first", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "Base" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const other = otherWorkspace(b);

    a.store.createIssue({ title: "A's second" });
    const mine = b.store.createIssue({ title: "B's second" });
    expect(mine.identifier).toBe("TRA-2");
    link(b, "TRA-2", other);
    await a.sync();
    await b.sync();

    const settled = identifierOf(b.db, mine.id);
    expect(settled).not.toBe("TRA-2");
    expect(links(b)).toEqual([{ blocker: settled, blocked: other }]);
    // And the registry learns both halves: the old key retracted, the new one linked.
    expect(changes(b)).toEqual(
      expect.arrayContaining([
        { blocker: "TRA-2", present: false },
        { blocker: settled, present: true },
      ]),
    );

    // A link made AFTER the move that names TRA-2 means the issue that holds TRA-2 now,
    // and a later move of a different issue does not touch it.
    link(b, "TRA-2", other);
    await b.sync();
    expect(links(b)).toEqual(expect.arrayContaining([{ blocker: "TRA-2", blocked: other }, { blocker: settled, blocked: other }]));
  });

  it("but a link made after the move, carried to the hub late, keeps the issue that holds the number now", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const moved = a.store.createIssue({ title: "Moves" });
    const other = otherWorkspace(a);
    const { moveIdentifier, pendingIdentifierMoves } = await import("../src/core/identifier-moves.js");
    const { carryIdentifierMovesToHub } = await import("../src/core/hub-follow.js");
    link(a, "TRA-1", other);
    // First an ordinary move, carried to the hub at once: the link follows it.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    moveIdentifier(a.db, moved.id, "TRA-7");
    expect(pendingIdentifierMoves(a.db)).toHaveLength(1);
    carryIdentifierMovesToHub(a.db, a.home);
    expect(links(a)).toEqual([{ blocker: "TRA-7", blocked: other }]);

    // Then a move the hub is not reached for (busy process, locked hub); meanwhile another
    // issue takes TRA-7 and somebody links THAT. When the move is carried late, only the
    // link made before it follows.
    await tick();
    moveIdentifier(a.db, moved.id, "TRA-8");
    await tick();
    const fresh = a.store.createIssue({ title: "Someone else's, made later" });
    a.db.prepare("UPDATE issues SET identifier = 'TRA-7' WHERE id = ?").run(fresh.id);
    const second = other.replace(/-(\d+)$/, (_, n: string) => `-${Number(n) + 1}`);
    link(a, "TRA-7", second);
    carryIdentifierMovesToHub(a.db, a.home);
    // The link made before the second move followed it; the one made after it stayed.
    expect(links(a)).toEqual(
      expect.arrayContaining([
        { blocker: "TRA-8", blocked: other },
        { blocker: "TRA-7", blocked: second },
      ]),
    );
    expect(links(a)).toHaveLength(2);
  });

  it("when a joining workspace yields a number its repository already uses", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "The repository's TRA-1" });
    await a.sync();

    const c = fleet.connect("c", fleet.prepare("c"));
    const own = c.store.createIssue({ title: "C's own, from before joining" });
    const other = otherWorkspace(c);
    link(c, "TRA-1", other);
    await c.sync();

    const settled = identifierOf(c.db, own.id);
    expect(settled).not.toBe("TRA-1");
    expect(links(c)).toEqual([{ blocker: settled, blocked: other }]);
  });

  it("when a person resolves an identifier conflict and the incumbent moves aside", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "Base" });
    await a.sync();
    const mine = a.store.createIssue({ title: "A's second" });
    await a.sync();
    const other = otherWorkspace(a);
    link(a, "TRA-2", other);

    // A device on an older build pushes its own TRA-2, and never renumbers it.
    const sent = a.db
      .prepare("SELECT payload FROM sync_outbox WHERE entity = 'issue' AND entity_id = ? AND verb = 'create'")
      .get(mine.id) as { payload: string };
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    await new OlderBuildDevice(server, REPO, "device-old", schema).push([
      { entity: "issue", entityId: randomUUID(), verb: "create", payload: { ...JSON.parse(sent.payload), title: "Old build's second" } },
    ]);
    await a.sync();
    expect(links(a)).toEqual([{ blocker: "TRA-2", blocked: other }]);

    const conflict = listConflicts(a.db).find((candidate) => candidate.resolvedAt === null)!;
    a.use();
    resolveConflict(a.db, { id: conflict.id, choice: "remote", actor: "vp" });
    const moved = identifierOf(a.db, mine.id);
    expect(moved).not.toBe("TRA-2");
    expect(links(a)).toEqual([{ blocker: moved, blocked: other }]);
  });
});

/**
 * A link made through a stand-in names the issue, not the stand-in.
 *
 * `staple link TRA-2+1 OTH-1` stored `TRA-2+1` verbatim: every reader keyed on the issue's
 * current identifier (`crossBlockersOf`, `get_task`, the UI's detail) found no blocker on
 * it, so it read as ready to pick up; and the next issue to collide on TRA-2 was handed
 * the same stand-in string, the link followed THAT issue's renumber, and `TRA-2+1` began
 * to find it. The link is stored under the issue's current identifier, and a stand-in is
 * never handed out twice.
 */
describe("a hub link made through a stand-in", () => {
  it("stays on the issue it was made on when another device collides on the same number", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const c = fleet.machine("c");
    await c.sync();
    const other = otherWorkspace(a);

    a.store.createIssue({ title: "TRA-2, on A" });
    const onB = b.store.createIssue({ title: "TRA-2, on B" });
    const onC = c.store.createIssue({ title: "TRA-2, on C" });
    await a.sync();
    await b.sync();
    await a.sync();
    // A met B's issue under a stand-in, and links through it.
    a.use();
    expect(a.store.getIssue("TRA-2+1").id).toBe(onB.id);
    link(a, "TRA-2+1", other);
    const settledB = identifierOf(a.db, onB.id);
    expect(links(a)).toEqual([{ blocker: settledB, blocked: other }]);

    await c.sync();
    await a.sync();
    a.use();
    // Still B's issue, under the number B settled on — not C's, however C's claim lands here.
    expect(identifierOf(a.db, onB.id)).toBe(settledB);
    expect(links(a)).toEqual([{ blocker: settledB, blocked: other }]);
    expect(a.store.getIssue("TRA-2+1").id).toBe(onB.id);
    expect(identifierOf(a.db, onC.id)).not.toBe(settledB);

    // A link published by another machine under a stand-in: placed here under the issue it
    // finds, or — when it finds none — skipped for that reason, not for a prefix.
    const hub = Hub.openAt(a.home);
    try {
      const trackerRepo = hub.findBySlug("tracker")!.repositoryId!;
      const otherRepo = hub.findBySlug("other")!.repositoryId!;
      const published = (blockerIdentifier: string) => ({
        blockerRepositoryId: trackerRepo,
        blockerWs: "tracker",
        blockerIdentifier,
        blockedRepositoryId: otherRepo,
        blockedWs: "other",
        blockedIdentifier: "OTH-2",
        type: "blocks" as const,
      });
      const report = adoptRegistry(
        hub,
        {
          format: REGISTRY_PAYLOAD_FORMAT,
          hubId: "another-machine",
          capturedAt: "2026-09-11T00:00:00.000Z",
          workspaces: [],
          crossLinks: [published("TRA-2+1"), published("TRA-9+1")],
        },
        { apply: true },
      );
      const reasons = report.crossLinkDecisions.map((decision) => decision.reason ?? decision.outcome).join("\n");
      expect(reasons).toContain("TRA-9+1, is a stand-in another machine used");
      expect(reasons).not.toContain("initialised here separately");
      expect(hub.crossLinksFor("tracker").map((link) => link.blockerIdentifier)).toContain(settledB);
      // And unlinking through the stand-in removes the link stored under the settled number.
      expect(hub.removeCrossLink("TRA-2+1", other)).toEqual(expect.objectContaining({ blockerIdentifier: settledB }));
    } finally {
      hub.close();
    }
    expect(links(a).filter((row) => row.blocked === other)).toEqual([]);
  });
});
