/**
 * `staple cloud` at the command layer — the gating, the exit codes and the two
 * output modes.
 *
 * The modules underneath are covered in `test/cloud-connect.test.ts`. What is
 * pinned HERE is the part that only exists in the command: what a human is shown
 * before they are asked, what a non-interactive caller gets instead of a prompt,
 * and which refusals cost exit 2 rather than doing the thing.
 *
 * Every invocation is non-interactive, because a test harness has no TTY. That
 * is the interesting case rather than a limitation: `confirm()` returns its
 * default without blocking, every cloud command's default is the SAFE answer,
 * and so the headless path is the conservative one without a second check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const ENDPOINT = "https://staple-sync-dev.example.workers.dev";

let home: string;
let repoDir: string;
let repositoryId: string;

function staple(...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], {
    env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "cloud-cli", NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
    cwd: repoDir,
  });
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(result.stderr ?? "")) {
    throw new Error(`the CLI child never started:\n${result.stderr}`);
  }
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cloudDir(): string {
  return join(home, "cloud");
}

function forgeConnection(patch: Record<string, unknown> = {}): void {
  mkdirSync(cloudDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(cloudDir(), `${repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
  writeFileSync(
    join(cloudDir(), `${repositoryId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      repositoryId,
      endpoint: ENDPOINT,
      deviceId: "11111111-2222-3333-4444-555555555555",
      label: "cli test device",
      credentialMechanism: "file",
      connectedAt: "2026-09-05T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
      ...patch,
    }),
    { mode: 0o600 },
  );
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cloudcli-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-cloudcli-repo-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir: repoDir, slug: "cloudcli" });
  ws.store.createIssue({ title: "local work", assignee: "cloud-cli" });
  ws.store.db.close();
  repositoryId = (
    JSON.parse(readFileSync(join(repoDir, ".staple", "repository.json"), "utf8")) as {
      repositoryId: string;
    }
  ).repositoryId;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(cloudDir(), { recursive: true, force: true });
});

describe("status", () => {
  it("prints the disconnected state and the command that changes it", () => {
    const result = staple("cloud", "status");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not connected");
    expect(result.stdout).toContain("staple cloud connect");
    expect(result.stdout).toContain(repositoryId);
  });

  it("--json carries the same state string the human sentence describes", () => {
    const body = JSON.parse(staple("cloud", "status", "--json").stdout) as Record<string, unknown>;
    expect(body.state).toBe("disconnected");
    expect(body.checked).toBe(false);
    expect(body.repositoryId).toBe(repositoryId);
  });

  it("says, in both modes, that it did not ask the endpoint", () => {
    forgeConnection();
    expect(staple("cloud", "status").stdout).toContain("local files only");
    expect(JSON.parse(staple("cloud", "status", "--json").stdout).checked).toBe(false);
  });
});

describe("connect", () => {
  it("previews and refuses without --yes, and writes nothing", () => {
    const result = staple("cloud", "connect", "--endpoint", ENDPOINT, "--token", "secret");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(ENDPOINT);
    expect(result.stdout).toContain(repositoryId);
    expect(result.stdout).toContain("AUTOMATIC SYNC STAYS OFF");
    expect(result.stderr).toContain("Re-run with --yes");
    expect(existsSync(join(cloudDir(), `${repositoryId}.json`))).toBe(false);
    expect(existsSync(join(cloudDir(), `${repositoryId}.token`))).toBe(false);
  });

  it("--json previews as a machine-readable object, still without connecting", () => {
    const result = staple("cloud", "connect", "--endpoint", ENDPOINT, "--token", "s", "--json");
    expect(result.status).toBe(2);
    const body = JSON.parse(result.stdout) as { preview: Record<string, unknown> };
    expect(body.preview.endpoint).toBe(ENDPOINT);
    expect(body.preview.repositoryId).toBe(repositoryId);
    // The promise is a FIELD, not only prose, so a script reads the same thing.
    expect(body.preview.autoAfterConnect).toBe(false);
  });

  it("refuses a plaintext endpoint before it previews anything", () => {
    const result = staple("cloud", "connect", "--endpoint", "http://sync.example.com", "--token", "s");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/must be https/);
  });

  it("refuses without an endpoint rather than guessing one", () => {
    expect(staple("cloud", "connect", "--token", "s").stderr).toMatch(/--endpoint/);
  });

  it("names the enrollment credential and says repositories are provisioned out of band", () => {
    // The Worker implements enrollment, not provisioning: an unknown repoId
    // fails closed as `forbidden` and is never auto-created. The message has to
    // tell somebody that before they go looking for a `create` verb.
    const result = staple("cloud", "connect", "--endpoint", ENDPOINT, "--yes");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/enrollment secret/);
    expect(result.stderr).toMatch(/provisioned out of band/);
  });
});

describe("auto", () => {
  it("refuses on a repository that is not connected", () => {
    const result = staple("cloud", "auto", "on");
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/not connected/);
  });

  it("turns automatic sync on for THIS device and says so", () => {
    forgeConnection();
    const result = staple("cloud", "auto", "on");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("THIS device only");
    expect(JSON.parse(staple("cloud", "status", "--json").stdout).state).toBe("automatic");
  });

  it("off does not disconnect", () => {
    forgeConnection({ auto: true });
    expect(staple("cloud", "auto", "off").stdout).toContain("Still connected");
    expect(JSON.parse(staple("cloud", "status", "--json").stdout).state).toBe("manual");
  });

  it("refuses anything that is not on or off", () => {
    forgeConnection();
    expect(staple("cloud", "auto", "maybe").stderr).toMatch(/on\|off/);
  });
});

describe("disconnect", () => {
  it("previews and refuses without --yes", () => {
    forgeConnection();
    const result = staple("cloud", "disconnect");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("your local database is untouched");
    expect(result.stdout).toContain("staple cloud purge");
    expect(existsSync(join(cloudDir(), `${repositoryId}.json`))).toBe(true);
  });

  it("with --yes removes the credential and the record", () => {
    forgeConnection();
    const result = staple("cloud", "disconnect", "--yes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pending operations, is unchanged");
    expect(existsSync(join(cloudDir(), `${repositoryId}.json`))).toBe(false);
    expect(existsSync(join(cloudDir(), `${repositoryId}.token`))).toBe(false);
  });

  it("on an unconnected repository says so and exits 0", () => {
    const result = staple("cloud", "disconnect", "--yes");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing to do");
  });
});

describe("purge — the separately named, separately confirmed one", () => {
  it("prints the retention disclosure BEFORE it looks at the confirmation", () => {
    forgeConnection();
    const result = staple("cloud", "purge");
    expect(result.status).toBe(2);
    // A disclosure shown only to people who got the confirmation wrong is not a
    // disclosure. It is unconditional and it comes first.
    expect(result.stdout).toContain("What is stored there");
    expect(result.stdout).toContain("PLAINTEXT");
    expect(result.stdout).toContain("How long");
    expect(result.stdout).toContain("Who can read it");
    expect(result.stdout).toContain("not reversible");
    expect(result.stderr).toContain(`--confirm ${repositoryId}`);
  });

  it("refuses a confirmation that does not match, and says what was expected", () => {
    forgeConnection();
    const result = staple("cloud", "purge", "--confirm", "definitely-not-the-id");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("What is stored there");
    expect(result.stderr).toMatch(/did not match/);
  });

  it("has no --yes shortcut — the id has to be typed back", () => {
    forgeConnection();
    // `--yes` is muscle memory and lives in shell history; the id has to be read
    // off the disclosure that was just printed.
    const result = staple("cloud", "purge", "--yes");
    expect(result.status).not.toBe(0);
    expect(existsSync(join(cloudDir(), `${repositoryId}.json`))).toBe(true);
  });

  it("refuses on an unconnected repository rather than inventing an endpoint", () => {
    const result = staple("cloud", "purge", "--confirm", repositoryId);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/not connected/);
  });
});

describe("devices", () => {
  it("revoke previews and refuses without --yes", () => {
    forgeConnection();
    const result = staple("cloud", "devices", "revoke", "some-device");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("every other device is undisturbed");
    expect(result.stderr).toContain("--yes");
  });

  it("revoke requires a device id", () => {
    forgeConnection();
    expect(staple("cloud", "devices", "revoke").stderr).toMatch(/usage: staple cloud devices revoke/);
  });
});

/**
 * `staple cloud sync` at the command layer.
 *
 * What the engine does is pinned in `test/cloud-sync.test.ts` against an
 * in-process service. What is pinned HERE is the part that only exists in the
 * command: that it refuses from local files when there is nothing to sync with,
 * that an unreachable endpoint is a bounded, typed failure rather than a hang or
 * an unhandled rejection, and that the local database survives both.
 */
describe("sync", () => {
  it("refuses on a repository that is not connected, and says which command connects it", () => {
    const result = staple("cloud", "sync");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("not connected");
    expect(result.stderr).toContain("staple cloud connect");
  });

  it("--json returns the error envelope every other surface returns", () => {
    const result = staple("cloud", "sync", "--json");
    expect(result.status).toBe(3);
    const envelope = JSON.parse(result.stderr) as { code: string; message: string };
    expect(envelope.code).toBe("not_found");
  });

  /**
   * The endpoint in `forgeConnection` does not resolve, so this is the real
   * offline path through a real process — which is the case that would otherwise
   * surface as an `UnhandledPromiseRejection` and exit 1, losing the code, the
   * message and the retry bit.
   */
  it("an unreachable endpoint is a bounded failure, not a hang", () => {
    forgeConnection();
    const result = staple("cloud", "sync", "--json");
    expect(result.status).not.toBe(0);
    const envelope = JSON.parse(result.stderr) as {
      code: string;
      retryable: boolean;
      detail?: { cloudCode?: string; retryable?: boolean };
    };
    /**
     * The true code and the true retry bit are in `detail`, not at the top
     * level. `StapleErrorCode` is a closed union with no `offline` member and
     * exactly one retryable code, so the connect lane preserved both in `detail`
     * rather than widening a shared union mid-wave. This asserts that decision
     * rather than working around it: a `--json` consumer gets the truth, and the
     * shell gets a sensible exit status.
     */
    expect(envelope.detail?.cloudCode).toBe("offline");
    expect(envelope.detail?.retryable).toBe(true);
    expect(envelope.retryable).toBe(false);
  });

  it("leaves the local database readable and unchanged after a failed sync", () => {
    forgeConnection();
    staple("cloud", "sync");
    const listing = staple("ls", "--json");
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain("local work");
  });

  it("rejects a --pull-limit that is not a page size", () => {
    forgeConnection();
    expect(staple("cloud", "sync", "--pull-limit", "0").stderr).toMatch(/positive integer/);
    // `=` form, because a bare `-3` is parsed as a short option by `parseArgs`
    // before this command sees it at all.
    expect(staple("cloud", "sync", "--pull-limit=-3").stderr).toMatch(/positive integer/);
    expect(staple("cloud", "sync", "--pull-limit", "notanumber").stderr).toMatch(/positive integer/);
  });
});

describe("help and dispatch", () => {
  it("cloud --help names the three consents and keeps them apart", () => {
    const help = staple("cloud", "--help").stdout;
    expect(help).toContain("Three separate consents");
    expect(help).toContain("None of them implies another");
    expect(help).toContain("LOCAL ONLY");
    expect(help).toContain("it is not disconnecting");
  });

  it("staple help lists the cloud verbs", () => {
    const help = staple("help").stdout;
    expect(help).toContain("cloud [status] [--refresh]");
    expect(help).toContain("cloud connect");
    expect(help).toContain("cloud sync");
    expect(help).toContain("cloud purge --confirm");
  });

  it("a bare `staple cloud` is status, not an error", () => {
    expect(staple("cloud").status).toBe(0);
    expect(staple("cloud").stdout).toContain("not connected");
  });

  it("an unknown subcommand names the ones that exist", () => {
    expect(staple("cloud", "sink").stderr).toMatch(/Unknown subcommand "sink"/);
  });
});
