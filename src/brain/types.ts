/**
 * The brain: persistent agent memory shared by every agent CLI (proof of concept).
 *
 * A record is one fact an agent should carry into later sessions. The text record is the
 * source of truth; every search index over it is a derived cache that is rebuilt from the
 * records and never synchronized.
 */

export const BRAIN_KINDS = ["user", "feedback", "project", "reference"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

/** `global`, or `project:<key>` where the key is a Claude-style path slug (`scope.ts`). */
export type BrainScope = string;

export interface BrainRecord {
  id: string;
  kind: BrainKind;
  /** Short handle, unique enough to read in a list. Optional for agent-written records. */
  name: string | null;
  /** One line: what the record is about. Shown in the injected context block. */
  description: string | null;
  body: string;
  why: string | null;
  scope: BrainScope;
  tags: string[];
  /** Who wrote it: `agent:<harness>/<session>`, `human:<name>`, or `import:<path>`. */
  source: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  supersededBy: string | null;
  provisional: boolean;
}

export const GLOBAL_SCOPE = "global";

export function isBrainKind(value: unknown): value is BrainKind {
  return typeof value === "string" && (BRAIN_KINDS as readonly string[]).includes(value);
}

/** Rough token estimate, chars/4. The report states it as an estimate, never as a count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
