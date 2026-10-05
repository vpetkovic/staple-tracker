/**
 * Evidence an agent wrote as a document before typed files existed.
 *
 * The shape is a markdown body with a `Media type: <type>` line, a
 * `SHA-256: <hex>` line, and the bytes as base64: either a data URI (usually
 * inside `![…](data:…;base64,…)`) or a block of base64 lines, fenced or not.
 * AII-2's `evidence-before-png` and `evidence-after-png` are the fixture.
 *
 * Detection reads the body and never changes it. A detected document is
 * `verified` only when the decoded bytes hash to the SHA-256 it claims and
 * sniff as the media type it claims. Anything else is flagged with what is
 * wrong, and nothing serves or converts it as a file.
 */
import { sha256Hex, sniffMediaType } from "./attachments.js";

export type EvidenceStatus = "verified" | "sha256_mismatch" | "type_mismatch" | "undecodable";

/** What the UI and the CLI are told. Never the bytes. */
export interface EvidenceSummary {
  status: EvidenceStatus;
  /** The `Media type:` line. */
  declaredMediaType: string;
  /** The `SHA-256:` line, lowercased. */
  declaredSha256: string;
  /** Sniffed from the decoded bytes; null when they did not decode. */
  mediaType: string | null;
  /** Of the decoded bytes; null when they did not decode. */
  sha256: string | null;
  size: number | null;
  /** One sentence for a person when the status is not `verified`. */
  problem: string | null;
}

export interface ParsedEvidence extends EvidenceSummary {
  bytes: Buffer | null;
}

/** Header lines sit before the payload; a heading or a list marker or bold around the label is fine. */
const MEDIA_TYPE_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?Media[ \t]+type(?::(?:\*\*)?|(?:\*\*)?:)[ \t]*`?([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)`?[ \t]*$/im;
const SHA_LINE = /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?SHA-?256(?::(?:\*\*)?|(?:\*\*)?:)[ \t]*`?([0-9a-fA-F]{64})`?[ \t]*$/im;
const DATA_URI = /data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/=\s]+)/i;
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/** A payload shorter than this is a mention, not a file. */
const MIN_PAYLOAD_CHARS = 64;

/** Parse a document body. Null when it is not this shape at all. */
export function parseEvidenceDocument(body: string): ParsedEvidence | null {
  // Cheap gate first: most documents are plans and worklogs.
  if (!/SHA-?256/i.test(body) || !/Media[ \t]+type/i.test(body)) return null;
  const mediaLine = MEDIA_TYPE_LINE.exec(body);
  const shaLine = SHA_LINE.exec(body);
  if (!mediaLine || !shaLine) return null;
  const declaredMediaType = mediaLine[1]!.toLowerCase();
  const payload = findPayload(body, Math.max(mediaLine.index, shaLine.index), declaredMediaType);
  if (payload === null) return null;

  const declaredSha256 = shaLine[1]!.toLowerCase();
  const bytes = decodeBase64(payload);
  if (bytes === null) {
    return {
      status: "undecodable",
      declaredMediaType,
      declaredSha256,
      mediaType: null,
      sha256: null,
      size: null,
      problem: "The base64 in this document does not decode, so it cannot be checked against its SHA-256.",
      bytes: null,
    };
  }
  const sha256 = sha256Hex(bytes);
  const mediaType = sniffMediaType(bytes);
  let status: EvidenceStatus = "verified";
  let problem: string | null = null;
  if (sha256 !== declaredSha256) {
    status = "sha256_mismatch";
    problem = `The bytes hash to ${sha256}, not the SHA-256 this document claims (${declaredSha256}). Do not treat it as the evidence it says it is.`;
  } else if (mediaType !== declaredMediaType) {
    status = "type_mismatch";
    problem = `The bytes are ${mediaType}, not the ${declaredMediaType} this document claims.`;
  }
  return { status, declaredMediaType, declaredSha256, mediaType, sha256, size: bytes.byteLength, problem, bytes };
}

export function summarizeEvidence(parsed: ParsedEvidence): EvidenceSummary {
  const { bytes: _bytes, ...summary } = parsed;
  return summary;
}

/**
 * The base64 after the header: the first data URI of the declared type, or
 * else the longest run of consecutive base64-only lines (a fence around it is
 * fine). A run of hex only is hashes (a SHA-256, a list of commits), never a
 * payload, so a plan that records a hash beside a `Media type:` line stays a plan.
 */
function findPayload(body: string, headerAt: number, declaredMediaType: string): string | null {
  const after = body.slice(headerAt);
  const uri = DATA_URI.exec(after);
  if (uri && uri[1]!.toLowerCase() === declaredMediaType) {
    const raw = uri[2]!.replace(/\s+/g, "");
    return raw.length >= MIN_PAYLOAD_CHARS ? raw : null;
  }
  const lines = after.split(/\r?\n/);
  let best = "";
  let run: string[] = [];
  const close = () => {
    const joined = run.join("");
    if (joined.length > best.length && !HEX_ONLY.test(joined)) best = joined;
    run = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== "" && BASE64_LINE.test(trimmed)) run.push(trimmed);
    else close();
  }
  close();
  return best.length >= MIN_PAYLOAD_CHARS ? best : null;
}

/** Strict base64: the right alphabet, whole quads, padding only at the end. */
function decodeBase64(raw: string): Buffer | null {
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  // Buffer.from tolerates junk; a round trip proves the text was canonical base64.
  if (bytes.toString("base64") !== raw) return null;
  return bytes;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "text/plain": "txt",
};

/** The current document after its bytes have been moved to a file. History keeps the old body. */
export function movedToFileNote(filename: string, sha256: string): string {
  return `Moved to file ${filename}.\nsha256: ${sha256}\n`;
}

/** The sha256 in a moved-to-file note, or null when the body is not that note. */
export function movedFileSha(body: string): string | null {
  const match = /^Moved to file \S+\.\nsha256: ([0-9a-f]{64})\n?$/.exec(body);
  return match?.[1] ?? null;
}

/** `evidence-before-png` holding a PNG becomes `evidence-before.png`. */
export function evidenceFilename(key: string, mediaType: string): string {
  const ext = EXTENSIONS[mediaType];
  if (!ext) return key;
  const stem = key.replace(new RegExp(`[-_.](?:${ext}|${ext === "jpg" ? "jpeg" : ext})$`, "i"), "");
  return `${stem || key}.${ext}`;
}
