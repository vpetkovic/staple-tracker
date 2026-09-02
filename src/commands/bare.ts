/**
 * Bare `staple` — STA-24 plan §1 ("Bare command"): "Bare `staple` composes setup
 * and open."
 *
 * The seven numbered steps in the plan are the seven things below, in order:
 *
 *   1. Resolve machine configuration.
 *   2. Look upward for `.staple/staple.db`, then a legacy `.tasks/tasks.db`.
 *   3. If no workspace exists and the terminal is interactive, run onboarding.
 *   4. If a legacy workspace exists, preview the migration and make migration
 *      the default interactive choice; a refusal opens the legacy database in
 *      compatibility mode and prints the exact migration command.
 *   5. Open the workspace, validate its identity, and repair its hub path.
 *   6. Start the UI on loopback in the foreground; open the browser per config.
 *   7. On Ctrl-C, close everything and return the signal-appropriate status.
 *
 * Steps 3-4 are `performSetup()` from `commands/init.ts` — literally the same
 * function `staple init` calls, which is the plan's "This setup stage uses the
 * same application service as `staple init`". Steps 5-7 are `runOpen()` from
 * `commands/open.ts`, likewise shared with the explicit `staple open`.
 *
 * ## The non-TTY refusal
 *
 * This is the ticket's fourth acceptance criterion ("Non-TTY bare command never
 * prompts or starts a server") and the plan's sharpest sentence about it: "Bare
 * invocation must never wait for input when stdin or stdout is not a TTY. It
 * returns validation exit code 2 without mutation and points to an explicit
 * command."
 *
 * It is checked FIRST — before any workspace inspection, before any config read
 * that could fail, before anything that could write. A refusal that has already
 * created a directory is not a refusal. The plan's edge-case table calls this
 * out by name: "`npx` runs in CI | Wizard hangs | Detect non-TTY before
 * onboarding and require explicit flags."
 *
 * ## `--yes` (epic D, D5)
 *
 * Bare `staple --yes` (and therefore `npx staple-cli --yes`) is the
 * "require explicit flags" half of that edge-case row, mirroring
 * `npx paperclipai onboard --yes`:
 *
 *   - At a terminal, `--yes` skips the questions and takes the defaults — the
 *     exact choices `staple init --yes` makes, because it IS the same
 *     `performSetup({yes: true})` call — then opens the UI as bare always has.
 *   - With no terminal, `--yes` still performs the setup but REFUSES to start
 *     the UI server: a foreground server in CI is a hang, not a feature. It
 *     prints what was created and the explicit follow-up commands, exit 0.
 *   - With no terminal and no `--yes`, the exit-2 refusal above is unchanged.
 */
import { parseArgs } from "node:util";
import { effectiveConfig } from "../config/index.js";
import { StapleError } from "../core/types.js";
import { isInteractive } from "../onboarding/prompts.js";
import { performSetup, printInitReport } from "./init.js";
import { runOpen, type OpenDeps } from "./open.js";

/**
 * The message a CI log has to be able to act on.
 *
 * Every branch is named with the exact command that does it non-interactively,
 * because "run this interactively" is useless advice inside a pipeline. Kept as
 * a constant so the test that pins it and the code that prints it are the same
 * string.
 */
export const BARE_NON_TTY_MESSAGE =
  "Bare `staple` is the interactive command: it sets this repository up if it needs it, " +
  "then runs the web UI in the foreground. There is no terminal attached here, so it will not " +
  "prompt and will not start a server.\n" +
  "  staple init --yes     set this repository up, then exit\n" +
  "  staple open           run the UI in the foreground (explicit, so it is allowed here)\n" +
  "  staple help           the full command list";

/**
 * What a non-TTY `staple --yes` prints AFTER the setup report. Setup happened;
 * the server did not, because "CI must never hang on a server" (STA-91 plan,
 * D5). Both spellings of the follow-up are named so a log reader can paste one.
 */
export const BARE_YES_NON_TTY_MESSAGE =
  "Setup is done. There is no terminal attached here, so the UI server was not started — " +
  "a foreground server would hang this pipeline.\n" +
  "  staple open           run the web UI in the foreground\n" +
  "  staple ui             the same, under its compatibility alias";

export interface BareDeps extends OpenDeps {
  interactive?: boolean;
}

export function runBareCommand(argv: string[], deps: BareDeps = {}): void {
  // The bare command's whole flag surface. Anything else on a bare invocation
  // is a usage error (ERR_PARSE_ARGS → validation exit 2), same as every other
  // command's parse; parsing is pure, so the no-mutation refusal still holds.
  const { values } = parseArgs({ args: argv, options: { yes: { type: "boolean" } } });
  const yes = values.yes === true;

  const interactive = deps.interactive ?? isInteractive();
  if (!interactive && !yes) {
    // Nothing above this line touched the filesystem. That is the contract.
    throw new StapleError("validation", BARE_NON_TTY_MESSAGE);
  }

  // Steps 3-4: the same application service `staple init` runs. Without
  // `--yes` the migration question is asked rather than flagged — at a
  // terminal, consent comes from the prompt, and passing `--yes` on the
  // user's behalf is exactly the anti-pattern A8 warned about for `install`.
  // WITH `--yes`, consent was typed on the command line, and it means exactly
  // what `staple init --yes` means, because this is the same function.
  const report = performSetup({
    yes,
    gitignore: true,
    interactive,
  });
  printInitReport(report);
  console.log("");

  if (!interactive) {
    // Non-TTY + --yes: onboard, but never a server a pipeline cannot stop.
    // Exit 0 — the setup the flag consented to is complete.
    console.log(BARE_YES_NON_TTY_MESSAGE);
    return;
  }

  // Steps 5-7. The explicit `open` and this share one implementation, so "bare
  // opens the current workspace" cannot drift from "`staple open` opens the
  // current workspace" — they are the same call.
  runOpen(
    {
      hub: false,
      explicitPort: null,
      configPort: effectiveConfig().settings.port.value,
      browser: false,
      noBrowser: false,
      token: deps.token,
    },
    { ...deps, interactive: true },
  );
}
