/**
 * The plan layer: the pure half of `design/plan.md`.
 *
 * An idea is an issue of the reserved kind `idea`, above the tracker: never queued, never
 * checked out, never picked by `next`, never counted by a non-plan parent's derived status
 * and never listed in a task view unless asked for. It holds no ticket number: its identifier
 * is a draft form until it is promoted in place into an epic, which is the way in, beside
 * Adopt (link an existing issue). A horizon is a milestone the plan shows as a column.
 *
 * Everything here is a type or a function of its arguments: no store, no database, no clock.
 */
import { StapleError } from "./types.js";

export const IDEA_KIND = "idea";
/** The kind a horizon is: a milestone with a plan rank. */
export const HORIZON_MILESTONE_KIND = "milestone";
/** The kind a promoted idea becomes, when the workspace has it. */
export const PROMOTED_KIND = "epic";
/** Kinds the tracker keeps out of its work: only an unpromoted idea. */
export const PLAN_KINDS: ReadonlySet<string> = new Set([IDEA_KIND]);

export function isPlanKind(kind: string | null | undefined): boolean {
  return typeof kind === "string" && PLAN_KINDS.has(kind);
}

// ---------- the draft identifier ----------

const DRAFT_PREFIX = "~";

/**
 * An unpromoted idea's identifier: `~` and its UUID's hex. Unique because the UUID is; never
 * `PREFIX-n`, so nothing parses it as a ticket ref, resolves a typed ref to it, or advances the
 * ticket counter past it; and never shown.
 */
export function draftIdentifier(issueId: string): string {
  return `${DRAFT_PREFIX}${issueId.replace(/-/g, "").toLowerCase()}`;
}

export function isDraftIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === "string" && identifier.startsWith(DRAFT_PREFIX);
}

// ---------- what a surface shows instead of a draft identifier ----------

const DRAFT_IN_TEXT = /~([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})(?![0-9a-f])/g;

/**
 * Text with every draft identifier in it written as its idea's id, which is how the CLI, the MCP
 * tools and the page refer to an idea before it has a number. The draft is the id's own hex, so
 * nothing needs looking up.
 */
export function draftsAsIds(text: string): string {
  return text.includes("~") ? text.replace(DRAFT_IN_TEXT, "$1-$2-$3-$4-$5") : text;
}

/**
 * A `JSON.stringify` replacer for everything a surface sends: an object whose `identifier` is a
 * draft goes out with `identifier: null` and `draft: true`, the shape `IdeaView` has, and a draft
 * anywhere else (a parent's ref, a message) goes out as the idea's id.
 */
export function hideDraftIdentifiers(key: string, value: unknown): unknown {
  if (typeof value === "string") return key === "identifier" && isDraftIdentifier(value) ? null : draftsAsIds(value);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const identifier = (value as { identifier?: unknown }).identifier;
    if (typeof identifier === "string" && isDraftIdentifier(identifier)) return { ...(value as Record<string, unknown>), identifier: null, draft: true };
  }
  return value;
}

/** A value as a surface sends it (`hideDraftIdentifiers`), still a value. */
export function publicValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value, hideDraftIdentifiers)) as T;
}

/**
 * One line of output as a surface prints it. A JSON document keeps its shape and its layout,
 * with drafts hidden as `hideDraftIdentifiers` hides them; any other text names an idea by its id.
 */
export function publicOutput(text: string): string {
  if (!text.includes("~")) return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const indented = /^[[{]\n( +)/.exec(trimmed)?.[1]?.length;
      return JSON.stringify(JSON.parse(text), hideDraftIdentifiers, indented);
    } catch {
      /* not one JSON document: text like any other */
    }
  }
  return draftsAsIds(text);
}

/** How a message names an issue: its ticket number, or the idea's title while it has none. */
export function displayRef(row: { identifier: string; title?: string | null }): string {
  return isDraftIdentifier(row.identifier) ? `the idea "${row.title ?? "untitled"}"` : row.identifier;
}

/** A kind named in a sentence, with its article: "an epic", "a task". */
export function aKind(kind: string): string {
  return `${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind}`;
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
  /** Links whose issue this device no longer holds: still links, judged by nothing. */
  missingLinks?: number;
}

/**
 * Shipped is judged on the linked work that is here; a link whose issue is gone keeps the idea
 * started rather than letting it slip back to a maturity it had already left.
 */
export function deriveStage(input: StageInputs): Stage {
  const present = input.links - (input.missingLinks ?? 0);
  if (input.links > 0) return present > 0 && input.resolvedLinks >= present ? "shipped" : "started";
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
 * Late is about linked work only: it landed, or is forecast to land, after the earlier of the
 * planned target and the horizon's date, or that day has passed while it is still open. An
 * idea with nothing linked is never late; see {@link isNotStarted}.
 */
export function isLate(input: {
  plannedTarget: string | null;
  horizonDate: string | null;
  actual: ActualWindow;
  /** Linked issues, own and rolled up. */
  links: number;
  /** Not shipped and not dropped. */
  open: boolean;
  today: string;
}): boolean {
  if (input.links === 0) return false;
  const lines = [input.plannedTarget, input.horizonDate].filter((day): day is string => day !== null);
  if (lines.length === 0) return false;
  const line = lines.reduce((a, b) => (a < b ? a : b));
  const landing = input.actual.end ?? input.actual.forecastEnd;
  if (landing !== null && landing > line) return true;
  return input.open && input.today > line;
}

/** Not started: nothing is linked yet, and the planned start has passed. */
export function isNotStarted(input: { plannedStart: string | null; links: number; dropped: boolean; today: string }): boolean {
  return !input.dropped && input.links === 0 && input.plannedStart !== null && input.today > input.plannedStart;
}

// ---------- guards ----------

export const PLAN_KINDS_MISSING_MESSAGE =
  "Planning is not turned on in this workspace. Run `staple plan enable` (it adds the `idea` and `milestone` kinds and the horizons Now, Next and Later).";

/** The one sentence every tracker door gives an unpromoted idea. */
export function planKindRefusal(issue: { identifier: string; kind: string; title?: string | null }, action: string): StapleError {
  const name = displayRef(issue);
  return new StapleError(
    "validation",
    `${name.charAt(0).toUpperCase()}${name.slice(1)} is an idea; it cannot be ${action}. An idea reaches the tracker when the person promotes it, or when work is adopted onto it.`,
    { kind: issue.kind },
  );
}

/**
 * The parent rule. An idea's parent is a plan record (an idea, or one already promoted) or
 * nothing; tracker work never sits under an unpromoted idea.
 */
export function assertPlanParent(
  child: { kind: string },
  parent: { kind: string; identifier: string; title?: string | null; planRecord?: boolean } | null,
): void {
  if (parent === null) return;
  if (child.kind === IDEA_KIND && parent.kind !== IDEA_KIND && parent.planRecord !== true) {
    throw new StapleError("validation", `An idea's parent must be another idea; ${displayRef(parent)} is ${aKind(parent.kind)}.`);
  }
  if (!isPlanKind(child.kind) && isPlanKind(parent.kind)) {
    throw new StapleError(
      "validation",
      `${displayRef(parent)} is an idea; tracker work cannot be filed under it. Adopt the work onto the idea instead (staple idea adopt <idea> <ref>).`,
    );
  }
}

/** Re-declaring a kind across the plan boundary is refused in both directions. */
/**
 * Re-declaring a kind across the plan boundary is refused in both directions through the
 * tracker's own update: an idea becomes tracker work only by promotion, which the plan does.
 */
export function assertPlanRekind(row: { identifier: string; kind: string; title?: string | null }, nextKind: string): void {
  if (row.kind === nextKind) return;
  if (isPlanKind(row.kind) || isPlanKind(nextKind)) {
    throw new StapleError(
      "validation",
      `${displayRef(row)} cannot change kind from ${row.kind} to ${nextKind} here: an idea stays above the tracker until the person promotes it (staple idea promote), and tracker work becomes part of a plan by being adopted onto an idea.`,
      { kind: row.kind, nextKind },
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
  | "status"
  | "maturity"
  | "horizon"
  | "parent"
  | "planned dates"
  | "baseline"
  | "horizons"
  | "promote";

/** `subject` is how the message names the record (`displayRef`), never a draft identifier. */
export function steeringRefusal(what: SteeringWrite, subject: string | null): StapleError {
  const name = subject ?? "the plan";
  const Name = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const message =
    what === "promote"
      ? `${Name} is not shaped yet; an agent may promote only an idea the person has marked shaped. Capture questions or decisions on it instead, or ask the person to shape it.`
      : what === "status"
        ? `${Name} is an idea; its status does not move. Its maturity is its state, and the person sets it, or drops the idea, in the Plan view (or the CLI with --person). Promote it, or adopt work onto it, to track progress.`
        : `Changing ${what === "horizons" ? "horizons" : `the ${what} of ${name}`} is the person's call, not an agent's. ` +
          "Agents capture ideas, edit titles and briefs, add questions and decisions, and adopt or unlink work; " +
          "the person sets maturity, horizons, dates and the baseline in the Plan view (or the CLI with --person).";
  return new StapleError("validation", message, { steering: what });
}

/** Default horizons for `staple plan enable`, in order. */
export const DEFAULT_HORIZONS: readonly string[] = ["Now", "Next", "Later"];
