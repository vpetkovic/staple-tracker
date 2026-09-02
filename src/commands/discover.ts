/**
 * `staple discover <root>` — STA-24 plan §4 and its TTY-matrix row:
 *
 * > "Preview candidates and confirm selected registrations | Read-only preview
 * > by default, mutation requires explicit root, `--all-found` or explicit
 * > selections, and `--yes` | Finite JSON candidates or result; exit 2 when
 * > mutation selection is incomplete | Selected hub registrations only; it never
 * > initializes discovered Git repositories."
 *
 * ## Three separate things the user has to say
 *
 * Registration needs all three, and they are deliberately not collapsible:
 *
 *   1. **A root.** A positional argument, never a default. The plan is explicit:
 *      "do not scan the user's home implicitly."
 *   2. **A selection.** `--all-found` or `--select a,b,c`. `--yes` alone means
 *      "yes to what?" — and the honest answer, when a scan just found eleven
 *      directories, is that nobody knows.
 *   3. **`--yes`.** The consent itself.
 *
 * Missing any one of them is exit 2 with nothing written.
 *
 * ## What it will not do
 *
 * - **Initialize anything.** Plan: "It does not initialize every Git repository
 *   it sees." `discover` only ever writes hub rows; creating a workspace is
 *   `staple init` or `staple add`, both of which name one directory.
 * - **Register an ambiguous directory.** A5's handoff by name: "NEVER register
 *   an ambiguous directory — that is the forked workspace the whole epic is
 *   about, and the hub can only hold one path per slug, so registering one
 *   silently picks a winner." `--all-found` means all found REGISTRABLE
 *   candidates; the unregistrable ones are reported and skipped, and `--select`
 *   naming one is a hard error rather than a silent omission.
 */
import { parseArgs } from "node:util";
import { StapleError } from "../core/types.js";
import { Hub } from "../core/hub.js";
import { repairHubRegistration } from "../core/hub-repair.js";
import {
  DEFAULT_MAX_DEPTH,
  classifyCandidates,
  scanForWorkspaces,
  type ClassifiedCandidate,
  type RegistryView,
  type ScanReport,
} from "../core/discovery.js";

export interface DiscoverReport {
  root: string;
  scannedDirs: number;
  maxDepth: number;
  truncated: boolean;
  candidates: ClassifiedCandidate[];
  denied: ScanReport["denied"];
  skipped: ScanReport["skipped"];
  /** True when nothing was written. Always true without --yes. */
  previewOnly: boolean;
  registered: Array<{ slug: string; prefix: string; path: string; outcome: string }>;
  failed: Array<{ slug: string; reason: string }>;
}

/** An empty registry, for a machine that has never run `init`. */
const EMPTY_REGISTRY: RegistryView = { bySlug: () => undefined, slugForPrefix: () => undefined };

/** Read the hub without migrating or converting it — discovery is a preview. */
function registryView(hub: Hub | null): RegistryView {
  if (!hub) return EMPTY_REGISTRY;
  const entries = hub.list();
  return {
    bySlug: (slug) => entries.find((entry) => entry.slug === slug),
    slugForPrefix: (prefix) => entries.find((entry) => entry.prefix === prefix)?.slug,
  };
}

export interface DiscoverOptions {
  root: string;
  maxDepth?: number;
  followSymlinks?: boolean;
  crossFilesystems?: boolean;
}

/** The read-only half. Scans, classifies, writes nothing. */
export function previewDiscover(options: DiscoverOptions): DiscoverReport {
  const scan = scanForWorkspaces({
    root: options.root,
    maxDepth: options.maxDepth,
    followSymlinks: options.followSymlinks,
    crossFilesystems: options.crossFilesystems,
  });

  let hub: Hub | null = null;
  try {
    try {
      hub = Hub.openReadOnly();
    } catch {
      hub = null; // no hub yet: everything found is unregistered
    }
    return {
      root: scan.root,
      scannedDirs: scan.scannedDirs,
      maxDepth: scan.maxDepth,
      truncated: scan.truncated,
      candidates: classifyCandidates(scan.candidates, registryView(hub)),
      denied: scan.denied,
      skipped: scan.skipped,
      previewOnly: true,
      registered: [],
      failed: [],
    };
  } finally {
    try {
      hub?.close();
    } catch {
      /* unwinding */
    }
  }
}

/**
 * Resolve `--select` tokens against the scan.
 *
 * A token may be a slug or a directory path, because both are things a user can
 * read off the preview table. A token that matches nothing is an ERROR rather
 * than an empty selection — "I asked for three and got two" has to be loud.
 */
function selectCandidates(
  candidates: readonly ClassifiedCandidate[],
  tokens: readonly string[],
): ClassifiedCandidate[] {
  const chosen: ClassifiedCandidate[] = [];
  for (const token of tokens) {
    const match = candidates.find((c) => c.slug === token || c.dir === token || c.dbPath === token);
    if (!match) {
      throw new StapleError(
        "not_found",
        `--select named "${token}", which is not among the ${candidates.length} candidate(s) found under this root.`,
      );
    }
    if (!match.registrable) {
      // Silently skipping this would be the worst option: the user explicitly
      // named it, so they have to be told why it is refused.
      throw new StapleError(
        "conflict",
        `--select named "${token}", which cannot be registered: ${match.reason}.`,
      );
    }
    if (!chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

function printPreview(report: DiscoverReport): void {
  console.log(`Scanned ${report.scannedDirs} director${report.scannedDirs === 1 ? "y" : "ies"} under ${report.root}` +
    ` (max depth ${report.maxDepth}${report.truncated ? ", TRUNCATED" : ""}).`);

  if (report.candidates.length === 0) {
    console.log("No staple workspaces found.");
  } else {
    console.log("");
    for (const candidate of report.candidates) {
      const mark = candidate.registrable ? "+" : " ";
      const name = candidate.slug ?? "(unidentified)";
      const layout = candidate.layout === "legacy" ? " [legacy .tasks]" : "";
      console.log(`${mark} ${candidate.state.padEnd(16)} ${name.padEnd(20)} ${candidate.dir}${layout}`);
      console.log(`  ${" ".repeat(16)} ${candidate.reason}`);
    }
  }

  for (const entry of report.denied) {
    console.error(`warning: could not read ${entry.path} (${entry.reason}) — skipped, scan continued.`);
  }

  const registrable = report.candidates.filter((c) => c.registrable);
  if (report.previewOnly && registrable.length > 0) {
    console.log("");
    console.log(`${registrable.length} candidate(s) can be registered. Nothing has been written.`);
    console.log(`  staple discover ${report.root} --all-found --yes`);
    console.log(`  staple discover ${report.root} --select ${registrable.map((c) => c.slug).join(",")} --yes`);
  }
}

export function runDiscoverCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean" },
      "all-found": { type: "boolean" },
      select: { type: "string" },
      depth: { type: "string" },
      "follow-symlinks": { type: "boolean" },
      "cross-filesystems": { type: "boolean" },
    },
  });

  const root = positionals[0];
  if (root === undefined) {
    throw new StapleError(
      "validation",
      "usage: staple discover <root> [--depth N] [--all-found|--select a,b] [--yes]\n" +
        "  The root is required and is never defaulted: staple does not scan your home directory.",
    );
  }

  const depth = values.depth === undefined ? DEFAULT_MAX_DEPTH : Number(values.depth);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new StapleError("validation", `--depth must be a non-negative integer, got "${values.depth}"`);
  }

  const report = previewDiscover({
    root,
    maxDepth: depth,
    followSymlinks: values["follow-symlinks"] === true,
    crossFilesystems: values["cross-filesystems"] === true,
  });

  const selection = values.select?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const wantsMutation = values.yes === true || values["all-found"] === true || selection.length > 0;

  if (!wantsMutation) {
    // The default, and the plan's "Read-only preview by default".
    if (values.json) console.log(JSON.stringify(report));
    else printPreview(report);
    return;
  }

  /**
   * The three-part gate. Each missing piece gets its own message, because
   * "invalid arguments" would leave the user guessing which of three things
   * they omitted.
   */
  if (values["all-found"] && selection.length > 0) {
    throw new StapleError("validation", "--all-found and --select contradict each other; pass one.");
  }
  if (!values["all-found"] && selection.length === 0) {
    throw new StapleError(
      "validation",
      "--yes says yes, but not to what. Registering needs an explicit selection policy as well:\n" +
        "  --all-found            every registrable candidate under this root\n" +
        "  --select <a,b,c>       named slugs or directories, from the preview\n" +
        "Run `staple discover <root>` with no flags to see the candidates first.",
      { root: report.root, candidates: report.candidates.length },
    );
  }
  if (!values.yes) {
    throw new StapleError(
      "validation",
      `Refusing to write hub registrations without --yes. ` +
        `Re-run the same command with --yes to register ${
          values["all-found"] ? "every registrable candidate" : `the ${selection.length} selected candidate(s)`
        } under ${report.root}.`,
      { ...report },
    );
  }

  const chosen = values["all-found"]
    ? report.candidates.filter((c) => c.registrable)
    : selectCandidates(report.candidates, selection);

  const registered: DiscoverReport["registered"] = [];
  const failed: DiscoverReport["failed"] = [];
  for (const candidate of chosen) {
    // Hub rows only. `discover` never creates a database, never writes a guide,
    // never writes an ignore file, and never migrates anything.
    const outcome = repairHubRegistration({
      slug: candidate.slug!,
      prefix: candidate.prefix!,
      dbPath: candidate.dbPath!,
      kind: "repo",
    });
    if (outcome.error) failed.push({ slug: candidate.slug!, reason: outcome.error });
    else registered.push({
      slug: candidate.slug!,
      prefix: candidate.prefix!,
      path: outcome.pathAfter,
      outcome: outcome.outcome,
    });
  }

  const applied: DiscoverReport = { ...report, previewOnly: false, registered, failed };
  if (values.json) {
    console.log(JSON.stringify(applied));
    return;
  }
  const skippedCount = report.candidates.length - chosen.length;
  console.log(`Registered ${registered.length} workspace(s) from ${report.root}.`);
  for (const entry of registered) {
    console.log(`  ${entry.outcome.padEnd(12)} ${entry.slug.padEnd(20)} ${entry.path}`);
  }
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} candidate(s); run \`staple discover ${report.root}\` to see why.`);
  }
  for (const entry of failed) console.error(`warning: ${entry.slug}: ${entry.reason}`);
}
