/**
 * The machine-local, repository-scoped record of a cloud connection.
 *
 * Contract: `docs/sync.md`, "Three consents".
 *
 * ## Why this is a file in the staple home and not a row in the workspace
 *
 * All three consents — connect, automatic sync, backup — are **per-device**.
 * The workspace database synchronizes; a `sync.auto = true` written there would
 * replicate to every other machine and turn one laptop's decision into a fleet
 * policy. So the record lives beside the hub, in the home, keyed by repository
 * id, and the workspace database never learns it exists.
 *
 * Keyed by REPOSITORY id rather than by workspace path on purpose. Two checkouts
 * of the same repository on one machine are the same connection — the same
 * device, the same credential, the same consent — and keying by path would make
 * a second clone silently unconnected, or worse, connect it a second time and
 * mint a second device for one machine.
 *
 * ## Absent means disconnected, and there is no placeholder
 *
 * There is no "connected: false" record. `disconnect` deletes the file. The
 * migration that created `sync_state` made the same choice for the same reason:
 * writing a placeholder would make "has this repository ever been connected"
 * un-askable, and the zero-network invariant is stated as *"before a repository
 * is connected, no cloud setting, credential or request may exist at all"* —
 * `at all` is not satisfied by a file that says no.
 *
 * ## What is deliberately NOT in here
 *
 * The token. It is in the credential store, and the mechanism recorded here says
 * which one. This file is `0600` too, but the separation is what lets the
 * keychain hold the only copy of the secret on a machine that has one.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/atomic.js";
import { StapleError } from "../types.js";
import { credentialDir } from "./credential-store.js";
import type { CredentialMechanism } from "./credential-store.js";

export const CONNECTION_SCHEMA_VERSION = 1;

export interface CloudConnection {
  readonly schemaVersion: number;
  /** The repository this connection is for. Also the file's name. */
  readonly repositoryId: string;
  /** Normalized origin. No trailing slash, no credentials, no query. */
  readonly endpoint: string;
  /** This machine's device id, as the server knows it. */
  readonly deviceId: string;
  /** Human label shown in `cloud devices`. Null when none was given. */
  readonly label: string | null;
  /** Where the token for this repository is stored on this machine. */
  readonly credentialMechanism: CredentialMechanism;
  readonly connectedAt: string;
  /**
   * Automatic synchronization. **Always false on a fresh connection.** Storing a
   * credential is not consent to use it; `staple cloud auto on` is a second,
   * separately named decision, and turning it off does not disconnect.
   */
  readonly auto: boolean;
  /** Backup is a third opt-in with its own commands. Also false on connect. */
  readonly backup: boolean;
  /**
   * Publishing the hub registry — the FOURTH consent (STA-283). False on connect,
   * like the other two, and meaningful only on the hub's own record, whose key is
   * `hub.hubId()` rather than a workspace's `repositoryId`.
   *
   * It is its own consent because it discloses something none of the other three
   * does, and the sentence is `hub-registry.ts`'s, verbatim, wherever it is granted:
   *
   *   *"a machine that publishes its registry tells the service the names, prefixes
   *   and identities of every workspace on it, and that they sit together."*
   *
   * Connecting a repository says nothing about other repositories. Automatic sync
   * says nothing about what is synchronized. Backup says a copy may be KEPT, not that
   * the shape of the machine may be described. So neither of the three implies this
   * one, and this one implies none of them.
   *
   * `CONNECTION_SCHEMA_VERSION` deliberately does NOT move for this field, and the
   * asymmetry is what makes that safe. An older build reading a record that carries
   * it ignores it — `readConnection` reads a fixed key list and every flag as
   * `x === true` — so it simply does not publish, which is the safe direction. And if
   * an older build then WRITES the record through `setConsent`, its spread drops the
   * field, silently REVOKING the consent rather than silently keeping it. A consent
   * that degrades to "no" across a downgrade needs no version gate; one that degraded
   * to "yes" would need much more than a version gate.
   *
   * OPTIONAL in the type, and that is the same statement said in TypeScript rather
   * than a concession to the existing call sites. **Absent means not granted**, on a
   * record written before this field existed and on one written by a build that does
   * not know about it, and the only readers are `registry === true` tests. Making it
   * required would force every hand-built `CloudConnection` literal in the tree to
   * name a consent it is not about, which teaches nothing and is a merge conflict per
   * file; more importantly it would let `undefined` mean "unset" in exactly one place
   * — a partially-built record — instead of meaning "no" everywhere.
   *
   * `performConnect` still writes it explicitly as `false`, because a fresh connection
   * should state all of its consents rather than leaving one to be inferred.
   */
  readonly registry?: boolean;
  /** Protocol version negotiated at connect. Advisory; re-read per session. */
  readonly protocol: number;
}

export function connectionPath(home: string, repositoryId: string): string {
  return join(credentialDir(home), `${repositoryId}.json`);
}

function assertString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new StapleError("validation", `${path}: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Read the record, or null when this repository has never been connected here.
 *
 * Absence is not an error; unreadability is — the same discipline as
 * `readConfig` and `readRepositoryManifest`. A parse failure that fell back to
 * "not connected" would tell a human they had never connected, and the natural
 * next thing they would do is connect again, minting a second device and
 * overwriting the file we could not read.
 */
export function readConnection(home: string, repositoryId: string): CloudConnection | null {
  const path = connectionPath(home, repositoryId);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StapleError(
      "validation",
      `${path} is not valid JSON. It records this machine's connection to repository ` +
        `${repositoryId} and is refused rather than replaced. Fix it, or run ` +
        `\`staple cloud disconnect\` to remove it and re-connect.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StapleError("validation", `${path} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new StapleError("validation", `${path}: "schemaVersion" must be a positive integer`);
  }
  if (version > CONNECTION_SCHEMA_VERSION) {
    throw new StapleError(
      "conflict",
      `${path} is schemaVersion ${version}, but this build understands ` +
        `${CONNECTION_SCHEMA_VERSION}. It was written by a newer staple. Upgrade rather than ` +
        `letting an older build rewrite it.`,
    );
  }

  const mechanism = assertString(record, "credentialMechanism", path);
  if (mechanism !== "keychain" && mechanism !== "secret-tool" && mechanism !== "file") {
    throw new StapleError("validation", `${path}: unknown credentialMechanism "${mechanism}"`);
  }

  /**
   * `auto`, `backup` and `registry` default to FALSE when the key is missing or is
   * not a boolean, rather than being refused. A consent flag whose value cannot be
   * read is not consent — the safe reading of a damaged file is that permission
   * was never given, and it is the only reading that cannot silently start
   * sending data.
   *
   * `registry` reaches this default by the ordinary path on every record written
   * before STA-283, which is exactly right: a machine that has never been asked
   * whether it wants to publish its registry has not agreed to.
   */
  const auto = record.auto === true;
  const backup = record.backup === true;
  const registry = record.registry === true;
  const protocol = typeof record.protocol === "number" ? record.protocol : 1;

  return {
    schemaVersion: version,
    repositoryId: assertString(record, "repositoryId", path),
    endpoint: assertString(record, "endpoint", path),
    deviceId: assertString(record, "deviceId", path),
    label: typeof record.label === "string" ? record.label : null,
    credentialMechanism: mechanism,
    connectedAt: assertString(record, "connectedAt", path),
    auto,
    backup,
    registry,
    protocol,
  };
}

/** Write the record. `0600` in a `0700` directory, atomically, like every secret-adjacent file. */
export function writeConnection(home: string, connection: CloudConnection): string {
  const path = connectionPath(home, connection.repositoryId);
  writeFileAtomic(path, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  return path;
}

/**
 * Change one consent flag. Read-modify-write, refusing when there is no record.
 *
 * `staple cloud auto on` on an unconnected repository is a `not_found` rather
 * than a file that springs into existence carrying a consent for a connection
 * that does not exist.
 */
export function setConsent(
  home: string,
  repositoryId: string,
  patch: { auto?: boolean; backup?: boolean; registry?: boolean },
): CloudConnection {
  const existing = readConnection(home, repositoryId);
  if (!existing) {
    throw new StapleError(
      "not_found",
      `This repository is not connected on this machine, so there is no consent to change. ` +
        `Run \`staple cloud connect\` first.`,
    );
  }
  const next: CloudConnection = {
    ...existing,
    auto: patch.auto ?? existing.auto,
    backup: patch.backup ?? existing.backup,
    /**
     * Patched independently of the other two, which is the enforcement rather than a
     * convenience: there is no argument shape here in which agreeing to one consent
     * produces another, so "backup implies publish" is not something a caller can
     * express even by mistake.
     */
    registry: patch.registry ?? existing.registry,
  };
  writeConnection(home, next);
  return next;
}

/** Remove the record. Idempotent — disconnecting twice is not an error. */
export function deleteConnection(home: string, repositoryId: string): boolean {
  const path = connectionPath(home, repositoryId);
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}

/**
 * Is the connection record as private as it was written?
 *
 * Same reasoning as the credential file's check: reported, never silently
 * repaired, and not run on Windows where the mode bits mean nothing.
 */
export function connectionIsPrivate(
  home: string,
  repositoryId: string,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform === "win32") return null;
  const path = connectionPath(home, repositoryId);
  if (!existsSync(path)) return null;
  return (statSync(path).mode & 0o077) === 0;
}

/**
 * Every repository connected on this machine.
 *
 * Used by `staple doctor` and by nothing that runs on an ordinary command path.
 * Reads the directory; makes no network call and opens no workspace.
 */
export function listConnections(home: string): CloudConnection[] {
  const dir = credentialDir(home);
  if (!existsSync(dir)) return [];
  const connections: CloudConnection[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const repositoryId = name.slice(0, -".json".length);
    const connection = readConnection(home, repositoryId);
    if (connection) connections.push(connection);
  }
  return connections;
}
