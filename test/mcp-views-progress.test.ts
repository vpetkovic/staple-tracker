/// <reference lib="dom" />
/**
 * The progress view (`ui://staple/progress`), served by the packaged `staple mcp` and rendered
 * in the minimal, host-agnostic MCP Apps host (`npm run test:views`; also part of `npm test`).
 *
 * `show_progress` answers with the ticket's current attempt: its timeline of milestones and
 * comments, estimate against elapsed and last activity; a host without MCP Apps gets the
 * milestones as prose. In the host the view paints at 360px in both themes and keeps itself
 * current: a milestone recorded from outside the thread appears with no click, through
 * nothing but `show_progress`, which is read-only (a host asks nobody before it). When the
 * host refuses the reads (its agent session is gone) or tears the view down, the view stops
 * and says so; Check again resumes it.
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
import { testPackageDir } from "./fixtures/package-payload.js";
import { MCP_APPS_EXTENSION, expectPainted, loadView, measurePaint, renderView, type RenderedView, type ViewSource } from "./fixtures/mcp-apps-harness.js";

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
if (reason) console.warn(`mcp-views-progress: browser tests skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("mcp-views-progress: a browser to run in", () => {
    it("has Chromium", () => {
      throw new Error(`mcp-views-progress cannot run in CI: ${reason}.`);
    });
  });
}

const WIDTH = 360;
const UI_BASE = "http://127.0.0.1:4999/";
/** The refresh period the tests run the view at, so a wait is a second, not five. */
const FAST_REFRESH = 1;
const HOST_REFUSAL = "The app's thread is not running. Send a message in the thread that created it to use the app again.";

let home: string;
let dbPath: string;
let slug: string;
let browser: Browser | undefined;
const clients: Client[] = [];

/** The seeded tickets, by role. */
const refs = {
  /** In progress: claimed by pat, two milestones (one pointing at a comment), one comment. */
  worked: "",
  /** In progress, for the refresh test: one milestone so far. */
  live: "",
  /** In progress, for the refusal and Check again test. */
  refused: "",
  /** In progress, for the teardown test. */
  torn: "",
  /** Claimed and done: the attempt ended. */
  finished: "",
  /** Never started. */
  idle: "",
  /** Forty milestones: the payload keeps the newest twenty. */
  long: "",
  /** Its claim cleared where nothing swept it (as a synced clear arrives): an end the read derives. */
  orphaned: "",
  /** Another in-progress ticket, for a view handed a new ticket mid-read. */
  next: "",
};

async function connect(options: { apps: boolean; uiUrl?: string }): Promise<Client> {
  // Built from scratch: a STAPLE_DB or STAPLE_WS from the shell must never reach this server.
  const { STAPLE_DB: _db, STAPLE_WS: _ws, STAPLE_UI_URL: _ui, ...inherited } = process.env as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(testPackageDir(), "staple.mjs"), "mcp"],
    cwd: home,
    env: { ...inherited, STAPLE_DB: dbPath, STAPLE_AGENT: "progress-test", STAPLE_UI_URL: options.uiUrl ?? UI_BASE, NODE_NO_WARNINGS: "1" },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "progress-test-host", version: "0.0.0" },
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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-progress-"));
  process.env.STAPLE_HOME = join(home, ".staple");
  const ws = initWorkspace({ global: true, slug: "watch" });
  dbPath = ws.dbPath;
  slug = ws.store.slug;
  const s = ws.store;

  const worked = s.createIssue({ title: "Retry failed card payments", priority: "high", estimatedSeconds: 3 * 3600 });
  s.checkoutIssue(worked.identifier, "pat");
  s.recordAttemptEvent(worked.identifier, "milestone", "pat", { label: "Retry scheduler wired" });
  s.addComment(worked.identifier, "Declines now wait 30 seconds before one retry.\nDetails in the worklog.", "pat", "agent");
  const pointer = s.addComment(worked.identifier, "Order log shows each retry with its outcome.", "pat", "agent");
  s.recordAttemptEvent(worked.identifier, "milestone", "pat", { label: "Retries visible in the order log", commentId: pointer.id });
  refs.worked = worked.identifier;

  for (const role of ["live", "refused", "torn", "next"] as const) {
    const issue = s.createIssue({ title: `Gift card balance: ${role}`, estimatedSeconds: 2 * 3600 });
    s.checkoutIssue(issue.identifier, "pat");
    s.recordAttemptEvent(issue.identifier, "milestone", "pat", { label: "Balance endpoint drafted" });
    refs[role] = issue.identifier;
  }

  const finished = s.createIssue({ title: "Add saved cards" });
  s.checkoutIssue(finished.identifier, "pat");
  s.recordAttemptEvent(finished.identifier, "milestone", "pat", { label: "Cards tokenised" });
  s.updateIssue(finished.identifier, { status: "done" }, "pat");
  refs.finished = finished.identifier;

  refs.idle = s.createIssue({ title: "Show the order summary on phones", status: "todo" }).identifier;

  const long = s.createIssue({ title: "Loyalty points" });
  s.checkoutIssue(long.identifier, "pat");
  for (let i = 1; i <= 40; i++) s.recordAttemptEvent(long.identifier, "milestone", "pat", { label: `Step ${i}` });
  refs.long = long.identifier;

  const orphaned = s.createIssue({ title: "Partial refunds" });
  s.checkoutIssue(orphaned.identifier, "pat");
  s.recordAttemptEvent(orphaned.identifier, "milestone", "pat", { label: "Refund ledger drafted" });
  s.addComment(orphaned.identifier, "Ledger rows carry the original order.", "pat", "agent");
  const after = s.addComment(orphaned.identifier, "Picked up again later by someone else.", "sam", "agent");
  // The claim is gone with no mutation here to end the attempt, and the second comment was
  // posted an hour after: it is not part of the attempt the view shows.
  s.db.prepare("UPDATE issues SET checkout_agent = NULL WHERE id = ?").run(orphaned.id);
  s.db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(new Date(Date.now() + 3_600_000).toISOString(), after.id);
  refs.orphaned = orphaned.identifier;
  ws.store.db.close();
  if (!reason) browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  if (home) rmSync(home, { recursive: true, force: true });
});

type Progress = {
  identifier: string;
  attempt: { ordinal: number; agent: string; state: string; current: boolean } | null;
  timeline: Array<{ kind: string; text: string; detail: string | null; actor: string | null }>;
  earlier: number;
  milestoneCount: number;
  live: boolean;
  refreshSeconds: number;
  url: string | null;
};

const progressOf = (result: CallToolResult): Progress => (result.structuredContent as { progress: Progress }).progress;

describe("show_progress over MCP", () => {
  it("serves ui://staple/progress, and show_progress declares it and is read-only", async () => {
    const client = await connect({ apps: true });
    const { resources } = await client.listResources();
    expect(resources.find((resource) => resource.uri === "ui://staple/progress")).toMatchObject({
      name: "progress",
      mimeType: "text/html;profile=mcp-app",
    });
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "show_progress")!;
    expect(tool._meta).toEqual({ ui: { resourceUri: "ui://staple/progress" }, "ui/resourceUri": "ui://staple/progress" });
    // Read-only is what lets a host run the view's refresh without asking anyone.
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("answers with the attempt's timeline: milestones, the comment one points at, comments, time and the link", async () => {
    const client = await connect({ apps: true });
    const result = (await client.callTool({ name: "show_progress", arguments: { ref: refs.worked } })) as CallToolResult;
    expect(result._meta).toEqual({ ui: { resourceUri: "ui://staple/progress" } });
    const progress = progressOf(result);
    expect(progress).toMatchObject({
      identifier: refs.worked,
      attempt: { ordinal: 1, agent: "pat", state: "running", current: true },
      earlier: 0,
      milestoneCount: 2,
      live: true,
      refreshSeconds: 5,
      url: `${UI_BASE}?ws=${slug}&issue=${refs.worked}`,
    });
    expect(progress.timeline.map(({ kind, text: line, detail }) => ({ kind, text: line, detail }))).toEqual([
      { kind: "started", text: "Started by pat", detail: null },
      { kind: "milestone", text: "Retry scheduler wired", detail: null },
      // The comment's first line only; the pointed-at comment shows under its milestone, not twice.
      { kind: "comment", text: "Declines now wait 30 seconds before one retry.", detail: null },
      { kind: "milestone", text: "Retries visible in the order log", detail: "Order log shows each retry with its outcome." },
    ]);
    expect((result.structuredContent as { progress: { timing: unknown } }).progress.timing).toMatchObject({ estimatedSeconds: 3 * 3600 });
  });

  it("keeps the newest twenty entries and counts the rest", async () => {
    const client = await connect({ apps: true });
    const progress = progressOf((await client.callTool({ name: "show_progress", arguments: { ref: refs.long } })) as CallToolResult);
    expect(progress.milestoneCount).toBe(40);
    expect(progress.timeline).toHaveLength(20);
    // 41 entries (started + 40 milestones): the oldest 21 are left out.
    expect(progress.earlier).toBe(21);
    expect(progress.timeline.at(-1)!.text).toBe("Step 40");
    expect(progress.timeline[0]!.text).toBe("Step 21");
  });

  it("reads an ended attempt as not live, and a ticket never started as no attempt", async () => {
    const client = await connect({ apps: true });
    const finished = progressOf((await client.callTool({ name: "show_progress", arguments: { ref: refs.finished } })) as CallToolResult);
    expect(finished).toMatchObject({ live: false, attempt: { current: false, state: "ended" } });
    expect(finished.timeline.at(-1)).toMatchObject({ kind: "ended" });
    const idle = progressOf((await client.callTool({ name: "show_progress", arguments: { ref: refs.idle } })) as CallToolResult);
    expect(idle).toMatchObject({ live: false, attempt: null, timeline: [], milestoneCount: 0 });
  });

  it("ends an attempt the read derives as ended, and leaves out comments posted after it", async () => {
    const client = await connect({ apps: true });
    const progress = progressOf((await client.callTool({ name: "show_progress", arguments: { ref: refs.orphaned } })) as CallToolResult);
    expect(progress).toMatchObject({ live: false, attempt: { state: "ended", current: false } });
    expect(progress.timeline.map(({ kind, text: line }) => [kind, line])).toEqual([
      ["started", "Started by pat"],
      ["milestone", "Refund ledger drafted"],
      ["comment", "Ledger rows carry the original order."],
      ["ended", expect.stringMatching(/^Ended/)],
    ]);
  });

  it("answers a host without MCP Apps with the milestones in readable text", async () => {
    const client = await connect({ apps: false });
    const lines = text((await client.callTool({ name: "show_progress", arguments: { ref: refs.worked } })) as CallToolResult).split("\n");
    expect(lines[0]).toBe(`${refs.worked} Retry failed card payments`);
    expect(lines[1]).toMatch(/^In Progress · attempt #1 by pat: running, since \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    expect(lines).toContain("Milestones (2):");
    expect(lines.filter((line) => line.startsWith("  - "))).toEqual([
      expect.stringMatching(/^ {2}- \d{4}-\d\d-\d\d \d\d:\d\d UTC Retry scheduler wired$/),
      expect.stringMatching(/^ {2}- .* UTC Retries visible in the order log \(Order log shows each retry with its outcome\.\)$/),
    ]);
    expect(lines.at(-1)).toBe(`Open in Staple: ${UI_BASE}?ws=${slug}&issue=${refs.worked}`);
    const idle = text((await client.callTool({ name: "show_progress", arguments: { ref: refs.idle } })) as CallToolResult);
    expect(idle).toContain("no attempt yet");
    const missing = (await client.callTool({ name: "show_progress", arguments: { ref: "NOPE-999" } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^ERROR\(not_found\)/);
  });
});

describe.skipIf(Boolean(reason))("the progress view in a host", () => {
  /** The view's own refresh period, made short for the test; the product sends 5 seconds. */
  function fast(source: ViewSource): ViewSource {
    const structured = source.toolResult.structuredContent as { progress: { refreshSeconds: number } };
    return { ...source, toolResult: { ...source.toolResult, structuredContent: { progress: { ...structured.progress, refreshSeconds: FAST_REFRESH } } } };
  }

  /** Every read the view makes through the host comes back with the short period too. */
  async function keepFast(view: RenderedView): Promise<void> {
    await view.page.evaluate((seconds) => {
      const forward = window.hostCallTool;
      window.hostCallTool = async (params) => {
        const result = await forward(params);
        const progress = (result.structuredContent as { progress?: { refreshSeconds: number } } | undefined)?.progress;
        if (progress) progress.refreshSeconds = seconds;
        return result;
      };
    }, FAST_REFRESH);
  }

  async function show(ref: string, options: { theme?: "light" | "dark"; serverTools?: boolean; quick?: boolean } = {}): Promise<RenderedView> {
    const client = await connect({ apps: true });
    const source = await loadView(client, "show_progress", { ref });
    const view = await renderView(browser!, client, options.quick === false ? source : fast(source), {
      theme: options.theme ?? "light",
      width: WIDTH,
      serverTools: options.serverTools,
    });
    if (options.quick !== false) await keepFast(view);
    return view;
  }

  for (const theme of ["light", "dark"] as const) {
    it(`paints the timeline at ${WIDTH}px in the host's ${theme} theme`, async () => {
      const view = await show(refs.worked, { theme, quick: false });
      try {
        expectPainted(await measurePaint(view), theme, WIDTH);
        const article = view.frame.locator('[data-view="progress"]');
        expect(await article.getAttribute("data-ticket")).toBe(refs.worked);
        const shown = await article.innerText();
        expect(shown).toContain("Retry failed card payments");
        expect(shown).toContain("Attempt #1 · pat · running");
        expect(shown).toContain("of 3h estimate");
        expect(await view.frame.locator('[data-entry="milestone"]').allInnerTexts()).toEqual([
          expect.stringContaining("Retry scheduler wired"),
          expect.stringContaining("Order log shows each retry with its outcome."),
        ]);
        expect(await view.frame.locator('[data-entry="comment"]').innerText()).toContain("comment by pat");
        expect(await view.frame.locator('[data-live="live"]').innerText()).toMatch(/^Live · updated /);
      } finally {
        await view.context.close();
      }
    });
  }

  it("shows a milestone recorded outside the thread with no click, reading only show_progress", async () => {
    const view = await show(refs.live);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      expect(await view.frame.locator('[data-entry="milestone"]').count()).toBe(1);
      const before = await view.frame.locator('[data-view="progress"]').getAttribute("data-as-of");
      // Recorded by the agent's own surface, from outside the view: nothing in the view is touched.
      withStore((store) => store.recordAttemptEvent(refs.live, "milestone", "pat", { label: "Balances shown on the account page" }));
      await view.frame.getByText("Balances shown on the account page").waitFor({ timeout: 10_000 });
      expect(await view.frame.locator('[data-entry="milestone"]').count()).toBe(2);
      expect(await view.frame.locator("[data-milestones]").innerText()).toBe("2");
      expect(await view.frame.locator('[data-view="progress"]').getAttribute("data-as-of")).not.toBe(before);
      const { toolCalls, messages } = await view.record();
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(new Set(toolCalls)).toEqual(new Set(["show_progress"]));
      expect(messages).toEqual([]);
    } finally {
      await view.context.close();
    }
  });

  it("stops and says so when the host refuses the reads, and Check again resumes", async () => {
    const view = await show(refs.refused);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      // From here the host refuses every call, as a host whose agent session ended does.
      await view.page.evaluate((refusal) => {
        const forward = window.hostCallTool;
        (window as unknown as { hostForward: typeof forward }).hostForward = forward;
        window.hostCallTool = async () => {
          throw new Error(refusal);
        };
      }, HOST_REFUSAL);
      const stopped = view.frame.locator('[data-live="stopped"]');
      await stopped.waitFor({ timeout: 10_000 });
      expect(await stopped.innerText()).toContain(`Live updates stopped. ${HOST_REFUSAL}`);
      // The timeline that was on screen stays.
      expect(await view.frame.getByText("Balance endpoint drafted").count()).toBe(1);
      // Stopped means stopped: no further reads.
      const calls = (await view.record()).toolCalls.length;
      await view.page.waitForTimeout(2_500);
      expect((await view.record()).toolCalls.length).toBe(calls);
      expectPainted(await measurePaint(view), "light", WIDTH);

      // The session is back; a person checks again, and the view follows again.
      await view.page.evaluate(() => {
        window.hostCallTool = (window as unknown as { hostForward: typeof window.hostCallTool }).hostForward;
      });
      await keepFast(view);
      withStore((store) => store.recordAttemptEvent(refs.refused, "milestone", "pat", { label: "Partial payments accepted" }));
      await view.frame.locator('[data-action="check-again"]').click();
      await view.frame.getByText("Partial payments accepted").waitFor({ timeout: 10_000 });
      await view.frame.locator('[data-live="live"]').waitFor();
      const resumed = (await view.record()).toolCalls.length;
      await expect.poll(async () => (await view.record()).toolCalls.length, { timeout: 5_000 }).toBeGreaterThan(resumed);
    } finally {
      await view.context.close();
    }
  });

  it("follows the new ticket when the host hands the view another one while a read is out", async () => {
    const client = await connect({ apps: true });
    const view = await renderView(browser!, client, fast(await loadView(client, "show_progress", { ref: refs.live })), {
      theme: "light",
      width: WIDTH,
    });
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      // The next read is slow to come back; the host hands over another ticket meanwhile.
      await view.page.evaluate((seconds) => {
        const forward = window.hostCallTool;
        let first = true;
        window.hostCallTool = async (params) => {
          if (first) {
            first = false;
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
          const result = await forward(params);
          const progress = (result.structuredContent as { progress?: { refreshSeconds: number } } | undefined)?.progress;
          if (progress) progress.refreshSeconds = seconds;
          return result;
        };
      }, FAST_REFRESH);
      await expect.poll(async () => (await view.record()).toolCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
      await view.sendResult(fast(await loadView(client, "show_progress", { ref: refs.next })).toolResult);
      await view.frame.locator(`[data-ticket="${refs.next}"]`).waitFor();
      withStore((store) => store.recordAttemptEvent(refs.next, "milestone", "pat", { label: "Balance shown on receipts" }));
      await view.frame.getByText("Balance shown on receipts").waitFor({ timeout: 10_000 });
      expect(await view.frame.locator('[data-live="live"]').count()).toBe(1);
    } finally {
      await view.context.close();
    }
  });

  it("stops when the host tears the view down", async () => {
    const view = await show(refs.torn);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      await view.teardown();
      await view.frame.locator('[data-live="stopped"]').waitFor();
      expect(await view.frame.locator('[data-live="stopped"]').innerText()).toContain("the host closed this view");
      const calls = (await view.record()).toolCalls.length;
      await view.page.waitForTimeout(2_500);
      expect((await view.record()).toolCalls.length).toBe(calls);
    } finally {
      await view.context.close();
    }
  });

  it("does not poll an ended attempt, and offers Check again", async () => {
    const view = await show(refs.finished, { theme: "dark" });
    try {
      expectPainted(await measurePaint(view), "dark", WIDTH);
      expect(await view.frame.locator('[data-live="idle"]').innerText()).toContain("Attempt ended, so not refreshing");
      expect(await view.frame.locator('[data-entry="ended"]').count()).toBe(1);
      await view.page.waitForTimeout(2_500);
      expect((await view.record()).toolCalls).toEqual([]);
      await view.frame.locator('[data-action="check-again"]').click();
      await expect.poll(async () => (await view.record()).toolCalls).toEqual(["show_progress"]);
    } finally {
      await view.context.close();
    }
  });

  it("says it will not refresh in a host that lets views call no tools", async () => {
    const view = await show(refs.worked, { serverTools: false });
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      expect(await view.frame.locator('[data-live="static"]').innerText()).toContain("will not refresh");
      await view.page.waitForTimeout(2_500);
      expect((await view.record()).toolCalls).toEqual([]);
      expect(await view.frame.locator('[data-action="check-again"]').count()).toBe(0);
    } finally {
      await view.context.close();
    }
  });

  it("paints a ticket that was never started", async () => {
    const view = await show(refs.idle, { quick: false });
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      expect(await view.frame.locator('[data-live="idle"]').innerText()).toContain("No attempt yet");
      expect(await view.frame.locator("[data-timeline]").count()).toBe(0);
    } finally {
      await view.context.close();
    }
  });
});
