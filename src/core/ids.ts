import { createHash, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** Fallback prefix when a slug has no letters at all. */
export const PREFIX_FALLBACK = "WS";

/** Slug -> candidate identifier prefix: first three letters, uppercased. */
export function derivePrefixBase(slug: string): string {
  const letters = slug.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.slice(0, 3) || PREFIX_FALLBACK;
}

/** Disambiguating suffix for the nth allocation attempt: "", "A", "AA", ... */
export function prefixSuffixForAttempt(attempt: number): string {
  return attempt <= 1 ? "" : "A".repeat(attempt - 1);
}

export const IDENTIFIER_RE = /^([A-Z]+)-(\d+)$/;

export function parseIdentifier(identifier: string): { prefix: string; number: number } | null {
  const match = IDENTIFIER_RE.exec(identifier.trim().toUpperCase());
  if (!match) return null;
  return { prefix: match[1]!, number: Number(match[2]!) };
}

/**
 * Level-triggered dependency-wake key: one wake per (dependent, exact blocker
 * set, blocked cycle). A new blocked cycle produces a new key, so re-blocking
 * re-arms the wake; a duplicate ready-state is suppressed by the unique index.
 */
export function blockersResolvedDedupKey(input: {
  dependentId: string;
  blockerIds: string[];
  blockedTransitionAt: string | null;
}): string {
  const sorted = [...new Set(input.blockerIds)].sort();
  const cycle = input.blockedTransitionAt ?? "none";
  const digest = createHash("sha256")
    .update(`${sorted.join(",")}\n${cycle}`)
    .digest("hex")
    .slice(0, 32);
  return `blockers_resolved:${input.dependentId}:${sorted.length}:${digest}`;
}

/** One children-complete wake per (parent, exact child set). */
export function childrenCompleteDedupKey(parentId: string, childIds: string[]): string {
  const sorted = [...new Set(childIds)].sort();
  const digest = createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 32);
  return `children_complete:${parentId}:${sorted.length}:${digest}`;
}
