/**
 * `staple open` (and its compatibility alias `staple ui`) — STA-24 plan §1,
 * command table row `staple open`: "Open current project; `--hub` opens the
 * machine hub; `--browser` forces and `--no-browser` suppresses browser launch."
 *
 * This is the FOREGROUND process. Plan §1 bare-command step 7: "On Ctrl-C or
 * termination, stop accepting requests, close database handles, close the
 * server, and return the signal-appropriate exit status." That sentence is four
 * separate things and all four are implemented below, because A1 pinned that
 * none of them were: `src/cli.ts` registered no signal handler at all and threw
 * away the `close()` that `startUiServer` returns.
 *
 * Three defects A1 recorded against this ticket are fixed here:
 *
 *   1. An occupied port produced an UNHANDLED `'error'` event — a raw
 *      `listen EADDRINUSE`, a Node stack, exit 1, no diagnostic, no fallback.
 *   2. `--port abc` went through a bare `Number()` to `NaN`, surfacing as an
 *      unclassified `ERR_SOCKET_BAD_PORT` and exit 1, where every other bad flag
 *      value in this CLI is a validation exit 2.
 *   3. No SIGINT/SIGTERM handling, so database handles and live connections were
 *      never drained.
 *
 * The fourth, `src/ui/server.ts`'s `handleFor()` inside the listen callback, is
 * fixed in that file — but the reason it stops mattering for a real user is
 * here: this command resolves the workspace BEFORE it binds a socket, so an
 * unresolvable directory exits 3 (or 4, for A5's ambiguous-databases refusal)
 * without ever starting a server.
 */
import { parseArgs } from "node:util";
import { effectiveConfig } from "../config/index.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";
import { startUiServer, uiBundleExists, UI_BUILD_HINT, type UiHandle } from "../ui/server.js";
import {
  decideBrowserLaunch,
  hasDisplay,
  launchBrowser,
  type BrowserOpener,
} from "../ui/open-browser.js";
import { isInteractive } from "../onboarding/prompts.js";

/** Injected by tests, so no test ever launches a real browser. */
export interface OpenDeps {
  openBrowser?: BrowserOpener;
  interactive?: boolean;
  display?: boolean;
  /** Where the token comes from; the CLI passes its persistent one. */
  token?: string;
}

/**
 * Port parsing that fails like every other flag in this CLI.
 *
 * `0` is deliberately allowed: it is how the tests (and anyone scripting around
 * a busy machine) ask the operating system for a free loopback port, and
 * `characterize-ui-server` pins that `--port 0` prints the port it actually got.
 */
export function parsePort(raw: string): number {
  // `Number("")` is 0, and 0 is a legal port here — so an empty `--port` would
  // silently mean "pick any free port" when it is always a typo or an unset
  // shell variable. Reject it before the numeric check can be kind about it.
  if (raw.trim() === "") {
    throw new StapleError("validation", "--port needs a value; got an empty one.");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StapleError(
      "validation",
      `--port must be an integer between 0 and 65535, got "${raw}"`,
    );
  }
  return port;
}

function shutdownSignalExit(signal: NodeJS.Signals): number {
  // The shell convention: 128 + the signal number. SIGINT (2) exits 130, which
  // is what a caller checking "did Ctrl-C stop this" looks for.
  return 128 + (signal === "SIGINT" ? 2 : 15);
}

/**
 * Install the shutdown path.
 *
 * `once` per signal, and a guard flag besides: a second Ctrl-C while the first
 * close is draining must not re-enter `close()` on a half-closed server. The
 * notice goes to STDERR so the two startup lines stay the entire stdout
 * contract — a wrapper script grepping stdout for the bound URL must not have to
 * skip a farewell.
 */
function installShutdown(handle: UiHandle): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.error(`\nstaple ui — shutting down (${signal}); closing server and database handles.`);
    try {
      // closeAllConnections() + close() + every store's db.close(), which is
      // exactly "stop accepting requests, close database handles, close the
      // server" — the handle has always been able to do this; nothing called it.
      handle.close();
    } catch {
      // A close that fails must not turn a clean Ctrl-C into a stack trace.
    }
    process.exit(shutdownSignalExit(signal));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export interface OpenOptions {
  db?: string;
  ws?: string;
  hub: boolean;
  /** The port the user typed, or null to take the configured default. */
  explicitPort: number | null;
  configPort: number;
  browser: boolean;
  noBrowser: boolean;
  token?: string;
}

export function runOpen(options: OpenOptions, deps: OpenDeps = {}): UiHandle {
  /**
   * Resolve first, bind second.
   *
   * A5's handoff: resolution can now throw `conflict` during walk-up as well as
   * `not_found`, so "succeeds or not_found" is no longer the shape. Both are
   * StapleErrors and both are thrown out of this function into `cli.ts`'s
   * top-level catch, which maps them to exit 3 and exit 4 — no branch needed
   * here, but the ORDER is what makes that work: after `server.listen()` there
   * is no catch left to throw into.
   *
   * Hub mode resolves nothing: `--hub` serves every registered workspace and an
   * empty registry is a legitimate (if dull) thing to look at.
   */
  if (!options.hub) {
    const opened = resolveWorkspace({ db: options.db, ws: options.ws });
    // Opened only to prove it opens; the server opens its own handle lazily.
    opened.store.db.close();
  }

  const built = uiBundleExists();
  // Warn but serve: the placeholder page repeats the build instruction, and the
  // dev workflow (vite on :4401 proxying /api here) needs this process either way.
  if (!built) console.error(UI_BUILD_HINT);

  const port = options.explicitPort ?? options.configPort;
  const handle = startUiServer({
    port,
    hub: options.hub,
    db: options.db,
    ws: options.ws,
    token: deps.token ?? options.token,
  });

  installShutdown(handle);

  /**
   * The port-collision policy, which is the plan's and not a simplification of
   * it: "If the configured default port is busy, an implicit open may choose an
   * operating-system-assigned loopback port and print it. An explicit `--port`
   * collision fails with a useful diagnostic."
   *
   * The asymmetry is the whole point. A user who typed `--port 4400` is usually
   * pointing something else at 4400 and needs to know it did not get it; a user
   * who typed nothing wants a UI, and silently landing on 4407 is a better
   * answer than a stack trace.
   */
  let fellBack = false;
  handle.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && options.explicitPort === null && !fellBack) {
      fellBack = true;
      console.error(
        `staple ui — port ${port} is in use; taking an operating-system-assigned port instead ` +
          `(set one with \`staple config set port <n>\` or \`--port\`).`,
      );
      handle.server.listen(0, "127.0.0.1");
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(
        `error(conflict): port ${port} is already in use on 127.0.0.1, so the staple UI cannot bind it.\n` +
          `  Something else is listening there — possibly another \`staple open\`.\n` +
          `  Retry on a different port with \`--port <n>\`, or omit --port to let staple pick a free one.`,
      );
      handle.close();
      process.exit(4);
    }
    // Any other listen failure (EACCES on a privileged port, EADDRNOTAVAIL)
    // still has to be reported rather than becoming an uncaught 'error' event.
    console.error(`error(conflict): the staple UI could not listen on port ${port}: ${error.message}`);
    handle.close();
    process.exit(4);
  });

  /**
   * Browser launch, after listen and never before — plan §1: "Browser launch
   * happens only after the server is listening."
   *
   * Registered as a second 'listening' listener, so it runs after the banner
   * that `startUiServer` prints from its own listen callback. On the fallback
   * path both fire on the retry, which is why the printed URL and the opened URL
   * are read from the same live socket rather than from `options.port`.
   */
  handle.server.on("listening", () => {
    if (!built) return; // nothing to look at yet; the hint is already on stderr
    const config = effectiveConfig();
    const address = handle.server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    const url = `http://localhost:${bound}/`;

    const decision = decideBrowserLaunch({
      preference: config.settings.browser.value,
      forced: options.browser,
      suppressed: options.noBrowser,
      interactive: deps.interactive ?? isInteractive(),
      display: deps.display ?? hasDisplay(),
    });
    if (!decision.launch) return;

    // No ?token= — the server seeds the token into pages served to loopback hosts.
    const result = launchBrowser(url, deps.openBrowser);
    if (!result.ok) {
      // Plan edge case "Browser command fails | Server works but appears broken":
      // print the usable URL and keep the foreground server running.
      console.error(`staple ui — could not launch a browser (${result.error}). Open ${url} yourself.`);
    }
  });

  return handle;
}

/**
 * The command surface.
 *
 * `--no-open` is accepted as a synonym for `--no-browser` because `staple ui`
 * has shipped it since before this ticket and the plan keeps `ui` as "a
 * compatibility alias for `open`" for at least one minor release. One flag set,
 * one implementation: an alias that drifts is worse than no alias.
 */
export function runOpenCommand(argv: string[], deps: OpenDeps = {}): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      port: { type: "string" },
      hub: { type: "boolean" },
      browser: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "no-open": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  if (values.json) {
    // Plan: "`--json` is invalid for the long-lived server." Accepted by the
    // parser and refused here on purpose — a hard parse error would say
    // "Unknown option --json" about a flag the help text calls global.
    throw new StapleError(
      "validation",
      "--json is not available for `staple open`: it runs a server in the foreground and never produces a finite result. " +
        "Use `staple ls --json`, `staple inbox --json`, or `staple doctor --json` instead.",
    );
  }
  if (values.browser && (values["no-browser"] || values["no-open"])) {
    throw new StapleError("validation", "--browser and --no-browser contradict each other; pass one.");
  }

  runOpen(
    {
      db: values.db,
      ws: values.ws,
      hub: values.hub === true,
      explicitPort: values.port === undefined ? null : parsePort(values.port),
      configPort: effectiveConfig().settings.port.value,
      browser: values.browser === true,
      noBrowser: values["no-browser"] === true || values["no-open"] === true,
    },
    deps,
  );
}
