/**
 * The MCP half of the attempt write surfaces (`docs/execution-telemetry.md`, "Surfaces"):
 * the optional attempt fields on `checkout_task`, `release_task` and `update_task`, and the
 * `record_attempt_event` tool. Each calls the same store method the CLI does
 * (`src/commands/attempt.ts`), so the two cannot disagree.
 */
import { z } from "zod";
import type { WorkspaceStore } from "./core/store.js";
import type { AttemptOptions } from "./core/telemetry/attempts.js";
import { refuseRole } from "./commands/attempt.js";

/** The self-reported fields an attempt-opening write accepts (`checkout_task`, `update_task`). */
export const attemptOpenFields = {
  role: z
    .string()
    .optional()
    .describe("Refused here: a checkout, a steal and a status write always act on the worker lane. To coordinate without claiming, use record_attempt_event with event open and role orchestrator."),
  harness_session: z
    .string()
    .optional()
    .describe(
      "Your harness session id: the Claude Code session id, or for Codex the rollout's session_meta id (the rollout file name's tail). Stored only hashed with the harness name, the same hash a budget sample from that session carries. Needs `harness`.",
    ),
  harness: z.enum(["claude_code", "codex", "other"]).optional().describe("Which agent harness is doing the work."),
  model: z.string().optional().describe("The model doing the work, as the harness names it."),
  account: z
    .string()
    .optional()
    .describe("The provider account (operator's label, e.g. personal-max) this attempt spends from. Omit to use this machine's binding for the harness."),
  attempt_idempotency_key: z.string().optional().describe("Retry key for the attempt this write opens: a replay returns the original attempt."),
};

/** What a claim-clearing write accepts (`release_task`, `update_task`). */
export const attemptEndFields = {
  role: z.string().optional().describe("Refused here: a claim-clearing write always ends the worker lane's attempt."),
  outcome: z
    .literal("failed")
    .optional()
    .describe("Only when YOU concluded you cannot do the work, on the write that clears the claim. Needs `reason`."),
  reason: z.string().optional().describe("Why the attempt failed; required with outcome failed."),
};

/** The `attempt` a write returns beside its unchanged payload. */
export const attemptOutputField = {
  attempt: z.record(z.string(), z.unknown()).nullable().optional().describe("The attempt this write opened, ended or kept, as it reads; null when none."),
};

export function attemptOptionsFromInput(input: {
  role?: string;
  harness_session?: string;
  harness?: string;
  model?: string;
  account?: string;
  attempt_idempotency_key?: string;
  outcome?: string;
  reason?: string;
}): AttemptOptions | undefined {
  refuseRole(input.role);
  const options: AttemptOptions = {
    ...(input.harness_session !== undefined ? { harnessSession: input.harness_session } : {}),
    ...(input.harness !== undefined ? { harness: input.harness } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.account !== undefined ? { account: input.account } : {}),
    ...(input.attempt_idempotency_key !== undefined ? { idempotencyKey: input.attempt_idempotency_key } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : options;
}

/** A write's payload unchanged, plus `attempt`. */
export function withAttemptResult<T extends object>(store: WorkspaceStore, payload: T): T & { attempt: unknown } {
  return { ...payload, attempt: store.attempts().result() };
}

/** `record_attempt_event`'s input. */
export const recordAttemptEventInput = {
  event: z
    .enum(["pause", "resume", "milestone", "interrupt", "open", "end"])
    .describe(
      "pause: running -> paused, keeps the claim (reason: checkpoint_before_reset, awaiting_reset, awaiting_input, operator, other). resume: paused -> running. milestone: a one-line checkpoint (label). interrupt: ends the attempt as interrupted (reason: provider_limit, harness_exit, operator_stop, unknown); the claim stays, and a later checkout opens a new attempt that names this one. open (role orchestrator, required): open an orchestrator attempt on the issue you coordinate, usually the parent or epic; no claim, no status change, never agent work. end (role orchestrator): end it (coordination_ended).",
    ),
  role: z
    .enum(["worker", "orchestrator"])
    .optional()
    .describe("The lane. Required as orchestrator for open and end; on the other events, required when you hold an attempt in each lane."),
  attempt_id: z.string().optional().describe("The attempt to act on, by id: the other way to say which lane."),
  // `open`: what the orchestrator self-reports, as on a checkout.
  harness_session: attemptOpenFields.harness_session,
  harness: attemptOpenFields.harness,
  model: attemptOpenFields.model,
  account: attemptOpenFields.account,
  attempt_idempotency_key: attemptOpenFields.attempt_idempotency_key,
  reason: z.string().optional(),
  label: z.string().optional().describe("The milestone's one-line label."),
  comment_id: z.string().optional().describe("A comment on this issue the milestone summarizes."),
  document_key: z.string().optional().describe("A document on this issue (e.g. worklog) the milestone points at; with document_revision."),
  document_revision: z.number().int().positive().optional(),
};

export function recordAttemptEvent(
  store: WorkspaceStore,
  ref: string,
  actor: string,
  input: {
    event: string;
    reason?: string;
    label?: string;
    comment_id?: string;
    document_key?: string;
    document_revision?: number;
    role?: string;
    attempt_id?: string;
    harness_session?: string;
    harness?: string;
    model?: string;
    account?: string;
    attempt_idempotency_key?: string;
  },
): unknown {
  if (input.event === "open") {
    const { role, event: _event, reason: _reason, label: _label, comment_id: _comment, document_key: _key, document_revision: _revision, attempt_id: _id, ...reported } = input;
    return store.openOrchestratorAttempt(ref, actor, role, attemptOptionsFromInput(reported) ?? {});
  }
  if (input.event === "end") return store.endOrchestratorAttempt(ref, actor, input.role, input.attempt_id);
  return store.recordAttemptEvent(ref, input.event, actor, {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.attempt_id !== undefined ? { attemptId: input.attempt_id } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.comment_id !== undefined ? { commentId: input.comment_id } : {}),
    ...(input.document_key !== undefined && input.document_revision !== undefined
      ? { document: { key: input.document_key, revision: input.document_revision } }
      : {}),
  });
}
