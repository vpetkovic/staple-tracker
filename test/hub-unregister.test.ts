/**
 * STA-249 — removing a hub registration, as a library.
 *
 * `staple init` registered a workspace and nothing ever removed it, so every
 * scratch directory an agent initialised stayed in the machine registry forever.
 * This suite pins the two verbs that close that hole and, more importantly, the
 * three things they must NOT do:
 *
 *   1. never touch the workspace database or any file in the workspace directory
 *      (the registry is derived state; the workspace file is the real thing);
 *   2. never leave a cross-link pointing at a workspace that is no longer
 *      registered, because `crossBlockersOf` reads an unresolvable blocker as
 *      "blocked" and a dangling edge therefore wedges a live issue silently;
 *   3. never prune a row whose file is present.
 *
 * Every case runs against an isolated `STAPLE_HOME` — the pattern `hub.test.ts`
 * established. Nothing here can see, let alone modify, the real `~/.staple/hub.db`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hub, deleteHubRegistration } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-unreg-"));
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** A global workspace, opened and immediately closed — we only want it registered. */
function makeWorkspace(slug: string): { slug: string; prefix: string; dbPath: string } {
  const ws = initWorkspace({ global: true, slug });
  const summary = { slug: ws.store.slug, prefix: ws.store.prefix, dbPath: ws.dbPath };
  ws.store.db.close();
  return summary;
}

/**
 * Every file under `root`, with its size and mtime.
 *
 * This is the instrument for the safety guarantee. Comparing it across an
 * operation catches deletion, truncation, a move, AND an open-for-write that
 * "changed nothing" — `openDb` issues `PRAGMA journal_mode=WAL`, which rewrites
 * the file header and moves mtime even when no row is touched. A test that only
 * checked `existsSync` would pass while the database was being opened for
 * writing on every unregister.
 */
function digest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      out.push(`${relative(root, full)} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

function withHub<T>(fn: (hub: Hub) => T): T {
  const hub = Hub.open();
  try {
    return fn(hub);
  } finally {
    hub.close();
  }
}

// --------------------------------------------------------------- unregister

describe("Hub.unregister", () => {
  it("removes the row when addressed by slug", () => {
    makeWorkspace("scratch");
    makeWorkspace("keeper");

    const result = withHub((hub) => hub.unregister("scratch"));

    expect(result.workspace.slug).toBe("scratch");
    expect(result.prefixReleased).toBe("SCR");
    expect(result.removedCrossLinks).toEqual([]);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["keeper"]);
  });

  it("removes the row when addressed by prefix, in either case", () => {
    makeWorkspace("qdemo");
    makeWorkspace("rsix");

    expect(withHub((hub) => hub.unregister("QDE").workspace.slug)).toBe("qdemo");
    // `Hub.get` upper-cases the candidate, so a lowercase prefix is the same
    // address — an agent that copied a prefix out of prose still hits the row.
    expect(withHub((hub) => hub.unregister("rsi").workspace.slug)).toBe("rsix");
    expect(withHub((hub) => hub.list())).toEqual([]);
  });

  it("refuses an unknown slug or prefix with not_found and changes nothing", () => {
    makeWorkspace("present");

    for (const missing of ["absent", "ZZZ"]) {
      expect(() => withHub((hub) => hub.unregister(missing))).toThrowError(
        /is registered in the hub/,
      );
    }
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["present"]);
  });

  it("names `staple hub ls` in the not_found message, so the error is actionable", () => {
    makeWorkspace("present");
    expect(() => withHub((hub) => hub.unregister("absent"))).toThrowError(/staple hub ls/);
  });
});

// ------------------------------------------------------------- cross-links

describe("unregister and cross-workspace links", () => {
  /** Two workspaces, one issue each, one hub edge from `alpha` to `beta`. */
  function linkedPair(): { blocker: string; blocked: string } {
    const a = initWorkspace({ global: true, slug: "alpha" });
    const b = initWorkspace({ global: true, slug: "beta" });
    const gate = a.store.createIssue({ title: "API contract" });
    const consumer = b.store.createIssue({ title: "Use the API" });
    a.store.db.close();
    b.store.db.close();
    withHub((hub) => hub.addCrossLink(gate.identifier, consumer.identifier));
    return { blocker: gate.identifier, blocked: consumer.identifier };
  }

  it("refuses while a link names the workspace, and lists the links in the error", () => {
    const { blocker, blocked } = linkedPair();

    // The blocker side...
    expect(() => withHub((hub) => hub.unregister("alpha"))).toThrowError(
      new RegExp(`${blocker} blocks ${blocked}`),
    );
    // ...and the blocked side. A link is a fact about BOTH workspaces.
    expect(() => withHub((hub) => hub.unregister("beta"))).toThrowError(/cross-workspace link/);

    // A refusal is a read: the row and the edge both survive intact.
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["alpha", "beta"]);
    expect(withHub((hub) => hub.listCrossLinks())).toHaveLength(1);
  });

  it("points the refusal at the two ways out", () => {
    linkedPair();
    const attempt = () => withHub((hub) => hub.unregister("alpha"));
    expect(attempt).toThrowError(/staple hub unlink/);
    expect(attempt).toThrowError(/--with-links/);
  });

  it("cascades to the links when asked explicitly", () => {
    const { blocker, blocked } = linkedPair();

    const result = withHub((hub) => hub.unregister("alpha", { withLinks: true }));

    expect(result.removedCrossLinks).toEqual([
      { blockerWs: "alpha", blockerIdentifier: blocker, blockedWs: "beta", blockedIdentifier: blocked, type: "blocks" },
    ]);
    expect(withHub((hub) => hub.listCrossLinks())).toEqual([]);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["beta"]);
  });

  it("leaves no edge that would silently block a surviving issue", () => {
    const { blocked } = linkedPair();
    withHub((hub) => hub.unregister("alpha", { withLinks: true }));

    // The whole point of the cascade. Before it, `beta`'s issue had a blocker in
    // a workspace the hub no longer knows: `crossBlockersOf` would report it
    // unresolvable, which the readiness rule treats as BLOCKED — forever, with
    // no surface that explains why.
    expect(withHub((hub) => hub.crossBlockersOf(blocked))).toEqual([]);
  });

  it("reports the links it would remove without removing them", () => {
    const { blocker, blocked } = linkedPair();
    const preview = withHub((hub) => hub.previewUnregister("alpha"));

    expect(preview.entry.slug).toBe("alpha");
    expect(preview.crossLinks.map((l) => `${l.blockerIdentifier}>${l.blockedIdentifier}`)).toEqual([
      `${blocker}>${blocked}`,
    ]);
    expect(withHub((hub) => hub.listCrossLinks())).toHaveLength(1);
  });

  it("unregisters cleanly once the link has been removed one at a time", () => {
    const { blocker, blocked } = linkedPair();
    // `Hub.removeCrossLink` shipped with no caller on any surface. This is the
    // non-destructive way out of the refusal, and the reason it now has one.
    withHub((hub) => hub.removeCrossLink(blocker, blocked));
    expect(withHub((hub) => hub.unregister("alpha").removedCrossLinks)).toEqual([]);
  });
});

// ------------------------------------------------------------------- prune

describe("Hub.prune", () => {
  /** Register `slug`, then delete its database so the row is dead. */
  function makeDeadWorkspace(slug: string): string {
    const ws = makeWorkspace(slug);
    rmSync(ws.dbPath);
    rmSync(`${ws.dbPath}-wal`, { force: true });
    rmSync(`${ws.dbPath}-shm`, { force: true });
    return ws.dbPath;
  }

  it("previews without removing anything, and lists only the dead rows", () => {
    makeWorkspace("alive");
    makeDeadWorkspace("gone");

    const preview = withHub((hub) => hub.prune());

    expect(preview.dryRun).toBe(true);
    expect(preview.removed.map((r) => r.workspace.slug)).toEqual(["gone"]);
    expect(preview.skipped).toEqual([]);
    // The defining property of a preview.
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["alive", "gone"]);
  });

  it("removes the dead rows and keeps the live ones when applied", () => {
    makeWorkspace("alive");
    makeDeadWorkspace("gone");
    makeDeadWorkspace("alsogone");

    const result = withHub((hub) => hub.prune({ apply: true }));

    expect(result.dryRun).toBe(false);
    expect(result.removed.map((r) => r.workspace.slug).sort()).toEqual(["alsogone", "gone"]);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["alive"]);
  });

  it("is a no-op on a registry with nothing dead in it", () => {
    makeWorkspace("alive");
    const result = withHub((hub) => hub.prune({ apply: true }));
    expect(result.removed).toEqual([]);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["alive"]);
  });

  it("skips a dead row that still carries links, and removes the rest", () => {
    // `linked` is dead but cross-linked; `loose` is dead and unencumbered.
    const a = initWorkspace({ global: true, slug: "linked" });
    const b = initWorkspace({ global: true, slug: "survivor" });
    const gate = a.store.createIssue({ title: "gate" });
    const consumer = b.store.createIssue({ title: "consumer" });
    const deadPath = a.dbPath;
    a.store.db.close();
    b.store.db.close();
    withHub((hub) => hub.addCrossLink(gate.identifier, consumer.identifier));
    rmSync(deadPath);
    makeDeadWorkspace("loose");

    const result = withHub((hub) => hub.prune({ apply: true }));

    // Partial-tolerant by design: a sweep that aborted on the first encumbered
    // row would make one stubborn entry block every other cleanup forever.
    expect(result.removed.map((r) => r.workspace.slug)).toEqual(["loose"]);
    expect(result.skipped.map((s) => s.entry.slug)).toEqual(["linked"]);
    expect(result.skipped[0]!.blockedBy).toBe("cross_links");
    expect(result.skipped[0]!.crossLinks).toHaveLength(1);
    expect(withHub((hub) => hub.list().map((w) => w.slug)).sort()).toEqual(["linked", "survivor"]);
  });

  it("takes the encumbered row too when links are cascaded", () => {
    const a = initWorkspace({ global: true, slug: "linked" });
    const b = initWorkspace({ global: true, slug: "survivor" });
    const gate = a.store.createIssue({ title: "gate" });
    const consumer = b.store.createIssue({ title: "consumer" });
    const deadPath = a.dbPath;
    a.store.db.close();
    b.store.db.close();
    withHub((hub) => hub.addCrossLink(gate.identifier, consumer.identifier));
    rmSync(deadPath);

    const result = withHub((hub) => hub.prune({ apply: true, withLinks: true }));

    expect(result.removed.map((r) => r.workspace.slug)).toEqual(["linked"]);
    expect(result.skipped).toEqual([]);
    expect(withHub((hub) => hub.listCrossLinks())).toEqual([]);
  });

  /**
   * The trap this test exists to keep shut.
   *
   * `findRepointableRows` exists because this machine's hub holds paths spelled
   * `/var/...` for files whose realpath is `/private/var/...`, and comparing
   * those two STRINGS says "stale". It is tempting to make prune normalise the
   * path before deciding a row is dead. It must not: prune's question is
   * "does the file exist", `existsSync` follows symlinks, and both spellings
   * therefore answer yes. The spelling problem belongs to repair, which compares
   * paths; prune only ever asks the filesystem.
   *
   * A prune that normalised first and then compared spellings would delete a
   * live registration, which is the one outcome this command must never have.
   */
  it("does not touch a live row that is merely spelled the other way", () => {
    const ws = makeWorkspace("spelled");
    const otherSpelling = ws.dbPath.startsWith("/private/")
      ? ws.dbPath.slice("/private".length)
      : join("/private", ws.dbPath);
    // Only meaningful where the two spellings genuinely differ (macOS).
    if (otherSpelling === ws.dbPath || !existsSync(otherSpelling)) return;

    withHub((hub) => hub.repointPath({ slug: "spelled", prefix: ws.prefix, path: otherSpelling, kind: "global" }));
    expect(withHub((hub) => hub.list()[0]!.path)).toBe(otherSpelling);

    expect(withHub((hub) => hub.prune({ apply: true }).removed)).toEqual([]);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["spelled"]);
  });
});

// --------------------------------------------------------- prefix release

describe("prefix reallocation after unregistration", () => {
  it("frees the prefix for the next workspace that derives the same base", () => {
    const first = makeWorkspace("scratchpad");
    expect(first.prefix).toBe("SCR");
    // While SCR is held, the collision ladder pushes the next SCR-base slug down.
    expect(makeWorkspace("scribble").prefix).toBe("SCRA");

    withHub((hub) => hub.unregister("scratchpad"));

    // `allocatePrefix` reads the live `workspaces` table, so deleting the row is
    // all the bookkeeping a release needs — asserted rather than assumed.
    expect(withHub((hub) => hub.allocatePrefix("screen"))).toBe("SCR");
    expect(withHub((hub) => hub.slugHoldingPrefix("SCR"))).toBeUndefined();
    expect(makeWorkspace("screen").prefix).toBe("SCR");
  });

  it("lets a workspace re-register under the prefix stamped in its own database", () => {
    const ws = makeWorkspace("returning");
    withHub((hub) => hub.unregister("returning"));
    expect(withHub((hub) => hub.list())).toEqual([]);

    // The prefix lives in the workspace file, not the hub, so re-init restores
    // the original identity rather than minting a second one.
    const again = makeWorkspace("returning");
    expect(again.prefix).toBe(ws.prefix);
    expect(again.dbPath).toBe(ws.dbPath);
    expect(withHub((hub) => hub.list().map((w) => w.slug))).toEqual(["returning"]);
  });
});

// -------------------------------------------------------------- the safety

describe("unregistration never touches the workspace", () => {
  it("leaves every file under STAPLE_HOME/workspaces byte-for-byte and mtime identical", () => {
    makeWorkspace("untouched");
    makeWorkspace("bystander");
    const workspaces = join(home, "workspaces");
    const before = digest(workspaces);
    expect(before.length).toBeGreaterThan(0);

    withHub((hub) => hub.unregister("untouched"));

    // Not merely "the file is still there": identical size and mtime, which an
    // open-for-write would have moved even if it wrote no rows.
    expect(digest(workspaces)).toEqual(before);
  });

  it("leaves a repo workspace directory untouched, guide and gitignore included", () => {
    const repo = mkdtempSync(join(tmpdir(), "staple-unreg-repo-"));
    const ws = initWorkspace({ dir: repo, slug: "repows" });
    ws.store.db.close();
    const before = digest(repo);

    withHub((hub) => hub.unregister("repows"));

    expect(digest(repo)).toEqual(before);
    expect(existsSync(join(repo, ".staple", "staple.db"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * The structural half of the guarantee.
   *
   * `deleteHubRegistration` is handed the hub connection and a slug. It is given
   * no path, no `fs` module and no workspace opener, so "it cannot reach a
   * workspace file" is a property of its SIGNATURE — a future edit would have to
   * widen the parameter list before it could do damage, and that widening is a
   * visible diff. This test calls it directly, with no `Hub` around it.
   */
  it("is a pure hub-connection write: the free function has no path to reach a workspace with", () => {
    makeWorkspace("direct");
    const workspaces = join(home, "workspaces");
    const before = digest(workspaces);

    const hub = Hub.open();
    try {
      const removed = deleteHubRegistration(hub.db, "direct", { withLinks: false });
      expect(removed).toEqual([]);
      expect(hub.list()).toEqual([]);
    } finally {
      hub.close();
    }

    expect(digest(workspaces)).toEqual(before);
  });

  it("rolls back the row when the cascade guard refuses mid-transaction", () => {
    const a = initWorkspace({ global: true, slug: "guarded" });
    const b = initWorkspace({ global: true, slug: "other" });
    const gate = a.store.createIssue({ title: "gate" });
    const consumer = b.store.createIssue({ title: "consumer" });
    a.store.db.close();
    b.store.db.close();
    withHub((hub) => hub.addCrossLink(gate.identifier, consumer.identifier));

    const hub = Hub.open();
    try {
      expect(() => deleteHubRegistration(hub.db, "guarded", { withLinks: false })).toThrowError(
        /cross-workspace link/,
      );
      // One transaction: the refusal cannot leave the row deleted and the links
      // behind, which would be exactly the dangling state the guard prevents.
      expect(hub.list().map((w) => w.slug)).toEqual(["guarded", "other"]);
      expect(hub.listCrossLinks()).toHaveLength(1);
    } finally {
      hub.close();
    }
  });
});
