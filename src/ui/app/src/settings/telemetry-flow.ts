/**
 * The consent flow of automatic collection, apart from React so it can be run against the
 * real server in a test (the suite has no DOM; see `telemetry-e2e.test.tsx`).
 *
 * The page's consent is the server's: `POST /api/budget/collection/plan` returns the plan
 * and a single-use ticket bound to its digest, and setup/unsetup take only that ticket. So:
 *
 *   plan    -> shown to the reader, with an explicit Confirm;
 *   confirm -> applied, or
 *              the ticket is stale (expired, used, or the machine changed under the plan:
 *              404 / 409) -> the plan is asked for AGAIN and shown again, never applied
 *              without a second confirm, or
 *              setup stopped partway (`setup_incomplete`) -> said honestly, with what
 *              was done, or
 *              refused (a write from another device: `cross_origin`; anything else: the
 *              server's sentence).
 */
import type { CollectionOutcome, CollectionPlanResponse, CollectionSetupOptions, PlanConsentTicket, PlanStep } from "@/lib/telemetry-types";

/** The two calls the flow makes. `lib/api.ts` in the page; a fetch against the test server in a test. */
export interface CollectionTransport {
  plan(action: "setup" | "unsetup", options: CollectionSetupOptions): Promise<CollectionPlanResponse>;
  apply(action: "setup" | "unsetup", consent: PlanConsentTicket): Promise<CollectionOutcome>;
}

/** A plan on screen: what was asked, and what the server answered. */
export interface ShownPlan {
  action: "setup" | "unsetup";
  options: CollectionSetupOptions;
  response: CollectionPlanResponse;
  /** Set when this is a fresh plan shown because the previous one went stale. */
  replanned: boolean;
}

export type ConfirmResult =
  | { kind: "applied"; outcome: CollectionOutcome; options: CollectionSetupOptions }
  | { kind: "replanned"; shown: ShownPlan; why: string }
  | { kind: "incomplete"; message: string; failedStep: string | null; applied: PlanStep[] }
  | { kind: "refused"; message: string; crossOrigin: boolean };

/** The failure fields every staple error envelope carries (ApiError in the page). */
interface Failure {
  status?: number;
  message?: string;
  detail?: Record<string, unknown>;
}

export function reasonOf(error: unknown): string | null {
  const detail = (error as Failure | null)?.detail;
  const reason = detail?.["reason"];
  return typeof reason === "string" ? reason : null;
}

export function isCrossOrigin(error: unknown): boolean {
  return (error as Failure | null)?.status === 403 && reasonOf(error) === "cross_origin";
}

export function messageOf(error: unknown): string {
  const message = (error as Failure | null)?.message;
  return typeof message === "string" && message !== "" ? message : "The change was refused, and the server did not say why.";
}

export async function showPlan(transport: CollectionTransport, action: "setup" | "unsetup", options: CollectionSetupOptions = {}): Promise<ShownPlan> {
  const response = await transport.plan(action, action === "setup" ? options : {});
  return { action, options, response, replanned: false };
}

export const STALE_PLAN_WHY =
  "Something changed since this plan was shown, or it was open too long (a plan is good for 5 minutes), so nothing was changed. " +
  "Here is the plan as it stands now; check it and confirm again.";

/**
 * Apply the plan on screen with its ticket. Never applies a plan the reader has not seen:
 * a stale ticket comes back as a NEW plan to show, not as a retry.
 */
export async function confirmPlan(transport: CollectionTransport, shown: ShownPlan): Promise<ConfirmResult> {
  const consent = shown.response.consent;
  if (consent === null) return { kind: "refused", message: "This plan has nothing to confirm.", crossOrigin: false };
  try {
    const outcome = await transport.apply(shown.action, consent);
    return { kind: "applied", outcome, options: shown.options };
  } catch (error) {
    if (isCrossOrigin(error)) return { kind: "refused", message: messageOf(error), crossOrigin: true };
    const reason = reasonOf(error);
    if (reason === "setup_incomplete") {
      const detail = (error as Failure).detail ?? {};
      return {
        kind: "incomplete",
        message: messageOf(error),
        failedStep: typeof detail["failedStep"] === "string" ? detail["failedStep"] : null,
        applied: Array.isArray(detail["applied"]) ? (detail["applied"] as PlanStep[]) : [],
      };
    }
    const status = (error as Failure | null)?.status;
    if (status === 404 || status === 409) {
      const fresh = await showPlan(transport, shown.action, shown.options);
      return { kind: "replanned", shown: { ...fresh, replanned: true }, why: STALE_PLAN_WHY };
    }
    return { kind: "refused", message: messageOf(error), crossOrigin: false };
  }
}
