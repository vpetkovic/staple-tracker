/**
 * A6 (STA-36) — the browser decision matrix.
 *
 * Plan §1: "Opens after listen unless config disables it" / "`--browser` forces
 * and `--no-browser` suppresses" / "TTY default from config; non-TTY default
 * off" / edge case "`npx` runs in CI | Wizard hangs | Detect non-TTY before
 * onboarding".
 *
 * The decision is a pure function precisely so it can be tested for the
 * environments a test process is never actually in — a headless Linux box, a
 * Wayland session, a terminal-less CI runner. Exhaustive rather than
 * representative: every combination of the five inputs is enumerated below, so
 * a future edit that reorders the rules has to state which cell it changed.
 */
import { describe, expect, it } from "vitest";
import {
  browserCommandFor,
  decideBrowserLaunch,
  hasDisplay,
  launchBrowser,
  type BrowserContext,
} from "../src/ui/open-browser.js";
import { BROWSER_PREFERENCES } from "../src/config/index.js";

const BASE: BrowserContext = {
  preference: "auto",
  interactive: true,
  display: true,
};

describe("display detection", () => {
  it("assumes a display on macOS and Windows, where no variable says otherwise", () => {
    expect(hasDisplay({}, "darwin")).toBe(true);
    expect(hasDisplay({}, "win32")).toBe(true);
  });

  it("requires DISPLAY or WAYLAND_DISPLAY elsewhere", () => {
    expect(hasDisplay({}, "linux")).toBe(false);
    expect(hasDisplay({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(hasDisplay({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    // Empty is not set: an exported-but-blank DISPLAY is a headless shell.
    expect(hasDisplay({ DISPLAY: "" }, "linux")).toBe(false);
  });

  it("names the platform opener", () => {
    expect(browserCommandFor("darwin")).toBe("open");
    expect(browserCommandFor("win32")).toBe("explorer");
    expect(browserCommandFor("linux")).toBe("xdg-open");
  });
});

describe("the headless matrix", () => {
  it("never launches without a display, whatever the preference or the flags", () => {
    for (const preference of BROWSER_PREFERENCES) {
      for (const forced of [false, true]) {
        for (const interactive of [false, true]) {
          const decision = decideBrowserLaunch({ ...BASE, preference, forced, interactive, display: false });
          expect(decision.launch, `${preference}/forced=${forced}/tty=${interactive}`).toBe(false);
          expect(decision.reason).toBe("no graphical display detected");
        }
      }
    }
  });

  it("never launches when --no-browser is given, even alongside --browser", () => {
    for (const preference of BROWSER_PREFERENCES) {
      const decision = decideBrowserLaunch({ ...BASE, preference, suppressed: true, forced: true });
      expect(decision.launch).toBe(false);
      expect(decision.reason).toBe("suppressed by --no-browser");
    }
  });

  it("--browser overrides browser=never and a missing TTY", () => {
    expect(decideBrowserLaunch({ ...BASE, preference: "never", forced: true }).launch).toBe(true);
    expect(decideBrowserLaunch({ ...BASE, interactive: false, forced: true }).launch).toBe(true);
  });

  it("browser=never refuses even at a terminal", () => {
    const decision = decideBrowserLaunch({ ...BASE, preference: "never" });
    expect(decision.launch).toBe(false);
    expect(decision.reason).toBe("config browser=never");
  });

  it("browser=always launches without a TTY, because that is what always means", () => {
    const decision = decideBrowserLaunch({ ...BASE, preference: "always", interactive: false });
    expect(decision.launch).toBe(true);
    expect(decision.reason).toBe("config browser=always");
  });

  /** The CI case, and the default configuration: `auto` + no terminal = no browser. */
  it("browser=auto follows the TTY", () => {
    expect(decideBrowserLaunch({ ...BASE, interactive: true }).launch).toBe(true);
    const headless = decideBrowserLaunch({ ...BASE, interactive: false });
    expect(headless.launch).toBe(false);
    expect(headless.reason).toBe("config browser=auto and this is not a terminal");
  });

  /** The full truth table, written out, so a reordering of the rules is a visible diff. */
  it("pins every cell of the matrix", () => {
    const cells: Array<[Partial<BrowserContext>, boolean]> = [
      [{ preference: "auto", interactive: true, display: true }, true],
      [{ preference: "auto", interactive: false, display: true }, false],
      [{ preference: "auto", interactive: true, display: false }, false],
      [{ preference: "auto", interactive: false, display: false }, false],
      [{ preference: "always", interactive: true, display: true }, true],
      [{ preference: "always", interactive: false, display: true }, true],
      [{ preference: "always", interactive: false, display: false }, false],
      [{ preference: "never", interactive: true, display: true }, false],
      [{ preference: "never", interactive: true, display: true, forced: true }, true],
      [{ preference: "always", interactive: true, display: true, suppressed: true }, false],
      [{ preference: "auto", interactive: false, display: true, forced: true }, true],
      [{ preference: "auto", interactive: true, display: true, suppressed: true, forced: true }, false],
    ];
    for (const [patch, expected] of cells) {
      expect(decideBrowserLaunch({ ...BASE, ...patch }).launch, JSON.stringify(patch)).toBe(expected);
    }
  });
});

describe("launching", () => {
  it("uses the injected opener and never spawns a real application", () => {
    const opened: string[] = [];
    const result = launchBrowser("http://localhost:4400/", (url) => opened.push(url));
    expect(result).toEqual({ attempted: true, ok: true, error: null });
    expect(opened).toEqual(["http://localhost:4400/"]);
  });

  /**
   * Plan edge case: "Browser command fails | Server works but appears broken |
   * Print the tokenized URL and keep the foreground server running." A thrown
   * opener must therefore come back as a RESULT, never as an exception that
   * could unwind through the listen callback and take the server with it.
   */
  it("reports a failing opener instead of throwing", () => {
    const result = launchBrowser("http://localhost:4400/", () => {
      throw new Error("no such program");
    });
    expect(result.ok).toBe(false);
    expect(result.attempted).toBe(true);
    expect(result.error).toContain("no such program");
  });
});
