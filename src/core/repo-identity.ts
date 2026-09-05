/**
 * The repository's identity: a UUID that survives cloning, because the thing
 * being shared is the repository, not the directory or the database file.
 *
 * Contract: `docs/sync.md`, "Repository identity".
 *
 * ## Why it is a checked-in file and not a row
 *
 * A fresh clone has no database. If identity lived only in `.staple/staple.db`
 * — which `.staple/.gitignore` deliberately makes uncommittable — then the first
 * `staple cloud sync` on a bare clone would have nothing to hydrate *from* and
 * would have to guess, or mint, or prompt. All three are wrong: minting forks
 * the repository silently, and the other two ask a human a question git already
 * answered.
 *
 * So `.staple/repository.json` is tracked, and it is the git-recoverable copy of
 * the identity. `sync_state.repository_id` is what the database itself believes.
 * Keeping both is the point rather than duplication — they disagree exactly when
 * a directory was copied or a manifest was hand-edited, and that disagreement is
 * the only local evidence either event happened.
 *
 * ## Why it is safe to publish
 *
 * Two keys. An id and a format number, and nothing else — no endpoint, no
 * account, no token, no membership list, no device. Publishing it discloses that
 * a repository *may* be connected, and nothing about what is in it or who can
 * read it. {@link REPOSITORY_MANIFEST_KEYS} is asserted against in the tests so
 * that a third key cannot arrive without somebody deciding it is publishable.
 *
 * Credentials, the user identity and the device id and secret are machine-local
 * and live in the staple home. They are not here, and they are not in the
 * workspace database either — that database synchronizes, so a credential in it
 * would replicate itself to every device.
 *
 * ## Fail closed, never fork silently
 *
 * Every read path here refuses a manifest it cannot understand instead of
 * treating it as absent. "Absent" means mint a new id, and minting a new id on a
 * clone whose manifest merely failed to parse is precisely the fork this file
 * exists to prevent — silent, unattributable, and discovered weeks later as two
 * repositories that will not converge. A malformed manifest is a five-second fix
 * for a human and an unrecoverable data split for a machine, so the machine
 * stops and says which file and what it expected.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StapleError } from "./types.js";

export const REPOSITORY_MANIFEST_FILENAME = "repository.json";

/**
 * The manifest format this build writes and understands.
 *
 * A manifest declaring a HIGHER number was written by a newer build and is
 * refused, for the same reason `meta.schema_version` is refused when it runs
 * ahead of the binary: a format number that travels with the file is only worth
 * having if something actually stops when it disagrees.
 */
export const REPOSITORY_MANIFEST_FORMAT = 1;

/** Every key the manifest is allowed to carry. Asserted in the tests. */
export const REPOSITORY_MANIFEST_KEYS = ["repositoryId", "format"] as const;

export interface RepositoryManifest {
  /** The sync identity of this repository. Stable across clones. */
  readonly repositoryId: string;
  /** Manifest format version. */
  readonly format: number;
}

/** Lower-case canonical UUID, the shape `randomUUID()` produces. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function repositoryManifestPath(workspaceDir: string): string {
  return join(workspaceDir, REPOSITORY_MANIFEST_FILENAME);
}

/**
 * Serialize deterministically: fixed key order, two-space indent, trailing
 * newline.
 *
 * This file is checked in, so its BYTES are a diff somebody reads. A serializer
 * that reordered keys or dropped the newline would produce spurious diffs on
 * every rewrite and make a real change to the id harder to spot in review, not
 * easier.
 */
export function renderRepositoryManifest(manifest: RepositoryManifest): string {
  return `${JSON.stringify(
    { repositoryId: manifest.repositoryId, format: manifest.format },
    null,
    2,
  )}\n`;
}

/**
 * Parse and validate manifest text.
 *
 * Throws rather than returning null for anything present-but-wrong. See the
 * module header: "unreadable" must never be allowed to degrade into "absent".
 */
export function parseRepositoryManifest(text: string, path: string): RepositoryManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new StapleError(
      "validation",
      `${path} is not valid JSON. It holds this repository's sync identity and is refused rather ` +
        `than replaced, because replacing it would fork the repository. Restore it from git ` +
        `(git checkout -- ${REPOSITORY_MANIFEST_FILENAME}), or delete it to mint a new identity.`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StapleError("validation", `${path} must contain a JSON object.`);
  }

  const record = raw as Record<string, unknown>;
  const { repositoryId, format } = record;

  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    throw new StapleError(
      "validation",
      `${path} has no valid "format" number. Expected the integer ${REPOSITORY_MANIFEST_FORMAT}.`,
    );
  }
  if (format > REPOSITORY_MANIFEST_FORMAT) {
    /**
     * `conflict`, not `validation`: the file is not malformed, this build is
     * simply older than it. Same shape of refusal as the schema downgrade guard,
     * and for the same reason — an older binary that shrugged and carried on
     * would write a manifest the newer one had already moved past.
     */
    throw new StapleError(
      "conflict",
      `${path} is format ${format}, but this build understands ${REPOSITORY_MANIFEST_FORMAT}. ` +
        `It was written by a newer version of staple. Upgrade rather than downgrading the file.`,
    );
  }
  if (!isRepositoryId(repositoryId)) {
    throw new StapleError(
      "validation",
      `${path} has no valid "repositoryId". Expected a lower-case UUID.`,
    );
  }

  const unknownKeys = Object.keys(record).filter(
    (key) => !(REPOSITORY_MANIFEST_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    /**
     * Deliberately strict, and the opposite of the envelope's "unknown fields are
     * preserved" rule. That rule exists so a mixed-version fleet does not lose
     * DATA. This file is not data, it is a published artefact whose entire
     * security property is that its contents are exhaustively known — a key
     * nobody recognises is either a newer format (caught above by `format`) or
     * something that should never have been committed.
     */
    throw new StapleError(
      "validation",
      `${path} carries unexpected keys (${unknownKeys.join(", ")}). The manifest holds only ` +
        `${REPOSITORY_MANIFEST_KEYS.join(" and ")}; it is published, so nothing else belongs in it.`,
    );
  }

  return { repositoryId, format };
}

/** Read the manifest, or null when the file is genuinely absent. */
export function readRepositoryManifest(workspaceDir: string): RepositoryManifest | null {
  const path = repositoryManifestPath(workspaceDir);
  if (!existsSync(path)) return null;
  return parseRepositoryManifest(readFileSync(path, "utf8"), path);
}

export interface EnsureRepositoryManifestResult {
  readonly path: string;
  readonly manifest: RepositoryManifest;
  /** false when a manifest was already there and was adopted unchanged. */
  readonly written: boolean;
}

/**
 * Adopt the existing manifest, or mint one when there is none.
 *
 * **Never clobbers**, same discipline as `writeAgentsGuide` and
 * `writeWorkspaceGitignore` — and here it is not merely politeness about an
 * operator's edits. A fresh clone arrives carrying a manifest and no database,
 * and `staple init` is the first command that runs in it. An init that wrote its
 * own id over the tracked one would fork the repository at exactly the moment
 * the manifest was supposed to prevent that. Adoption is the whole feature.
 */
export function ensureRepositoryManifest(workspaceDir: string): EnsureRepositoryManifestResult {
  const path = repositoryManifestPath(workspaceDir);
  const existing = readRepositoryManifest(workspaceDir);
  if (existing) return { path, manifest: existing, written: false };

  const manifest: RepositoryManifest = {
    repositoryId: randomUUID(),
    format: REPOSITORY_MANIFEST_FORMAT,
  };
  writeFileSync(path, renderRepositoryManifest(manifest), "utf8");
  return { path, manifest, written: true };
}

// ---------------------------------------------------------------- sync_state

/** What `sync_state` records about identity. Null when the row does not exist. */
export function readStoredRepositoryId(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT repository_id FROM sync_state WHERE id = 1").get() as
    | { repository_id: string | null }
    | undefined;
  return row?.repository_id ?? null;
}

/**
 * Record what this database believes it is.
 *
 * Writes the singleton row if it is not there. `epoch`, the cursors and
 * `client_seq_high_water` keep their defaults — recording an identity is not
 * connecting, and a workspace can carry an id it has never synchronized.
 */
export function writeStoredRepositoryId(db: DatabaseSync, repositoryId: string): void {
  db.prepare(
    `INSERT INTO sync_state (id, repository_id) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET repository_id = excluded.repository_id`,
  ).run(repositoryId);
}

export type RepositoryIdentityStatus =
  /** Manifest and database agree, or the database had not yet recorded one. */
  | "consistent"
  /** The database recorded an id and the manifest now names a different one. */
  | "manifest_mismatch";

export interface RepositoryIdentityReport {
  readonly repositoryId: string;
  readonly manifestPath: string;
  readonly status: RepositoryIdentityStatus;
  /** What `sync_state` held before this call, for a diagnostic to render. */
  readonly storedRepositoryId: string | null;
  /** true when the manifest file was created by this call. */
  readonly manifestWritten: boolean;
}

/**
 * Reconcile the manifest with the database, minting a manifest only when absent.
 *
 * The manifest wins. It is the git-recoverable copy, so on a clone it is the
 * only copy, and on a disagreement it is the one a human can see in a diff and
 * reason about. `sync_state` is adopted from it, never the reverse.
 *
 * A mismatch is REPORTED, not repaired. Rewriting either side would destroy the
 * evidence: a database whose recorded id is not the manifest's has either been
 * copied out of another repository or had its manifest hand-edited, and both are
 * things a person needs to decide about — `staple cloud fork-id` if the split is
 * intended, restoring the manifest from git if it is not. Note this call still
 * leaves the workspace fully usable, because an unconnected repository does not
 * care what its id is.
 */
export function reconcileRepositoryIdentity(
  db: DatabaseSync,
  workspaceDir: string,
): RepositoryIdentityReport {
  const ensured = ensureRepositoryManifest(workspaceDir);
  const stored = readStoredRepositoryId(db);

  if (stored === null) {
    writeStoredRepositoryId(db, ensured.manifest.repositoryId);
    return {
      repositoryId: ensured.manifest.repositoryId,
      manifestPath: ensured.path,
      status: "consistent",
      storedRepositoryId: null,
      manifestWritten: ensured.written,
    };
  }

  return {
    repositoryId: ensured.manifest.repositoryId,
    manifestPath: ensured.path,
    status: stored === ensured.manifest.repositoryId ? "consistent" : "manifest_mismatch",
    storedRepositoryId: stored,
    manifestWritten: ensured.written,
  };
}

// ---------------------------------------------------------------------- fork

export interface ForkResult {
  readonly previousRepositoryId: string | null;
  readonly repositoryId: string;
  readonly manifestPath: string;
}

/**
 * Mint a new identity for this workspace — the operation behind
 * `staple cloud fork-id`.
 *
 * A copied directory is byte-indistinguishable from a clone: same manifest, same
 * entity ids, same everything. For a clone, converging back to one repository is
 * exactly right. For a fork it is a surprise, so forking is explicit and this is
 * the ONLY function here that rewrites the manifest.
 *
 * What is dropped, and why each:
 *
 *   - `sync_state` — cursors, epoch, head_seq and the client-sequence high-water
 *     mark are all positions in the OLD repository's log. Carrying a cursor into
 *     a repository that has never heard of it would ask for rows by a sequence
 *     number that means something else there.
 *   - `sync_outbox` — operations addressed to the old repository. Their ids are
 *     derived from the old `repoId`, so they cannot be re-aimed; they are
 *     regenerated by the seam if the underlying mutations still need pushing.
 *   - `sync_applied` — a dedup ledger keyed on old-repository operation ids.
 *   - `sync_leases` — claims granted by the old repository's server. A fencing
 *     token from one repository has no authority in another, and keeping one
 *     would let a surface render a global claim this workspace does not hold.
 *   - `sync_devices` — a read cache of the old repository's device list.
 *
 * What is KEPT, deliberately:
 *
 *   - `sync_entity_versions` — monotonic local counters. A fork does not make
 *     this device's edit history untrue, and rewinding versions to zero would
 *     make the first post-fork operation claim a `baseVersion` it has already
 *     used.
 *   - `sync_tombstones` — a deletion that happened here still happened here.
 *     Dropping them is the resurrection bug wearing a different hat.
 *   - `sync_conflicts` — the audit record of what was contested and who chose.
 *
 * The original repository is untouched: nothing here makes a network call, and
 * the other clones keep their manifest and their id.
 */
export function forkRepositoryId(db: DatabaseSync, workspaceDir: string): ForkResult {
  const previous = readRepositoryManifest(workspaceDir)?.repositoryId ?? null;
  const repositoryId = randomUUID();
  const path = repositoryManifestPath(workspaceDir);

  writeFileSync(
    path,
    renderRepositoryManifest({ repositoryId, format: REPOSITORY_MANIFEST_FORMAT }),
    "utf8",
  );

  for (const table of ["sync_state", "sync_outbox", "sync_applied", "sync_leases", "sync_devices"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  writeStoredRepositoryId(db, repositoryId);

  return { previousRepositoryId: previous, repositoryId, manifestPath: path };
}

// --------------------------------------------------------------- diagnostics

/** One workspace as the hub knows it, plus whatever manifest is on its disk. */
export interface WorkspaceIdentityEntry {
  /** Canonical workspace path, as registered. */
  readonly path: string;
  /** The manifest id found there, or null when there is no manifest. */
  readonly repositoryId: string | null;
}

export interface RepositoryIdCollision {
  readonly repositoryId: string;
  /** Every registered workspace path presenting this id, sorted. */
  readonly paths: readonly string[];
}

/**
 * Find repository ids claimed by more than one workspace on this machine.
 *
 * This is the copied-directory diagnostic, and it is deliberately LOCAL. The
 * server cannot detect a copied manifest — two directories presenting the same
 * id look exactly like two clones, which is a thing it must support — so the
 * evidence only exists on the machine where both copies sit.
 *
 * Pure, and takes the entries rather than reading the hub itself, for two
 * reasons: it is trivially testable without a hub, and it needs no hub schema
 * change. The caller enumerates registered workspaces and reads each one's
 * manifest off disk, which is information the hub already indirectly has.
 *
 * A collision is reported, never repaired. The right answer depends on which
 * copy is the real one, and only a human knows that.
 */
export function findRepositoryIdCollisions(
  entries: readonly WorkspaceIdentityEntry[],
): RepositoryIdCollision[] {
  const byId = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.repositoryId === null) continue;
    const paths = byId.get(entry.repositoryId);
    if (paths) paths.push(entry.path);
    else byId.set(entry.repositoryId, [entry.path]);
  }

  const collisions: RepositoryIdCollision[] = [];
  for (const [repositoryId, paths] of byId) {
    const unique = [...new Set(paths)].sort();
    if (unique.length > 1) collisions.push({ repositoryId, paths: unique });
  }
  return collisions.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
}
