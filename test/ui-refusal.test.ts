/**
 * A refused write has to show the store's own words.
 *
 * Written for U6 (STA-18) against the board's drag-and-drop. V2 (STA-87) deleted the
 * board and KEPT THIS, because the property it pins was never about dragging — it is
 * about the chain, and the chain now ends at the command palette and V3's drawer instead
 * of at a card. Renamed from ui-board-refusal.test.ts; the fixtures and assertions below
 * are unchanged.
 *
 * staple has no transition table. The reason a transition is illegal exists in exactly
 * one place: the sentence `updateIssue`/`checkoutIssue` throws. So the property under
 * test is not "the board shows an error" — it is that the sentence the *real store*
 * produced survives the whole chain unaltered:
 *
 *     store guard  →  StapleError  →  errorEnvelope  →  409 JSON  →  ApiError
 *                  →  describeRefusal()  →  what the UI renders
 *
 * That is why this suite drives the actual UI server over HTTP instead of hand-writing
 * envelopes. A hand-written fixture would keep passing after someone reworded a guard,
 * which is the exact regression that would make the UI lie.
 *
 * It lives in test/ (Node side) rather than beside the UI, because provoking a real
 * guard needs a real SQLite workspace. `refusal.ts` is importable from here precisely
 * because it is pure — no DOM, no `@/` alias, no lib/api import.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { describeRefusal, type Refusal } from "../src/ui/app/src/lib/refusal.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
/** ref -> identifier, for the fixtures each guard needs. */
const refs: Record<string, string> = {};

/**
 * Exactly what the browser does: POST the action, and on a non-2xx turn the envelope
 * into the object lib/api.ts's ApiError would be. ApiError copies message/code/
 * retryable/detail straight off the envelope, so feeding the parsed body to
 * describeRefusal is the same input the real card gets.
 */
async function dropOnto(ref: string, status: string): Promise<{ ok: boolean; refusal: Refusal; http: number }> {
  const res = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": token, origin },
    body: JSON.stringify({ actor: "ui", ref, type: "status", status }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { ok: res.ok, refusal: describeRefusal(body), http: res.status };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-boardrefusal-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "boardrefusal" });

  refs.unassigned = ws.store.createIssue({ title: "Nobody owns this" }).identifier;
  refs.assigned = ws.store.createIssue({ title: "Owned", assignee: "kim" }).identifier;
  const blockerA = ws.store.createIssue({ title: "Blocker A" }).identifier;
  const blockerB = ws.store.createIssue({ title: "Blocker B" }).identifier;
  refs.blockerA = blockerA;
  refs.blockerB = blockerB;
  refs.blocked = ws.store.createIssue({
    title: "Waiting on two things",
    assignee: "kim",
    blockedBy: [blockerA, blockerB],
  }).identifier;

  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a status write the store refuses", () => {
  it("shows the assignee guard in the store's own words, not a paraphrase", async () => {
    const { ok, http, refusal } = await dropOnto(refs.unassigned!, "in_progress");
    expect(ok).toBe(false);
    expect(http).toBe(409);
    // Verbatim. If someone "improves" this to "needs an assignee", the UI is
    // inventing a guard the store never stated.
    expect(refusal.message).toBe("in_progress requires an assignee");
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
    expect(refusal.fromServer).toBe(true);
    expect(refusal.blockers).toEqual([]);
  });

  it("names the blockers, both in the sentence and as chips off detail.blockers", async () => {
    const { ok, refusal } = await dropOnto(refs.blocked!, "in_progress");
    expect(ok).toBe(false);
    expect(refusal.message).toBe(`Cannot start: unresolved blockers ${refs.blockerA}, ${refs.blockerB}`);
    // The chips come from the envelope, not from re-parsing the sentence.
    expect(refusal.blockers).toEqual([refs.blockerA, refs.blockerB]);
    expect(refusal.code).toBe("validation");
  });

  it("stops refusing the moment the blockers resolve — the guard is live, not a table", async () => {
    for (const blocker of [refs.blockerA!, refs.blockerB!]) {
      const res = await fetch(`${origin}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-staple-token": token, origin },
        body: JSON.stringify({ actor: "ui", ref: blocker, type: "status", status: "done" }),
      });
      expect(res.status).toBe(200);
    }
    const { ok } = await dropOnto(refs.blocked!, "in_progress");
    expect(ok).toBe(true);
  });

  it("passes a not_found through untouched rather than dressing it as a guard", async () => {
    const { http, refusal } = await dropOnto("STA-99999", "done");
    expect(http).toBe(404);
    expect(refusal.code).toBe("not_found");
    expect(refusal.message).toContain("No issue matches");
    expect(refusal.fromServer).toBe(true);
  });

  it("lets a legal write through, so this is not just a refusal machine", async () => {
    const { ok, http } = await dropOnto(refs.assigned!, "in_progress");
    expect(ok).toBe(true);
    expect(http).toBe(200);
  });
});

describe("describeRefusal on things that never reached the store", () => {
  it("degrades a bare Error to its message", () => {
    expect(describeRefusal(new Error("Failed to fetch"))).toEqual({
      message: "Failed to fetch",
      code: "unknown",
      blockers: [],
      retryable: false,
      fromServer: true,
    });
  });

  it("says plainly that there was no reason, rather than inventing one", () => {
    const refusal = describeRefusal({});
    expect(refusal.fromServer).toBe(false);
    expect(refusal.message).toBe("the change was refused, and the server did not say why");
  });

  it("survives a non-object rejection", () => {
    expect(describeRefusal(undefined).message).toBe("the change was refused");
    expect(describeRefusal("boom").message).toBe("boom");
  });

  it("ignores a detail.blockers that is not a list of identifiers", () => {
    expect(describeRefusal({ message: "x", detail: { blockers: "STA-1" } }).blockers).toEqual([]);
    expect(describeRefusal({ message: "x", detail: { blockers: [1, "STA-2"] } }).blockers).toEqual(["STA-2"]);
  });
});
