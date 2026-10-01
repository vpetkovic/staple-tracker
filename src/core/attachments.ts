/**
 * Typed file attachments: metadata that syncs, bytes that sync only when they fit.
 *
 * The bytes live in `attachment_bytes`, keyed by SHA-256, so two attachments of the
 * same file share one copy and a database backup holds the evidence. The metadata
 * lives in `attachments` and is the `attachment` entity (protocol 4). A file of at
 * most {@link ATTACH_INLINE_MAX_BYTES} whose payload stays under the journal cap
 * travels inside the create, base64. A larger file, up to {@link ATTACH_MAX_BYTES},
 * is kept on the device that attached it and marked `local`: the metadata syncs and
 * another device can say the bytes are not here. Past the cap, nothing is written.
 *
 * The media type is sniffed from the bytes. The filename is a label.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StapleError } from "./types.js";

/** A file larger than this is refused. 32 MiB covers a screenshot, a PDF and a short recording. */
export const ATTACH_MAX_BYTES = 32 * 1024 * 1024;

/**
 * At or under this, the bytes are inlined in the operation when the encoded payload
 * still fits the journal cap (`JOURNAL_MAX_OP_BYTES`, 512 KiB). 256 KiB of raw bytes
 * is about 341 KiB of base64, which leaves room for the metadata under that cap.
 * The store drops to `local` when a particular payload would not fit.
 */
export const ATTACH_INLINE_MAX_BYTES = 256 * 1024;

export type ByteSync = "inline" | "local";

/** What `show` and `get_task` return. Never the bytes. */
export interface AttachmentMeta {
  id: string;
  issueId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  author: string | null;
  caption: string | null;
  byteSync: ByteSync;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  issue_id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  author: string | null;
  caption: string | null;
  byte_sync: string;
  created_at: string;
}

export function metaFromRow(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id,
    issueId: row.issue_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    author: row.author,
    caption: row.caption,
    byteSync: row.byte_sync === "inline" ? "inline" : "local",
    createdAt: row.created_at,
  };
}

/** A filename is a label: no path, no empty name. */
export function cleanFilename(name: string): string {
  const base = basename(name.trim());
  if (base === "" || base === "." || base === ".." || base.length > 255 || /[\\/\0]/.test(base)) {
    throw new StapleError("validation", "A file needs a filename of 1-255 characters with no path separators.");
  }
  return base;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The media type the bytes actually are.
 *
 * Magic numbers win. What is left is text when it is valid UTF-8 without NULs, and
 * SVG or HTML are recognised there so a later server can refuse to execute them.
 * Anything else is `application/octet-stream`. The extension is never consulted.
 */
export function sniffMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const gif = ascii(bytes, 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  const text = utf8Text(bytes);
  if (text === null) return "application/octet-stream";
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "text/html";
  return "text/plain";
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** Valid UTF-8 with no NUL and almost no control characters, or null. An empty file is not text. */
function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return null;
  }
  let controls = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 9 || (code > 13 && code < 32)) controls += 1;
  }
  return controls / text.length < 0.05 ? text : null;
}

export function assertAttachable(bytes: Uint8Array): void {
  if (bytes.byteLength > ATTACH_MAX_BYTES) {
    throw new StapleError(
      "payload_too_large",
      `A file is at most ${ATTACH_MAX_BYTES} bytes (${formatBytes(ATTACH_MAX_BYTES)}). This one is ${bytes.byteLength} bytes. Nothing was written.`,
      { bytes: bytes.byteLength, maxBytes: ATTACH_MAX_BYTES },
    );
  }
}

function formatBytes(n: number): string {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MiB`;
  if (n % 1024 === 0) return `${n / 1024} KiB`;
  return `${n} bytes`;
}

/** The create payload. Bytes are included only when `byteSync` is `inline` and the caller passed them. */
export function attachmentPayload(meta: AttachmentMeta, bytes: Uint8Array | null): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    issueId: meta.issueId,
    filename: meta.filename,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
    author: meta.author,
    caption: meta.caption,
    byteSync: meta.byteSync,
    createdAt: meta.createdAt,
  };
  if (meta.byteSync !== "inline" || bytes === null) return fields;
  return { ...fields, bytes: Buffer.from(bytes).toString("base64") };
}

/** Which sync class a file of this size gets, before the payload-size check. */
export function byteSyncFor(size: number): ByteSync {
  return size <= ATTACH_INLINE_MAX_BYTES ? "inline" : "local";
}

export function readAttachment(db: DatabaseSync, id: string): AttachmentMeta | null {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
  return row ? metaFromRow(row) : null;
}

export function listAttachments(db: DatabaseSync, issueId: string): AttachmentMeta[] {
  const rows = db
    .prepare("SELECT * FROM attachments WHERE issue_id = ? ORDER BY created_at, id")
    .all(issueId) as unknown as AttachmentRow[];
  return rows.map(metaFromRow);
}

export function readAttachmentBytes(db: DatabaseSync, sha256: string): Buffer | null {
  const row = db.prepare("SELECT bytes FROM attachment_bytes WHERE sha256 = ?").get(sha256) as
    | { bytes: Uint8Array }
    | undefined;
  return row ? Buffer.from(row.bytes) : null;
}

/** Insert the row and, when bytes are in hand, the blob. A redelivery of the same id changes nothing. */
export function insertAttachment(db: DatabaseSync, meta: AttachmentMeta, bytes: Uint8Array | null): boolean {
  const inserted = db
    .prepare(
      `INSERT INTO attachments (id, issue_id, filename, media_type, size, sha256, author, caption, byte_sync, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      meta.id,
      meta.issueId,
      meta.filename,
      meta.mediaType,
      meta.size,
      meta.sha256,
      meta.author,
      meta.caption,
      meta.byteSync,
      meta.createdAt,
    );
  if (bytes !== null) {
    db.prepare("INSERT OR IGNORE INTO attachment_bytes (sha256, bytes) VALUES (?, ?)").run(meta.sha256, Buffer.from(bytes));
  }
  return Number(inserted.changes) > 0;
}

/**
 * The bytes a create payload carries, checked against the size and the hash it claims.
 * Null when the payload carries none (a local-only file).
 */
export function bytesFromPayload(payload: Record<string, unknown>, meta: AttachmentMeta): Uint8Array | null {
  if (typeof payload.bytes !== "string") return null;
  const raw = Buffer.from(payload.bytes, "base64");
  if (raw.byteLength !== meta.size || sha256Hex(raw) !== meta.sha256) {
    throw new StapleError(
      "validation",
      `Attachment ${meta.id} carries bytes that do not match its size or SHA-256. Nothing was written.`,
    );
  }
  return raw;
}

/** Metadata out of a create payload, or null when a required field is missing. */
export function metaFromPayload(id: string, payload: Record<string, unknown>): AttachmentMeta | null {
  const issueId = payload.issueId;
  const filename = payload.filename;
  const mediaType = payload.mediaType;
  const sha256 = payload.sha256;
  const createdAt = payload.createdAt;
  const size = payload.size;
  if (
    typeof issueId !== "string" ||
    typeof filename !== "string" ||
    typeof mediaType !== "string" ||
    typeof sha256 !== "string" ||
    typeof createdAt !== "string" ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0
  ) {
    return null;
  }
  const byteSync: ByteSync = payload.byteSync === "inline" ? "inline" : "local";
  return {
    id,
    issueId,
    filename,
    mediaType,
    size,
    sha256,
    author: typeof payload.author === "string" ? payload.author : null,
    caption: typeof payload.caption === "string" ? payload.caption : null,
    byteSync,
    createdAt,
  };
}
