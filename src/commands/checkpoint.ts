/**
 * `staple checkpoint` — the handoff a session leaves on a ticket, in one call.
 *
 *   checkpoint <ref> [--done T] [--next T] [--files T] [--branch NAME] [--json]
 *
 * Replaces the ticket's worklog with Done, Next and Files touched (core/checkpoint.ts), and
 * sets the branch the way `staple branch <ref> <name>` does when --branch is given.
 */
import { parseArgs } from "node:util";
import { writeCheckpoint, emptySections, type CheckpointResult } from "../core/checkpoint.js";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";
import { readStdinToEnd } from "../onboarding/prompts.js";

const HELP = `staple checkpoint <ref> [--done TEXT] [--next TEXT] [--files TEXT] [--branch NAME] [--json]
  Replace the ticket's worklog with a handoff, in one call: one new revision whose
  whole body is "## Done", "## Next" and "## Files touched", in that order. A
  second checkpoint replaces the first; the earlier one stays in the history
  (staple doc <ref> worklog --revisions).
  --done TEXT     what this session finished
  --next TEXT     where the next session picks up
  --files TEXT    the files this session changed
                  A section left out is written as its heading with nothing under
                  it, so a thin handoff shows. Say "none" when there is nothing to
                  report: a run's handoff check wants content under all three.
                  One of the three may be "-" to read that section from stdin.
  --branch NAME   also record the branch the ticket is worked on, as staple branch
                  <ref> <name> does; left out, the branch is kept. Written with the
                  worklog: both land or neither does.
  --agent A       who writes it; else $STAPLE_AGENT, else $USER`;

const OPTIONS = {
  db: { type: "string" },
  ws: { type: "string" },
  json: { type: "boolean" },
  "ack-renumber": { type: "boolean" },
  agent: { type: "string" },
  done: { type: "string" },
  next: { type: "string" },
  files: { type: "string" },
  branch: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const SECTION_FLAGS = new Set(["--done", "--next", "--files"]);

/**
 * A section is often a markdown list, and parseArgs refuses `--done "- item"` as ambiguous.
 * A section flag takes the next word as its text unless that word is one of this command's
 * own options, so a forgotten value is still refused rather than swallowing `--json`.
 */
function sectionArgs(args: readonly string[]): string[] {
  const own = (word: string) => word === "-h" || (word.startsWith("--") && Object.hasOwn(OPTIONS, word.slice(2).split("=", 1)[0]!));
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const value = args[i + 1];
    if (SECTION_FLAGS.has(word) && value !== undefined && value.startsWith("-") && !own(value)) {
      out.push(`${word}=${value}`);
      i++;
    } else out.push(word);
  }
  return out;
}

export async function runCheckpointCommand(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: sectionArgs(rest), allowPositionals: true, options: OPTIONS });
  if (values.help) return console.log(HELP);
  const [ref, ...extra] = positionals;
  if (!ref?.trim()) throw new StapleError("validation", "staple checkpoint needs an issue reference: staple checkpoint <ref> --done ... --next ... --files ....");
  if (extra.length) throw new StapleError("validation", `staple checkpoint takes its sections as --done, --next and --files; got ${extra.join(" ")}.`);
  const fromStdin = (["done", "next", "files"] as const).filter((name) => values[name] === "-");
  if (fromStdin.length > 1) throw new StapleError("validation", `Only one section can read stdin; --${fromStdin.join(" and --")} both say "-".`);
  const read = (value: string | undefined) => (value === "-" ? readStdinToEnd() : value);
  if (values["ack-renumber"]) acknowledgeRenumbers();
  const sections = { done: read(values.done), next: read(values.next), filesTouched: read(values.files) };
  const { store } = resolveWorkspace({ ws: values.ws, db: values.db });
  const actor = values.agent ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const result = writeCheckpoint(store, ref, { ...sections, ...(values.branch !== undefined ? { branch: values.branch } : {}) }, actor);
  if (values.json) return console.log(JSON.stringify(result));
  console.log(checkpointText(result, emptySections(sections)));
}

/** The answer as the terminal prints it. */
export function checkpointText(result: CheckpointResult, empty: readonly string[]): string {
  const lines = [`${result.ref}  ${result.key} @ revision ${result.revision}`];
  if (result.branch) lines.push(`  branch ${result.branch.name}${result.branch.base ? ` · base ${result.branch.base}` : ""}${result.branchChanged ? " (set)" : ""}`);
  if (empty.length) lines.push(`  empty: ${empty.join(", ")}`);
  return lines.join("\n");
}
