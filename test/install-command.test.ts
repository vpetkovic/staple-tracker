/**
 * A8 (STA-38) — `runInstallCommand`, the command surface.
 *
 * A5 owns `src/cli.ts` for the duration of this ticket, so the command is
 * exported from `src/install/index.ts` and wired in at merge with a three-line
 * `case`. These tests therefore call `runInstallCommand(argv)` directly, which
 * is exactly what that `case` will do — the same seam `runConfigCommand` uses.
 *
 * What is pinned here is the house style, because that is what a later wiring
 * change could silently break: `StapleError` out (cli.ts's existing top-level
 * catch turns it into the envelope and the exit code), one line of JSON on
 * stdout under `--json`, consent flags enforced BEFORE any mutation.
 *
 * `--home` and `--bin-dir` are what keep every case inside a temporary
 * directory. No test here may read or write the developer's real `~/.staple`,
 * `~/.local/bin`, or shell profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInstallCommand } from "../src/install/index.js";
import { clearHomeOverride } from "../src/config/index.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { StapleError } from "../src/core/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { writeFakePayload } from "./fixtures/install-support.js";
import { FIXTURES, fixturePath, rawMeta } from "./fixtures/schema/support.js";

let scratch: string;
let home: string;
let binDir: string;
let payloads: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  scratch = tempDir("install-cmd");
  home = join(scratch, "home");
  binDir = join(scratch, "bin");
  payloads = join(scratch, "payloads");
  mkdirSync(payloads, { recursive: true });
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // --home sets a process-level override in the config module; leaking it into
  // a later suite would repoint that suite at a deleted temp directory.
  clearHomeOverride();
  removeDir(scratch);
});

function payload(version: string, options?: Parameters<typeof writeFakePayload>[2]): string {
  return writeFakePayload(join(payloads, version), version, options);
}

/** Every case is scoped to the temp home and temp bin dir. */
function run(args: string[]): void {
  runInstallCommand(["--home", home, "--bin-dir", binDir, ...args]);
}

function install(version: string, extra: string[] = []): void {
  run(["--from", payload(version), "--yes", ...extra]);
}

function lastJson(): Record<string, unknown> {
  const last = stdout.at(-1);
  if (last === undefined) throw new Error("expected a line of JSON on stdout, got nothing");
  return JSON.parse(last);
}

describe("consent: nothing mutates without --yes", () => {
  it("refuses to install and previews instead", () => {
    expect(() => run(["--from", payload("1.0.0")])).toThrow(/Refusing to install without --yes/);

    expect(existsSync(join(home, "runtime"))).toBe(false);
    expect(existsSync(binDir)).toBe(false);
  });

  it("carries the preview as StapleError detail, so --json callers can read the plan", () => {
    const error = (() => {
      try {
        run(["--from", payload("1.0.0")]);
        return null;
      } catch (caught) {
        return caught as StapleError;
      }
    })();

    expect(error).toBeInstanceOf(StapleError);
    expect(error!.code).toBe("validation");
    const detail = error!.detail as Record<string, any>;
    expect(detail.home).toBe(home);
    expect(detail.binDir).toBe(binDir);
    expect(detail.currentVersion).toBeNull();
    expect(detail.wouldInstall.from).toContain("1.0.0");
  });

  it("reports a bad --from BEFORE complaining about the missing --yes", () => {
    // Otherwise the user fixes the consent flag, re-runs, and only then learns
    // the payload path was wrong.
    expect(() => run(["--from", join(scratch, "nope")])).toThrow(/does not exist/);
    expect(() => run(["--from", payload("1.0.0", { withoutAssets: true })])).toThrow(
      /not a staple payload/,
    );
  });

  it("refuses to roll back without --yes and names both versions in the message", () => {
    install("1.0.0");
    install("2.0.0");

    expect(() => run(["rollback"])).toThrow(/Would roll back from 2\.0\.0 to 1\.0\.0/);
    expect(() => run(["--rollback"])).toThrow(/Refusing to switch runtimes without --yes/);
  });
});

describe("install", () => {
  it("installs and summarises on stdout", () => {
    install("1.0.0");

    expect(existsSync(join(home, "runtime", "versions", "1.0.0", "staple.mjs"))).toBe(true);
    expect(existsSync(join(binDir, "staple"))).toBe(true);
    expect(stdout.join("\n")).toContain("Installed staple 1.0.0");
  });

  it("emits exactly one line of JSON under --json", () => {
    install("1.0.0", ["--json"]);

    expect(stdout).toHaveLength(1);
    const payloadJson = lastJson();
    expect(payloadJson.version).toBe("1.0.0");
    expect(payloadJson.home).toBe(home);
    expect(payloadJson.previousVersion).toBeNull();
  });

  it("names the rollback target on a second install", () => {
    install("1.0.0");
    stdout.length = 0;
    install("2.0.0");

    expect(stdout.join("\n")).toContain("`staple install --rollback --yes` returns to 1.0.0");
  });

  it("says which workspace schema the installed runtime understands, and where the prior one is retained", () => {
    install("1.0.0");
    stdout.length = 0;
    install("2.0.0");

    const text = stdout.join("\n");
    expect(text).toContain(`Schema     understands workspace schema ${WORKSPACE_LATEST_VERSION}`);
    expect(text).toContain(`returns to 1.0.0, retained at ${join(home, "runtime", "versions", "1.0.0")}.`);
  });

  it("exposes the schema and the retained path under --json", () => {
    install("1.0.0");
    install("2.0.0", ["--json"]);

    const payloadJson = lastJson();
    expect(payloadJson.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
    expect(payloadJson.previousVersionPath).toBe(join(home, "runtime", "versions", "1.0.0"));
  });

  it("throws StapleError — cli.ts's existing catch owns the envelope and exit code", () => {
    let caught: unknown;
    try {
      run(["--from", payload("1.0.0", { doubleShebang: true }), "--yes"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StapleError);
    expect((caught as StapleError).code).toBe("validation");
  });

  it("rejects an unknown subcommand with usage", () => {
    expect(() => run(["wat"])).toThrow(/Unknown install subcommand "wat"/);
  });

  it("classifies a bad flag the way the CLI does, via parseArgs", () => {
    // cli.ts normalizes ERR_PARSE_ARGS_* into a validation StapleError at the
    // top level; the command's job is only to let it out unchanged.
    expect(() => run(["--nonsense"])).toThrow(/Unknown option/);
  });
});

describe("status", () => {
  it("says nothing is installed for a fresh home", () => {
    run(["status"]);
    expect(stdout.join("\n")).toContain("No staple runtime is installed");
  });

  it("prints the active version, rollback target and launcher", () => {
    install("1.0.0");
    install("2.0.0");
    stdout.length = 0;

    run(["status"]);
    const text = stdout.join("\n");
    expect(text).toContain("version    2.0.0");
    expect(text).toContain(`schema     understands workspace schema ${WORKSPACE_LATEST_VERSION}`);
    expect(text).toContain(`previous   1.0.0  retained at ${join(home, "runtime", "versions", "1.0.0")}`);
    expect(text).toContain("versions   1.0.0, 2.0.0");
    expect(text).toContain(join(binDir, "staple"));
  });

  it("is read-only — it does not create the home it reports on", () => {
    run(["status", "--json"]);
    expect(existsSync(home)).toBe(false);
    expect(lastJson().installed).toBe(false);
  });

  it("flags a version whose bytes changed under it", () => {
    install("1.0.0");
    writeFileSync(join(home, "runtime", "versions", "1.0.0", "assets", "index.html"), "tampered");
    stdout.length = 0;
    stderr.length = 0;

    run(["status"]);
    expect(stdout.join("\n")).toContain("FAILS VERIFICATION");
    expect(stderr.join("\n")).toMatch(/assets\/index\.html/);
  });
});

describe("rollback", () => {
  it("switches back and says what the next rollback would do", () => {
    install("1.0.0");
    install("2.0.0");
    stdout.length = 0;

    run(["rollback", "--yes"]);

    expect(stdout.join("\n")).toContain("Rolled back to staple 1.0.0 (from 2.0.0)");
    expect(stdout.join("\n")).toContain("now returns to 2.0.0");
  });

  it("accepts the plan's `install --rollback` spelling too", () => {
    install("1.0.0");
    install("2.0.0");

    run(["--rollback", "--yes", "--json"]);
    expect(lastJson().to).toBe("1.0.0");
  });

  /**
   * STA-164: a rollback switches the runtime selection and nothing else. The
   * case that matters is a workspace the newer runtime already migrated — it
   * stays at the newer schema, byte for byte, and the output says so, so nobody
   * reads "rolled back" as "un-migrated".
   */
  it("restores the runtime selection without touching a workspace the newer runtime already upgraded", () => {
    install("1.0.0");
    install("2.0.0");
    const workspace = join(scratch, "ws", ".staple");
    mkdirSync(workspace, { recursive: true });
    const dbPath = join(workspace, "staple.db");
    copyFileSync(fixturePath(FIXTURES.workspaceV99), dbPath);
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    stdout.length = 0;

    run(["--rollback", "--yes"]);

    expect(stdout.join("\n")).toContain("Rolled back to staple 1.0.0 (from 2.0.0)");
    expect(stdout.join("\n")).toContain("Workspaces no database was changed");
    expect(stdout.join("\n")).toContain("refused read-only until you roll forward again");
    expect(readFileSync(join(home, "runtime", "current.json"), "utf8")).toContain('"version": "1.0.0"');
    expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(before);
    expect(rawMeta(dbPath, "schema_version")).toBe("99");
  });
});

describe("PATH handling", () => {
  /** A profile file inside the scratch dir — never the developer's real one. */
  function profile(): string {
    const path = join(scratch, "profile.zshrc");
    if (!existsSync(path)) writeFileSync(path, "# existing user content\n");
    return path;
  }

  it("prints the exact export line and does NOT edit anything when --update-path is absent", () => {
    install("1.0.0", ["--profile", profile()]);

    const text = stdout.join("\n");
    expect(text).toContain("is not on your PATH");
    expect(text).toContain(`export PATH="${binDir}:$PATH"`);
    // Plan §6: declining leaves the runtime usable by absolute path.
    expect(text).toContain(join(binDir, "staple"));
    expect(readFileSync(profile(), "utf8")).toBe("# existing user content\n");
  });

  it("appends a marked block only when --update-path is given with --yes", () => {
    install("1.0.0", ["--update-path", "--profile", profile()]);

    const text = readFileSync(profile(), "utf8");
    expect(text).toContain("# existing user content");
    expect(text).toContain("# >>> staple >>>");
    expect(text).toContain(`export PATH="${binDir}:$PATH"`);
    expect(stdout.join("\n")).toContain(`PATH       added to ${profile()}`);
  });

  it("is idempotent — a second install does not append a duplicate block", () => {
    install("1.0.0", ["--update-path", "--profile", profile()]);
    const after = readFileSync(profile(), "utf8");
    install("2.0.0", ["--update-path", "--profile", profile()]);

    expect(readFileSync(profile(), "utf8")).toBe(after);
    expect(after.match(/# >>> staple >>>/g)).toHaveLength(1);
  });

  it("preserves the user's existing profile content byte for byte", () => {
    const path = profile();
    const original = "# existing user content\nexport EDITOR=vim\n";
    writeFileSync(path, original);

    install("1.0.0", ["--update-path", "--profile", path]);

    expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
  });
});
