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
import type { IssueDetail } from "@/lib/types";
import { setClock } from "../../../../core/types.ts";
import { initWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";
import { actionContextOf } from "./IssueActions";
import { overflowItems, primaryItem, statusItems, toRequest, type ActionItem, type StatusItem, type WriteCall } from "./plain-actions";

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
  me: string | null;
  build: (store: Store) => string;
}

const ME = "tester";

const SCENARIOS: Scenario[] = [
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
  try {
    return { ws, ref: scenario.build(store) };
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

async function offered(scenario: Scenario): Promise<Offered[]> {
  const { ws, ref } = world(scenario);
  const ctx = actionContextOf(await detailOf(ws, ref), scenario.me);
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
        const ctx = actionContextOf(detail, scenario.me);
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
          if (body) {
            const response = await post("/api/action", body);
            expect(response.status, `${scenario.name} / ${key} was held back ("${item.disabledReason}") but the store accepts it`).not.toBe(200);
          }
        }
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
  };
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const { ws, ref } = world(scenario);
      const primary = primaryItem(actionContextOf(await detailOf(ws, ref), scenario.me));
      expect(`${primary.id}${primary.disabledReason ? " (disabled)" : ""}`).toBe(expected[scenario.name]);
    });
  }
});
