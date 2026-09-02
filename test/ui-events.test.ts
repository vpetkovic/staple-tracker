/**
 * GET /api/events?issue= — the issue-scoped window the activity timeline reads.
 *
 * The parameter is additive: omitting it must behave exactly as it did before, because
 * the workspace-wide log is still what the rest of the page uses. What is worth pinning
 * is that adding it does not open a hole (same token gate, same GET pin) and that it
 * actually reaches past the unfiltered route's 100-event cap, which is the reason it
 * exists at all.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

interface WireEvent {
  seq: number;
  kind: string;
  issueId: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  dedupKey: string | null;
  createdAt: string;
}

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let subject: string;
let subjectId: string;
let other: string;

function get(path: string) {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

async function events(query: string): Promise<WireEvent[]> {
  const res = await get(`/api/events${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as WireEvent[];
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uievents-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uievents" });

  const issue = ws.store.createIssue({ title: "The subject" });
  subject = issue.identifier;
  subjectId = issue.id;
  other = ws.store.createIssue({ title: "Something else entirely" }).identifier;

  // Push the subject's early history well past the unfiltered route's 100-event cap
  // by generating noise on the other issue afterwards.
  ws.store.checkoutIssue(subject, "opus-detail");
  ws.store.updateIssue(subject, { status: "in_progress" }, "opus-detail");
  ws.store.addComment(subject, "first comment", "opus-detail", "agent");
  ws.store.putDocument(subject, "plan", "# plan\n", { author: "opus-detail", changeSummary: "first" });
  for (let i = 0; i < 140; i += 1) {
    ws.store.addComment(other, `noise ${i}`, "noisy", "agent");
  }
  ws.store.updateIssue(subject, { status: "in_review" }, "opus-detail");

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

describe("GET /api/events?issue=", () => {
  it("is behind the same token gate as the unfiltered route", async () => {
    const res = await fetch(`${origin}/api/events?issue=${encodeURIComponent(subject)}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("is still a GET — the filter does not smuggle in a second write path", async () => {
    const res = await fetch(`${origin}/api/events?issue=${encodeURIComponent(subject)}`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("returns only this issue's events", async () => {
    const rows = await events(`?issue=${encodeURIComponent(subject)}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.issueId === subjectId)).toBe(true);
  });

  it("reaches history the unfiltered 100-event window cannot", async () => {
    const unfiltered = await events("");
    const scoped = await events(`?issue=${encodeURIComponent(subject)}`);

    // listEvents() is `seq > since ORDER BY seq LIMIT 100`, so the unfiltered route
    // returns the OLDEST hundred. Once another issue has generated a hundred events,
    // the subject's most recent transition is outside that window entirely — the
    // timeline would show the story up to a point and then just stop.
    const inReview = (row: WireEvent) => row.kind === "status_changed" && row.payload.to === "in_review";
    expect(unfiltered.some((row) => row.issueId === subjectId && inReview(row))).toBe(false);

    // The scoped route takes the NEWEST 500 for the issue and returns them oldest-first,
    // which for one issue is its whole life: both ends are present.
    expect(scoped.some((row) => row.kind === "issue_created")).toBe(true);
    expect(scoped.some((row) => row.kind === "doc_updated")).toBe(true);
    expect(inReview(scoped.at(-1)!)).toBe(true);
  });

  it("carries the whole event shape, identical to the unfiltered route's", async () => {
    const scoped = await events(`?issue=${encodeURIComponent(subject)}`);
    expect(Object.keys(scoped[0]!).sort()).toEqual([
      "actor",
      "createdAt",
      "dedupKey",
      "issueId",
      "kind",
      "payload",
      "seq",
    ]);
    const statusChange = scoped.filter((row) => row.kind === "status_changed").at(-1)!;
    expect(statusChange.payload).toMatchObject({ from: "in_progress", to: "in_review" });
    expect(statusChange.actor).toBe("opus-detail");
  });

  it("comes back oldest-first, which is the order the timeline renders in", async () => {
    const scoped = await events(`?issue=${encodeURIComponent(subject)}`);
    const seqs = scoped.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("honours ?since= alongside the filter", async () => {
    const all = await events(`?issue=${encodeURIComponent(subject)}`);
    const cut = all[1]!.seq;
    const after = await events(`?issue=${encodeURIComponent(subject)}&since=${cut}`);
    expect(after.every((row) => row.seq > cut)).toBe(true);
    expect(after).toHaveLength(all.length - 2);
  });

  it("404s on a ref that resolves to nothing, rather than returning an empty log", async () => {
    const res = await get("/api/events?issue=NOPE-999");
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("not_found");
  });

  it("leaves the unfiltered route byte-for-byte as it was: workspace-wide, capped at 100", async () => {
    const rows = await events("");
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.issueId)).size).toBeGreaterThan(0);
  });

  it("treats an empty issue= as absent rather than as a filter that matches nothing", async () => {
    const rows = await events("?issue=");
    expect(rows).toHaveLength(100);
  });
});
