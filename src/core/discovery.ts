/**
 * Bounded workspace discovery — STA-24 plan §4.
 *
 * > `staple discover <root>`:
 * > - Traverses only beneath the canonical root supplied by the user.
 * > - Finds existing `.staple/staple.db` and legacy `.tasks/tasks.db`
 * >   workspaces. It does not initialize every Git repository it sees.
 * > - Does not follow directory symlinks by default and does not cross
 * >   filesystem boundaries unless requested.
 * > - Skips common generated directories and reports unreadable directories
 * >   without failing the full scan.
 * > - Prints candidates, current registration state, legacy status, and
 * >   conflicts before any write.
 * > - Registers only selected candidates.
 * >
 * > This design needs ordinary read access only to the chosen root. If the
 * > operating system denies a protected directory, report the path and continue.
 * > Do not request broad disk access and do not scan the user's home implicitly.
 *
 * This module does the FINDING and the CLASSIFYING. It registers nothing and
 * opens no database for writing — `commands/discover.ts` owns the consent, and
 * `core/hub-repair.ts` owns the registration. A scanner that could also write
 * would make "preview performs no registrations" a matter of discipline rather
 * than of structure.
 *
 * ## The root boundary, and why it is a realpath
 *
 * "Traverses only beneath the canonical root" cannot be enforced against a
 * string prefix: `root/link -> /` makes every path on the machine look like it
 * is beneath the root. So the root is realpath'd once, every directory is
 * realpath'd before it is entered, and anything whose realpath is not under the
 * canonical root is refused. That, plus a visited set, is also the symlink-loop
 * guard the plan's edge-case table asks for ("Canonicalize paths, skip symlinks
 * by default, track visited directories, report denied paths").
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describeLayout, journalPathFor, normalizePath, type MigrationJournal } from "./path-migration.js";
import { existsSync } from "node:fs";
import { readMeta } from "./open.js";
import { WorkspaceStore } from "./store.js";
import { DatabaseSync } from "node:sqlite";
import { StapleError } from "./types.js";

/**
 * Directories a scan never enters.
 *
 * Two rules, not a blocklist that has to keep up with every toolchain:
 *
 *   1. Anything starting with `.` — which covers `.git`, `.cache`, `.venv`, and
 *      also `.staple`/`.tasks` themselves. Staple's own directories are DETECTED
 *      from their parent (that is what `describeLayout` does) and never entered,
 *      so nothing is lost by skipping them wholesale. A workspace hidden inside
 *      a dot-directory is not a case worth walking every `.git` object store for.
 *   2. The named set below, which is the "common generated directories" the plan
 *      asks for: big, deep, and guaranteed not to contain a repository somebody
 *      is tracking work in.
 */
export const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "venv",
  "__pycache__",
  "Library",
  "Applications",
  "System",
]);

/** How deep beneath the root a scan goes before it stops and says so. */
export const DEFAULT_MAX_DEPTH = 6;

export interface ScanOptions {
  root: string;
  /** Levels below the root. Default {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
  /** Plan: "Does not follow directory symlinks by default". */
  followSymlinks?: boolean;
  /** Plan: "does not cross filesystem boundaries unless requested". */
  crossFilesystems?: boolean;
}

/** One directory that holds staple state. */
export interface RawCandidate {
  /** The directory containing `.staple/` or `.tasks/`. */
  dir: string;
  /** The database to register, or null when the directory is ambiguous. */
  dbPath: string | null;
  layout: "current" | "legacy" | null;
  /** Two canonical databases whose histories may have diverged. */
  ambiguous: boolean;
  /** The two paths are one file (a symlinked `.staple`), not a fork. */
  aliased: boolean;
  /** A crashed or in-flight migration found here. */
  journalState: MigrationJournal["state"] | null;
  slug: string | null;
  prefix: string | null;
  /** Set when the database could not be read for its identity. */
  readError: string | null;
}

export interface ScanReport {
  /** The canonical root, after realpath. */
  root: string;
  candidates: RawCandidate[];
  /** Directories the operating system would not let us read. Plan: report and continue. */
  denied: Array<{ path: string; reason: string }>;
  /** Directories deliberately not entered, with why. */
  skipped: Array<{ path: string; reason: "symlink" | "other-filesystem" | "generated" | "outside-root" | "visited" }>;
  /** How many directories were actually read. */
  scannedDirs: number;
  /** True when the depth limit stopped the walk somewhere. */
  truncated: boolean;
  maxDepth: number;
}

function identityOf(dbPath: string): { slug: string | null; prefix: string | null; readError: string | null } {
  try {
    // Read-only: discovery must not convert a stranger's database to WAL, and
    // must not migrate one. A candidate is something to REPORT, not to touch.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const probe = new WorkspaceStore(db, "", "");
      return { slug: readMeta(probe, "slug"), prefix: readMeta(probe, "prefix"), readError: null };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      slug: null,
      prefix: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True when `path` is the canonical root or genuinely beneath it. */
function withinRoot(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

/**
 * Walk beneath one explicit root and report every staple workspace under it.
 *
 * Never throws for anything the filesystem does — a denied directory, a broken
 * symlink and an unreadable database are all RESULTS. Plan §4: "If the operating
 * system denies a protected directory, report the path and continue."
 */
export function scanForWorkspaces(options: ScanOptions): ScanReport {
  const requested = resolve(options.root);
  if (!existsSync(requested)) {
    throw new StapleError("not_found", `No such directory: ${requested}`);
  }
  let root: string;
  try {
    root = realpathSync.native(requested);
    if (!statSync(root).isDirectory()) {
      throw new StapleError("validation", `${requested} is not a directory.`);
    }
  } catch (error) {
    if (error instanceof StapleError) throw error;
    throw new StapleError("validation", `${requested} cannot be scanned: ${(error as Error).message}`);
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rootDevice = statSync(root).dev;

  const report: ScanReport = {
    root,
    candidates: [],
    denied: [],
    skipped: [],
    scannedDirs: 0,
    truncated: false,
    maxDepth,
  };

  // Realpaths already entered. This is the symlink-loop guard AND the guard
  // against visiting one directory twice through two hard-linked routes.
  const visited = new Set<string>([root]);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    report.scannedDirs += 1;

    /**
     * Detection happens for EVERY directory, including the root and including
     * directories that also contain other workspaces.
     *
     * A5's handoff: "a walked-up resolution is per-directory: a migrated repo
     * nested inside an unmigrated one is its own workspace, so a scan must not
     * collapse them." So finding a workspace here is not a reason to stop
     * descending.
     */
    const layout = describeLayout(dir);
    const journalPresent = existsSync(journalPathFor(dir));
    if (layout.currentPresent || layout.legacyPresent || journalPresent) {
      const dbPath = layout.ambiguous
        ? null
        : layout.layout === "current"
          ? layout.currentPath
          : layout.layout === "legacy"
            ? layout.legacyPath
            : null;
      const identity = dbPath
        ? identityOf(dbPath)
        : { slug: null, prefix: null, readError: null };
      report.candidates.push({
        dir,
        dbPath,
        layout: layout.layout,
        ambiguous: layout.ambiguous,
        aliased: layout.aliased,
        journalState: layout.journal?.state ?? null,
        ...identity,
      });
    }

    if (depth >= maxDepth) {
      report.truncated = true;
      continue;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      report.denied.push({ path: dir, reason: (error as NodeJS.ErrnoException).code ?? String(error) });
      continue;
    }

    for (const entry of entries) {
      const child = join(dir, entry.name);

      // Rule 1: dot-directories, including staple's own. See the header on
      // SKIPPED_DIRECTORY_NAMES for why nothing is lost.
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
        if (entry.isDirectory()) report.skipped.push({ path: child, reason: "generated" });
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          report.skipped.push({ path: child, reason: "symlink" });
          continue;
        }
      } else if (!entry.isDirectory()) {
        continue;
      }

      // Everything below needs to know what the entry REALLY is. A broken
      // symlink, a socket, or a device node all land in the catch and are
      // simply not descended into.
      let real: string;
      let stats;
      try {
        real = realpathSync.native(child);
        stats = statSync(real);
      } catch (error) {
        report.denied.push({ path: child, reason: (error as NodeJS.ErrnoException).code ?? String(error) });
        continue;
      }
      if (!stats.isDirectory()) continue;

      // The root boundary, enforced on the REALPATH. A symlink pointing out of
      // the root is the whole reason this is not a string-prefix check.
      if (!withinRoot(root, real)) {
        report.skipped.push({ path: child, reason: "outside-root" });
        continue;
      }
      if (!options.crossFilesystems && stats.dev !== rootDevice) {
        report.skipped.push({ path: child, reason: "other-filesystem" });
        continue;
      }
      if (visited.has(real)) {
        report.skipped.push({ path: child, reason: "visited" });
        continue;
      }
      visited.add(real);
      queue.push({ dir: real, depth: depth + 1 });
    }
  }

  report.candidates.sort((a, b) => a.dir.localeCompare(b.dir));
  return report;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type CandidateState =
  | "registered" // the hub already points here
  | "moved" // registered under this slug, at a different path
  | "unregistered" // a workspace the hub has never seen
  | "prefix-conflict" // its prefix belongs to another slug
  | "slug-conflict" // its slug is registered with a different prefix
  | "ambiguous" // two canonical databases: never registrable
  | "in-migration" // a journal that has not reached `complete`
  | "unreadable"; // the database could not be identified

export interface ClassifiedCandidate extends RawCandidate {
  state: CandidateState;
  /** The path the hub currently holds for this slug, when it holds one. */
  registeredPath: string | null;
  /** False for every state a registration would have to guess about. */
  registrable: boolean;
  /** One sentence, for the preview table and for --json. */
  reason: string;
}

/** What the classifier needs from the hub — injected, so it is testable and read-only. */
export interface RegistryView {
  bySlug(slug: string): { slug: string; prefix: string; path: string } | undefined;
  slugForPrefix(prefix: string): string | undefined;
}

/**
 * Decide, for each candidate, whether registering it is a fact or a guess.
 *
 * The `registrable: false` cases are the interesting ones, and `ambiguous` is
 * the one A5 called out by name: "NEVER register an ambiguous directory — that
 * is the forked workspace the whole epic is about, and the hub can only hold one
 * path per slug, so registering one silently picks a winner. Report it as a
 * conflict candidate instead and let the operator resolve it."
 */
export function classifyCandidates(
  candidates: readonly RawCandidate[],
  registry: RegistryView,
): ClassifiedCandidate[] {
  return candidates.map((candidate): ClassifiedCandidate => {
    const base = { ...candidate, registeredPath: null as string | null };

    if (candidate.ambiguous) {
      return {
        ...base,
        state: "ambiguous",
        registrable: false,
        reason:
          "two canonical databases here and nothing proves one is a copy of the other; " +
          "registering would silently pick a winner",
      };
    }
    if (candidate.journalState !== null && candidate.journalState !== "complete") {
      return {
        ...base,
        state: "in-migration",
        registrable: false,
        reason: `a path migration is at "${candidate.journalState}" here; finish it with \`staple migrate --yes\` first`,
      };
    }
    if (!candidate.dbPath || !candidate.slug || !candidate.prefix) {
      return {
        ...base,
        state: "unreadable",
        registrable: false,
        reason: candidate.readError
          ? `its database could not be read (${candidate.readError})`
          : "it has no slug/prefix metadata, so it is not a staple workspace this build wrote",
      };
    }

    const here = normalizePath(candidate.dbPath);
    const existing = registry.bySlug(candidate.slug);

    if (existing && existing.prefix !== candidate.prefix) {
      return {
        ...base,
        state: "slug-conflict",
        registeredPath: existing.path,
        registrable: false,
        reason:
          `the hub registers "${candidate.slug}" with prefix ${existing.prefix}, but this database is ` +
          `stamped ${candidate.prefix} — two different workspaces have collided on a name`,
      };
    }
    if (existing) {
      const registered = normalizePath(existing.path);
      if (registered === here) {
        return {
          ...base,
          state: "registered",
          registeredPath: existing.path,
          registrable: false,
          reason: "already registered at this exact path",
        };
      }
      return {
        ...base,
        state: "moved",
        registeredPath: existing.path,
        registrable: true,
        reason: `registered at ${existing.path}, which is not here; registering repoints it`,
      };
    }

    const holder = registry.slugForPrefix(candidate.prefix);
    if (holder !== undefined && holder !== candidate.slug) {
      return {
        ...base,
        state: "prefix-conflict",
        registrable: false,
        reason: `prefix ${candidate.prefix} already belongs to workspace "${holder}"`,
      };
    }

    return {
      ...base,
      state: "unregistered",
      registrable: true,
      reason: "not in the hub yet",
    };
  });
}
