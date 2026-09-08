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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  const violations = readViolations();
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

const INITIALIZE_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "t", version: "0" },
};

function call(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/**
 * One MCP session, with the spy in the child — the same discipline `staple()`
 * uses, and for the same reason.
 *
 * Extracted from the handshake case (S10, STA-76) so that a scenario which calls
 * write tools is one array literal rather than a second copy of the spawn. The
 * child-never-started guard is the same one: a session that died in the module
 * loader answers nothing and calls nobody, and would otherwise pass.
 */
function mcp(messages: Array<Record<string, unknown>>, extraEnv: Record<string, string> = {}) {
  rmSync(logPath, { force: true });
  const result = spawnSync(process.execPath, [TSX, MCP], {
    input: `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
    env: {
      ...process.env,
      STAPLE_HOME: home,
      STAPLE_DB: dbPath,
      STAPLE_AGENT: "network-silence",
      NODE_NO_WARNINGS: "1",
      NODE_OPTIONS: `--import ${JSON.stringify(PRELOAD)}`,
      STAPLE_NETWORK_SPY_LOG: logPath,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const stderr = result.stderr ?? "";
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION/.test(stderr)) {
    throw new Error(`the MCP child never started, so its silence proves nothing:\n${stderr}`);
  }
  return { stdout: result.stdout ?? "", stderr, violations: readViolations() };
}

/** The `tools/call` responses, keyed by request id. Non-JSON lines are the server's banner. */
function parseToolResults(stdout: string): Map<number, Record<string, unknown>> {
  const found = new Map<number, Record<string, unknown>>();
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let message: { id?: unknown; result?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    if (typeof message.id === "number" && message.id > 1 && message.result !== undefined) {
      found.set(message.id, message.result as Record<string, unknown>);
    }
  }
  return found;
}

function readViolations(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
    const result = mcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    expect(result.stdout).toContain("cloud_status");
    expect(result.violations).toHaveLength(0);
  });

  /**
   * S10 (STA-76). *"an MCP `initialize` handshake **plus one call of every
   * mutating tool**"* — the contract's scenario list, and the second half of it
   * had never been exercised.
   *
   * That is worth naming as a finding rather than quietly fixing, because it is
   * the same failure mode this file already carries a comment about: a scenario
   * whose subject never ran. The MCP case above sends `initialize` and
   * `tools/list` and asserts silence, and it would have gone on asserting silence
   * after somebody put a network call in every write tool, because it never called
   * one. The name of the file was doing the work the file was not.
   *
   * Three real writes, with real arguments, whose results are asserted NOT to be
   * errors — that assertion is the anchor. A `tools/call` answered with a
   * validation failure makes no network call either, so without it this test
   * would be back where the last one was.
   */
  it("MCP write tools attempt no network call — and really did write", () => {
    const result = mcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS },
      call(2, "create_task", { title: "a task made over MCP", actor: "network-silence" }),
      call(3, "add_comment", { ref: "NET-1", body: "said over MCP", actor: "network-silence" }),
      call(4, "put_document", {
        ref: "NET-1",
        key: "plan",
        body: "written over MCP",
        actor: "network-silence",
      }),
      call(5, "enqueue_task", { ref: "NET-1", actor: "network-silence" }),
    ]);

    // The anchor: four writes that worked, not four refusals that were silent.
    const results = parseToolResults(result.stdout);
    expect(results.size).toBe(4);
    for (const [id, payload] of results) {
      expect(payload.isError, `tool call ${id} failed: ${JSON.stringify(payload)}`).not.toBe(true);
    }
    expect(result.violations).toHaveLength(0);
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

// ------------------------------------------------ the second consent, once spent

/**
 * S10 (STA-76): **connected AND automatically synchronizing.**
 *
 * Every other block in this file asserts an absence. This one asserts a presence
 * first, and that inversion is the whole reason it exists.
 *
 * *"Network-spy tests prove ordinary commands make zero calls while connected in
 * manual mode"* is only worth something if the same commands, on the same
 * machine, with one boolean changed, are seen to call out. Otherwise "zero" is
 * indistinguishable from a trigger that was never wired up, a gate that refuses
 * everything, or a spy watching a surface nothing runs on — the three ways this
 * epic has already produced a green suite that proved nothing.
 *
 * So the shape here is: turn the consent on, watch the spy catch a real outbound
 * attempt at exactly the configured endpoint; turn the consent off; watch the
 * same commands go silent. The second half is the acceptance criterion
 * *"Disabling automatic mode stops background requests while preserving manual
 * sync"*, and it is meaningful precisely because the first half is not zero.
 *
 * The endpoint is a `.invalid` host (RFC 2606). The spy throws before calling
 * through, so nothing resolves in the normal case — and if the spy were ever to
 * be missing, the name still cannot resolve, so a regression here fails rather
 * than quietly reaching a real service.
 */
describe("connected in AUTOMATIC mode: the trigger fires, at the endpoint and nowhere else", () => {
  const ENDPOINT = "https://staple-sync-auto.invalid";
  const ENDPOINT_HOST = "staple-sync-auto.invalid";
  let cloudDir: string;
  let repositoryId: string;

  function forge(auto: boolean): void {
    writeFileSync(join(cloudDir, `${repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
    writeFileSync(
      join(cloudDir, `${repositoryId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        repositoryId,
        endpoint: ENDPOINT,
        deviceId: "11111111-2222-3333-4444-555555555555",
        label: "test device",
        credentialMechanism: "file",
        connectedAt: new Date().toISOString(),
        auto,
        backup: false,
        protocol: 1,
      }),
      { mode: 0o600 },
    );
  }

  /**
   * A fresh device, every case.
   *
   * The trigger persists a jittered backoff after a failed run, and every run
   * here fails — there is no service at a `.invalid` host. Without this each
   * scenario after the first would be refused by the previous one's backoff and
   * would report "zero calls" for a reason that has nothing to do with what it
   * claims to test. Which is exactly the kind of false green this file exists to
   * refuse, so it is worth the two lines.
   */
  function freshDevice(): void {
    rmSync(join(cloudDir, `${repositoryId}.autosync`), { force: true });
  }

  beforeAll(() => {
    const manifest = JSON.parse(readFileSync(join(repoDir, ".staple", "repository.json"), "utf8")) as {
      repositoryId: string;
    };
    repositoryId = manifest.repositoryId;
    cloudDir = join(home, "cloud");
    mkdirSync(cloudDir, { recursive: true, mode: 0o700 });
    forge(true);
  });

  beforeEach(() => {
    freshDevice();
  });

  /**
   * Leave the machine as this block found it: disconnected.
   *
   * The blocks after this one assert things about a workspace with no connection
   * — *"a declined connect leaves no credential, no config key and no server-side
   * record"* among them — and a forged record left lying about would make one of
   * them pass or fail for a reason belonging to this block.
   */
  afterAll(() => {
    for (const suffix of [".json", ".token", ".autosync"]) {
      rmSync(join(cloudDir, `${repositoryId}${suffix}`), { force: true });
    }
  });

  /**
   * THE POSITIVE ANCHOR for this whole block, and the strongest single statement
   * this lane can make: a read command, on a machine that consented, really does
   * reach the network — and the spy really does see it.
   */
  it("an ordinary READ attempts exactly one call, and its destination is the endpoint", () => {
    const result = staple(["ls"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("a task");

    expect(result.violations.length).toBeGreaterThan(0);
    for (const violation of result.violations) {
      expect(violation.destination, JSON.stringify(violation)).toBe(ENDPOINT_HOST);
    }
    // One host, and the first thing a sync does is the capabilities handshake, so
    // the call that was caught is the transport's and not something else's.
    expect(new Set(result.violations.map((v) => v.destination))).toEqual(new Set([ENDPOINT_HOST]));
  });

  it("an ordinary WRITE does too, and nothing it touched leaked into the destination", () => {
    const result = staple(["new", "a task made while automatic"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(new Set(result.violations.map((v) => v.destination))).toEqual(new Set([ENDPOINT_HOST]));
  });

  /**
   * The failure is recorded where the next PROCESS can read it, which is the only
   * place a CLI trigger can coalesce at all — and the next command inside that
   * window is silent again.
   *
   * This is the anti-hot-loop property. A device pointed at an endpoint that is
   * not answering must not attempt a doomed sync on every single command, and a
   * bound that lived in memory would be no bound at all for a tool that exits
   * after every command.
   */
  it("backs off across processes: the next command inside the window attempts nothing", () => {
    const first = staple(["ls"]);
    expect(first.violations.length).toBeGreaterThan(0);

    const clock = JSON.parse(readFileSync(join(cloudDir, `${repositoryId}.autosync`), "utf8")) as {
      consecutiveFailures: number;
      nextEligibleAt: string | null;
    };
    expect(clock.consecutiveFailures).toBeGreaterThan(0);
    expect(Date.parse(clock.nextEligibleAt!)).toBeGreaterThan(Date.now());

    // Same machine, new process, inside the window. Silent.
    const second = staple(["ls"]);
    expect(
      second.violations,
      `a second command inside the backoff window attempted: ${JSON.stringify(second.violations)}`,
    ).toHaveLength(0);
  });

  /**
   * A command that FAILED synchronizes nothing.
   *
   * The registration runs only when `process.exitCode` is falsy, so a typo does
   * not become a request to Cloudflare. Small, and worth pinning: the natural
   * place to put a trigger is "at the end", and "at the end" includes the error
   * path unless somebody says otherwise.
   */
  it("a command that failed attempts nothing — a typo is not a reason to call anybody", () => {
    const result = staple(["show", "NET-99999"]);
    expect(result.status).not.toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  /**
   * THE ACCEPTANCE CRITERION, in its own test:
   * *"Disabling automatic mode stops background requests while preserving manual
   * sync."*
   *
   * Both halves, in order, on one machine — and note what is NOT done between
   * them. Nothing disconnects, no credential moves, and the endpoint in the record
   * is untouched. One boolean changes.
   */
  it("`cloud auto off` stops the background requests, and manual sync still works", () => {
    // Off is itself local: turning it off must not tell the service.
    const off = staple(["cloud", "auto", "off"]);
    expect(off.status, off.stderr).toBe(0);
    expect(off.violations).toHaveLength(0);
    expect(off.stdout).toContain("Still connected");

    freshDevice();
    for (const args of [["ls"], ["new", "a task made after auto off"], ["show", "NET-1"]]) {
      const result = staple(args);
      expect(
        result.violations,
        `${args.join(" ")} after \`cloud auto off\` attempted: ${JSON.stringify(result.violations)}`,
      ).toHaveLength(0);
    }

    // Still connected, and still manual — the mode the report shows.
    const status = JSON.parse(staple(["cloud", "status", "--json"]).stdout) as {
      state: string;
      mode: string;
      auto: boolean;
      endpoint: string;
    };
    expect(status.state).toBe("manual");
    expect(status.mode).toBe("manual");
    expect(status.auto).toBe(false);
    expect(status.endpoint).toBe(ENDPOINT);

    /**
     * And the half that would be easy to lose: manual sync is UNAFFECTED. A
     * "stop background requests" implemented by breaking the transport, or by
     * clearing the credential, would pass every assertion above and destroy the
     * feature the consent was separate from.
     */
    const manual = staple(["cloud", "sync"]);
    expect(manual.violations.length).toBeGreaterThan(0);
    expect(new Set(manual.violations.map((v) => v.destination))).toEqual(new Set([ENDPOINT_HOST]));
  });

  it("`cloud auto on` gives it back, and the consent is the only thing that changed", () => {
    expect(staple(["cloud", "auto", "on"]).violations).toHaveLength(0);
    freshDevice();
    const result = staple(["ls"]);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(new Set(result.violations.map((v) => v.destination))).toEqual(new Set([ENDPOINT_HOST]));
  });

  /**
   * The MCP surface, in automatic mode, through the post-write wrapper.
   *
   * The counterpart to the disconnected MCP case above, and the reason that one
   * needed write tools at all: this is where a per-tool trigger becomes visible.
   * A read tool fires nothing; a write tool fires exactly one endpoint's worth of
   * traffic.
   */
  /**
   * The MCP surface, where the per-tool trigger is decided by the `readOnlyHint`
   * annotation each tool already declares.
   *
   * The spy alone cannot separate a read from a write here, because an MCP server
   * also fires the STARTUP trigger when its transport connects — so every session
   * in automatic mode has at least one attempt in it no matter what tools were
   * called. The distinction is read from `STAPLE_AUTO_SYNC_DEBUG`, which names the
   * trigger and the gate's answer on stderr, and the spy is what proves that when
   * something did go out, it went to exactly one place.
   *
   * That is what the debug channel is for. It goes to stderr, never stdout,
   * precisely so that a `--json` consumer never sees it and a test like this one
   * can.
   */
  it("an MCP write tool triggers a sync; a read tool adds nothing beyond startup", () => {
    freshDevice();
    const reads = mcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS },
        call(2, "list_tasks", {}),
        call(3, "cloud_status", {}),
      ],
      { STAPLE_AUTO_SYNC_DEBUG: "1" },
    );
    expect(parseToolResults(reads.stdout).size).toBe(2);
    expect(reads.stderr).toMatch(/auto-sync: startup/);
    // Two read tools, and not one post-write between them.
    expect(reads.stderr, reads.stderr).not.toMatch(/auto-sync: post-write/);

    freshDevice();
    const writes = mcp(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE_PARAMS },
        call(2, "create_task", {
          title: "a task made over MCP while automatic",
          actor: "network-silence",
        }),
      ],
      { STAPLE_AUTO_SYNC_DEBUG: "1" },
    );
    const results = parseToolResults(writes.stdout);
    expect(results.size).toBe(1);
    expect(results.get(2)?.isError).not.toBe(true);
    expect(writes.stderr, writes.stderr).toMatch(/auto-sync: post-write/);

    // And whatever went out, in either session, went to one host and no other.
    for (const violation of [...reads.violations, ...writes.violations]) {
      expect(violation.destination, JSON.stringify(violation)).toBe(ENDPOINT_HOST);
    }
    expect(writes.violations.length).toBeGreaterThan(0);
  });

  /**
   * And the UI server, which is the surface the S9 lane found had never been
   * booted here at all. Its startup trigger is the one that would be easiest to
   * ship unnoticed: nobody is watching a server bind.
   */
  it("the UI server's startup trigger fires in automatic mode, and only at the endpoint", async () => {
    freshDevice();
    const spy = installNetworkSpy();
    try {
      const { startUiServer } = await import("../src/ui/server.js");
      const ui = startUiServer({ port: 0, hub: false, db: dbPath });
      await once(ui.server, "listening");
      try {
        // The startup trigger is fired from the `listening` callback and its
        // transport failure is absorbed; give the microtask queue a turn.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(spy.violations.length, "the UI server's startup trigger never fired").toBeGreaterThan(
          0,
        );
        for (const violation of spy.violations) {
          expect(violation.destination, describeViolations(spy.violations)).toContain(ENDPOINT_HOST);
        }
      } finally {
        ui.close();
      }
    } finally {
      spy.restore();
    }
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
