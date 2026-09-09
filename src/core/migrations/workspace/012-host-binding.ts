import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 12 — which machine minted this workspace's identity (contract in
 * `docs/sync.md`, "A copied home is not a second device").
 *
 * ## Why 12
 *
 * Latest is 011 (field-write provenance) and this is the next number. The rule
 * in `index.ts` still applies: if another branch merges a 012 first, this one
 * renumbers to latest+1 at merge time and never skips ahead.
 *
 * ## One nullable column, and why NULL is the interesting value
 *
 * `sync_state.origin_host` is a digest of the machine that minted this
 * workspace's sync identity, written by every workspace whose identity cannot
 * travel without its database. That was home-resident workspaces when this
 * migration was written and is every workspace outside a version control
 * checkout since STA-281; the column, its type and its meaning are unchanged,
 * only the set of workspaces that writes it is wider. Every checkout-backed
 * workspace leaves it NULL, and every check reads NULL as "not host-bound" and
 * does nothing at all.
 *
 * That is not a shortcut, it is the semantic. One repository id held by two
 * machines is what a clone IS, and the whole sync design depends on two clones
 * converging rather than refusing each other. A clone also arrives with the
 * manifest and no database, so it mints its own local state and there is nothing
 * to confuse. A home restored onto a second machine is the opposite case in
 * every respect: it arrives with the database, the cursor, the client-sequence
 * allocator and the device credential, at the same absolute path, and if it were
 * allowed to sync it would mint operation ids the other machine has already
 * used — the silent-discard failure `010-sync-metadata.ts` describes for
 * `client_seq_high_water`, arriving by a road nothing was watching.
 *
 * NULL is therefore what keeps the checkout-backed path provably unchanged by
 * this migration: a workspace that never writes the column can never be refused
 * by a check that only fires when it is set.
 *
 * ## Why a column and not a file
 *
 * The identity itself is a file, because a clone has to recover it from the tree
 * with no database to read. This value has the opposite requirement: it must
 * travel with the copy (so the mismatch is visible at all) and it must be
 * readable everywhere a sync could start. Every such place already holds an open
 * database handle and none of them holds a path, so a column costs no plumbing
 * where a file would have added an argument to `syncRepository`,
 * `cloudSurfaceReport` and every surface between them.
 *
 * It also inherits two properties for free. `sync_state` does not replicate — no
 * row in the tables from 010 ever leaves this device — so the binding cannot
 * propagate to another machine and make its problem worse. And
 * `forkRepositoryId` already clears `sync_state`, so a fork drops the stale
 * binding in the same statement it drops the positions it was already dropping,
 * with no new code to forget.
 *
 * ## Purely additive
 *
 * One `ALTER TABLE ... ADD COLUMN` on a table introduced two migrations ago,
 * with no default and no backfill. An upgraded workspace reads NULL, behaves
 * exactly as it did, and only starts recording anything if it is opened as a
 * host-bound workspace by a build that knows about this column.
 */
export const migration: Migration = {
  version: 12,
  name: "host-binding",
  up(db: DatabaseSync): void {
    db.exec("ALTER TABLE sync_state ADD COLUMN origin_host TEXT");
  },
};
