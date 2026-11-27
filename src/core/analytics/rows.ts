/**
 * The analytics read's input: one workspace's issues and attempts as plain rows.
 *
 * Everything the metrics compute is a function of these rows, so the metrics module stays
 * pure (no database, no clock) and a hub is a list of these, one per workspace.
 *
 * ## Replicated data only
 *
 * Every field below is replicated: issue rows and attempt rows, and each attempt's effort is
 * read by `issueEffort` (`telemetry/effort.ts`), which reads the same rows on every device.
 * Nothing here reads the local event log, so two devices holding the same workspace draw the
 * same Analytics page. That is why cycle time is the replicated first-start-to-done span and
 * not the device-local elapsed partition (`wall`, `design/timing-semantics.md`).
 *
 * ## An attempt's end
 *
 * Not the stored `endedAt`: the effective end `issueEffort` reads from the attempt's replicated
 * evidence. An attempt with no end yet (still running, or orphaned and not yet closed) counts
 * through its last evidence, never to "now", and an attempt whose end was inferred from a steal
 * or a stale release is not shrunk to the stealing device's view.
 */
import type { DatabaseSync } from "node:sqlite";
import type { StatusCategory } from "../types.js";
import { attemptsOfIssue } from "../telemetry/attempt-records.js";
import { issueEffort } from "../telemetry/effort.js";

export interface AnalyticsIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  /** The status's category in the workspace vocabulary; null for a status it does not define. */
  readonly category: StatusCategory | null;
  readonly priority: string;
  readonly parentId: string | null;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly estimatedSeconds: number | null;
}

/** How an attempt stands, as the reliability figures count it. */
export type AttemptStanding = "completed" | "yielded" | "failed" | "interrupted" | "orphaned" | "open";

export interface AnalyticsAttempt {
  readonly id: string;
  readonly issueId: string;
  readonly agent: string;
  /** `worker` or `orchestrator`. */
  readonly role: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  /** The effective end (see the module comment). Never before `startedAt`. */
  readonly endAt: string;
  /** Agent work in the attempt: its span to `endAt` minus its pauses, whole seconds. */
  readonly effortSeconds: number;
  readonly standing: AttemptStanding;
  /** `recorded`, or `reconstructed` from history by `staple attempt reconstruct`. */
  readonly provenance: string;
}

export interface WorkspaceRows {
  readonly slug: string;
  readonly prefix: string;
  readonly issues: readonly AnalyticsIssue[];
  readonly attempts: readonly AnalyticsAttempt[];
}

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  category: string | null;
  priority: string;
  parent_id: string | null;
  labels: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  estimated_seconds: number | null;
}

function labelsOf(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((label): label is string => typeof label === "string") : [];
  } catch {
    return [];
  }
}

function standingOf(state: string, outcome: string | null, orphaned: boolean): AttemptStanding {
  if (state === "ended") {
    if (outcome === "completed" || outcome === "yielded" || outcome === "failed") return outcome;
    return "interrupted";
  }
  return orphaned ? "orphaned" : "open";
}

/** One workspace's analytics rows, read from its database. Read-only. */
export function readWorkspaceRows(db: DatabaseSync, workspace: { slug: string; prefix: string }): WorkspaceRows {
  const rows = db
    .prepare(
      `SELECT i.id, i.identifier, i.title, i.kind, i.status, s.category, i.priority, i.parent_id, i.labels,
              i.created_at, i.started_at, i.completed_at, i.cancelled_at, i.estimated_seconds
         FROM issues i LEFT JOIN workspace_statuses s ON s.id = i.status
        ORDER BY i.created_at, i.id`,
    )
    .all() as unknown as IssueRow[];
  const issues: AnalyticsIssue[] = rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    kind: row.kind,
    status: row.status,
    category: (row.category as StatusCategory | null) ?? null,
    priority: row.priority,
    parentId: row.parent_id,
    labels: labelsOf(row.labels),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    estimatedSeconds: row.estimated_seconds,
  }));

  const withAttempts = (db.prepare("SELECT DISTINCT issue_id AS id FROM attempts").all() as Array<{ id: string }>).map((row) => row.id);
  const attempts: AnalyticsAttempt[] = [];
  for (const issueId of withAttempts) {
    const records = new Map(attemptsOfIssue(db, issueId).map((record) => [record.id, record]));
    const effort = issueEffort(db, issueId);
    for (const lane of [effort.workers, effort.orchestrators]) {
      for (const read of lane.attempts) {
        const record = records.get(read.id);
        if (!record) continue;
        const end = read.end > read.startedAt ? read.end : read.startedAt;
        attempts.push({
          id: read.id,
          issueId,
          agent: record.agent,
          role: read.role,
          harness: record.harness?.name ?? null,
          model: record.harness?.model ?? null,
          startedAt: read.startedAt,
          endAt: end,
          effortSeconds: read.seconds,
          standing: standingOf(record.state, record.outcome, read.inputs.includes("orphan_provisional")),
          provenance: read.provenance,
        });
      }
    }
  }
  attempts.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
  return { slug: workspace.slug, prefix: workspace.prefix, issues, attempts };
}
