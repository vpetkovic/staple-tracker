/**
 * Pull and snapshot cursors.
 *
 * A cursor is opaque to the client: it is treated as bytes, never parsed, never
 * synthesised. It is base64url over JSON here purely because that is cheap; the
 * encoding is an implementation detail and the `v` field exists so it can change.
 *
 * It is NOT signed. Every field is re-validated against the authenticated session
 * before it is used, and a forged cursor can therefore only ask for rows the caller is
 * already entitled to. An HMAC would add a secret to rotate and remove no threat.
 */

import { SyncError } from "./errors.js";

export interface PullCursor {
  /** Format version, so the cursor can evolve alongside `protocol`. */
  v: 1;
  /** Repository id. Re-checked against the session; a mismatch is `cursor_invalid`. */
  r: string;
  /** Epoch. A superseded epoch is `epoch_changed`, never a silent reset. */
  e: number;
  /** Exclusive lower bound on `seq`. */
  s: number;
}

export interface SnapshotCursor {
  v: 1;
  r: string;
  e: number;
  /** The pinned snapshot cutoff. Every page of one snapshot folds to the same seq. */
  c: number;
  /** Exclusive lower bound on the composite entity key, `"<entity> <entityId>"`. */
  k: string;
}

export function encodeCursor(cursor: PullCursor | SnapshotCursor): string {
  return b64urlEncode(JSON.stringify(cursor));
}

export function decodePullCursor(raw: string): PullCursor {
  const parsed = parse(raw);
  if (
    parsed.v !== 1 ||
    typeof parsed.r !== "string" ||
    !Number.isInteger(parsed.e) ||
    !Number.isInteger(parsed.s) ||
    (parsed.s as number) < 0
  ) {
    throw new SyncError("cursor_invalid", "cursor is not a pull cursor");
  }
  return parsed as unknown as PullCursor;
}

export function decodeSnapshotCursor(raw: string): SnapshotCursor {
  const parsed = parse(raw);
  if (
    parsed.v !== 1 ||
    typeof parsed.r !== "string" ||
    !Number.isInteger(parsed.e) ||
    !Number.isInteger(parsed.c) ||
    typeof parsed.k !== "string"
  ) {
    throw new SyncError("cursor_invalid", "cursor is not a snapshot cursor");
  }
  return parsed as unknown as SnapshotCursor;
}

/**
 * The two checks every cursor gets, in this order.
 *
 * Repository first: a cursor naming another repository is `cursor_invalid`, and
 * saying so before looking at the epoch avoids leaking whether that other repository
 * has moved on.
 *
 * Then epoch. A stale epoch is `epoch_changed` and carries the current one, so the
 * client knows it must re-bootstrap. It is never silently reset to the beginning — a
 * silent reset replays the entire history into a live database.
 */
export function assertCursorScope(
  cursor: { r: string; e: number },
  repoId: string,
  currentEpoch: number,
): void {
  if (cursor.r !== repoId) {
    throw new SyncError("cursor_invalid", "cursor is from another repository");
  }
  if (cursor.e !== currentEpoch) {
    throw new SyncError("epoch_changed", "cursor is from a superseded epoch", {
      currentEpoch,
      mustRebootstrap: true,
    });
  }
}

function parse(raw: string): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = b64urlDecode(raw);
  } catch {
    throw new SyncError("cursor_invalid", "cursor is not decodable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new SyncError("cursor_invalid", "cursor is not decodable");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("cursor_invalid", "cursor is not decodable");
  }
  return parsed as Record<string, unknown>;
}

function b64urlEncode(text: string): string {
  const utf8 = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(raw: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("not base64url");
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * The composite key snapshot pages order and resume on.
 *
 * The separator is a SPACE, and used to be a literal NUL byte. That was not a design
 * choice, it was an escape that became a real byte — and its cost had nothing to do
 * with sorting: a single NUL makes git classify the whole file as **binary**, so
 * `git diff` reports `Binary files differ`, the GitHub UI shows nothing, and `grep`
 * skips it. This file was unreviewable and ungreppable for as long as it held one.
 * `test/source-hygiene.test.ts` now fails on any raw NUL in a tracked source file.
 *
 * ## Why the substitution does not change any ordering
 *
 * Snapshot pages are ordered by this key and resumed with `key > afterKey`, so a
 * separator change is only safe if it preserves every comparison.
 *
 * Both characters sort below every character any entity name contains — NUL is 0x00,
 * space is 0x20, and the names are all `[a-zA-Z]`. The only pair where the separator is
 * ever the deciding byte is one entity name that is a prefix of another, and there is
 * exactly one: `document` and `documentRevision`. At index 8 the comparison is
 * separator vs `R`, and both 0x00 and 0x20 are below `R` (0x52), so `document` sorts
 * first either way. Within one entity the separator is at the same index on both sides
 * and cancels. So the order is identical.
 *
 * ## The one live consequence, and why it is harmless
 *
 * A snapshot cursor issued before this change carries a `k` built with a NUL. Compared
 * against keys built with a space, that stale `k` sorts below **every** new key for the
 * same entity (0x00 < 0x20), so a bootstrap in flight across the deploy re-walks the whole
 * served range for that entity — NOT "one duplicated page of work", which is what an
 * earlier version of this comment claimed and which was wrong.
 *
 * It is still bounded and still idempotent: the range is the snapshot's own pinned cutoff,
 * a device applies by `(entity, entityId)`, and the fold is a pure function of the log. So
 * the cost is one repeated pass for a bootstrap that happened to straddle a deploy, and
 * the alternative was leaving a file nobody can review or grep.
 *
 * **Note for anyone reviewing the pull request that changed this.** The PRE-IMAGE at the
 * merge base still contains the NUL, so git classifies the whole diff as binary and
 * `gh pr diff` shows nothing for this file — the net-new code here was unreviewable in the
 * diff that introduced it. `test/source-hygiene.test.ts` guards the post-image and cannot
 * help with that; reading the file at HEAD is the only way to review it.
 */
export function entityKey(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}
