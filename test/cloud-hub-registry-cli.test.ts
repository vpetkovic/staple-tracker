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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  return stapleIn(home, ...args);
}

/**
 * The same invocation, from a chosen directory.
 *
 * `staple init` is directory-sensitive — it registers the workspace it is standing in — so
 * the `locate` tests need a real workspace somewhere other than the staple home. Everything
 * else about the child is identical, spy included, so a `locate` that reached the network
 * would still be caught.
 */
function stapleIn(cwd: string, ...args: string[]): Run {
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
    cwd,
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

/**
 * Do something to the hub the CLI will read, under the same home the CLI uses.
 *
 * `Hub.open()` reads the real staple home, so the seam is the environment variable — and
 * it is restored afterwards, because these tests also run the CLI as a subprocess and a
 * leaked `STAPLE_HOME` would point the next test's hub at the previous test's directory.
 */
function withTestHub<T>(fn: (hub: Hub) => T): T {
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  const hub = Hub.open();
  try {
    return fn(hub);
  } finally {
    hub.close();
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
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

  it("does not let --json bypass the agreement, and hands back the disclosure", () => {
    /**
     * REGRESSION, and it was a real hole. The grant branch was `if (enabled && !json)`,
     * so `--json` skipped BOTH the disclosure and the `--yes` gate: a scripted
     * `publish --enable --json` granted the consent having displayed nothing and asked
     * nothing. The acknowledgement `setRegistryConsent` requires was then supplied by this
     * command on the caller's behalf, which spends the check instead of honouring it —
     * the same failure as a server filling in a client's argument.
     *
     * Found by `opus-hubverbs` reasoning about its own route and asking whether the CLI
     * had the same shape. It did.
     */
    adoptIdentity();
    connectHub();

    const refused = staple("hub", "registry", "publish", "--enable", "--json");
    expect(refused.status).toBe(2);
    const refusal = JSON.parse(refused.stderr);
    expect(refusal.disclosure).toBe(REGISTRY_DISCLOSURE);
    /**
     * The WHOLE disclosure, not only the headline sentence.
     *
     * `disclosure` is one sentence about what is uploaded. Everything that makes this a
     * decision rather than a notice is in the block: that publishing is scoped to one
     * machine, that a second machine naming a workspace differently costs a billed
     * operation on every pass for ever, that this machine always wins, and what is
     * actually refused. `--json` used to get the sentence and none of that, so "the cost
     * is stated at the point of consent" held on a TTY only.
     */
    expect(refusal.disclosureBlock).toContain("Publishing is scoped to ONE machine");
    expect(refusal.disclosureBlock).toContain("each time");
    expect(refusal.disclosureBlock).toContain("staple hub registry adopt --apply");
    // From index 1: the block capitalises the sentence's first letter, so the rest of it
    // is what the two share verbatim. The point is that the block CONTAINS the sentence
    // rather than paraphrasing it — one wording, reviewed once.
    expect(refusal.disclosureBlock).toContain(REGISTRY_DISCLOSURE.slice(1));
    // The consent was NOT recorded.
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).publishConsent).toBe(
      false,
    );
    expect(refused.violations).toEqual([]);

    // With --yes it goes through, and the response still carries both.
    const granted = staple("hub", "registry", "publish", "--enable", "--json", "--yes");
    expect(granted.status).toBe(0);
    const grant = JSON.parse(granted.stdout);
    expect(grant.enabled).toBe(true);
    expect(grant.disclosure).toBe(REGISTRY_DISCLOSURE);
    expect(grant.disclosureBlock).toContain("Publishing is scoped to ONE machine");
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
      // An opt-out SUPPRESSES adoption, so it belongs on the status a panel reads.
      // `registry_optouts` shipped with two readers and no surface at all — no verb, no
      // `--json` field, no status line — so a `prune` silently declined that identity on
      // every future adopt and nothing could show it.
      ignored: [],
    });
    // No `epoch` and no `lastPublishedAt`: both need an authenticated round trip, and a
    // status command that made one would be a poll that costs money and fails offline.
    expect(Object.keys(report)).not.toContain("epoch");
    expect(Object.keys(report)).not.toContain("lastPublishedAt");
  }, 60_000);

  it("shows an opt-out on status, so a suppressed adoption is discoverable", () => {
    adoptIdentity();
    connectHub({ registry: true, backup: true });
    withTestHub((hub) => hub.addOptOut("11111111-1111-4111-8111-111111111111", "gone", "pruned"));

    const report = JSON.parse(staple("hub", "registry", "status", "--json").stdout);
    expect(report.ignored).toEqual([
      { repositoryId: "11111111-1111-4111-8111-111111111111", slug: "gone", reason: "pruned" },
    ]);

    // And on the human surface, with a verb that exists.
    const human = staple("hub", "registry", "status").stdout;
    expect(human).toContain("11111111-1111-4111-8111-111111111111");
    expect(human).toContain("pruned");
    expect(human).toContain("staple hub registry unignore");
  }, 60_000);

  /**
   * `ignore` must not write the contradiction the C1 invariant forbids.
   *
   * `Hub.recordRepositoryId` retires an opt-out the moment an identity binds to a row, so
   * "an opt-out never coexists with a registered row for the same identity" is the rule.
   * This verb wrote one straight past it, and its own usage text sends the reader to "the
   * `repositoryId` of a row in `staple hub ls --json`" — i.e. at live rows. The result was
   * one command reporting a single row as both registered and not registered:
   *
   *     workspaces   2 registered, 1 cross-workspace link(s)
   *     not adopted  - 22d08ff6-…  (not registered here) (ignored)
   *
   * It could not self-heal either: `initWorkspace` and `reconcileRepositoryIds` only call
   * `recordRepositoryId` when the value CHANGES, and for a row already holding its identity
   * it does not. So the write is the only place to catch it.
   */
  it("refuses to ignore an identity this machine actually has, and names unregister", () => {
    adoptIdentity();
    connectHub({ registry: true });
    const identity = "33333333-3333-4333-8333-333333333333";
    withTestHub((hub) => {
      hub.registerAbsent({ slug: "mine", prefix: "MIN", kind: "repo", repositoryId: identity });
    });

    const refused = staple("hub", "registry", "ignore", identity);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("registered on this machine right now");
    expect(refused.stderr).toContain('as "mine"');
    // The remedy has to be the verb that actually removes a workspace.
    expect(refused.stderr).toContain("staple hub unregister mine");
    expect(refused.stderr).toContain("Nothing was changed");

    // And nothing was written: no opt-out, so status cannot contradict itself.
    const report = JSON.parse(staple("hub", "registry", "status", "--json").stdout);
    expect(report.ignored).toEqual([]);
    expect(report.registered).toBe(1);
    expect(refused.violations).toEqual([]);
  }, 60_000);

  it("still ignores an identity this machine does NOT have, which is what the verb is for", () => {
    adoptIdentity();
    connectHub({ registry: true });
    const stranger = "44444444-4444-4444-8444-444444444444";
    const ok = staple("hub", "registry", "ignore", stranger);
    expect(ok.status).toBe(0);
    const report = JSON.parse(staple("hub", "registry", "status", "--json").stdout);
    expect(report.ignored).toEqual([
      { repositoryId: stranger, slug: "(not registered here)", reason: "ignored" },
    ]);
  }, 60_000);
});

// ------------------------------------------------------------------- refusals

describe("--json is not a way around any agreement gate", () => {
  /**
   * The shape, grepped rather than hunted: `&& !json` wrapping a block that contains BOTH
   * a disclosure and a `--yes` check. Three instances existed; one was fixed in isolation
   * and the other two shipped. `runConnect` was the one that had it right all along —
   * only the printing inside `!json`, the gate outside.
   */
  it("`identity` will not replace an identity in machine mode without --yes", () => {
    adoptIdentity();
    const other = "88888888-8888-4888-8888-888888888888";

    const refused = staple("hub", "registry", "identity", other, "--json");
    expect(refused.status).toBe(2);
    const envelope = JSON.parse(refused.stderr);
    expect(envelope.previousHubId).toBe(HUB_ID);
    // The orphan notice was given to me as a hard requirement to state unconditionally.
    // In machine mode it was not stated at all, and there was no field to carry it.
    expect(envelope.notice).toContain("stays on the service");
    expect(envelope.notice).toContain(HUB_ID);
    // Unchanged.
    expect(JSON.parse(staple("hub", "registry", "status", "--json").stdout).hubId).toBe(HUB_ID);
    expect(refused.violations).toEqual([]);

    // With --yes it goes through, and the notice rides on the success too.
    const done = staple("hub", "registry", "identity", other, "--json", "--yes");
    expect(done.status).toBe(0);
    const result = JSON.parse(done.stdout);
    expect(result).toMatchObject({ hubId: other, adopted: true, previousHubId: HUB_ID });
    expect(result.notice).toContain("stays on the service");
  }, 120_000);

  it("`restore` will not rewind the service in machine mode without --yes", () => {
    /**
     * The most dangerous of the three. `restore <id> --json` skipped the entire
     * "rewinds the registry ON THE SERVICE / the service moves to a new epoch; work
     * published since is discarded" screen AND the confirmation, and went straight to the
     * remote restore — which affects every machine on that hub id. Only the unrelated
     * backup-consent check stood in the way, and anyone who has taken a backup has that.
     *
     * Backup consent is GRANTED here, deliberately, so the test exercises the state a real
     * user is in rather than one where an unrelated gate hides the hole.
     */
    adoptIdentity();
    connectHub({ backup: true });

    const refused = staple("hub", "registry", "restore", "some-backup-id", "--json");
    expect(refused.status).toBe(2);
    const envelope = JSON.parse(refused.stderr);
    expect(envelope.notice.join(" ")).toContain("moves to a new epoch");
    expect(envelope.notice.join(" ")).toContain("every machine on this hub id is affected");
    // NOTHING was sent. The gate is before the first request, which is the whole point of
    // a confirmation on a destructive fleet-wide operation.
    expect(refused.violations).toEqual([]);
  }, 60_000);
});

describe("backup rm is gated, in both modes", () => {
  it("refuses without --yes, and its --yes is no longer dead code", () => {
    /**
     * `runBackup` declared `yes: { type: "boolean" }` and NEVER READ IT, and `rm` had no
     * confirmation in either mode — exit 0, nothing printed. A declared-but-unread option is
     * worse than an absent one: an operator who types `--yes` habitually got no error and no
     * gate.
     *
     * Found by grepping for declared-but-unread OPTIONS rather than for `!json`, because
     * there was no `!json` here for the previous grep to catch.
     *
     * It composes into real damage with `runRestore`, which prints
     * "undo with: staple hub registry restore <preRestoreBackupId>" — one unconfirmed
     * `backup rm` of that id destroys the only undo for an epoch-rewinding, fleet-wide
     * restore.
     */
    adoptIdentity();
    connectHub({ backup: true });

    const refused = staple("hub", "registry", "backup", "rm", "some-backup-id", "--json");
    expect(refused.status).toBe(2);
    const envelope = JSON.parse(refused.stderr);
    expect(envelope.notice.join(" ")).toContain("only way back to a moment");
    expect(envelope.backupId).toBe("some-backup-id");
    // NOTHING was sent: the gate is before the request, like every other destructive verb.
    expect(refused.violations).toEqual([]);
  }, 60_000);

  it("refuses an unknown backup subcommand instead of falling through to `ls`", () => {
    // `backup enabel` used to fall through to `ls` and make a NETWORK CALL — doing something
    // the person did not ask for, against a paid service, and reporting success.
    adoptIdentity();
    connectHub({ backup: true });
    const result = staple("hub", "registry", "backup", "enabel");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown backup subcommand");
    expect(result.violations).toEqual([]);
  }, 60_000);
});

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
    expect(result.stderr).toContain("status|id|identity|connect|disconnect|publish");
    // The three verbs added this round, so the usage line and the dispatch cannot drift.
    expect(result.stderr).toContain("ignore|unignore");
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

// -------------------------------------------------------------------- locate

/**
 * `locate` is the verb that makes the `absent` adoption outcome performable.
 *
 * `locateAbsent` existed from the first commit of this epic, with all three of its refusals,
 * and nothing called it — so adoption told people to "point this row at it" and named no way
 * to do so. Restoring a registry onto a machine that already holds some of the clones is the
 * ordinary recovery case, so the dead end was on the main path rather than at the edge.
 *
 * These tests use a REAL `staple init` workspace rather than a hand-built row, because the
 * whole safety property is that the candidate directory's own identity is read and compared.
 * A fixture that supplied the identity would test the comparison against itself.
 */
describe("locate attaches an absent row to a copy on this machine", () => {
  /** A real workspace on disk, returning its directory and the identity it stamped. */
  function initWorkspaceAt(name: string): { dir: string; slug: string; repositoryId: string } {
    const dir = join(home, "..", `ws-${name}-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const init = stapleIn(dir, "init", "--slug", name, "--yes", "--json");
    if (init.status !== 0) throw new Error(`init failed for ${name}: ${init.stderr}`);
    const row = withTestHub((hub) => hub.get(name));
    if (!row) throw new Error(`init did not register ${name}`);
    if (row.repositoryId === null) throw new Error(`init recorded no identity for ${name}`);
    return { dir, slug: name, repositoryId: row.repositoryId };
  }

  it("attaches when the directory's own identity matches the row", () => {
    const ws = initWorkspaceAt("alpha");
    // Turn the real row into the placeholder an adopt would have left: same identity, no path.
    const prefix = withTestHub((hub) => {
      const before = hub.get(ws.slug)!;
      hub.unregister(ws.slug);
      hub.registerAbsent({
        slug: before.slug,
        prefix: before.prefix,
        kind: before.kind,
        repositoryId: ws.repositoryId,
      });
      return before.prefix;
    });
    expect(withTestHub((hub) => hub.get(ws.slug)!.available)).toBe(false);

    const run = stapleIn(home, "hub", "registry", "locate", ws.slug, "--path", ws.dir, "--json");
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.slug).toBe(ws.slug);
    expect(out.prefix).toBe(prefix);
    // The row now points at a file that is really there.
    expect(withTestHub((hub) => hub.get(ws.slug)!.available)).toBe(true);
    // Local by construction. Attaching a row this machine already has needs nobody's
    // permission and must not cost a request.
    expect(run.violations).toEqual([]);
  }, 120_000);

  it("REFUSES a directory that is a different repository, and changes nothing", () => {
    const ws = initWorkspaceAt("beta");
    const other = initWorkspaceAt("gamma");
    withTestHub((hub) => {
      const before = hub.get(ws.slug)!;
      hub.unregister(ws.slug);
      hub.registerAbsent({
        slug: before.slug,
        prefix: before.prefix,
        kind: before.kind,
        repositoryId: ws.repositoryId,
      });
    });

    const run = stapleIn(home, "hub", "registry", "locate", ws.slug, "--path", other.dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("different repository");
    // The refusal is the point: pointing a registry row at the wrong repository is silent,
    // durable, and found later as two workspaces that will not agree.
    expect(withTestHub((hub) => hub.get(ws.slug)!.available)).toBe(false);
    expect(run.violations).toEqual([]);
  }, 120_000);

  it("names the layout when the path is not a workspace at all", () => {
    const run = stapleIn(home, "hub", "registry", "locate", "nope", "--path", join(home, "empty"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(".staple/staple.db");
    expect(run.stderr).toContain("Nothing was changed");
    expect(run.violations).toEqual([]);
  }, 60_000);

  it("refuses without a --path rather than guessing, and names the verb", () => {
    const run = stapleIn(home, "hub", "registry", "locate", "nope");
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("usage: staple hub registry locate <slug> --path <directory>");
    expect(run.violations).toEqual([]);
  }, 60_000);
});
