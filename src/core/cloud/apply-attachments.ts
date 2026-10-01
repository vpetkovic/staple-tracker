/**
 * Applying `attachment` operations (protocol 4).
 *
 * A create writes the metadata and, when the payload carries bytes, the blob.
 * The bytes are checked against the size and the SHA-256 the payload claims
 * before anything is written. A create that arrives twice changes nothing, and
 * one that arrives without bytes on a device that already holds them leaves
 * those bytes in place. A delete is a tombstone, and the blob goes when the
 * last attachment that named its hash goes.
 */
import type { DatabaseSync } from "node:sqlite";
import { bytesFromPayload, insertAttachment, metaFromPayload, readAttachment, readAttachmentBytes, sha256Hex } from "../attachments.js";
import { StapleError } from "../types.js";
import { ReferentMissing, type ApplyInput } from "./apply.js";

export function applyAttachment(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "delete") {
    writeTombstone(db, input);
    db.prepare("DELETE FROM attachments WHERE id = ?").run(input.entityId);
    return true;
  }
  if (input.verb !== "create") return false;
  const meta = metaFromPayload(input.entityId, input.payload);
  if (meta === null) {
    throw new StapleError(
      "validation",
      `An attachment create for ${input.entityId} is missing its issue, filename, media type, size, SHA-256 or time.`,
    );
  }
  const issue = db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(meta.issueId) as { hit: number } | undefined;
  if (!issue) throw new ReferentMissing(`issue ${meta.issueId} (subject of attachment ${input.entityId})`);
  const bytes = bytesFromPayload(input.payload, meta);
  const held = readAttachment(db, input.entityId);
  if (held !== null) {
    // The first create is authoritative. A redelivery may fill a missing blob, and only with bytes that match the row already stored.
    if (
      bytes !== null &&
      bytes.byteLength === held.size &&
      sha256Hex(bytes) === held.sha256 &&
      readAttachmentBytes(db, held.sha256) === null
    ) {
      insertAttachment(db, held, bytes);
    }
    return false;
  }
  insertAttachment(db, meta, bytes);
  return true;
}

function writeTombstone(db: DatabaseSync, input: ApplyInput): void {
  db.prepare(
    `INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entity, entity_id) DO NOTHING`,
  ).run(input.entity, input.entityId, input.at, input.deviceId, input.opId);
}
