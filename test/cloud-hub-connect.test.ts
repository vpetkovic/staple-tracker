/**
 * One connect, every registered workspace — STA-275.
 *
 * One `describe` per acceptance criterion, plus the two properties that are not
 * criteria but are the reason the design is shaped this way: the fan-out cannot
 * reach the network before consent, and the fan-out never opens a workspace
 * database to answer a question about connection state.
 *
 * ## What is faked and what is real
 *
 * The **hub is real**. These tests create actual workspaces in a temporary
 * staple home and read them back through `Hub`, because the enumeration is the
 * thing under test in half of them and a stubbed registry would prove nothing
 * about `staple init` making a workspace visible.
 *
 * The **server is a fake `fetch`**, for the reason `cloud-connect.test.ts`
 * gives: these are tests about what the client does — what it sends, in what
 * order, what it writes, and above all what it does when one of twelve requests
 * fails — and a fake is the only thing that can be made to fail on the third
 * workspace and succeed on the fourth.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { performSetup } from "../src/commands/init.js";
import { Hub } from "../src/core/hub.js";
import { StapleError } from "../src/core/types.js";
import { connectionPath, readConnection, setConsent } from "../src/core/cloud/connection.js";
import { credentialFilePath } from "../src/core/cloud/credential-store.js";
import {
  describeSkip,
  listHubWorkspaces,
  skipReasonFor,
  type HubWorkspace,
} from "../src/core/cloud/hub-scope.js";
import { buildHubConnectPreview, renderHubConnectPreview } from "../src/core/cloud/hub-preview.js";
import {
  performHubConnect,
  performHubDisconnect,
  renderHubConnectOutcome,
} from "../src/core/cloud/hub-connect.js";
import { describeHubReport, hubCloudReport } from "../src/core/cloud/hub-surface.js";

const ENDPOINT = "https://staple-sync-dev.example.workers.dev";

let home: string;
let scratch: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.STAPLE_HOME;
  home = mkdtempSync(join(tmpdir(), "staple-hub-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-hub-work-"));
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

// ------------------------------------------------------------------- fixtures

/** Register a real repository-backed workspace and return its ids. */
function makeRepo(name: string): { dir: string; dbPath: string; repositoryId: string } {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const report = performSetup({ dir, yes: true, gitignore: false, interactive: false });
  const manifest = JSON.parse(
    readFileSync(join(dir, ".staple", "repository.json"), "utf8"),
  ) as { repositoryId: string };
  return { dir, dbPath: report.dbPath, repositoryId: manifest.repositoryId };
}

/** Register a home-resident (`--global`) workspace, the STA-273 case. */
function makeGlobal(slug: string): { dbPath: string; repositoryId: string } {
  const report = performSetup({ global: slug, yes: true, gitignore: false, interactive: false });
  const manifest = JSON.parse(
    readFileSync(join(home, "workspaces", slug, "repository.json"), "utf8"),
  ) as { repositoryId: string };
  return { dbPath: report.dbPath, repositoryId: manifest.repositoryId };
}

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const CAPABILITIES = {
  protocol: { min: 1, max: 1 },
  maxBatchSize: 25,
  maxOpBytes: 524288,
  maxPullLimit: 500,
  defaultPullLimit: 200,
  maxSnapshotPageSize: 500,
};

/**
 * A fake service that enrolls some repositories and refuses others.
 *
 * `refuse` is the whole point of the fixture. The acceptance criterion is that
 * one workspace failing does not abort the others, and the only honest way to
 * test it is a server that says yes, yes, no, yes.
 */
/**
 * Minted per CALL and across service instances, not per repository.
 *
 * A token derived from the repository id would be byte-identical on a
 * re-connect, which would make the rotation invisible to any assertion — and
 * "did --reconnect actually replace the credential" is one of the things worth
 * knowing. Module-scoped because a re-connect uses a SECOND `fakeService()`.
 */
let minted = 0;

function fakeService(options: { refuse?: ReadonlySet<string> } = {}) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    if (pathname === "/v1/capabilities") {
      return json(200, CAPABILITIES);
    }

    const connect = /^\/v1\/repos\/([^/]+)\/connect$/.exec(pathname);
    if (connect && method === "POST") {
      const repoId = connect[1]!;
      if (options.refuse?.has(repoId)) {
        return json(403, {
          code: "forbidden",
          message: "not a member of this repository",
          retryable: false,
        });
      }
      return json(200, {
        protocol: 1,
        repoId,
        deviceId: (init?.body ? (JSON.parse(init.body as string) as { deviceId: string }) : { deviceId: "d" })
          .deviceId,
        epoch: 1,
        token: `stpl_token_${(minted += 1)}_for_${repoId}`,
        capabilities: CAPABILITIES,
      });
    }

    return json(404, { code: "not_found", message: "unknown route", retryable: false });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hubPreview(options: { reconnect?: boolean } = {}) {
  return buildHubConnectPreview({
    home,
    endpoint: ENDPOINT,
    label: "test machine",
    credential: { forceFile: true },
    reconnect: options.reconnect,
  });
}

async function connectAll(service = fakeService()) {
  const outcome = await performHubConnect(hubPreview(), {
    home,
    enrollmentSecret: "enrollment-secret",
    credential: { forceFile: true },
    fetchImpl: service.impl,
  });
  return { outcome, service };
}

// ---------------------------------------------------------------- criterion 1

describe("one connect covers every registered workspace", () => {
  it("connects all of them from a single gesture, and each keeps its own credential", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    const c = makeGlobal("charlie");

    const { outcome } = await connectAll();

    expect(outcome.connected).toBe(3);
    expect(outcome.failed).toBe(0);
    expect(outcome.workspaces.map((row) => row.status)).toEqual([
      "connected",
      "connected",
      "connected",
    ]);

    /**
     * THE CREDENTIAL DECISION, asserted rather than described. Three
     * workspaces, three separate credential files, three different secrets.
     * One credential covering all three would make this test pass with one
     * file, and the day somebody "simplifies" it that way this is what fails.
     */
    for (const { repositoryId } of [a, b, c]) {
      expect(existsSync(credentialFilePath(home, repositoryId)), repositoryId).toBe(true);
    }
    const secrets = [a, b, c].map((w) =>
      readFileSync(credentialFilePath(home, w.repositoryId), "utf8").trim(),
    );
    expect(new Set(secrets).size).toBe(3);
  });

  it("is one DEVICE in all of them — the machine identity was already hub-wide", async () => {
    makeRepo("alpha");
    makeRepo("bravo");

    const { outcome } = await connectAll();
    const deviceIds = outcome.workspaces.map((row) => row.connection?.deviceId);

    // `device.ts`: "One laptop connected to three repositories is one device
    // three times over, not three devices."
    expect(new Set(deviceIds).size).toBe(1);
    expect(deviceIds[0]).toBeTruthy();
  });

  it("sends exactly one connect per workspace, and no request names the hub", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");

    const { service } = await connectAll();

    const connects = service.calls.filter((call) => call.path.endsWith("/connect"));
    expect(connects).toHaveLength(2);
    expect(connects.map((call) => call.path).sort()).toEqual(
      [`/v1/repos/${a.repositoryId}/connect`, `/v1/repos/${b.repositoryId}/connect`].sort(),
    );

    /**
     * *"The hub database itself still never leaves the machine."* Nothing in any
     * request body names another workspace, a path, a slug or a count. The
     * service cannot tell this from two people connecting two repositories.
     */
    for (const call of service.calls) {
      const wire = JSON.stringify(call.body ?? {});
      expect(wire).not.toContain(home);
      expect(wire).not.toContain(scratch);
      expect(wire).not.toContain("alpha");
      expect(wire).not.toContain("bravo");
      expect(Object.keys((call.body ?? {}) as object).sort()).toEqual(
        call.path.endsWith("/connect") ? ["deviceId", "label"] : [],
      );
    }
  });
});

// ---------------------------------------------------------------- criterion 2

describe("the settings surface lists every workspace with its own state", () => {
  it("gives each workspace its own state, endpoint and consents", async () => {
    const a = makeRepo("alpha");
    makeRepo("bravo");
    await connectAll();

    // One workspace, and only that one, turns automatic sync on.
    setConsent(home, a.repositoryId, { auto: true });

    const report = hubCloudReport(home);
    expect(report.workspaces.map((row) => row.slug)).toEqual(["alpha", "bravo"]);
    expect(report.workspaces.map((row) => row.state)).toEqual(["automatic", "manual"]);
    expect(report.workspaces.map((row) => row.auto)).toEqual([true, false]);
    expect(report.counts).toMatchObject({ total: 2, connected: 2, disconnected: 0, automatic: 1 });
  });

  it("reports every distinct endpoint, because a hub may legitimately span two", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    await connectAll();

    // Repoint one of them by hand, the way a second `connect` would.
    const record = readConnection(home, b.repositoryId)!;
    writeFileSync(
      connectionPath(home, b.repositoryId),
      JSON.stringify({ ...record, endpoint: "https://other.example.com" }, null, 2),
      { mode: 0o600 },
    );

    const report = hubCloudReport(home);
    expect(report.endpoints).toEqual([ENDPOINT, "https://other.example.com"].sort());
    expect(report.workspaces.find((row) => row.slug === "alpha")!.endpoint).toBe(ENDPOINT);
    expect(a.repositoryId).not.toBe(b.repositoryId);
  });

  it("does not probe the credential unless asked, and says so with null", async () => {
    const a = makeRepo("alpha");
    await connectAll();

    expect(hubCloudReport(home).workspaces[0]!.credentialPresent).toBeNull();
    expect(hubCloudReport(home, { probeCredentials: true }).workspaces[0]!.credentialPresent).toBe(
      true,
    );

    rmSync(credentialFilePath(home, a.repositoryId));
    const probed = hubCloudReport(home, { probeCredentials: true }).workspaces[0]!;
    expect(probed.credentialPresent).toBe(false);
    expect(probed.state).toBe("auth_failed");

    /**
     * And the UNPROBED read does not guess. It reports the consent on file
     * rather than inventing `auth_failed` from a credential it never looked at
     * — the honest answer for a surface that polls.
     */
    expect(hubCloudReport(home).workspaces[0]!.state).toBe("manual");
  });

  it("renders a human list naming every workspace", async () => {
    makeRepo("alpha");
    makeRepo("bravo");
    await connectAll();

    const text = describeHubReport(hubCloudReport(home));
    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
    expect(text).toContain("2 of 2 connected");
  });
});

// ---------------------------------------------------------------- criterion 3

describe("a newly registered workspace appears without reconnecting", () => {
  it("shows up in the list the moment it is registered", async () => {
    makeRepo("alpha");
    await connectAll();
    expect(hubCloudReport(home).counts.total).toBe(1);

    makeRepo("bravo");

    /**
     * No re-connect, no refresh, no cache to invalidate. The list is ENUMERATED
     * when it is asked for, and there is no stored set of member workspaces that
     * could have gone stale — which is the whole mechanism behind this
     * criterion.
     */
    const report = hubCloudReport(home);
    expect(report.workspaces.map((row) => row.slug)).toEqual(["alpha", "bravo"]);
    expect(report.workspaces[1]!.state).toBe("disconnected");
  });

  it("re-running connect picks up only the new one and does not touch the others", async () => {
    const a = makeRepo("alpha");
    const first = await connectAll();
    const firstSecret = readFileSync(credentialFilePath(home, a.repositoryId), "utf8");
    const firstConnectedAt = readConnection(home, a.repositoryId)!.connectedAt;

    const b = makeRepo("bravo");
    const second = await connectAll();

    expect(second.outcome.connected).toBe(1);
    expect(second.outcome.skipped).toBe(1);
    expect(second.outcome.workspaces.find((row) => row.slug === "bravo")!.status).toBe("connected");
    expect(second.outcome.workspaces.find((row) => row.slug === "alpha")!.status).toBe("skipped");

    /**
     * The existing credential is BYTE-IDENTICAL and the record's timestamp did
     * not move. "Appears without reconnecting" is only true if re-running the
     * gesture is not itself a reconnect for everybody else.
     */
    expect(readFileSync(credentialFilePath(home, a.repositoryId), "utf8")).toBe(firstSecret);
    expect(readConnection(home, a.repositoryId)!.connectedAt).toBe(firstConnectedAt);

    // And the second run spoke only about the new workspace.
    const connects = second.service.calls.filter((call) => call.path.endsWith("/connect"));
    expect(connects.map((call) => call.path)).toEqual([`/v1/repos/${b.repositoryId}/connect`]);
    expect(first.outcome.connected).toBe(1);
  });

  it("--reconnect is what replaces existing credentials, and says so in capitals", async () => {
    const a = makeRepo("alpha");
    await connectAll();
    const before = readFileSync(credentialFilePath(home, a.repositoryId), "utf8");

    const preview = hubPreview({ reconnect: true });
    expect(preview.willReconnect).toBe(1);
    expect(renderHubConnectPreview(preview)).toContain("RECONNECT");

    await performHubConnect(preview, {
      home,
      enrollmentSecret: "enrollment-secret",
      credential: { forceFile: true },
      fetchImpl: fakeService().impl,
    });
    expect(readFileSync(credentialFilePath(home, a.repositoryId), "utf8")).not.toBe(before);
  });
});

// ------------------------------------------------------------- criteria 4 & 5

describe("partial failure is the normal case", () => {
  it("one workspace refused by the service does not abort the others", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    const c = makeRepo("charlie");

    const service = fakeService({ refuse: new Set([b.repositoryId]) });
    const outcome = await performHubConnect(hubPreview(), {
      home,
      enrollmentSecret: "enrollment-secret",
      credential: { forceFile: true },
      fetchImpl: service.impl,
    });

    expect(outcome.connected).toBe(2);
    expect(outcome.failed).toBe(1);

    const rows = Object.fromEntries(outcome.workspaces.map((row) => [row.slug, row]));
    expect(rows.alpha!.status).toBe("connected");
    expect(rows.bravo!.status).toBe("failed");
    expect(rows.charlie!.status).toBe("connected");

    /**
     * The failure carries the SERVICE's own code and message.
     *
     * `code` is staple's four-value space, which folds `forbidden`,
     * `cursor_invalid` and `payload_too_large` all into `validation` so exit
     * codes stay coherent. That is fine for one workspace and useless in a
     * twelve-row table, so `cloudCode` carries the code the service actually
     * sent — which is the one that says "this repository was provisioned with a
     * different enrollment secret".
     */
    expect(rows.bravo!.code).toBe("validation");
    expect(rows.bravo!.cloudCode).toBe("forbidden");
    expect(rows.bravo!.reason).toContain("not a member of this repository");

    // And the two that worked really did: credentials on disk, records written.
    expect(readConnection(home, a.repositoryId)).not.toBeNull();
    expect(readConnection(home, b.repositoryId)).toBeNull();
    expect(readConnection(home, c.repositoryId)).not.toBeNull();
  });

  it("the run after a refusal still attempts the remaining workspaces", async () => {
    const a = makeRepo("alpha");
    makeRepo("bravo");
    makeRepo("charlie");

    const service = fakeService({ refuse: new Set([a.repositoryId]) });
    await performHubConnect(hubPreview(), {
      home,
      enrollmentSecret: "enrollment-secret",
      credential: { forceFile: true },
      fetchImpl: service.impl,
    });

    /**
     * The FIRST workspace is the one refused, so an implementation that threw on
     * the first failure would have made exactly one connect call. Three is the
     * assertion that it kept going with the same enrollment secret — see
     * `hub-connect.ts` on why a `forbidden` is a statement about one repository
     * and not about the secret.
     */
    expect(service.calls.filter((call) => call.path.endsWith("/connect"))).toHaveLength(3);
  });

  it("never reports an aggregate — every workspace gets its own row", async () => {
    const a = makeRepo("alpha");
    makeRepo("bravo");
    const service = fakeService({ refuse: new Set([a.repositoryId]) });

    const outcome = await performHubConnect(hubPreview(), {
      home,
      enrollmentSecret: "enrollment-secret",
      credential: { forceFile: true },
      fetchImpl: service.impl,
    });

    expect(outcome.workspaces).toHaveLength(2);
    for (const row of outcome.workspaces) {
      expect(row.slug).toBeTruthy();
      expect(row.reason).not.toBe("");
    }
    const text = renderHubConnectOutcome(outcome);
    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
    expect(text).toContain("1 connected, 0 skipped, 1 failed");
    // Not "sync failed", not "connect failed".
    expect(text).toContain("did not affect the others");
  });
});

// ---------------------------------------------------------------- criterion 6

describe("the hub database never leaves the machine", () => {
  it("no request body or URL carries a workspace path, slug or the hub", async () => {
    makeRepo("alpha");
    const { service } = await connectAll();
    for (const call of service.calls) {
      expect(call.path).not.toContain("hub");
      expect(JSON.stringify(call)).not.toContain(Hub.hubPath());
    }
  });

  it("the enumeration opens the hub READ-ONLY and does not stamp it", () => {
    makeRepo("alpha");
    const hubFile = Hub.hubPath();
    const before = readFileSync(hubFile);

    listHubWorkspaces();
    hubCloudReport(home);
    hubPreview();

    /**
     * `Hub.open()` migrates and issues `PRAGMA journal_mode=WAL`, both of which
     * write to the file header. A status command that stamped the hub as a side
     * effect of listing it is the mistake `Hub.openReadOnly()` exists to prevent
     * in `doctor`, and a hub-wide cloud read has no more business doing it.
     */
    expect(readFileSync(hubFile).equals(before)).toBe(true);
  });
});

// ----------------------------------------------------- preview before consent

describe("a fan-out preview shows what it is about to connect, before anything", () => {
  it("building the preview issues no request at all", () => {
    makeRepo("alpha");
    makeRepo("bravo");
    const service = fakeService();

    const preview = hubPreview();

    expect(service.calls).toHaveLength(0);
    expect(preview.entries).toHaveLength(2);
    expect(preview.willConnect).toBe(2);
  });

  it("cannot reach the transport, and that is the import graph", () => {
    /**
     * The same transitive walk `cloud-auto-sync.test.ts` uses for the automatic
     * sync gate, and for the same reason: a one-level import list would pass the
     * day somebody added a reachability probe two hops away.
     *
     * `hub-preview.ts` exists as a separate file from `hub-connect.ts` PURELY to
     * make this assertion possible. If they are ever merged, this fails, which
     * is the review moment.
     */
    const cloud = new URL("../src/core/cloud/", import.meta.url).pathname;
    const seen = new Set<string>();
    const queue = [join(cloud, "hub-preview.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /(?:^|\n)import\s+(?:type\s+)?[^;]*?from\s+"(\.[^"]+)"/g,
      )) {
        if (/import\s+type\s/.test(match[0])) continue; // erased; no runtime edge
        const resolved = join(dirname(file), match[1]!.replace(/\.js$/, ".ts"));
        if (existsSync(resolved)) queue.push(resolved);
      }
    }

    expect([...seen].filter((file) => /\/(client|sync)\.ts$/.test(file))).toEqual([]);
    for (const file of seen) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("names every workspace, including the ones it will not touch", () => {
    makeRepo("alpha");
    const orphan = join(scratch, "orphan");
    mkdirSync(join(orphan, ".staple"), { recursive: true });
    registerRaw("orphan", "ORPH", join(orphan, ".staple", "staple.db"), "repo");

    const text = renderHubConnectPreview(hubPreview());

    // A count would not be consent. Both are named, and the skipped one says why.
    expect(text).toContain("alpha");
    expect(text).toContain("orphan");
    expect(text).toContain("not on this machine right now");
    expect(text).toContain("AUTOMATIC SYNC STAYS OFF");
  });

  it("refuses to spend the enrollment secret when consent produced no entries", async () => {
    // No workspaces at all: `performHubConnect` still validates its argument
    // rather than silently succeeding with zero rows.
    await expect(
      performHubConnect(hubPreview(), { home, enrollmentSecret: "   " }),
    ).rejects.toBeInstanceOf(StapleError);
  });
});

// ------------------------------------------------------------- the MISSING row

describe("a MISSING hub row is listed, skipped, and never repaired", () => {
  it("is skipped by connect and reported as unavailable, not as missing identity", () => {
    const a = makeRepo("alpha");
    rmSync(join(a.dir, ".staple"), { recursive: true, force: true });

    const [workspace] = listHubWorkspaces();
    expect(workspace!.available).toBe(false);
    expect(skipReasonFor(workspace!)).toBe("unavailable");

    /**
     * NOT `no_identity`. The manifest is gone with the disk, so an ordering that
     * tested identity first would tell a human to run `staple init` in a
     * directory that is not there — advice which, followed after the volume
     * remounts, mints a SECOND repository id over a workspace that already had
     * one. See `skipReasonFor`.
     */
    expect(describeSkip(workspace!, "unavailable")).not.toContain("staple init");

    const preview = hubPreview();
    expect(preview.willConnect).toBe(0);
    expect(preview.entries[0]!.action).toBe("skip");
    expect(preview.entries[0]!.preview).toBeNull();
  });

  it("is never pruned from the hub — existsSync is not evidence of deletion", () => {
    const a = makeRepo("alpha");
    rmSync(join(a.dir, ".staple"), { recursive: true, force: true });

    hubCloudReport(home);
    hubPreview();
    performHubDisconnect(home);

    const hub = Hub.openReadOnly();
    try {
      expect(hub.list().map((row) => row.slug)).toEqual(["alpha"]);
    } finally {
      hub.close();
    }
  });

  it("still reports its own connection state, because that is a fact about THIS machine", async () => {
    const a = makeRepo("alpha");
    await connectAll();
    rmSync(a.dbPath);

    const row = hubCloudReport(home).workspaces[0]!;
    expect(row.available).toBe(false);
    expect(row.skip).toBe("unavailable");
    // The manifest outlived the database, so the id is still readable and the
    // connection record — which lives in the HOME — is still true.
    expect(row.state).toBe("manual");
    expect(row.endpoint).toBe(ENDPOINT);
  });

  it("a fan-out never creates a database for a path that is not there", () => {
    const ghost = join(scratch, "ghost", ".staple", "staple.db");
    registerRaw("ghost", "GHST", ghost, "repo");

    hubCloudReport(home, { probeCredentials: true });
    hubPreview();
    performHubDisconnect(home);

    /**
     * `staple init`'s door calls `openDb()`, which CREATES the file. If a
     * fan-out ever reached for that door instead of `openWorkspace`'s, every
     * unmounted volume would gain an empty workspace. This is the assertion that
     * notices.
     */
    expect(existsSync(ghost)).toBe(false);
    expect(existsSync(dirname(ghost))).toBe(false);
  });
});

// ------------------------------------------------------------- three consents

describe("a hub-wide connect is not a hub-wide auto-sync consent", () => {
  it("leaves automatic sync and backup OFF for every workspace", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    const c = makeGlobal("charlie");

    const { outcome } = await connectAll();

    for (const row of outcome.workspaces) {
      expect(row.connection!.auto, row.slug).toBe(false);
      expect(row.connection!.backup, row.slug).toBe(false);
    }
    for (const { repositoryId } of [a, b, c]) {
      const record = readConnection(home, repositoryId)!;
      expect(record.auto).toBe(false);
      expect(record.backup).toBe(false);
    }
    expect(hubCloudReport(home).counts.automatic).toBe(0);
    expect(renderHubConnectOutcome(outcome)).toContain("Automatic sync is OFF for every one of them");
  });

  it("--reconnect does not inherit an existing automatic-sync consent either", async () => {
    const a = makeRepo("alpha");
    await connectAll();
    setConsent(home, a.repositoryId, { auto: true, backup: true });
    expect(readConnection(home, a.repositoryId)!.auto).toBe(true);

    await performHubConnect(hubPreview({ reconnect: true }), {
      home,
      enrollmentSecret: "enrollment-secret",
      credential: { forceFile: true },
      fetchImpl: fakeService().impl,
    });

    /**
     * `performConnect` hardcodes both to false on every connection including a
     * re-connect, and the fan-out calls it unchanged. A re-connect happens
     * because something went wrong with a credential, and silently resuming
     * background traffic at the moment somebody is repairing a trust problem is
     * the failure the single-workspace path already refuses.
     */
    const record = readConnection(home, a.repositoryId)!;
    expect(record.auto).toBe(false);
    expect(record.backup).toBe(false);
  });

  it("disconnecting one workspace leaves the others connected — granular revocation", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    await connectAll();

    // The single-workspace verb, unchanged, on one of many.
    rmSync(connectionPath(home, a.repositoryId));
    rmSync(credentialFilePath(home, a.repositoryId));

    const report = hubCloudReport(home);
    expect(report.workspaces.find((row) => row.slug === "alpha")!.state).toBe("disconnected");
    expect(report.workspaces.find((row) => row.slug === "bravo")!.state).toBe("manual");
    expect(readConnection(home, b.repositoryId)).not.toBeNull();
  });
});

// -------------------------------------------------------------- disconnect all

describe("disconnect --all is local, and only local", () => {
  it("removes every credential and makes no request", async () => {
    const a = makeRepo("alpha");
    const b = makeRepo("bravo");
    await connectAll();

    const outcome = performHubDisconnect(home, { forceFile: true });

    expect(outcome.disconnected).toBe(2);
    expect(readConnection(home, a.repositoryId)).toBeNull();
    expect(readConnection(home, b.repositoryId)).toBeNull();
    expect(existsSync(credentialFilePath(home, a.repositoryId))).toBe(false);
    /**
     * `performHubDisconnect` is not async and has no `fetchImpl` to give it, so
     * "makes no request" is a property of the SIGNATURE here rather than an
     * assertion about a spy — which is the stronger form.
     */
    expect(outcome.workspaces.every((row) => row.reason.length > 0)).toBe(true);
  });

  it("disconnects a workspace whose disk is not mounted, unlike connect and sync", async () => {
    const a = makeRepo("alpha");
    await connectAll();
    rmSync(a.dbPath);

    const outcome = performHubDisconnect(home, { forceFile: true });

    /**
     * The credential is in the HOME, not in the workspace. Refusing because a
     * volume is absent would leave a live credential behind for precisely the
     * workspace somebody is most likely to be disconnecting.
     */
    expect(outcome.disconnected).toBe(1);
    expect(readConnection(home, a.repositoryId)).toBeNull();
  });

  it("reports a never-connected workspace as skipped rather than disconnected", () => {
    makeRepo("alpha");
    const outcome = performHubDisconnect(home, { forceFile: true });
    expect(outcome.disconnected).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(outcome.workspaces[0]!.reason).toContain("Was not connected");
  });
});

// -------------------------------------------------------- damaged rows in situ

describe("one damaged workspace does not blank the list", () => {
  it("reports an unreadable manifest as a problem, never as 'no identity'", () => {
    const a = makeRepo("alpha");
    makeRepo("bravo");
    writeFileSync(join(a.dir, ".staple", "repository.json"), "{ not json");

    const workspaces = listHubWorkspaces();
    const alpha = workspaces.find((row) => row.slug === "alpha")!;

    expect(alpha.problem).not.toBeNull();
    expect(skipReasonFor(alpha)).toBe("problem");
    // The other workspace is unaffected and fully described.
    expect(workspaces.find((row) => row.slug === "bravo")!.repositoryId).toBeTruthy();
    expect(hubCloudReport(home).workspaces).toHaveLength(2);
  });

  it("reports an unreadable connection record without taking the run down", async () => {
    const a = makeRepo("alpha");
    makeRepo("bravo");
    await connectAll();
    writeFileSync(connectionPath(home, a.repositoryId), "{ not json", { mode: 0o600 });

    const report = hubCloudReport(home);
    const alpha = report.workspaces.find((row) => row.slug === "alpha")!;
    expect(alpha.skip).toBe("problem");
    expect(alpha.skipDetail).toContain("could not be read");
    expect(report.workspaces).toHaveLength(2);

    // And a connect fan-out skips it rather than overwriting it.
    const entry = hubPreview().entries.find((row) => row.slug === "alpha")!;
    expect(entry.action).toBe("skip");
    expect(entry.skip).toBe("problem");
  });
});

/**
 * Register a hub row directly, for the cases that need a registration WITHOUT a
 * workspace behind it. `performSetup` cannot produce one — it creates the
 * database as it registers — and that is exactly the state a hub is in after an
 * external disk is unplugged.
 */
function registerRaw(slug: string, prefix: string, path: string, kind: string): void {
  const hub = Hub.open();
  try {
    hub.register({ slug, prefix, path, kind });
  } finally {
    hub.close();
  }
}

/** Referenced so the fixture helper is not dead when a case is removed. */
export type { HubWorkspace };
