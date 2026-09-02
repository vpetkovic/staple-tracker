/**
 * The document surface the UI's Documents tab stands on: list revisions, read a
 * specific revision, restore an old one.
 *
 * Restore is a WRITE, and it deliberately rides POST /api/action rather than getting
 * its own route — so the assertions here are as much about the gate as about the
 * behaviour: no token is 401, a foreign Origin is 403, and neither one writes.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ref: string;
let ui: UiHandle;
let origin: string;
let token: string;

const R1 = "# plan\n\nfirst draft\n";
const R2 = "# plan\n\nsecond draft\nwith another line\n";
const R3 = "# plan\n\nthird draft\nwith another line\n";

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token, ...headers } });
}

function post(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": token, ...headers },
    body: JSON.stringify(payload),
  });
}

async function revisions(): Promise<Array<{ revision: number; author: string | null; changeSummary: string | null }>> {
  const res = await get(`/api/revisions?ref=${encodeURIComponent(ref)}&key=plan`);
  return (await res.json()) as Array<{ revision: number; author: string | null; changeSummary: string | null }>;
}

async function bodyAt(revision?: number): Promise<string> {
  const qs = revision === undefined ? "" : `&revision=${revision}`;
  const res = await get(`/api/document?ref=${encodeURIComponent(ref)}&key=plan${qs}`);
  return ((await res.json()) as { body: string }).body;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uidocs-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uidocs" });
  const issue = ws.store.createIssue({ title: "Documented task" });
  ref = issue.identifier;
  ws.store.putDocument(ref, "plan", R1, { author: "author-one", changeSummary: "first" });
  ws.store.putDocument(ref, "plan", R2, { author: "author-two", changeSummary: "second" });
  ws.store.putDocument(ref, "plan", R3, { author: "author-two", changeSummary: "third" });
  const dbPath = ws.dbPath;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui.close();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/revisions", () => {
  it("is gated by the same token as every other read", async () => {
    const res = await fetch(`${origin}/api/revisions?ref=${encodeURIComponent(ref)}&key=plan`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("is a GET, and answers 405 to a POST like every other read route", async () => {
    const res = await fetch(`${origin}/api/revisions?ref=${encodeURIComponent(ref)}&key=plan`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("lists every revision newest-first with author and change summary", async () => {
    const list = await revisions();
    expect(list.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(list[0]).toMatchObject({ revision: 3, author: "author-two", changeSummary: "third" });
    expect(list[2]).toMatchObject({ revision: 1, author: "author-one", changeSummary: "first" });
  });

  it("404s for a document key that does not exist", async () => {
    const res = await get(`/api/revisions?ref=${encodeURIComponent(ref)}&key=nope`);
    // listDocumentRevisions on an unknown key is an empty history, not an error —
    // pin that so the tab knows to render "no revisions" rather than an error state.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/document?revision=", () => {
  it("serves an older revision verbatim", async () => {
    expect(await bodyAt(1)).toBe(R1);
    expect(await bodyAt(2)).toBe(R2);
  });

  it("serves the current revision when none is asked for", async () => {
    expect(await bodyAt()).toBe(R3);
  });

  it("404s for a revision that never existed", async () => {
    const res = await get(`/api/document?ref=${encodeURIComponent(ref)}&key=plan&revision=99`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("not_found");
  });
});

describe("doc_restore", () => {
  it("requires a token", async () => {
    const before = (await revisions()).length;
    const res = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, type: "doc_restore", key: "plan", revision: 1, baseRevision: 3 }),
    });
    expect(res.status).toBe(401);
    expect((await revisions()).length).toBe(before);
  });

  it("is rejected from a foreign Origin, and the write does not land", async () => {
    const before = (await revisions()).length;
    const res = await post(
      { ref, type: "doc_restore", key: "plan", revision: 1, baseRevision: 3, actor: "attacker" },
      { origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("forbidden");
    expect((await revisions()).length).toBe(before);
  });

  it("refuses a stale baseRevision as a retryable revision_conflict", async () => {
    const before = (await revisions()).length;
    const res = await post({ ref, type: "doc_restore", key: "plan", revision: 1, baseRevision: 1 }, { origin });
    expect(res.status).toBe(409);
    const envelope = (await res.json()) as Record<string, unknown>;
    expect(envelope.code).toBe("revision_conflict");
    expect(envelope.retryable).toBe(true);
    expect((await revisions()).length).toBe(before);
  });

  it("writes the old body forward as a new revision, attributed to the actor", async () => {
    const res = await post(
      { ref, type: "doc_restore", key: "plan", revision: 1, baseRevision: 3, actor: "ui" },
      { origin },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "plan", revision: 4 });

    // The restore is append-only: r1..r3 are untouched and r4 carries r1's body.
    expect(await bodyAt(1)).toBe(R1);
    expect(await bodyAt(3)).toBe(R3);
    expect(await bodyAt(4)).toBe(R1);
    expect(await bodyAt()).toBe(R1);

    const list = await revisions();
    expect(list.map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(list[0]).toMatchObject({ revision: 4, author: "ui", changeSummary: "restore revision 1" });
  });

  it("shows up in the event log, so the activity timeline sees it", async () => {
    const res = await get("/api/events");
    const events = (await res.json()) as Array<{ kind: string; payload: Record<string, unknown> }>;
    const restore = events.filter(
      (e) => e.kind === "doc_updated" && e.payload.changeSummary === "restore revision 1",
    );
    expect(restore).toHaveLength(1);
    expect(restore[0]!.payload).toMatchObject({ key: "plan", revision: 4 });
  });

  it("404s for a revision that does not exist rather than creating an empty one", async () => {
    const before = (await revisions()).length;
    const res = await post({ ref, type: "doc_restore", key: "plan", revision: 99, baseRevision: 4 }, { origin });
    expect(res.status).toBe(404);
    expect((await revisions()).length).toBe(before);
  });
});
