/**
 * The web page's consent to a collection plan, tied to the plan it was shown.
 *
 * The CLI's consent is `--yes` on the same command line that printed the plan. A page
 * shows the plan in one request and applies it in another, and between the two the
 * machine can change (another setup ran, settings.json was edited). So, in the pattern of
 * the cloud connect consent (`core/cloud/consent.ts`), `POST /api/budget/collection/plan`
 * mints a single-use ticket bound to a digest of the plan it returned, and the options
 * that produced it are kept HERE, server-side: `setup`/`unsetup` carry only the ticket
 * and the digest. Redeeming re-plans from the stored options and refuses if the plan no
 * longer reads the same, so what is applied is what the person read.
 *
 * In memory and per server process, like the connect tickets: a ticket is a record that
 * somebody was looking at a plan a moment ago, not a stored permission.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StapleError } from "../../types.js";
import type { CollectionPlan, SetupOptions } from "./service.js";

export const PLAN_CONSENT_TTL_MS = 5 * 60 * 1000;
export const MAX_OUTSTANDING_PLAN_CONSENTS = 16;

export interface PlanConsentTicket {
  readonly id: string;
  readonly digest: string;
  readonly expiresAt: string;
}

interface Stored {
  readonly action: CollectionPlan["action"];
  readonly options: SetupOptions;
  readonly digest: string;
  readonly expiresAtMs: number;
}

/** Every field of every step a person reads, in a fixed order. */
export function planDigest(plan: CollectionPlan): string {
  const lines = [`action=${plan.action}`, ...plan.steps.map((step) => [step.part, step.action, step.summary, step.path ?? "", step.target ?? ""].join("\u0000"))];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class PlanConsentStore {
  private readonly tickets = new Map<string, Stored>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(plan: CollectionPlan, options: SetupOptions): PlanConsentTicket {
    this.sweep();
    if (this.tickets.size >= MAX_OUTSTANDING_PLAN_CONSENTS) {
      const oldest = this.tickets.keys().next();
      if (!oldest.done) this.tickets.delete(oldest.value);
    }
    const id = randomBytes(32).toString("base64url");
    const digest = planDigest(plan);
    const expiresAtMs = this.now() + PLAN_CONSENT_TTL_MS;
    this.tickets.set(id, { action: plan.action, options, digest, expiresAtMs });
    return { id, digest, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /**
   * Consume a ticket (single use, deleted before anything can fail) and return the
   * options its plan was made from, after checking the plan still reads the same.
   */
  redeem(
    id: unknown,
    digest: unknown,
    action: CollectionPlan["action"],
    rebuild: (options: SetupOptions) => CollectionPlan,
  ): { options: SetupOptions; plan: CollectionPlan } {
    this.sweep();
    if (typeof id !== "string" || id === "") {
      throw new StapleError("validation", `${action} needs the consent id and digest that POST /api/budget/collection/plan returned with the plan you were shown.`, {
        reason: "consent_required",
      });
    }
    const stored = this.tickets.get(id);
    this.tickets.delete(id);
    if (stored === undefined) {
      throw new StapleError("not_found", "That consent has expired, was already used, or was issued by a server that has since restarted. Nothing was changed. Ask for the plan again.");
    }
    if (stored.action !== action) {
      throw new StapleError("validation", `That consent is for ${stored.action}, not ${action}. Nothing was changed.`);
    }
    if (typeof digest !== "string" || !same(stored.digest, digest)) {
      throw new StapleError("validation", "The confirmation does not match the plan it names. Nothing was changed. Ask for the plan again.");
    }
    const plan = rebuild(stored.options);
    if (!same(stored.digest, planDigest(plan))) {
      throw new StapleError("conflict", "This machine changed while that plan was on screen, so it no longer describes what would happen. Nothing was changed. Ask for the plan again.", {
        reason: "plan_changed",
        plan,
      });
    }
    return { options: stored.options, plan };
  }

  clear(): void {
    this.tickets.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAtMs <= now) this.tickets.delete(id);
  }
}
