/**
 * `staple plan`, `staple idea` and `staple horizon` (design/plan.md).
 *
 * The CLI is an agent's door by default: it captures raw ideas, edits titles and briefs, adds
 * and resolves questions, adds decisions, adopts and unlinks work, and promotes an idea the
 * person has marked shaped. Maturity, horizons, dates, order and the baseline are the
 * person's; a person at the terminal says so with `--person`, which records the write under
 * the machine's configured `humanName` (`staple config set humanName "…"`), as a decision a
 * person made from the CLI.
 */
import { parseArgs } from "node:util";
import { configuredHumanName } from "../mcp-view-actions.js";
import type { HorizonView, IdeaDetail, IdeaView, PlanView, PlanWriteOptions } from "../core/plan-store.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";

const COMMON = {
  db: { type: "string" },
  ws: { type: "string" },
  json: { type: "boolean" },
  person: { type: "boolean" },
} as const;

/** `none` clears a value on the CLI; absent leaves it alone. */
function clearable(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw.trim().toLowerCase() === "none" ? null : raw;
}

/**
 * Who writes, and whether as the person. `--person` without a configured name is refused:
 * a decision recorded under a guessed name is worse than none.
 */
function writer(person: boolean | undefined): { actor: string; options: PlanWriteOptions } {
  const agent = process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  if (!person) return { actor: agent, options: {} };
  const name = configuredHumanName();
  if (name === null) {
    throw new StapleError(
      "validation",
      '--person records the write as yours, so it needs your name: run `staple config set humanName "Your Name"` first.',
    );
  }
  return { actor: name, options: { person: { via: "cli" } } };
}

function planFor(values: { db?: string; ws?: string }) {
  return resolveWorkspace({ db: values.db, ws: values.ws }).store.plan();
}

function ideaLine(idea: IdeaView, plan: PlanView): string {
  const horizon = plan.horizons.find((h) => h.id === idea.horizonId)?.name ?? "unscheduled";
  const flags = [idea.late ? "late" : null, idea.notStarted ? "not started" : null].filter(Boolean).join(", ");
  const depth = (() => {
    let level = 0;
    let cursor = idea.parentId;
    while (cursor && level < 8) {
      level += 1;
      cursor = plan.ideas.find((other) => other.id === cursor)?.parentId ?? null;
    }
    return level;
  })();
  const progress = idea.progress === null ? "" : ` ${Math.round(idea.progress * 100)}%`;
  // An idea has no ticket number to show; its id is what a command takes until it is promoted.
  return `${(idea.identifier ?? idea.id).padEnd(9)} ${idea.stage.padEnd(9)} ${horizon.padEnd(14)} ${"  ".repeat(depth)}${idea.title}${progress}${flags ? `  [${flags}]` : ""}`;
}

function horizonLine(horizon: HorizonView): string {
  const risk = [horizon.lateCount ? `${horizon.lateCount} late` : null, horizon.notStartedCount ? `${horizon.notStartedCount} not started` : null].filter(Boolean).join(" · ");
  return `${horizon.identifier.padEnd(9)} ${horizon.name.padEnd(24)} ${(horizon.date ?? "no date").padEnd(10)} ${String(horizon.ideaCount).padStart(3)} ideas${risk ? `  ${risk}` : ""}`;
}

function printDetail(detail: IdeaDetail): void {
  const { idea } = detail;
  console.log(`${idea.identifier ?? `idea ${idea.id}`} · ${idea.title}`);
  console.log(`stage ${idea.stage} · maturity ${idea.maturity} · horizon ${detail.horizon?.name ?? "unscheduled"}${detail.parent ? ` · part of ${detail.parent.identifier ?? detail.parent.title}` : ""}`);
  console.log(`planned ${idea.planned.start ?? "—"} → ${idea.planned.target ?? "—"}${idea.baseline ? ` · baseline ${idea.baseline.start ?? "—"} → ${idea.baseline.target ?? "—"}` : ""}`);
  if (idea.linkCount > 0) {
    console.log(`actual ${idea.actual.start ?? "—"} → ${idea.actual.end ?? (idea.actual.forecastEnd ? `~${idea.actual.forecastEnd}` : "open")} · ${Math.round((idea.progress ?? 0) * 100)}%${idea.late ? " · late" : ""}`);
  } else if (idea.notStarted) {
    console.log("not started: its planned start has passed and nothing is linked");
  }
  if (detail.brief) console.log(`brief    ${detail.brief.split("\n")[0]}`);
  detail.questions.forEach((q, i) => console.log(`  ${q.resolved ? "[x]" : "[ ]"} ${i + 1}. ${q.text}`));
  for (const decision of detail.decisions) console.log(`  decided ${decision}`);
  for (const child of detail.children) console.log(`  sub-idea ${child.identifier} ${child.title} (${child.stage})`);
  for (const link of detail.linked) console.log(`  linked  ${link.identifier} ${link.title} · ${link.status} · ${link.doneLeaves}/${link.leaves}`);
}

export function runPlanCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMMON });
  const [sub = "show"] = positionals;
  const plan = planFor(values);
  const { actor } = writer(values.person);
  let view: PlanView;
  switch (sub) {
    case "enable":
      view = plan.enable(actor);
      break;
    case "show":
      view = plan.view();
      break;
    default:
      throw new StapleError("validation", `Unknown plan verb "${sub}". Use: enable, show`);
  }
  if (values.json) return console.log(JSON.stringify(view));
  if (!view.enabled) return console.log("Planning is not turned on. Run `staple plan enable`.");
  for (const horizon of view.horizons) console.log(horizonLine(horizon));
  console.log(`${view.ideas.length} ideas · today ${view.today}`);
}

export function runIdeaCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...COMMON,
      brief: { type: "string" },
      title: { type: "string" },
      parent: { type: "string" },
      maturity: { type: "string" },
      horizon: { type: "string" },
      start: { type: "string" },
      target: { type: "string" },
      before: { type: "string" },
      reopen: { type: "boolean" },
    },
  });
  const [sub = "ls", first, ...others] = positionals;
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new StapleError("validation", `staple idea ${sub} needs ${what}`);
    return value;
  };
  const plan = planFor(values);
  const { actor, options } = writer(values.person);
  const show = (ref: string) => {
    const detail = plan.detail(ref);
    if (values.json) console.log(JSON.stringify(detail));
    else printDetail(detail);
  };

  switch (sub) {
    case "ls": {
      const view = plan.view();
      let ideas = view.ideas;
      if (values.maturity) ideas = ideas.filter((idea) => idea.maturity === values.maturity);
      if (values.horizon) {
        const horizon = view.horizons.find((h) => h.identifier === values.horizon!.toUpperCase() || h.id === values.horizon || h.name.toLowerCase() === values.horizon!.toLowerCase());
        ideas = ideas.filter((idea) => idea.horizonId === (horizon?.id ?? null));
      }
      if (values.json) return console.log(JSON.stringify(ideas));
      if (!view.enabled) return console.log("Planning is not turned on. Run `staple plan enable`.");
      if (ideas.length === 0) return console.log("no ideas");
      for (const idea of ideas) console.log(ideaLine(idea, view));
      return;
    }
    case "new": {
      const idea = plan.capture(
        {
          title: [first, ...others].filter(Boolean).join(" "),
          brief: values.brief ?? null,
          parent: values.parent ?? null,
          maturity: values.maturity,
          horizon: values.horizon ?? null,
          plannedStart: values.start ?? null,
          plannedTarget: values.target ?? null,
        },
        actor,
        options,
      );
      return show(idea.id);
    }
    case "show":
      return show(need(first, "an idea reference"));
    case "set": {
      const ref = need(first, "an idea reference");
      plan.update(
        ref,
        {
          title: values.title,
          brief: values.brief,
          maturity: values.maturity,
          horizon: clearable(values.horizon),
          parent: clearable(values.parent),
          plannedStart: clearable(values.start),
          plannedTarget: clearable(values.target),
          before: values.before === undefined ? undefined : values.before === "end" ? null : values.before,
        },
        actor,
        options,
      );
      return show(ref);
    }
    case "promote": {
      const promoted = plan.promote(need(first, "an idea reference"), actor, options);
      if (values.json) return console.log(JSON.stringify(promoted));
      console.log(`promoted to ${promoted.identifier}: ${promoted.title} is a ${promoted.kind} in the tracker now (${promoted.stage})`);
      return;
    }
    case "adopt":
      plan.adopt(need(first, "an idea reference"), need(others[0], "the issue to adopt"), actor);
      return show(first!);
    case "unlink":
      plan.unlink(need(first, "an idea reference"), need(others[0], "the issue to unlink"), actor);
      return show(first!);
    case "ask":
      plan.addQuestion(need(first, "an idea reference"), need(others.join(" "), "the question"), actor);
      return show(first!);
    case "resolve": {
      const position = Number(need(others[0], "the question's number"));
      if (!Number.isInteger(position)) throw new StapleError("validation", "The question's number is a whole number, 1 for the first.");
      plan.resolveQuestion(need(first, "an idea reference"), position, actor, values.reopen !== true);
      return show(first!);
    }
    case "decide":
      plan.addDecision(need(first, "an idea reference"), need(others.join(" "), "the decision"), actor);
      return show(first!);
    case "reset-baseline":
      plan.resetBaseline(need(first, "an idea reference"), actor, options);
      return show(first!);
    default:
      throw new StapleError("validation", `Unknown idea verb "${sub}". Use: ls, new, show, set, promote, adopt, unlink, ask, resolve, decide, reset-baseline`);
  }
}

export function runHorizonCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...COMMON, name: { type: "string" }, date: { type: "string" }, before: { type: "string" }, end: { type: "boolean" } },
  });
  const [sub = "ls", first, ...others] = positionals;
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new StapleError("validation", `staple horizon ${sub} needs ${what}`);
    return value;
  };
  const plan = planFor(values);
  const { actor, options } = writer(values.person);
  const list = () => {
    const view = plan.view();
    if (values.json) return console.log(JSON.stringify(view.horizons));
    if (!view.enabled) return console.log("Planning is not turned on. Run `staple plan enable`.");
    for (const horizon of view.horizons) console.log(horizonLine(horizon));
  };
  switch (sub) {
    case "ls":
      return list();
    case "new":
      plan.createHorizon({ name: need([first, ...others].filter(Boolean).join(" "), "a name"), date: values.date ?? null }, actor, options);
      return list();
    case "set":
      plan.updateHorizon(need(first, "a horizon reference"), { name: values.name, date: clearable(values.date) }, actor, options);
      return list();
    case "mv":
      if (values.before === undefined && values.end !== true) throw new StapleError("validation", "staple horizon mv needs --before <horizon> or --end");
      plan.updateHorizon(need(first, "a horizon reference"), { before: values.end ? null : values.before! }, actor, options);
      return list();
    case "rm":
      plan.removeHorizon(need(first, "a horizon reference"), actor, options);
      return list();
    default:
      throw new StapleError("validation", `Unknown horizon verb "${sub}". Use: ls, new, set, mv, rm`);
  }
}
