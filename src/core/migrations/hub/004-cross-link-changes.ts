import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 4: the hub records the cross-link changes THIS machine made (STA-287).
 *
 * ## Why publishing needs a record of what this machine did
 *
 * Several machines can publish one hub registry and converge on the same set, as long
 * as a publish never destroys anything it does not own. For registrations that is simple:
 * names are create-only and nothing is ever deleted. Cross-links are harder, because a
 * link can be removed and put back, and whether that should reach the other machines
 * depends on WHO removed it:
 *
 *   - A machine that merely lacks a link has no standing to retract it. It may never have
 *     adopted the link, or it may have parked the workspace at one end.
 *   - A machine that still holds a link another machine retracted has no standing to put
 *     it back either. Its copy is older than the retraction. It is not a fresh decision.
 *
 * You can't tell these cases apart by comparing this machine's links with the service's.
 * Two machines that legitimately hold the same repositories look the same by identity, by
 * name, and by everything else in the payload. What does tell them apart is a record
 * of what this machine itself DID. That record is hub-local state, and this table holds it.
 *
 * ## One row per link, holding this machine's latest act on it
 *
 * `present = 0` means `staple hub unlink` (or `Hub.removeCrossLink` from any surface)
 * removed the link here. The row stays after it is published. It is also this machine's
 * standing refusal to take the link back on adopt, the same role `registry_optouts`
 * plays for a registration. Re-linking the link here is the only thing that clears it.
 *
 * `present = 1` means `staple link` (`Hub.addCrossLink`) linked the link here after the
 * last publish. Once a publish has shared it, or has found that the service already
 * agrees, the row is deleted. An unpublished re-link is the ONLY thing that lets a publish
 * put back a link the service holds as retracted.
 *
 * `published` flips to 1 when a removal has been sent, or when a publish found nothing
 * on the service to retract. After that, the removal is never sent again. So a link
 * another machine deliberately re-links later stays re-linked on the service, and this
 * machine keeps its own copy removed, reporting that it did.
 *
 * ## `sent_epoch` and `sent_version`: exactly once, through a failed publish
 *
 * A publish can fail AFTER its operation landed: a later chunk fails, or the Worker
 * commits and the response is lost. The row is then still unsettled. If the next publish
 * only asked "does the service still disagree?", it would send the act again, with a
 * new opId because the entity's version has moved, so the service could not deduplicate
 * it. It would land over whatever another machine decided after seeing this one's act.
 *
 * So just before a row's operation is pushed, the epoch and the entity version it is
 * sent against are written here. On the next publish, if the service's entity is still
 * at that epoch and version, the operation did not land, and it is sent again: same base
 * version, same opId. If the entity has moved, the operation landed, or something newer
 * happened after this machine read it. Either way, sending it again would overrule a
 * later act, so the row is settled and nothing is sent. The epoch is part of the check
 * because a restore starts a new epoch and can reset versions, and an act that may have
 * landed before a restore must not be replayed over it.
 *
 * A stamp is kept only for an act that may have landed. When a push fails in a way that
 * proves it did not land (the service refused it with a 4xx, or answered 5xx and a
 * re-read shows the entity unmoved), `publishRegistry` clears the stamp again. Otherwise
 * a restore before the retry would make the stamp read as "superseded", and an act that
 * was never delivered would be settled without being sent (`unstampWhatDidNotLand` in
 * `hub-registry-service.ts`).
 *
 * Both are NULL until a publish sends the row, and a new act on the link resets them.
 *
 * ## Keyed on the portable identity, never on slugs
 *
 * `link_key` is the cross-link's entity id on the wire: the two workspaces'
 * `repository_id`s plus the two issue identifiers (`crossLinkEntityId` in
 * `hub-registry-ops.ts`). Slugs come from directory names and differ between machines
 * holding the same repository. A removal keyed on them would miss the same link published
 * by a machine that named the directory differently. The four parts are also stored as
 * separate columns, so a person reading this table does not have to decode the key.
 *
 * A link whose workspace has no recorded identity gets no row here. That link was never
 * publishable, so nothing on the service can need retracting.
 */
export const migration: Migration = {
  version: 4,
  name: "cross-link-changes",
  up(db: DatabaseSync): void {
    db.exec(`CREATE TABLE cross_link_changes (
  link_key TEXT PRIMARY KEY,
  blocker_repository_id TEXT NOT NULL,
  blocker_identifier TEXT NOT NULL,
  blocked_repository_id TEXT NOT NULL,
  blocked_identifier TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  sent_epoch INTEGER,
  sent_version INTEGER,
  changed_at TEXT NOT NULL
)`);
  },
};
