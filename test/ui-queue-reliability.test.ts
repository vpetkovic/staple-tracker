/// <reference lib="dom" />
/**
 * THE QUEUE PAGE KEEPS ITS PLAN WHOLE THROUGH A WRITE, in a real browser against the real
 * server and the built app.
 *
 *   - A write answers the whole plan, finished entries included, so the page drawn from that
 *     answer still shows them, still offers to clear them, and a second move made before the
 *     page re-reads carries every entry (the store refuses a reorder that leaves one out).
 *   - Alt and an arrow on a row NESTED under a queued epic is not a move of the epic: that
 *     row is not a plan entry, and the keys must not reach the plan row it hangs under.
 *   - A re-read that fails after the plan is on screen keeps the plan there: the page swapped
 *     the whole plan for the error until something else changed and the next read happened.
 *   - In a shared workspace a row the next pick skips because it is another member's says so,
 *     with the store's sentence, instead of reading as ready.
 *   - A conflict whose re-read fails does not leave the older order under a banner that says
 *     the list is the server's.
 *
 * The re-read after a write is held back by delaying `/api/poll`, which is the first thing the
 * page's refresh asks. That is the real window between a write answering and the page
 * re-reading, made wide enough to act in, not a different code path.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle or no Chromium for `playwright-core`
 * (the rule ui-queue-keyboard.test.ts follows; in CI it must run). Everything is scratch.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { MEMBERS_CACHE_VERSION, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, uiBundleExists, type UiHandle } from "../src/ui/server.js";

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

const bundle = uiBundleExists();
const browserReady = bundle && (await chromiumAvailable());
const reason = !bundle ? "no UI bundle (run npm run build:ui)" : !browserReady ? "no Chromium for playwright-core" : "";
if (reason) console.warn(`ui-queue-reliability: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-queue-reliability: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-queue-reliability cannot run in CI: ${reason}.`);
    });
  });
}

let home: string;
let dbPath: string;
let ui: UiHandle;
let browser: Browser;
let finished: string;
let epic: string;
let children: string[];
let first: string;
let second: string;

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-queue-reliability-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "rel" });
  const s = ws.store;
  finished = s.createIssue({ title: "Ship the changelog" }).identifier;
  const container = s.createIssue({ title: "Checkout rework", kind: "epic" });
  epic = container.identifier;
  children = ["Price the basket", "Take the payment"].map((title) => s.createChild(container.id, { title }).identifier);
  first = s.createIssue({ title: "Write the release notes" }).identifier;
  second = s.createIssue({ title: "Tidy the settings page", assignee: "marko" }).identifier;
  for (const ref of [finished, epic, first, second]) s.queue().enqueue(ref, {}, "vp");
  s.updateIssue(finished, { status: "done" }, "vp");
  // A shared workspace: `second` is marko's, another member's (member-pickup.test.ts).
  const { repository_id: repositoryId } = s.db.prepare("SELECT repository_id FROM sync_state WHERE id = 1").get() as {
    repository_id: string;
  };
  writeMembersCache(home, {
    version: MEMBERS_CACHE_VERSION,
    repositoryId,
    fetchedAt: "2026-11-06T12:00:00.000Z",
    self: { memberId: "mem-vp", deviceId: "this-machine" },
    members: [
      { memberId: "mem-vp", name: "VP", isOwner: true, removed: false, devices: [] },
      { memberId: "mem-marko", name: "marko", isOwner: false, removed: false, devices: [] },
    ],
  });
  dbPath = ws.dbPath;
  s.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function plan(): { order: string[]; revision: number } {
  const { store } = openWorkspace(dbPath);
  try {
    return {
      order: store.queue().entries({ all: true }).map((entry) => entry.identifier),
      revision: store.queue().revision(),
    };
  } finally {
    store.db.close();
  }
}

/** A write from elsewhere, so the page's poll sees a change and re-reads. */
function touch(title: string): void {
  const { store } = openWorkspace(dbPath);
  try {
    store.createIssue({ title });
  } finally {
    store.db.close();
  }
}

function setOrder(order: string[]): void {
  const { store } = openWorkspace(dbPath);
  try {
    store.queue().reorder(order, {}, "vp");
  } finally {
    store.db.close();
  }
}

async function openQueue(): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const port = (ui.server.address() as AddressInfo).port;
  await page.goto(`http://127.0.0.1:${port}/?view=queue&token=${ui.token}`, { waitUntil: "networkidle" });
  await page.locator(`[data-queue-entry="${finished}"]`).waitFor();
  return { page, context, errors };
}

/** Hold every `/api/poll` back, so the page keeps drawing a write's own answer. */
async function holdRereads(page: Page): Promise<void> {
  await page.route("**/api/poll*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue().catch(() => {});
  });
}

const moveButton = (page: Page, ref: string, control: "up" | "down") =>
  page.locator(`[data-reorder-row="${ref}"] [data-reorder-control="${control}"]`);

async function press(page: Page, ref: string, control: "up" | "down"): Promise<void> {
  const answered = page.waitForResponse((response) => response.url().includes("/api/queue/reorder"));
  await moveButton(page, ref, control).click();
  await answered;
  // The answer is drawn on the next render; the controls come back once `busy` clears.
  await expect.poll(() => moveButton(page, ref, control === "up" ? "down" : "up").isDisabled()).toBe(false);
}

describe.skipIf(Boolean(reason))("the queue page through a write", () => {
  it("keeps a finished entry and its Clear control on the page drawn from a move's answer", async () => {
    setOrder([finished, epic, first, second]);
    const { page, context, errors } = await openQueue();
    try {
      await holdRereads(page);
      await press(page, first, "down");
      expect(plan().order).toEqual([finished, epic, second, first]);
      expect(await page.locator(`[data-queue-entry="${finished}"]`).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Clear 1 finished" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("accepts a second move made before the page re-reads", async () => {
    setOrder([finished, epic, first, second]);
    const { page, context, errors } = await openQueue();
    try {
      await holdRereads(page);
      await press(page, first, "down");
      await press(page, epic, "down");
      expect(await page.locator('[role="alert"]').count()).toBe(0);
      expect(plan().order).toEqual([finished, second, epic, first]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("does not move the epic when Alt and an arrow are pressed on a row nested under it", async () => {
    setOrder([finished, epic, first, second]);
    const before = plan();
    const { page, context, errors } = await openQueue();
    try {
      const nested = page
        .getByRole("listbox", { name: `What ${epic} expands to` })
        .locator(`[role="option"][data-identifier="${children[0]}"]`);
      await nested.waitFor();
      await nested.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(500);
      expect(plan()).toEqual(before);
      await page.keyboard.press("Alt+ArrowUp");
      await page.waitForTimeout(500);
      expect(plan()).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("keeps the plan on screen when a re-read fails, and takes the next read that succeeds", async () => {
    setOrder([finished, epic, first, second]);
    const { page, context, errors } = await openQueue();
    try {
      let refused = 0;
      // The first poll only sets the baseline; a change made before it would never be "new".
      await page.waitForResponse((response) => response.url().includes("/api/poll"));
      await page.route(/\/api\/queue\?/, async (route) => {
        if (refused > 0) return route.continue();
        refused += 1;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "busy", message: "The server is busy." }) });
      });
      touch("A change from another agent");
      await expect.poll(() => refused, { timeout: 10_000 }).toBe(1);
      await page.waitForTimeout(300);
      expect(await page.getByText("The server is busy.").count()).toBe(0);
      expect(await page.locator(`[data-queue-entry="${first}"]`).count()).toBe(1);
      // The next change is read and drawn: the page was not left holding a dead read.
      setOrder([finished, epic, second, first]);
      await expect
        .poll(() => page.locator("[data-queue-entry]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-queue-entry"))), { timeout: 10_000 })
        .toEqual([finished, epic, second, first]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("says why the next pick skips another member's ticket", async () => {
    setOrder([finished, second, epic, first]);
    const { page, context, errors } = await openQueue();
    try {
      const row = page.locator(`[data-queue-entry="${second}"]`);
      expect(await row.innerText()).toContain(`${second} is assigned to marko, another member.`);
      // The pick is the first row the store calls eligible, past marko's.
      expect(await page.locator("[data-queue-next-ref]").innerText()).toBe(children[0]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("does not show the older order as the server's when a conflict's re-read fails", async () => {
    setOrder([finished, epic, first, second]);
    const { page, context, errors } = await openQueue();
    try {
      await holdRereads(page);
      // Somebody else reorders: the page still holds the older revision.
      setOrder([finished, second, epic, first]);
      await page.route(/\/api\/queue\?/, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "busy", message: "The server is busy." }) }),
      );
      const answered = page.waitForResponse((response) => response.url().includes("/api/queue/reorder"));
      await moveButton(page, first, "down").click();
      expect((await answered).status()).toBe(409);
      await page.getByText("The server is busy.").waitFor({ timeout: 5_000 });
      expect(await page.locator("[data-queue-conflict]").count()).toBe(0);
      expect(plan().order).toEqual([finished, second, epic, first]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
