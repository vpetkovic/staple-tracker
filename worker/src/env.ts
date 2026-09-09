/**
 * Bindings and configuration. Nothing here holds a secret value in source: `DB` is a
 * binding resolved at runtime and `PLAN` is a plain string.
 */

export type Plan = "free" | "paid";

/**
 * The rate limiter's shape, declared locally rather than imported.
 *
 * It is declared optional on `Env` because the binding is not always present — a
 * `wrangler dev --local` run and some test configurations have no limiter — and a
 * missing limiter must fail OPEN rather than 500 the service. Rate limiting is abuse
 * control here, not an authorization control: authorization is the credential lookup,
 * which is never optional.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;

  /**
   * Selects the advertised batch ceiling. `free` (the default) advertises 25
   * operations per push, `paid` advertises 200. It is a var, not a secret, and it is
   * committed in wrangler.toml — getting it wrong costs throughput, never
   * correctness, because the server enforces whatever it advertises.
   */
  PLAN?: string;

  SYNC_LIMITER?: RateLimiter;

  /**
   * Test-only escape for the TLS requirement. Absent in every committed
   * configuration; see `assertTls` in http.ts for why loopback does not need it.
   */
  ALLOW_INSECURE?: string;
}
