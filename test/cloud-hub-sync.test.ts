/**
 * `sync --all` — per-workspace outcome, and one failure that does not become
 * twelve. STA-275, criteria 4 and 5.
 *
 * ## Why the server is a multiplexer over several fakes
 *
 * The thing under test is what happens when the answers DIFFER: one workspace
 * synchronizes, one is unreachable, one was never connected, one is not on the
 * disk. A single fake cannot express that, and neither can a real Worker — you
 * cannot ask a real service to fail for exactly one of four repositories and
 * succeed for the rest. So each repository gets its own `FakeSyncServer` and a
 * small router picks between them on the `repoId` in the path, which is exactly
 * what the real Worker does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performSetup } from "../src/commands/init.js";
import { Hub } from "../src/core/hub.js";
import { openWorkspace } from "../src/core/open.js";
import { connectionPath } from "../src/core/cloud/connection.js";
import { credentialFilePath } from "../src/core/cloud/credential-store.js";
import { renderHubSyncOutcome, syncAllWorkspaces } from "../src/core/cloud/hub-sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const ENDPOINT = "https://staple-sync-dev.example.workers.dev";
const DEVICE_ID = "11111111-2222-3333-4444-555555555555";

let home: string;
let scratch: string;
let previousHome: string | undefined;
let servers: Map<string, FakeSyncServer>;

beforeEach(() => {
  previousHome = process.env.STAPLE_HOME;
  home = mkdtempSync(join(tmpdir(), "staple-hubsync-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-hubsync-work-"));
  process.env.STAPLE_HOME = home;
  servers = new Map();
  mkdirSync(join(home, "cloud"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "cloud", "device-id"), `${DEVICE_ID}\n`, { mode: 0o600 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

// ------------------------------------------------------------------- fixtures

interface Workspace {
  slug: string;
  dir: string;
  dbPath: string;
  repositoryId: string;
  server: FakeSyncServer;
}

/**
 * A registered workspace, connected, with its own fake service behind it.
 *
 * `connect` writes the record and the credential by hand rather than going
 * through `performConnect`, because the fan-out under test here starts AFTER
 * connect and going through it would put `cloud-hub-connect.test.ts`'s subject
 * in the setup of every case in this file.
 */
function makeWorkspace(
  slug: string,
  options: { connect?: boolean; enroll?: boolean } = {},
): Workspace {
  const dir = join(scratch, slug);
  mkdirSync(dir, { recursive: true });
  const report = performSetup({ dir, yes: true, gitignore: false, interactive: false });
  const repositoryId = (
    JSON.parse(readFileSync(join(dir, ".staple", "repository.json"), "utf8")) as {
      repositoryId: string;
    }
  ).repositoryId;

  const server = new FakeSyncServer({ repositoryId });
  servers.set(repositoryId, server);

  if (options.connect !== false) {
    const token = `stpl_token_for_${slug}`;
    writeFileSync(
      connectionPath(home, repositoryId),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repositoryId,
          endpoint: ENDPOINT,
          deviceId: DEVICE_ID,
          label: "test machine",
          credentialMechanism: "file",
          connectedAt: new Date().toISOString(),
          auto: false,
          backup: false,
          protocol: 1,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    writeFileSync(credentialFilePath(home, repositoryId), `${token}\n`, { mode: 0o600 });
    // `enroll: false` is how a workspace is made to fail authentication while
    // every other workspace in the same run succeeds.
    if (options.enroll !== false) server.enroll(DEVICE_ID, token);
  }

  return { slug, dir, dbPath: report.dbPath, repositoryId, server };
}

/**
 * Route to the fake that owns the repository named in the path.
 *
 * `/v1/capabilities` is the one route with no repository in it — it is the
 * unauthenticated protocol handshake every sync opens with — so it is answered
 * by whichever fake is to hand. They all advertise the same protocol, which is
 * true of the real service too: capabilities describe the SERVICE, not a
 * repository.
 */
const router: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const match = /^\/v1\/repos\/([^/]+)\//.exec(`${url.pathname}/`);
  const server = match
    ? servers.get(match[1]!)
    : url.pathname === "/v1/capabilities"
      ? servers.values().next().value
      : undefined;
  if (!server) {
    return new Response(
      JSON.stringify({ code: "not_found", message: "unknown repository", retryable: false }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return server.fetch(input as string, init);
}) as unknown as typeof fetch;

function syncAll() {
  return syncAllWorkspaces({
    home,
    fetchImpl: router,
    sleep: async () => undefined,
    attempts: 1,
  });
}

/** Create an issue in a workspace, so it has something to push. */
function write(workspace: Workspace, title: string): void {
  const opened = openWorkspace(workspace.dbPath);
  try {
    opened.store.createIssue({ title, createdBy: "test" });
  } finally {
    opened.store.db.close();
  }
}

// ---------------------------------------------------------------- criterion 4

describe("a sync run reports per-workspace outcome, never an aggregate", () => {
  it("gives every workspace its own row with its own numbers", async () => {
    const alpha = makeWorkspace("alpha");
    const bravo = makeWorkspace("bravo");
    write(alpha, "one on alpha");
    write(alpha, "two on alpha");
    write(bravo, "one on bravo");

    const outcome = await syncAll();

    expect(outcome.workspaces).toHaveLength(2);
    expect(outcome.synced).toBe(2);
    expect(outcome.failed).toBe(0);

    const rows = Object.fromEntries(outcome.workspaces.map((row) => [row.slug, row]));
    expect(rows.alpha!.report!.pushed.applied).toBe(2);
    expect(rows.bravo!.report!.pushed.applied).toBe(1);
    // Each row carries the FULL single-workspace report, not a summary of it.
    expect(rows.alpha!.report!.repositoryId).toBe(alpha.repositoryId);
    expect(rows.bravo!.report!.repositoryId).toBe(bravo.repositoryId);
    expect(outcome.pushed).toBe(3);
  });

  it("skips a workspace that is not connected rather than failing it", async () => {
    makeWorkspace("alpha");
    makeWorkspace("bravo", { connect: false });

    const outcome = await syncAll();

    const bravo = outcome.workspaces.find((row) => row.slug === "bravo")!;
    expect(bravo.status).toBe("skipped");
    expect(bravo.skip).toBe("disconnected");
    expect(outcome.failed).toBe(0);
    /**
     * Not being connected is the DEFAULT state of the whole product. Reporting
     * it as a failure would paint three unconnected repositories red on every
     * run of a command whose job is to synchronize the connected ones.
     */
    expect(bravo.reason).toContain("Connecting is a separate consent");
  });

  it("renders every workspace, including the ones nothing happened to", async () => {
    makeWorkspace("alpha");
    makeWorkspace("bravo", { connect: false });

    const text = renderHubSyncOutcome(await syncAll());

    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
    expect(text).toContain("1 synchronized, 1 skipped, 0 failed");
    // A report that printed only failures is indistinguishable, on a good day,
    // from a command that did nothing.
    expect(text).not.toBe("");
  });
});

// ---------------------------------------------------------------- criterion 5

describe("a failure on one workspace does not abort the others", () => {
  it("synchronizes the rest when the middle one cannot authenticate", async () => {
    const alpha = makeWorkspace("alpha");
    makeWorkspace("bravo", { enroll: false });
    const charlie = makeWorkspace("charlie");
    write(alpha, "on alpha");
    write(charlie, "on charlie");

    const outcome = await syncAll();

    expect(outcome.synced).toBe(2);
    expect(outcome.failed).toBe(1);

    const rows = Object.fromEntries(outcome.workspaces.map((row) => [row.slug, row]));
    expect(rows.alpha!.status).toBe("synced");
    expect(rows.bravo!.status).toBe("failed");
    expect(rows.charlie!.status).toBe("synced");

    /**
     * The two that worked really did reach their services. `charlie` is AFTER
     * the failure in hub order, so this is the assertion that the run kept
     * going rather than merely that the first one was attempted.
     */
    expect(alpha.server.ops).toHaveLength(1);
    expect(charlie.server.ops).toHaveLength(1);
  });

  it("carries the service's own code per row, not staple's folded one", async () => {
    makeWorkspace("alpha", { enroll: false });

    const row = (await syncAll()).workspaces[0]!;

    expect(row.status).toBe("failed");
    /**
     * `client.ts` folds every cloud code into staple's four-value space so exit
     * codes stay coherent, which means `offline`, `rate_limited` and
     * `unavailable` all arrive as `conflict`. In a twelve-row table that is
     * useless. `cloudCode` is the one that tells a person which workspace needs
     * a re-connect and which just needs a network.
     */
    expect(row.cloudCode).toBe("auth");
    expect(row.code).toBeTruthy();
  });

  it("does not throw — a partial failure is a report, not an exception", async () => {
    makeWorkspace("alpha", { enroll: false });
    makeWorkspace("bravo", { enroll: false });

    // Every single workspace failed, and it is still a resolved promise with
    // two rows. Throwing here would replace two precise statements with one
    // vague one.
    const outcome = await syncAll();
    expect(outcome.failed).toBe(2);
    expect(outcome.workspaces).toHaveLength(2);
  });
});

// ------------------------------------------------------------- the MISSING row

describe("a MISSING workspace is skipped, and never materialised", () => {
  it("does not create a database for a registered path that is not there", async () => {
    const ghost = join(scratch, "ghost", ".staple", "staple.db");
    const hub = Hub.open();
    try {
      hub.register({ slug: "ghost", prefix: "GHST", path: ghost, kind: "repo" });
    } finally {
      hub.close();
    }
    makeWorkspace("alpha");

    const outcome = await syncAll();

    /**
     * The catastrophe this guards against: `staple init`'s door calls
     * `openDb()`, which CREATES the file. A `sync --all` that reached for it
     * would materialise an empty database for every unmounted volume and then
     * hydrate each one from a remote snapshot, silently. `openWorkspace` refuses
     * a missing path too, so this is belt and braces — but the belt is what
     * turns a `not_found` failure row into an honest skip.
     */
    expect(existsSync(ghost)).toBe(false);

    const row = outcome.workspaces.find((r) => r.slug === "ghost")!;
    expect(row.status).toBe("skipped");
    expect(row.skip).toBe("unavailable");
    expect(outcome.failed).toBe(0);
    expect(outcome.synced).toBe(1);
  });

  /**
   * The case that actually exercises BOTH guards, which the `ghost` case above
   * does not.
   *
   * A ghost row has no manifest either, so it is refused for want of an identity
   * before availability is ever consulted — and an implementation that had lost
   * the availability check entirely would still skip it. This one is different:
   * the manifest and the connection record both survive the database, so the row
   * has an identity AND is connected, and the ONLY thing standing between the
   * fan-out and `openWorkspace` is `available`.
   *
   * That makes it the case where the layering is visible. `skipReasonFor` skips
   * it, and if that check were ever removed, `openWorkspace`'s own `not_found`
   * catches it before SQLite is touched — the row would go red instead of amber,
   * but no empty database would be created and nothing would be hydrated into
   * one. Both layers are asserted here.
   */
  it("skips a connected workspace whose database is gone but whose manifest survives", async () => {
    const alpha = makeWorkspace("alpha");
    const bravo = makeWorkspace("bravo");
    write(bravo, "on bravo");
    // The database only. `.staple/repository.json` stays, so the identity is
    // readable and the connection record in the home is still valid.
    rmSync(alpha.dbPath);
    expect(existsSync(join(alpha.dir, ".staple", "repository.json"))).toBe(true);

    const outcome = await syncAll();

    const row = outcome.workspaces.find((r) => r.slug === "alpha")!;
    expect(row.status).toBe("skipped");
    expect(row.skip).toBe("unavailable");
    // It HAS an identity — this is not the `no_identity` path in disguise.
    expect(row.repositoryId).toBe(alpha.repositoryId);

    // Nothing was recreated, and the workspace that was fine still synced.
    expect(existsSync(alpha.dbPath)).toBe(false);
    expect(alpha.server.ops).toHaveLength(0);
    expect(outcome.synced).toBe(1);
    expect(bravo.server.ops).toHaveLength(1);
  });

  it("leaves the registration in place — existsSync is not evidence of deletion", async () => {
    const alpha = makeWorkspace("alpha");
    rmSync(join(alpha.dir, ".staple"), { recursive: true, force: true });

    await syncAll();

    const hub = Hub.openReadOnly();
    try {
      expect(hub.list().map((row) => row.slug)).toEqual(["alpha"]);
    } finally {
      hub.close();
    }
  });
});

// --------------------------------------------------------- handles and hygiene

describe("the fan-out leaves nothing open behind it", () => {
  it("closes each workspace before opening the next, even when one fails", async () => {
    const alpha = makeWorkspace("alpha", { enroll: false });
    const bravo = makeWorkspace("bravo");
    write(bravo, "on bravo");

    await syncAll();

    /**
     * Proof by consequence: a handle left open on `alpha` would hold its WAL,
     * and re-opening it here would still work but the sync of `bravo` after a
     * throw is what a missing `finally` would have prevented. Both are checked —
     * `bravo` synced, and both databases are re-openable and writable now.
     */
    for (const workspace of [alpha, bravo]) {
      const opened = openWorkspace(workspace.dbPath);
      try {
        opened.store.createIssue({ title: `after ${workspace.slug}`, createdBy: "test" });
      } finally {
        opened.store.db.close();
      }
    }
    expect(bravo.server.ops).toHaveLength(1);
  });
});
