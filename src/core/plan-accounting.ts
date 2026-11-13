/**
 * What the plan counts (design/plan.md, "Accounting"): work items done, open and planned.
 *
 * A record's own units come from the first of these that applies: the ticket leaves under its own
 * work (it is promoted, or links issues present on this device); else nothing when it is an
 * *umbrella* over live sub-records, which carry its size (a parent's breakdown usually names its
 * sub-ideas, and counting both would count that work twice; its rows count once they are
 * tickets); else one planned unit per breakdown row; else nothing, and it is *unsized*. A
 * parent's rollup adds every non-dropped descendant's units.
 * A horizon's units are the ticket leaves under its members, counted as its milestone counts them,
 * plus the planned units of every non-dropped record it carries with no own work: those scheduled
 * on it, and the descendants of those that are not scheduled on a horizon themselves.
 *
 * Pure functions of their arguments: `PlanStore` gathers the facts once per state of the database
 * and every surface reads what it derives.
 */
import type { IdeaState } from "./plan-lifecycle-table.js";
import type { MilestoneProgress } from "./milestones.js";
import type { Stage } from "./plan.js";

/** What sizes a record: whether it has own work, its breakdown rows, and whether it holds live sub-records. */
export interface RecordSize {
  /** Its own work's ticket leaves, done and open; null when it has no own work present on this device. */
  work: { done: number; open: number } | null;
  rows: number;
  /** It has at least one sub-record that is not dropped. */
  liveSubRecords: boolean;
  /** The person marked it delivered outside the tracker. */
  delivered?: boolean;
}

export interface OwnUnits {
  done: number;
  open: number;
  planned: number;
  /** Nothing to count: no own work, no live sub-records and no rows. Never read as zero work. */
  unsized: boolean;
}

export interface Units {
  done: number;
  open: number;
  planned: number;
  total: number;
}

/**
 * A record's own units: its tickets' leaves, else none for an umbrella, else, delivered outside the
 * tracker, its rows (at least one) all done, else its rows as planned, else unsized.
 */
export function ownUnits(size: RecordSize): OwnUnits {
  if (size.work !== null) return { done: size.work.done, open: size.work.open, planned: 0, unsized: false };
  if (isUmbrella(size)) return { done: 0, open: 0, planned: 0, unsized: false };
  if (size.delivered) return { done: Math.max(size.rows, 1), open: 0, planned: 0, unsized: false };
  if (size.rows > 0) return { done: 0, open: 0, planned: size.rows, unsized: false };
  return { done: 0, open: 0, planned: 0, unsized: true };
}

/** An umbrella: no own work, over live sub-records that carry its size (its own rows count once they are tickets). */
export function isUmbrella(size: Pick<RecordSize, "work" | "liveSubRecords">): boolean {
  return size.work === null && size.liveSubRecords;
}

/**
 * Whether a record a horizon carries keeps it from shipping: it is not dropped, not shipped, and
 * not an umbrella (an umbrella holds a horizon through its sub-records, which the horizon carries
 * too unless they are scheduled on another one).
 */
export function holdsHorizon(stage: Stage, size: Pick<RecordSize, "work" | "liveSubRecords">): boolean {
  return stage !== "shipped" && stage !== "dropped" && !isUmbrella(size);
}

export function units(done: number, open: number, planned: number): Units {
  return { done, open, planned, total: done + open + planned };
}

/** done / total, null when there is nothing to count. */
export function unitProgress(counted: Units): number | null {
  return counted.total === 0 ? null : counted.done / counted.total;
}

/**
 * The one percentage every surface prints: whole percent, rounded down, from the counts (never
 * from a fraction, so 29 of 50 reads 58 everywhere); null when there is nothing to count.
 */
export function unitPercent(counted: Pick<Units, "done" | "total">): number | null {
  return counted.total === 0 ? null : Math.floor((counted.done * 100) / counted.total);
}

/** A percentage as the CLI prints it: a whole 100 that is not complete says so beside it. */
export function percentText(percent: number | null, complete: boolean): string {
  if (percent === null) return "—";
  return `${percent}%${percent === 100 && !complete ? " incomplete" : ""}`;
}

/** Non-dropped leaf records a horizon carries, by their own state, and the parents beside them. */
export interface RecordCounts {
  /** Every leaf record it carries: the five states below summed, what surfaces print. */
  leaves: number;
  shipped: number;
  started: number;
  shaped: number;
  exploring: number;
  /** A sub-idea not developed yet, carried through a scheduled parent. */
  raw: number;
  parentCount: number;
}

/** One non-dropped record a horizon carries, as the horizon's accounting reads it. */
export interface ScheduledRecord {
  state: IdeaState;
  /**
   * Its own units; own work counts among the members' ticket leaves, so only its planned units
   * add here, and its done ones when it was delivered outside the tracker (no ticket counts those).
   */
  own: OwnUnits;
  liveSubRecords: boolean;
  /** It keeps the horizon from shipping (`holdsHorizon`). */
  holds: boolean;
  /** The person marked it delivered outside the tracker: its done units are a third source. */
  delivered?: boolean;
}

export interface HorizonAccounting {
  units: Units;
  unsizedCount: number;
  records: RecordCounts;
  progress: number | null;
  /** `unitPercent` of the units. */
  percent: number | null;
  /** How many of its records keep it from shipping. */
  held: number;
  /** Done units of records delivered outside the tracker: counted by no member's leaf. */
  deliveredUnits: number;
  /** Something is counted, all of it is done and nothing holds it: what derives its milestone done. */
  complete: boolean;
}

/**
 * A horizon's units: `tickets` are the leaves under its members exactly as its milestone counts
 * them (each once, cancelled not counted), and each record it carries without own work adds its
 * planned rows. Records print as leaves; a parent is counted apart, never as one of its children.
 */
export function horizonAccounting(tickets: Pick<MilestoneProgress, "countable" | "counts">, records: readonly ScheduledRecord[]): HorizonAccounting {
  let planned = 0;
  let delivered = 0;
  let unsizedCount = 0;
  let held = 0;
  const counts: RecordCounts = { leaves: 0, shipped: 0, started: 0, shaped: 0, exploring: 0, raw: 0, parentCount: 0 };
  for (const record of records) {
    planned += record.own.planned;
    // Delivered outside the tracker: done units no member's leaf counts.
    if (record.delivered) delivered += record.own.done;
    if (record.own.unsized) unsizedCount += 1;
    if (record.holds) held += 1;
    if (record.liveSubRecords) counts.parentCount += 1;
    else if (record.state !== "dropped") {
      counts[record.state] += 1;
      counts.leaves += 1;
    }
  }
  const done = tickets.counts.done + delivered;
  const counted = units(done, tickets.countable - tickets.counts.done, planned);
  return {
    units: counted,
    unsizedCount,
    records: counts,
    progress: unitProgress(counted),
    percent: unitPercent(counted),
    held,
    deliveredUnits: delivered,
    complete: counted.total > 0 && counted.done === counted.total && held === 0,
  };
}

/**
 * The milestone view's progress for a horizon: the same units, with the planned ones in the
 * denominator and the unsized records named. Complete only when its milestone would derive done.
 */
export function withPlannedUnits(progress: MilestoneProgress, accounting: Pick<HorizonAccounting, "units" | "unsizedCount" | "percent" | "complete" | "deliveredUnits">): MilestoneProgress {
  return {
    ...progress,
    planned: accounting.units.planned,
    unsized: accounting.unsizedCount,
    delivered: accounting.deliveredUnits,
    percent: accounting.percent,
    complete: accounting.complete,
  };
}
