import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 19: instruction documents (`design/runs.md`, "Instruction documents").
 *
 * ## On the revision, not on the document
 *
 * `document_revisions.instructions` says whether that revision is an instruction document:
 * text the tracker hands to every ticket beneath its issue (descendants by parent, members of
 * a milestone and their descendants) and to every run that takes one of them. The document
 * is an instruction document when its head revision says so.
 *
 * The flag lives on the revision because the revision is what travels. Only the
 * `documentRevision` create is journaled (`putDocument`): the `documents` row is a pointer
 * its receiver re-derives. A flag on the pointer would need an operation of its own, and a
 * receiver applying the pointer before the body would show a flag over content that had not
 * arrived. On the revision, it arrives with the body, in the payload field `instructions`,
 * and an operation from an older device that has no such field reads as `false`. Turning
 * the flag on or off is a new revision, so history shows when a document started or stopped
 * being instructions.
 *
 * ## The run's own instructions
 *
 * `runs.instructions` is JSON `[{key, body}]` from `run start --instructions <file>`: the
 * instructions a person gave this one run. Runs are machine-local, and so are these.
 * `runs.instructions_seq` is the event watermark of what the run has already reported: an
 * `instructions_changed` event after it is news to the run's next take.
 *
 * Additive. The number is the `schema` every operation carries, so a device that has not
 * migrated refuses a page stamped 19 with `schema_ahead` until it upgrades. No new entity,
 * no protocol change: the Worker carries the payload field without knowing it.
 */
export const migration: Migration = {
  version: 19,
  name: "instruction-documents",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE document_revisions ADD COLUMN instructions INTEGER NOT NULL DEFAULT 0 CHECK (instructions IN (0, 1));
      ALTER TABLE runs ADD COLUMN instructions TEXT;
      ALTER TABLE runs ADD COLUMN instructions_seq INTEGER;
    `);
  },
};
