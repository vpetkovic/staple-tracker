/**
 * `staple budget collect`: ingest the Codex rollouts that are new or have grown since the
 * last run, under every bound Codex home's `sessions/` tree.
 *
 * A cursor in the staple home (`telemetry/codex-cursor.json`) keeps each file's size and
 * mtime as of the last successful ingestion, so a run stats every rollout but opens only
 * the ones that changed. Replays are already safe (`BudgetStore.record` dedups), so the
 * cursor is an economy, not a correctness device: losing it re-reads everything once and
 * stores nothing twice.
 *
 * A grown file is read from where the last read stopped (`completeBytes`), not from the
 * start, when that is safe: its first bytes are unchanged (a hash of the head) and the
 * last read saw the end of any leading run of fork copies, so no copy test needs the
 * lines before it. Otherwise (a fork still inside its copied history, a rewritten file,
 * a cursor from before this was recorded) the whole file is read again.
 *
 * A run is bounded: at most `maxFiles` rollouts, newest first, so the session that is
 * running now is read on every run and a large backlog drains over several. A file that
 * fails keeps its old cursor and is retried next run. Each run appends one summary line
 * to `logs/budget-collect.log`, which is rotated at {@link LOG_MAX_BYTES}.
 *
 * One run at a time: the launch agent, a hand-run collect and the UI route share a lock
 * file (`telemetry/collect.lock`). A second run finds it held and returns `locked`,
 * reading nothing. A lock whose process is gone, or older than {@link LOCK_STALE_MS},
 * is taken over.
 *
 * Local only: stat, read and hub.db. No network call.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { readConfig } from "../../../config/file.js";
import { expandHomePath } from "../bindings.js";
import { isKnownBinding } from "../config.js";
import { ingestBudget, type AttemptLinker } from "../ingest.js";
import type { SessionMeta } from "../sources/codex-rollout.js";

export const DEFAULT_MAX_FILES = 100;
export const LOG_MAX_BYTES = 256 * 1024;
/** How many per-file errors a run's summary keeps. */
const ERRORS_KEPT = 10;

/** How many leading bytes identify a rollout's head for a tail read. */
export const HEAD_BYTES = 4096;
/** A collect lock older than this is taken over whatever its process says. */
export const LOCK_STALE_MS = 15 * 60 * 1000;

export interface CursorEntry {
  readonly size: number;
  readonly mtimeMs: number;
  /** Where the last read stopped: bytes through its last complete line. */
  readonly completeBytes?: number;
  /** sha256 of the first `headLength` bytes when last read. */
  readonly head?: string;
  readonly headLength?: number;
  readonly meta?: SessionMeta | null;
  /** The last read saw the end of any leading fork-copy run, so a tail read is safe. */
  readonly leadingRunEnded?: boolean;
}

export interface CollectRunSummary {
  readonly at: string;
  readonly ok: boolean;
  /** Why nothing was read, when nothing could be. */
  readonly skippedReason: "capture_disabled" | "no_codex_binding" | "locked" | null;
  readonly scanned: number;
  readonly changed: number;
  readonly ingested: number;
  readonly deferred: number;
  readonly storedCount: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly message: string }>;
}

export interface CodexCursor {
  readonly version: 1;
  readonly files: Readonly<Record<string, CursorEntry>>;
  readonly lastRun: CollectRunSummary | null;
  /** The last run that had an error, kept until a later run is clean. */
  readonly lastError: { readonly at: string; readonly message: string } | null;
}

export interface CollectFileResult {
  readonly file: string;
  readonly accountRef: string | null;
  readonly storedCount: number;
  readonly skipped: Record<string, number>;
  readonly error: string | null;
  /** `tail`: only the lines after the previous read; `full`: the whole file. */
  readonly mode: "full" | "tail";
}

export interface CollectResult extends CollectRunSummary {
  readonly homes: ReadonlyArray<{ readonly home: string; readonly sessionsDir: string; readonly accountRef: string; readonly present: boolean }>;
  readonly files: readonly CollectFileResult[];
  readonly cursorPath: string;
  readonly logPath: string;
}

export function cursorPath(home: string): string {
  return join(home, "telemetry", "codex-cursor.json");
}

export function collectLogPath(home: string): string {
  return join(home, "logs", "budget-collect.log");
}

export function readCursor(home: string): CodexCursor {
  const empty: CodexCursor = { version: 1, files: {}, lastRun: null, lastError: null };
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(home), "utf8")) as Partial<CodexCursor>;
    if (parsed?.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) return empty;
    return { version: 1, files: parsed.files, lastRun: parsed.lastRun ?? null, lastError: parsed.lastError ?? null };
  } catch {
    // Absent or damaged: start over. Every rollout is read once more and nothing is stored twice.
    return empty;
  }
}

/** Keep a log file bounded: past `max` bytes it becomes `<file>.1`, replacing the older one. */
export function rotateLog(path: string, max = LOG_MAX_BYTES): void {
  try {
    if (statSync(path).size > max) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
}

function listRollouts(sessionsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(path);
    }
  };
  walk(sessionsDir);
  return out;
}

export interface CollectOptions {
  readonly maxFiles?: number;
  readonly now?: () => string;
  readonly attemptLinker?: AttemptLinker;
  /** Extra log files to keep bounded (the launch agent's own stdout log). */
  readonly rotate?: readonly string[];
}

export function lockPath(home: string): string {
  return join(home, "telemetry", "collect.lock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the collect lock, or return false when a live run holds it. */
function acquireLock(home: string, nowMs: number): boolean {
  const path = lockPath(home);
  mkdirSync(join(home, "telemetry"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(nowMs).toISOString() }));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: { pid?: number; at?: string } = {};
    try {
      holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; at?: string };
    } catch {
      // Unreadable: a crash mid-write. Treated as stale.
    }
    const age = holder.at === undefined ? Number.POSITIVE_INFINITY : nowMs - Date.parse(holder.at);
    const live = typeof holder.pid === "number" && processAlive(holder.pid) && age < LOCK_STALE_MS;
    if (live) return false;
    rmSync(path, { force: true });
  }
  return false;
}

function headOf(path: string, length: number): string {
  const bytes = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, bytes, read, length - read, read);
      if (n === 0) break;
      read += n;
    }
    return createHash("sha256").update(bytes.subarray(0, read)).digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Where a tail read of a grown file may start, or null when the whole file must be read. */
function resumePoint(path: string, previous: CursorEntry | undefined, size: number): { offset: number; meta: SessionMeta | null } | null {
  if (previous === undefined || previous.leadingRunEnded !== true || previous.completeBytes === undefined) return null;
  if (previous.head === undefined || previous.headLength === undefined || previous.meta === undefined) return null;
  if (size < previous.completeBytes) return null; // truncated or replaced
  if (headOf(path, previous.headLength) !== previous.head) return null; // rewritten
  return { offset: previous.completeBytes, meta: previous.meta };
}

export function collectCodexRollouts(home: string, options: CollectOptions = {}): CollectResult {
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();
  if (!acquireLock(home, Date.now())) {
    const summary: CollectRunSummary = { at, ok: false, skippedReason: "locked", scanned: 0, changed: 0, ingested: 0, deferred: 0, storedCount: 0, errors: [] };
    const logPath = collectLogPath(home);
    mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
    rotateLog(logPath);
    appendFileSync(logPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    return { ...summary, homes: [], files: [], cursorPath: cursorPath(home), logPath };
  }
  try {
    return collectLocked(home, options, now, at);
  } finally {
    rmSync(lockPath(home), { force: true });
  }
}

function collectLocked(home: string, options: CollectOptions, now: () => string, at: string): CollectResult {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const telemetry = readConfig(home).config.telemetry;
  const cursor = readCursor(home);
  const homes = telemetry.bindings
    .filter(isKnownBinding)
    .flatMap((binding) => (binding.source === "codex_rollout" ? [binding] : []))
    .map((binding) => {
      const codexHome = expandHomePath(binding.home);
      const sessionsDir = join(codexHome, "sessions");
      return { home: codexHome, sessionsDir, accountRef: binding.accountRef, present: existsSync(sessionsDir) };
    });

  const files: CollectFileResult[] = [];
  const nextFiles: Record<string, CursorEntry> = { ...cursor.files };
  let scanned = 0;
  let changed = 0;
  let skippedReason: CollectRunSummary["skippedReason"] = null;
  if (!telemetry.budgetCapture) skippedReason = "capture_disabled";
  else if (homes.length === 0) skippedReason = "no_codex_binding";
  else {
    const seen = new Set<string>();
    const candidates: Array<{ path: string; entry: CursorEntry }> = [];
    for (const codex of homes) {
      if (!codex.present) continue;
      for (const path of listRollouts(codex.sessionsDir)) {
        if (seen.has(path)) continue;
        seen.add(path);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        scanned += 1;
        const entry = { size: stat.size, mtimeMs: stat.mtimeMs };
        const previous = cursor.files[path];
        if (previous !== undefined && previous.size === entry.size && previous.mtimeMs === entry.mtimeMs) continue;
        candidates.push({ path, entry });
      }
      // Forget rollouts that are gone, so the cursor does not grow without bound.
      for (const path of Object.keys(nextFiles)) {
        if (path.startsWith(`${codex.sessionsDir}${sep}`) && !seen.has(path)) delete nextFiles[path];
      }
    }
    changed = candidates.length;
    candidates.sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs || a.path.localeCompare(b.path));
    for (const candidate of candidates.slice(0, maxFiles)) {
      let mode: "full" | "tail" = "full";
      try {
        const from = resumePoint(candidate.path, cursor.files[candidate.path], candidate.entry.size);
        mode = from === null ? "full" : "tail";
        let scan: { meta: SessionMeta | null; completeBytes: number; leadingRunEnded: boolean } | null = null;
        const result = ingestBudget(
          { source: "codex-rollout", file: candidate.path, rolloutFrom: from ?? undefined },
          { home, now, attemptLinker: options.attemptLinker, onRolloutScan: (found) => (scan = found) },
        );
        const found = scan as { meta: SessionMeta | null; completeBytes: number; leadingRunEnded: boolean } | null;
        const headLength = Math.min(HEAD_BYTES, found?.completeBytes ?? 0);
        // The size and mtime from BEFORE the read: a line appended while it was read makes
        // the file look grown next run, and it is read again from where this read stopped.
        nextFiles[candidate.path] = {
          ...candidate.entry,
          ...(found !== null
            ? { completeBytes: found.completeBytes, head: headOf(candidate.path, headLength), headLength, meta: found.meta, leadingRunEnded: found.leadingRunEnded }
            : {}),
        };
        files.push({ file: candidate.path, accountRef: result.accountRef, storedCount: result.storedCount, skipped: result.skipped, error: null, mode });
      } catch (error) {
        files.push({ file: candidate.path, accountRef: null, storedCount: 0, skipped: {}, error: (error as Error).message, mode });
      }
    }
  }

  const errors = files.filter((file) => file.error !== null).map((file) => ({ file: file.file, message: file.error! }));
  const summary: CollectRunSummary = {
    at,
    ok: errors.length === 0 && skippedReason === null,
    skippedReason,
    scanned,
    changed,
    ingested: files.length - errors.length,
    deferred: Math.max(0, changed - files.length),
    storedCount: files.reduce((sum, file) => sum + file.storedCount, 0),
    errors: errors.slice(0, ERRORS_KEPT),
  };
  const lastError =
    errors.length > 0
      ? { at, message: `${errors.length} rollout(s) failed; first: ${errors[0]!.file}: ${errors[0]!.message}` }
      : skippedReason === "capture_disabled"
        ? { at, message: "budget capture is off; nothing was read" }
        : skippedReason === "no_codex_binding"
          ? { at, message: "no codex-rollout binding; nothing to read" }
          : null;
  const next: CodexCursor = { version: 1, files: nextFiles, lastRun: summary, lastError };
  mkdirSync(join(home, "telemetry"), { recursive: true, mode: 0o700 });
  writeFileAtomic(cursorPath(home), `${JSON.stringify(next)}\n`, { mode: 0o600 });

  const logPath = collectLogPath(home);
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  for (const path of [logPath, ...(options.rotate ?? [])]) rotateLog(path);
  appendFileSync(logPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });

  return { ...summary, homes, files, cursorPath: cursorPath(home), logPath };
}
