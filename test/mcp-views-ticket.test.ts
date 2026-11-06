/// <reference lib="dom" />
/**
 * The ticket card (`ui://staple/ticket`), served by the packaged `staple mcp` and rendered in
 * the minimal, host-agnostic MCP Apps host (`npm run test:views`; also part of `npm test`).
 *
 * `show_ticket` answers with the card, `checkout_task` declares the same view and carries
 * the card, `get_task` (the agent's own read) declares none, and a host without MCP Apps
 * gets the card as prose. In the host the card paints at 360px in both themes, never calls a
 * tool on its own (hosts such as T3 Code ask the person before every call a view makes), and
 * its buttons go through the host: Approve and Request changes call the
 * app-only approve_gate_from_view and request_changes_from_view (the note rides along), which
 * record the person (the machine's humanName, else the gate's owner), never the server's
 * STAPLE_AGENT, and answer with the card the view redraws from; Open in Staple asks the host
 * to open the web UI's deep link. Each write is checked in the workspace afterwards, not only
 * on screen.
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
if (reason) console.warn(`mcp-views-ticket: browser tests skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("mcp-views-ticket: a browser to run in", () => {
    it("has Chromium", () => {
      throw new Error(`mcp-views-ticket cannot run in CI: ${reason}.`);
    });
  });
}

const WIDTH = 360;
const UI_BASE = "http://127.0.0.1:4999/";
const AGENT = "card-test";

let home: string;
let dbPath: string;
let slug: string;
let browser: Browser | undefined;
const clients: Client[] = [];

/** The seeded tickets, by role. */
const refs = {
  /** A task in progress: claimed, a branch pointer, an estimate, three open criteria. */
  worked: "",
  /** An epic with a pending gate, for Approve. */
  approveGate: "",
  /** An epic with a pending gate, for Request changes. */
  sendBackGate: "",
  /** An epic with a pending gate, approved through a host that drops the card from the answer. */
  rereadFails: "",
  /** A todo task nobody holds, for checkout_task. */
  free: "",
  /** A done task: its criteria read as met. */
  finished: "",
};

async function connect(options: { apps: boolean; uiUrl?: string }): Promise<Client> {
  // Built from scratch: a STAPLE_DB or STAPLE_WS from the shell must never reach this server.
  const { STAPLE_DB: _db, STAPLE_WS: _ws, STAPLE_UI_URL: _ui, ...inherited } = process.env as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(testPackageDir(), "staple.mjs"), "mcp"],
    cwd: home,
    env: {
      ...inherited,
      STAPLE_DB: dbPath,
      STAPLE_AGENT: AGENT,
      STAPLE_UI_URL: options.uiUrl ?? UI_BASE,
      NODE_NO_WARNINGS: "1",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "card-test-host", version: "0.0.0" },
    { capabilities: options.apps ? { extensions: MCP_APPS_EXTENSION } : {} },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function text(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/** The workspace as it stands now, read beside the server. */
function store() {
  return resolveWorkspace({ db: dbPath }).store;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-card-"));
  process.env.STAPLE_HOME = join(home, ".staple");
  const ws = initWorkspace({ global: true, slug: "cards" });
  dbPath = ws.dbPath;
  slug = ws.store.slug;
  const s = ws.store;
  const worked = s.createIssue({
    title: "Retry failed card payments",
    priority: "high",
    assignee: "pat",
    acceptanceCriteria: ["Retried once after 30 seconds", "One clear message", "Visible in the order log"],
    estimatedSeconds: 3 * 3600,
  });
  s.checkoutIssue(worked.identifier, "pat");
  s.addComment(worked.identifier, "Branch pointer: branch fix/payment-retry, base 9c41d07.", "pat", "agent");
  refs.worked = worked.identifier;

  for (const [role, title] of [
    ["approveGate", "Checkout redesign"],
    ["sendBackGate", "Gift cards"],
    ["rereadFails", "Loyalty points"],
  ] as const) {
    const epic = s.createIssue({ title, kind: "epic", acceptanceCriteria: ["Works on a phone"] });
    s.createIssue({ title: `${title}: first step`, parent: epic.identifier });
    s.gateIssue(epic.identifier, { owner: "reviewer", comment: "Ready for review." }, "pat");
    refs[role] = epic.identifier;
  }
  refs.free = s.createIssue({ title: "Show the order summary on phones", status: "todo" }).identifier;
  const finished = s.createIssue({ title: "Add saved cards", acceptanceCriteria: ["Cards are tokenised"] });
  s.checkoutIssue(finished.identifier, "pat");
  s.updateIssue(finished.identifier, { status: "done" }, "pat");
  refs.finished = finished.identifier;
  ws.store.db.close();
  if (!reason) browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("the ticket card over MCP", () => {
  it("serves ui://staple/ticket, show_ticket and checkout_task declare it, and get_task does not", async () => {
    const client = await connect({ apps: true });
    const { resources } = await client.listResources();
    expect(resources.find((resource) => resource.uri === "ui://staple/ticket")).toMatchObject({
      name: "ticket",
      mimeType: "text/html;profile=mcp-app",
    });
    const { tools } = await client.listTools();
    for (const name of ["show_ticket", "checkout_task"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool._meta, name).toEqual({ ui: { resourceUri: "ui://staple/ticket" }, "ui/resourceUri": "ui://staple/ticket" });
    }
    // The agent reads tickets with get_task all the time: a card for each would be noise.
    expect(tools.find((tool) => tool.name === "get_task")!._meta).toBeUndefined();
    expect(tools.find((tool) => tool.name === "show_ticket")!.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("answers show_ticket with the card: status, criteria, attempt, branch, time and the deep link", async () => {
    const client = await connect({ apps: true });
    const result = (await client.callTool({ name: "show_ticket", arguments: { ref: refs.worked } })) as CallToolResult;
    expect(result._meta).toEqual({ ui: { resourceUri: "ui://staple/ticket" } });
    expect(result.structuredContent).toMatchObject({
      ticket: {
        workspace: slug,
        identifier: refs.worked,
        title: "Retry failed card payments",
        status: { id: "in_progress", label: "In Progress", category: "active" },
        kind: { id: "task", label: "Task" },
        priority: "high",
        assignee: "pat",
        criteria: [
          { text: "Retried once after 30 seconds", mark: "open" },
          { text: "One clear message", mark: "open" },
          { text: "Visible in the order log", mark: "open" },
        ],
        gate: null,
        queuedBy: null,
        attempt: { ordinal: 1, agent: "pat", state: "running", current: true },
        branch: { name: "fix/payment-retry", base: "9c41d07", author: "pat" },
        timing: { estimatedSeconds: 3 * 3600 },
        url: `${UI_BASE}?ws=${slug}&issue=${refs.worked}`,
        actions: { approve: false, requestChanges: false },
      },
    });
  });

  it("marks a done ticket's criteria met, and offers the gate buttons only while a gate is pending", async () => {
    const client = await connect({ apps: true });
    const done = (await client.callTool({ name: "show_ticket", arguments: { ref: refs.finished } })) as CallToolResult;
    expect((done.structuredContent as { ticket: { criteria: unknown } }).ticket.criteria).toEqual([{ text: "Cards are tokenised", mark: "met" }]);
    const gated = (await client.callTool({ name: "show_ticket", arguments: { ref: refs.approveGate } })) as CallToolResult;
    expect(gated.structuredContent).toMatchObject({
      ticket: {
        status: { id: "awaiting_approval" },
        gate: { state: "pending", owner: "reviewer", requestedBy: "pat", resolvedBy: null },
        actions: { approve: true, requestChanges: true },
      },
    });
  });

  it("answers a host without MCP Apps in readable text", async () => {
    const client = await connect({ apps: false });
    const worked = text((await client.callTool({ name: "show_ticket", arguments: { ref: refs.worked } })) as CallToolResult);
    expect(worked.split("\n")).toEqual([
      `${refs.worked} Retry failed card payments`,
      "In Progress · Task · high priority · assigned to pat",
      "Attempt #1 by pat: running.",
      "Branch fix/payment-retry (base 9c41d07).",
      expect.stringMatching(/^Estimate 3h, ran \d+s\.$/),
      "Done when:",
      "  [ ] Retried once after 30 seconds",
      "  [ ] One clear message",
      "  [ ] Visible in the order log",
      `Open in Staple: ${UI_BASE}?ws=${slug}&issue=${refs.worked}`,
    ]);
    const gated = text((await client.callTool({ name: "show_ticket", arguments: { ref: refs.approveGate } })) as CallToolResult);
    expect(gated).toContain("Gate pending: waiting on reviewer (requested by pat). Approve with approve_task, or send it back with request_changes.");
    expect(() => JSON.parse(worked)).toThrow();
  });

  it("leaves the link out with STAPLE_UI_URL=off, and refuses an unknown ticket", async () => {
    const client = await connect({ apps: true, uiUrl: "off" });
    const result = (await client.callTool({ name: "show_ticket", arguments: { ref: refs.worked } })) as CallToolResult;
    expect((result.structuredContent as { ticket: { url: unknown } }).ticket.url).toBeNull();
    expect(text(result)).not.toContain("Open in Staple");
    const missing = (await client.callTool({ name: "show_ticket", arguments: { ref: "NOPE-999" } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^ERROR\(not_found\)/);
  });
});

describe.skipIf(Boolean(reason))("the ticket card in a host", () => {
  async function card(ref: string, theme: "light" | "dark" = "light"): Promise<RenderedView> {
    const client = await connect({ apps: true });
    return renderView(browser!, client, await loadView(client, "show_ticket", { ref }), { theme, width: WIDTH });
  }

  for (const theme of ["light", "dark"] as const) {
    it(`paints at ${WIDTH}px in the host's ${theme} theme`, async () => {
      const view = await card(refs.worked, theme);
      try {
        expectPainted(await measurePaint(view), theme, WIDTH);
        const article = view.frame.locator('[data-view="ticket"]');
        expect(await article.getAttribute("data-ticket")).toBe(refs.worked);
        const shown = await article.innerText();
        expect(shown).toContain("Retry failed card payments");
        expect(shown).toContain("In Progress");
        expect(shown).toContain("fix/payment-retry");
        expect(shown).toContain("9c41d07");
        expect(shown).toContain("#1 · pat · running");
        expect(await view.frame.locator("[data-criterion]").count()).toBe(3);
        // No gate on this ticket, so no gate buttons.
        expect(await view.frame.locator('[data-action="approve"], [data-action="request-changes"]').count()).toBe(0);
      } finally {
        await view.context.close();
      }
    });
  }

  it("Approve approves the gate under the gate's owner while no humanName is set, never the agent, and says it came from the card", async () => {
    updateConfig(process.env.STAPLE_HOME!, { humanName: "" });
    const view = await card(refs.approveGate);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      expect(await view.frame.locator('[data-gate="pending"]').innerText()).toContain("waiting on reviewer");
      await view.frame.locator('[data-action="approve"]').click();
      await view.frame.locator('[data-gate="approved"]').waitFor();
      expect(await view.frame.locator('[data-gate="approved"] .ticket-gate-line').innerText()).toBe("Gate approved by reviewer · from the card");
      expect(await view.frame.locator('[data-action="approve"]').count()).toBe(0);
      expect(await view.frame.locator("[data-action-note]").innerText()).toBe("Approved. Recorded as reviewer.");
      // The answer carries the card: one call, so one host prompt.
      expect((await view.record()).toolCalls).toEqual(["approve_gate_from_view"]);
      const now = store();
      try {
        expect(now.gate(refs.approveGate)).toMatchObject({ state: "approved", resolvedBy: "reviewer" });
        expect(now.listComments(refs.approveGate).at(-1)).toMatchObject({
          author: "reviewer",
          authorType: "user",
          body: "Approved by reviewer from the ticket card.",
        });
        expect(now.gateDecision(refs.approveGate)).toMatchObject({ state: "approved", by: "reviewer", via: "ticket_card" });
        const issueId = now.getIssue(refs.approveGate).id;
        const written = now.listEvents(0, 500).filter((event) => event.issueId === issueId && event.kind === "gate_approved");
        expect(written.map((event) => event.actor)).toEqual(["reviewer"]);
        expect(now.listEvents(0, 500).some((event) => event.actor === AGENT)).toBe(false);
      } finally {
        now.db.close();
      }
    } finally {
      await view.context.close();
    }
  });

  it("Request changes sends the note under the configured humanName, keeps the draft across a theme change, and shows the gate sent back", async () => {
    updateConfig(process.env.STAPLE_HOME!, { humanName: "Mira Lane" });
    const view = await card(refs.sendBackGate);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      await view.frame.locator('[data-action="request-changes"]').click();
      const field = view.frame.locator("[data-note-field]");
      await field.fill("Split the balance page out first.");
      // A host theme change re-renders the card; the open form and the draft survive it.
      await view.setTheme("dark");
      await expect.poll(() => view.frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
      expect(await field.inputValue()).toBe("Split the balance page out first.");
      await view.frame.locator('[data-action="send-back"]').click();
      await view.frame.locator('[data-gate="changes_requested"]').waitFor();
      expect(await view.frame.locator('[data-gate="changes_requested"] .ticket-gate-line').innerText()).toBe(
        "Changes requested by Mira Lane · from the card",
      );
      expect((await view.record()).toolCalls).toEqual(["request_changes_from_view"]);
      const now = store();
      try {
        expect(now.gate(refs.sendBackGate)).toMatchObject({ state: "changes_requested", resolvedBy: "Mira Lane" });
        expect(now.listComments(refs.sendBackGate).at(-1)).toMatchObject({
          author: "Mira Lane",
          authorType: "user",
          body: "Split the balance page out first.\n\nSent back by Mira Lane from the ticket card.",
        });
        expect(now.gateDecision(refs.sendBackGate)).toMatchObject({ state: "changes_requested", by: "Mira Lane", via: "ticket_card" });
      } finally {
        now.db.close();
      }
    } finally {
      updateConfig(process.env.STAPLE_HOME!, { humanName: "" });
      await view.context.close();
    }
  });

  it("hides the gate buttons when a write went through but its answer carried no card", async () => {
    const view = await card(refs.rereadFails);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      // A host that passes the answer on without its structured card.
      await view.page.evaluate(() => {
        const forward = window.hostCallTool;
        window.hostCallTool = async (params) => {
          const result = await forward(params);
          const structured = result.structuredContent as Record<string, unknown> | undefined;
          if (structured) delete structured.ticket;
          return result;
        };
      });
      await view.frame.locator('[data-action="approve"]').click();
      await view.frame.getByText("The card below predates it.", { exact: false }).waitFor();
      expect((await view.record()).toolCalls).toEqual(["approve_gate_from_view"]);
      expect(await view.frame.locator('[data-action="approve"], [data-action="request-changes"]').count()).toBe(0);
      const now = store();
      try {
        expect(now.gate(refs.rereadFails)).toMatchObject({ state: "approved" });
      } finally {
        now.db.close();
      }
    } finally {
      await view.context.close();
    }
  });

  it("Open in Staple asks the host to open the ticket's deep link", async () => {
    const view = await card(refs.worked);
    try {
      expectPainted(await measurePaint(view), "light", WIDTH);
      await view.frame.locator('[data-action="open"]').click();
      await expect.poll(async () => (await view.record()).links).toEqual([`${UI_BASE}?ws=${slug}&issue=${refs.worked}`]);
    } finally {
      await view.context.close();
    }
  });

  it("renders the card from a checkout_task result, calling nothing back", async () => {
    const client = await connect({ apps: true });
    const source = await loadView(client, "checkout_task", { ref: refs.free });
    expect(source.toolResult.isError).toBeFalsy();
    const view = await renderView(browser!, client, source, { theme: "light", width: WIDTH });
    try {
      await view.frame.locator('[data-view="ticket"]').waitFor();
      expectPainted(await measurePaint(view), "light", WIDTH);
      expect(await view.frame.locator("[data-attempt]").innerText()).toContain(`#1 · ${AGENT} · running`);
      await view.page.waitForTimeout(1_500);
      expect((await view.record()).toolCalls).toEqual([]);
    } finally {
      await view.context.close();
    }
  });
});
