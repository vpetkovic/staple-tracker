/// <reference lib="dom" />
/**
 * The queue view (`ui://staple/queue`), served by the packaged `staple mcp` and rendered in
 * the minimal, host-agnostic MCP Apps host (`npm run test:views`; also part of `npm test`).
 *
 * `show_queue` answers with the lanes and is the only tool that declares the view (`inbox` and
 * `list_queue` are the agent's reads), and a host without MCP Apps gets the lanes as text. The lanes are the effective queue split by
 * eligibility, so they are checked against the resolver `staple queue next` and `next_task`
 * read, not against a hand-written list. Under `queue.policy = strict` only the row checkout
 * accepts offers Take. In the host the view paints at 360px in both themes; Take posts
 * "Work <REF>" into the thread through the host, and Approve calls the app-only
 * approve_gate_from_view through the host, which records the person (the machine's
 * humanName), never the server's STAPLE_AGENT, and answers with the lanes, so the released work
 * shows as ready without a second call (a host may ask the person before every call). Each
 * write is checked in the workspace afterwards, not only on screen.
 *
 * The browser half is skipped, saying why, when this machine has no Chromium for
 * playwright-core (and fails in CI instead). The protocol half always runs.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initWorkspace, resolveWorkspace } from "../src/core/workspace.js";
import { updateConfig } from "../src/config/file.js";
import type { QueueLanes } from "../src/mcp-queue.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { MCP_APPS_EXTENSION, expectPainted, loadView, measurePaint, renderView, type RenderedView } from "./fixtures/mcp-apps-harness.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache =
    process.platform === "darwin"
      ? join(userInfo().homedir, "Library", "Caches", "ms-playwright")
      : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

const { chromium } = await import("playwright-core");

async function chromiumAvailable(): Promise<boolean> {
  try {
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const browserReady = await chromiumAvailable();
const reason = browserReady ? "" : "no Chromium for playwright-core";
if (reason) console.warn(`mcp-views-queue: browser tests skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("mcp-views-queue: a browser to run in", () => {
    it("has Chromium", () => {
      throw new Error(`mcp-views-queue cannot run in CI: ${reason}.`);
    });
  });
}

const WIDTH = 360;
const AGENT = "queue-test";

let home: string;
let dbPath: string;
let browser: Browser | undefined;
const clients: Client[] = [];

/** The seeded tickets, by role. */
const refs = {
  /** Plan row 1: in progress, held by pat, two milestones, an estimate. */
  working: "",
  /** Plan row 2: an epic gated on the reviewer, holding two children. */
  gate: "",
  gateChildren: [] as string[],
  /** Plan rows 3 and 4: ready, in that order. */
  first: "",
  second: "",
  /** Plan row 5: blocked by `first`. */
  blocked: "",
  /** Unqueued and ready: after every plan row. */
  unqueued: "",
  /** Unqueued, held by another agent. */
  otherWorking: "",
  /** An epic outside the plan with one ready child, for a scoped view. */
  scope: "",
  scopeChild: "",
};

async function connect(options: { apps: boolean; db?: string }): Promise<Client> {
  // Built from scratch: a STAPLE_DB or STAPLE_WS from the shell must never reach this server.
  const { STAPLE_DB: _db, STAPLE_WS: _ws, ...inherited } = process.env as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(testPackageDir(), "staple.mjs"), "mcp"],
    cwd: home,
    env: { ...inherited, STAPLE_DB: options.db ?? dbPath, STAPLE_AGENT: AGENT, NODE_NO_WARNINGS: "1" },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "queue-test-host", version: "0.0.0" },
    { capabilities: options.apps ? { extensions: MCP_APPS_EXTENSION } : {} },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function text(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** Run `fn` against the workspace as it stands now, beside the server, then close it. */
function withStore<T>(fn: (store: ReturnType<typeof resolveWorkspace>["store"]) => T): T {
  const { store } = resolveWorkspace({ db: dbPath });
  try {
    return fn(store);
  } finally {
    store.db.close();
  }
}

async function lanes(client: Client, args: Record<string, unknown> = {}): Promise<QueueLanes> {
  const result = (await client.callTool({ name: "show_queue", arguments: args })) as CallToolResult;
  expect(result.isError, text(result)).toBeFalsy();
  return (result.structuredContent as { queue: QueueLanes }).queue;
}

/**
 * The lanes must be the effective queue split by eligibility: ready is every eligible row
 * in order (its head is `next`), gated every gated row under the gate that holds it, in
 * progress every claimed row with its holder, blocked every blocked row.
 */
function expectLanesMatchResolver(shown: QueueLanes, scope?: string): void {
  const answer = withStore((store) => store.queue().effectiveQueue({ scope }));
  const ids = (eligibility: string) => answer.rows.filter((row) => row.eligibility === eligibility).map((row) => row.identifier);
  expect(shown.next).toBe(answer.next?.identifier ?? null);
  expect(shown.ready[0]?.identifier ?? null).toBe(answer.next?.identifier ?? null);
  expect(shown.ready.map((row) => row.identifier)).toEqual(ids("eligible"));
  expect(shown.ready.map((row) => row.position)).toEqual(answer.rows.filter((row) => row.eligibility === "eligible").map((row) => row.position));
  expect(shown.gated.flatMap((group) => group.holds.map((row) => row.identifier))).toEqual(ids("gated"));
  for (const group of shown.gated) {
    for (const held of group.holds) {
      const row = answer.rows.find((candidate) => candidate.identifier === held.identifier)!;
      const by = (row.detail?.queuedBy as { identifier: string; owner: string } | undefined) ?? null;
      expect(group.identifier).toBe(by?.identifier ?? row.identifier);
      if (by) expect(group.owner).toBe(by.owner);
    }
  }
  expect(shown.inProgress.map((row) => [row.identifier, row.heldBy])).toEqual(
    answer.rows.filter((row) => row.eligibility === "claimed").map((row) => [row.identifier, String(row.detail?.heldBy)]),
  );
  expect(shown.blocked.map((row) => row.identifier)).toEqual(ids("blocked"));
  // Everything next stepped over is in a lane that says why.
  for (const row of answer.skipped) {
    const where = {
      gated: shown.gated.some((group) => group.holds.some((held) => held.identifier === row.identifier)),
      claimed: shown.inProgress.some((held) => held.identifier === row.identifier),
      blocked: shown.blocked.some((held) => held.identifier === row.identifier),
      unavailable: shown.unavailable.some((held) => held.identifier === row.identifier),
    } as Record<string, boolean>;
    expect(where[row.eligibility], `${row.identifier} (${row.eligibility}) is in its lane`).toBe(true);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-queue-"));
  process.env.STAPLE_HOME = join(home, ".staple");
  const ws = initWorkspace({ global: true, slug: "lanes" });
  dbPath = ws.dbPath;
  const s = ws.store;

  const working = s.createIssue({ title: "Retry failed card payments", priority: "high", estimatedSeconds: 3 * 3600 });
  s.checkoutIssue(working.identifier, "pat");
  s.recordAttemptEvent(working.identifier, "milestone", "pat", { label: "Retry scheduler wired" });
  s.recordAttemptEvent(working.identifier, "milestone", "pat", { label: "One clear decline message" });
  refs.working = working.identifier;

  const gate = s.createIssue({ title: "Gift cards", kind: "epic" });
  refs.gateChildren = [
    s.createIssue({ title: "Redeem a gift card at checkout", parent: gate.identifier }).identifier,
    s.createIssue({ title: "Show the gift card balance", parent: gate.identifier }).identifier,
  ];
  s.gateIssue(gate.identifier, { owner: "reviewer", comment: "First pass." }, "pat");
  refs.gate = gate.identifier;

  refs.first = s.createIssue({ title: "Show the order summary on phones", status: "todo" }).identifier;
  refs.second = s.createIssue({ title: "Add saved cards to checkout", status: "todo" }).identifier;
  refs.blocked = s.createIssue({ title: "Email a receipt after payment", status: "todo", blockedBy: [refs.first] }).identifier;
  refs.unqueued = s.createIssue({ title: "Translate checkout into Spanish", status: "todo" }).identifier;
  const other = s.createIssue({ title: "Speed up product search", status: "todo", estimatedSeconds: 4 * 3600 });
  s.checkoutIssue(other.identifier, "rio");
  refs.otherWorking = other.identifier;
  const scope = s.createIssue({ title: "Loyalty points", kind: "epic" });
  refs.scope = scope.identifier;
  refs.scopeChild = s.createIssue({ title: "Earn points on every order", parent: scope.identifier, status: "todo" }).identifier;

  for (const ref of [refs.working, refs.gate, refs.first, refs.second, refs.blocked]) s.queue().mutate("add", { ref }, "pat");
  ws.store.db.close();
  if (!reason) browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("the queue view over MCP", () => {
  it("serves ui://staple/queue, show_queue declares it, and inbox and list_queue do not", async () => {
    const client = await connect({ apps: true });
    const { resources } = await client.listResources();
    expect(resources.find((resource) => resource.uri === "ui://staple/queue")).toMatchObject({
      name: "queue",
      mimeType: "text/html;profile=mcp-app",
    });
    const { tools } = await client.listTools();
    const show = tools.find((tool) => tool.name === "show_queue")!;
    expect(show._meta).toEqual({ ui: { resourceUri: "ui://staple/queue" }, "ui/resourceUri": "ui://staple/queue" });
    expect(show.annotations).toMatchObject({ readOnlyHint: true });
    // The agent's own reads draw nothing: a view per inbox call would be noise.
    for (const name of ["inbox", "list_queue"]) expect(tools.find((tool) => tool.name === name)!._meta, name).toBeUndefined();
    const inbox = (await client.callTool({ name: "inbox", arguments: {} })) as CallToolResult;
    expect(inbox._meta).toBeUndefined();
    expect(Object.keys(inbox.structuredContent ?? {}).sort()).toEqual(["blocked", "hasMore", "nextCursor", "queued", "ready"]);
  });

  it("answers show_queue with the lanes the resolver gives, and next_task agrees on the head", async () => {
    const client = await connect({ apps: true });
    const result = (await client.callTool({ name: "show_queue", arguments: {} })) as CallToolResult;
    expect(result._meta).toEqual({ ui: { resourceUri: "ui://staple/queue" } });
    const shown = (result.structuredContent as { queue: QueueLanes }).queue;
    expectLanesMatchResolver(shown);
    expect(shown).toMatchObject({
      workspace: "lanes",
      scope: null,
      policy: "advisory",
      expected: null,
      next: refs.first,
      ready: [
        { identifier: refs.first, planPosition: 3, takeable: true },
        { identifier: refs.second, planPosition: 4, takeable: true },
        { identifier: refs.unqueued, planPosition: null, takeable: true },
        { identifier: refs.scopeChild, planPosition: null, takeable: true },
      ],
      gated: [
        {
          identifier: refs.gate,
          title: "Gift cards",
          owner: "reviewer",
          state: "pending",
          requestedBy: "pat",
          resolvedBy: null,
          behind: null,
          approve: true,
          holds: refs.gateChildren.map((identifier) => ({ identifier, planPosition: 2, path: [refs.gate] })),
          heldTotal: 2,
        },
      ],
      inProgress: [
        {
          identifier: refs.working,
          heldBy: "pat",
          attempt: { ordinal: 1, state: "running" },
          milestoneCount: 2,
          lastMilestone: "One clear decline message",
          timing: { estimatedSeconds: 3 * 3600 },
        },
        { identifier: refs.otherWorking, heldBy: "rio", milestoneCount: 0, lastMilestone: null, timing: { estimatedSeconds: 4 * 3600 } },
      ],
      blocked: [{ identifier: refs.blocked, blockers: [refs.first] }],
      totals: { ready: 4, gated: 2, gates: 1, inProgress: 2, blocked: 1, unavailable: 0 },
    });
    const next = (await client.callTool({ name: "next_task", arguments: {} })) as CallToolResult;
    expect((next.structuredContent as { next: { identifier: string } }).next.identifier).toBe(shown.ready[0]!.identifier);
  });

  it("limits the lanes to a scope, as queue next --scope does", async () => {
    const client = await connect({ apps: true });
    const shown = await lanes(client, { scope: refs.scope });
    expectLanesMatchResolver(shown, refs.scope);
    expect(shown.scope).toEqual({ identifier: refs.scope, title: "Loyalty points", kind: "epic" });
    expect(shown.ready.map((row) => row.identifier)).toEqual([refs.scopeChild]);
    const prefix = refs.first.split("-")[0];
    const missing = (await client.callTool({ name: "show_queue", arguments: { scope: `${prefix}-999` } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^ERROR\(not_found\)/);
  });

  it("answers a host without MCP Apps with the lanes in readable text", async () => {
    const client = await connect({ apps: false });
    const shown = text((await client.callTool({ name: "show_queue", arguments: {} })) as CallToolResult);
    const lines = shown.split("\n");
    expect(lines[0]).toBe("Queue (advisory) · 4 ready · 2 gated · 2 in progress · 1 blocked");
    expect(lines[1]).toBe(`Next: ${refs.first} Show the order summary on phones`);
    expect(lines).toContain("Ready, in pickup order:");
    expect(lines).toContain(`  1. ${refs.first} Show the order summary on phones`);
    expect(lines).toContain(`  2. ${refs.second} Add saved cards to checkout`);
    expect(lines).toContain(
      `  ${refs.gate} Gift cards: waiting on reviewer; holds ${refs.gateChildren.join(", ")}. Approve with approve_task.`,
    );
    expect(lines).toContain("In progress:");
    expect(shown).toMatch(new RegExp(`  ${refs.working} Retry failed card payments: pat · attempt #1 running · 2 milestones, last "One clear decline message" · \\d+s of 3h`));
    expect(lines).toContain(`Blocked: ${refs.blocked} (by ${refs.first}).`);
    expect(lines.at(-1)).toBe(`To take one, say "Work ${refs.first}".`);
    expect(() => JSON.parse(shown)).toThrow();
  });

  it("under queue.policy strict, offers Take only on the row checkout accepts, even in a scope", async () => {
    withStore((store) => store.setSetting("queue.policy", "strict", "pat"));
    try {
      const client = await connect({ apps: true });
      const whole = await lanes(client);
      expect(whole.policy).toBe("strict");
      expect(whole.expected).toMatchObject({ identifier: refs.first, title: "Show the order summary on phones" });
      expect(whole.ready.map((row) => [row.identifier, row.takeable])).toEqual([
        [refs.first, true],
        [refs.second, false],
        [refs.unqueued, false],
        [refs.scopeChild, false],
      ]);
      // checkout agrees: the second row is refused out_of_order, naming the expected one.
      const refused = (await client.callTool({ name: "checkout_task", arguments: { ref: refs.second } })) as CallToolResult;
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(new RegExp(`^ERROR\\(out_of_order\\).*Take ${refs.first}`));
      // A scope narrows what is shown, not what checkout checks.
      const scoped = await lanes(client, { scope: refs.scope });
      expect(scoped.expected?.identifier).toBe(refs.first);
      expect(scoped.ready.map((row) => [row.identifier, row.takeable])).toEqual([[refs.scopeChild, false]]);
      const strictText = text((await client.callTool({ name: "show_queue", arguments: {} })) as CallToolResult);
      expect(strictText).toContain(`Strict queue: checkout takes ${refs.first} now; every other ready row waits for it.`);
      expect(strictText).toContain(`  2. ${refs.second} Add saved cards to checkout (after ${refs.first})`);
      expect(strictText.split("\n").at(-1)).toBe(`To take one, say "Work ${refs.first}".`);
      // Scoped to work the plan does not reach first, nothing in view can be taken: the text
      // sends the person to the row checkout accepts, not to the scope's head.
      const scopedText = text((await client.callTool({ name: "show_queue", arguments: { scope: refs.scope } })) as CallToolResult);
      expect(scopedText).toContain(`Strict queue: checkout takes ${refs.first} Show the order summary on phones first, outside this view`);
      expect(scopedText.split("\n").at(-1)).toBe(`Take ${refs.first} first: say "Work ${refs.first}".`);
    } finally {
      withStore((store) => store.setSetting("queue.policy", "advisory", "pat"));
    }
  });
});

describe("gates in the lanes", () => {
  /** A second workspace: a gate holding more rows than a lane carries, a nested gate, a sent-back gate. */
  const wide = { db: "", wideGate: "", outer: "", inner: "", innerChild: "", sentBack: "", sentBackFromCard: "" };

  beforeAll(() => {
    const ws = initWorkspace({ global: true, slug: "gates" });
    wide.db = ws.dbPath;
    const s = ws.store;
    const epic = s.createIssue({ title: "Launch week", kind: "epic" });
    for (let i = 1; i <= 23; i++) s.createIssue({ title: `Launch step ${i}`, parent: epic.identifier, status: "todo" });
    s.gateIssue(epic.identifier, { owner: "reviewer" }, "pat");
    wide.wideGate = epic.identifier;
    const outer = s.createIssue({ title: "Payments revamp", kind: "epic" });
    const inner = s.createIssue({ title: "Card vault", kind: "epic", parent: outer.identifier });
    wide.innerChild = s.createIssue({ title: "Tokenise cards", parent: inner.identifier, status: "todo" }).identifier;
    s.gateIssue(inner.identifier, { owner: "vault-owner" }, "pat");
    s.gateIssue(outer.identifier, { owner: "lead" }, "pat");
    wide.outer = outer.identifier;
    wide.inner = inner.identifier;
    const sentBack = s.createIssue({ title: "Referral codes", kind: "epic" });
    s.createIssue({ title: "Share a referral link", parent: sentBack.identifier, status: "todo" });
    s.gateIssue(sentBack.identifier, { owner: "reviewer" }, "pat");
    s.requestChanges(sentBack.identifier, { comment: "Split the payout out first." }, "reviewer");
    wide.sentBack = sentBack.identifier;
    const fromCard = s.createIssue({ title: "Store credit", kind: "epic" });
    s.createIssue({ title: "Refund to store credit", parent: fromCard.identifier, status: "todo" });
    s.gateIssue(fromCard.identifier, { owner: "reviewer" }, "pat");
    s.requestChanges(fromCard.identifier, { comment: "Name the expiry rule.", person: { via: "ticket_card" } }, "Mira Lane");
    wide.sentBackFromCard = fromCard.identifier;
    ws.store.db.close();
  });

  it("caps a gate's rows at twenty and says how many it holds, counts tickets not gates, and approves a sent-back gate", async () => {
    const client = await connect({ apps: true, db: wide.db });
    const shown = await lanes(client);
    const big = shown.gated.find((group) => group.identifier === wide.wideGate)!;
    expect(big.holds).toHaveLength(20);
    expect(big.heldTotal).toBe(23);
    const sentBack = shown.gated.find((group) => group.identifier === wide.sentBack)!;
    expect(sentBack).toMatchObject({ state: "changes_requested", resolvedBy: "reviewer", resolvedVia: null, owner: "reviewer", approve: true, heldTotal: 1 });
    // Sent back by a person from the card: the lane says who and where.
    expect(shown.gated.find((group) => group.identifier === wide.sentBackFromCard)).toMatchObject({
      state: "changes_requested",
      resolvedBy: "Mira Lane",
      resolvedVia: "ticket_card",
    });
    expect(shown.totals.gated).toBe(shown.gated.reduce((sum, group) => sum + group.heldTotal, 0));
    expect(shown.totals.gates).toBe(shown.gated.length);
    const shownText = text((await client.callTool({ name: "show_queue", arguments: {} })) as CallToolResult);
    expect(shownText).toMatch(new RegExp(`  ${wide.wideGate} Launch week: waiting on reviewer; holds [A-Z]+-\\d+(, [A-Z]+-\\d+){19} and 3 more\\.`));
    expect(shownText).toContain(`  ${wide.sentBack} Referral codes: changes requested by reviewer, owner reviewer;`);
    expect(shownText).toContain(`  ${wide.sentBackFromCard} Store credit: changes requested by Mira Lane from the card, owner reviewer;`);
  });

  it("says an inner gate waits on the outer one after it is approved", async () => {
    const client = await connect({ apps: true, db: wide.db });
    const shown = await lanes(client);
    // The resolver reports the NEAREST gate a row is queued behind: the inner one.
    const inner = shown.gated.find((group) => group.identifier === wide.inner)!;
    expect(inner.holds.map((row) => row.identifier)).toEqual([wide.innerChild]);
    expect(inner.behind).toEqual({ identifier: wide.outer, owner: "lead" });
    expect(text((await client.callTool({ name: "show_queue", arguments: {} })) as CallToolResult)).toContain(
      `  ${wide.inner} Card vault: waiting on vault-owner; holds ${wide.innerChild}; then waits on ${wide.outer} (lead). Approve with approve_task.`,
    );
  });
});

describe.skipIf(Boolean(reason))("the queue view in a host", () => {
  async function queueView(theme: "light" | "dark" = "light", tool = "show_queue", args: Record<string, unknown> = {}): Promise<RenderedView> {
    const client = await connect({ apps: true });
    return renderView(browser!, client, await loadView(client, tool, args), { theme, width: WIDTH });
  }

  for (const theme of ["light", "dark"] as const) {
    it(`paints the three lanes at ${WIDTH}px in the host's ${theme} theme`, async () => {
      const view = await queueView(theme);
      try {
        expectPainted(await measurePaint(view), theme, WIDTH);
        const article = view.frame.locator('[data-view="queue"]');
        expect(await article.getAttribute("data-next")).toBe(refs.first);
        const ready = view.frame.locator('[data-lane="ready"] [data-row]');
        expect(await ready.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")))).toEqual([
          refs.first,
          refs.second,
          refs.unqueued,
          refs.scopeChild,
        ]);
        expect(await view.frame.locator('[data-lane="ready"] [data-next]').getAttribute("data-row")).toBe(refs.first);
        expect(await view.frame.locator('[data-lane="ready"] [data-action="take"]').count()).toBe(4);
        const gate = view.frame.locator(`[data-lane="gated"] [data-gate="${refs.gate}"]`);
        expect(await gate.innerText()).toContain("waiting on reviewer");
        expect(await gate.innerText()).toContain(`holds ${refs.gateChildren.join(", ")}`);
        const working = view.frame.locator(`[data-lane="in-progress"] [data-row="${refs.working}"]`);
        expect(await working.getAttribute("data-held-by")).toBe("pat");
        expect(await working.innerText()).toContain("2 milestones");
        expect(await working.innerText()).toContain("Last: One clear decline message");
        expect(await view.frame.locator("[data-blocked]").innerText()).toContain(`${refs.blocked} (by ${refs.first})`);
      } finally {
        await view.context.close();
      }
    });
  }

  it("Take posts “Work <REF>” into the thread through the host, and marks the row sent", async () => {
    const view = await queueView();
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      await view.frame.locator(`[data-row="${refs.second}"] [data-action="take"]`).click();
      await view.frame.locator(`[data-row="${refs.second}"][data-taken]`).waitFor();
      const record = await view.record();
      expect(record.messages).toEqual([{ role: "user", content: [{ type: "text", text: `Work ${refs.second}` }] }]);
      // A message is not a tool call: nothing was claimed by the view.
      expect(record.toolCalls).toEqual([]);
      expect(await view.frame.locator("[data-action-note]").innerText()).toBe(`Sent “Work ${refs.second}” to the thread.`);
      // The sent mark survives a theme change.
      await view.setTheme("dark");
      await expect.poll(() => view.frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
      expect(await view.frame.locator(`[data-row="${refs.second}"] [data-sent]`).count()).toBe(1);
      expect(withStore((store) => store.getIssue(refs.second).checkoutAgent)).toBeNull();
      // Nobody took it, so a fresh read offers Take again instead of a stale Sent.
      await view.frame.locator('[data-action="refresh"]').click();
      await view.frame.locator(`[data-row="${refs.second}"] [data-action="take"]`).waitFor();
      expect(await view.frame.locator("[data-sent]").count()).toBe(0);
    } finally {
      await view.context.close();
    }
  });

  it("under strict, the rows after the expected one wait for it instead of offering Take", async () => {
    withStore((store) => store.setSetting("queue.policy", "strict", "pat"));
    try {
      const view = await queueView("dark");
      try {
        expectPainted(await measurePaint(view), "dark", WIDTH);
        expect(await view.frame.locator('[data-view="queue"]').getAttribute("data-policy")).toBe("strict");
        expect(await view.frame.locator("[data-expected]").innerText()).toContain(`checkout takes ${refs.first} now`);
        expect(await view.frame.locator('[data-lane="ready"] [data-action="take"]').count()).toBe(1);
        expect(await view.frame.locator(`[data-row="${refs.first}"] [data-action="take"]`).count()).toBe(1);
        expect(await view.frame.locator(`[data-row="${refs.second}"] [data-waits-for]`).innerText()).toBe(`after ${refs.first}`);
      } finally {
        await view.context.close();
      }
    } finally {
      withStore((store) => store.setSetting("queue.policy", "advisory", "pat"));
    }
  });

  it("Approve approves the gate under the configured humanName, never the agent, and the released work shows as ready", async () => {
    updateConfig(process.env.STAPLE_HOME!, { humanName: "Mira Lane" });
    const view = await queueView();
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      await view.frame.locator(`[data-gate="${refs.gate}"] [data-action="approve"]`).click();
      await view.frame.getByText(`Approved ${refs.gate} by Mira Lane · from the queue.`).waitFor();
      // The approval's answer carries the lanes: one call, so one host prompt.
      expect((await view.record()).toolCalls).toEqual(["approve_gate_from_view"]);
      expect(await view.frame.locator(`[data-gate="${refs.gate}"]`).count()).toBe(0);
      const ready = await view.frame
        .locator('[data-lane="ready"] [data-row]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));
      for (const child of refs.gateChildren) expect(ready).toContain(child);
      withStore((store) => {
        expect(store.gate(refs.gate)).toMatchObject({ state: "approved", resolvedBy: "Mira Lane" });
        expect(store.listComments(refs.gate).at(-1)).toMatchObject({
          author: "Mira Lane",
          authorType: "user",
          body: "Approved by Mira Lane from the queue.",
        });
        expect(store.gateDecision(refs.gate)).toMatchObject({ state: "approved", by: "Mira Lane", via: "queue" });
        expect(store.listEvents(0, 1000).some((event) => event.actor === AGENT)).toBe(false);
      });
      // The lanes on screen are the resolver's after the approval, too.
      const client = await connect({ apps: true });
      expectLanesMatchResolver(await lanes(client));
    } finally {
      updateConfig(process.env.STAPLE_HOME!, { humanName: "" });
      await view.context.close();
    }
  });
});
