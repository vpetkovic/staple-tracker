/**
 * A1 — the `staple ui` PROCESS lifecycle, frozen before A6.
 *
 * The `ui-*.test.ts` suites all call `startUiServer()` in-process with
 * `port: 0`, so they cover the HTTP surface thoroughly and the PROCESS not at
 * all. Nothing today pins what `staple ui` prints when it comes up, which stream
 * it prints on, how it binds, or what it does when the port is taken — and A6
 * ("explicit `open`, UI shutdown, browser launch", "if the configured default
 * port is busy, an implicit open may choose an OS-assigned port and print it")
 * rewrites every one of those.
 *
 * The startup lines are a real contract: they are the only place the bound URL
 * appears, so a wrapper script has to grep them to know where to point a browser.
 *
 * Every case here runs the real CLI as a child process and passes `--no-open`,
 * so no browser is ever launched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_ENTRY,
  freePort,
  removeDir,
  runCliAt,
  spawnStaple,
  tempDir,
} from "./fixtures/characterize-support.js";
import { uiBundleExists, UI_BUILD_HINT } from "../src/ui/server.js";

let home: string;
let root: string;
let repo: string;

const LISTENING = /staple ui — .* at http:\/\/localhost:\d+\/\n/;

beforeAll(() => {
  home = tempDir("char-ui-home");
  root = tempDir("char-ui-root");
  repo = join(root, "uirepo");
  mkdirSync(repo, { recursive: true });
  expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function startUi(args: string[]) {
  return spawnStaple(CLI_ENTRY, ["ui", ...args, "--no-open"], {
    cwd: repo,
    env: { STAPLE_HOME: home },
  });
}

describe("startup logging", () => {
  it("prints exactly two lines on STDOUT, naming the workspace and the bound URL", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const lines = proc.stdout().split("\n");
    proc.kill();

    expect(lines[0]).toBe(`staple ui — workspace "uirepo" at http://localhost:${port}/`);
    // The second line names the token FILE and shows only the first 8 characters
    // of the token itself, followed by a U+2026 ellipsis — deliberately not a
    // usable credential, so a shared terminal log does not leak one.
    expect(lines[1]).toMatch(
      /^ {2}\(browser on this machine needs no token; API callers use ~\/\.staple\/ui-token or \?token=[A-Za-z0-9_-]{8}…\)$/,
    );
    expect(lines[2]).toBe("");
    expect(lines).toHaveLength(3);
  }, 40_000);

  it("says \"hub (all workspaces)\" in hub mode instead of naming one workspace", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port), "--hub"]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const first = proc.stdout().split("\n")[0];
    proc.kill();
    expect(first).toBe(`staple ui — hub (all workspaces) at http://localhost:${port}/`);
  }, 40_000);

  /**
   * QUIRK (A6): the printed URL says `localhost` while the socket is bound to
   * the literal `127.0.0.1`. On a machine where `localhost` resolves to `::1`
   * first, the URL staple prints is not the address it is listening on. Pinned
   * as-is — the binding is deliberately loopback-only and correct; it is the
   * printed hostname that is a guess.
   */
  it("KNOWN: prints a localhost URL while binding 127.0.0.1", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    expect(proc.stdout()).toContain(`http://localhost:${port}/`);
    // The bound socket answers on the dotted-quad, which is what the server
    // actually passed to listen().
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    proc.kill();
  }, 40_000);
});

describe("port binding", () => {
  it("uses 4400 as the default port when --port is absent", () => {
    // Read off the help text rather than by binding 4400, which would collide
    // with a developer's own running instance.
    expect(runCliAt(repo, ["help"], { STAPLE_HOME: home }).stdout).toContain("ui [--port 4400]");
  });

  it("takes an OS-assigned port for --port 0 and prints the one it got", async () => {
    const proc = startUi(["--port", "0"]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    const bound = /at http:\/\/localhost:(\d+)\//.exec(proc.stdout())?.[1];
    expect(Number(bound)).toBeGreaterThan(0);
    expect(Number(bound)).not.toBe(0);
    expect((await fetch(`http://127.0.0.1:${bound}/`)).status).toBe(200);
    proc.kill();
  }, 40_000);

  /**
   * FIXED BY A6 (STA-36); the assertions are inverted here and the full
   * behaviour — including the implicit-port fallback — lives in
   * `ui-lifecycle.test.ts`.
   *
   * The "before" this replaced: an occupied port produced an UNHANDLED 'error'
   * event on the http.Server, so the process died with a raw
   * `Error: listen EADDRINUSE`, a Node stack and exit 1 — no diagnostic, no
   * suggestion of another port, no fallback. Kept here rather than deleted
   * because this suite is where a reader looks for "what does `ui` do when the
   * port is taken", and the answer changed.
   */
  it("an occupied EXPLICIT port exits 4 with a diagnostic, not an unhandled 'error'", async () => {
    const port = await freePort();
    const holder = startUi(["--port", String(port)]);
    expect(await holder.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

    const loser = startUi(["--port", String(port)]);
    const code = await loser.waitForExit(25_000);
    holder.kill();
    loser.kill();

    expect(code).toBe(4);
    expect(loser.stdout()).toBe(""); // still no startup line
    expect(loser.stderr()).toContain(`error(conflict): port ${port} is already in use`);
    expect(loser.stderr()).not.toContain("Unhandled 'error' event");
  }, 60_000);

  /**
   * FIXED BY A6 (STA-36). The "before": `--port` was coerced with a bare
   * `Number()`, so a non-numeric value became NaN, reached `server.listen(NaN)`
   * as ERR_SOCKET_BAD_PORT, and was caught only as an unclassified error — exit
   * 1, where every other bad flag value in this CLI is validation exit 2.
   */
  it("--port abc is validation exit 2, like every other bad flag value", () => {
    const result = runCliAt(repo, ["ui", "--port", "abc", "--no-open"], { STAPLE_HOME: home }, 25_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error(validation): --port must be an integer");
    expect(result.stderr).not.toContain("ERR_SOCKET_BAD_PORT");
  }, 40_000);
});

describe("a missing UI bundle", () => {
  /**
   * The bundle is generated, so a checkout can legitimately be in either state.
   * `ui-static.test.ts` takes the same approach for the served page; this one is
   * about the PROCESS behaviour, which is the part A2 changes when it starts
   * copying the UI asset beside the bundled server.
   */
  it("warns on stderr and serves anyway, rather than refusing to start", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);

    if (uiBundleExists()) {
      // Built tree: no hint, and stderr stays clean.
      expect(proc.stderr()).toBe("");
    } else {
      // Unbuilt tree: the hint goes to STDERR (so it does not pollute a stdout
      // pipeline), names the exact expected path, and the server still comes up.
      expect(proc.stderr()).toContain(UI_BUILD_HINT);
      expect(proc.stderr()).toContain("npm run build:ui");
    }
    // Either way the server is listening and answers with a page.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    proc.kill();
  }, 40_000);

  it("still opens the workspace, so the API is live before the page exists", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    // Unauthenticated: the API is gated even when the page is not.
    expect((await fetch(`http://127.0.0.1:${port}/api/issues`)).status).toBe(401);
    proc.kill();
  }, 40_000);
});

describe("shutdown", () => {
  /**
   * FIXED BY A6 (STA-36).
   *
   * The "before", pinned by A1: there was no signal handling anywhere in the
   * CLI. SIGTERM/SIGINT took the default disposition and the process died
   * without closing database handles or draining connections, even though
   * `startUiServer` has always returned a `close()` that does exactly that and
   * nothing ever called it.
   *
   * A1 asserted this by reading `src/cli.ts` for the ABSENCE of a handler. That
   * shape cannot survive the fix — the handler now lives in
   * `src/commands/open.ts`, which is the right place for it and is not the file
   * A1 could name in advance. So the source-grep assertion is replaced with a
   * behavioural one here, and `ui-lifecycle.test.ts` proves the exit statuses,
   * the released port and the single-shutdown guard in full.
   */
  it("the returned close() is now actually called, from the command layer", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const openCommand = join(dirname(CLI_ENTRY), "commands", "open.ts");
    const source = readFileSync(openCommand, "utf8");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
    expect(source).toContain("handle.close()");
  });

  it("SIGTERM shuts down gracefully and exits 143, announcing it on stderr", async () => {
    const port = await freePort();
    const proc = startUi(["--port", String(port)]);
    expect(await proc.waitFor((out) => LISTENING.test(out), 25_000)).toBe(true);
    proc.kill("SIGTERM");
    // `spawnStaple` signals the process GROUP through tsx's launcher fork, so
    // the code observed here is the launcher's rather than staple's own — which
    // is why `ui-lifecycle.test.ts` spawns a single process to read the exact
    // 143. What this case proves is that the shutdown path RAN.
    await proc.waitForExit(20_000);
    expect(proc.stderr()).toContain("shutting down (SIGTERM)");
    // The farewell stays off stdout, so the two startup lines remain the whole
    // stdout contract for a wrapper script grepping for the bound URL.
    expect(proc.stdout()).not.toContain("shutting down");
  }, 40_000);
});
