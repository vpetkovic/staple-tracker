/**
 * `staple hub registry` — the CLI surface (STA-283).
 *
 * Two properties carry this file and everything else is scaffolding for them:
 *
 *  1. **No existing consent makes publishing reachable.** Connect, automatic sync and
 *     backup are all granted here, in one home, and `publish` still refuses. Asserted
 *     through the real binary rather than by calling `requireRegistryConsent`, because
 *     what has to be true is a property of the command a person types.
 *  2. **The commands that are not supposed to talk to the network do not.** Proven
 *     with the same subprocess spy `network-silence.test.ts` uses — a real `fetch`
 *     patched in before tsx's loader — and with the same child-actually-ran guard,
 *     because a process that died in the module loader makes no network call and would
 *     otherwise pass every assertion here while proving nothing.
 *
 * The refusals get as much attention as the successes. A publish that goes out when it
 * should not is not recoverable by re-running anything: the registry is on the service,
 * and the disclosure the person never agreed to is already true.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { writeConnection, type CloudConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { REGISTRY_DISCLOSURE } from "../src/core/cloud/hub-registry-service.js";

const REPO_ROOT = process.cwd();
/**
 * ABSOLUTE, both of them, for the reason `network-silence.test.ts` records: a relative
 * entry path resolves against the child's cwd, the child dies with
 * `ERR_MODULE_NOT_FOUND` before executing a line of staple, and every "makes no
 * network call" assertion then passes against a process that never ran.
 */
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const PRELOAD = join(REPO_ROOT, "test", "fixtures", "network-spy-preload.mjs");

const HUB_ID = "cf0ea872-1111-4111-8111-111111111111";
const ENDPOINT = "https://sync.test.example";

let home: string;
let logPath: string;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  violations: Array<Record<string, unknown>>;
}

/**
 * One CLI invocation with the network spy installed in the child.
 *
 * `--import` rather than `--require`, so the preload is in place before tsx registers
 * its loader and therefore before any module could capture an unpatched `fetch`.
 */
function staple(...args: string[]): Run {
  rmSync(logPath, { force: true });
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
    env: {
      ...process.env,
      STAPLE_HOME: home,
      STAPLE_AGENT: "hub-registry-cli",
      NODE_NO_WARNINGS: "1",
      NODE_OPTIONS: `--import ${JSON.stringify(PRELOAD)}`,
      STAPLE_NETWORK_SPY_LOG: logPath,
    },
    encoding: "utf8",
    cwd: home,
  });
  const stderr = result.stderr ?? "";
  // The guard. Without it a broken invocation is indistinguishable from a silent one.
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION/.test(stderr)) {
    throw new Error(`the CLI child never started, so its silence proves nothing:\n${stderr}`);
  }
  if (result.error) throw result.error;
  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr,
    violations: readViolations(),
  };
}

function readViolations(): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A connected hub, with the credential and the record a real connect would leave. */
function connectHub(consents: Partial<Pick<CloudConnection, "auto" | "backup" | "registry">> = {}): void {
  credentialStoreFor(home, "file").write(HUB_ID, "stpl_hub_cli_test");
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: HUB_ID,
    endpoint: ENDPOINT,
    deviceId: "device-cli",
    label: "device-cli",
    credentialMechanism: "file",
    connectedAt: "2026-09-09T00:00:00.000Z",
    auto: consents.auto ?? false,
    backup: consents.backup ?? false,
    registry: consents.registry ?? false,
    protocol: 1,
  });
}

/** Give this machine's hub the shared registry identity, the way `identity` does. */
function adoptIdentity(): void {
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  const hub = Hub.open();
  try {
    hub.adoptHubId(HUB_ID);
  } finally {
    hub.close();
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-hubcli-"));
  logPath = join(home, "network-spy.log");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------- no consent implies another

describe("publishing is reachable only through its own consent", () => {
  it("refuses after connect, automatic sync AND backup have all been granted", () => {
    /**
     * THE assertion of this file. All three existing consents are on; the fourth is
     * not; and the command still refuses — **without making a request**, which is the
     * half that matters, because a refusal issued after the registry was uploaded
     * would be a refusal about nothing.
     */
    adoptIdentity();
    connectHub({ auto: true, backup: true, registry: false });

    const result = staple("hub", "registry", "publish");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("separate consent");
    // The disclosure is quoted in the refusal, verbatim from the module. A person told
    // "you need a consent" without being told what it discloses cannot decide.
    expect(result.stderr).toContain(REGISTRY_DISCLOSURE);
    expect(result.stderr).toContain("staple hub registry publish --enable");
    // Nothing left the machine. This is the assertion that makes the gate structural
    // rather than cosmetic.
    expect(result.violations).toEqual([]);
  }, 60_000);

  it("granting it does not require, or make, a network call", () => {
    // The consent has no server-side half — there is no wire spelling for "this machine
    // may describe itself" — so granting and withdrawing both work offline. A consent
    // that could not be withdrawn with the service unreachable would not be revocable.
    adoptIdentity();
    connectHub();

    const enable = staple("hub", "registry", "publish", "--enable", "--yes");
    expect(enable.status).toBe(0);
    expect(enable.violations).toEqual([]);
    /**
     * The disclosure is printed BEFORE the flag is written, and printed in full.
     *
     * Compared case-insensitively, and only here. `REGISTRY_DISCLOSURE` is a
     * mid-sentence clause beginning "a machine that publishes…", which the refusal
     * quotes byte-for-byte; the rendered consent block puts it at the start of a
     * sentence and capitalises the first letter. That is correct English rather than a
     * second wording, and the assertion has to admit it without opening the door to a
     * genuine paraphrase — which a lowercase comparison of the whole clause still
     * catches.
     */
    expect(enable.stdout.toLowerCase()).toContain(REGISTRY_DISCLOSURE.toLowerCase());
    expect(enable.stdout).toContain("No filesystem paths");
    expect(enable.stdout).toContain("No tasks");
    expect(enable.stdout).toContain("Publishing is ON");

    const status = staple("hub", "registry", "status", "--json");
    expect(JSON.parse(status.stdout).publishConsent).toBe(true);

    const disable = staple("hub", "registry", "publish", "--disable");
    expect(disable.status).toBe(0);
    expect(disable.violations).toEqual([]);
    expect(disable.stdout).toContain("was already published was NOT deleted");
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).publishConsent).toBe(
      false,
    );
  }, 90_000);

  it("refuses to record the consent on a hub that is not connected", () => {
    // `at all` in the zero-network invariant is not satisfied by a file that records a
    // consent for a connection that does not exist. And the refusal names the HUB's
    // connect command, not `staple cloud connect` — which was a real bug: the generic
    // wording sent the reader to a workspace's connection to fix a hub's.
    adoptIdentity();
    const result = staple("hub", "registry", "publish", "--enable", "--yes");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("staple hub registry connect");
    expect(result.stderr).not.toContain("staple cloud connect");
    // And it refused BEFORE printing the consent screen, rather than after.
    expect(result.stdout).not.toContain(REGISTRY_DISCLOSURE);
    expect(result.violations).toEqual([]);
  }, 60_000);

  it("treats --enable and --disable as two decisions rather than resolving them", () => {
    adoptIdentity();
    connectHub();
    const result = staple("hub", "registry", "publish", "--enable", "--disable");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("two different decisions");
    expect(result.violations).toEqual([]);
  }, 60_000);
});

// --------------------------------------------------------- the network silence

describe("the local verbs make no network call", () => {
  /**
   * Every command here is one the contract says is local. Run through the real binary
   * with a real spy, because the claim is about what the process does and not about
   * what its imports look like.
   *
   * `ls` is in the list because it is the everyday command: it must stay silent, and it
   * is the one a regression would be noticed in last.
   */
  const cases: Array<{ name: string; args: string[] }> = [
    { name: "ls", args: ["ls"] },
    { name: "hub ls", args: ["hub", "ls"] },
    { name: "hub registry status", args: ["hub", "registry", "status"] },
    { name: "hub registry status --json", args: ["hub", "registry", "status", "--json"] },
    { name: "hub registry id", args: ["hub", "registry", "id"] },
  ];

  /**
   * One registered workspace, so `hub ls` has something to print.
   *
   * Not decoration: the guard below asserts the command produced output, and an empty
   * hub makes `hub ls` legitimately print nothing — which would make the silence
   * assertion pass for the wrong reason. Giving it a row keeps one uniform guard
   * instead of a per-case exception that would quietly cover a real regression.
   */
  beforeEach(() => {
    const previous = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    const hub = Hub.open();
    try {
      hub.registerAbsent({
        slug: "silent-ws",
        prefix: "SIL",
        kind: "repo",
        repositoryId: "11111111-1111-4111-8111-111111111111",
      });
    } finally {
      hub.close();
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  });

  for (const scenario of cases) {
    it(`\`staple ${scenario.name}\` attempts no network call`, () => {
      const result = staple(...scenario.args);
      expect(result.violations).toEqual([]);
      /**
       * The child ran to COMPLETION and produced output.
       *
       * Not `status === 0`: `staple ls` in a directory with no workspace exits 3, which
       * is the honest answer and still a completed run — it parsed its arguments, did
       * its work, and produced a typed envelope. What has to be excluded is a CRASH,
       * because a process that died makes no network call and would otherwise satisfy
       * the silence assertion above while proving nothing.
       *
       * So the check is that the exit code is one the CLI chose: 0, or one of the four
       * `EXIT_CODES` values. An unhandled throw is 1 and a signal is null; both fail.
       */
      expect([0, 2, 3, 4]).toContain(result.status);
      expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
    }, 60_000);
  }

  it("`hub registry identity` adopts an identity without a request", () => {
    const result = staple("hub", "registry", "identity", HUB_ID, "--yes");
    expect(result.status).toBe(0);
    expect(result.violations).toEqual([]);
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).hubId).toBe(HUB_ID);
  }, 90_000);
});

// ------------------------------------------------------------- the local verbs

describe("status and id", () => {
  it("`status` does NOT mint an identity as a side effect of being read", () => {
    /**
     * A read that minted would hand this machine a registry id it never chose, and
     * `identity` would then refuse to adopt the real one on the strength of it —
     * turning a status command into the thing that broke recovery.
     */
    const first = staple("hub", "registry", "status", "--json");
    expect(JSON.parse(first.stdout).hubId).toBeNull();

    // Still null after being asked twice, and `identity` still works afterwards.
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).hubId).toBeNull();
    expect(staple("hub", "registry", "identity", HUB_ID, "--yes").status).toBe(0);
  }, 90_000);

  it("`id` mints deliberately and says the row has to be provisioned out of band", () => {
    const minted = staple("hub", "registry", "id");
    expect(minted.status).toBe(0);
    const printed = minted.stdout.split("\n")[0]!.trim();
    expect(printed).toMatch(/^[0-9a-f-]{36}$/);
    // The out-of-band step, named. `staple hub registry id` is what `worker/README.md`
    // tells an operator to run, so it has to explain what to do with the answer.
    expect(minted.stdout).toContain("out of band");
    expect(minted.stdout).toContain("worker/README.md");

    // Stable: asking again returns the same id and does not report a fresh mint.
    const again = staple("hub", "registry", "id", "--json");
    expect(JSON.parse(again.stdout)).toEqual({ hubId: printed, minted: false });
  }, 90_000);

  it("reports the four facts a hub panel needs, and nothing that needs a request", () => {
    adoptIdentity();
    connectHub({ registry: true, backup: true });
    const report = JSON.parse(staple("hub", "registry", "status", "--json").stdout);
    expect(report).toEqual({
      hubId: HUB_ID,
      connected: true,
      endpoint: ENDPOINT,
      publishConsent: true,
      backupConsent: true,
      registered: 0,
      crossLinks: 0,
    });
    // No `epoch` and no `lastPublishedAt`: both need an authenticated round trip, and a
    // status command that made one would be a poll that costs money and fails offline.
    expect(Object.keys(report)).not.toContain("epoch");
    expect(Object.keys(report)).not.toContain("lastPublishedAt");
  }, 60_000);
});

// ------------------------------------------------------------------- refusals

describe("refusals name the remedy", () => {
  it("refuses to connect before an identity has been adopted", () => {
    /**
     * Minting here was a real bug with a misleading symptom: connect invented a fresh
     * UUID, the service had never heard of it, and the failure read as "not
     * provisioned" — sending the reader to an operator to provision an id this machine
     * had just made up.
     */
    const result = staple(
      "hub", "registry", "connect", "--endpoint", ENDPOINT, "--token", "x", "--yes",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no registry identity yet");
    expect(result.stderr).toContain("staple hub registry identity");
    expect(result.violations).toEqual([]);
  }, 60_000);

  it("refuses an unknown subcommand instead of guessing", () => {
    const result = staple("hub", "registry", "publsh");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown subcommand");
    expect(result.stderr).toContain("status|id|identity|connect|publish");
  }, 60_000);

  it("does NOT inherit `hub`'s flag tolerance", () => {
    /**
     * `staple hub --zzz` is silently tolerated, and that quirk fails safe for the local
     * verbs because every typo there does LESS. The argument does not transfer to a
     * command group that publishes: a swallowed `--disable` would leave publishing on,
     * and a swallowed `--apply` is the only thing between a preview and a write.
     */
    adoptIdentity();
    connectHub();
    const result = staple("hub", "registry", "publish", "--disabel");
    expect(result.status).not.toBe(0);
    expect(result.violations).toEqual([]);
    // The consent is untouched — the typo did nothing at all, which is the point.
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).publishConsent).toBe(
      false,
    );

    // And the existing tolerance on plain `hub` is unchanged.
    expect(staple("hub", "--zzz-not-a-real-flag").status).toBe(0);
  }, 90_000);

  it("names a missing backup id rather than picking one", () => {
    adoptIdentity();
    connectHub({ backup: true });
    const result = staple("hub", "registry", "restore");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage: staple hub registry restore <backupId>");
    expect(result.stderr).toContain("staple hub registry backup ls");
    expect(result.violations).toEqual([]);
  }, 60_000);
});
