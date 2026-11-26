import { StapleError } from "./core/types.js";

/**
 * The global flags `staple help` lists, in the order it lists them. Each one means the same
 * before the command (`staple --json show REF`) as after it (`staple show REF --json`).
 *
 * `--db`, `--ws` and `--json` are every workspace command's own options, so the dispatcher
 * hands one given before the command to the command, after its arguments. `--agent` is who
 * acts, and every verb already resolves who acts as its own flag, else `$STAPLE_AGENT`, else
 * `$USER`: the dispatcher takes it off the command line wherever it is and sets
 * `$STAPLE_AGENT` for this one process, so every verb that writes honours it, including the
 * ones that never parsed `--agent`.
 */
export const GLOBAL_FLAGS = [
  { name: "db", value: "<path>" },
  { name: "ws", value: "<slug|prefix>" },
  { name: "json", value: null },
  { name: "agent", value: "<name>" },
] as const;

/** `--db <path>, --ws <slug|prefix>, --json, --agent <name>`, for messages. */
export const GLOBAL_FLAG_LIST = GLOBAL_FLAGS.map((f) => (f.value ? `--${f.name} ${f.value}` : `--${f.name}`)).join(", ");

export interface NormalizedArgv {
  /** The command word, or undefined for a bare `staple`. */
  command: string | undefined;
  /** The command's arguments, with any `--db`/`--ws`/`--json` given before the command appended. */
  args: string[];
  /** The `--agent` value, from either side of the command; undefined when none was given. */
  agent: string | undefined;
}

/** First words that keep their own meaning and are not read as global flags. */
const UNTOUCHED = new Set(["help", "--help", "-h", "--yes"]);

/**
 * Split argv into the command and its arguments, with the global flags given before the
 * command moved to where the command's own parser reads them.
 *
 * A command-first invocation comes back exactly as it went in, except that `--agent` is
 * taken out (see GLOBAL_FLAGS); a bare `staple`, `staple --yes` and the help spellings are not
 * looked at at all. After `run drive`, `--agent` names the harness and stays where it is.
 */
export function normalizeArgv(argv: readonly string[]): NormalizedArgv {
  if (argv.length === 0 || UNTOUCHED.has(argv[0]!)) {
    return { command: argv[0], args: argv.slice(1), agent: undefined };
  }

  const leading: Array<{ name: string; value: string | null }> = [];
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith("-")) {
    const token = argv[index]!;
    // `staple --json --help` still asks for help.
    if (token === "--help" || token === "-h") return { command: "help", args: [], agent: undefined };
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(token);
    const flag = match ? GLOBAL_FLAGS.find((f) => f.name === match[1]) : undefined;
    if (!flag) {
      throw new StapleError(
        "validation",
        `"${token}" is not a global flag, so it cannot come before the command. Global flags: ${GLOBAL_FLAG_LIST}. ` +
          `A command's own options go after it: staple <command> ${token}.`,
      );
    }
    if (flag.value === null) {
      if (match![2] !== undefined) throw new StapleError("validation", `--${flag.name} takes no value; got "${token}".`);
      leading.push({ name: flag.name, value: null });
      index += 1;
      continue;
    }
    const value = match![2] ?? argv[index + 1];
    if (value === undefined || value === "" || (match![2] === undefined && value.startsWith("-"))) {
      throw new StapleError("validation", `--${flag.name} needs a value: --${flag.name} ${flag.value}.`);
    }
    leading.push({ name: flag.name, value });
    index += match![2] === undefined ? 2 : 1;
  }

  const command = argv[index];
  if (command === undefined) {
    throw new StapleError("validation", `A global flag needs a command after it: staple ${argv.join(" ")} <command>. Run \`staple help\`.`);
  }
  const rest = argv.slice(index + 1);
  // Only the arguments before a `--` are options; nothing after one is rewritten or read.
  const end = rest.indexOf("--") === -1 ? rest.length : rest.indexOf("--");
  const options = rest.slice(0, end);
  const operands = rest.slice(end);

  // After `run drive`, `--agent` is the harness (claude, codex, custom), not who acts.
  const agentIsHarness = command === "run" && rest[0] === "drive";
  let agent = leading.find((f) => f.name === "agent")?.value ?? undefined;
  const kept: string[] = [];
  for (let i = 0; i < options.length; i += 1) {
    const token = options[i]!;
    const match = agentIsHarness ? null : /^--agent(?:=(.*))?$/s.exec(token);
    if (!match) {
      kept.push(token);
      continue;
    }
    const value = match[1] ?? options[i + 1];
    if (value === undefined || value === "" || (match[1] === undefined && value.startsWith("-"))) {
      throw new StapleError("validation", "--agent needs a value: --agent <name>.");
    }
    if (agent !== undefined && agent !== value) throw twice("agent", agent, value);
    agent = value;
    if (match[1] === undefined) i += 1;
  }

  const appended: string[] = [];
  for (const { name, value } of leading) {
    if (name === "agent") continue;
    if (value === null) {
      appended.push(`--${name}`);
      continue;
    }
    const other = valueAfter(kept, name);
    if (other !== undefined && other !== value) throw twice(name, value, other);
    appended.push(`--${name}`, value);
  }

  return { command, args: [...kept, ...appended, ...operands], agent };
}

/** The last value `--name` is given in `args` (`--name v` or `--name=v`), as parseArgs reads it. */
function valueAfter(args: readonly string[], name: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const match = new RegExp(`^--${name}(?:=(.*))?$`, "s").exec(args[i]!);
    if (match) found = match[1] ?? args[i + 1];
  }
  return found;
}

function twice(name: string, first: string, second: string): StapleError {
  return new StapleError(
    "validation",
    `--${name} is given two different values, "${first}" and "${second}". Give it once, before or after the command.`,
  );
}
