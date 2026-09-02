/**
 * W1 (STA-113) — the worklog summary on the wire.
 *
 * §2a of the STA-108 spec: `GET /api/issues` carried `{ workspace, issue, claim }` and no
 * document metadata at all, so a row-level worklog cue was not merely expensive but
 * impossible — 114 rows against a server polled every 1.5s. This suite pins the additive
 * fix, and just as importantly it pins where the fix STOPS.
 *
 * The negative assertions are the load-bearing ones:
 *  - `/api/issue` must NOT grow a `worklog` field. Its `documents[]` already carries
 *    `key`/`currentRevision`/`updatedAt`; a second representation of one fact on one
 *    payload is how two surfaces start disagreeing (§5b).
 *  - `/api/agent-context` must not change at all — `test/ui-agent-context.test.ts` pins it
 *    byte-identical to MCP `get_task`, and that test is not allowed to be edited for this.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKLOG_KEY, type WorklogSummary } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;

/** Three tickets: none / one revision / three revisions — the §5a fixture. */
let refNone: string;
let refOne: string;
let refMany: string;

interface Row {
  workspace: string;
  issue: { identifier: string };
  claim: unknown;
  worklog: WorklogSummary | null;
}

function get(path: string) {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

async function getJson<T>(path: string): Promise<T> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uiworklog-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uiworklog" });

  refNone = ws.store.createIssue({ title: "Nothing written down" }).identifier;
  refOne = ws.store.createIssue({ title: "One checkpoint" }).identifier;
  refMany = ws.store.createIssue({ title: "Checkpointed properly" }).identifier;

  ws.store.putDocument(refOne, WORKLOG_KEY, "## Done\nstarted\n", { author: "agent-a" });
  ws.store.putDocument(refMany, WORKLOG_KEY, "## Done\nr1\n", { author: "agent-b" });
  ws.store.putDocument(refMany, WORKLOG_KEY, "## Done\nr2\n", { author: "agent-b" });
  ws.store.putDocument(refMany, WORKLOG_KEY, "## Done\nr3\n", { author: "agent-c" });
  // A plan is not a worklog. If the route ever keys off "the newest document" this fails.
  ws.store.putDocument(refNone, "plan", "the plan", { author: "agent-a" });

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

describe("GET /api/issues carries a worklog sibling per row", () => {
  it("attaches the summary beside issue and claim, never as a field on issue", async () => {
    const rows = await getJson<Row[]>("/api/issues");
    const row = rows.find((r) => r.issue.identifier === refMany)!;
    expect(row.worklog).toEqual({
      key: WORKLOG_KEY,
      revisions: 3,
      updatedAt: expect.any(String),
      author: "agent-c",
    });
    // The sibling argument: `issue` is the entity and stays the entity.
    expect(row.issue).not.toHaveProperty("worklog");
  });

  it("reports worklog: null — present, not omitted — when nothing has been written", async () => {
    const rows = await getJson<Row[]>("/api/issues");
    const row = rows.find((r) => r.issue.identifier === refNone)!;
    // Same treatment `claim` gets: the field is always on the wire so the page never
    // has to distinguish "absent" from "no worklog".
    expect(row).toHaveProperty("worklog");
    expect(row.worklog).toBeNull();
  });

  it("counts revisions, which is the signal a bare age would lose", async () => {
    const rows = await getJson<Row[]>("/api/issues");
    expect(rows.find((r) => r.issue.identifier === refOne)!.worklog!.revisions).toBe(1);
    expect(rows.find((r) => r.issue.identifier === refMany)!.worklog!.revisions).toBe(3);
  });

  it("every row carries the field, so the page never has to guess", async () => {
    const rows = await getJson<Row[]>("/api/issues");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect("worklog" in row).toBe(true);
  });

  it("is still gated by the same token as every other read", async () => {
    const res = await fetch(`${origin}/api/issues`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/inbox carries the same summary", () => {
  it("attaches worklog to each entry beside claim, following the shape that route already has", async () => {
    const payload = await getJson<
      Array<{
        workspace: string;
        inbox: {
          ready: Array<{ identifier: string; worklog: WorklogSummary | null }>;
          blocked: Array<{ identifier: string; worklog: WorklogSummary | null }>;
        };
      }>
    >("/api/inbox");
    const entries = payload.flatMap((p) => [...p.inbox.ready, ...p.inbox.blocked]);

    const many = entries.find((e) => e.identifier === refMany)!;
    expect(many.worklog).toEqual({
      key: WORKLOG_KEY,
      revisions: 3,
      updatedAt: expect.any(String),
      author: "agent-c",
    });
    expect(entries.find((e) => e.identifier === refNone)!.worklog).toBeNull();
    for (const entry of entries) expect("worklog" in entry).toBe(true);
  });

  it("agrees with /api/issues on the same issue — one definition, two routes", async () => {
    const rows = await getJson<Row[]>("/api/issues");
    const payload = await getJson<
      Array<{ inbox: { ready: Array<{ identifier: string; worklog: WorklogSummary | null }>; blocked: Array<{ identifier: string; worklog: WorklogSummary | null }> } }>
    >("/api/inbox");
    const entries = payload.flatMap((p) => [...p.inbox.ready, ...p.inbox.blocked]);

    for (const ref of [refNone, refOne, refMany]) {
      const fromList = rows.find((r) => r.issue.identifier === ref)!.worklog;
      const fromInbox = entries.find((e) => e.identifier === ref)!.worklog;
      expect(fromInbox).toEqual(fromList);
    }
  });
});

describe("the routes this ticket must not touch", () => {
  it("GET /api/issue grows nothing — documents[] already carries the same fact", async () => {
    const detail = await getJson<Record<string, unknown> & { documents: Array<{ key: string; currentRevision: number }> }>(
      `/api/issue?ref=${encodeURIComponent(refMany)}`,
    );
    expect(detail).not.toHaveProperty("worklog");
    // ...and it is genuinely already there, which is why adding it twice would be a bug.
    const meta = detail.documents.find((d) => d.key === WORKLOG_KEY)!;
    expect(meta.currentRevision).toBe(3);
  });

  it("GET /api/agent-context grows nothing — it is pinned to MCP get_task", async () => {
    const context = await getJson<Record<string, unknown>>(
      `/api/agent-context?ref=${encodeURIComponent(refMany)}`,
    );
    expect(context).not.toHaveProperty("worklog");
  });
});
