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
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { configuredHumanName } from "../mcp-view-actions.js";
import type { HorizonView, IdeaDetail, IdeaView, PlanView, PlanWriteOptions, ScaffoldPreview } from "../core/plan-store.js";
import { splitDepends, type BreakdownRowInput, type PlanPatch } from "../core/plan-sections.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";
import { aKind } from "../core/plan.js";

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

function planFor(values: { db?: string; ws?: string }, enabling = false) {
  const plan = resolveWorkspace({ db: values.db, ws: values.ws }).store.plan();
  if (!enabling) plan.assertEnabled();
  return plan;
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

function printScaffold(preview: ScaffoldPreview, dry: boolean, depth = 0): void {
  const pad = "  ".repeat(depth);
  const epic = preview.epic.identifier ?? `a new ${preview.epic.kind}`;
  console.log(`${pad}${dry ? "would make" : "made"} ${epic}: ${preview.idea.title} · ${preview.epic.acceptance.length} acceptance criteria`);
  for (const task of preview.tasks) {
    const blockers = task.blockedBy.length > 0 ? ` · after ${task.blockedBy.join(", ")}` : "";
    const inherited = task.acceptanceInherited ? " · acceptance inherited" : "";
    const estimate = task.estimateWarning ? ` · ${task.estimateWarning}` : task.estimate ? ` · ${task.estimate}` : "";
    console.log(`${pad}  ${task.existing ?? (dry ? "new" : "?")} ${task.title}${estimate}${blockers}${inherited}`);
  }
  for (const warning of depth === 0 ? preview.warnings : []) console.log(`${pad}warning ${warning}`);
  for (const child of preview.children) printScaffold(child, dry, depth + 1);
}

function horizonLine(horizon: HorizonView): string {
  const risk = [horizon.lateCount ? `${horizon.lateCount} late` : null, horizon.notStartedCount ? `${horizon.notStartedCount} not started` : null].filter(Boolean).join(" · ");
  const run = horizon.runMode ? `  runs ${horizon.runMode}${horizon.goal.length ? ` · ${horizon.goal.length} goal ${horizon.goal.length === 1 ? "criterion" : "criteria"}` : ""}` : horizon.goal.length ? `  ${horizon.goal.length} goal ${horizon.goal.length === 1 ? "criterion" : "criteria"}` : "";
  // Leaf ideas: a parent is counted apart, never as one of its children.
  const { leaves, parentCount } = horizon.records;
  const parents = parentCount ? ` (+${parentCount} ${parentCount === 1 ? "parent" : "parents"})` : "";
  const { done, total, planned } = horizon.units;
  const progress = `  ${done}/${total} ${horizon.progress === null ? "—" : `${Math.floor(horizon.progress * 100)}%`}${planned ? ` · ${planned} planned` : ""}${horizon.unsizedCount ? ` · ${horizon.unsizedCount} unsized` : ""}`;
  return `${horizon.identifier.padEnd(9)} ${horizon.name.padEnd(24)} ${(horizon.date ?? "no date").padEnd(10)} ${horizon.state.padEnd(8)} ${String(leaves).padStart(3)} ${leaves === 1 ? "idea" : "ideas"}${parents}${progress}${risk ? `  ${risk}` : ""}${run}${horizon.awaitingApproval ? "  waiting for your approval" : ""}`;
}

function printDetail(detail: IdeaDetail): void {
  const { idea } = detail;
  console.log(`${idea.identifier ?? `idea ${idea.id}`} · ${idea.title}`);
  console.log(`state ${idea.state} · stage ${idea.stage} · maturity ${idea.maturity} · horizon ${detail.horizon?.name ?? "unscheduled"}${detail.parent ? ` · part of ${detail.parent.identifier ?? detail.parent.title}` : ""}`);
  console.log(`planned ${idea.planned.start ?? "—"} → ${idea.planned.target ?? "—"}${idea.baseline ? ` · baseline ${idea.baseline.start ?? "—"} → ${idea.baseline.target ?? "—"}` : ""}`);
  if (idea.linkCount > 0) {
    console.log(`actual ${idea.actual.start ?? "—"} → ${idea.actual.end ?? (idea.actual.forecastEnd ? `~${idea.actual.forecastEnd}` : "open")} · ${Math.round((idea.progress ?? 0) * 100)}%${idea.late ? " · late" : ""}`);
  } else if (idea.notStarted) {
    console.log("not started: its planned start has passed and nothing is linked");
  }
  if (detail.brief) console.log(`brief    ${detail.brief.split("\n")[0]}`);
  detail.questions.forEach((q, i) => console.log(`  ${q.resolved ? "[x]" : q.deferred ? "[~]" : "[ ]"} ${i + 1}. ${q.text}${q.deferred ? " (deferred)" : ""}`));
  for (const decision of detail.decisions) console.log(`  decided ${decision}`);
  for (const child of detail.children) console.log(`  sub-idea ${child.identifier ?? child.id} ${child.title} (${child.stage})`);
  for (const link of detail.linked) console.log(`  linked  ${link.identifier} ${link.title} · ${link.status} · ${link.doneLeaves}/${link.leaves}`);
  const { completeness: c } = detail;
  console.log(`plan     ${c.starred}/${c.starredTotal} required sections · ${c.filled}/${c.total} written${detail.missingForShaped.length > 0 && (idea.state === "raw" || idea.state === "exploring") ? ` · to shape: ${detail.missingForShaped.join("; ")}` : ""}`);
  if (idea.planIncomplete.length > 0) console.log(`shaped · plan incomplete: ${idea.planIncomplete.join("; ")}`);
  if (detail.plan.goal) console.log(`goal     ${detail.plan.goal.split("\n")[0]}`);
  const inherits = detail.plan.acceptance.length > 0;
  for (const row of detail.plan.breakdown) {
    const done = row.acceptance ? "" : inherits ? " · done when: inherits the plan's acceptance" : " · no acceptance";
    console.log(`  task ${row.key} ${row.title}${row.estimate ? ` · ${row.estimate}` : ""}${row.dependsOn.length ? ` · after ${row.dependsOn.join(", ")}` : ""}${done}`);
  }
  for (const warning of detail.planWarnings) console.log(`  warning ${warning}`);
  for (const item of detail.plan.acceptance) console.log(`  accept ${item}`);
  console.log(`offers   ${offeredLine(idea.actions)}`);
}

/** What the record's state offers, from the lifecycle table; a person-only action says so. */
function offeredLine(actions: IdeaDetail["idea"]["actions"]): string {
  if (actions.length === 0) return "nothing";
  return actions.map((action) => `${action.label.toLowerCase()}${action.who === "person" ? " (person)" : ""}${action.disabledReason ? ` [${action.disabledReason}]` : ""}`).join(", ");
}

export function runPlanCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: COMMON });
  const [sub = "show"] = positionals;
  const plan = planFor(values, sub === "enable");
  const { actor, options } = writer(values.person);
  let view: PlanView;
  switch (sub) {
    case "enable":
      view = plan.enable(actor, options);
      break;
    case "show":
      view = plan.view();
      break;
    default:
      throw new StapleError("validation", `Unknown plan verb "${sub}". Use: enable, show`);
  }
  if (values.json) return console.log(JSON.stringify(view));
  for (const horizon of view.horizons) console.log(horizonLine(horizon));
  console.log(`${view.ideas.length} ${view.ideas.length === 1 ? "idea" : "ideas"} · today ${view.today}`);
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
      goal: { type: "string" },
      context: { type: "string" },
      acceptance: { type: "string", multiple: true },
      dependency: { type: "string", multiple: true },
      "out-of-scope": { type: "string" },
      risks: { type: "string" },
      source: { type: "string", multiple: true },
      estimate: { type: "string" },
      depends: { type: "string" },
      owner: { type: "string" },
      notes: { type: "string" },
      preview: { type: "boolean" },
      confirm: { type: "string" },
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
      console.log(`promoted to ${promoted.identifier}: ${promoted.title} is ${aKind(promoted.kind)} in the tracker now (${promoted.stage})`);
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
    case "defer": {
      const position = Number(need(others[0], "the question's number"));
      if (!Number.isInteger(position)) throw new StapleError("validation", "The question's number is a whole number, 1 for the first.");
      plan.deferQuestion(need(first, "an idea reference"), position, actor, values.reopen !== true);
      return show(first!);
    }
    case "plan": {
      // The text and list sections; a list flag given replaces that list whole.
      const ref = need(first, "an idea reference");
      const patch: PlanPatch = {};
      if (values.goal !== undefined) patch.goal = values.goal;
      if (values.context !== undefined) patch.context = values.context === "-" ? readFileSync(0, "utf8") : values.context;
      if (values.acceptance !== undefined) patch.acceptance = values.acceptance;
      if (values.dependency !== undefined) patch.dependencies = values.dependency;
      if (values["out-of-scope"] !== undefined) patch.outOfScope = values["out-of-scope"];
      if (values.risks !== undefined) patch.risks = values.risks;
      if (values.source !== undefined) patch.sources = values.source;
      if (Object.keys(patch).length > 0) plan.update(ref, { plan: patch }, actor, options);
      return show(ref);
    }
    case "task": {
      // One breakdown row at a time: add <key> <title…>, set <key>, rm <key>.
      const ref = need(first, "an idea reference");
      const [verb, key, ...titleWords] = others;
      const read = plan.detail(ref);
      const rows: BreakdownRowInput[] = [...read.plan.breakdown];
      const at = rows.findIndex((row) => row.key === key);
      const fields = (base: BreakdownRowInput): BreakdownRowInput => ({
        ...base,
        title: titleWords.length > 0 ? titleWords.join(" ") : values.title ?? base.title,
        estimate: values.estimate ?? base.estimate,
        dependsOn: values.depends !== undefined ? splitDepends(values.depends) : base.dependsOn,
        acceptance: values.acceptance?.[0] ?? base.acceptance,
        owner: values.owner ?? base.owner,
        notes: values.notes ?? base.notes,
      });
      if (verb === "add") {
        if (at >= 0) throw new StapleError("validation", `Task ${key} is already in the breakdown; use \`staple idea task ${ref} set ${key}\`.`);
        rows.push(fields({ key: need(key, "the task's key"), title: "", estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null }));
      } else if (verb === "set" || verb === "rm") {
        if (at < 0) throw new StapleError("validation", `No task ${key ?? "(none given)"} in this idea's breakdown.`);
        if (verb === "set") rows[at] = fields(rows[at]!);
        else rows.splice(at, 1);
      } else {
        throw new StapleError("validation", "staple idea task <ref> add|set|rm <key> [title] [--estimate E] [--depends K,K] [--acceptance T] [--owner O] [--notes T]");
      }
      plan.update(ref, { plan: { breakdown: rows }, breakdownBase: read.breakdownRevision }, actor, options);
      return show(ref);
    }
    case "scaffold": {
      const ref = need(first, "an idea reference");
      // Without --confirm it is the preview; the confirm names the fingerprint the preview printed.
      const dry = values.confirm === undefined;
      const result = dry ? plan.scaffoldPreview(ref) : plan.scaffold(ref, values.confirm, actor, options);
      if (values.json) return console.log(JSON.stringify(result));
      printScaffold(result, dry);
      if (dry) {
        console.log(
          result.problems.length > 0
            ? `held back: ${result.problems.join("; ")}`
            : `confirm with: staple idea scaffold ${ref} --confirm ${result.fingerprint}${values.person ? " --person" : ""}`,
        );
      }
      return;
    }
    case "import": {
      const path = need(first, "a plan file (markdown)");
      const result = plan.importPlan(
        { name: basename(path), markdown: readFileSync(path, "utf8") },
        { parent: values.parent ?? null, horizon: values.horizon ?? null, maturity: values.maturity },
        actor,
        options,
      );
      if (values.json) return console.log(JSON.stringify(result));
      console.log(`imported ${result.idea.idea.title} (idea ${result.idea.idea.id}): ${result.rows} task${result.rows === 1 ? "" : "s"}, ${result.idea.completeness.filled}/${result.idea.completeness.total} sections`);
      for (const warning of result.warnings) console.log(`  warning: ${warning}`);
      return;
    }
    default:
      throw new StapleError("validation", `Unknown idea verb "${sub}". Use: ls, new, show, set, plan, task, promote, scaffold, import, adopt, unlink, ask, resolve, defer, decide, reset-baseline`);
  }
}

export function runHorizonCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...COMMON, name: { type: "string" }, date: { type: "string" }, before: { type: "string" }, end: { type: "boolean" }, run: { type: "string" }, goal: { type: "string", multiple: true }, "no-goal": { type: "boolean" } },
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
    for (const horizon of view.horizons) console.log(horizonLine(horizon));
  };
  switch (sub) {
    case "ls":
      return list();
    case "new":
      plan.createHorizon({ name: need([first, ...others].filter(Boolean).join(" "), "a name"), date: values.date ?? null }, actor, options);
      return list();
    case "set": {
      const ref = need(first, "a horizon reference");
      const naming = values.name !== undefined || values.date !== undefined;
      const running = values.run !== undefined || values.goal !== undefined || values["no-goal"] === true;
      if (!naming && !running) throw new StapleError("validation", "staple horizon set needs --name, --date, --run (work, goal, epic or none) or --goal");
      if (naming) plan.updateHorizon(ref, { name: values.name, date: clearable(values.date) }, actor, options);
      if (running) {
        plan.setHorizonRun(
          ref,
          {
            ...(values.run !== undefined ? { mode: (values.run === "none" ? null : values.run) as never } : {}),
            ...(values.goal !== undefined || values["no-goal"] ? { goal: values["no-goal"] ? [] : (values.goal as string[]) } : {}),
          },
          actor,
          options,
        );
      }
      return list();
    }
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
