import type { MigrationTarget } from "../types.js";
import { latestVersion } from "../types.js";
import { CONSOLIDATED_DDL } from "./consolidated.js";
import { migration as m001 } from "./001-initial-schema.js";
import { migration as m002 } from "./002-comment-idempotency.js";
import { migration as m003 } from "./003-issue-estimate.js";
import { migration as m004 } from "./004-workspace-settings.js";
import { migration as m005 } from "./005-issue-kind.js";
import { migration as m006 } from "./006-approval-gates.js";
import { migration as m007 } from "./007-milestones.js";
import { migration as m008 } from "./008-queue-entries.js";
import { migration as m009 } from "./009-projects.js";
import { migration as m010 } from "./010-sync-metadata.js";
import { migration as m011 } from "./011-sync-field-writes.js";
import { migration as m012 } from "./012-host-binding.js";
import { migration as m013 } from "./013-execution-attempts.js";
import { migration as m014 } from "./014-lifecycle-capture.js";
import { migration as m015 } from "./015-autopilot-runs.js";
import { migration as m016 } from "./016-milestone-goals.js";
import { migration as m017 } from "./017-derived-status.js";
import { migration as m018 } from "./018-attachments.js";
import { migration as m019 } from "./019-instruction-documents.js";
import { migration as m020 } from "./020-plan-fields.js";
import { migration as m021 } from "./021-plan-delivered.js";
import { migration as m023 } from "./023-external-context-sharing.js";
import { migration as m022 } from "./022-external-links.js";
import { migration as m024 } from "./024-ticket-branch.js";
import { migration as m025 } from "./025-attempt-heartbeats.js";
import { migration as m026 } from "./026-idea-numbers.js";
import { migration as m027 } from "./027-plan-link-purpose.js";
import { migration as m028 } from "./028-plan-ticket-number.js";
import { migration as m029 } from "./029-plan-explored.js";
import { migration as m030 } from "./030-plan-blockers.js";

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
 * The list closed up at the merge that produced this file: the O integration
 * branch brought 004 (workspace settings) and 005 (issue kind), and the
 * approval-gates branch renumbered to 006 because it merged second. 001..006
 * with no hole, which is what every database on disk needs in order to reach the
 * latest version by walking. 007 (milestones, STA-172) followed as latest+1,
 * 008 (the pickup queue, STA-167) after it, and 009 (tracked projects) after
 * that. 010 (the local sync tables) is the next in the same line — purely
 * additive, eight new tables, no existing table touched. 011 (field-write
 * provenance) follows it and is additive in the same way: one table, backfilled
 * from the outbox, so conflict detection stops depending on rows that routine
 * compaction is entitled to delete. 012 (the host binding) follows, one nullable
 * column on `sync_state` that only a home-resident workspace ever writes. 013
 * (execution attempts) follows: two new tables that replicate as protocol-3 entities, and
 * two nullable `sync_state` columns recording where the last pull reached the head. 014
 * (the lifecycle work) follows: the attempt's lane, and the events' cross-device order. 015
 * (autopilot runs) follows: two machine-local tables no operation ever names. 016
 * (milestone goal mode) follows: one machine-local table of criterion marks and three
 * nullable `runs` columns, also never named by an operation. 017 (derived status) follows:
 * one nullable `issues` column that replicates as the issue field `derivedStatus`, and the
 * trigger that clears it when anything but derivation moves the row. 018 (attachments)
 * follows: two new tables, the metadata replicating as the `attachment` entity and the
 * bytes staying local except when a create inlines them. 019 (instruction documents) follows:
 * one column on `document_revisions` that rides in the revision's payload, and two machine-local
 * `runs` columns. 020 (the plan layer) follows: seven nullable `issues` columns that ride the
 * `issue` entity as fields, and `plan_links` and `plan_rows`, one row per link and per breakdown row, each a field of the idea's `milestone` entity. 021 (delivered outside the tracker) follows: one nullable `issues`
 * column that rides the `issue` entity as a field, like 020's. 022 adds permanent external
 * identities and many-to-many issue links with explicit PR stack metadata. 023 keeps provider context
 * private unless shared. 024 (the ticket branch) follows: two nullable `issues` columns that ride the
 * `issue` entity as fields, like 021's. 025 (the attempt heartbeat) follows: one machine-local table,
 * one row per attempt, never named by an operation, like 015's. 026 (idea numbers) follows: one nullable
 * `issues` column, the number a promoted idea keeps, that rides the `issue` entity as a field, like 021's. 027 (link purpose) follows: one
 * `plan_links` column, delivery or exploration, that rides the link's own field of the idea's `milestone` entity. 028 (the kept ticket
 * number) follows: one nullable `issues` column, the number a ticket converted into an idea keeps, that rides the `issue` entity as a field, like 026's.
 * `plan_links` column, delivery or exploration, that rides the link's own field of the idea's `milestone` entity. 028 (the kept ticket
 * number) follows: one nullable `issues` column, the number a ticket converted into an idea keeps, that rides the `issue` entity as a field, like 026's. 029 (explored) follows: one nullable
 * `issues` column, set once an idea is made more complete while raw, that rides the `issue` entity as a field, like 021's. 030 (idea blockers)
 * follows: `plan_blockers`, one row per edge between plan records, each a field of the blocked record's `milestone` entity, like 020's links.
 */
export const WORKSPACE_TARGET: MigrationTarget = {
  label: "workspace database",
  // `issues` has existed since version 1, so its absence means an empty file.
  sentinelTable: "issues",
  migrations: [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022, m023, m024, m025, m026, m027, m028, m029, m030],
  consolidated: CONSOLIDATED_DDL,
};

export const WORKSPACE_LATEST_VERSION = latestVersion(WORKSPACE_TARGET);
