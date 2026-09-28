import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 17: who owns a parent's status, stored where every device can read it
 * (`docs/semantics.md`, "A parent's status is derived from its children").
 *
 * ## The column
 *
 * `issues.derived_status` is the status derivation last wrote on the row, and NULL once
 * anybody else has moved it. A parent's status belongs to derivation — the reversibility law
 * lets derivation move it out of the active, review, blocked and closed bands — exactly when
 * `derived_status = status`.
 *
 * It used to be read from the event log alone: the newest status-moving event had to be a
 * derived `status_changed` that landed on the row's status. Events never replicate (they are
 * re-emitted from what an operation narrates), and a snapshot or a join seed narrates nothing,
 * so a device that hydrated held no events for what it pulled and read every derived parent as
 * set by hand. Work landing there never closed its epic or its milestone. A column replicates:
 * it is the issue field `derivedStatus` on the wire, in the snapshot, in a seed and in a
 * backup, like any other.
 *
 * ## Cleared by any other move, whichever path makes it
 *
 * The invariant is `derived_status IS NULL OR derived_status = status`, held by two triggers.
 * After an update of the status, the column or the claim, the column is cleared when
 *
 *  - it names a status the row does not hold — whatever wrote it, an operation from a device
 *    that has not caught up included; or
 *  - it did not move while the status or the claim did, and it was valid before. That is
 *    somebody else's move: derivation's own write sets both in one statement.
 *
 * The "valid before" half is what keeps derivation's write when the old value was stale: a row
 * `{todo, done}` that derivation closes to `{done, done}` leaves the column unchanged, and
 * without it that write would be read as a hand move and cleared. With the invariant held,
 * that row cannot arise any more; the clause makes the trigger right on it all the same. A new
 * row whose column names another status is cleared the same way. Derivation's own write sets
 * both in one statement, so only it keeps the column;
 * every other door — a status write from the CLI, MCP or the UI, a gate, a checkout, a steal,
 * a release, a vocabulary migration, an applied operation from a device that is not on this
 * build — clears it, as a manual event made the log's answer "manual" before. Stated once, in
 * the schema, so no future path can forget it. The capture that journals a mutation's changed
 * columns (`cloud/row-diff.ts`) sees the cleared column like any other, so the clear travels.
 *
 * ## Backfilled from the rule it replaces
 *
 * A row the event log says derivation owns gets `derived_status = status`; every other row
 * stays NULL. A device that hydrated has no events to backfill from, and the service's fold
 * holds no `derivedStatus` for anything written before this version, so a device that did
 * backfill owes the service what it found: the `meta` key `derived_status_publish_owed`, which
 * its next sync pays after the pull reaches the head (`publishDerivedStatuses`).
 *
 * ## Why a migration
 *
 * The fact must live on the row to travel with it. Additive: one nullable column and one
 * trigger. The number is the `schema` every operation carries, so every device upgrades
 * together, as for 013 to 016; the service stores the new field verbatim and needs nothing.
 */
export const migration: Migration = {
  version: 17,
  name: "derived-status",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE issues ADD COLUMN derived_status TEXT;

      UPDATE issues SET derived_status = status
       WHERE EXISTS (
         SELECT 1 FROM events e
          WHERE e.seq = (
                  SELECT MAX(seq) FROM events
                   WHERE issue_id = issues.id
                     AND kind IN ('issue_created', 'status_changed', 'checkout', 'claim_stolen', 'release', 'claim_released_stale')
                )
            AND e.kind = 'status_changed'
            AND json_valid(e.payload)
            AND json_type(e.payload, '$.derived') = 'text'
            AND json_extract(e.payload, '$.to') = issues.status
       );

      INSERT INTO meta (key, value)
      SELECT 'derived_status_publish_owed', '1'
       WHERE EXISTS (SELECT 1 FROM issues WHERE derived_status IS NOT NULL);

      CREATE TRIGGER issues_derived_status_cleared
      AFTER UPDATE OF status, derived_status, checkout_agent, checkout_at ON issues
      WHEN NEW.derived_status IS NOT NULL
       AND (
             NEW.derived_status IS NOT NEW.status
          OR (    NEW.derived_status IS OLD.derived_status
              AND OLD.derived_status IS OLD.status
              AND (NEW.status IS NOT OLD.status OR NEW.checkout_agent IS NOT OLD.checkout_agent OR NEW.checkout_at IS NOT OLD.checkout_at))
           )
      BEGIN
        UPDATE issues SET derived_status = NULL WHERE id = NEW.id;
      END;

      CREATE TRIGGER issues_derived_status_created
      AFTER INSERT ON issues
      WHEN NEW.derived_status IS NOT NULL AND NEW.derived_status IS NOT NEW.status
      BEGIN
        UPDATE issues SET derived_status = NULL WHERE id = NEW.id;
      END;
    `);
  },
};
