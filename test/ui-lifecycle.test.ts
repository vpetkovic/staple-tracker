/**
 * A6 (STA-36) — the `staple open` PROCESS lifecycle.
 *
 * `characterize-ui-server.test.ts` froze the "before" and marked four things as
 * A6's to change. This suite is the "after", and every case below is one of
 * them:
 *
 *   - Ctrl-C / SIGTERM close the server and the database handles, and return a
 *     signal-appropriate exit status (plan §1 step 7).
 *   - An occupied EXPLICIT `--port` fails with a diagnostic instead of an
 *     unhandled `'error'` event.
 *   - An occupied IMPLICIT port falls back to an OS-assigned one and prints it.
 *   - `--port abc` is validation exit 2, like every other bad flag value.
 *
 * Plus the two the plan adds: resolution happens before the socket binds, and
 * `--json` is refused for a long-lived server.
 *
 * Nothing here launches a browser: `--no-browser` everywhere, and the machine
 * config left at its default `browser: auto` would refuse anyway because a test
 * child has no TTY.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, removeDir, runCliAt, tempDir, REPO_ROOT } from "./fixtures/characterize-support.js";
import { boundPortOf, LISTENING, spawnCli } from "./fixtures/lifecycle-support.js";

let home: string;
let root: string;
let repo: string;
/** A directory with no workspace at or above it, for the resolution cases. */
let barren: string;

beforeAll(() => {
  home = tempDir("a6-ui-home");
  root = tempDir("a6-ui-root");
  repo = join(root, "openrepo");
  mkdirSync(repo, { recursive: true });
  expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
  // tempDir() is its own filesystem root's child, so a walk-up from here finds
  // nothing — which is the point.
  barren = tempDir("a6-ui-barren");
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
  removeDir(barren);
});

function open(args: string[], cwd = repo) {
  return spawnCli(["open", ...args, "--no-browser"], { cwd, env: { STAPLE_HOME: home } });
}

// ---------------------------------------------------------------- shutdown

describe("foreground shutdown", () => {
  /**
   * MOVES the A1 pin "src/cli.ts installs no signal handler and never calls the
   * returned close()". That assertion read the SOURCE for the absence of a
   * handler; this one proves the behaviour instead, which is strictly better
   * evidence and does not care which module the handler ends up living in.
   */
  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s closes the server and exits 128+signal",
    async (signal) => {
      const port = await freePort();
      const proc = open(["--port", String(port)]);
      expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

      proc.signalIt(signal);
      const code = await proc.waitForExit(25_000);

      // 130 for SIGINT (128+2), 143 for SIGTERM (128+15). A default disposition
      // would have reported a terminating SIGNAL and a null code instead.
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(proc.signal()).toBe(null);
      // The notice goes to stderr so the two startup lines remain the whole
      // stdout contract for a wrapper script grepping for the bound URL.
      expect(proc.stderr()).toContain(`shutting down (${signal})`);
      expect(proc.stdout()).not.toContain("shutting down");

      // The port is genuinely released: a fresh server binds it immediately.
      const second = open(["--port", String(port)]);
      expect(await second.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
      second.killHard();
    },
    70_000,
  );

  it("a second Ctrl-C during shutdown does not re-enter close()", async () => {
    const port = await freePort();
    const proc = open(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    proc.signalIt("SIGINT");
    proc.signalIt("SIGINT");
    expect(await proc.waitForExit(25_000)).toBe(130);
    // Exactly one notice, not two: the handler is `once` per signal AND guarded.
    expect(proc.stderr().match(/shutting down/g)).toHaveLength(1);
  }, 60_000);
});

// -------------------------------------------------------------- port policy

describe("port collisions", () => {
  /**
   * MOVES the A1 pin "an occupied port crashes with a raw EADDRINUSE stack and
   * exit 1". Plan §1: "An explicit `--port` collision fails with a useful
   * diagnostic."
   */
  it("an occupied EXPLICIT --port exits 4 with a diagnostic and no stack", async () => {
    const port = await freePort();
    const holder = open(["--port", String(port)]);
    expect(await holder.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

    const loser = open(["--port", String(port)]);
    const code = await loser.waitForExit(25_000);
    holder.killHard();

    expect(code).toBe(4);
    expect(loser.stdout()).toBe("");
    expect(loser.stderr()).toContain(`error(conflict): port ${port} is already in use`);
    expect(loser.stderr()).toContain("--port <n>");
    // The failure mode this replaces, gone:
    expect(loser.stderr()).not.toContain("Unhandled 'error' event");
    expect(loser.stderr()).not.toContain("at Server.setupListenHandle");
  }, 70_000);

  /**
   * Plan §1: "If the configured default port is busy, an implicit open may
   * choose an operating-system-assigned loopback port and print it."
   *
   * The configured port is set through `staple config set port` rather than a
   * flag, because the whole point is that the user typed no port at all.
   */
  it("an occupied IMPLICIT port falls back to a free one and prints it", async () => {
    const port = await freePort();
    expect(
      runCliAt(repo, ["config", "set", "port", String(port)], { STAPLE_HOME: home }).status,
    ).toBe(0);

    const holder = open(["--port", String(port)]);
    expect(await holder.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

    const fallback = open([]);
    expect(await fallback.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

    const bound = boundPortOf(fallback.stdout());
    expect(bound).not.toBeNull();
    expect(bound).not.toBe(port);
    expect(bound).toBeGreaterThan(0);
    expect(fallback.stderr()).toContain(`port ${port} is in use`);
    // …and the port it printed is the port it is actually serving on.
    expect((await fetch(`http://127.0.0.1:${bound}/`)).status).toBe(200);

    holder.killHard();
    fallback.killHard();
    // Leave the config as the rest of the suite expects to find it.
    expect(runCliAt(repo, ["config", "set", "port", "4400"], { STAPLE_HOME: home }).status).toBe(0);
  }, 80_000);

  /**
   * MOVES the A1 pin "--port abc exits 1 with a raw ERR_SOCKET_BAD_PORT, not
   * validation exit 2". Every other bad flag value in this CLI is a 2; this one
   * was a 1 only because `Number()` produced a NaN that reached `listen()`.
   */
  it.each(["abc", "99999", "4400.5", "1e5", " "])(
    "--port %j is validation exit 2 with the standard envelope",
    (value) => {
      const result = runCliAt(repo, ["open", "--port", value, "--no-browser"], { STAPLE_HOME: home }, 25_000);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("error(validation): --port");
      expect(result.stderr).not.toContain("ERR_SOCKET_BAD_PORT");
      expect(result.stdout).toBe("");
    },
    40_000,
  );

  /**
   * `Number("")` is 0, and 0 is a LEGAL port here (it means "let the OS pick").
   * An empty `--port` is always a typo or an unset shell variable, never a
   * request for an arbitrary port, so it is rejected on its own before the
   * range check gets a chance to be generous about it.
   */
  it("--port with an empty value is refused rather than read as port 0", () => {
    const result = runCliAt(repo, ["open", "--port", "", "--no-browser"], { STAPLE_HOME: home }, 25_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--port needs a value");
    expect(result.stdout).toBe("");
  }, 30_000);

  it("--port 0 still takes an OS-assigned port and prints the one it got", async () => {
    const proc = open(["--port", "0"]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const bound = boundPortOf(proc.stdout());
    expect(bound).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${bound}/`)).status).toBe(200);
    proc.killHard();
  }, 40_000);
});

// ------------------------------------------------------- resolve before bind

describe("resolution happens before the socket binds", () => {
  /**
   * The user-visible half of the `src/ui/server.ts` listen-callback fix.
   *
   * A1 filed it as a pre-existing bug: `handleFor()` ran inside the
   * `server.listen` callback, so a resolution failure escaped as an uncaught
   * exception on a tick with no catch — AFTER the socket was bound, so the
   * process died looking like a crash. `staple open` now resolves first, which
   * means the failure is an ordinary typed exit and no socket is ever bound.
   */
  it("exits 3 in a directory with no workspace, and never prints a listening line", () => {
    const result = runCliAt(barren, ["open", "--port", "0", "--no-browser"], { STAPLE_HOME: home }, 25_000);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("error(not_found):");
    expect(result.stdout).not.toMatch(LISTENING);
    // The old failure shape, gone:
    expect(result.stderr).not.toContain("Uncaught");
    expect(result.stderr).not.toContain("throw er;");
  }, 40_000);

  /**
   * A5's handoff: resolution can now throw `conflict` as well as `not_found`,
   * "so anything that treats resolution as 'succeeds or not_found' needs a
   * conflict branch". `open` needs no branch — both are StapleErrors thrown
   * before `listen()` — but it does need to be PROVEN, because a directory with
   * two canonical databases is the second trigger A5 warned the listen-callback
   * bug had acquired.
   */
  it("exits 4 in a forked directory, and never prints a listening line", () => {
    const forked = join(root, "forkedrepo");
    mkdirSync(forked, { recursive: true });
    expect(runCliAt(forked, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    // Plant a SECOND canonical database at the legacy path. A copy has its own
    // inode, so `describeLayout` reports `ambiguous` rather than `aliased` —
    // this is the forked workspace the whole path migration exists to prevent.
    mkdirSync(join(forked, ".tasks"), { recursive: true });
    copyFileSync(join(forked, ".staple", "staple.db"), join(forked, ".tasks", "tasks.db"));

    const result = runCliAt(forked, ["open", "--port", "0", "--no-browser"], { STAPLE_HOME: home }, 25_000);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Ambiguous workspace");
    expect(result.stdout).not.toMatch(LISTENING);
  }, 60_000);
});

// --------------------------------------------------------------- the alias

describe("`ui` is an alias for `open`, not a second implementation", () => {
  it("both spellings print the same startup line and accept both flag families", async () => {
    const viaOpen = open(["--port", "0"]);
    expect(await viaOpen.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const openLine = viaOpen.stdout().split("\n")[0]!.replace(/:\d+\//, ":PORT/");
    viaOpen.killHard();

    // `--no-open` is `ui`'s historical spelling of `--no-browser`; both work on
    // both commands, because there is one parseArgs table and one code path.
    const viaUi = spawnCli(["ui", "--port", "0", "--no-open"], { cwd: repo, env: { STAPLE_HOME: home } });
    expect(await viaUi.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const uiLine = viaUi.stdout().split("\n")[0]!.replace(/:\d+\//, ":PORT/");
    viaUi.killHard();

    expect(uiLine).toBe(openLine);
    expect(openLine).toBe('staple ui — workspace "openrepo" at http://localhost:PORT/');
  }, 60_000);

  it("refuses --json rather than pretending a foreground server has a result", () => {
    for (const command of ["open", "ui"]) {
      const result = runCliAt(repo, [command, "--json", "--no-browser"], { STAPLE_HOME: home }, 25_000);
      expect(result.status, command).toBe(2);
      const envelope = JSON.parse(result.stderr.trim()) as { code: string; message: string };
      expect(envelope.code).toBe("validation");
      expect(envelope.message).toContain("--json is not available for `staple open`");
    }
  }, 40_000);

  it("rejects --browser and --no-browser together instead of guessing", () => {
    const result = runCliAt(repo, ["open", "--browser", "--no-browser"], { STAPLE_HOME: home }, 25_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("contradict each other");
  }, 30_000);
});

// ---------------------------------------------------------- no browser, ever

describe("a headless run never launches a browser", () => {
  /**
   * The child has no TTY, so `browser: auto` decides against launching even
   * without `--no-browser`. Proven by absence of the failure line the launcher
   * prints when it cannot start one, and by the process staying up and serving.
   *
   * The decision matrix itself is exercised exhaustively as a pure function in
   * `open-browser.test.ts`; this is the end-to-end half.
   */
  it("stays up and serves with no browser attempt and no hang", async () => {
    const proc = spawnCli(["open", "--port", "0"], { cwd: repo, env: { STAPLE_HOME: home } });
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const bound = boundPortOf(proc.stdout());
    expect((await fetch(`http://127.0.0.1:${bound}/`)).status).toBe(200);
    expect(proc.stderr()).not.toContain("could not launch a browser");
    // Still running: a browser decision must never take the server down.
    expect(await proc.waitForExit(500)).toBe(null);
    proc.killHard();
  }, 40_000);
});

describe("`init` never starts a server", () => {
  /**
   * The ticket's first acceptance criterion, checked structurally rather than by
   * timing: `src/commands/init.ts` does not import the UI server at all, so no
   * future edit to init can start one by accident.
   */
  it("src/commands/init.ts imports nothing from src/ui", () => {
    const source = readFileSync(join(REPO_ROOT, "src/commands/init.ts"), "utf8");
    expect(source).not.toContain("ui/server");
    expect(source).not.toContain("startUiServer");
    expect(existsSync(join(REPO_ROOT, "src/commands/init.ts"))).toBe(true);
  });
});
