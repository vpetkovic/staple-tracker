/**
 * The registry as a portable set: what leaves, what does not, and every way
 * adoption is allowed to refuse.
 *
 * The tests that matter most here are the refusals. Adopting correctly is the
 * easy half; the half that ruins a machine is adopting something you should have
 * declined, and each of those has its own case below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateHub } from "../src/core/schema.js";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import {
  HUB_BACKUP_HEADLINE,
  REGISTRY_PAYLOAD_FORMAT,
  adoptRegistry,
  describeAdoption,
  exportRegistry,
  locateAbsent,
  type HubRegistryPayload,
} from "../src/core/cloud/hub-registry.js";

/**
 * A hub on disk, opened through the same constructor production uses.
 *
 * `Hub` has a private constructor and `Hub.open()` reads the real staple home,
 * so the seam is the home itself — set per test, torn down after. Using the real
 * opener rather than hand-rolling a DatabaseSync is deliberate: it means these
 * tests exercise the migration path, so a hub 003 that failed to apply would
 * fail here rather than somewhere further away.
 */
let dir: string;
let previousHome: string | undefined;

function openHub(): Hub {
  return Hub.open();
}

/** Register a workspace with a real file behind it, so `available` is true. */
function seed(
  hub: Hub,
  slug: string,
  prefix: string,
  repositoryId: string | null,
): string {
  const wsDir = join(dir, "ws", slug);
  mkdirSync(wsDir, { recursive: true });
  const dbPath = join(wsDir, "staple.db");
  writeFileSync(dbPath, "");
  hub.register({ slug, prefix, path: dbPath, kind: "repo" });
  if (repositoryId !== null) hub.recordRepositoryId(slug, repositoryId);
  return dbPath;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "staple-hub-registry-"));
  previousHome = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = dir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("what a hub backup contains", () => {
  it("carries the set, and no path anywhere in it", () => {
    const hub = openHub();
    const dbPath = seed(hub, "api", "API", "repo-api");
    seed(hub, "web", "WEB", "repo-web");
    const payload = exportRegistry(hub);
    hub.close();

    expect(payload.workspaces.map((w) => w.slug).sort()).toEqual(["api", "web"]);
    expect(payload.workspaces[0]).not.toHaveProperty("path");

    // The real assertion is not "the field is absent from the type" — the
    // compiler already says that — but that the serialized payload a service
    // would receive contains no absolute path anywhere, including somewhere
    // nobody thought to look.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(dbPath);
    expect(wire).not.toContain(dir);
    expect(wire).not.toContain("/");
  });

  it("omits lastSeenAt, which is an observation about this machine's disk", () => {
    const hub = openHub();
    seed(hub, "api", "API", "repo-api");
    const payload = exportRegistry(hub);
    hub.close();
    expect(payload.workspaces[0]).not.toHaveProperty("lastSeenAt");
  });

  it("says in one sentence that it does not contain tasks", () => {
    // A user will assume "back up the hub" covers their work. It does not, and
    // the sentence that says so is pinned so it cannot quietly soften.
    expect(HUB_BACKUP_HEADLINE).toContain("does not contain any tasks");
  });

  it("gives the hub a stable identity, minted once", () => {
    const hub = openHub();
    const first = hub.hubId();
    const second = hub.hubId();
    hub.close();
    const reopened = openHub();
    const afterReopen = reopened.hubId();
    reopened.close();
    expect(second).toBe(first);
    expect(afterReopen).toBe(first);
  });
});

describe("adoption matches by identity rather than minting a second registration", () => {
  function payloadOf(entries: HubRegistryPayload["workspaces"]): HubRegistryPayload {
    return {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "hub-elsewhere",
      capturedAt: "2026-01-01T00:00:00.000Z",
      workspaces: entries,
      crossLinks: [],
    };
  }

  it("recognises a workspace it already has, under a different local name", () => {
    const hub = openHub();
    seed(hub, "api-local", "API", "repo-api");
    const report = adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-api", slug: "api", prefix: "API", kind: "repo", addedAt: "x" },
      ]),
      { apply: true },
    );
    const rows = hub.list();
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("adopted");
    expect(report.decisions[0]!.localSlug).toBe("api-local");
    // The whole point: ONE row, still under this machine's name.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("api-local");
  });

  it("adds a row with no path for a workspace that is not here, and invents nothing", () => {
    const hub = openHub();
    adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
      ]),
      { apply: true },
    );
    const row = hub.get("web")!;
    hub.close();

    expect(row.path).toBe("");
    expect(row.available).toBe(false);
    expect(row.repositoryId).toBe("repo-web");
  });

  /**
   * The copy already on disk is matched by the IDENTITY COLUMN, and by nothing else.
   *
   * This replaces a test that proved a `repointed` outcome by passing `adoptRegistry` a
   * `locate` callback. That callback was the only way to reach the outcome and no surface
   * ever supplied one, so the test proved a capability the product did not have — the
   * exact shape this epic has been bitten by. Both are gone.
   *
   * What actually makes a clone on this machine match is `reconcileRepositoryIds`, which
   * `adoptPublishedRegistry` runs BEFORE adopting. So the two states worth pinning are
   * the one where the column is filled (matches) and the one where it is not (parks, and
   * says something performable).
   */
  it("matches a copy on disk once its identity is recorded, without registering it twice", () => {
    const hub = openHub();
    seed(hub, "api", "API", "repo-api");
    const report = adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-api", slug: "api", prefix: "API", kind: "repo", addedAt: "x" },
      ]),
      { apply: true },
    );
    const rows = hub.list();
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("current");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repositoryId).toBe("repo-api");
  });

  it("parks a copy whose identity is NOT recorded, and names verbs that exist", () => {
    const hub = openHub();
    // The state a machine is in before `reconcileRepositoryIds` has run: the workspace is
    // here, holding the prefix, but the hub does not know what it calls itself.
    seed(hub, "api", "API", null);
    const report = adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-api", slug: "api", prefix: "API", kind: "repo", addedAt: "x" },
      ]),
      { apply: true },
    );
    const rows = hub.list();
    hub.close();

    // Parked, not renumbered and not duplicated — the local stamp is untouchable.
    expect(report.decisions[0]!.outcome).toBe("conflict");
    expect(rows).toHaveLength(1);
    const reason = report.decisions[0]!.reason;
    expect(reason).toContain("staple hub registry ignore repo-api");
    expect(reason).toContain("staple hub unregister api");
    // The remedy that used to be here named an operation the product does not have.
    expect(reason).not.toContain("Re-stamp");
  });

  it("has no outcome that only a test can produce", () => {
    // `repointed` was reachable solely through an `AdoptOptions.locate` callback that no
    // surface supplied. An advertised outcome the product cannot reach is a promise to
    // whoever reads the type, so both the outcome and the hook are gone.
    const hub = openHub();
    seed(hub, "api", "API", "repo-api");
    const report = adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-api", slug: "api", prefix: "API", kind: "repo", addedAt: "x" },
      ]),
    );
    hub.close();
    expect(report.decisions.map((d) => d.outcome)).not.toContain("repointed");
    expect(describeAdoption(report)).not.toContain("re-pointed");
  });
});

describe("BREAK: a prefix collision must park, not renumber and not abort", () => {
  it("keeps the local stamp, refuses the incoming entry, and still adopts the rest", () => {
    const hub = openHub();
    seed(hub, "quoted", "QDE", "repo-quoted"); // this machine's QDE

    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [
          // A DIFFERENT repository that also ended up with QDE.
          { repositoryId: "repo-quest", slug: "quest", prefix: "QDE", kind: "repo", addedAt: "x" },
          { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    const rows = hub.list();
    hub.close();

    const collided = report.decisions.find((d) => d.entry.slug === "quest")!;
    expect(collided.outcome).toBe("conflict");
    expect(collided.conflict).toEqual({
      field: "prefix",
      value: "QDE",
      heldBySlug: "quoted",
      heldByRepositoryId: "repo-quoted",
    });
    // Says both names and the prefix, and does not offer to renumber.
    expect(collided.reason).toContain("quoted");
    expect(collided.reason).toContain("QDE-N");

    // Nothing was renumbered, and the colliding row was not added.
    expect(rows.find((r) => r.slug === "quoted")!.prefix).toBe("QDE");
    expect(rows.find((r) => r.slug === "quest")).toBeUndefined();
    // One bad row did not block the good one.
    expect(rows.find((r) => r.slug === "web")).toBeDefined();
  });
});

describe("BREAK: unregister is local, and must stay undone across an adoption", () => {
  it("does not bring back a workspace this machine removed", () => {
    const hub = openHub();
    seed(hub, "scratch", "SCR", "repo-scratch");
    hub.unregister("scratch");
    expect(hub.get("scratch")).toBeUndefined();

    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [
          { repositoryId: "repo-scratch", slug: "scratch", prefix: "SCR", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    const rows = hub.list();
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("declined");
    expect(rows).toHaveLength(0);
  });

  it("can be undone deliberately, which is what makes the removal safe to offer", () => {
    const hub = openHub();
    seed(hub, "scratch", "SCR", "repo-scratch");
    hub.unregister("scratch");
    expect(hub.clearOptOut("repo-scratch")).toBe(true);

    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [
          { repositoryId: "repo-scratch", slug: "scratch", prefix: "SCR", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    hub.close();
    expect(report.decisions[0]!.outcome).toBe("absent");
  });
});

describe("BREAK: adoption must never delete a local row", () => {
  it("leaves a workspace the incoming set has never heard of exactly where it is", () => {
    const hub = openHub();
    seed(hub, "only-here", "ONL", "repo-only");
    adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [],
        crossLinks: [],
      },
      { apply: true },
    );
    const rows = hub.list();
    hub.close();
    // The incoming set is another machine's knowledge, not an instruction about
    // what this machine should stop having.
    expect(rows.map((r) => r.slug)).toEqual(["only-here"]);
  });
});

describe("BREAK: locate must refuse a directory that is a different repository", () => {
  it("refuses on identity mismatch and changes nothing", () => {
    const hub = openHub();
    adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "h",
        capturedAt: "x",
        workspaces: [
          { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );

    expect(() =>
      locateAbsent(hub, "web", {
        path: join(dir, "elsewhere", "staple.db"),
        prefix: "WEB",
        repositoryId: "repo-something-else",
      }),
    ).toThrow(/different repository/);

    const row = hub.get("web")!;
    hub.close();
    expect(row.path).toBe("");
  });

  it("refuses a candidate stamped with a different prefix", () => {
    const hub = openHub();
    adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "h",
        capturedAt: "x",
        workspaces: [
          { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    expect(() =>
      locateAbsent(hub, "web", {
        path: join(dir, "elsewhere", "staple.db"),
        prefix: "WBB",
        repositoryId: "repo-web",
      }),
    ).toThrow(/will not renumber/);
    hub.close();
  });

  it("attaches when the identity matches", () => {
    const hub = openHub();
    adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "h",
        capturedAt: "x",
        workspaces: [
          { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    const wsDir = join(dir, "found");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "staple.db");
    writeFileSync(dbPath, "");

    const row = locateAbsent(hub, "web", { path: dbPath, prefix: "WEB", repositoryId: "repo-web" });
    hub.close();
    expect(row.available).toBe(true);
  });
});

describe("BREAK: a payload from a newer build must be refused, not partially believed", () => {
  it("refuses a higher format number", () => {
    const hub = openHub();
    expect(() =>
      adoptRegistry(hub, {
        format: REGISTRY_PAYLOAD_FORMAT + 1,
        hubId: "h",
        capturedAt: "x",
        workspaces: [],
        crossLinks: [],
      }),
    ).toThrow(/Upgrade staple/);
    hub.close();
  });
});

describe("previewing writes nothing", () => {
  it("reports what it would do and leaves the registry alone", () => {
    const hub = openHub();
    const report = adoptRegistry(hub, {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "h",
      capturedAt: "x",
      workspaces: [
        { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
      ],
      crossLinks: [],
    });
    const rows = hub.list();
    hub.close();
    expect(report.dryRun).toBe(true);
    expect(report.decisions[0]!.outcome).toBe("absent");
    expect(rows).toHaveLength(0);
    expect(describeAdoption(report)).toContain("Nothing was written");
  });
});

describe("cross-links only land between workspaces this machine now has", () => {
  it("skips an edge whose other end did not arrive", () => {
    const hub = openHub();
    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "h",
        capturedAt: "x",
        workspaces: [
          { repositoryId: "repo-web", slug: "web", prefix: "WEB", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [
          {
            blockerRepositoryId: "repo-api",
            blockerWs: "api",
            blockerIdentifier: "API-1",
            blockedRepositoryId: "repo-web",
            blockedWs: "web",
            blockedIdentifier: "WEB-1",
            type: "blocks",
          },
        ],
      },
      { apply: true },
    );
    const links = hub.listCrossLinks();
    hub.close();
    // An imported edge naming an absent workspace reads as an unresolvable
    // blocker, and unresolvable counts as BLOCKED — it would wedge WEB-1 with
    // nothing on any surface to say why.
    expect(report.crossLinks).toMatchObject({ added: 0, skipped: 1 });
    expect(links).toEqual([]);
    // And the report says which end is missing, by the name the registry uses for it.
    expect(report.crossLinkDecisions[0]!.reason).toContain('the blocker end, "api"');
  });

  it("matches each end BY IDENTITY, so a link lands between this machine's own names", () => {
    const hub = openHub();
    hub.registerAbsent({ slug: "api-here", prefix: "API", kind: "repo", repositoryId: "repo-api" });
    hub.registerAbsent({ slug: "web-here", prefix: "WEB", kind: "repo", repositoryId: "repo-web" });
    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "h",
        capturedAt: "x",
        workspaces: [],
        crossLinks: [
          {
            blockerRepositoryId: "repo-api",
            blockerWs: "api",
            blockerIdentifier: "API-1",
            blockedRepositoryId: "repo-web",
            blockedWs: "web",
            blockedIdentifier: "WEB-1",
            type: "blocks",
          },
        ],
      },
      { apply: true },
    );
    const links = hub.listCrossLinks().map((l) => `${l.blockerWs}/${l.blockerIdentifier} -> ${l.blockedWs}/${l.blockedIdentifier}`);
    // An adopted link is not a change this machine made, so it records none.
    const changes = hub.listCrossLinkChanges();
    hub.close();
    expect(report.crossLinks).toMatchObject({ added: 1, skipped: 0 });
    expect(links).toEqual(["api-here/API-1 -> web-here/WEB-1"]);
    expect(changes).toEqual([]);
  });

  it("refuses an identifier that does not exist in the local workspace, and says so", () => {
    /**
     * A real workspace, so the apply's identifier check runs. The registry names WEB-9 and
     * this machine's `web` has no WEB-9. The preview runs the same check, so it agrees.
     */
    const hub = openHub();
    const web = join(dir, "web");
    mkdirSync(web, { recursive: true });
    const opened = initWorkspace({ dir: web, slug: "web", kind: "repo" });
    const webId = opened.repository.repositoryId;
    opened.store.db.close();
    const webPrefix = hub.get("web")!.prefix;
    hub.registerAbsent({ slug: "api", prefix: "API", kind: "repo", repositoryId: "repo-api" });
    const payload: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "h",
      capturedAt: "x",
      workspaces: [],
      crossLinks: [
        {
          blockerRepositoryId: "repo-api",
          blockerWs: "api",
          blockerIdentifier: "API-1",
          blockedRepositoryId: webId,
          blockedWs: "web",
          blockedIdentifier: `${webPrefix}-9`,
          type: "blocks",
        },
      ],
    };
    const preview = adoptRegistry(hub, payload);
    const applied = adoptRegistry(hub, payload, { apply: true });
    const links = hub.listCrossLinks();
    hub.close();
    expect(preview.crossLinkDecisions.map((d) => d.outcome)).toEqual(["skipped"]);
    expect(applied.crossLinkDecisions.map((d) => d.outcome)).toEqual(["skipped"]);
    expect(applied.crossLinkDecisions[0]!.reason).toContain(`${webPrefix}-9`);
    expect(links).toEqual([]);
  });
});

/**
 * BREAK: an opt-out must not outlive the row it was about.
 *
 * `registry_optouts` records "this machine does not want that identity back", and
 * nothing in the tree ever cleared one. That is fine while the workspace stays
 * gone, and wrong the moment it comes back: the row is present and current, and
 * adoption still declined it — for ever, invisibly, because `decide` asked the
 * opt-out set before it asked the hub.
 *
 * The damage is not only the wrong `declined` label. A declined entry never reaches
 * the `learned` branch, so a workspace with a stale opt-out could never pick up a
 * slug or kind change from the registry either — which is the divergence this epic
 * chose to REPORT rather than refuse, silently disabled for exactly those rows.
 */
describe("BREAK: a returning workspace must not stay declined for ever", () => {
  it("prefers the live local row over a stale opt-out, and clears the contradiction", () => {
    const hub = openHub();
    const dbPath = seed(hub, "doomed", "DOO", "repo-doomed");
    // Prune only touches rows whose path is gone, so take the file away first.
    rmSync(dbPath, { force: true });
    const pruned = hub.prune({ apply: true });
    expect(pruned.removed.map((r) => r.workspace.slug)).toEqual(["doomed"]);
    expect(hub.listOptOuts().map((o) => o.reason)).toEqual(["pruned"]);

    // The workspace legitimately comes back: same identity, same name.
    seed(hub, "doomed", "DOO", "repo-doomed");

    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [
          { repositoryId: "repo-doomed", slug: "doomed", prefix: "DOO", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    const remaining = hub.listOptOuts();
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("current");
    // And the contradiction is gone, rather than being stepped over every adopt.
    expect(remaining).toEqual([]);
  });

  it("still declines when the row really is absent, which is the property opt-out exists for", () => {
    const hub = openHub();
    seed(hub, "scratch", "SCR", "repo-scratch");
    hub.unregister("scratch");

    const report = adoptRegistry(
      hub,
      {
        format: REGISTRY_PAYLOAD_FORMAT,
        hubId: "hub-elsewhere",
        capturedAt: "2026-01-01T00:00:00.000Z",
        workspaces: [
          { repositoryId: "repo-scratch", slug: "scratch", prefix: "SCR", kind: "repo", addedAt: "x" },
        ],
        crossLinks: [],
      },
      { apply: true },
    );
    const remaining = hub.listOptOuts().map((o) => o.repositoryId);
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("declined");
    // Not cleared: there is no local row, so nothing contradicts it.
    expect(remaining).toEqual(["repo-scratch"]);
  });

  it("names a verb that exists when it declines", () => {
    const hub = openHub();
    seed(hub, "scratch", "SCR", "repo-scratch");
    hub.unregister("scratch");
    const report = adoptRegistry(hub, {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "hub-elsewhere",
      capturedAt: "2026-01-01T00:00:00.000Z",
      workspaces: [
        { repositoryId: "repo-scratch", slug: "scratch", prefix: "SCR", kind: "repo", addedAt: "x" },
      ],
      crossLinks: [],
    });
    hub.close();
    const reason = report.decisions[0]!.reason;
    // The remedy has to be something a CLI user can type. `Hub.clearOptOut` is not.
    expect(reason).toContain("staple hub registry unignore repo-scratch");
    expect(reason).not.toContain("clearOptOut");
    expect(reason).not.toContain("no CLI verb");
  });

  it("clears the opt-out when a workspace re-records its identity, not only on adopt", () => {
    const hub = openHub();
    seed(hub, "back", "BAK", "repo-back");
    hub.unregister("back");
    expect(hub.listOptOuts()).toHaveLength(1);

    // What `initWorkspace` does on the next command run inside that repository.
    hub.register({
      slug: "back",
      prefix: "BAK",
      path: join(dir, "ws", "back", "staple.db"),
      kind: "repo",
    });
    hub.recordRepositoryId("back", "repo-back");
    const remaining = hub.listOptOuts();
    hub.close();

    expect(remaining).toEqual([]);
  });
});

/**
 * BREAK: the last step of restoring a machine — getting the repositories back.
 *
 * Adoption lands a PLACEHOLDER row per listed workspace: real slug, real prefix, real
 * identity, no database. The person then clones the repository, and a clone carries the
 * TRACKED `.staple/repository.json` and NOT the gitignored database — so `staple init` is
 * what turns the placeholder into a live workspace.
 *
 * Both ways of trying that used to fail, and this was the acceptance criterion's own last
 * step. Measured against a real Worker, not reasoned about:
 *
 *   - same-named clone: `allocatePrefix("website")` saw WEB held by the placeholder,
 *     returned WEBA, and `register` refused —
 *     `error(conflict): Workspace "website" is registered with prefix WEB, not WEBA`.
 *   - differently-named clone: init minted prefix TRAA as a THIRD row, leaving `tracker`
 *     (no database) beside `tracker-checkout` (the real one) for ONE repository — a
 *     duplicated identity, which publishing then correctly parks and refuses to send.
 *
 * `staple hub registry locate` cannot cover this either: it repoints an EXISTING database
 * and a fresh clone has none. So the placeholder was unreachable by any performable route.
 */
describe("BREAK: a clone must take the registry row that already describes it", () => {
  // Real lower-case UUIDs: `.staple/repository.json` is validated, not just parsed.
  const TRACKER_ID = "3f2a91c4-5d6e-4a7b-8c9d-0e1f2a3b4c5d";
  const WEB_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  /** A clone as git leaves it: the tracked manifest, and no database. */
  function cloneDir(name: string, repositoryId: string): string {
    const dir = join(dir_(), "clones", name);
    mkdirSync(join(dir, ".staple"), { recursive: true });
    writeFileSync(
      join(dir, ".staple", "repository.json"),
      JSON.stringify({ repositoryId, format: 1 }, null, 2),
    );
    return dir;
  }
  // `dir` is the per-test temp home; wrapped so the helper above reads it lazily.
  function dir_(): string {
    return dir;
  }

  it("takes the placeholder's slug AND prefix, even from a differently named directory", () => {
    const hub = openHub();
    hub.registerAbsent({ slug: "tracker", prefix: "TRA", kind: "repo", repositoryId: TRACKER_ID });
    hub.close();

    const clone = cloneDir("tracker-checkout", TRACKER_ID);
    initWorkspace({ dir: clone, gitignore: false }).store.db.close();

    const after = openHub();
    const rows = after.list();
    after.close();

    // ONE row, not two: the placeholder became the live workspace.
    expect(rows).toHaveLength(1);
    expect({ slug: rows[0]!.slug, prefix: rows[0]!.prefix, available: rows[0]!.available }).toEqual({
      slug: "tracker",
      prefix: "TRA",
      available: true,
    });
    // The prefix is the load-bearing half: every TRA-N ever written stays resolvable.
    expect(rows[0]!.repositoryId).toBe(TRACKER_ID);
  });

  it("takes the placeholder's prefix when the names already agree", () => {
    const hub = openHub();
    hub.registerAbsent({ slug: "website", prefix: "WEB", kind: "repo", repositoryId: WEB_ID });
    hub.close();

    const clone = cloneDir("website", WEB_ID);
    initWorkspace({ dir: clone, gitignore: false }).store.db.close();

    const after = openHub();
    const rows = after.list();
    after.close();
    // Used to be `error(conflict): Workspace "website" is registered with prefix WEB, not WEBA`.
    expect(rows.map((r) => `${r.slug}/${r.prefix}`)).toEqual(["website/WEB"]);
  });

  it("does NOT touch a row whose database is present — a second live clone is still a duplicate", () => {
    const hub = openHub();
    // A live row, not a placeholder: it has a real path.
    seed(hub, "tracker", "TRA", TRACKER_ID);
    hub.close();

    const clone = cloneDir("tracker-two", TRACKER_ID);
    initWorkspace({ dir: clone, gitignore: false }).store.db.close();

    const after = openHub();
    const rows = after.list();
    after.close();
    // Two rows sharing an identity, which `diffRegistry` parks and reports. Unchanged
    // behaviour, and the point of gating the adoption on `path === ABSENT_PATH`.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.prefix).sort()).toEqual(["TRA", "TRAA"]);
  });

  it("REFUSES an explicit --slug that disagrees, naming the row and both ways out", () => {
    const hub = openHub();
    hub.registerAbsent({ slug: "tracker", prefix: "TRA", kind: "repo", repositoryId: TRACKER_ID });
    hub.close();

    const clone = cloneDir("tracker-checkout", TRACKER_ID);
    expect(() =>
      initWorkspace({ dir: clone, slug: "something-else", gitignore: false }),
    ).toThrow(/already in the hub as "tracker" \(prefix TRA\)/);

    const after = openHub();
    const rows = after.list();
    after.close();
    // Refused before writing a row: still just the placeholder.
    expect(rows.map((r) => r.slug)).toEqual(["tracker"]);
  });
});

/**
 * BREAK: a preview must predict what apply will do — the count as well as the tense.
 *
 * A preview is the consent gate for `--apply`, so a preview that describes a different
 * outcome from the one apply produces is the only kind that actively misleads. Two of these
 * shipped, both on the fresh-replacement-machine path, which is the headline case.
 */
describe("BREAK: the adopt preview must agree with the apply", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  function twoAbsentAndAnEdge(): HubRegistryPayload {
    return {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "hub-elsewhere",
      capturedAt: "2026-01-01T00:00:00.000Z",
      workspaces: [
        { repositoryId: A, slug: "tracker", prefix: "TRA", kind: "repo", addedAt: "x" },
        { repositoryId: B, slug: "website", prefix: "WEB", kind: "repo", addedAt: "x" },
      ],
      crossLinks: [
        {
          blockerRepositoryId: A,
          blockerWs: "tracker",
          blockerIdentifier: "TRA-1",
          blockedRepositoryId: B,
          blockedWs: "website",
          blockedIdentifier: "WEB-1",
          type: "blocks",
        },
      ],
    };
  }

  it("counts an edge between two rows the SAME adoption will create", () => {
    /**
     * `known` was `hub.list()` computed after the decide loop, so in preview mode the
     * placeholder rows did not exist yet and the edge between them counted as skipped —
     * while `--apply` imported it. Measured on the fresh-machine path:
     *
     *     preview: {"added": 0, "skipped": 1}
     *     apply:   {"added": 1, "skipped": 0}
     */
    const preview = adoptRegistry(openHubClosing(), twoAbsentAndAnEdge());
    expect(preview.crossLinks).toMatchObject({ added: 1, skipped: 0 });
    expect(describeAdoption(preview)).toContain("1 cross-workspace link would be imported");

    // And the apply agrees, which is the whole assertion.
    const hub = openHub();
    const applied = adoptRegistry(hub, twoAbsentAndAnEdge(), { apply: true });
    const links = hub.listCrossLinks().length;
    hub.close();
    expect(applied.crossLinks).toEqual(preview.crossLinks);
    expect(links).toBe(1);
  });

  it("still skips an edge whose other end no adoption will create", () => {
    // The property the union must not destroy: an edge naming a workspace that is not in
    // the payload and not on this machine is still unresolvable, and still skipped.
    const payload = twoAbsentAndAnEdge();
    const orphan: HubRegistryPayload = {
      ...payload,
      crossLinks: [{ ...payload.crossLinks[0]!, blockedWs: "nowhere", blockedRepositoryId: "repo-nowhere" }],
    };
    const preview = adoptRegistry(openHubClosing(), orphan);
    expect(preview.crossLinks).toMatchObject({ added: 0, skipped: 1 });
  });

  it("says an opt-out WOULD be retired on a preview, and retires nothing", () => {
    const hub = openHub();
    seed(hub, "tracker", "TRA", A);
    // The contradiction every machine that has pruned since STA-283 holds.
    hub.addOptOut(A, "tracker", "pruned");

    const preview = adoptRegistry(hub, twoAbsentAndAnEdge());
    const stillThere = hub.listOptOuts().map((o) => o.repositoryId);
    hub.close();

    const reason = preview.decisions.find((d) => d.entry.repositoryId === A)!.reason;
    expect(reason).toContain("would be retired");
    expect(reason).not.toContain("was retired");
    // The past tense was the bug: the clear is gated on `apply` and the sentence was not.
    expect(stillThere).toEqual([A]);
  });

  it("says it WAS retired on the apply, and has retired it", () => {
    const hub = openHub();
    seed(hub, "tracker", "TRA", A);
    hub.addOptOut(A, "tracker", "pruned");

    const applied = adoptRegistry(hub, twoAbsentAndAnEdge(), { apply: true });
    const left = hub.listOptOuts();
    hub.close();

    const reason = applied.decisions.find((d) => d.entry.repositoryId === A)!.reason;
    expect(reason).toContain("was retired");
    expect(left).toEqual([]);
  });
});

/** A hub handle for a one-shot read, closed by the test that made it. */
function openHubClosing(): Hub {
  return Hub.open();
}
