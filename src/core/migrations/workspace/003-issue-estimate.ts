import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 3 — plan-time estimates on issues.
 *
 * The one number nothing else in the schema can supply: what a human (or an
 * agent, at plan time) thought this would take. Everything on the other side of
 * the comparison — how long it ACTUALLY took — is already derivable from
 * `started_at` / `completed_at`, which is why this migration adds exactly one
 * column and no companions. There is deliberately no `elapsed_seconds`, no
 * `children_estimated_seconds`, no per-status cache: a stored derivation is a
 * value that goes stale between the write that should have refreshed it and the
 * read that trusts it, and the whole point of the claim-liveness precedent
 * (see `ClaimActivity` in core/types.ts) is that read-time derivation cannot.
 *
 * NULL means "no estimate recorded", and that is a distinct fact from zero — the
 * analytics surface has to be able to say "no estimate" rather than render a
 * fabricated 0 and a meaningless delta. So the column is nullable with no
 * DEFAULT: every row that existed before this migration correctly reads as
 * un-estimated rather than as estimated-at-nothing.
 *
 * `ALTER TABLE ADD COLUMN` appends to the stored `CREATE TABLE issues` text
 * rather than rewriting it, exactly as migration 002 did to `comments`. The
 * regenerated consolidated snapshot carries that appended tail verbatim, which
 * is what keeps the fresh-create fast path byte-equivalent to the walk.
 */
export const migration: Migration = {
  version: 3,
  name: "issue-estimate",
  up(db: DatabaseSync): void {
    db.exec("ALTER TABLE issues ADD COLUMN estimated_seconds INTEGER");
  },
};
