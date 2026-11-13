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
 * plus the planned units of every scheduled, non-dropped record with no own work.
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

/** A record's own units: its tickets' leaves, else none for an umbrella, else its rows as planned, else unsized. */
export function ownUnits(size: RecordSize): OwnUnits {
  if (size.work !== null) return { done: size.work.done, open: size.work.open, planned: 0, unsized: false };
  if (isUmbrella(size)) return { done: 0, open: 0, planned: 0, unsized: false };
  if (size.rows > 0) return { done: 0, open: 0, planned: size.rows, unsized: false };
  return { done: 0, open: 0, planned: 0, unsized: true };
}

/** An umbrella: no own work, over live sub-records that carry its size (its own rows count once they are tickets). */
export function isUmbrella(size: Pick<RecordSize, "work" | "liveSubRecords">): boolean {
  return size.work === null && size.liveSubRecords;
}

/**
 * Whether a record scheduled on a horizon keeps it from shipping: it is not dropped, not shipped,
 * and not an umbrella (an umbrella holds a horizon through its sub-records, where they are scheduled).
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

/** Scheduled, non-dropped leaf records by their own state, and the parents beside them. */
export interface RecordCounts {
  /** Every scheduled, non-dropped leaf record: the four states below summed, what surfaces print. */
  leaves: number;
  shipped: number;
  started: number;
  shaped: number;
  exploring: number;
  parentCount: number;
}

/** One scheduled, non-dropped record on a horizon, as the horizon's accounting reads it. */
export interface ScheduledRecord {
  state: IdeaState;
  /** Its own units; own work counts among the members' ticket leaves, so only its planned units add here. */
  own: OwnUnits;
  liveSubRecords: boolean;
}

export interface HorizonAccounting {
  units: Units;
  unsizedCount: number;
  records: RecordCounts;
  progress: number | null;
}

/**
 * A horizon's units: `tickets` are the leaves under its members exactly as its milestone counts
 * them (each once, cancelled not counted), and each scheduled record without own work adds its
 * planned rows. Records print as leaves; a parent is counted apart, never as one of its children.
 */
export function horizonAccounting(tickets: Pick<MilestoneProgress, "countable" | "counts">, records: readonly ScheduledRecord[]): HorizonAccounting {
  let planned = 0;
  let unsizedCount = 0;
  const counts: RecordCounts = { leaves: 0, shipped: 0, started: 0, shaped: 0, exploring: 0, parentCount: 0 };
  for (const record of records) {
    planned += record.own.planned;
    if (record.own.unsized) unsizedCount += 1;
    if (record.liveSubRecords) counts.parentCount += 1;
    else if (record.state === "shipped" || record.state === "started" || record.state === "shaped" || record.state === "exploring") {
      counts[record.state] += 1;
      counts.leaves += 1;
    }
  }
  const done = tickets.counts.done;
  const counted = units(done, tickets.countable - done, planned);
  return { units: counted, unsizedCount, records: counts, progress: unitProgress(counted) };
}

/**
 * The milestone view's progress for a horizon: the same units, with the planned ones in the
 * denominator and the unsized records named. Complete only when nothing is open, planned or unsized.
 */
export function withPlannedUnits(progress: MilestoneProgress, accounting: Pick<HorizonAccounting, "units" | "unsizedCount">): MilestoneProgress {
  const { done, total, planned } = accounting.units;
  return {
    ...progress,
    planned,
    unsized: accounting.unsizedCount,
    percent: total === 0 ? null : Math.floor((done * 100) / total),
    complete: total > 0 && done === total && accounting.unsizedCount === 0,
  };
}
