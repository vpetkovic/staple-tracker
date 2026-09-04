/**
 * `staple queue` — the CLI half of docs/queue.md (STA-168, R2c).
 *
 *   queue [ls] [--all] [--effective] [--actor A]
 *   queue next [--actor A]
 *   queue add <ref> [--before R | --after R | --at N] [--base N] [-m note]
 *   queue rm <ref> [--base N]
 *   queue mv <ref> (--before R | --after R | --at N) [--base N]
 *   queue reorder <r1,r2,…> [--base N]
 *   queue prune [--base N]
 *
 * TWO ORDERS, both shown. The default listing is PLAN order — the rows a human
 * put in the queue, containers included, with each container's expansion
 * indented under it and a `→ n` effective cue per leaf. `--effective` is the
 * order an AGENT receives, with the eligibility column. `queue next` is the one
 * row an agent should take and everything it stepped over.
 *
 * Every mutation goes through `QueueStore.mutate`, the same method MCP and HTTP
 * call, and every subcommand answers the same `{revision, entries, effective}`
 * under `--json` — so a script reading `queue` and a script reading the result
 * of `queue add` parse one shape. Errors are thrown as `StapleError` and
 * formatted by the top-level catch in cli.ts like every other command's.
 */
import { parseArgs } from "node:util";
import type {
  EffectiveQueueRow,
  QueueEntry,
  QueueVerb,
  QueueView,
} from "../core/queue-store.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";

const USAGE = "Use: ls, next, add, rm, mv, reorder, prune (staple queue --help)";

/**
 * `staple queue --help`. The global `staple help` lists the verbs; this says
 * what the command MEANS — that there are two orders and which one you are
 * looking at, and which refusal each surface can hand back — because that is
 * what an agent gets wrong at the moment it is holding a refusal.
 */
const HELP = `staple queue — the pickup plan: an explicit, human-ordered sequence of what
agents take next, independent of status, priority and display grouping.

  queue [ls] [--all] [--effective] [--actor A]
  queue next [--actor A]
  queue add <ref> [--before R | --after R | --at N] [--base N] [-m note]
  queue rm <ref> [--base N]
  queue mv <ref> (--before R | --after R | --at N) [--base N]
  queue reorder <r1,r2,...> [--base N]
  queue prune [--base N]

TWO ORDERS, and the difference is the whole command.

  RAW PLAN ORDER      what a human queued, containers and milestones included,
                      in the order they put them. This is the default listing
                      and it is what add/mv/reorder edit. --all keeps the
                      resolved entries visible.
  EFFECTIVE ORDER     what an AGENT receives: every container expanded
                      depth-first to its open leaf work (an epic is never a
                      checkout target), then every open leaf nobody queued, in
                      the ordinary presentation sort — the plan is a prefix,
                      not a filter. --effective prints it with its eligibility
                      column; the default listing shows it as a "-> n" cue per
                      leaf, and "queue next" is its first takeable row.

Every row is classified resolved | gated | blocked | claimed | eligible, first
match wins, and none is ever dropped: rank orders work, it never lifts a
blocker, a gate, a live claim or a resolved status.

REFUSALS. --base N is the revision a listing printed; a stale one is refused
with revision_conflict (exit 7), the one retryable code, and the server order
stands. With queue.policy = strict (staple settings get queue.policy) a
checkout of a row the plan puts later than an eligible one is refused with
out_of_order (exit 10), naming what to take instead — it is neither conflict
(exit 4, somebody got there first) nor gated (exit 9, a human must act), and
retrying clears none of the three. A human steps over the plan on the record
with "staple checkout <ref> --override -m <why>".

--json prints {revision, entries, effective} on every subcommand, and
{revision, next, skipped} for "queue next" — the same shape MCP and the UI
server answer. Full contract: docs/queue.md.`;

function integerOption(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new StapleError("validation", `${flag} must be an integer; got "${raw}".`);
  return value;
}

/** The `→ n eligibility` cue: where a row landed for an agent, and whether it may take it. */
function cue(row: EffectiveQueueRow): string {
  const detail =
    row.eligibility === "blocked" && Array.isArray(row.detail?.blockers) && (row.detail.blockers as string[]).length > 0
      ? ` ${(row.detail.blockers as string[]).join(", ")}`
      : row.eligibility === "gated" && row.detail?.queuedBy
        ? ` ${(row.detail.queuedBy as { identifier: string }).identifier}`
        : row.eligibility === "claimed" && row.detail?.heldBy
          ? ` ${String(row.detail.heldBy)}`
          : "";
  return `→ ${String(row.position).padEnd(3)} ${row.eligibility}${detail}`;
}

function planLine(entry: QueueEntry, row: EffectiveQueueRow | undefined, expanded: number): string {
  const tail = row ? cue(row) : expanded > 0 ? `container (${expanded})` : "container";
  return ` ${String(entry.planPosition).padStart(2)}  ${entry.identifier.padEnd(9)} ${entry.status.padEnd(11)} ${entry.title.slice(0, 46).padEnd(46)} ${tail}`;
}

function effectiveLine(row: EffectiveQueueRow): string {
  const band = row.unqueued ? "·" : String(row.planPosition ?? "");
  return `${String(row.position).padStart(3)}  ${band.padStart(3)}  ${row.identifier.padEnd(9)} ${row.eligibility.padEnd(9)} ${row.title.slice(0, 46).padEnd(46)}${row.reason ? `  ${row.reason}` : ""}`;
}

function printPlan(view: QueueView): void {
  console.log(`queue revision ${view.revision}`);
  if (view.entries.length === 0) {
    console.log("(empty plan — every open issue is in the unqueued band)");
    return;
  }
  const own = new Map(view.effective.map((row) => [row.issueId, row]));
  for (const entry of view.entries) {
    const expansion = view.effective.filter((row) => row.via === entry.identifier);
    console.log(planLine(entry, own.get(entry.issueId), expansion.length));
    for (const row of expansion) {
      console.log(`      ${row.identifier.padEnd(9)} ${row.title.slice(0, 46).padEnd(46)} ${cue(row)}`);
    }
  }
}

function printEffective(view: QueueView): void {
  console.log(`queue revision ${view.revision}`);
  console.log("pos  plan  issue     eligibility  title");
  for (const row of view.effective) console.log(effectiveLine(row));
}

export function runQueueCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      all: { type: "boolean" },
      effective: { type: "boolean" },
      actor: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      at: { type: "string" },
      base: { type: "string" },
      note: { type: "string", short: "m" },
    },
  });
  const [sub = "ls", first] = positionals;
  // Before the workspace is resolved: `queue --help` has to answer in a
  // directory that has no workspace yet, like every other help does.
  if (values.help === true || sub === "help") return console.log(HELP);
  const actor = values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const queue = resolveWorkspace({ db: values.db, ws: values.ws }).store.queue();
  const input = {
    ref: first,
    order: first === undefined ? undefined : first.split(",").map((part) => part.trim()).filter(Boolean),
    before: values.before,
    after: values.after,
    at: integerOption(values.at, "--at"),
    baseRevision: integerOption(values.base, "--base"),
    note: values.note ?? null,
    all: values.all === true,
  };

  if (sub === "ls") {
    const view = queue.view({ all: input.all, actor });
    if (values.json) return console.log(JSON.stringify(view));
    return values.effective === true ? printEffective(view) : printPlan(view);
  }

  if (sub === "next") {
    const result = queue.effectiveQueue({ actor });
    if (values.json) {
      return console.log(
        JSON.stringify({ revision: result.revision, next: result.next, skipped: result.skipped }),
      );
    }
    for (const row of result.skipped) console.log(`skipped  ${row.identifier.padEnd(9)} ${row.eligibility.padEnd(9)} ${row.reason ?? ""}`);
    if (!result.next) return console.log("next     (nothing eligible)");
    return console.log(`next     ${result.next.identifier} (position ${result.next.position}) ${result.next.title}`);
  }

  const verbs: Record<string, QueueVerb> = { add: "add", rm: "rm", mv: "mv", reorder: "reorder", prune: "prune" };
  const verb = verbs[sub];
  if (!verb) throw new StapleError("validation", `Unknown subcommand "${sub}". ${USAGE}`);
  const view = queue.mutate(verb, input, actor);
  if (values.json) return console.log(JSON.stringify(view));
  printPlan(view);
}
