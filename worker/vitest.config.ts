/**
 * The Worker's own test runner.
 *
 * `worker/` is a self-contained package with its own package.json, its own lockfile
 * and its own vitest, because both `@cloudflare/vitest-plugin` and its predecessor
 * `@cloudflare/vitest-pool-workers` require vitest 4.1+ while the repository root pins
 * vitest 3 across 173 test files. Two runners in one repository is the deliberate cost
 * of not dragging that suite through a major-version upgrade to satisfy a directory
 * that did not exist last week.
 *
 * Root `npm test` neither runs these tests nor is affected by them: the root
 * vitest.config.ts excludes `worker/**`, and `npm run test:worker` at the root
 * delegates in here.
 *
 * These tests run INSIDE the Workers runtime against Miniflare's D1. No network is
 * involved and none can be: there is no `wrangler dev` subprocess here at all, which
 * sidesteps the trap that `wrangler dev` defaults to REMOTE in Wrangler v4 and would
 * quietly make real network calls while appearing to prove the opposite.
 */
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // The real migration files, read from disk and applied to a fresh in-memory D1
      // per test file. The schema under test is therefore the schema that ships —
      // there is no second, hand-maintained copy to drift.
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          d1Databases: { DB: "staple-sync-test" },
        },
        // NOTE: there is no `isolatedStorage` option in @cloudflare/vitest-plugin@1.x
        // — the key exists in older `vitest-pool-workers` documentation and is
        // SILENTLY IGNORED here rather than rejected. Setting it and trusting it would
        // have produced order-dependent tests that pass alone and fail in a suite.
        // test/setup.ts truncates the tables in a global `beforeEach` instead, which
        // is explicit and does not depend on a framework feature that may not exist.
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
