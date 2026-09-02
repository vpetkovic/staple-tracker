/**
 * A3 (STA-33) — the `staple config` surface, through the real binary.
 *
 * STA-24 plan command table:
 *   `staple config`                     show effective settings and their source;
 *                                       set UI and home preferences
 *   `staple config home <path> --move`  requires an absolute path, `--move` and
 *                                       `--yes`; exit 2 on missing flags, active
 *                                       locks, or an unsafe destination
 *
 * Every case runs the child with its own `HOME`, so the bootstrap locator lands
 * in a scratch directory and never touches the developer's real machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let sandbox: string;
let cwd: string;

/** A child whose HOME (and therefore locator, and therefore default home) is ours. */
function config(childHome: string, args: string[], env: Record<string, string> = {}) {
  return runCliAt(cwd, ["config", ...args], { HOME: childHome, ...env }, 25_000);
}

function freshHome(name: string): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface ShowJson {
  home: { value: string; source: string };
  configPath: string;
  configPresent: boolean;
  locator: { path: string; present: boolean; home: string | null };
  settings: {
    browser: { value: unknown; source: string };
    port: { value: unknown; source: string };
    setupComplete: { value: unknown; source: string };
  };
  unknownKeys: string[];
}

const showJson = (childHome: string, env: Record<string, string> = {}): ShowJson => {
  const result = config(childHome, ["--json"], env);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ShowJson;
};

beforeAll(() => {
  sandbox = tempDir("cli-config");
  cwd = freshHome("cwd");
});

afterAll(() => {
  removeDir(sandbox);
});

describe("config show", () => {
  it("is a known command, not an unknown one", () => {
    const result = config(freshHome("known"), []);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.status).toBe(0);
  });

  it("bare `config` and `config show` agree", () => {
    const home = freshHome("agree");
    expect(config(home, []).stdout).toBe(config(home, ["show"]).stdout);
  });

  it("reports the default home and marks every setting as a default", () => {
    const home = freshHome("defaults");
    const shown = showJson(home);
    expect(shown.home).toEqual({ value: join(home, ".staple"), source: "default" });
    expect(shown.configPresent).toBe(false);
    expect(shown.settings.browser).toEqual({ value: "auto", source: "default" });
    expect(shown.settings.port).toEqual({ value: 4400, source: "default" });
    expect(shown.settings.setupComplete).toEqual({ value: false, source: "default" });
  });

  it("names STAPLE_HOME as the source when the env sets the home", () => {
    const home = freshHome("envsrc");
    const staple = join(sandbox, "env-home");
    expect(showJson(home, { STAPLE_HOME: staple }).home).toEqual({ value: staple, source: "env" });
  });

  it("names the locator as the source when a locator is present", () => {
    const home = freshHome("locsrc");
    const relocated = join(sandbox, "loc-home");
    expect(config(home, ["home", relocated, "--move", "--yes"]).status).toBe(0);
    const shown = showJson(home);
    expect(shown.home).toEqual({ value: relocated, source: "locator" });
    expect(shown.locator.present).toBe(true);
    expect(shown.locator.home).toBe(relocated);
  });

  it("--home overrides everything and is reported as the flag source", () => {
    const home = freshHome("flagsrc");
    const explicit = join(sandbox, "flag-home");
    const shown = JSON.parse(
      config(home, ["--home", explicit, "--json"], { STAPLE_HOME: join(sandbox, "ignored") }).stdout,
    ) as ShowJson;
    expect(shown.home).toEqual({ value: explicit, source: "flag" });
  });

  it("marks a setting that came from config.json as `config`", () => {
    const home = freshHome("cfgsrc");
    const staple = join(home, ".staple");
    expect(config(home, ["set", "port", "4999"]).status).toBe(0);
    const shown = showJson(home);
    expect(shown.settings.port).toEqual({ value: 4999, source: "config" });
    expect(shown.settings.browser.source).toBe("default");
    expect(shown.configPresent).toBe(true);
    expect(shown.configPath).toBe(join(staple, "config.json"));
  });

  it("human output puts one setting per line with a stable leading key column", () => {
    const home = freshHome("human");
    const stdout = config(home, []).stdout;
    const keys = stdout
      .trimEnd()
      .split("\n")
      .map((l) => l.slice(0, 14).trimEnd());
    expect(keys).toEqual(["home", "config", "locator", "browser", "port", "setup"]);
  });

  it("lists unknown future keys instead of hiding them", () => {
    const home = freshHome("unknown");
    const staple = join(home, ".staple");
    mkdirSync(staple, { recursive: true });
    writeFileSync(
      join(staple, "config.json"),
      JSON.stringify({ schemaVersion: 1, somethingNewer: true }),
    );
    expect(showJson(home).unknownKeys).toEqual(["somethingNewer"]);
  });

  it("refuses a corrupt config with exit 2 and names the file", () => {
    const home = freshHome("corrupt");
    const staple = join(home, ".staple");
    mkdirSync(staple, { recursive: true });
    writeFileSync(join(staple, "config.json"), "{ nope");
    const result = config(home, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error(validation)");
    expect(result.stderr).toContain(join(staple, "config.json"));
  });
});

describe("config set", () => {
  it("sets and persists a port", () => {
    const home = freshHome("setport");
    const result = config(home, ["set", "port", "4777"]);
    expect(result.status).toBe(0);
    expect(showJson(home).settings.port.value).toBe(4777);
  });

  it("sets a browser preference", () => {
    const home = freshHome("setbrowser");
    expect(config(home, ["set", "browser", "never"]).status).toBe(0);
    expect(showJson(home).settings.browser).toEqual({ value: "never", source: "config" });
  });

  it("sets setupComplete from a boolean word", () => {
    const home = freshHome("setsetup");
    expect(config(home, ["set", "setupComplete", "true"]).status).toBe(0);
    expect(showJson(home).settings.setupComplete.value).toBe(true);
  });

  it("--json returns the key, the new value, and where it was written", () => {
    const home = freshHome("setjson");
    const result = config(home, ["set", "port", "4788", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: "port",
      value: 4788,
      path: join(home, ".staple", "config.json"),
    });
  });

  it("rejects an unknown key with exit 2", () => {
    const result = config(freshHome("setbadkey"), ["set", "nonsense", "1"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error(validation)");
  });

  it("rejects an unparseable value with exit 2", () => {
    const result = config(freshHome("setbadval"), ["set", "port", "not-a-number"]);
    expect(result.status).toBe(2);
  });

  it("rejects a missing value with exit 2", () => {
    expect(config(freshHome("setnoval"), ["set", "port"]).status).toBe(2);
  });

  it("writing one key leaves the others alone", () => {
    const home = freshHome("setmerge");
    expect(config(home, ["set", "port", "4799"]).status).toBe(0);
    expect(config(home, ["set", "browser", "always"]).status).toBe(0);
    const shown = showJson(home);
    expect(shown.settings.port.value).toBe(4799);
    expect(shown.settings.browser.value).toBe("always");
  });
});

describe("config home", () => {
  it("requires an absolute path", () => {
    const result = config(freshHome("relmove"), ["home", "relative/path", "--move", "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/absolute/i);
  });

  it("refuses a filesystem root", () => {
    const result = config(freshHome("rootmove"), ["home", "/", "--move", "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/root/i);
  });

  it("without --move, refuses a change that would strand existing data", () => {
    const home = freshHome("strand");
    expect(config(home, ["set", "port", "4400"]).status).toBe(0); // create data in the old home
    const result = config(home, ["home", join(sandbox, "strand-target"), "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--move/);
  });

  it("requires --yes before it mutates", () => {
    const home = freshHome("noyes");
    const target = join(sandbox, "noyes-target");
    const result = config(home, ["home", target, "--move"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--yes/);
    expect(existsSync(target)).toBe(false);
  });

  it("moves config, hub, and workspaces, then points the locator at the new home", () => {
    const home = freshHome("realmove");
    const old = join(home, ".staple");
    const target = join(sandbox, "realmove-target");
    // Populate the old home the way normal use would: a hub row and a preference.
    expect(runCliAt(cwd, ["init", "--global", "movable"], { HOME: home }).status).toBe(0);
    expect(config(home, ["set", "port", "4811"]).status).toBe(0);
    expect(existsSync(join(old, "hub.db"))).toBe(true);

    const result = config(home, ["home", target, "--move", "--yes"]);
    expect(result.status, result.stderr).toBe(0);

    // Everything arrived.
    expect(existsSync(join(target, "hub.db"))).toBe(true);
    expect(existsSync(join(target, "config.json"))).toBe(true);
    expect(existsSync(join(target, "workspaces", "movable.db"))).toBe(true);
    // The old home is RETAINED until doctor confirms — plan §2.
    expect(existsSync(join(old, "hub.db"))).toBe(true);
    // The locator, written last, now decides.
    expect(showJson(home).home).toEqual({ value: target, source: "locator" });
    expect(showJson(home).settings.port.value).toBe(4811);
    // And the moved workspace is reachable from the new home.
    expect(runCliAt(cwd, ["hub", "ls"], { HOME: home }).stdout).toContain("movable");
  }, 60_000);

  it("--json reports the source, the target, and what it copied", () => {
    const home = freshHome("movejson");
    const target = join(sandbox, "movejson-target");
    expect(config(home, ["set", "port", "4822"]).status).toBe(0);
    const result = config(home, ["home", target, "--move", "--yes", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      from: string;
      to: string;
      copied: string[];
      locator: string;
      retained: string;
    };
    expect(payload.from).toBe(join(home, ".staple"));
    expect(payload.to).toBe(target);
    expect(payload.copied).toContain("config.json");
    expect(payload.retained).toBe(join(home, ".staple"));
  });

  it("refuses a non-empty destination rather than merging into it", () => {
    const home = freshHome("occupied");
    const target = join(sandbox, "occupied-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "someone-elses-file"), "hello");
    expect(config(home, ["set", "port", "4833"]).status).toBe(0);
    const result = config(home, ["home", target, "--move", "--yes"]);
    expect(result.status).toBe(4);
    expect(readFileSync(join(target, "someone-elses-file"), "utf8")).toBe("hello");
  });

  it("refuses a destination nested inside the source", () => {
    const home = freshHome("nested");
    expect(config(home, ["set", "port", "4844"]).status).toBe(0);
    const result = config(home, ["home", join(home, ".staple", "inner"), "--move", "--yes"]);
    expect(result.status).toBe(2);
  });

  it("moving to the home already in effect is a no-op success", () => {
    const home = freshHome("same");
    expect(config(home, ["set", "port", "4855"]).status).toBe(0);
    const result = config(home, ["home", join(home, ".staple"), "--move", "--yes"]);
    expect(result.status, result.stderr).toBe(0);
  });

  /**
   * `STAPLE_HOME` outranks the locator, so a move performed in a shell that
   * exports it writes a locator nothing will read. Say so rather than leaving
   * the user to discover it.
   */
  it("warns when STAPLE_HOME will shadow the locator it just wrote", () => {
    const home = freshHome("shadow");
    const envHome = join(sandbox, "shadow-env");
    mkdirSync(envHome, { recursive: true });
    const result = config(home, ["home", join(sandbox, "shadow-target"), "--move", "--yes"], {
      STAPLE_HOME: envHome,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("STAPLE_HOME");
  });
});

describe("--home is scoped to config, not global", () => {
  it("`ls --home x` is still an unknown option", () => {
    const result = runCliAt(cwd, ["ls", "--home", "/tmp/x"], { HOME: freshHome("scoped") }, 20_000);
    expect(result.status).toBe(2);
  });
});
