/**
 * THE canonical error contract (test-only).
 *
 * One logical failure => one {code, retryable, detail} triple, regardless of
 * which surface the caller is on. Every surface suite (MCP, CLI, HTTP) asserts
 * its projection against THIS table rather than against its own copy, which is
 * what makes cross-surface consistency structural instead of aspirational: to
 * break consistency you would have to edit this file, and that breaks all three
 * suites at once.
 */

export interface ErrorTriple {
  code: string;
  retryable: boolean;
  /** Absent when the core throws without detail — asserted as absent, not ignored. */
  detail?: Record<string, unknown>;
}

/**
 * Only revision_conflict is retryable (core/types.ts RETRYABLE_ERROR_CODES).
 * A checkout conflict tells the caller to pick a different task; looping on it
 * is the exact behaviour the retry bit exists to prevent.
 */
export const ERROR_CONTRACT = {
  /** Claiming an issue another agent already holds. */
  checkoutConflict(holder: string): ErrorTriple {
    return {
      code: "conflict",
      retryable: false,
      detail: { currentStatus: "in_progress", heldBy: holder, blockers: [] },
    };
  },
  /** Claiming an issue whose blockers are unresolved — same code, different detail. */
  checkoutBlocked(currentStatus: string, blockers: string[]): ErrorTriple {
    return {
      code: "conflict",
      retryable: false,
      detail: { currentStatus, heldBy: null, blockers },
    };
  },
  /** Writing a document from a stale base revision. The one retryable failure. */
  revisionConflict(currentRevision: number): ErrorTriple {
    return { code: "revision_conflict", retryable: true, detail: { currentRevision } };
  },
  /** Creating a second open issue with the same normalized title under the same parent. */
  duplicate(identifier: string): ErrorTriple {
    return { code: "duplicate", retryable: false, detail: { identifier } };
  },
  /** Any ref that resolves to nothing. */
  notFound(): ErrorTriple {
    return { code: "not_found", retryable: false };
  },
  /** A write with no actor and no STAPLE_AGENT (H8). */
  missingActor(): ErrorTriple {
    return { code: "validation", retryable: false };
  },
  /** Replaying a cursor against different arguments than it was issued for (H9). */
  cursorScopeMismatch(): ErrorTriple {
    return { code: "validation", retryable: false };
  },
  /**
   * Claiming an issue queued behind an unresolved review gate (STA-143).
   *
   * Its own code rather than a `conflict`, and the difference is the whole
   * point of the triple: a `conflict` says another agent got there first, so go
   * find other work RIGHT NOW. `gated` says this work is real and unclaimed and
   * simply not released — the queue moves when a PERSON moves it. Non-retryable
   * like everything except revision_conflict: looping on it burns turns while a
   * human is asleep.
   */
  checkoutGated(gate: string, owner: string, currentStatus: string): ErrorTriple {
    return {
      code: "gated",
      retryable: false,
      detail: { currentStatus, queuedBy: { identifier: gate, owner } },
    };
  },
} as const;

/** Reduce any surface's error body to the triple, so surfaces are comparable. */
export function tripleOf(envelope: Record<string, unknown>): ErrorTriple {
  const triple: ErrorTriple = {
    code: String(envelope.code),
    retryable: envelope.retryable as boolean,
  };
  if (envelope.detail !== undefined) triple.detail = envelope.detail as Record<string, unknown>;
  return triple;
}

/** src/cli.ts EXIT_CODES — pinned so CI can keep branching on the number. */
export const CLI_EXIT_CODES: Record<string, number> = {
  validation: 2,
  not_found: 3,
  conflict: 4,
  duplicate: 5,
  cycle: 6,
  revision_conflict: 7,
  timeout: 8,
  gated: 9,
};

/** src/ui/server.ts maps StapleError -> 404 for not_found, 409 for everything else. */
export function httpStatusFor(code: string): number {
  return code === "not_found" ? 404 : 409;
}
