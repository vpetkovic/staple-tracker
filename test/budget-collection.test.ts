/**
 * Automatic budget collection (docs/execution-telemetry.md, "Automatic collection"):
 * `budget setup|unsetup|status|collect` and the service they share.
 *
 * Every path is injected: the staple home, the Claude config directory, the Codex home,
 * the LaunchAgents directory and `launchctl` itself (a fake that records its calls and
 * keeps one "loaded" plist path). Nothing here touches the operator's ~/.claude, their
 * launch agents or their launchd session.
 *
 * The status-line wrapper is exercised through a real `sh`, with a stand-in staple
 * that records what it was handed, so the byte-for-byte passthrough and the background
 * ingestion are what a shell actually does and not what a string comparison assumes.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindBudgetSource, budgetConfig, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { readCursor, LOG_MAX_BYTES } from "../src/core/telemetry/collection/codex-collect.js";
import { agentPlist, COLLECT_AGENT_LABEL, type LaunchctlRunner } from "../src/core/telemetry/collection/launchd.js";
import { acquireLock, lockPath } from "../src/core/telemetry/collection/codex-collect.js";
import {
  applyBudgetSetup,
  applyBudgetUnsetup,
  budgetCollectionStatus,
  collectBudget,
  planBudgetSetup,
  planBudgetUnsetup,
  readSetupRecord,
  setupRecordPath,
  type CollectionDeps,
} from "../src/core/telemetry/collection/service.js";
import {
  WRAPPER_MARKER,
  classifyCommand,
  installStatusline,
  readSettingsState,
  uninstallStatusline,
  unwrapCommand,
  wrapperCommand,
} from "../src/core/telemetry/collection/statusline.js";
import { StapleError } from "../src/core/types.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { after, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./fixtures/budget-support.js";

let root: string;
let home: string;
let userHome: string;
let claudeDir: string;
let codexDir: string;
let agentsDir: string;
let env: NodeJS.ProcessEnv;
let clock: string;
let calls: string[][];
/** The plist path launchd has loaded under staple's label, or null. */
let loaded: string | null;

const PLIST = (): string => join(agentsDir, `${COLLECT_AGENT_LABEL}.plist`);
const SETTINGS = (): string => join(claudeDir, "settings.json");
const STAPLE = "/opt/staple bin/staple";

const fakeLaunchctl: LaunchctlRunner = (args) => {
  calls.push([...args]);
  const ok = { status: 0, stdout: "", stderr: "" };
  switch (args[0]) {
    case "print":
      return loaded === null
        ? { status: 113, stdout: "", stderr: `Could not find service "${COLLECT_AGENT_LABEL}" in domain for user gui: 501` }
        : { status: 0, stdout: `gui/501/${COLLECT_AGENT_LABEL} = {\n\tactive count = 0\n\tpath = ${loaded}\n\ttype = LaunchAgent\n}`, stderr: "" };
    case "bootout":
      loaded = null;
      return ok;
    case "bootstrap":
      loaded = args[2]!;
      return ok;
    default:
      return { status: 1, stdout: "", stderr: "unexpected" };
  }
};

function deps(over: Partial<CollectionDeps> = {}): CollectionDeps {
  return {
    home,
    env,
    platform: "darwin",
    userHome,
    launchAgentsDir: agentsDir,
    launchctl: fakeLaunchctl,
    uid: 501,
    staple: STAPLE,
    nodePath: "/opt/node/bin/node",
    now: () => clock,
    ...over,
  };
}

beforeEach(() => {
  root = tempDir("budget-collection");
  home = join(root, "staple-home");
  userHome = join(root, "user");
  claudeDir = join(userHome, ".claude");
  codexDir = join(userHome, ".codex");
  agentsDir = join(userHome, "Library", "LaunchAgents");
  for (const dir of [home, claudeDir, codexDir]) mkdirSync(dir, { recursive: true });
  env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
  clock = "2026-09-26T10:00:00.000Z";
  calls = [];
  loaded = null;
});

afterEach(() => removeDir(root));

/** Every file under the directories setup may write, with its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(path, "utf8");
    }
  };
  walk(home);
  walk(userHome);
  return out;
}

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

const ORIGINAL = "$PAI_DIR/statusline-command.sh";
const PRETTY = `{\n  "theme": "dark",\n  "statusLine": {\n    "type": "command",\n    "command": "${ORIGINAL}",\n    "padding": 0\n  },\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n`;

// ------------------------------------------------------------------ the settings file

describe("the status-line wrapper round-trips settings.json", () => {
  const shapes: Array<[string, string]> = [
    ["a pretty file with other keys around the statusLine", PRETTY],
    ["a compact one-line file", `{"statusLine":{"type":"command","command":"${ORIGINAL}"},"model":"opus"}`],
    // Escapes JSON.stringify would not write back the same way: the restore must use the literal.
    ["a command written with escapes", `{\n\t"statusLine": { "command": "\\u0024HOME\\/bin\\/line \\"a b\\" 'c'", "type": "command" }\n}`],
    ["a file with no statusLine", `{\n  "theme": "dark",\n  "model": "opus"\n}\n`],
    ["a one-line file with no statusLine", `{"theme":"dark"}`],
    ["an empty object", `{}\n`],
    ["an empty multi-line object", `{\n}\n`],
    // The first key on the brace's own line after a leading newline: no indentation to copy.
    ["a leading newline and the first key on the brace's line", `\n{"theme": "dark",\n "model": "opus"\n}\n`],
    ["a duplicated statusLine key (JSON.parse keeps the last)", `{"statusLine":{"type":"command","command":"first"},"statusLine":{"type":"command","command":"second"}}`],
  ];

  for (const [name, text] of shapes) {
    it(`install then uninstall is byte-identical: ${name}`, () => {
      writeFileSync(SETTINGS(), text);
      const before = JSON.parse(text) as { statusLine?: { command: string } };
      const record = installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock })!;
      expect(record).not.toBeNull();
      const installed = JSON.parse(readFileSync(SETTINGS(), "utf8")) as Record<string, unknown> & { statusLine: { command: string } };
      // Every other key is still there, with its value.
      for (const [key, value] of Object.entries(before)) if (key !== "statusLine") expect(installed[key]).toEqual(value);
      expect(classifyCommand(installed.statusLine.command)).toBe("staple");
      expect(unwrapCommand(installed.statusLine.command)).toBe(before.statusLine?.command ?? null);
      // The backup is the file as it was.
      expect(readFileSync(record.backupPath!, "utf8")).toBe(text);

      expect(uninstallStatusline({ configDir: claudeDir, record, backupDir: join(home, "backups"), now: clock })).toBe(true);
      expect(readFileSync(SETTINGS(), "utf8")).toBe(text);
    });
  }

  it("creates a missing settings.json and deletes it again on uninstall", () => {
    const record = installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock })!;
    expect(record.createdFile).toBe(true);
    const created = JSON.parse(readFileSync(SETTINGS(), "utf8")) as { statusLine: { type: string; command: string } };
    expect(created.statusLine.type).toBe("command");
    expect(unwrapCommand(created.statusLine.command)).toBeNull();
    uninstallStatusline({ configDir: claudeDir, record, backupDir: join(home, "backups"), now: clock });
    expect(existsSync(SETTINGS())).toBe(false);
  });

  it("does not wrap twice, and a second uninstall finds nothing to undo", () => {
    writeFileSync(SETTINGS(), PRETTY);
    const record = installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock });
    const once = readFileSync(SETTINGS(), "utf8");
    expect(installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock })).toBeNull();
    expect(readFileSync(SETTINGS(), "utf8")).toBe(once);
    uninstallStatusline({ configDir: claudeDir, record, backupDir: join(home, "backups"), now: clock });
    expect(uninstallStatusline({ configDir: claudeDir, record, backupDir: join(home, "backups"), now: clock })).toBe(false);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(PRETTY);
  });

  it("restores from the wrapper alone when staple's record is gone", () => {
    writeFileSync(SETTINGS(), PRETTY);
    installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock });
    expect(uninstallStatusline({ configDir: claudeDir, record: null, backupDir: join(home, "backups"), now: clock })).toBe(true);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(PRETTY);
  });

  it("recognises the documented hand-wrapped recipe and the --tee pipeline, and leaves both alone", () => {
    const recipe = `bash -c 'f=$(mktemp); cat > "$f"; exec 3<"$f" 4<"$f"; rm -f "$f"; staple budget ingest --source claude-statusline <&3 >/dev/null 2>&1 & ${ORIGINAL} <&4'`;
    for (const command of [recipe, `staple budget ingest --source claude-statusline --tee | ${ORIGINAL}`]) {
      const text = JSON.stringify({ statusLine: { type: "command", command } }, null, 2);
      writeFileSync(SETTINGS(), text);
      expect(readSettingsState(SETTINGS())).toMatchObject({ state: "command", kind: "hand_wrapped" });
      expect(installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock })).toBeNull();
      expect(uninstallStatusline({ configDir: claudeDir, record: null, backupDir: join(home, "backups"), now: clock })).toBe(false);
      expect(readFileSync(SETTINGS(), "utf8")).toBe(text);
    }
  });

  it("refuses a settings file that is not valid JSON and writes nothing", () => {
    const broken = `{\n  "statusLine": { "type": "command", "command": "x" },\n}\n`;
    writeFileSync(SETTINGS(), broken);
    const error = refusal(() => installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock }));
    expect(error.code).toBe("validation");
    expect(error.message).toContain("not valid JSON");
    expect(readFileSync(SETTINGS(), "utf8")).toBe(broken);
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it("leaves a statusLine that is not a command alone", () => {
    writeFileSync(SETTINGS(), `{"statusLine":{"type":"static","text":"hi"}}`);
    const error = refusal(() => installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock }));
    expect(error.message).toContain("no command to wrap");
  });

  it("replaces the file by rename, keeps its mode and leaves no temporary file", () => {
    writeFileSync(SETTINGS(), PRETTY);
    chmodSync(SETTINGS(), 0o600);
    const inode = statSync(SETTINGS()).ino;
    installStatusline({ configDir: claudeDir, staple: STAPLE, backupDir: join(home, "backups"), now: clock });
    const after = statSync(SETTINGS());
    // A new inode: the file was renamed over, never rewritten in place.
    expect(after.ino).not.toBe(inode);
    expect(after.mode & 0o777).toBe(0o600);
    expect(readdirSync(claudeDir)).toEqual(["settings.json"]);
  });

  it("refuses to restore a marked wrapper that is not in the shape staple writes", () => {
    expect(() => unwrapCommand(`bash -c ': staple-statusline-wrapper/v1; something else'`)).toThrow(/not in the shape staple writes/);
  });
});

describe("the wrapper as a shell runs it", () => {
  it("prints exactly what the original prints and hands staple its own copy of the input", () => {
    const out = join(root, "ingested");
    const fake = join(root, "fake staple");
    // A stand-in for the staple launcher: records its argv and stdin, prints noise.
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}.args"\ncat > "${out}.tmp"\nmv "${out}.tmp" "${out}"\necho "noise that must not reach the status line"\necho "and stderr" >&2\n`);
    chmodSync(fake, 0o755);
    const original = `head -c 40 | tr a-z A-Z; echo " it's done"`;
    const command = wrapperCommand({ staple: fake, configDir: "/tmp/claude dir", original });
    const input = statusline();
    const direct = spawnSync("sh", ["-c", original], { input, encoding: "utf8" });
    const wrapped = spawnSync("sh", ["-c", command], { input, encoding: "utf8" });
    expect(wrapped.status).toBe(0);
    expect(wrapped.stdout).toBe(direct.stdout);
    expect(wrapped.stderr).toBe("");
    // The background ingestion finishes on its own time.
    const deadline = Date.now() + 10_000;
    while (!existsSync(out) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
    expect(readFileSync(out, "utf8")).toBe(input);
    expect(readFileSync(`${out}.args`, "utf8").trim().split("\n")).toEqual(["budget", "ingest", "--source", "claude-statusline", "--config-dir", "/tmp/claude dir"]);
  });

  it("prints nothing where there was no status line, and still ingests", () => {
    const out = join(root, "ingested");
    const fake = join(root, "staple");
    writeFileSync(fake, `#!/bin/sh\ncat > "${out}.tmp"; mv "${out}.tmp" "${out}"\n`);
    chmodSync(fake, 0o755);
    const wrapped = spawnSync("sh", ["-c", wrapperCommand({ staple: fake, configDir: claudeDir, original: null })], { input: "{}", encoding: "utf8" });
    expect(wrapped.status).toBe(0);
    expect(wrapped.stdout).toBe("");
    const deadline = Date.now() + 10_000;
    while (!existsSync(out) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
    expect(readFileSync(out, "utf8")).toBe("{}");
  });

  it("keeps the status line when staple is missing altogether", () => {
    const wrapped = spawnSync("sh", ["-c", wrapperCommand({ staple: join(root, "no-such-staple"), configDir: claudeDir, original: "cat" })], { input: "line", encoding: "utf8" });
    expect(wrapped.stdout).toBe("line");
    expect(wrapped.status).toBe(0);
  });
});

// ------------------------------------------------------------------ the Codex watcher

const A = "11111111-0000-7000-8000-000000000001";
const B = "11111111-0000-7000-8000-000000000002";
const C = "22222222-0000-7000-8000-000000000001";
const RESET = epoch("2026-09-27T00:00:00Z");
const five = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: RESET });

function optIn(): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir });
}

function rollout(id: string, start: string, used: number[]): string {
  return writeRollout(codexDir, id, start, [
    sessionMetaLine({ id, timestamp: start }),
    ...used.map((u, i) => tokenCountLine({ timestamp: after(start, (i + 1) * 60_000), primary: five(u), secondary: null })),
  ]);
}

describe("budget collect reads new and grown rollouts only", () => {
  beforeEach(optIn);

  it("ingests a new file, skips it when unchanged, and reads it again when it grows", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10, 12]);
    const first = collectBudget({}, deps());
    expect(first).toMatchObject({ ok: true, scanned: 1, changed: 1, ingested: 1, storedCount: 2, deferred: 0 });
    expect(readCursor(home).files[file]).toMatchObject({ size: statSync(file).size, mtimeMs: statSync(file).mtimeMs, completeBytes: statSync(file).size, leadingRunEnded: true });

    const second = collectBudget({}, deps());
    expect(second).toMatchObject({ scanned: 1, changed: 0, ingested: 0, storedCount: 0 });
    expect(second.files).toEqual([]);

    appendFileSync(file, `${tokenCountLine({ timestamp: "2026-09-26T08:05:00.000Z", primary: five(15), secondary: null })}\n`);
    const third = collectBudget({}, deps());
    expect(third).toMatchObject({ changed: 1, ingested: 1, storedCount: 1 });
    // Read from where the last read stopped: only the appended line, nothing re-parsed.
    expect(third.files[0]!.mode).toBe("tail");
    expect(third.files[0]!.skipped).toEqual({ not_reported_by_source: 1 });
  });

  it("reads a file whose mtime moved even at the same size", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    collectBudget({}, deps());
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(collectBudget({}, deps())).toMatchObject({ changed: 1, ingested: 1, storedCount: 0 });
  });

  it("skips a fork's copied history and stores only its own readings", () => {
    const parentStart = "2026-09-26T07:00:00.000Z";
    writeRollout(codexDir, A, parentStart, [
      sessionMetaLine({ id: A, timestamp: parentStart }),
      tokenCountLine({ timestamp: "2026-09-26T07:10:00.000Z", primary: five(20), secondary: null }),
      tokenCountLine({ timestamp: "2026-09-26T07:20:00.000Z", primary: five(22), secondary: null }),
    ]);
    const fork = "2026-09-26T07:30:00.000Z";
    const child = writeRollout(codexDir, B, fork, [
      sessionMetaLine({ id: B, timestamp: fork, forkedFromId: A }),
      tokenCountLine({ timestamp: after(fork, 1), primary: five(20), secondary: null }),
      tokenCountLine({ timestamp: after(fork, 2), primary: five(22), secondary: null }),
      tokenCountLine({ timestamp: after(fork, 60_000), primary: five(25), secondary: null }),
    ]);
    const result = collectBudget({}, deps());
    const forked = result.files.find((file) => file.file === child)!;
    expect(forked.skipped.fork_copied).toBe(2);
    expect(forked.storedCount).toBe(1);
    // A replay of both stores nothing.
    rmSync(join(home, "telemetry", "codex-cursor.json"));
    expect(collectBudget({}, deps())).toMatchObject({ changed: 2, storedCount: 0 });
  });

  it("is bounded per run, newest first, and drains the rest on later runs", () => {
    const old = rollout(A, "2026-09-26T06:00:00.000Z", [5]);
    const mid = rollout(B, "2026-09-26T07:00:00.000Z", [6]);
    const fresh = rollout(C, "2026-09-26T08:00:00.000Z", [7]);
    utimesSync(old, new Date("2026-09-26T06:00:00Z"), new Date("2026-09-26T06:00:00Z"));
    utimesSync(mid, new Date("2026-09-26T07:00:00Z"), new Date("2026-09-26T07:00:00Z"));
    utimesSync(fresh, new Date("2026-09-26T08:00:00Z"), new Date("2026-09-26T08:00:00Z"));
    const first = collectBudget({ maxFiles: 1 }, deps());
    expect(first).toMatchObject({ changed: 3, ingested: 1, deferred: 2 });
    expect(first.files.map((file) => file.file)).toEqual([fresh]);
    expect(collectBudget({ maxFiles: 1 }, deps()).files.map((file) => file.file)).toEqual([mid]);
    expect(collectBudget({ maxFiles: 1 }, deps()).files.map((file) => file.file)).toEqual([old]);
    expect(collectBudget({ maxFiles: 1 }, deps())).toMatchObject({ changed: 0, deferred: 0 });
  });

  it("keeps a failing file's cursor so it is retried, and reports the error", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    chmodSync(file, 0o000);
    try {
      const failed = collectBudget({}, deps());
      expect(failed.ok).toBe(false);
      expect(failed.errors).toHaveLength(1);
      expect(readCursor(home).files[file]).toBeUndefined();
      expect(readCursor(home).lastError?.message).toContain(file);
    } finally {
      chmodSync(file, 0o644);
    }
    const retried = collectBudget({}, deps());
    expect(retried).toMatchObject({ ok: true, ingested: 1, storedCount: 1 });
    expect(readCursor(home).lastError).toBeNull();
  });

  it("forgets rollouts that were deleted", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    collectBudget({}, deps());
    rmSync(file);
    collectBudget({}, deps());
    expect(readCursor(home).files).toEqual({});
  });

  it("reads nothing with capture off, and says so in its summary", () => {
    rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    setBudgetCapture(home, false);
    const result = collectBudget({}, deps());
    expect(result).toMatchObject({ ok: false, skippedReason: "capture_disabled", scanned: 0, storedCount: 0 });
    expect(readCursor(home).lastError?.message).toContain("capture is off");
  });

  it("logs one line per run and keeps the log bounded", () => {
    const log = join(home, "logs", "budget-collect.log");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(log, "x".repeat(LOG_MAX_BYTES + 1));
    collectBudget({}, deps());
    expect(statSync(`${log}.1`).size).toBe(LOG_MAX_BYTES + 1);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ at: clock, ok: true });
  });
});

// ------------------------------------------------------------------ setup and unsetup

const SETUP = { claudeAccount: "claude-max", codexAccount: "codex-plus" };

describe("setup changes nothing without consent", () => {
  it("planning reads only: every file is as it was and launchctl was only asked", () => {
    writeFileSync(SETTINGS(), PRETTY);
    const before = snapshot();
    const plan = planBudgetSetup(SETUP, deps());
    expect(plan.steps.map((step) => [step.part, step.action])).toEqual([
      ["capture", "change"],
      ["claude_binding", "change"],
      ["statusline", "change"],
      ["codex_binding", "change"],
      ["watcher", "change"],
    ]);
    expect(snapshot()).toEqual(before);
    expect(calls.every((call) => call[0] === "print")).toBe(true);
    expect(planBudgetUnsetup(deps()).changes).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("the CLI without --yes refuses with the plan, exit 2, and writes nothing", () => {
    writeFileSync(SETTINGS(), PRETTY);
    const before = snapshot();
    // --no-watcher: a child process reaches the real launchctl, which this suite never loads into.
    const run = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", "setup", "--claude-account", "claude-max", "--no-watcher", "--json"], {
      cwd: REPO_ROOT,
      env: bareEnv({ STAPLE_HOME: home, HOME: userHome, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(2);
    const envelope = JSON.parse(run.stderr.trim() || run.stdout.trim()) as { code: string; detail: { reason: string; plan: { changes: number } } };
    expect(envelope.code).toBe("validation");
    expect(envelope.detail.reason).toBe("consent_required");
    expect(envelope.detail.plan.changes).toBe(3);
    expect(snapshot()).toEqual(before);
  }, 30_000);

  it("refuses the whole setup when the settings file is not JSON, leaving capture and bindings alone", () => {
    writeFileSync(SETTINGS(), "{ not json");
    const error = refusal(() => applyBudgetSetup(SETUP, deps()));
    expect(error.message).toContain("nothing was changed");
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: false, bindings: [] });
    expect(existsSync(PLIST())).toBe(false);
    expect(calls.some((call) => call[0] === "bootstrap")).toBe(false);
  });

  it("refuses when neither harness has an account", () => {
    expect(refusal(() => planBudgetSetup({}, deps())).detail).toMatchObject({ reason: "no_account" });
  });
});

describe("setup and unsetup", () => {
  it("one call turns on capture, binds both homes, wraps the status line and loads the watcher", () => {
    writeFileSync(SETTINGS(), PRETTY);
    const outcome = applyBudgetSetup(SETUP, deps());
    expect(outcome.applied.map((step) => step.part)).toEqual(["capture", "claude_binding", "statusline", "codex_binding", "watcher"]);
    const config = budgetConfig(home);
    expect(config.budgetCapture).toBe(true);
    expect(config.bindings).toEqual([
      { source: "claude_code_statusline", configDir: claudeDir, provider: "anthropic", accountRef: "claude-max" },
      { source: "codex_rollout", home: codexDir, provider: "openai", accountRef: "codex-plus" },
    ]);
    expect(readSettingsState(SETTINGS())).toMatchObject({ state: "command", kind: "staple" });
    expect(readFileSync(PLIST(), "utf8")).toBe(
      agentPlist({ staple: STAPLE, nodePath: "/opt/node/bin/node", userHome, stapleHomeEnv: null, intervalMinutes: 5, logPath: join(home, "logs", "budget-collect.agent.log") }),
    );
    expect(calls).toContainEqual(["bootstrap", "gui/501", PLIST()]);
    expect(outcome.status.watcher).toMatchObject({ installed: true, loaded: true, intervalMinutes: 5 });
    expect(outcome.status.statusline).toEqual([expect.objectContaining({ configDir: claudeDir, state: "installed", recorded: true })]);

    // Idempotent: a second run changes nothing and loads nothing.
    calls = [];
    const again = applyBudgetSetup(SETUP, deps());
    expect(again.applied).toEqual([]);
    expect(calls.some((call) => call[0] !== "print")).toBe(false);
  });

  it("unsetup reverses every part exactly, and a second unsetup is a no-op", () => {
    writeFileSync(SETTINGS(), PRETTY);
    const before = snapshot();
    applyBudgetSetup(SETUP, deps());
    const outcome = applyBudgetUnsetup(deps());
    expect(outcome.applied.map((step) => step.part)).toEqual(["statusline", "watcher", "claude_binding", "codex_binding", "capture", "record"]);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(PRETTY);
    expect(existsSync(PLIST())).toBe(false);
    expect(loaded).toBeNull();
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: false, bindings: [] });
    expect(readSetupRecord(home)).toBeNull();
    // Outside the staple home's own state and backups, the machine is as it was.
    const after = snapshot();
    const outside = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(home)));
    expect(outside(after)).toEqual(outside(before));
    expect(applyBudgetUnsetup(deps()).applied).toEqual([]);
  });

  it("puts capture and an earlier binding back as they were before setup", () => {
    setBudgetCapture(home, true);
    bindBudgetSource(home, { source: "claude_code_statusline", account: "old-max", configDir: claudeDir });
    writeFileSync(SETTINGS(), PRETTY);
    applyBudgetSetup({ claudeAccount: "claude-max" }, deps());
    expect(budgetConfig(home).bindings[0]).toMatchObject({ accountRef: "claude-max" });
    // A second setup that re-binds the same home must not forget what was there before the first.
    applyBudgetSetup({ claudeAccount: "claude-pro", codexAccount: "codex-plus" }, deps());
    expect(readSetupRecord(home)!.bindings.find((change) => change.source === "claude_code_statusline")).toMatchObject({
      before: { accountRef: "old-max" },
      after: { accountRef: "claude-pro" },
    });
    applyBudgetUnsetup(deps());
    const config = budgetConfig(home);
    expect(config.budgetCapture).toBe(true);
    expect(config.bindings).toEqual([{ source: "claude_code_statusline", configDir: claudeDir, provider: "anthropic", accountRef: "old-max" }]);
  });

  it("leaves a binding re-bound by hand after setup alone", () => {
    applyBudgetSetup({ codexAccount: "codex-plus" }, deps());
    bindBudgetSource(home, { source: "codex_rollout", account: "codex-pro", codexHome: codexDir });
    const plan = planBudgetUnsetup(deps());
    expect(plan.steps.find((step) => step.part === "codex_binding")).toMatchObject({ action: "skip" });
    applyBudgetUnsetup(deps());
    expect(budgetConfig(home).bindings).toEqual([{ source: "codex_rollout", home: codexDir, provider: "openai", accountRef: "codex-pro" }]);
  });

  it("refuses the whole unsetup when the settings file stopped being JSON, and changes nothing", () => {
    writeFileSync(SETTINGS(), PRETTY);
    applyBudgetSetup(SETUP, deps());
    const wrapped = readFileSync(SETTINGS(), "utf8");
    writeFileSync(SETTINGS(), `${wrapped},`);
    const before = snapshot();
    const error = refusal(() => applyBudgetUnsetup(deps()));
    expect(error.detail).toMatchObject({ reason: "plan_refused" });
    expect(snapshot()).toEqual(before);
    expect(loaded).toBe(PLIST());
  });

  it("without a setup record, unsetup removes the wrapper and the agent and leaves capture and bindings", () => {
    writeFileSync(SETTINGS(), PRETTY);
    applyBudgetSetup(SETUP, deps());
    rmSync(setupRecordPath(home));
    applyBudgetUnsetup(deps());
    expect(readFileSync(SETTINGS(), "utf8")).toBe(PRETTY);
    expect(existsSync(PLIST())).toBe(false);
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: true });
    expect(budgetConfig(home).bindings).toHaveLength(2);
  });

  it("never touches a watcher another staple home loaded under the same label, and refuses at plan time", () => {
    loaded = "/Users/someone/Library/LaunchAgents/com.staple.budget-collect.plist";
    writeFileSync(SETTINGS(), PRETTY);
    const before = snapshot();
    const plan = planBudgetSetup(SETUP, deps());
    const watcher = plan.steps.find((step) => step.part === "watcher")!;
    expect(watcher.action).toBe("refuse");
    expect(watcher.summary).toContain("launchctl bootout gui/501/com.staple.budget-collect");
    const error = refusal(() => applyBudgetSetup(SETUP, deps()));
    expect(error.detail).toMatchObject({ reason: "plan_refused" });
    // Refused before capture, a binding, the wrapper or a setup record was written.
    expect(snapshot()).toEqual(before);
    expect(calls.some((call) => call[0] === "bootout" || call[0] === "bootstrap")).toBe(false);
    expect(budgetCollectionStatus(deps()).problems.map((problem) => problem.code)).toContain("watcher_foreign");
    expect(planBudgetUnsetup(deps()).steps.find((step) => step.part === "watcher")).toMatchObject({ action: "unchanged" });
    expect(budgetCollectionStatus(deps()).watcher.loaded).toBe(false);
  });

  it("installs no agent off macOS and prints the cron line instead", () => {
    const plan = planBudgetSetup({ codexAccount: "codex-plus" }, deps({ platform: "linux" }));
    const watcher = plan.steps.find((step) => step.part === "watcher")!;
    expect(watcher.action).toBe("skip");
    expect(watcher.summary).toContain(`*/5 * * * * '${STAPLE}' budget collect --quiet`);
    applyBudgetSetup({ codexAccount: "codex-plus" }, deps({ platform: "linux" }));
    expect(calls).toEqual([]);
    expect(budgetCollectionStatus(deps({ platform: "linux" })).watcher).toMatchObject({ supported: false, loaded: null, cronLine: expect.stringContaining("budget collect") });
  });

  it("skips the watcher when there is no installed launcher for it to run", () => {
    const plan = planBudgetSetup({ codexAccount: "codex-plus" }, deps({ staple: null }));
    expect(plan.steps.find((step) => step.part === "watcher")).toMatchObject({ action: "skip", summary: expect.stringContaining("staple install") });
  });

  it("--no-statusline and --no-watcher leave those parts alone", () => {
    writeFileSync(SETTINGS(), PRETTY);
    applyBudgetSetup({ ...SETUP, statusline: false, watcher: false }, deps());
    expect(readFileSync(SETTINGS(), "utf8")).toBe(PRETTY);
    expect(existsSync(PLIST())).toBe(false);
    expect(budgetConfig(home).budgetCapture).toBe(true);
  });
});

// ------------------------------------------------------------------ status

describe("budget status", () => {
  it("reports each source's newest reading and its age", () => {
    applyBudgetSetup({ codexAccount: "codex-plus" }, deps());
    rollout(A, "2026-09-26T08:00:00.000Z", [10, 11]);
    collectBudget({}, deps());
    clock = "2026-09-26T10:30:00.000Z";
    const status = budgetCollectionStatus(deps());
    expect(status.sources).toEqual([
      {
        source: "codex_rollout",
        dir: codexDir,
        provider: "openai",
        accountRef: "codex-plus",
        lastReading: { observedAt: "2026-09-26T08:02:00.000Z", recordedAt: "2026-09-26T10:00:00.000Z", sampleCount: 2, ageSeconds: 1800 },
      },
    ]);
    expect(status.watcher.lastRun).toMatchObject({ at: "2026-09-26T10:00:00.000Z", storedCount: 2 });
    expect(status.watcher.lastRunAgeSeconds).toBe(1800);
    // 30 minutes against a 5-minute interval: the watcher is not running.
    expect(status.problems.map((problem) => problem.code)).toEqual(["watcher_stale"]);
  });

  it("names each problem: capture off, a removed wrapper, an unloaded agent, a failed run", () => {
    writeFileSync(SETTINGS(), PRETTY);
    applyBudgetSetup(SETUP, deps());
    writeFileSync(SETTINGS(), PRETTY); // the operator put the old file back by hand
    loaded = null; // and the agent was unloaded
    setBudgetCapture(home, false);
    collectBudget({}, deps());
    const codes = budgetCollectionStatus(deps()).problems.map((problem) => problem.code);
    expect(codes).toEqual(expect.arrayContaining(["capture_off", "statusline_removed", "watcher_not_loaded", "collect_error"]));
  });

  it("flags a bound Claude home whose status line records nothing", () => {
    writeFileSync(SETTINGS(), PRETTY);
    setBudgetCapture(home, true);
    bindBudgetSource(home, { source: "claude_code_statusline", account: "claude-max", configDir: claudeDir });
    const status = budgetCollectionStatus(deps());
    expect(status.statusline).toEqual([expect.objectContaining({ state: "not_installed", recorded: false })]);
    expect(status.problems.map((problem) => problem.code)).toEqual(["no_reading", "statusline_not_installed"]);
  });

  it("the CLI's status --json is the service's value", () => {
    const run = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", "status", "--json"], {
      cwd: REPO_ROOT,
      env: bareEnv({ STAPLE_HOME: home, HOME: userHome, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    const status = JSON.parse(run.stdout) as { budgetCapture: boolean; problems: Array<{ code: string }> };
    expect(status.budgetCapture).toBe(false);
    expect(status.problems.map((problem) => problem.code)).toEqual(["capture_off", "no_binding"]);
  }, 30_000);
});

// ------------------------------------------------------------------ round 1 review

/** The wrapper version 1 installed: the same script inside `bash -c '…'`. */
function v1Wrapper(staple: string, configDir: string, original: string | null): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const inner = `: staple-statusline-wrapper/v1; f=$(mktemp); cat > "$f"; exec 3<"$f" 4<"$f"; rm -f "$f"; ${q(staple)} budget ingest --source claude-statusline --config-dir ${q(configDir)} <&3 >/dev/null 2>&1 & exec 0<&4 3<&- 4<&-;${original === null ? "" : ` ${original}`}`;
  return `bash -c ${q(inner)}`;
}

const SHELLS = ["/bin/sh", "/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash"].filter((shell) => existsSync(shell));

describe("the wrapper runs in the caller's own shell", () => {
  it("is a plain command list, not a nested shell", () => {
    const command = wrapperCommand({ staple: STAPLE, configDir: claudeDir, original: ORIGINAL });
    expect(command.startsWith(`: ${WRAPPER_MARKER}; `)).toBe(true);
    expect(command).not.toContain("bash -c");
    expect(command.endsWith(`; ${ORIGINAL}`)).toBe(true);
  });

  const originals = [
    `echo "\\033[32mgreen\\033[0m\\ttab"`,
    `printf '%s\\n' "$HOME" | tr a-z A-Z`,
    `head -c 20; echo " it's done"`,
    `cat | wc -c; exit 3`,
    `echo 'naïve ✓' && echo "$(echo nested)"`,
    // The wrapper's own variable does not leak into the command it wraps.
    `echo "[\${__stf-unset}]"`,
  ];
  for (const shell of SHELLS) {
    for (const original of originals) {
      it(`${shell}: prints the same bytes and exits the same as ${JSON.stringify(original)} run directly`, () => {
        const out = join(root, "ingested");
        const fake = join(root, "fake staple");
        writeFileSync(fake, `#!/bin/sh\ncat > "${out}.tmp"; mv "${out}.tmp" "${out}"\n`);
        chmodSync(fake, 0o755);
        const input = statusline();
        const direct = spawnSync(shell, ["-c", original], { input, env: { PATH: process.env.PATH, HOME: "/home/x" } });
        const wrapped = spawnSync(shell, ["-c", wrapperCommand({ staple: fake, configDir: claudeDir, original })], { input, env: { PATH: process.env.PATH, HOME: "/home/x" } });
        expect(Buffer.compare(wrapped.stdout, direct.stdout)).toBe(0);
        expect(wrapped.stderr.toString()).toBe(direct.stderr.toString());
        expect(wrapped.status).toBe(direct.status);
        const deadline = Date.now() + 10_000;
        while (!existsSync(out) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
        expect(readFileSync(out, "utf8")).toBe(input);
      });
    }
  }

  it("still unwraps a version-1 (bash -c) wrapper, and setup upgrades it; unsetup restores the original byte for byte", () => {
    // A v1 install as the first release wrote it, with its record.
    const original = `{\n  "statusLine": { "type": "command", "command": "echo \\"\\\\033[1mx\\"" }\n}\n`;
    writeFileSync(SETTINGS(), original);
    const command = (JSON.parse(original) as { statusLine: { command: string } }).statusLine.command;
    expect(unwrapCommand(v1Wrapper(STAPLE, claudeDir, command))).toBe(command);
    expect(classifyCommand(v1Wrapper(STAPLE, claudeDir, command))).toBe("staple");
    const v1Text = original.replace(JSON.stringify(command), JSON.stringify(v1Wrapper(STAPLE, claudeDir, command)));
    writeFileSync(SETTINGS(), v1Text);

    const plan = planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
    expect(plan.steps.find((step) => step.part === "statusline")).toMatchObject({ action: "change", summary: expect.stringContaining("older staple wrapper") });
    applyBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
    const upgraded = (JSON.parse(readFileSync(SETTINGS(), "utf8")) as { statusLine: { command: string } }).statusLine.command;
    expect(upgraded.startsWith(`: ${WRAPPER_MARKER}; `)).toBe(true);
    expect(unwrapCommand(upgraded)).toBe(command);
    // A second setup leaves the current wrapper alone.
    expect(planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps()).steps.find((step) => step.part === "statusline")).toMatchObject({ action: "unchanged" });
    applyBudgetUnsetup(deps());
    expect(readFileSync(SETTINGS(), "utf8")).toBe(original);
  });

  it("unsetup takes a version-1 wrapper out directly too", () => {
    const text = JSON.stringify({ statusLine: { type: "command", command: v1Wrapper(STAPLE, claudeDir, ORIGINAL) } }, null, 2);
    writeFileSync(SETTINGS(), text);
    applyBudgetUnsetup(deps());
    expect(JSON.parse(readFileSync(SETTINGS(), "utf8"))).toEqual({ statusLine: { type: "command", command: ORIGINAL } });
  });
});

describe("settings.json that is a symlink, read-only, or oddly laid out", () => {
  it("edits the file a symlink points at and keeps the link; unsetup restores the target byte for byte", () => {
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    const real = join(dotfiles, "claude-settings.json");
    writeFileSync(real, PRETTY);
    symlinkSync(real, SETTINGS());
    applyBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
    expect(lstatSync(SETTINGS()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(SETTINGS())).toBe(real);
    expect(readSettingsState(real)).toMatchObject({ state: "command", kind: "staple" });
    expect(readdirSync(dotfiles)).toEqual(["claude-settings.json"]);
    applyBudgetUnsetup(deps());
    expect(lstatSync(SETTINGS()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(PRETTY);
  });

  it("refuses a dangling symlink", () => {
    symlinkSync(join(root, "nowhere.json"), SETTINGS());
    const plan = planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
    expect(plan.steps.find((step) => step.part === "statusline")).toMatchObject({ action: "refuse" });
  });

  it("refuses a read-only settings.json at plan time and changes nothing", () => {
    writeFileSync(SETTINGS(), PRETTY);
    chmodSync(SETTINGS(), 0o444);
    try {
      const before = snapshot();
      const plan = planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
      expect(plan.steps.find((step) => step.part === "statusline")).toMatchObject({ action: "refuse", summary: expect.stringContaining("not writable") });
      expect(() => applyBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps())).toThrow(/refused, nothing was changed/);
      expect(snapshot()).toEqual(before);
    } finally {
      chmodSync(SETTINGS(), 0o644);
    }
  });

  it("refuses when the directory holding settings.json is read-only (the rename would fail)", () => {
    writeFileSync(SETTINGS(), PRETTY);
    chmodSync(claudeDir, 0o555);
    try {
      const plan = planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
      expect(plan.steps.find((step) => step.part === "statusline")).toMatchObject({ action: "refuse", summary: expect.stringContaining("not writable") });
    } finally {
      chmodSync(claudeDir, 0o755);
    }
  });
});

describe("launchd, beyond the happy path", () => {
  it("unsetup with a stale local plist never unloads another home's agent", () => {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(PLIST(), "<plist/>");
    loaded = "/Users/someone/Library/LaunchAgents/com.staple.budget-collect.plist";
    const outcome = applyBudgetUnsetup(deps());
    expect(outcome.applied.map((step) => step.part)).toContain("watcher");
    expect(calls.some((call) => call[0] === "bootout")).toBe(false);
    expect(loaded).toBe("/Users/someone/Library/LaunchAgents/com.staple.budget-collect.plist");
    expect(existsSync(PLIST())).toBe(false);
  });

  it("recognises its own agent through a symlinked path (/var vs /private/var)", () => {
    const realAgents = join(root, "real-agents");
    mkdirSync(realAgents, { recursive: true });
    mkdirSync(join(userHome, "Library"), { recursive: true });
    symlinkSync(realAgents, agentsDir);
    applyBudgetSetup({ codexAccount: "codex-plus" }, deps());
    // launchd reports the resolved path.
    loaded = join(realAgents, `${COLLECT_AGENT_LABEL}.plist`);
    calls = [];
    const again = applyBudgetSetup({ codexAccount: "codex-plus" }, deps());
    expect(again.applied).toEqual([]);
    expect(budgetCollectionStatus(deps()).watcher).toMatchObject({ installed: true, loaded: true });
    applyBudgetUnsetup(deps());
    expect(calls).toContainEqual(["bootout", `gui/501/${COLLECT_AGENT_LABEL}`]);
  });

  it("reports what was applied when launchctl fails part way, and unsetup reverses it", () => {
    const failing: LaunchctlRunner = (args) => (args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : fakeLaunchctl(args));
    const error = refusal(() => applyBudgetSetup({ codexAccount: "codex-plus" }, deps({ launchctl: failing })));
    expect(error.message).toContain("setup stopped at watcher");
    expect(error.detail).toMatchObject({ reason: "setup_incomplete", failedStep: "watcher" });
    expect(readSetupRecord(home)).not.toBeNull();
    applyBudgetUnsetup(deps());
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: false, bindings: [] });
    expect(existsSync(PLIST())).toBe(false);
  });

  it("flags a watcher whose PATH has no node", () => {
    applyBudgetSetup({ codexAccount: "codex-plus" }, deps());
    const plist = readFileSync(PLIST(), "utf8").replace(/<key>PATH<\/key><string>[^<]*<\/string>/, `<key>PATH</key><string>${join(root, "no-node")}</string>`);
    writeFileSync(PLIST(), plist);
    expect(budgetCollectionStatus(deps()).problems.map((problem) => problem.code)).toContain("watcher_node_missing");
  });

  it("puts the fallback node homes on the agent's PATH after the node setup ran under", () => {
    const plist = agentPlist({ staple: STAPLE, nodePath: "/Users/x/.nvm/versions/node/v22/bin/node", userHome, stapleHomeEnv: null, intervalMinutes: 5, logPath: "/tmp/l" });
    expect(plist).toContain("<key>PATH</key><string>/Users/x/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
  });
});

describe("budget collect: one run at a time, and tail reads", () => {
  beforeEach(optIn);

  it("returns locked while another live run holds the lock, and takes over a stale one", () => {
    rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    mkdirSync(join(home, "telemetry"), { recursive: true });
    writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const locked = collectBudget({}, deps());
    expect(locked).toMatchObject({ skippedReason: "locked", storedCount: 0 });
    expect(existsSync(lockPath(home))).toBe(true);
    // A dead holder: taken over.
    writeFileSync(lockPath(home), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
    expect(collectBudget({}, deps())).toMatchObject({ skippedReason: null, storedCount: 1 });
    expect(existsSync(lockPath(home))).toBe(false);
  });

  it("reads a line that was half-written at the last read once it is complete", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10]);
    const line = tokenCountLine({ timestamp: "2026-09-26T08:05:00.000Z", primary: five(15), secondary: null });
    collectBudget({}, deps());
    appendFileSync(file, line.slice(0, 40));
    expect(collectBudget({}, deps())).toMatchObject({ storedCount: 0 });
    appendFileSync(file, `${line.slice(40)}\n`);
    const done = collectBudget({}, deps());
    expect(done.files[0]).toMatchObject({ mode: "tail", storedCount: 1 });
  });

  it("reads a rewritten file whole", () => {
    const file = rollout(A, "2026-09-26T08:00:00.000Z", [10, 11]);
    collectBudget({}, deps());
    writeFileSync(file, readFileSync(file, "utf8").replace('"plus"', '"pro"') + `${tokenCountLine({ timestamp: "2026-09-26T08:09:00.000Z", primary: five(30), secondary: null })}\n`);
    const again = collectBudget({}, deps());
    expect(again.files[0]!.mode).toBe("full");
  });

  it("reads a fork whole until its copied history has ended, then resumes at the tail", () => {
    const parentStart = "2026-09-26T07:00:00.000Z";
    writeRollout(codexDir, A, parentStart, [
      sessionMetaLine({ id: A, timestamp: parentStart }),
      tokenCountLine({ timestamp: "2026-09-26T07:10:00.000Z", primary: five(20), secondary: null }),
    ]);
    const fork = "2026-09-26T07:30:00.000Z";
    // Only copies so far: the leading run has not ended.
    const child = writeRollout(codexDir, B, fork, [sessionMetaLine({ id: B, timestamp: fork, forkedFromId: A }), tokenCountLine({ timestamp: after(fork, 1), primary: five(20), secondary: null })]);
    collectBudget({}, deps());
    appendFileSync(child, `${tokenCountLine({ timestamp: after(fork, 2), primary: five(20), secondary: null })}\n`);
    const second = collectBudget({}, deps());
    const whole = second.files.find((file) => file.file === child)!;
    expect(whole.mode).toBe("full");
    expect(whole.skipped.fork_copied).toBe(2);
    appendFileSync(child, `${tokenCountLine({ timestamp: after(fork, 60_000), primary: five(26), secondary: null })}\n`);
    const third = collectBudget({}, deps());
    expect(third.files.find((file) => file.file === child)).toMatchObject({ mode: "full", storedCount: 1 });
    appendFileSync(child, `${tokenCountLine({ timestamp: after(fork, 120_000), primary: five(27), secondary: null })}\n`);
    expect(collectBudget({}, deps()).files.find((file) => file.file === child)).toMatchObject({ mode: "tail", storedCount: 1 });
  });
});

// ------------------------------------------------------------------ round 2 review

describe("round 2: noclobber, regrown rollouts, lock edges", () => {
  const noclobber = (shell: string) => (shell.endsWith("zsh") ? "setopt noclobber" : "set -C");

  for (const shell of SHELLS) {
    it(`${shell} with noclobber: the wrapper still prints what the original prints and hands staple the input`, () => {
      const out = join(root, "ingested");
      const fake = join(root, "fake staple");
      writeFileSync(fake, `#!/bin/sh\ncat > "${out}.tmp"; mv "${out}.tmp" "${out}"\n`);
      chmodSync(fake, 0o755);
      const original = `head -c 30; echo " ok"`;
      const input = statusline();
      const direct = spawnSync(shell, ["-c", `${noclobber(shell)}; ${original}`], { input });
      const wrapped = spawnSync(shell, ["-c", `${noclobber(shell)}; ${wrapperCommand({ staple: fake, configDir: claudeDir, original })}`], { input });
      expect(wrapped.stdout.toString()).not.toBe("");
      expect(Buffer.compare(wrapped.stdout, direct.stdout)).toBe(0);
      expect(wrapped.stderr.toString()).toBe("");
      const deadline = Date.now() + 10_000;
      while (!existsSync(out) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
      expect(readFileSync(out, "utf8")).toBe(input);
    });
  }

  it("setup rewrites a wrapper that is not exactly what this build writes (an earlier v2)", () => {
    const current = wrapperCommand({ staple: STAPLE, configDir: claudeDir, original: ORIGINAL });
    const earlier = current.replace('cat >| "$__stf"', 'cat > "$__stf"').replace(" unset __stf;", "");
    writeFileSync(SETTINGS(), JSON.stringify({ statusLine: { type: "command", command: earlier } }, null, 2));
    expect(planBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps()).steps.find((step) => step.part === "statusline")).toMatchObject({ action: "change" });
    applyBudgetSetup({ claudeAccount: "claude-max", watcher: false }, deps());
    expect((JSON.parse(readFileSync(SETTINGS(), "utf8")) as { statusLine: { command: string } }).statusLine.command).toBe(current);
  });

  describe("regrown and shrunk rollouts", () => {
    beforeEach(optIn);
    const start = "2026-09-26T06:00:00.000Z";
    const lines = (values: number[], offsetMinutes = 0) =>
      values.map((u, i) => tokenCountLine({ timestamp: after(start, (offsetMinutes + i + 1) * 60_000), primary: five(u), secondary: null }));
    const write = (path: string, body: string[]) => writeFileSync(path, `${[sessionMetaLine({ id: A, timestamp: start }), ...body].join("\n")}\n`);

    it("reads a file truncated and regrown past the old offset whole, even with the same first 4 KiB", () => {
      const file = rollout(A, start, Array.from({ length: 20 }, (_, i) => 10 + i));
      collectBudget({}, deps());
      expect(statSync(file).size).toBeGreaterThan(3 * 4096);
      // Same head (the first 6 readings), a different middle, and longer than before.
      write(file, [...lines([10, 11, 12, 13, 14, 15]), ...lines(Array.from({ length: 20 }, (_, i) => 60 + i), 6)]);
      const again = collectBudget({}, deps());
      expect(again.files[0]!.mode).toBe("full");
      // Every changed middle reading is stored: 20 new values, none skipped by a tail read.
      expect(again.files[0]!.storedCount).toBe(20);
    });

    it("reads a file shrunk below the old offset whole (first 4 KiB kept)", () => {
      const file = rollout(A, start, Array.from({ length: 20 }, (_, i) => 10 + i));
      collectBudget({}, deps());
      const before = statSync(file).size;
      // Keep the head, drop the rest, then add two new readings: still shorter than before.
      write(file, [...lines([10, 11, 12, 13, 14, 15]), ...lines([90, 91], 30)]);
      expect(statSync(file).size).toBeLessThan(before);
      expect(statSync(file).size).toBeGreaterThan(4096);
      const again = collectBudget({}, deps());
      expect(again.files[0]).toMatchObject({ mode: "full", error: null, storedCount: 2 });
    });
  });

  describe("lock edges", () => {
    beforeEach(optIn);

    it("keeps a live holder's lock even when its time cannot be read", () => {
      mkdirSync(join(home, "telemetry"), { recursive: true });
      writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, at: "not a time" }));
      expect(collectBudget({}, deps())).toMatchObject({ skippedReason: "locked" });
      writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid }));
      expect(collectBudget({}, deps())).toMatchObject({ skippedReason: "locked" });
    });

    it("takes over a live pid's lock once it is older than the stale limit, and leaves nothing aside", () => {
      mkdirSync(join(home, "telemetry"), { recursive: true });
      writeFileSync(lockPath(home), JSON.stringify({ pid: process.pid, at: "2020-01-01T00:00:00.000Z" }));
      expect(collectBudget({}, deps())).toMatchObject({ skippedReason: null });
      expect(readdirSync(join(home, "telemetry")).filter((name) => name.startsWith("collect.lock"))).toEqual([]);
    });

    it("never takes over a lock another run created between judging the old one stale and moving it aside", () => {
      mkdirSync(join(home, "telemetry"), { recursive: true });
      const dead = JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() });
      const fresh = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
      writeFileSync(lockPath(home), dead);
      // The race: another run replaces the stale lock with its own, right before this one moves it.
      const took = acquireLock(home, Date.now(), { beforeMoveAside: () => writeFileSync(lockPath(home), fresh) });
      expect(took).toBe(false);
      expect(readFileSync(lockPath(home), "utf8")).toBe(fresh);
      expect(readdirSync(join(home, "telemetry")).filter((name) => name.startsWith("collect.lock"))).toEqual(["collect.lock"]);
    });

    it("takes over an unreadable lock (a crash mid-write)", () => {
      mkdirSync(join(home, "telemetry"), { recursive: true });
      writeFileSync(lockPath(home), "{");
      expect(collectBudget({}, deps())).toMatchObject({ skippedReason: null });
    });
  });
});
