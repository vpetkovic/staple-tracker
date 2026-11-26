/// <reference lib="dom" />
/**
 * The ticket card's pull requests: the packaged ticket view, rendered in the minimal MCP Apps
 * host with cards built here, so every shape of the set is drawn without seeding a provider.
 *
 * A parent's card draws `subtreePullRequests` (each names the tickets it is on); a leaf's draws
 * its own `pullRequests`. The section is a heading with a tally (failing checks, open, draft,
 * merged, closed, state unknown) and up to six rows, the ones that need a person first. Each
 * row asks the host to open the pull request. A card from an older or newer server, with the
 * fields absent or malformed, still paints.
 *
 * The browser half is skipped, saying why, when this machine has no Chromium for
 * playwright-core (and fails in CI instead).
 */
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { expectPainted, measurePaint, renderView, type RenderedView } from "./fixtures/mcp-apps-harness.js";

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
if (reason) console.warn(`mcp-views-ticket-pull-requests: browser tests skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("mcp-views-ticket-pull-requests: a browser to run in", () => {
    it("has Chromium", () => {
      throw new Error(`mcp-views-ticket-pull-requests cannot run in CI: ${reason}.`);
    });
  });
}

const WIDTH = 360;
let browser: Browser | undefined;
let html = "";

/** The host never reaches a server here: the card never calls a tool on its own. */
const offline = {
  callTool: async () => ({ content: [{ type: "text", text: "no server in this test" }], isError: true }),
  readResource: async () => ({ contents: [] }),
} as unknown as Client;

const SHOW_TICKET = { name: "show_ticket", inputSchema: { type: "object" } } as Tool;

type Entry = Record<string, unknown>;

/** A pull request on the subtree of APP-1; `n` is its number in acme/shop unless `key` says otherwise. */
function pr(n: number, fields: Entry = {}): Entry {
  return {
    resourceId: `pr-${n}`,
    providerId: "github",
    key: `acme/shop#${n}`,
    url: `https://github.com/acme/shop/pull/${n}`,
    number: n,
    state: "open",
    title: `Change ${n}`,
    checks: null,
    fetchedAt: "2026-11-20T10:00:00.000Z",
    linkedAt: "2026-11-19T10:00:00.000Z",
    own: false,
    tickets: [{ id: "t-2", identifier: "APP-2", title: "Child two" }],
    ...fields,
  };
}

function card(fields: Entry = {}): Entry {
  return {
    workspace: "app",
    identifier: "APP-1",
    title: "Checkout redesign",
    status: { id: "in_progress", label: "In Progress", category: "active" },
    kind: { id: "epic", label: "Epic" },
    priority: "high",
    assignee: "pat",
    criteria: [{ text: "Works on a phone", mark: "open" }],
    gate: null,
    decision: null,
    queuedBy: null,
    attempt: null,
    branch: { name: "feat/checkout", base: "main", author: "pat", at: "2026-11-20T10:00:00.000Z" },
    timing: { estimatedSeconds: null, elapsedSeconds: null },
    url: "http://127.0.0.1:4999/?ws=app&issue=APP-1",
    actions: { approve: false, requestChanges: false },
    subtreePullRequests: null,
    ...fields,
  };
}

async function show(ticket: Entry, width = WIDTH, theme: "light" | "dark" = "light"): Promise<RenderedView> {
  const toolResult: CallToolResult = {
    content: [{ type: "text", text: "the card" }],
    structuredContent: { ticket },
    _meta: { ui: { resourceUri: "ui://staple/ticket" } },
  };
  const view = await renderView(browser!, offline, { tool: SHOW_TICKET, toolInput: { ref: "APP-1" }, toolResult, html }, { theme, width });
  expectPainted(await measurePaint(view), theme, width);
  return view;
}

async function rows(view: RenderedView): Promise<string[]> {
  return view.frame.locator("[data-pr]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-pr") ?? ""));
}

beforeAll(async () => {
  html = readFileSync(join(testPackageDir(), "views", "ticket.html"), "utf8");
  if (!reason) browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(Boolean(reason))("the ticket card's pull requests", () => {
  it("draws no section when the ticket has none, and still paints without the fields at all", async () => {
    for (const ticket of [card(), card({ subtreePullRequests: [] }), card({ subtreePullRequests: undefined, pullRequests: [] })]) {
      const view = await show(ticket);
      try {
        expect(await view.frame.locator("[data-pull-requests]").count()).toBe(0);
        expect(await view.frame.locator('[data-view="ticket"]').innerText()).toContain("Checkout redesign");
      } finally {
        await view.context.close();
      }
    }
  });

  it("tallies failing checks, open, draft, merged, closed and unknown in that order, in words for a screen reader", async () => {
    const set = [
      pr(1, { state: "closed" }),
      pr(2, { state: "merged" }),
      pr(3, { state: "open" }),
      pr(4, { state: "draft" }),
      pr(5, { state: "open", checks: { state: "failing", failing: ["unit"], completedAt: null } }),
      pr(6, { state: null }),
      pr(7, { state: "merged", checks: { state: "failing", failing: ["unit"], completedAt: null } }),
      pr(8, { state: "open" }),
    ];
    const view = await show(card({ subtreePullRequests: set }));
    try {
      const section = view.frame.locator("[data-pull-requests]");
      expect(await section.locator("h2").innerText()).toMatch(/^Pull requests/);
      const segments = await section.locator("[data-tally]").evaluateAll((items) =>
        items.map((item) => [item.getAttribute("data-tally"), item.textContent?.trim(), item.getAttribute("aria-label")]),
      );
      // A merged pull request's failing checks ask nothing of anyone, so they do not count.
      expect(segments).toEqual([
        ["failing", "1", "1 with failing checks"],
        ["open", "3", "3 open"],
        ["draft", "1", "1 draft"],
        ["merged", "2", "2 merged"],
        ["closed", "1", "1 closed"],
        ["unknown", "1", "1 state unknown"],
      ]);
      expect(await section.locator("[data-pr-tally]").getAttribute("aria-label")).toBe(
        "8 pull requests: 1 with failing checks, 3 open, 1 draft, 2 merged, 1 closed, 1 state unknown",
      );
    } finally {
      await view.context.close();
    }
  });

  it("leaves out a segment with nothing in it", async () => {
    const view = await show(card({ subtreePullRequests: [pr(1, { state: "merged" }), pr(2, { state: "merged" })] }));
    try {
      expect(await view.frame.locator("[data-tally]").evaluateAll((items) => items.map((item) => item.getAttribute("data-tally")))).toEqual(["merged"]);
      expect(await view.frame.locator("[data-pr-tally]").getAttribute("aria-label")).toBe("2 pull requests: 2 merged");
    } finally {
      await view.context.close();
    }
  });

  it("lists failing checks first, then open, draft, unknown, merged and closed, keeping the given order within each", async () => {
    const set = [
      pr(1, { state: "closed" }),
      pr(2, { state: "merged" }),
      pr(3, { state: "open" }),
      pr(4, { state: null }),
      pr(5, { state: "draft" }),
      pr(6, { state: "draft", checks: { state: "failing", failing: [], completedAt: null } }),
    ];
    const view = await show(card({ subtreePullRequests: set }));
    try {
      expect(await rows(view)).toEqual(["acme/shop#6", "acme/shop#3", "acme/shop#5", "acme/shop#4", "acme/shop#2", "acme/shop#1"]);
      const ties = await show(card({ subtreePullRequests: [pr(9), pr(3), pr(7)] }));
      try {
        expect(await rows(ties)).toEqual(["acme/shop#9", "acme/shop#3", "acme/shop#7"]);
      } finally {
        await ties.context.close();
      }
    } finally {
      await view.context.close();
    }
  });

  it("names the other tickets a pull request is on, with 'also' when it is on this ticket too", async () => {
    const set = [
      pr(1, { own: true, tickets: [{ id: "t-1", identifier: "APP-1", title: "Checkout redesign" }] }),
      pr(2, {
        own: true,
        tickets: [
          { id: "t-1", identifier: "APP-1", title: "Checkout redesign" },
          { id: "t-3", identifier: "APP-3", title: "Child three" },
        ],
      }),
      pr(3, {
        tickets: [
          { id: "t-2", identifier: "APP-2", title: "Child two" },
          { id: "t-4", identifier: "APP-4", title: "Child four" },
        ],
      }),
    ];
    const view = await show(card({ subtreePullRequests: set }));
    try {
      const tickets = (key: string) => view.frame.locator(`[data-pr="${key}"] .ticket-pr-tickets`);
      expect(await tickets("acme/shop#1").count()).toBe(0);
      expect(await tickets("acme/shop#2").innerText()).toBe("also APP-3");
      expect(await tickets("acme/shop#3").innerText()).toBe("APP-2, APP-4");
    } finally {
      await view.context.close();
    }
  });

  it("leaves the repository most are in unsaid, names another one, and keeps a key whole when two owners share a name", async () => {
    const one = await show(card({ subtreePullRequests: [pr(12), pr(13)] }));
    try {
      expect(await one.frame.locator(".ticket-pr-ref").allInnerTexts()).toEqual(["#12", "#13"]);
    } finally {
      await one.context.close();
    }
    const two = await show(card({ subtreePullRequests: [pr(12), pr(4, { key: "acme/api#4", url: "https://github.com/acme/api/pull/4" })] }));
    try {
      expect(await two.frame.locator(".ticket-pr-ref").allInnerTexts()).toEqual(["#12", "api#4"]);
    } finally {
      await two.context.close();
    }
    const shared = await show(
      card({ subtreePullRequests: [pr(12), pr(4, { key: "other/shop#4" }), pr(5, { key: "acme/api#5" })] }),
    );
    try {
      expect(await shared.frame.locator(".ticket-pr-ref").allInnerTexts()).toEqual(["#12", "other/shop#4", "api#5"]);
    } finally {
      await shared.context.close();
    }
  });

  it("draws six rows at most, and says how many more there are", async () => {
    const view = await show(card({ subtreePullRequests: Array.from({ length: 10 }, (_, i) => pr(i + 1)) }));
    try {
      expect(await view.frame.locator("[data-pr]").count()).toBe(6);
      expect(await view.frame.locator("[data-pr-more]").innerText()).toBe("and 4 more");
      expect(await view.frame.locator("[data-pr-tally]").getAttribute("aria-label")).toBe("10 pull requests: 10 open");
    } finally {
      await view.context.close();
    }
    const six = await show(card({ subtreePullRequests: Array.from({ length: 6 }, (_, i) => pr(i + 1)) }));
    try {
      expect(await six.frame.locator("[data-pr]").count()).toBe(6);
      expect(await six.frame.locator("[data-pr-more]").count()).toBe(0);
    } finally {
      await six.context.close();
    }
  });

  it("marks failing and pending checks in words, and asks the host to open a pull request when its row is clicked", async () => {
    const set = [
      pr(1, { title: "Fix totals", checks: { state: "failing", failing: ["unit", "typecheck", "lint", "e2e", "build"], completedAt: null } }),
      pr(2, { checks: { state: "pending", failing: [], completedAt: null } }),
      pr(3, { checks: { state: "passing", failing: [], completedAt: "2026-11-20T10:00:00.000Z" } }),
    ];
    const view = await show(card({ subtreePullRequests: set }));
    try {
      const failing = view.frame.locator('[data-pr="acme/shop#1"]');
      const mark = failing.locator("[data-pr-checks]");
      expect(await mark.getAttribute("data-pr-checks")).toBe("failing");
      expect(await mark.getAttribute("aria-label")).toBe("checks failing: unit, typecheck, lint and 2 more");
      expect(await mark.getAttribute("title")).toBe("checks failing: unit, typecheck, lint and 2 more");
      expect(await failing.getAttribute("aria-label")).toBe("Open acme/shop#1, Fix totals, open, checks failing: unit, typecheck, lint and 2 more");
      expect(await view.frame.locator('[data-pr="acme/shop#2"] [data-pr-checks]').getAttribute("aria-label")).toBe("checks pending");
      expect(await view.frame.locator('[data-pr="acme/shop#3"] [data-pr-checks]').count()).toBe(0);
      expect(await view.frame.locator('[data-pr="acme/shop#3"]').getAttribute("aria-label")).toBe("Open acme/shop#3, Change 3, open");

      await view.frame.locator('[data-pr="acme/shop#2"]').click();
      await expect.poll(async () => (await view.record()).links).toEqual(["https://github.com/acme/shop/pull/2"]);
      expect((await view.record()).toolCalls).toEqual([]);
    } finally {
      await view.context.close();
    }
  });

  it("draws a leaf's own pull requests when it has no subtree set, without ticket names", async () => {
    const own = [
      { resourceId: "a", providerId: "github", key: "acme/shop#40", url: "https://github.com/acme/shop/pull/40", number: 40, state: "merged", title: "Retry once", checks: null, fetchedAt: null, linkedAt: "2026-11-19T10:00:00.000Z" },
      { resourceId: "b", providerId: "github", key: "acme/shop#41", url: "https://github.com/acme/shop/pull/41", number: 41, state: "open", title: null, checks: null, fetchedAt: null, linkedAt: "2026-11-19T10:00:00.000Z" },
    ];
    const view = await show(card({ kind: { id: "task", label: "Task" }, subtreePullRequests: null, pullRequests: own }));
    try {
      expect(await rows(view)).toEqual(["acme/shop#41", "acme/shop#40"]);
      expect(await view.frame.locator(".ticket-pr-tickets").count()).toBe(0);
      // No title: the key stands in for it.
      expect(await view.frame.locator('[data-pr="acme/shop#41"] .ticket-pr-title').innerText()).toBe("acme/shop#41");
      expect(await view.frame.locator('[data-pr="acme/shop#41"]').getAttribute("aria-label")).toBe("Open acme/shop#41, open");
    } finally {
      await view.context.close();
    }
  });

  it("prefers the subtree set to the ticket's own when both are there", async () => {
    const view = await show(card({ subtreePullRequests: [pr(1)], pullRequests: [pr(99, { own: undefined, tickets: undefined })] }));
    try {
      expect(await rows(view)).toEqual(["acme/shop#1"]);
    } finally {
      await view.context.close();
    }
  });

  it("paints a card whose pull requests are malformed, drawing what it can", async () => {
    const view = await show(
      card({
        subtreePullRequests: [
          null,
          "acme/shop#1",
          { key: 7 },
          pr(2, { state: "reopened", checks: "red", tickets: "APP-2", title: 12, number: "x" }),
          pr(3, { checks: { state: "failing", failing: "unit" }, tickets: [null, { identifier: 4 }, { identifier: "APP-5" }] }),
          pr(4, { url: undefined }),
        ],
      }),
    );
    try {
      expect(await rows(view)).toEqual(["acme/shop#3", "acme/shop#4", "acme/shop#2"]);
      expect(await view.frame.locator('[data-pr="acme/shop#2"]').getAttribute("data-pr-state")).toBe("unknown");
      expect(await view.frame.locator('[data-pr="acme/shop#3"] [data-pr-checks]').getAttribute("aria-label")).toBe("checks failing");
      expect(await view.frame.locator('[data-pr="acme/shop#3"] .ticket-pr-tickets').innerText()).toBe("APP-5");
      expect(await view.frame.locator('[data-pr="acme/shop#4"]').isDisabled()).toBe(true);
    } finally {
      await view.context.close();
    }
    const odd = await show(card({ subtreePullRequests: { length: 2 }, pullRequests: "none" }));
    try {
      expect(await odd.frame.locator("[data-pull-requests]").count()).toBe(0);
    } finally {
      await odd.context.close();
    }
  });

  it("keeps glyph, number and title on one line on a narrow card, truncating the title and wrapping the tickets under it", async () => {
    const long = "Split the checkout total into line items so a refund can name what it returns, and keep the old total for orders placed before the change";
    const set = [
      pr(405, {
        title: long,
        checks: { state: "failing", failing: ["unit"], completedAt: null },
        tickets: [
          { id: "t-2", identifier: "APP-12", title: "Child" },
          { id: "t-3", identifier: "APP-13", title: "Child" },
        ],
      }),
    ];
    for (const width of [320, 720]) {
      const view = await show(card({ subtreePullRequests: set }), width);
      try {
        const box = (selector: string) => view.frame.locator(`[data-pr="acme/shop#405"] ${selector}`).boundingBox();
        const [glyph, ref, title, tickets] = await Promise.all([box(".ticket-pr-glyph"), box(".ticket-pr-ref"), box(".ticket-pr-title"), box(".ticket-pr-tickets")]);
        const middle = (b: { y: number; height: number } | null) => (b ? b.y + b.height / 2 : Number.NaN);
        expect(Math.abs(middle(glyph) - middle(title)), `${width}: glyph beside title`).toBeLessThan(4);
        expect(Math.abs(middle(ref) - middle(title)), `${width}: number beside title`).toBeLessThan(4);
        const truncated = await view.frame
          .locator('[data-pr="acme/shop#405"] .ticket-pr-title')
          .evaluate((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === "ellipsis");
        expect(truncated, `${width}: the title truncates`).toBe(true);
        if (width < 360) expect(tickets!.y, "tickets wrap under the title").toBeGreaterThan(title!.y + title!.height - 1);
        else expect(Math.abs(middle(tickets) - middle(title)), "tickets beside the title").toBeLessThan(4);
      } finally {
        await view.context.close();
      }
    }
  });
});
