/**
 * `staple milestone` — the CLI half of docs/milestones.md (STA-172, R3b).
 *
 *   milestone ls [--all]
 *   milestone show <ref>
 *   milestone new "<title>" [--target D] [--start D] [--from-epic <ref>] [--preview]
 *   milestone set <ref> [--target D|none] [--start D|none]
 *   milestone add <milestone> <ref> [--before R | --after R | --at N] [--base N] [-m note]
 *   milestone rm <milestone> <ref> [--base N]
 *   milestone mv <ref> (--before R | --after R | --at N | --to <milestone>) [--base N]
 *   milestone reorder <milestone> <r1,r2,…> [--base N]
 *
 * Every subcommand answers `--json` with the ONE shape `MilestoneStore` returns
 * — the same object MCP and HTTP hand back — so a script reading `show` and a
 * script reading the result of `add` parse the same thing. Title, description,
 * assignee and status are edited with the ordinary issue commands; `set` takes
 * only what is milestone-specific. Errors are thrown as `StapleError` and
 * formatted by the top-level catch in cli.ts like every other command's.
 */
import { parseArgs } from "node:util";
import type { MilestoneListRow, MilestoneView } from "../core/milestone-store.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";

const USAGE = "Use: ls, show, new, set, add, rm, mv, reorder";

/** `none` clears a date on the CLI; absent leaves it alone. */
function dateOption(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase() === "none" ? null : raw;
}

function integerOption(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new StapleError("validation", `${flag} must be an integer; got "${raw}".`);
  return value;
}

function progressCell(row: Pick<MilestoneView, "progress">): string {
  const { done } = row.progress.counts;
  const percent = row.progress.percent === null ? "—" : `${row.progress.percent}%`;
  return `${done}/${row.progress.countable} ${percent}`;
}

function summaryLine(row: MilestoneListRow | MilestoneView): string {
  const m = row.milestone;
  const next = row.next ? `  next ${row.next.identifier}` : "";
  return `${m.identifier.padEnd(9)} ${m.state.padEnd(9)} ${(m.targetDate ?? "no target").padEnd(10)} ${progressCell(row).padEnd(10)} ${m.title}${next}`;
}

function printView(view: MilestoneView): void {
  const m = view.milestone;
  console.log(`${m.identifier} · ${m.title}`);
  console.log(
    `state ${m.state} · status ${m.status}${m.assignee ? ` · @${m.assignee}` : ""} · target ${m.targetDate ?? "none"} · start ${m.startDate ?? "none"} · revision ${view.revision}`,
  );
  console.log(`progress ${progressCell(view)} · ${view.progress.total} leaves${view.progress.complete ? " · complete" : ""}`);
  if (view.members.length === 0) {
    console.log("members  (none)");
    return;
  }
  console.log("members");
  for (const member of view.members) {
    const indent = member.nestedUnder ? "    " : "  ";
    const kind = member.kind === "task" ? "" : ` · ${member.kind}`;
    console.log(`${indent}${String(member.position).padStart(2)}. ${member.identifier.padEnd(9)} ${member.status.padEnd(11)} ${member.title}${kind}`);
  }
  if (view.next) console.log(`next     ${view.next.identifier} (member ${view.next.position})`);
}

export function runMilestoneCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      all: { type: "boolean" },
      preview: { type: "boolean" },
      target: { type: "string" },
      start: { type: "string" },
      "from-epic": { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      at: { type: "string" },
      to: { type: "string" },
      base: { type: "string" },
      note: { type: "string", short: "m" },
    },
  });
  const [sub = "ls", first, second] = positionals;
  const actor = process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new StapleError("validation", `staple milestone ${sub} needs ${what}`);
    return value;
  };
  const position = {
    before: values.before,
    after: values.after,
    at: integerOption(values.at, "--at"),
  };
  const baseRevision = integerOption(values.base, "--base");
  const milestones = resolveWorkspace({ db: values.db, ws: values.ws }).store.milestones();

  let view: MilestoneView;
  switch (sub) {
    case "ls": {
      const rows = milestones.list({ all: values.all === true });
      if (values.json) return console.log(JSON.stringify(rows));
      if (rows.length === 0) return console.log(values.all ? "no milestones" : "no open milestones");
      for (const row of rows) console.log(summaryLine(row));
      return;
    }
    case "show":
      view = milestones.get(need(first, "a milestone reference"));
      break;
    case "new": {
      const result = milestones.create(
        {
          title: first,
          targetDate: dateOption(values.target) ?? null,
          startDate: dateOption(values.start) ?? null,
          fromEpic: values["from-epic"] ?? null,
          preview: values.preview === true,
        },
        actor,
      );
      if (values.json) return console.log(JSON.stringify(result));
      if (result.preview) {
        const m = result.milestone;
        console.log(`would create  ${m.title}  (milestone${m.targetDate ? `, target ${m.targetDate}` : ""}${m.startDate ? `, start ${m.startDate}` : ""})`);
        for (const member of result.members) console.log(`  + member  ${member.identifier}  at ${member.position}`);
        console.log(`hierarchy changes: ${result.hierarchyChanges.length === 0 ? "none" : String(result.hierarchyChanges.length)}`);
        return;
      }
      view = result;
      break;
    }
    case "set":
      view = milestones.update(
        need(first, "a milestone reference"),
        { targetDate: dateOption(values.target), startDate: dateOption(values.start) },
        actor,
      );
      break;
    case "add":
      view = milestones.addMember(
        need(first, "a milestone reference"),
        need(second, "the issue to add"),
        { ...position, baseRevision, note: values.note ?? null },
        actor,
      );
      break;
    case "rm":
      view = milestones.removeMember(need(first, "a milestone reference"), need(second, "the member to remove"), { baseRevision }, actor);
      break;
    case "mv":
      view = milestones.moveMember(need(first, "the member to move"), { ...position, to: values.to, baseRevision }, actor);
      break;
    case "reorder": {
      // Comma-separated, like `statuses reorder`: one shell word per LIST.
      const refs = need(second, "a comma-separated order").split(",").map((s) => s.trim()).filter(Boolean);
      view = milestones.reorderMembers(need(first, "a milestone reference"), refs, { baseRevision }, actor);
      break;
    }
    default:
      throw new StapleError("validation", `Unknown subcommand "${sub}". ${USAGE}`);
  }
  if (values.json) return console.log(JSON.stringify(view));
  printView(view);
}
