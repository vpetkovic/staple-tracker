/**
 * `staple cloud sync --all` — one run, N workspaces, N outcomes.
 *
 * Contract: STA-275 — *"A sync run reports per-workspace outcome rather than one
 * aggregate"* and *"A failure on one workspace does not abort the others"*.
 *
 * ## Partial failure is the normal case, not the exception
 *
 * With one workspace, a sync either worked or it did not, and one exit code is a
 * complete description. With twelve, "it failed" is almost never true and almost
 * never useful: the ordinary outcome is nine synced, two skipped because they
 * are not connected, and one `offline` because its endpoint is a company Worker
 * behind a VPN that is not up. An aggregate `sync failed` describes that state
 * so badly that it is worse than no output — it would send somebody looking for
 * a problem with the eleven workspaces that are fine.
 *
 * So every workspace produces its own row, always, and the run never throws on
 * behalf of one of them. The exit code is derived at the surface from
 * `failed > 0`, which is the only aggregation this design does and the only one
 * a shell can consume.
 *
 * ## Availability is checked BEFORE anything is opened
 *
 * `hub-scope.ts` explains at length why a fan-out must not reach for a missing
 * path, and the sync fan-out is the case where it matters most. `openWorkspace`
 * happens to refuse a path that is not there — it throws `not_found` before it
 * touches SQLite — so this is defence in depth rather than the only guard. But
 * the guard belongs here anyway: the OTHER door into a workspace, the one
 * `staple init` uses, calls `openDb()`, which **creates** the file. A future
 * refactor that reached for that door instead would have a `sync --all`
 * materialise an empty database for every unmounted volume and then hydrate each
 * one from a remote snapshot, silently. The check that stops it is one line, and
 * it is the difference between a skip and a data-shaped catastrophe.
 *
 * ## One database open at a time, and always closed
 *
 * Sequential, and each handle closed in a `finally` before the next is opened.
 * Twelve simultaneously-open SQLite handles across twelve projects is a
 * file-descriptor and WAL footprint nobody asked for, and the failure mode of
 * leaking one — a workspace that stays locked after a `sync --all` — is the kind
 * of thing that surfaces an hour later as "staple hangs".
 *
 * Concurrency would also defeat the point: twelve simultaneous pushes to one
 * Worker from one device meet the rate limiter, and being rate-limited is
 * reported as `offline`, so a concurrent fan-out would manufacture exactly the
 * failures this file exists to report accurately.
 */
import { openWorkspace } from "../open.js";
import { StapleError } from "../types.js";
import {
  describeSkip,
  listHubWorkspaces,
  skipReasonFor,
  type HubSkipReason,
  type HubWorkspace,
} from "./hub-scope.js";
import { cloudCodeOf } from "./client.js";
import { readConnection } from "./connection.js";
import { syncRepository, type SyncReport, type SyncOptions } from "./sync.js";

export interface HubSyncWorkspaceOutcome {
  slug: string;
  path: string;
  repositoryId: string | null;
  status: "synced" | "skipped" | "failed";
  /** A sentence, for every status. Never empty. */
  reason: string;
  /** Why it was not actionable, when that is why it was skipped. */
  skip: HubSkipReason | "disconnected" | null;
  /** The full single-workspace report. Null unless `synced`. */
  report: SyncReport | null;
  /** The staple error code, when this row failed. Null otherwise. */
  code: string | null;
  /**
   * The SERVICE's own code — `offline`, `revoked`, `rate_limited`,
   * `epoch_changed` — when the failure came from the wire. Null otherwise.
   *
   * The difference matters far more here than for one workspace. `client.ts`
   * folds every cloud code into staple's four-value space so that exit codes stay
   * coherent, and in that space `offline`, `rate_limited`, `unavailable` and
   * `conflict` are all `conflict`. A twelve-row table in which three failures all
   * read "conflict" is a table nobody can act on; one that says `offline`,
   * `offline`, `revoked` says exactly which two are a network problem and which
   * one needs a re-connect.
   */
  cloudCode: string | null;
}

export interface HubSyncOutcome {
  workspaces: HubSyncWorkspaceOutcome[];
  synced: number;
  skipped: number;
  failed: number;
  /** Operations pushed across every workspace that synced. */
  pushed: number;
  /** Remote operations applied across every workspace that synced. */
  pulled: number;
}

export interface HubSyncArgs extends Omit<SyncOptions, "home"> {
  home: string;
  /** Injected in tests. Replaces the hub enumeration. */
  workspaces?: readonly HubWorkspace[];
}

/**
 * Synchronize every connected workspace.
 *
 * A workspace with no connection record is **skipped, not failed**. Not being
 * connected is the default state of the whole product, and `openSession` throws
 * `not_found` for it with a message telling a human to connect — which is right
 * for `staple cloud sync` typed in one directory, and wrong here, where it would
 * turn "you have three repositories you have not connected" into three red
 * errors on every run. It is checked before `syncRepository` rather than caught
 * afterwards so that the distinction is a decision this function makes, not a
 * string it recognises.
 */
export async function syncAllWorkspaces(args: HubSyncArgs): Promise<HubSyncOutcome> {
  const workspaces = args.workspaces ?? listHubWorkspaces();
  const rows: HubSyncWorkspaceOutcome[] = [];

  for (const workspace of workspaces) {
    const skip = skipReasonFor(workspace);
    if (skip !== null) {
      rows.push({
        slug: workspace.slug,
        path: workspace.path,
        repositoryId: workspace.repositoryId,
        status: "skipped",
        reason: describeSkip(workspace, skip),
        skip,
        report: null,
        code: null,
        cloudCode: null,
      });
      continue;
    }

    const repositoryId = workspace.repositoryId as string;

    /**
     * Checked here, from the connection record, before a database is opened.
     *
     * Reading the record is three orders of magnitude cheaper than opening and
     * migrating a workspace, and on a machine where two of twelve repositories
     * are connected that is ten databases not opened per run.
     */
    let connected: boolean;
    try {
      connected = readConnection(args.home, repositoryId) !== null;
    } catch (error) {
      rows.push({
        slug: workspace.slug,
        path: workspace.path,
        repositoryId,
        status: "failed",
        reason: `This workspace's connection record could not be read: ${message(error)}`,
        skip: null,
        report: null,
        code: error instanceof StapleError ? error.code : "unknown",
        cloudCode: cloudCodeOf(error),
      });
      continue;
    }

    if (!connected) {
      rows.push({
        slug: workspace.slug,
        path: workspace.path,
        repositoryId,
        status: "skipped",
        reason:
          "Not connected on this machine, so there is nothing to synchronize with. " +
          "Connecting is a separate consent and a sync run does not get to spend it.",
        skip: "disconnected",
        report: null,
        code: null,
        cloudCode: null,
      });
      continue;
    }

    let report: SyncReport;
    let opened: ReturnType<typeof openWorkspace> | null = null;
    try {
      opened = openWorkspace(workspace.path);
      report = await syncRepository(opened.store.db, repositoryId, {
        home: args.home,
        pullLimit: args.pullLimit,
        attempts: args.attempts,
        sleep: args.sleep,
        fetchImpl: args.fetchImpl,
        timeoutMs: args.timeoutMs,
      });
    } catch (error) {
      /**
       * Every failure lands here and becomes a row. That includes the ones a
       * single-workspace sync treats as fatal — a copied home
       * (`assertOwnHost`), a schema too new to open, a repository id that
       * disagrees with `sync_state`. Each of those is a genuine refusal for the
       * workspace it is about and says nothing whatever about the other eleven,
       * so each is reported against its own row and stepped over.
       */
      rows.push({
        slug: workspace.slug,
        path: workspace.path,
        repositoryId,
        status: "failed",
        reason: message(error),
        skip: null,
        report: null,
        code: error instanceof StapleError ? error.code : "unknown",
        cloudCode: cloudCodeOf(error),
      });
      continue;
    } finally {
      // Closed before the next workspace is opened, on every path.
      opened?.store.db.close();
    }

    rows.push({
      slug: workspace.slug,
      path: workspace.path,
      repositoryId,
      status: "synced",
      reason: describeSyncRow(report),
      skip: null,
      report,
      code: null,
      cloudCode: null,
    });
  }

  const synced = rows.filter((row) => row.status === "synced");
  return {
    workspaces: rows,
    synced: synced.length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    failed: rows.filter((row) => row.status === "failed").length,
    pushed: synced.reduce((total, row) => total + (row.report?.pushed.applied ?? 0), 0),
    pulled: synced.reduce((total, row) => total + (row.report?.pulled.operations ?? 0), 0),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One clause per workspace, in the words the single-workspace report uses. */
function describeSyncRow(report: SyncReport): string {
  const parts: string[] = [];
  if (report.bootstrap) {
    parts.push(
      `${report.bootstrap.resumed ? "resumed" : "hydrated"} ${report.bootstrap.entities} entities`,
    );
  }
  parts.push(`pushed ${report.pushed.applied}`);
  parts.push(`applied ${report.pulled.operations}`);
  if (report.pending > 0) parts.push(`${report.pending} still pending`);
  if (report.conflicts > 0) parts.push(`${report.conflicts} unresolved conflicts`);
  return parts.join(", ");
}

/**
 * The run as a human reads it.
 *
 * Every workspace gets a line, including the skipped ones, and the totals come
 * last. A report that printed only the failures would be indistinguishable, on a
 * good day, from a command that had done nothing — and "did it run?" is the
 * question a fan-out most needs to answer without being asked.
 */
export function renderHubSyncOutcome(outcome: HubSyncOutcome): string {
  if (outcome.workspaces.length === 0) {
    return "No workspaces are registered on this machine, so nothing was synchronized.";
  }

  const lines: string[] = [];
  const width = Math.max(...outcome.workspaces.map((row) => row.slug.length), 9);
  for (const row of outcome.workspaces) {
    const mark = row.status === "synced" ? "ok" : row.status === "failed" ? "FAILED" : "skipped";
    lines.push(`  ${mark.padEnd(8)} ${row.slug.padEnd(width)}  ${row.reason}`);
  }

  lines.push("");
  lines.push(
    `  ${outcome.synced} synchronized, ${outcome.skipped} skipped, ${outcome.failed} failed` +
      (outcome.synced > 0 ? ` — ${outcome.pushed} pushed, ${outcome.pulled} applied` : ""),
  );
  if (outcome.failed > 0) {
    lines.push("");
    lines.push(
      "Each workspace above was synchronized independently; a failure on one did not stop the " +
        "others. Re-running retries only what is still behind.",
    );
  }
  return lines.join("\n");
}
