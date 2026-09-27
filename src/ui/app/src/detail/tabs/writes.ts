/**
 * The two writes the tabs make — a comment, and restoring an old document revision — as
 * plain descriptors, so who a write is signed with is decided in one tested place.
 *
 * The rule is the detail's: the person's own name (`personActor()` from ../parts, the
 * browser's "who I am") when they have given one, and no actor otherwise, so the server
 * signs it "ui" and the page shows "Someone in the web app". Never the working name (the
 * last Start work name, which may be an agent's).
 *
 * The server takes an actor on both: POST /api/action reads `body.actor || "ui"` and passes
 * it as the comment's author and the restored revision's author (src/ui/server.ts).
 */
import type { ActionPayload } from "@/lib/types";

export interface TabWrite {
  target: { ws: string; ref: string; actor?: string };
  payload: ActionPayload;
}

const signed = (ws: string, ref: string, person: string | null | undefined) => ({
  ws,
  ref,
  ...(person ? { actor: person } : {}),
});

/** A comment on the pane's issue, by id (`lib/write-ref.ts`), signed by the person when known. */
export function commentWrite(ws: string, issueId: string, body: string, person: string | null | undefined): TabWrite {
  return { target: signed(ws, issueId, person), payload: { type: "comment", body } };
}

/** Restore `revision` of `key` as a new revision, against the revision this page believed current. */
export function restoreWrite(
  ws: string,
  issueId: string,
  key: string,
  revision: number,
  baseRevision: number,
  person: string | null | undefined,
): TabWrite {
  return { target: signed(ws, issueId, person), payload: { type: "doc_restore", key, revision, baseRevision } };
}
