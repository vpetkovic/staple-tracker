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

  it("repoints onto a copy already on disk rather than registering it twice", () => {
    const hub = openHub();
    const dbPath = seed(hub, "api", "API", null);
    const report = adoptRegistry(
      hub,
      payloadOf([
        { repositoryId: "repo-api", slug: "api", prefix: "API", kind: "repo", addedAt: "x" },
      ]),
      {
        apply: true,
        locate: (id) => (id === "repo-api" ? { path: dbPath, prefix: "API", slug: "api" } : null),
      },
    );
    const rows = hub.list();
    hub.close();

    expect(report.decisions[0]!.outcome).toBe("repointed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repositoryId).toBe("repo-api");
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
            blockerWs: "api",
            blockerIdentifier: "API-1",
            blockedWs: "web",
            blockedIdentifier: "WEB-1",
            type: "blocks",
          },
        ],
      },
      { apply: true },
    );
    hub.close();
    // An imported edge naming an absent workspace reads as an unresolvable
    // blocker, and unresolvable counts as BLOCKED — it would wedge WEB-1 with
    // nothing on any surface to say why.
    expect(report.crossLinks).toEqual({ added: 0, skipped: 1 });
  });
});
