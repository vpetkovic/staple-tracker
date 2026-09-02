/**
 * The only place staple asks a question — STA-24 plan §1 ("Onboarding
 * questions") and the TTY/automation matrix.
 *
 * Two hard rules govern everything here, and they are the reason this is a
 * module rather than three inline `readline` calls:
 *
 *   1. **Nothing prompts unless a human is there.** The plan is explicit —
 *      "Bare invocation must never wait for input when stdin or stdout is not a
 *      TTY" and "`npx` runs in CI | Wizard hangs | Detect non-TTY before
 *      onboarding and require explicit flags". Every prompt below goes through
 *      {@link isInteractive}; a caller that forgets cannot hang a pipeline
 *      because {@link confirm} refuses to read a non-TTY stdin at all.
 *   2. **A prompt is not consent machinery, it is a second spelling of it.**
 *      `--yes` and a `y` at a terminal have to mean exactly the same thing, so
 *      the commands here decide WHAT to ask and this file only asks it. There
 *      is no prompt anywhere that can authorise something a flag could not.
 *
 * ## Why synchronous reads
 *
 * `src/cli.ts` is synchronous end to end — one `main()`, one sync try/catch
 * owning the process exit code — and that is load-bearing for the error
 * contract, not an accident. An `async` prompt would colour the whole call
 * chain and move error handling off the one path that maps a `StapleError` to
 * an exit code. So the read is a blocking `readSync` on fd 0, the same shape
 * the `wait` command already uses for its blocking sleep.
 */
import { readSync, writeSync } from "node:fs";

/** Shared with `wait`'s sleep: a bounded park with no busy spin and no dependency. */
const PARK = new Int32Array(new SharedArrayBuffer(4));

/**
 * Is a human at both ends?
 *
 * Both directions matter. Without a stdin TTY there is nobody to type; without
 * a stdout TTY the question itself may be going into a pipe, where a prompt is
 * invisible and the wait looks like a hang.
 */
export function isInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

/**
 * Read one line from fd 0, blocking.
 *
 * `EAGAIN` is expected rather than exceptional: a TTY that Node has put in
 * non-blocking mode returns it whenever the user has not typed yet, and treating
 * it as an error is the classic way this loop turns into a crash the first time
 * somebody thinks before answering. Park briefly and retry.
 *
 * EOF (a closed stdin) returns what has been read so far, so a caller always
 * falls back to its default rather than looping forever.
 */
function readLineSync(): string {
  const byte = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(PARK, 0, 0, 20);
        continue;
      }
      if (code === "EOF") return line;
      throw error;
    }
    if (read === 0) return line; // EOF
    const char = byte.toString("utf8");
    if (char === "\n") return line;
    if (char !== "\r") line += char;
  }
}

/** Questions and their answers go to stderr, so stdout stays a clean result stream. */
function ask(question: string): void {
  writeSync(2, question);
}

export interface ConfirmOptions {
  /** The answer a bare Enter gives, and the answer a non-TTY gets without asking. */
  default: boolean;
  /** Override the interactivity probe (tests, and callers that already decided). */
  interactive?: boolean;
}

/**
 * Yes/no.
 *
 * A non-interactive caller never blocks: it gets `options.default` immediately.
 * That is deliberate and it is why every mutating command decides its default
 * to be the SAFE answer (refuse, preview, do nothing) before calling — the
 * headless path must be the conservative one without needing a second check.
 */
export function confirm(question: string, options: ConfirmOptions): boolean {
  const interactive = options.interactive ?? isInteractive();
  if (!interactive) return options.default;
  ask(`${question} ${options.default ? "[Y/n]" : "[y/N]"} `);
  const answer = readLineSync().trim().toLowerCase();
  if (answer === "") return options.default;
  return answer === "y" || answer === "yes";
}

export interface ChoiceOptions<T extends string> {
  choices: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  /** Selected by a bare Enter, and returned unasked when non-interactive. */
  default: T;
  interactive?: boolean;
}

/**
 * Pick one of a short list — the plan's first onboarding screen ("The first
 * screen has two choices: Quick setup and Customize. Quick setup is the default
 * selection").
 *
 * Numbered rather than free-text: a typo picks nothing instead of picking wrong,
 * and re-asking on an unrecognised answer is safe because we already know a
 * human is there.
 */
export function choose<T extends string>(prompt: string, options: ChoiceOptions<T>): T {
  const interactive = options.interactive ?? isInteractive();
  if (!interactive) return options.default;
  ask(`${prompt}\n`);
  options.choices.forEach((choice, index) => {
    const marker = choice.value === options.default ? " (default)" : "";
    ask(`  ${index + 1}) ${choice.label}${marker}${choice.hint ? ` — ${choice.hint}` : ""}\n`);
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ask("> ");
    const answer = readLineSync().trim().toLowerCase();
    if (answer === "") return options.default;
    const byNumber = Number(answer);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= options.choices.length) {
      return options.choices[byNumber - 1]!.value;
    }
    const byName = options.choices.find((choice) => choice.value === answer);
    if (byName) return byName.value;
    ask(`Pick a number from 1 to ${options.choices.length}.\n`);
  }
  return options.default;
}

/** Free text with a default, for the one or two Customize answers that need it. */
export function askText(prompt: string, options: { default: string; interactive?: boolean }): string {
  const interactive = options.interactive ?? isInteractive();
  if (!interactive) return options.default;
  ask(`${prompt} [${options.default}] `);
  const answer = readLineSync().trim();
  return answer === "" ? options.default : answer;
}
