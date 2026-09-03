import type { MigrationTarget } from "../types.js";
import { latestVersion } from "../types.js";
import { CONSOLIDATED_DDL } from "./consolidated.js";
import { migration as m001 } from "./001-initial-schema.js";
import { migration as m002 } from "./002-comment-idempotency.js";
import { migration as m003 } from "./003-issue-estimate.js";
import { migration as m006 } from "./006-approval-gates.js";

/**
 * The workspace database — the per-repo (or global) task store.
 *
 * Append new migrations here in order. Never renumber, never edit a released
 * migration's `up`, and regenerate `consolidated.ts` afterwards
 * (`npx tsx scripts/regen-migration-snapshots.ts`) — the schema-equivalence
 * test fails with the exact replacement text if you forget.
 *
 * The list is ORDERED and CONTIGUOUS IN MERGE ORDER, and it must stay that way.
 * `applyPending` filters on `version > current` and the stamp is monotonic, so a
 * database that steps over a hole can never come back for it — a skipped number
 * is not reserved space, it is space permanently unreachable for everyone who
 * passed it. When two branches both want the next number, whichever merges
 * SECOND renumbers to latest+1; neither skips ahead to avoid the collision.
 *
 * The gap between 003 and 006 here is that rule applied, not a violation of it:
 * this branch merges after the O integration branch (004 workspace settings, 005
 * issue kind), so 006 was latest+1 at merge time. Those two arrive with that
 * merge and the list closes up. A database that steps over 004/005 never
 * receives them, which is exactly why neither branch was allowed to skip ahead.
 */
export const WORKSPACE_TARGET: MigrationTarget = {
  label: "workspace database",
  // `issues` has existed since version 1, so its absence means an empty file.
  sentinelTable: "issues",
  migrations: [m001, m002, m003, m006],
  consolidated: CONSOLIDATED_DDL,
};

export const WORKSPACE_LATEST_VERSION = latestVersion(WORKSPACE_TARGET);
