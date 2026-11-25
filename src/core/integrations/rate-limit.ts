import { StapleError } from "../types.js";

export interface BudgetClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const systemClock: BudgetClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

const WINDOW_MS = 60_000;
/** Longer than this and the caller hears `rate_limited` instead of a spinner. */
const MAX_WAIT_MS = 5_000;
/** A reset further out than this is treated as this; a provider never asks for longer. */
const MAX_BLOCK_MS = 3_600_000;

/**
 * One credential's request budget at a provider, enforced before each request. It starts
 * from the provider's published floor and then obeys what the server says: its advertised
 * limit, a reset when nothing remains, and Retry-After on a 429. A short wait is absorbed;
 * a long one is a typed retryable error, so a multi-request read fails whole rather than
 * returning a truncated page.
 */
export class RequestBudget {
  private sent: number[] = [];
  private blockedUntil = 0;
  constructor(private readonly provider: string, private limit: number, private readonly clock: BudgetClock = systemClock) {}

  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.sent = this.sent.filter(at => at > now - WINDOW_MS);
      const full = this.sent.length >= this.limit ? this.sent[this.sent.length - this.limit]! + WINDOW_MS - now : 0;
      const wait = Math.max(this.blockedUntil - now, full);
      if (wait <= 0) { this.sent.push(now); return; }
      if (wait > MAX_WAIT_MS) {
        const seconds = Math.ceil(wait / 1000);
        throw new StapleError("rate_limited", `${this.provider}'s rate limit is reached; try again in ${seconds} s.`, { retryAfterSeconds: seconds });
      }
      await this.clock.sleep(wait, signal);
    }
  }

  /** Learns from a response's headers. For a 429, returns how long until the provider accepts requests again. */
  observe(headers: Headers, status: number): number {
    const now = this.clock.now();
    const limit = Number(headers.get("x-ratelimit-limit"));
    if (Number.isSafeInteger(limit) && limit > 0) this.limit = limit;
    const reset = resetAt(headers.get("x-ratelimit-reset"), now);
    if (headers.get("x-ratelimit-remaining")?.trim() === "0" && reset !== null) this.blockedUntil = Math.max(this.blockedUntil, reset);
    if (status !== 429) return 0;
    const until = retryAfter(headers.get("retry-after"), now) ?? reset ?? now + WINDOW_MS;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    return until - now;
  }
}

/** A Unix timestamp in seconds or milliseconds; null when absent, unreadable or already past. */
function resetAt(value: string | null, now: number): number | null {
  const n = Number(value);
  if (!value?.trim() || !Number.isFinite(n) || n <= 0) return null;
  const at = n > 1e12 ? n : n * 1000;
  return at > now ? Math.min(Math.ceil(at), now + MAX_BLOCK_MS) : null;
}

/** Delta seconds or an HTTP date. */
function retryAfter(value: string | null, now: number): number | null {
  if (!value?.trim()) return null;
  const at = /^\d+$/.test(value.trim()) ? now + Number(value.trim()) * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now ? Math.min(at, now + MAX_BLOCK_MS) : null;
}

const budgets = new Map<string, RequestBudget>();

/** The process-wide budget for one provider credential. Keyed by a hash, never the credential itself. */
export function sharedBudget(key: string, provider: string, floor: number): RequestBudget {
  let budget = budgets.get(key);
  if (!budget) budgets.set(key, budget = new RequestBudget(provider, floor));
  return budget;
}
