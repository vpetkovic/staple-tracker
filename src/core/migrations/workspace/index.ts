import type { MigrationTarget } from "../types.js";
import { latestVersion } from "../types.js";
import { CONSOLIDATED_DDL } from "./consolidated.js";
import { migration as m001 } from "./001-initial-schema.js";
import { migration as m002 } from "./002-comment-idempotency.js";
import { migration as m003 } from "./003-issue-estimate.js";

/**
 * The workspace database — the per-repo (or global) task store.
 *
 * Append new migrations here in order. Never renumber, never edit a released
 * migration's `up`, and regenerate `consolidated.ts` afterwards
 * (`npx tsx scripts/regen-migration-snapshots.ts`) — the schema-equivalence
 * test fails with the exact replacement text if you forget.
 */
export const WORKSPACE_TARGET: MigrationTarget = {
  label: "workspace database",
  // `issues` has existed since version 1, so its absence means an empty file.
  sentinelTable: "issues",
  migrations: [m001, m002, m003],
  consolidated: CONSOLIDATED_DDL,
};

export const WORKSPACE_LATEST_VERSION = latestVersion(WORKSPACE_TARGET);
