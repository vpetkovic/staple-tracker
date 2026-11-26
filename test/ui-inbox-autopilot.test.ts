/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * THE INBOX AND THE AUTOPILOT PAGE KEEP THE KEYBOARD — in a real browser, against the real
 * server and the built app.
 *
 * Where the focus is after an action is a property of the DOM that no string render can see:
 * a dismissed row takes its button with it, the one-pane Autopilot page swaps the list for a
 * run, and the phone's More sheet has no trigger of its own. Each of those used to drop the
 * focus to the page. This suite drives Chromium through `playwright-core` and asserts on
 * `document.activeElement` and the address.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle (`npm run build:ui`; the gate order
 * builds first) or no Chromium for `playwright-core` on this machine. Everything is scratch:
 * STAPLE_HOME is a temp dir, the server is in-process on port 0.
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

// The suite runs with HOME pointed at a scratch dir; Playwright's browsers live under the real one.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache =
    process.platform === "darwin"
      ? join(userInfo().homedir, "Library", "Caches", "ms-playwright")
      : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

// Imported after the path is set: Playwright reads it when the module loads.
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
if (reason) console.warn(`ui-inbox-autopilot: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-inbox-autopilot: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-inbox-autopilot cannot run in CI: ${reason}.`);
    });
  });
}

let home: string;
let ui: UiHandle;
let browser: Browser;
/** Two runs that stopped after two failures (each a dismissible Inbox row), and one still live. */
const runs: { stopped: string[]; live: string } = { stopped: [], live: "" };
/** The ticket each stopped run failed on: what its page offers to open. */
const failedOn: string[] = [];
let reviews: string[];

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-inbox-autopilot-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "box" });
  const { store } = ws;
  const tree = (title: string) => {
    const parent = store.createIssue({ title, kind: "epic" });
    const child = store.createIssue({ title: `${title}: the one ticket`, parent: parent.identifier, status: "todo" });
    return { parent: parent.identifier, child: child.identifier };
  };
  reviews = ["Review the first thing", "Review the second thing", "Review the third thing"].map(
    (title) => store.createIssue({ title, status: "in_review" }).identifier,
  );
  const store_runs = store.runs();
  for (const [index, title] of ["First failing epic", "Second failing epic"].entries()) {
    const actor = `opus-fail-${index}`;
    const work = tree(title);
    runs.stopped.push(store_runs.start({ actor, scope: work.parent }).id);
    store_runs.continue({ actor });
    store_runs.continue({ actor, outcome: "failed", reason: "session exited 1" });
    const streak = store_runs.continue({ actor, outcome: "failed", reason: "timed out: 30m" });
    if (streak.action !== "stop") throw new Error(`expected a stop, got ${JSON.stringify(streak)}`);
    failedOn.push(work.child);
  }
  const live = tree("An epic still being worked");
  runs.live = store_runs.start({ actor: "opus-live", scope: live.parent, maxTickets: 5 }).id;
  store_runs.continue({ actor: "opus-live" });
  const dbPath = ws.dbPath;
  store.db.close();
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

async function open(device: typeof DESK | typeof PHONE, query: string): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const port = (ui.server.address() as AddressInfo).port;
  await page.goto(`http://127.0.0.1:${port}/?${query}&token=${ui.token}`, { waitUntil: "networkidle" });
  return { page, context, errors };
}

/** What holds the focus, as the attribute that names it. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "body";
    const data = element.dataset;
    return (
      (data.attentionRow !== undefined && `row:${data.attentionRow}`) ||
      (data.runItem !== undefined && `run-item:${data.runItem}`) ||
      (data.runTitle !== undefined && "run-title") ||
      (data.viewTab !== undefined && `tab:${data.viewTab}`) ||
      element.tagName.toLowerCase()
    );
  });
const rowKeys = (page: Page) => page.locator("[data-attention-row]").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.attentionRow!));
const openedIssue = (page: Page) => new URL(page.url()).searchParams.get("issue");

describe.skipIf(Boolean(reason))("the Inbox from the keyboard", () => {
  it("is one tab stop that j, k, Home and End walk across sections, and Enter opens the ticket", async () => {
    const { page, context, errors } = await open(DESK, "view=inbox");
    try {
      await page.locator("[data-attention-row]").first().waitFor();
      const keys = await rowKeys(page);
      expect(keys.length).toBeGreaterThanOrEqual(5);
      expect(await page.locator('[data-attention-row][tabindex="0"]').count()).toBe(1);
      await page.locator("[data-attention-row]").first().focus();
      await page.keyboard.press("j");
      expect(await focused(page)).toBe(`row:${keys[1]}`);
      await page.keyboard.press("ArrowDown");
      expect(await focused(page)).toBe(`row:${keys[2]}`);
      await page.keyboard.press("k");
      expect(await focused(page)).toBe(`row:${keys[1]}`);
      await page.keyboard.press("End");
      expect(await focused(page)).toBe(`row:${keys.at(-1)}`);
      await page.keyboard.press("Home");
      expect(await focused(page)).toBe(`row:${keys[0]}`);
      // The first rows are the tickets in review: Enter opens that ticket in the drawer.
      await page.keyboard.press("Enter");
      await expect.poll(() => openedIssue(page)).toBe(reviews[0]);
      // Closing the drawer returns to the row it was opened from, not to the page.
      await page.locator("[data-detail-overlay]").waitFor();
      await page.keyboard.press("Escape");
      await page.locator("[data-detail-overlay]").waitFor({ state: "detached" });
      await expect.poll(() => focused(page)).toBe(`row:${keys[0]}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("moves the focus to the row that takes its place when a row is dismissed from its own button", async () => {
    const { page, context, errors } = await open(DESK, "view=inbox");
    try {
      const dismiss = page.locator("[data-attention-dismiss]");
      await dismiss.first().waitFor();
      expect(await dismiss.count()).toBe(2);
      const [first, second] = await dismiss.evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).dataset.attentionDismiss!));
      await dismiss.first().focus();
      await page.keyboard.press("Enter");
      await page.locator(`[data-attention-row="${first}"]`).waitFor({ state: "detached" });
      await expect.poll(() => focused(page)).toBe(`row:${second}`);
      // And from the row itself, with e: the last dismissible row leaves and the focus stays in the list.
      await page.keyboard.press("e");
      await page.locator(`[data-attention-row="${second}"]`).waitFor({ state: "detached" });
      await expect.poll(async () => (await focused(page)).startsWith("row:")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("the Autopilot page", () => {
  it("on one pane, lands on the run's title when a run opens and back on its item when it closes", async () => {
    const { page, context, errors } = await open(PHONE, "view=autopilot");
    try {
      const item = page.locator(`[data-run-item="${runs.live}"]`);
      await item.waitFor();
      await item.focus();
      await page.keyboard.press("Enter");
      await page.locator(`[data-run-detail="${runs.live}"]`).waitFor();
      expect(new URL(page.url()).searchParams.get("run")).toBe(runs.live);
      await expect.poll(() => focused(page)).toBe("run-title");
      await page.locator("[data-run-back]").focus();
      await page.keyboard.press("Enter");
      await item.waitFor();
      expect(new URL(page.url()).searchParams.get("run")).toBeNull();
      await expect.poll(() => focused(page)).toBe(`run-item:${runs.live}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("an ended run's one action opens the ticket it names", async () => {
    const { page, context, errors } = await open(DESK, `view=autopilot&run=${runs.stopped[1]}`);
    try {
      const action = page.locator(`[data-run-detail="${runs.stopped[1]}"] [data-run-attention]`);
      await action.waitFor();
      await action.click();
      await expect.poll(() => openedIssue(page)).toBe(failedOn[1]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("the phone's More sheet", () => {
  it("hands the focus back to the More tab when Escape closes it", async () => {
    const { page, context, errors } = await open(PHONE, "view=inbox");
    try {
      const more = page.locator('[data-view-tab="more"]');
      await more.waitFor();
      await more.focus();
      await page.keyboard.press("Enter");
      await page.locator('[data-sheet="more-views"]').waitFor();
      await page.keyboard.press("Escape");
      await page.locator('[data-sheet="more-views"]').waitFor({ state: "detached" });
      await expect.poll(() => focused(page)).toBe("tab:more");
      expect(await more.getAttribute("aria-expanded")).toBe("false");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
