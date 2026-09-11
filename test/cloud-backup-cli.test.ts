/**
 * `staple cloud backup` and `staple cloud restore` at the command layer.
 *
 * The modules underneath are covered in `test/cloud-backup-restore.test.ts`.
 * What is pinned HERE is the part that only exists in the command: the order in
 * which a human is refused, what they are shown before they are asked, and which
 * refusals cost an exit code rather than doing the thing.
 *
 * A separate file from `cloud-cli.test.ts` on purpose — three lanes are editing
 * the cloud surface this wave, and a new file merges where a new `describe` in a
 * shared one collides.
 *
 * Every invocation is non-interactive, which is the interesting case rather than
 * a limitation: `confirm()` returns its default without blocking and every one of
 * these commands defaults to the safe answer, so the headless path is the
 * conservative one without a second check.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "backup-cli", NODE_NO_WARNINGS: "1" },
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

function connectionRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cloudDir(), `${repositoryId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-backupcli-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-backupcli-repo-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir: repoDir, slug: "backupcli" });
  ws.store.createIssue({ title: "local work", assignee: "backup-cli" });
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

describe("disconnected", () => {
  it("refuses every backup subcommand with the command that would fix it", () => {
    for (const args of [
      ["cloud", "backup", "ls"],
      ["cloud", "backup", "create"],
      ["cloud", "backup", "enable"],
      ["cloud", "restore", "some-backup"],
    ]) {
      const result = staple(...args);
      expect({ args, status: result.status }).toEqual({ args, status: 3 });
      expect(result.stderr).toMatch(/not connected on this machine|no service to restore from/);
    }
  });
});

describe("connected, backup not consented", () => {
  beforeEach(() => forgeConnection());

  it("refuses and names the consent, rather than describing the state", () => {
    const result = staple("cloud", "backup", "ls");
    // `forbidden`'s own exit (STA-251). It was 2 while `forbidden` folded into `validation`.
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("separate consent");
    expect(result.stderr).toContain("staple cloud backup enable");
  });

  it("refuses a restore before it discloses anything, because consent comes first", () => {
    const result = staple("cloud", "restore", "some-backup", "--confirm", repositoryId);
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("staple cloud backup enable");
    // Nothing about what a restore would discard, because we never got that far.
    expect(result.stdout).not.toContain("DISCARDS");
  });

  it("does not turn backup on as a side effect of enabling automatic sync", () => {
    expect(staple("cloud", "auto", "on").status).toBe(0);
    expect(connectionRecord().auto).toBe(true);
    expect(connectionRecord().backup).toBe(false);

    expect(staple("cloud", "auto", "off").status).toBe(0);
    expect(connectionRecord().backup).toBe(false);
  });

  it("still reports backup as off in status, next to the other two consents", () => {
    const result = staple("cloud", "status");
    expect(result.stdout).toContain("automatic sync off");
    expect(result.stdout).toContain("backup         off");
  });
});

describe("restore refuses without a typed confirmation", () => {
  beforeEach(() => forgeConnection({ backup: true }));

  it("demands a backup id", () => {
    const result = staple("cloud", "restore");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("staple cloud restore <backupId>");
    expect(result.stderr).toContain("staple cloud backup ls");
  });
});

describe("help and dispatch", () => {
  it("documents backup as a third consent that neither of the others turns on", () => {
    const help = staple("cloud", "--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Three separate consents");
    expect(help.stdout).toContain("cloud backup enable|disable");
    expect(help.stdout).toContain("A THIRD consent");
    expect(help.stdout).toContain("connecting does not");
  });

  it("says what a restore discards and that it never merges database files", () => {
    const help = staple("cloud", "--help");
    expect(help.stdout).toContain("cloud restore <backupId> --confirm <repositoryId>");
    expect(help.stdout).toContain("DISCARDS anything synchronized since the");
    expect(help.stdout).toContain("Never merges database files");
    expect(help.stdout).toContain("bounded re-bootstrap");
  });

  it("names backup and restore in the subcommand usage line", () => {
    const result = staple("cloud", "sink");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown subcommand "sink"');
    expect(result.stderr).toContain("backup, restore");
  });

  it("a bare `cloud backup` lists rather than taking one", () => {
    forgeConnection();
    const result = staple("cloud", "backup");
    // Refused for want of consent — but refused on the LISTING path, which is the
    // one that changes nothing. A bare `cloud backup` must never be the command
    // that took a backup.
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("separate consent");
  });
});
