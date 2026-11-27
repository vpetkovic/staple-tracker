/// <reference lib="dom" />
/**
 * A QUEUE ROW OPENS FROM THE KEYBOARD, in a real browser against the real server and the
 * built app.
 *
 * The queue's rows nested under the plan (what a queued epic expands to, and the work after
 * the plan) are `role="listitem"` rows under the page's one roving tab stop. Enter and Space
 * open the focused row's details, as they do in the task list, and Space does not scroll the
 * page. A key pressed on a control inside the row (its `⋯` menu) belongs to that control.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle or no Chromium for `playwright-core`
 * (the same rule as ui-issue-link.test.ts; in CI it must run). Everything is scratch:
 * STAPLE_HOME is a temp dir and the server is in-process on port 0.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
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
if (reason) console.warn(`ui-queue-keyboard: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-queue-keyboard: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-queue-keyboard cannot run in CI: ${reason}.`);
    });
  });
}

let home: string;
let ui: UiHandle;
let browser: Browser;
let epic: string;
let children: string[];

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-queue-keyboard-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "keys" });
  const container = ws.store.createIssue({ title: "Checkout rework", kind: "epic" });
  epic = container.identifier;
  const made = ["Price the basket", "Take the payment"].map((title) => ws.store.createChild(container.id, { title }));
  children = made.map((child) => child.identifier);
  // The payment waits on the basket: its state column links to the basket's row.
  ws.store.setBlockedBy(made[1]!.identifier, [made[0]!.identifier], "tester");
  ws.store.createIssue({ title: "Write the release notes" });
  ws.store.createIssue({ title: "Tidy the settings page" });
  ws.store.queue().enqueue(epic, {}, "tester");
  const dbPath = ws.dbPath;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function openQueue(device: typeof DESK | typeof PHONE): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const port = (ui.server.address() as AddressInfo).port;
  await page.goto(`http://127.0.0.1:${port}/?view=queue&token=${ui.token}`, { waitUntil: "networkidle" });
  // Whether the page itself saw the key as handled: a Space that is not prevented scrolls.
  await page.evaluate(() => {
    (window as unknown as { keys: { key: string; prevented: boolean }[] }).keys = [];
    window.addEventListener("keydown", (event) => {
      (window as unknown as { keys: { key: string; prevented: boolean }[] }).keys.push({ key: event.key, prevented: event.defaultPrevented });
    });
  });
  return { page, context, errors };
}

const detail = (page: Page) => page.locator("[data-detail-overlay]");
/** What the queued epic expands to: its tasks, under its plan entry. */
const expansion = (page: Page) => page.locator(`[data-queue-expansion="${epic}"]`);
const openedIssue = (page: Page) => new URL(page.url()).searchParams.get("issue");
const keysSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { keys: { key: string; prevented: boolean }[] }).keys);

describe.skipIf(Boolean(reason))("a queue row opens from the keyboard", () => {
  for (const [device, options] of [["desktop", DESK], ["phone", PHONE]] as const) {
    for (const key of ["Enter", " "] as const) {
      const name = key === " " ? "Space" : key;
      it(`opens the focused row of a queued epic's expansion with ${name} on ${device}`, async () => {
        const { page, context, errors } = await openQueue(options);
        try {
          const second = expansion(page).locator(`[role="listitem"][data-identifier="${children[1]}"]`);
          await second.waitFor();
          expect(await detail(page).count()).toBe(0);
          await second.focus();
          await page.keyboard.press(key);
          await detail(page).waitFor({ timeout: 5_000 });
          await expect.poll(() => openedIssue(page)).toBe(children[1]);
          expect(await keysSeen(page)).toEqual([{ key, prevented: true }]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }

  it("opens a row of the work that is not in the plan, after arrowing to it", async () => {
    const { page, context, errors } = await openQueue(DESK);
    try {
      await page.locator("[data-queue-unqueued-toggle]").click();
      const options = page.locator('[data-queue-unqueued="true"]').getByRole("listitem");
      await options.nth(1).waitFor();
      await options.first().focus();
      await page.keyboard.press("ArrowDown");
      const target = await options.nth(1).getAttribute("data-identifier");
      expect(await options.nth(1).evaluate((row) => row === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await detail(page).waitFor({ timeout: 5_000 });
      await expect.poll(() => openedIssue(page)).toBe(target);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("leaves Enter on the row's own menu button to the menu", async () => {
    const { page, context } = await openQueue(DESK);
    try {
      const trigger = expansion(page).getByRole("button", { name: `Actions for ${children[0]}` });
      await trigger.waitFor();
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await page.waitForTimeout(300);
      expect(await detail(page).count()).toBe(0);
      expect(openedIssue(page)).toBeNull();
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("a Waiting on link in the state column", () => {
  const row = (page: Page, ref: string) => expansion(page).locator(`[role="listitem"][data-identifier="${ref}"]`);
  const focused = (page: Page) =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { row: active?.dataset.identifier ?? null, jump: active?.dataset.queueJump ?? null, listitem: active?.getAttribute("role") === "listitem" };
    });

  it("focuses the row it names when clicked", async () => {
    const { page, context, errors } = await openQueue(DESK);
    try {
      await row(page, children[1]!).locator(`[data-queue-jump="${children[0]}"]`).click();
      await expect.poll(() => focused(page)).toEqual({ row: children[0], jump: null, listitem: true });
      expect(openedIssue(page)).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("is reached with Tab from its row, and Enter on it focuses the row it names without opening a task", async () => {
    const { page, context, errors } = await openQueue(DESK);
    try {
      await row(page, children[1]!).focus();
      await page.keyboard.press("Tab");
      expect(await focused(page)).toEqual({ row: null, jump: children[0], listitem: false });
      await page.keyboard.press("Enter");
      await expect.poll(() => focused(page)).toEqual({ row: children[0], jump: null, listitem: true });
      await page.waitForTimeout(300);
      expect(await detail(page).count()).toBe(0);
      expect(openedIssue(page)).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("the queue page on a phone", () => {
  /**
   * The controls at a row's right edge carry touch hit areas that reach past the page. A box
   * that scrolls down scrolls sideways too unless it says otherwise, and on a phone the whole
   * list then slid left and right under a finger.
   */
  it("scrolls down and never sideways", async () => {
    const { page, context } = await openQueue(PHONE);
    try {
      await expansion(page).getByRole("listitem").first().waitFor();
      const pans = await page.evaluate(() => {
        const canPan = (box: Element) =>
          box.scrollWidth > box.clientWidth && /auto|scroll/.test(getComputedStyle(box).overflowX);
        const board = document.querySelector("[data-queue-board]");
        return { board: board === null ? null : canPan(board), page: canPan(document.documentElement) };
      });
      expect(pans).toEqual({ board: false, page: false });
    } finally {
      await context.close();
    }
  });
});
