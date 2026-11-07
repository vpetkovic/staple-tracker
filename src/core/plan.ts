/**
 * The plan layer: the pure half of `design/plan.md`.
 *
 * An idea is an issue of the reserved kind `idea`; a horizon is an issue of the reserved
 * kind `horizon`. Together they are the plan kinds. They live above the tracker: never
 * queued, never checked out, never picked by `next`, never counted by a non-plan parent's
 * derived status and never listed in a task view unless asked for. Start (a new epic) and
 * Adopt (an existing issue) are the only links from an idea into the work.
 *
 * Everything here is a type or a function of its arguments: no store, no database, no clock.
 */
import { StapleError } from "./types.js";

export const IDEA_KIND = "idea";
export const HORIZON_KIND = "horizon";
export const PLAN_KINDS: ReadonlySet<string> = new Set([IDEA_KIND, HORIZON_KIND]);

export function isPlanKind(kind: string | null | undefined): boolean {
  return typeof kind === "string" && PLAN_KINDS.has(kind);
}

/** What a person sets by hand. `dropped` keeps the idea and takes it off the boards. */
export const MATURITIES = ["raw", "exploring", "shaped", "dropped"] as const;
export type Maturity = (typeof MATURITIES)[number];

/**
 * The ladder the UI shows. The first three are a maturity; `scheduled` means it has a
 * horizon, `started` that it links work, `shipped` that every linked issue is resolved.
 */
export const STAGES = ["raw", "exploring", "shaped", "scheduled", "started", "shipped", "dropped"] as const;
export type Stage = (typeof STAGES)[number];

export function parseMaturity(value: string): Maturity {
  const clean = value.trim().toLowerCase();
  if ((MATURITIES as readonly string[]).includes(clean)) return clean as Maturity;
  throw new StapleError("validation", `Maturity is one of ${MATURITIES.join(", ")}; got "${value}".`, {
    maturity: value,
  });
}

/** An unknown stored value (a later build's) reads as `raw` here rather than failing a read. */
export function readMaturity(value: string | null | undefined): Maturity {
  return (MATURITIES as readonly string[]).includes(value ?? "") ? (value as Maturity) : "raw";
}

export interface StageInputs {
  maturity: Maturity;
  scheduled: boolean;
  /** Linked issues, own and rolled up from child ideas. */
  links: number;
  /** How many of them are resolved. */
  resolvedLinks: number;
}

export function deriveStage(input: StageInputs): Stage {
  if (input.links > 0) return input.resolvedLinks >= input.links ? "shipped" : "started";
  if (input.maturity === "dropped") return "dropped";
  if (input.scheduled) return "scheduled";
  return input.maturity;
}

// ---------- dates: calendar days, UTC, inclusive (as milestones) ----------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function parsePlanDate(value: string): string {
  const clean = value.trim();
  const fail = () => new StapleError("validation", `Plan dates are calendar days, YYYY-MM-DD; got "${value}".`);
  if (!DATE_PATTERN.test(clean)) throw fail();
  const date = new Date(`${clean}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== clean) throw fail();
  return clean;
}

export function assertPlanWindow(window: { start: string | null; target: string | null }): void {
  if (window.start !== null && window.target !== null && window.start > window.target) {
    throw new StapleError(
      "validation",
      `The planned start (${window.start}) is after the planned target (${window.target}).`,
      window,
    );
  }
}

export function utcDay(at: Date | string): string {
  return (typeof at === "string" ? new Date(at) : at).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / MS_PER_DAY);
}

// ---------- derived dates and lateness ----------

export interface ActualWindow {
  /** First day any linked work started, or null when none has. */
  start: string | null;
  /** Last day linked work finished, when all of it has. */
  end: string | null;
  /** When open work is expected to land, from progress so far; null when it cannot be told. */
  forecastEnd: string | null;
}

/**
 * A straight-line forecast: the days spent so far over the share done. Nothing is said
 * before any work started, before any of it is done, or once it has all landed.
 */
export function forecastEnd(input: { start: string | null; end: string | null; progress: number; today: string }): string | null {
  if (input.end !== null || input.start === null || input.progress <= 0 || input.progress >= 1) return null;
  const spent = Math.max(1, daysBetween(input.start, input.today));
  return addDays(input.start, Math.ceil(spent / input.progress));
}

/**
 * Late when the work landed, or is forecast to land, after the earlier of the planned target
 * and the horizon's date; or when that day has passed and the idea is still open.
 */
export function isLate(input: {
  plannedTarget: string | null;
  horizonDate: string | null;
  actual: ActualWindow;
  /** Not shipped and not dropped. */
  open: boolean;
  today: string;
}): boolean {
  const lines = [input.plannedTarget, input.horizonDate].filter((day): day is string => day !== null);
  if (lines.length === 0) return false;
  const line = lines.reduce((a, b) => (a < b ? a : b));
  const landing = input.actual.end ?? input.actual.forecastEnd;
  if (landing !== null && landing > line) return true;
  return input.open && input.today > line;
}

// ---------- guards ----------

export const PLAN_KINDS_MISSING_MESSAGE =
  "Planning is not turned on in this workspace. Run `staple plan enable` (it adds the `idea` and `horizon` kinds).";

export function assertPlanKindsConfigured(kindIds: readonly string[]): void {
  if (!kindIds.includes(IDEA_KIND) || !kindIds.includes(HORIZON_KIND)) {
    throw new StapleError("validation", PLAN_KINDS_MISSING_MESSAGE, { kinds: [IDEA_KIND, HORIZON_KIND] });
  }
}

/** The one sentence every tracker door gives a plan-kind issue. */
export function planKindRefusal(issue: { identifier: string; kind: string }, action: string): StapleError {
  const noun = issue.kind === IDEA_KIND ? "an idea" : "a horizon";
  const door =
    issue.kind === IDEA_KIND
      ? ` Ideas reach the tracker through Start or Adopt (\`staple idea start ${issue.identifier}\`).`
      : "";
  return new StapleError("validation", `${issue.identifier} is ${noun}; it cannot be ${action}.${door}`, {
    identifier: issue.identifier,
    kind: issue.kind,
  });
}

/**
 * The parent rule. An idea's parent is an idea or nothing; a horizon has none; a tracker
 * issue never sits under a plan-kind issue.
 */
export function assertPlanParent(
  child: { kind: string; identifier?: string },
  parent: { kind: string; identifier: string } | null,
): void {
  if (parent === null) return;
  if (child.kind === HORIZON_KIND) {
    throw new StapleError("validation", "A horizon cannot have a parent.", { parent: parent.identifier });
  }
  if (child.kind === IDEA_KIND && parent.kind !== IDEA_KIND) {
    throw new StapleError("validation", `An idea's parent must be another idea; ${parent.identifier} is ${parent.kind === HORIZON_KIND ? "a horizon" : `a ${parent.kind}`}.`, {
      parent: parent.identifier,
    });
  }
  if (!isPlanKind(child.kind) && isPlanKind(parent.kind)) {
    throw new StapleError(
      "validation",
      `${parent.identifier} is ${parent.kind === IDEA_KIND ? "an idea" : "a horizon"}; tracker work cannot be filed under it. Use \`staple idea adopt ${parent.identifier} <ref>\` to link work to an idea.`,
      { parent: parent.identifier },
    );
  }
}

/** Re-declaring a kind across the plan boundary is refused in both directions. */
export function assertPlanRekind(row: { identifier: string; kind: string }, nextKind: string): void {
  if (row.kind === nextKind) return;
  if (isPlanKind(row.kind) || isPlanKind(nextKind)) {
    throw new StapleError(
      "validation",
      `${row.identifier} cannot change kind from ${row.kind} to ${nextKind}: ideas and horizons stay above the tracker. Start or adopt work from an idea instead.`,
      { identifier: row.identifier, kind: row.kind, nextKind },
    );
  }
}

// ---------- who steers ----------

/**
 * The plan's steering is the person's: maturity, horizon assignment, horizon definitions and
 * dates, planned dates and the baseline. A write that carries a `PersonDecision` (the web UI,
 * an app-only view action, the CLI's `--person`) may make them; any other write is an agent's
 * and is refused here, naming what the agent can do instead.
 */
export type SteeringWrite =
  | "maturity"
  | "horizon"
  | "parent"
  | "planned dates"
  | "baseline"
  | "horizons"
  | "start";

export function steeringRefusal(what: SteeringWrite, identifier: string | null): StapleError {
  const subject = identifier ?? "the plan";
  const message =
    what === "start"
      ? `${subject} is not shaped yet; an agent may start only an idea the person has marked shaped. Capture questions or decisions on it instead, or ask the person to shape it.`
      : `Changing ${what === "horizons" ? "horizons" : `the ${what} of ${subject}`} is the person's call, not an agent's. ` +
        "Agents capture ideas, edit titles and briefs, add questions and decisions, and adopt or unlink work; " +
        "the person sets maturity, horizons, dates and the baseline in the Plan view (or the CLI with --person).";
  return new StapleError("validation", message, { steering: what, ...(identifier ? { identifier } : {}) });
}

/** Default horizons for `staple plan enable`, in order. */
export const DEFAULT_HORIZONS: readonly string[] = ["Now", "Next", "Later"];
