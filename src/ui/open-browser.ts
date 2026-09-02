/**
 * Browser launch for `staple` and `staple open` — STA-24 plan §1 ("UI process
 * behavior") and the plan's TTY/automation matrix.
 *
 * Two things live here and nothing else: the DECISION (should a browser be
 * launched at all) and the LAUNCH (spawn the platform opener). They are split
 * because only the second one touches the operating system, so the interesting
 * half — the headless matrix — is a pure function that tests can exercise
 * exhaustively without a display, a terminal, or a real browser.
 *
 * The plan's requirements, in order of precedence:
 *
 *   - "Browser launch happens only after the server is listening." The caller
 *     owns that ordering; this module is only ever called from a listen callback.
 *   - "Launch failure is a warning with the usable URL, not a server failure."
 *     Hence {@link launchBrowser} returns a result and never throws.
 *   - "`--browser` forces and `--no-browser` suppresses browser launch."
 *   - "TTY default from config; non-TTY default off" — an `npx` run in CI must
 *     not try to open anything, and must not stall waiting for one.
 *   - "Tests inject the browser opener rather than launching a real application."
 */
import { spawn } from "node:child_process";
import type { BrowserPreference } from "../config/index.js";

/** Everything the decision depends on. No I/O, no globals — all of it passed in. */
export interface BrowserContext {
  /** Config `browser`: auto | always | never. */
  preference: BrowserPreference;
  /** `--browser` was given: the user asked for one explicitly, right now. */
  forced?: boolean;
  /** `--no-browser` (or the `ui` alias `--no-open`) was given. */
  suppressed?: boolean;
  /** stdout is a terminal, i.e. a human is probably watching. */
  interactive: boolean;
  /** A graphical session exists to open a window in. */
  display: boolean;
}

export interface BrowserDecision {
  launch: boolean;
  /** Why, in words, for `--json` payloads and for the "not opening because…" line. */
  reason: string;
}

/**
 * Is there a graphical session to open a window into?
 *
 * macOS and Windows always have one available to a logged-in user, and there is
 * no environment variable that reliably says otherwise. On Linux and the other
 * X11-ish platforms the display variables are the only signal, and getting this
 * wrong is not cosmetic: `xdg-open` with no display can block, print to the
 * terminal, or launch a text-mode browser that captures the foreground — the
 * plan's "no display ⇒ no browser attempts, no hang".
 */
export function hasDisplay(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * The headless matrix, as one ordered list of rules.
 *
 * `--no-browser` outranks everything, including `--browser`: two contradictory
 * flags is a usage error the CLI rejects before it gets here, but if one ever
 * reaches this function the safe answer is the one that does not launch.
 *
 * The display check sits ABOVE `--browser` on purpose. `always` and `--browser`
 * are statements about preference; a missing display is a statement about
 * capability, and honouring a preference into a session that cannot show a
 * window is how a headless run ends up waiting on a process nobody can see.
 */
export function decideBrowserLaunch(context: BrowserContext): BrowserDecision {
  if (context.suppressed) return { launch: false, reason: "suppressed by --no-browser" };
  if (!context.display) return { launch: false, reason: "no graphical display detected" };
  if (context.forced) return { launch: true, reason: "requested with --browser" };
  if (context.preference === "never") return { launch: false, reason: "config browser=never" };
  if (context.preference === "always") return { launch: true, reason: "config browser=always" };
  return context.interactive
    ? { launch: true, reason: "config browser=auto and this is a terminal" }
    : { launch: false, reason: "config browser=auto and this is not a terminal" };
}

/** How each platform is asked to open a URL. */
export function browserCommandFor(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "explorer";
  return "xdg-open";
}

/** Injectable in tests, per the plan: "Tests inject the browser opener". */
export type BrowserOpener = (url: string) => void;

export interface BrowserLaunchResult {
  attempted: boolean;
  ok: boolean;
  /** The failure message when `ok` is false. */
  error: string | null;
}

/**
 * Spawn the platform opener, detached, with every stream discarded.
 *
 * `detached` + `unref()` + `stdio: "ignore"` is the whole no-hang story: the
 * child is not in our process group, holds none of our descriptors, and is not
 * waited on — so a browser that takes ten seconds to start, or an `xdg-open`
 * that picks a terminal browser, cannot keep the UI server from serving or keep
 * the process from exiting on Ctrl-C.
 *
 * Never throws. The URL has already been printed by the time this runs, so a
 * failed launch costs the user one warning line and nothing else.
 */
export function launchBrowser(url: string, opener?: BrowserOpener): BrowserLaunchResult {
  try {
    if (opener) {
      opener(url);
    } else {
      const child = spawn(browserCommandFor(), [url], { stdio: "ignore", detached: true });
      // A spawn that fails asynchronously (ENOENT for `xdg-open`) emits 'error'
      // on the child. With no listener that is an uncaught exception — the exact
      // failure mode A1 pinned on the server's own 'error' event.
      child.on("error", () => {
        /* reported by the caller's fallback line; the URL is already on stdout */
      });
      child.unref();
    }
    return { attempted: true, ok: true, error: null };
  } catch (error) {
    return { attempted: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
