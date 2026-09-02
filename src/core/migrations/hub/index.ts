import type { MigrationTarget } from "../types.js";
import { latestVersion } from "../types.js";
import { CONSOLIDATED_DDL } from "./consolidated.js";
import { migration as m001 } from "./001-initial-schema.js";
import { migration as m002 } from "./002-meta-and-versioning.js";

/**
 * The hub database — machine-wide registry and cross-workspace links.
 *
 * Append new migrations here in order. Never renumber, never edit a released
 * migration's `up`, and regenerate `consolidated.ts` afterwards
 * (`npx tsx scripts/regen-migration-snapshots.ts`).
 */
export const HUB_TARGET: MigrationTarget = {
  label: "hub database",
  // `workspaces` has existed since version 1; a hub with it and no version row
  // is a pre-A4 hub, which is what every hub on disk today looks like.
  sentinelTable: "workspaces",
  migrations: [m001, m002],
  consolidated: CONSOLIDATED_DDL,
};

export const HUB_LATEST_VERSION = latestVersion(HUB_TARGET);
