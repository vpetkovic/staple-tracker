/**
 * THE ACTION AUDIT: nothing the detail offers is a guaranteed refusal, and everything it holds
 * back really would be refused.
 *
 * A real UI server in hub mode over real workspaces, one fresh workspace per case. For each
 * state (status × claim × gate × blocker) the test reads `/api/issue` exactly as the panel
 * does, derives the primary action, the ⋯ items and the status menu with the same functions
 * the components call, and then:
 *
 *   - sends every ENABLED item's write, built by `toRequest`, to `/api/action` and expects the
 *     store to accept it;
 *   - sends the obvious write behind every DISABLED item and expects the store to refuse it,
 *     so a disabled reason is never a guess.
 *
 * Hub mode with several workspaces is deliberate: a write that dropped its `ws` cannot land on
 * the right workspace there, which is the trap a single-workspace test would miss.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { settingValueIn, type WorkspaceSettingsEnvelope } from "@/lib/settings";
import type { IssueDetail, QueueView } from "@/lib/types";
import { setClock } from "../../../../core/types.ts";
import { initWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";
import { actionContextOf } from "./IssueActions";
import { overflowItems, primaryItem, queueAheadOf, statusItems, toRequest, type ActionContext, type ActionItem, type StatusItem, type WriteCall } from "./plain-actions";

type Store = ReturnType<typeof initWorkspace>["store"];

const T0 = Date.parse("2026-09-20T10:00:00.000Z");
let clock = T0;
let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let counter = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-detail-actions-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  setClock(() => clock);
  // A second workspace, so the hub has more than one and a write without `ws` is ambiguous.
  initWorkspace({ global: true, slug: "other" }).store.db.close();
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  setClock(null);
  rmSync(home, { recursive: true, force: true });
});

/** One state of the world: build it in a fresh workspace, return the issue to look at. */
interface Scenario {
  name: string;
  /** The working name this browser remembers (Start work's last name). */
  me: string | null;
  build: (store: Store, ws: string) => string;
  /**
   * Items the page holds back ON PURPOSE although the store alone would accept them, keyed
   * to the words the reason must contain: work waiting on another workspace (the queue reads
   * that as blocked too), and In Progress by the status menu while a gate or the strict queue
   * says no (a way round them). For these the audit asserts the hold-back and its reason.
   */
  stricter?: Record<string, string>;
}

/** Link `blocked` (in `ws`) behind a task in another workspace, as the hub records it. */
function crossLink(blockerWs: string, blockerIdentifier: string, blockedWs: string, blocked: string): void {
  const hub = new DatabaseSync(join(home, "hub.db"));
  try {
    hub
      .prepare("INSERT INTO cross_links (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier, type, created_at) VALUES (?, ?, ?, ?, 'blocks', ?)")
      .run(blockerWs, blockerIdentifier, blockedWs, blocked, new Date(T0).toISOString());
  } finally {
    hub.close();
  }
}

/** A task in the second workspace, open, for a cross-workspace blocker. */
function otherTask(): string {
  const other = initWorkspace({ global: true, slug: "other" }).store;
  try {
    return other.createIssue({ title: `other ${++titles}` }).identifier;
  } finally {
    other.db.close();
  }
}

const ME = "tester";

const SCENARIOS: Scenario[] = [
  {
    name: "todo, waiting only on an open task in another workspace",
    me: ME,
    build: (s, ws) => {
      const id = todo(s);
      crossLink("other", otherTask(), ws, id);
      return id;
    },
    stricter: { "primary:start": "Waiting on 1 other task to finish first." },
  },
  {
    name: "todo, waiting on a task missing from a workspace on this computer",
    me: ME,
    build: (s, ws) => {
      const id = todo(s);
      crossLink("other", `${otherTask().split("-")[0]}-9999`, ws, id);
      return id;
    },
    stricter: { "primary:start": "Waiting on a task this computer can't see" },
  },
  {
    name: "todo, waiting on a task in a workspace not on this computer",
    me: ME,
    build: (s, ws) => {
      const id = todo(s);
      crossLink("gone", "GON-1", ws, id);
      return id;
    },
    stricter: { "primary:start": "Waiting on a task this computer can't see (GON-1)" },
  },
  {
    name: "strict queue, another task is next",
    me: ME,
    build: (s) => {
      (s as unknown as { setSetting(k: string, v: unknown, a: string): void }).setSetting("queue.policy", "strict", "w");
      const head = todo(s);
      (s as unknown as { queue(): { mutate(op: string, args: object, actor: string): void } }).queue().mutate("add", { ref: head }, "w");
      return todo(s);
    },
  },
  {
    name: "strict queue, another task is next, and this one has an assignee",
    me: ME,
    build: (s) => {
      (s as unknown as { setSetting(k: string, v: unknown, a: string): void }).setSetting("queue.policy", "strict", "w");
      const head = todo(s);
      (s as unknown as { queue(): { mutate(op: string, args: object, actor: string): void } }).queue().mutate("add", { ref: head }, "w");
      const id = todo(s);
      s.updateIssue(id, { assignee: "vp" }, "w");
      return id;
    },
    stricter: { "status:in_progress": "is next in the queue." },
  },
  {
    name: "a queued child with an assignee",
    me: ME,
    build: (s) => {
      const parent = todo(s);
      const child = s.createIssue({ title: `child ${++titles}`, parent }).identifier;
      s.updateIssue(child, { status: "todo", assignee: "vp" }, "w");
      s.gateIssue(parent, { owner: "VP" }, "lead");
      return child;
    },
    stricter: { "status:in_progress": "Waiting for VP to approve the parent task first." },
  },
  { name: "backlog, nobody on it", me: ME, build: (s) => s.createIssue({ title: `task ${++titles}` }).identifier },
  { name: "todo, nobody on it", me: ME, build: (s) => todo(s) },
  {
    name: "todo with an open blocker",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.setBlockedBy(id, [todo(s)], "w");
      return id;
    },
  },
  {
    name: "blocked by hand, no blocker",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.updateIssue(id, { status: "blocked" }, "w");
      return id;
    },
  },
  {
    name: "blocked with an open blocker",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.setBlockedBy(id, [todo(s)], "w");
      s.updateIssue(id, { status: "blocked" }, "w");
      return id;
    },
  },
  { name: "held by someone else, active", me: ME, build: (s) => held(s, "agent-a") },
  { name: "held by me", me: ME, build: (s) => held(s, ME) },
  { name: "held by someone, no name remembered here", me: null, build: (s) => held(s, "agent-a") },
  {
    name: "held by someone who went quiet",
    me: ME,
    build: (s) => {
      const id = held(s, "agent-a");
      clock += 31 * 60_000;
      return id;
    },
  },
  {
    name: "held by someone who went quiet, and now blocked",
    me: ME,
    build: (s) => {
      const id = held(s, "agent-a");
      s.setBlockedBy(id, [todo(s)], "w");
      clock += 31 * 60_000;
      return id;
    },
  },
  {
    name: "in review",
    me: ME,
    build: (s) => {
      const id = held(s, "agent-a");
      s.updateIssue(id, { status: "in_review" }, "agent-a");
      return id;
    },
  },
  {
    name: "in progress with nobody holding it",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.updateIssue(id, { assignee: "vp" }, "w");
      s.updateIssue(id, { status: "in_progress" }, "w");
      return id;
    },
  },
  {
    name: "done",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.updateIssue(id, { status: "done" }, "w");
      return id;
    },
  },
  {
    name: "cancelled",
    me: ME,
    build: (s) => {
      const id = todo(s);
      s.updateIssue(id, { status: "cancelled" }, "w");
      return id;
    },
  },
  {
    name: "a parent with open children",
    me: ME,
    build: (s) => {
      const parent = todo(s);
      s.createIssue({ title: `child ${++titles}`, parent });
      return parent;
    },
  },
  {
    name: "a parent parked behind a review",
    me: ME,
    build: (s) => {
      const parent = todo(s);
      s.createIssue({ title: `child ${++titles}`, parent });
      s.gateIssue(parent, { owner: "VP" }, "lead");
      return parent;
    },
  },
  {
    name: "a child queued behind its parent's review",
    me: ME,
    build: (s) => {
      const parent = todo(s);
      const child = s.createIssue({ title: `child ${++titles}`, parent }).identifier;
      s.updateIssue(child, { status: "todo" }, "w");
      s.gateIssue(parent, { owner: "VP" }, "lead");
      return child;
    },
  },
];

let titles = 0;
/** The workspaces on this computer, as the page's session lists them. */
const created: string[] = ["other"];

function todo(store: Store): string {
  const id = store.createIssue({ title: `task ${++titles}` }).identifier;
  store.updateIssue(id, { status: "todo" }, "w");
  return id;
}

function held(store: Store, agent: string): string {
  const id = todo(store);
  store.checkoutIssue(id, agent);
  return id;
}

/** A fresh workspace holding one scenario. */
function world(scenario: Scenario): { ws: string; ref: string } {
  clock = T0;
  // Letters only, three of them, so every workspace gets its own id prefix.
  const n = ++counter;
  const ws = [676, 26, 1].map((d, i) => String.fromCharCode((i === 0 ? 98 : 97) + (Math.floor(n / d) % 26))).join("");
  const store = initWorkspace({ global: true, slug: ws }).store;
  created.push(ws);
  try {
    return { ws, ref: scenario.build(store, ws) };
  } finally {
    store.db.close();
  }
}

async function detailOf(ws: string, ref: string): Promise<IssueDetail> {
  const response = await fetch(`${origin}/api/issue?ws=${ws}&ref=${ref}`, { headers: { "x-staple-token": ui.token } });
  const body = await response.text();
  expect(response.status, `${ws}/${ref}: ${body}`).toBe(200);
  return JSON.parse(body) as IssueDetail;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": ui.token, origin },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** What the page sends for a call, over the wire the page uses. The web app's default actor is "ui". */
function send(call: WriteCall, actor: string | null) {
  const request = toRequest(call, actor);
  if (request.fn !== "action") throw new Error(`unexpected ${request.fn}`);
  return post("/api/action", { actor: "ui", ...request.target, ...request.payload });
}

type Offered = { key: string; item: ActionItem | StatusItem };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  return (await response.json()) as T;
}

/** The context exactly as the page builds it: names, workspaces, and the strict queue's head. */
async function contextFor(scenario: Scenario, ws: string, detail: IssueDetail): Promise<ActionContext> {
  const settings = await getJson<WorkspaceSettingsEnvelope>(`/api/settings?ws=${ws}`);
  const strict = settingValueIn(settings, "queue.policy")?.value === "strict";
  const queueAhead = strict ? queueAheadOf((await getJson<QueueView>(`/api/queue?ws=${ws}`)).effective, detail.issue.id) : null;
  return actionContextOf(detail, { worker: scenario.me, person: null }, { workspaces: created, queueAhead });
}

async function offered(scenario: Scenario): Promise<Offered[]> {
  const { ws, ref } = world(scenario);
  const ctx = await contextFor(scenario, ws, await detailOf(ws, ref));
  return [
    { key: `primary:${primaryItem(ctx).id}`, item: primaryItem(ctx) },
    ...overflowItems(ctx).map((item) => ({ key: `more:${item.id}`, item })),
    ...statusItems(ctx).filter((item) => !item.current).map((item) => ({ key: `status:${item.status}`, item })),
  ];
}

/** The obvious write behind a disabled item: what a naive button would have sent. */
function naive(key: string, ctx: { ws: string; ref: string; me: string | null }): Record<string, unknown> | null {
  const base = { ws: ctx.ws, ref: ctx.ref, actor: ctx.me ?? "ui" };
  if (key === "primary:start" || key === "more:start") return { ...base, type: "checkout" };
  if (key.endsWith(":take-over")) return { ...base, type: "checkout", stealIfIdleSeconds: 1800 };
  if (key === "more:release") return { ...base, type: "release" };
  if (key.startsWith("status:")) return { ...base, type: "status", status: key.slice("status:".length) };
  return null;
}

describe("every action the detail offers is one the store accepts", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const keys = (await offered(scenario)).map((o) => o.key);
      for (const key of keys) {
        // A fresh world per write, so each item is judged against the state it was offered in.
        const { ws, ref } = world(scenario);
        const detail = await detailOf(ws, ref);
        const ctx = await contextFor(scenario, ws, detail);
        const all: Offered[] = [
          { key: `primary:${primaryItem(ctx).id}`, item: primaryItem(ctx) },
          ...overflowItems(ctx).map((item) => ({ key: `more:${item.id}`, item })),
          ...statusItems(ctx).filter((item) => !item.current).map((item) => ({ key: `status:${item.status}`, item })),
        ];
        const { item } = all.find((o) => o.key === key)!;
        if (item.call) {
          expect(item.call.ws, `${scenario.name} / ${key} carries its workspace`).toBe(ws);
          const response = await send(item.call, ME);
          expect(response.status, `${scenario.name} / ${key} was offered but refused: ${response.text}`).toBe(200);
        } else if (item.disabledReason) {
          const body = naive(key, { ws, ref: detail.issue.id, me: scenario.me });
          const intended = scenario.stricter?.[key];
          if (intended) {
            // Held back on purpose: assert the reason, and that it really is stricter than the store.
            expect(item.disabledReason, `${scenario.name} / ${key}`).toContain(intended);
            if (body) expect((await post("/api/action", body)).status, `${scenario.name} / ${key} is stricter than the store`).toBe(200);
          } else if (body) {
            const response = await post("/api/action", body);
            expect(response.status, `${scenario.name} / ${key} was held back ("${item.disabledReason}") but the store accepts it`).not.toBe(200);
          }
        }
      }
      for (const key of Object.keys(scenario.stricter ?? {})) {
        expect(keys, `${scenario.name}: ${key} is listed`).toContain(key);
      }
    }, 60_000);
  }
});

describe("the primary action per state", () => {
  const expected: Record<string, string> = {
    "backlog, nobody on it": "start",
    "todo, nobody on it": "start",
    "todo with an open blocker": "start (disabled)",
    "blocked by hand, no blocker": "start",
    "blocked with an open blocker": "start (disabled)",
    "held by someone else, active": "done",
    "held by me": "done",
    "held by someone, no name remembered here": "done",
    "held by someone who went quiet": "take-over",
    "held by someone who went quiet, and now blocked": "take-over (disabled)",
    "in review": "done",
    "in progress with nobody holding it": "done",
    done: "reopen",
    cancelled: "reopen",
    "a parent with open children": "start",
    "a parent parked behind a review": "review",
    "a child queued behind its parent's review": "start (disabled)",
    "todo, waiting only on an open task in another workspace": "start (disabled)",
    "todo, waiting on a task missing from a workspace on this computer": "start (disabled)",
    "todo, waiting on a task in a workspace not on this computer": "start (disabled)",
    "strict queue, another task is next": "start (disabled)",
    "strict queue, another task is next, and this one has an assignee": "start (disabled)",
    "a queued child with an assignee": "start (disabled)",
  };
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { ws, ref } = world(scenario);
      const primary = primaryItem(await contextFor(scenario, ws, await detailOf(ws, ref)));
      expect(`${primary.id}${primary.disabledReason ? " (disabled)" : ""}`).toBe(expected[scenario.name]);
    });
  }
});
