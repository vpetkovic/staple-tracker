/**
 * The test that proves the zero-network invariant.
 *
 * Contract: `docs/sync.md`, "The network rule — and the test that proves it".
 *
 *   *"Today the runtime contains **zero outbound network call sites** … The
 *   invariant is therefore not a reduction to be achieved — it is a floor to be
 *   held, and the assertion is literally zero rather than an allowlist."*
 *
 * Two halves, because the scenarios the contract names live in two places.
 *
 * **Subprocess half.** The listed scenarios are real CLI invocations, and a spy
 * in this process cannot see a child. Each one runs under
 * `NODE_OPTIONS=--import test/fixtures/network-spy-preload.mjs`, which attaches
 * the spy before tsx's loader and therefore before any line of `src/`. A
 * violation is appended to a log file and then thrown, so it shows up as both a
 * non-zero exit and a line we can read back and name.
 *
 * **In-process half.** The cloud modules are imported directly with the
 * TypeScript spy attached, so the assertions can be about specific functions —
 * "building a connect preview makes no call" is a claim about
 * `buildConnectPreview`, not about a process.
 *
 * ## Nothing here starts `wrangler`
 *
 * *"`wrangler dev` defaults to remote execution … a script that starts a dev
 * Worker without `--local` reaches Cloudflare, runs against real
 * infrastructure, and does it silently."* This lane's tests never invoke
 * `wrangler` at all, in any mode. The Worker's own suite lives in `worker/` with
 * its own runner and is not collected here.
 */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { describeViolations, installNetworkSpy, isExempt } from "./fixtures/network-spy.js";

const REPO_ROOT = process.cwd();
const PRELOAD = join(REPO_ROOT, "test", "fixtures", "network-spy-preload.mjs");
/**
 * ABSOLUTE, both of them.
 *
 * Every scenario below runs with `cwd` set to a temporary workspace so that the
 * CLI discovers it by walking up, which is how a human runs it. Relative entry
 * paths resolve against that cwd, so `node_modules/tsx/dist/cli.mjs` pointed at
 * the temporary directory and the child died with `ERR_MODULE_NOT_FOUND` before
 * executing a line of staple.
 *
 * That failure mode is worth a comment because of how it presented: a crashed
 * child makes no network call, so every "attempts no network call" assertion
 * PASSED, and the suite was green while proving nothing at all. Which is why
 * `staple()` now asserts the child actually ran — a network-silence test whose
 * subject never started is the same category of lie as a spy that never
 * installed, and it deserves the same guard.
 */
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const MCP = join(REPO_ROOT, "src", "mcp.ts");

let home: string;
let repoDir: string;
let dbPath: string;
let logPath: string;

/**
 * One CLI invocation, with the spy in the child.
 *
 * `--import` rather than `--require`: the preload is ESM, and it has to be in
 * place before tsx registers its loader so that a module which captured `fetch`
 * at import time captured the patched one.
 */
function staple(args: string[], extraEnv: Record<string, string> = {}) {
  rmSync(logPath, { force: true });
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
    env: {
      ...process.env,
      STAPLE_HOME: home,
      STAPLE_AGENT: "network-silence",
      NODE_NO_WARNINGS: "1",
      NODE_OPTIONS: `--import ${JSON.stringify(PRELOAD)}`,
      STAPLE_NETWORK_SPY_LOG: logPath,
      ...extraEnv,
    },
    encoding: "utf8",
    cwd: repoDir,
  });
  const violations = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  const stderr = result.stderr ?? "";

  /**
   * The child has to have RUN. A process that died in the module loader, or that
   * never started at all, makes no network call — so without this guard a broken
   * invocation is indistinguishable from a silent one, and the whole file passes
   * while testing nothing.
   */
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION/.test(stderr)) {
    throw new Error(`the CLI child never started, so its silence proves nothing:\n${stderr}`);
  }
  if (result.error) throw result.error;

  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr, violations };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-netsilence-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-netsilence-repo-"));
  logPath = join(home, "violations.ndjson");
  process.env.STAPLE_HOME = home;

  // A repo-local workspace, so it gets a `.staple/repository.json` — the sync
  // identity every cloud command resolves through.
  mkdirSync(join(repoDir, ".staple"), { recursive: true });
  const ws = initWorkspace({ dir: repoDir, slug: "netsilence" });
  dbPath = ws.dbPath;
  ws.store.createIssue({ title: "a task", assignee: "network-silence" });
  ws.store.db.close();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

// -------------------------------------------------------- the harness itself

describe("the spy, before it is trusted to prove anything", () => {
  it("records and throws on a non-loopback call — the contract's self-check", () => {
    const spy = installNetworkSpy();
    try {
      // This IS the self-check: it makes a sentinel call and asserts the spy saw
      // it. A network-silence test that passes because the spy never attached is
      // worse than no test.
      expect(() => spy.selfCheck()).not.toThrow();
    } finally {
      spy.restore();
    }
  });

  it("treats loopback, unix sockets and 127.0.0.0/8 as not egress", () => {
    for (const exempt of ["127.0.0.1", "127.0.0.2", "::1", "localhost", "/tmp/staple.sock"]) {
      expect(isExempt(exempt)).toBe(true);
    }
    for (const egress of ["example.com", "1.1.1.1", "staple-sync-dev.vptkvc.workers.dev"]) {
      expect(isExempt(egress)).toBe(false);
    }
  });

  it("catches a real fetch to a real hostname, so zero means zero", () => {
    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      expect(() => void fetch("https://example.com/")).toThrow(/network-silence violation/);
      expect(spy.violations).toHaveLength(1);
      expect(spy.violations[0]!.destination).toBe("example.com");
    } finally {
      spy.restore();
    }
  });

  it("catches a DNS lookup, because an attempt is a violation even when it fails", async () => {
    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      const dns = await import("node:dns");
      expect(() => dns.default.lookup("example.com", () => {})).toThrow(/network-silence violation/);
      expect(spy.violations.some((v) => v.member === "lookup")).toBe(true);
    } finally {
      spy.restore();
    }
  });

  it("is installed in the CHILD too — a subprocess cannot hide a call", () => {
    // Proves the preload attaches, using the same sentinel discipline. Without
    // this, every subprocess assertion below could be passing because the child
    // never had a spy at all.
    rmSync(logPath, { force: true });
    const probe = spawnSync(
      process.execPath,
      ["-e", "fetch('https://spy-preload-check.invalid/').catch(() => {})"],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${JSON.stringify(PRELOAD)}`,
          STAPLE_NETWORK_SPY_LOG: logPath,
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
      },
    );
    expect(probe.status).not.toBe(0);
    expect(readFileSync(logPath, "utf8")).toContain("spy-preload-check.invalid");
  });
});

// ------------------------------------------ the scenarios that must assert zero

/**
 * *"Disconnected, on a workspace with no `repository.json` and no credential"* —
 * the contract's list, minus the ones this lane cannot exercise honestly and
 * plus the cloud commands that are supposed to be silent.
 *
 * `install` and `migrate` are omitted deliberately rather than quietly: both
 * mutate a home or move a database, and running them here would be testing those
 * lanes' behaviour rather than network silence. They are covered by the same
 * preload the moment somebody adds them, which is the point of the harness being
 * an environment variable rather than a bespoke runner.
 */
const DISCONNECTED_SCENARIOS: Array<[name: string, args: string[]]> = [
  ["ls", ["ls"]],
  ["ls --json", ["ls", "--json"]],
  ["new", ["new", "silent task"]],
  ["show", ["show", "NET-1"]],
  ["status", ["status", "NET-1", "in_progress"]],
  ["checkout", ["checkout", "NET-1", "--agent", "netsilence"]],
  ["release", ["release", "NET-1"]],
  ["comment", ["comment", "NET-1", "a comment"]],
  ["queue", ["queue"]],
  ["inbox", ["inbox"]],
  ["events", ["events"]],
  ["tree", ["tree"]],
  ["board", ["board"]],
  ["doctor", ["doctor"]],
  ["hub ls", ["hub", "ls"]],
  ["settings ls", ["settings", "ls"]],
  ["config show", ["config", "show"]],
  ["help", ["help"]],
  ["cloud status", ["cloud", "status"]],
  ["cloud status --json", ["cloud", "status", "--json"]],
  ["cloud --help", ["cloud", "--help"]],
  /**
   * `cloud sync` IS allowed to call out — on a connected repository. On a
   * disconnected one it must refuse from local files alone, which is the
   * interesting case: a sync command that resolved the endpoint before checking
   * whether there was a connection would break the invariant on the machine
   * least likely to be watching.
   */
  ["cloud sync", ["cloud", "sync"]],
  ["cloud sync --json", ["cloud", "sync", "--json"]],
  /**
   * `cloud lease status` reads the mirror and the connection record and is
   * silent on both sides of the wire, connected or not.
   *
   * `cloud lease acquire` is the interesting one. On a DISCONNECTED repository
   * it must succeed — offline acquisition is allowed, because refusing to work
   * without a network would be a worse tracker — and it must do so without
   * resolving an endpoint or reading a credential, because there is neither.
   * A version of it that resolved the connection after taking the lease, or
   * that probed to decide which path to take, would break the invariant in the
   * exact place nobody would look for it.
   */
  ["cloud lease", ["cloud", "lease"]],
  ["cloud lease status --json", ["cloud", "lease", "status", "--json"]],
  ["cloud lease acquire", ["cloud", "lease", "acquire", "NET-1", "--agent", "netsilence"]],
  ["cloud lease release", ["cloud", "lease", "release", "NET-1"]],
  /**
   * Backup and restore, for the same reason as `cloud sync` and one more.
   *
   * On a disconnected repository they refuse from local files alone. But backup
   * is also a THIRD consent, so even on a connected machine these commands must
   * not reach the network until it has been given — a device that probed the
   * service to find out whether it was allowed to back up would have made the
   * request the consent exists to authorize. The connected-but-not-consented
   * half of that is asserted directly in `test/cloud-backup-restore.test.ts`
   * against the call log; this half is the harness's, on the machine least
   * likely to be watching.
   */
  ["cloud backup", ["cloud", "backup"]],
  ["cloud backup ls", ["cloud", "backup", "ls"]],
  ["cloud backup ls --json", ["cloud", "backup", "ls", "--json"]],
  ["cloud backup create", ["cloud", "backup", "create"]],
  ["cloud backup enable", ["cloud", "backup", "enable"]],
  ["cloud backup disable", ["cloud", "backup", "disable"]],
  ["cloud restore", ["cloud", "restore", "some-backup-id"]],
];

describe("disconnected: every ordinary command makes zero outbound calls", () => {
  /**
   * The anchor for the loop below.
   *
   * Every other test in it asserts an ABSENCE, and an absence is exactly what a
   * command that never ran also produces. This one asserts a presence — the
   * seeded issue, through the real CLI, in the real workspace — so that "zero
   * violations" in the rest of the loop means "staple ran and stayed silent"
   * rather than "nothing happened".
   */
  it("the harness runs the real CLI against the real workspace", () => {
    const result = staple(["ls"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("a task");
  });

  for (const [name, args] of DISCONNECTED_SCENARIOS) {
    it(`${name} attempts no network call`, () => {
      const result = staple(args);
      expect(
        result.violations,
        `${name} attempted: ${JSON.stringify(result.violations, null, 2)}`,
      ).toHaveLength(0);
    });
  }

  it("an MCP initialize handshake attempts no network call", () => {
    rmSync(logPath, { force: true });
    const handshake = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`;

    const result = spawnSync(process.execPath, [TSX, MCP], {
      input: handshake,
      env: {
        ...process.env,
        STAPLE_HOME: home,
        STAPLE_DB: dbPath,
        NODE_NO_WARNINGS: "1",
        NODE_OPTIONS: `--import ${JSON.stringify(PRELOAD)}`,
        STAPLE_NETWORK_SPY_LOG: logPath,
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.stdout).toContain("cloud_status");
    expect(existsSync(logPath) ? readFileSync(logPath, "utf8") : "").toBe("");
  });
});

describe("connected in manual mode: still zero", () => {
  /**
   * *"Connected in manual mode, the same list asserts zero. Only `staple cloud
   * sync`, `staple cloud connect`, `staple cloud status --refresh` and the
   * explicitly named backup and purge commands may call out."*
   *
   * The connection is forged directly — a record and a credential file — rather
   * than by connecting for real, because connecting for real would require a
   * server and this test is about what happens when there ISN'T one being
   * talked to.
   */
  beforeAll(() => {
    const manifest = JSON.parse(readFileSync(join(repoDir, ".staple", "repository.json"), "utf8")) as {
      repositoryId: string;
    };
    const dir = join(home, "cloud");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${manifest.repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
    writeFileSync(
      join(dir, `${manifest.repositoryId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        repositoryId: manifest.repositoryId,
        endpoint: "https://staple-sync-dev.example.workers.dev",
        deviceId: "11111111-2222-3333-4444-555555555555",
        label: "test device",
        credentialMechanism: "file",
        connectedAt: new Date().toISOString(),
        auto: false,
        backup: false,
        protocol: 1,
      }),
      { mode: 0o600 },
    );

    /**
     * A lease this device holds, written straight into the mirror.
     *
     * Acquiring one for real would need a service, and this suite is about what
     * happens when there ISN'T one being talked to — the same reasoning as the
     * forged connection above. The row is what makes the everyday-verb
     * assertions below meaningful: without it, "checkout made no call" could be
     * true simply because there was no lease to consult.
     */
    const db = new DatabaseSync(dbPath);
    try {
      const issue = db.prepare("SELECT id FROM issues WHERE identifier = 'NET-1'").get() as
        | { id: string }
        | undefined;
      if (issue) {
        db.prepare(
          `INSERT INTO sync_leases
             (entity_id, fencing_token, holder, device_id, server_expires_at, acquired_at, renewed_at)
           VALUES (?, 1, 'netsilence', '11111111-2222-3333-4444-555555555555', ?, ?, NULL)
           ON CONFLICT (entity_id) DO NOTHING`,
        ).run(issue.id, "2099-01-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
      }
    } finally {
      db.close();
    }
  });

  for (const [name, args] of [
    ["ls", ["ls"]],
    ["show", ["show", "NET-1"]],
    ["checkout", ["checkout", "NET-1", "--agent", "netsilence"]],
    ["release", ["release", "NET-1"]],
    ["inbox", ["inbox"]],
    ["doctor", ["doctor"]],
    ["cloud status", ["cloud", "status"]],
    ["cloud status --json", ["cloud", "status", "--json"]],
    ["cloud auto on", ["cloud", "auto", "on"]],
    ["cloud auto off", ["cloud", "auto", "off"]],
    /**
     * The everyday verbs, on a repository that is connected AND on which this
     * device holds a lease (the mirror row is seeded below). This is the
     * assertion the lease lane most needs: *"Do not make local checkout depend
     * on a lease being reachable — that would put a network call on an everyday
     * verb"*. A `checkout` that validated the lease, or a `done` that released
     * it, would show up right here.
     */
    ["done", ["done", "NET-1"]],
    ["cloud lease status", ["cloud", "lease", "status"]],
    ["cloud lease status --json", ["cloud", "lease", "status", "--json"]],
  ] as Array<[string, string[]]>) {
    it(`${name} on a CONNECTED repository attempts no network call`, () => {
      const result = staple(args);
      expect(
        result.violations,
        `${name} attempted: ${JSON.stringify(result.violations, null, 2)}`,
      ).toHaveLength(0);
    });
  }

  it("cloud status reports connected-manual without having asked anyone", () => {
    const result = staple(["cloud", "status", "--json"]);
    expect(result.violations).toHaveLength(0);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const status = JSON.parse(result.stdout) as { state: string; checked: boolean };
    expect(status.state).toBe("manual");
    expect(status.checked).toBe(false);
  });

  it("cloud disconnect is local: it removes the credential with no request at all", () => {
    const result = staple(["cloud", "disconnect", "--yes"]);
    expect(result.violations).toHaveLength(0);
    expect(result.status).toBe(0);
    expect(staple(["cloud", "status", "--json"]).stdout).toContain('"state": "disconnected"');
  });
});

// ---------------------------------------------------- the pre-consent boundary

describe("connect: nothing leaves the machine before consent", () => {
  let spy: ReturnType<typeof installNetworkSpy> | null = null;

  afterEach(() => {
    spy?.restore();
    spy = null;
  });

  it("building the preview makes no call, and the preview module cannot make one", async () => {
    spy = installNetworkSpy();
    spy.selfCheck();

    const { buildConnectPreview, renderConnectPreview } = await import("../src/core/cloud/preview.js");
    const preview = buildConnectPreview({
      home,
      repositoryId: "0e77fa01-1111-2222-3333-444444444444",
      endpoint: "https://staple-sync-dev.example.workers.dev",
      credential: { forceFile: true },
    });

    expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    // The preview is the consent mechanism, so it has to actually say the things
    // consent is being given to.
    const rendered = renderConnectPreview(preview);
    expect(rendered).toContain("staple-sync-dev.example.workers.dev");
    expect(rendered).toContain("0e77fa01-1111-2222-3333-444444444444");
    expect(rendered).toContain("AUTOMATIC SYNC STAYS OFF");
    expect(rendered).toContain("Nothing has been sent yet");
  });

  it("`cloud connect` without --yes and without a terminal previews, exits 2, and sends nothing", () => {
    const result = staple([
      "cloud",
      "connect",
      "--endpoint",
      "https://staple-sync-dev.example.workers.dev",
      "--token",
      "enrollment-secret",
    ]);

    expect(result.violations, JSON.stringify(result.violations, null, 2)).toHaveLength(0);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("staple-sync-dev.example.workers.dev");
    expect(result.stdout).toContain("AUTOMATIC SYNC STAYS OFF");
    expect(result.stderr).toContain("Nothing was sent");
  });

  it("a declined connect leaves no credential, no record and no cloud directory entry", () => {
    const manifest = JSON.parse(readFileSync(join(repoDir, ".staple", "repository.json"), "utf8")) as {
      repositoryId: string;
    };
    // The previous test already declined. Assert the absence, which is the
    // clause "a declined connect leaves no credential, no config key and no
    // server-side record".
    expect(existsSync(join(home, "cloud", `${manifest.repositoryId}.json`))).toBe(false);
    expect(existsSync(join(home, "cloud", `${manifest.repositoryId}.token`))).toBe(false);
  });

  it("an invalid endpoint is refused without a lookup — parsing, never resolving", async () => {
    spy = installNetworkSpy();
    spy.selfCheck();
    const { parseEndpoint } = await import("../src/core/cloud/endpoint.js");

    expect(() => parseEndpoint("http://sync.example.com")).toThrow(/must be https/);
    expect(() => parseEndpoint("https://user:pw@sync.example.com")).toThrow(/username or password/);
    expect(() => parseEndpoint("not a url")).toThrow(/is not a URL/);
    // A VALID endpoint is parsed too — the point is that even the good path
    // resolves nothing.
    expect(parseEndpoint("https://sync.example.com/").origin).toBe("https://sync.example.com");
    expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
  });

  it("localCloudStatus never calls out, on any state, including a connected one", async () => {
    spy = installNetworkSpy();
    spy.selfCheck();
    const { localCloudStatus } = await import("../src/core/cloud/status.js");

    const scratch = mkdtempSync(join(tmpdir(), "staple-netsilence-status-"));
    try {
      expect(localCloudStatus(scratch, "aaaaaaaa-1111-2222-3333-444444444444").state).toBe("disconnected");

      const dir = join(scratch, "cloud");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = "bbbbbbbb-1111-2222-3333-444444444444";
      writeFileSync(join(dir, `${id}.token`), "stpl_fake\n", { mode: 0o600 });
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          schemaVersion: 1,
          repositoryId: id,
          endpoint: "https://sync.example.com",
          deviceId: "dddddddd-1111-2222-3333-444444444444",
          label: null,
          credentialMechanism: "file",
          connectedAt: new Date().toISOString(),
          auto: true,
          backup: false,
          protocol: 1,
        }),
        { mode: 0o600 },
      );
      expect(localCloudStatus(scratch, id).state).toBe("automatic");
      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------- the UI, actually served

/**
 * The half of the invariant this suite never covered: **the page.**
 *
 * Everything above drives the CLI in a subprocess or calls a cloud module
 * directly. Neither reaches `src/ui/server.ts`, so until now the assertion
 * *"Fresh installs and unconnected workspaces make zero Staple-owned DNS socket
 * or HTTP calls"* was proved for the command line and merely believed for the
 * browser — which is the surface with a poll loop on it, and therefore the one
 * where an accidental heartbeat would be continuous rather than once.
 *
 * The gap mattered more after STA-75, because the page now reads
 * `/api/cloud/status` on mount. That route is network-free by construction — it
 * has no `refresh` parameter and `localCloudStatus` cannot be made to call out —
 * but "by construction" is a claim, and this is the thing that checks it.
 *
 * Loopback is not egress: `network-spy.ts` classifies `127.0.0.0/8` as exempt,
 * which is what makes it honest to drive a real server over a real socket here
 * and still assert zero. The spy sees the server's OWN outbound calls, of which
 * there must be none.
 */
describe("the UI server serves the whole page, connected or not, and calls nobody", () => {
  let spy: ReturnType<typeof installNetworkSpy> | null = null;

  afterEach(() => {
    spy?.restore();
    spy = null;
  });

  it("answers every route an open page hits, repeatedly, with zero outbound calls", async () => {
    spy = installNetworkSpy();
    // The self-check first: an assertion of zero from a spy that never installed
    // is the same lie as a scenario whose subject never ran.
    spy.selfCheck();

    // `src/ui/server.js` is imported dynamically so the spy is installed before a
    // line of it is evaluated, the same discipline the cloud modules above use.
    const { startUiServer } = await import("../src/ui/server.js");

    const uiHome = mkdtempSync(join(tmpdir(), "staple-netsilence-ui-home-"));
    const uiRepo = mkdtempSync(join(tmpdir(), "staple-netsilence-ui-repo-"));
    const previousHome = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = uiHome;

    let ui: { server: import("node:http").Server; token: string; close: () => void } | null = null;
    try {
      const ws = initWorkspace({ dir: uiRepo, slug: "netsilenceui" });
      ws.store.createIssue({ title: "a task", assignee: "netsilence" });
      ws.store.db.close();

      ui = startUiServer({ port: 0, hub: false, db: join(uiRepo, ".staple", "staple.db") });
      await once(ui.server, "listening");
      const port = (ui.server.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      const token = ui.token;

      /**
       * Everything a freshly opened tab asks for, in the order it asks. The poll
       * routes are hit repeatedly rather than once: a heartbeat that fired on
       * every Nth poll rather than on the first would pass a single-shot check,
       * and a poll loop is exactly where such a thing would hide.
       */
      const ROUTES = [
        "/api/bootstrap",
        "/api/cloud/status",
        "/api/cloud/conflicts",
        "/api/issues",
        "/api/inbox",
        "/api/queue",
        "/api/settings",
        "/api/poll",
      ];

      for (let round = 0; round < 3; round += 1) {
        for (const route of ROUTES) {
          const res = await fetch(`${origin}${route}`, { headers: { "x-staple-token": token } });
          expect(res.status, `${route} answered ${res.status}`).toBe(200);
          await res.json();
        }
      }

      /**
       * S13 (STA-258): the cloud MUTATION routes, on a workspace that has no
       * connection. These are the ones a settings panel reaches, and every one of
       * them must be silent here — three of them because they only ever touch
       * local files, and three of them (`devices`, `devices/revoke`, `connect`)
       * because on a DISCONNECTED repository they must refuse from local files
       * alone. That last group is the interesting one: a devices route that
       * resolved the endpoint before checking whether there was a connection
       * would break the invariant on the machine least likely to be watching,
       * which is exactly the failure mode `cloud sync` is on this list for.
       *
       * The status codes are not asserted (they are `test/ui-cloud-settings.test.ts`'s
       * job); what is asserted is that answering them attempted nothing.
       */
      const CLOUD_WRITES: Array<[string, Record<string, unknown>]> = [
        ["/api/cloud/connect/preview", { endpoint: "https://sync.example.com", credentialFile: true }],
        ["/api/cloud/connect", { endpoint: "https://sync.example.com", token: "enrollment-secret" }],
        ["/api/cloud/connect", { consent: "made-up", digest: "made-up", token: "enrollment-secret" }],
        ["/api/cloud/consent", { auto: true }],
        ["/api/cloud/consent", { backup: true }],
        ["/api/cloud/disconnect", { confirm: true }],
        ["/api/cloud/devices", {}],
        ["/api/cloud/devices/revoke", { deviceId: "someone-else", confirm: true }],
      ];
      for (let round = 0; round < 3; round += 1) {
        for (const [route, body] of CLOUD_WRITES) {
          const res = await fetch(`${origin}${route}`, {
            method: "POST",
            headers: { "x-staple-token": token, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          await res.json();
        }
      }

      // The anchor: the server really served, so "zero violations" means "it ran
      // and stayed silent" rather than "nothing happened".
      const status = (await (
        await fetch(`${origin}/api/cloud/status`, { headers: { "x-staple-token": token } })
      ).json()) as { state: string; hint: string | null };
      expect(status.state).toBe("disconnected");
      expect(status.hint).toBe("staple cloud connect");

      // A second anchor for the writes above: previewing a connection really does
      // produce a preview, so their silence is a silence with a subject.
      const previewed = (await (
        await fetch(`${origin}/api/cloud/connect/preview`, {
          method: "POST",
          headers: { "x-staple-token": token, "content-type": "application/json" },
          body: JSON.stringify({ endpoint: "https://sync.example.com", credentialFile: true }),
        })
      ).json()) as { preview: { endpoint: { origin: string } }; consent: { id: string } };
      expect(previewed.preview.endpoint.origin).toBe("https://sync.example.com");
      expect(previewed.consent.id).toBeTruthy();

      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      ui?.close();
      if (previousHome === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previousHome;
      rmSync(uiHome, { recursive: true, force: true });
      rmSync(uiRepo, { recursive: true, force: true });
    }
  });

  /**
   * The other half, and the harder one: **connected in manual mode.**
   *
   * *"Connected in manual mode, the same list asserts zero. Only `staple cloud
   * sync`, `staple cloud connect`, `staple cloud status --refresh` and the
   * explicitly named backup and purge commands may call out."* The subprocess
   * section above asserts that for the CLI; this asserts it for the page, which is
   * where it is easier to lose — a connected settings panel is exactly the surface
   * somebody would "improve" by refreshing the device list on open, or by probing
   * reachability so the status could be shown in colour.
   *
   * `/api/cloud/devices` and `/api/cloud/devices/revoke` are DELIBERATELY absent
   * from the list below. They are the two routes that are supposed to egress, and
   * putting them here would either fail honestly or force an exemption that would
   * then quietly cover something else. What holds them is
   * `test/ui-cloud-settings.test.ts`, which drives a fake service on loopback and
   * asserts against its request log that nothing else reaches it — including that
   * reading `/api/cloud/status` does not.
   */
  it("stays silent on a CONNECTED workspace too, across every route the page can reach", async () => {
    spy = installNetworkSpy();
    spy.selfCheck();

    const { startUiServer } = await import("../src/ui/server.js");

    const uiHome = mkdtempSync(join(tmpdir(), "staple-netsilence-uic-home-"));
    const uiRepo = mkdtempSync(join(tmpdir(), "staple-netsilence-uic-repo-"));
    const previousHome = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = uiHome;

    let ui: { server: import("node:http").Server; token: string; close: () => void } | null = null;
    try {
      const ws = initWorkspace({ dir: uiRepo, slug: "netsilenceuic" });
      ws.store.createIssue({ title: "a task", assignee: "netsilence" });
      ws.store.db.close();

      // Forged, for the reason the CLI half forges: connecting for real would
      // need a server, and this is about what happens when there ISN'T one being
      // talked to.
      const manifest = JSON.parse(readFileSync(join(uiRepo, ".staple", "repository.json"), "utf8")) as {
        repositoryId: string;
      };
      const dir = join(uiHome, "cloud");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${manifest.repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
      writeFileSync(
        join(dir, `${manifest.repositoryId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          repositoryId: manifest.repositoryId,
          endpoint: "https://staple-sync-dev.example.workers.dev",
          deviceId: "11111111-2222-3333-4444-555555555555",
          label: "test device",
          credentialMechanism: "file",
          connectedAt: new Date().toISOString(),
          auto: false,
          backup: false,
          protocol: 1,
        }),
        { mode: 0o600 },
      );

      ui = startUiServer({ port: 0, hub: false, db: join(uiRepo, ".staple", "staple.db") });
      await once(ui.server, "listening");
      const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
      const token = ui.token;
      const headers = { "x-staple-token": token, "content-type": "application/json" };

      for (let round = 0; round < 3; round += 1) {
        for (const route of ["/api/cloud/status", "/api/cloud/conflicts", "/api/settings", "/api/poll"]) {
          const res = await fetch(`${origin}${route}`, { headers });
          expect(res.status, `${route} answered ${res.status}`).toBe(200);
          await res.json();
        }
        /**
         * Turning a consent on and off is a local file write and must say nothing
         * to anybody — a device that told the service it had enabled automatic
         * sync would be making a request BEFORE the sync the consent authorizes.
         * And previewing a re-connect, on a machine that is already connected, is
         * still local: the preview names the existing endpoint in its
         * `existingEndpoint` field without ever resolving it.
         */
        for (const [route, body] of [
          ["/api/cloud/consent", { auto: true }],
          ["/api/cloud/consent", { auto: false }],
          ["/api/cloud/consent", { backup: true }],
          ["/api/cloud/consent", { backup: false }],
          ["/api/cloud/connect/preview", { endpoint: "https://elsewhere.example", credentialFile: true }],
        ] as Array<[string, Record<string, unknown>]>) {
          const res = await fetch(`${origin}${route}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          expect(res.status, `${route} answered ${res.status}`).toBe(200);
          await res.json();
        }
      }

      // The anchor: the server really was connected while all of that happened.
      const status = (await (await fetch(`${origin}/api/cloud/status`, { headers })).json()) as {
        state: string;
        checked: boolean;
      };
      expect(status.state).toBe("manual");
      expect(status.checked).toBe(false);

      /**
       * And disconnect, last, because it is the one write on a connected
       * repository whose whole contract is that it does NOT tell the service:
       * *"a person who has decided to stop talking to a service must not need
       * that service's permission to stop."*
       */
      const off = (await (
        await fetch(`${origin}/api/cloud/disconnect`, {
          method: "POST",
          headers,
          body: JSON.stringify({ confirm: true }),
        })
      ).json()) as { wasConnected: boolean; report: { state: string } };
      expect(off.wasConnected).toBe(true);
      expect(off.report.state).toBe("disconnected");

      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      ui?.close();
      if (previousHome === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previousHome;
      rmSync(uiHome, { recursive: true, force: true });
      rmSync(uiRepo, { recursive: true, force: true });
    }
  });
});
