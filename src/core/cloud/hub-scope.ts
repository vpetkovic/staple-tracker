/**
 * Which workspaces a hub-wide cloud operation is about — enumerated from files,
 * and from files only.
 *
 * Contract: `docs/sync.md`, "What never leaves the machine" — *"The whole hub
 * database | `~/.staple/hub.db` | `workspaces.path` is an absolute filesystem
 * path and the registry names every *other* repository on the machine.
 * Cross-repository topology is not this repository's business."*
 *
 * ## This is a fan-out, not a synced hub, and the distinction is the design
 *
 * A hub-wide connect is not "the hub connects". The hub never leaves this
 * machine and no remote party ever learns that these workspaces sit together. It
 * is one gesture on one machine that visits each registered workspace in turn and
 * performs the per-repository operation that already existed. Every remote call
 * this produces is indistinguishable, at the service, from a human running
 * `staple cloud connect` in each directory by hand. That is the property that
 * lets the fan-out exist at all without contradicting the line above.
 *
 * ## Nothing here opens a workspace database
 *
 * The single most important property of this module, and the reason it reads
 * manifests rather than databases.
 *
 * `openWorkspace()` migrates. A `staple cloud status --all` that opened every
 * registered workspace would run schema migrations across every project on the
 * machine as a side effect of *looking at a list* — and the settings page polls,
 * so it would do it repeatedly. Worse, `performSetup()`'s `openDb()` **creates**
 * a database that is not there, so an enumeration that reached for a missing
 * path would materialise an empty workspace rather than reporting the absence.
 *
 * So the enumeration reads exactly three kinds of file: the hub registry, each
 * workspace's `repository.json`, and (in {@link ./hub-surface.js}) the connection
 * records in the staple home. All three are local, all three are cheap, and none
 * of them is the workspace database. The counters that DO need a database —
 * pending, cursor, epoch, conflicts, leases — are deliberately absent from the
 * hub-wide view; `staple cloud status` on one workspace remains where those come
 * from.
 *
 * ## An unreadable manifest is reported, never read as absent
 *
 * `readWorkspaceManifest` throws on a manifest that exists and will not parse,
 * and `repo-identity.ts` is emphatic that *"unreadable must never degrade into
 * absent"* — a workspace reported as having no identity is one a human will
 * happily `staple init` over, minting a second id for a repository that already
 * had one.
 *
 * A fan-out cannot let one such row take down the list, though: twelve
 * workspaces and one bad manifest must not produce zero information about the
 * other eleven. So the throw is caught **per row** and recorded as
 * {@link HubWorkspace.problem}. That is not a softening of the rule — the row
 * still does not report `repositoryId: null`, it reports a problem, and every
 * consumer treats a problem as "not actionable" rather than as "not connected".
 */
import { existsSync } from "node:fs";
import { Hub, type WorkspaceEntry } from "../hub.js";
import { readWorkspaceManifest, workspaceIdentityDir } from "../repo-identity.js";

/**
 * One registered workspace, as a hub-wide cloud operation sees it.
 *
 * `path` is the DATABASE path, because that is what the hub registers and what
 * `available` is a statement about. The identity lives in
 * {@link workspaceIdentityDir}, which is `dirname(path)` for a repository and a
 * sibling directory for a home-resident workspace — the distinction
 * `repo-identity.ts` exists to keep straight, and one this module must not
 * re-derive by hand.
 */
export interface HubWorkspace {
  readonly slug: string;
  readonly prefix: string;
  /** The workspace database path, exactly as the hub registered it. */
  readonly path: string;
  /** `"repo"` or `"global"`, as the hub recorded it. */
  readonly kind: string;
  /** `existsSync(path)`, and nothing more. See {@link HubWorkspace.problem}. */
  readonly available: boolean;
  /** Where this workspace's `repository.json` lives. */
  readonly identityDir: string;
  /** The sync identity, or null when this workspace has never been `init`ed. */
  readonly repositoryId: string | null;
  /**
   * Something wrong with this ROW that is not a state — an unreadable manifest,
   * so far. Never null-and-also-a-problem: a row with a problem has
   * `repositoryId: null` because the id could not be established, and every
   * consumer must read the problem rather than the null.
   */
  readonly problem: string | null;
}

/**
 * Every workspace the hub knows about, in hub order, with its sync identity.
 *
 * Opens the hub **read-only**. `Hub.open()` migrates and converts the journal to
 * WAL, which are both writes; a status command that stamped the hub as a side
 * effect of listing it would be the same class of mistake `Hub.openReadOnly()`
 * was introduced for in `doctor`. A hub-wide *connect* has no more business
 * writing to the hub than a hub-wide status does: this fan-out reads the
 * registry and writes only into the staple home's `cloud/` directory.
 *
 * Returns an empty list rather than throwing when there is no hub at all. A
 * machine that has never run `staple init` has nothing registered, and "no
 * workspaces" is the true answer to what a fan-out would visit — not an error.
 */
export function listHubWorkspaces(): HubWorkspace[] {
  let entries: WorkspaceEntry[];
  let hub: Hub;
  try {
    hub = Hub.openReadOnly();
  } catch {
    // No hub file. Nothing is registered, so a fan-out visits nothing.
    return [];
  }
  try {
    entries = hub.list();
  } finally {
    hub.close();
  }

  return entries.map(describeWorkspace);
}

/**
 * One hub row, resolved to an identity.
 *
 * Exported for the tests, which need to describe a row without a hub, and for
 * any caller that already holds a {@link WorkspaceEntry}.
 */
export function describeWorkspace(entry: WorkspaceEntry): HubWorkspace {
  const identityDir = workspaceIdentityDir(entry.path);
  /**
   * Re-derived rather than trusting `entry.available`. `Hub.list()` computes it
   * with `existsSync` at the moment it reads the row, which is the same thing
   * this would compute a microsecond later — but a fan-out makes decisions on
   * this value, and taking it from the enumerator rather than from the
   * filesystem would mean a caller holding a stale list could act on a path that
   * has since gone. Cheap, and it keeps the decision next to the syscall.
   */
  const available = existsSync(entry.path);

  let repositoryId: string | null = null;
  let problem: string | null = null;
  try {
    repositoryId = readWorkspaceManifest(entry.path)?.repositoryId ?? null;
  } catch (error) {
    /**
     * Caught per row, and turned into a PROBLEM rather than into an absence.
     * See the module header: one corrupt manifest must not blank the other
     * eleven workspaces, and it must equally not be reported as "no identity",
     * which is an invitation to `staple init` over a repository that has one.
     */
    problem = error instanceof Error ? error.message : String(error);
  }

  return {
    slug: entry.slug,
    prefix: entry.prefix,
    path: entry.path,
    kind: entry.kind,
    available,
    identityDir,
    repositoryId,
    problem,
  };
}

/**
 * Why a fan-out will not act on a workspace.
 *
 * Three values, and they are deliberately not collapsed into one "skipped":
 * each has a different remedy, and a fan-out that reported twelve skips without
 * saying which kind would be telling a human to go and look at twelve
 * directories.
 */
export type HubSkipReason =
  /** The database file is not on this machine right now. */
  | "unavailable"
  /** No `repository.json`, so there is no identity to connect or synchronize. */
  | "no_identity"
  /** The manifest is there and unreadable. Neither absent nor usable. */
  | "problem";

/**
 * Can a hub-wide operation act on this workspace at all?
 *
 * Null means yes. This is the ONE place the three refusals are decided, so the
 * connect fan-out and the sync fan-out cannot drift apart on what "actionable"
 * means — which they would, because each is separately tempted to be a little
 * more permissive than the other.
 *
 * **An unavailable workspace is skipped, never repaired and never pruned.**
 * `hub.ts` says `available` is *"`existsSync(path)` and nothing more, which is
 * the whole test"* — an unmounted volume, an external disk and a laptop with a
 * network share not yet attached all read as MISSING and are all back tomorrow.
 * Syncing one would be worse than useless: `syncRepository` needs an open
 * database, and the fan-out would either fail per row (noise) or, if it reached
 * for `staple init`'s door instead of `openWorkspace`'s, CREATE an empty
 * database and hydrate it from the remote snapshot. Connecting one is closer to
 * harmless — connect reads the manifest and writes only into the home — but it
 * would mint a device credential for a workspace that cannot then sync, and a
 * credential nobody can use is a secret with no purpose.
 */
export function skipReasonFor(workspace: HubWorkspace): HubSkipReason | null {
  /**
   * `unavailable` is tested FIRST, and the order is load-bearing rather than
   * incidental.
   *
   * A workspace whose disk is not mounted usually has no readable manifest
   * either — the manifest sits beside the database. Testing identity first
   * therefore reports `no_identity` for it, whose remedy sentence is *"Run
   * `staple init` in it to record one"* — advice to run a command in a directory
   * that is not there. That is not merely a worse message; it is an instruction
   * which, followed on a machine where the volume later mounts at the same path,
   * would mint a SECOND repository id over a workspace that already had one.
   *
   * Absence of the disk is the more fundamental fact and the only one that can
   * be established with confidence, so it is reported first.
   */
  if (!workspace.available) return "unavailable";
  if (workspace.problem !== null) return "problem";
  if (workspace.repositoryId === null) return "no_identity";
  return null;
}

/** One sentence for each refusal, so four surfaces do not word it four ways. */
export function describeSkip(workspace: HubWorkspace, reason: HubSkipReason): string {
  switch (reason) {
    case "unavailable":
      return (
        `The workspace database is not on this machine right now (${workspace.path}). ` +
        `It is left registered and untouched — an unmounted volume is not a deleted workspace.`
      );
    case "no_identity":
      return (
        `This workspace has no ${workspace.identityDir}/repository.json, so it has no sync ` +
        `identity. Run \`staple init\` in it to record one.`
      );
    case "problem":
      return `This workspace's sync identity could not be read: ${workspace.problem}`;
  }
}
