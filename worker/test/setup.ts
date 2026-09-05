import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

/**
 * The migrations binding is injected by vitest.config.ts and exists only under test,
 * so it is not in the Env that `wrangler types` generates from wrangler.toml. Augment
 * `Cloudflare.Env` rather than the older `ProvidedEnv`, which this plugin version no
 * longer consults.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

/**
 * Apply the real `worker/migrations/*.sql` to the test database before anything runs.
 *
 * Migrations are read from disk by vitest.config.ts, so these tests exercise the same
 * DDL that `wrangler d1 migrations apply` puts on the dev database. A schema bug is a
 * test failure here rather than a surprise at deploy.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/**
 * Truncate between tests, explicitly.
 *
 * `@cloudflare/vitest-plugin@1.x` has NO `isolatedStorage` option — the key appears in
 * older `vitest-pool-workers` documentation and is silently ignored by this version
 * rather than rejected. Relying on it produced exactly the failure mode you would
 * expect: sequence numbers accumulating across tests, so every test passed alone and
 * the suite failed as a whole.
 *
 * Sequence assignment is the thing this service exists to get right, and it is stateful
 * by definition, so its tests need a genuinely empty log. This is that guarantee,
 * written out rather than assumed.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ops"),
    env.DB.prepare("DELETE FROM leases"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM repos"),
  ]);
});
