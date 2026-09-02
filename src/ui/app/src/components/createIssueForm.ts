/**
 * Six text boxes -> one `{ type: "create" }` ActionPayload. Owned by U5.
 *
 * Split out of the dialog because this is the only part of creating a task that can be
 * wrong in a way nobody sees. Two rules run through all of it:
 *
 *  1. ABSENT is not EMPTY. `store.createIssue` reads `undefined` as "use the default"
 *     and a value as "use this", so an untouched box has to disappear from the payload
 *     rather than arrive as `""` or `[]`. A description of `""` would overwrite nothing
 *     today and would be a lie tomorrow.
 *  2. This module validates NOTHING. A blank title is sent blank, so `createIssue`
 *     throws its own "Title is required" and the dialog renders that sentence. Every
 *     rule about what a task may be lives in the store; a copy here is a second rule
 *     that can drift from the first.
 *
 * Pure and DOM-free on purpose — it is unit-tested next door without React.
 * Type-only import, relative: the repo has no vitest config, so `@/` does not resolve
 * at test time and a runtime import through it would not load.
 */
import type { ActionPayload, IssuePriority } from "../lib/types";

/** Exactly what the dialog holds in state — all strings, because all of it is typed. */
export interface CreateFormState {
  title: string;
  description: string;
  priority: IssuePriority;
  parent: string;
  /** Comma-separated. Labels may contain spaces, so commas are the only separator. */
  labels: string;
  /** Refs, separated by commas and/or whitespace. */
  blockedBy: string;
}

/** Medium is the store's own create-time default, so an untouched form agrees with it. */
export const EMPTY_CREATE_FORM: CreateFormState = {
  title: "",
  description: "",
  priority: "medium",
  parent: "",
  labels: "",
  blockedBy: "",
};

/** Trim, drop blanks, de-duplicate — keeping the order they were first typed in. */
function tidy(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Commas only. "needs review, ui" is two labels, not three — splitting on whitespace
 * as well would quietly shred every multi-word label an agent already wrote.
 */
export function splitLabels(raw: string): string[] {
  return tidy(raw.split(","));
}

/**
 * Commas and/or whitespace, because "STA-1 STA-2" and "STA-1, STA-2" are both what a
 * person types. Case is left alone: resolving a ref is the store's job, and lowercasing
 * here would decide something this form has no business deciding.
 */
export function splitRefs(raw: string): string[] {
  return tidy(raw.split(/[\s,]+/));
}

/** The payload the dialog POSTs. Empty optional fields are omitted, not emptied. */
export function buildCreatePayload(state: CreateFormState): Extract<ActionPayload, { type: "create" }> {
  const payload: Extract<ActionPayload, { type: "create" }> = {
    type: "create",
    // Trimmed but never rejected — see rule 2 above.
    title: state.title.trim(),
    priority: state.priority,
  };

  const description = state.description.trim();
  if (description) payload.description = description;

  const parent = state.parent.trim();
  if (parent) payload.parent = parent;

  const labels = splitLabels(state.labels);
  if (labels.length > 0) payload.labels = labels;

  const blockedBy = splitRefs(state.blockedBy);
  if (blockedBy.length > 0) payload.blockedBy = blockedBy;

  return payload;
}
