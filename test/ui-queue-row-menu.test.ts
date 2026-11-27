/// <reference lib="dom" />
/**
 * THE QUEUE ROW MENU'S REMOVE, in a real browser against the real server and the built app.
 *
 * A row is held only while an agent has it checked out, which is what the store calls
 * `claimed`. A row whose status was moved to in_progress by hand, with no checkout, is held
 * by nobody: its menu offers "Remove from queue" and the removal goes through. A row an agent
 * holds keeps the item disabled and names that agent. No holder name is ever made up.
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
if (reason) console.warn(`ui-queue-row-menu: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-queue-row-menu: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-queue-row-menu cannot run in CI: ${reason}.`);
    });
  });
}

let home: string;
let dbPath: string;
let ui: UiHandle;
let browser: Browser;
let started: string;
let claimed: string;
let gone: string;
let movable: string[];

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-queue-row-menu-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "menu" });
  const s = ws.store;
  // Moved to in_progress by a status edit, which never sets a checkout agent.
  started = s.createIssue({ title: "Fix the login redirect" }).identifier;
  s.updateIssue(started, { status: "in_progress", assignee: "vp" }, "vp");
  claimed = s.createIssue({ title: "Document the API keys" }).identifier;
  s.checkoutIssue(claimed, "codex-1");
  movable = ["Write the release notes", "Tidy the settings page", "Rename the export"].map((title) => s.createIssue({ title }).identifier);
  gone = s.createIssue({ title: "Drop the old exporter" }).identifier;
  for (const ref of [started, claimed, movable[0]!, gone, movable[1]!, movable[2]!]) s.queue().enqueue(ref, {}, "vp");
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

async function openMenu(ref: string): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const port = (ui.server.address() as AddressInfo).port;
  await page.goto(`http://127.0.0.1:${port}/?view=queue&token=${ui.token}`, { waitUntil: "networkidle" });
  const entry = page.locator(`[data-queue-entry="${ref}"]`);
  // The desk row reveals its menu button on hover, as a pointer would.
  await entry.hover();
  await entry.getByRole("button", { name: `Actions for ${ref}` }).click();
  await page.locator(`[data-queue-row-menu="${ref}"]`).waitFor();
  return { page, context, errors };
}

const planned = () => {
  const { store } = openWorkspace(dbPath);
  try {
    return store.queue().entries({ all: true }).map((entry) => entry.identifier);
  } finally {
    store.db.close();
  }
};

describe.skipIf(Boolean(reason))("removing a row from the queue through its menu", () => {
  it("names the agent holding a checked-out row and keeps it in the queue", async () => {
    const { page, context, errors } = await openMenu(claimed);
    try {
      const menu = page.locator(`[data-queue-row-menu="${claimed}"]`);
      const remove = menu.locator('[data-menu-item="dequeue"]');
      expect(await remove.getAttribute("aria-disabled")).toBe("true");
      expect(await remove.innerText()).toContain("codex-1 is working on this, so it stays in the queue");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("removes an in-progress row nobody has checked out, naming no holder", async () => {
    const { page, context, errors } = await openMenu(started);
    try {
      const menu = page.locator(`[data-queue-row-menu="${started}"]`);
      const remove = menu.locator('[data-menu-item="dequeue"]');
      expect(await remove.getAttribute("aria-disabled")).toBeNull();
      expect(await menu.innerText()).not.toContain("is working on this");
      const before = planned();
      expect(before).toContain(started);
      await remove.click();
      await page.locator(`[data-queue-entry="${started}"]`).waitFor({ state: "detached" });
      expect(planned()).toEqual(before.filter((ref) => ref !== started));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/** The page's focus: the row it is on, or the body. */
const focusedRow = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    return (active as HTMLElement).dataset.queueEntry ?? active.outerHTML.slice(0, 80);
  });

describe.skipIf(Boolean(reason))("after a row leaves through its menu", () => {
  it("puts the focus on the row that takes its place, not on the page", async () => {
    const { page, context, errors } = await openMenu(gone);
    try {
      const after = planned()[planned().indexOf(gone) + 1]!;
      await page.locator(`[data-queue-row-menu="${gone}"] [data-menu-item="dequeue"]`).click();
      await page.locator(`[data-queue-entry="${gone}"]`).waitFor({ state: "detached" });
      await expect.poll(() => focusedRow(page)).toBe(after);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("moving an entry through its menu", () => {
  /** The plan with `ref` moved to index `to`. */
  const moved = (order: string[], ref: string, to: number) => {
    const rest = order.filter((id) => id !== ref);
    rest.splice(to, 0, ref);
    return rest;
  };

  for (const [item, place] of [
    ["move-up", (at: number) => at - 1],
    ["move-down", (at: number) => at + 1],
    ["move-top", () => 0],
    ["move-bottom", (_at: number, last: number) => last],
  ] as const) {
    it(`moves the entry the menu was opened on with ${item}`, async () => {
      const target = movable[1]!;
      const before = planned();
      const at = before.indexOf(target);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(before.length - 1);
      const { page, context, errors } = await openMenu(target);
      try {
        const answered = page.waitForResponse((response) => response.url().includes("/api/queue/reorder"));
        await page.locator(`[data-queue-row-menu="${target}"] [data-menu-item="${item}"]`).click();
        expect((await answered).status()).toBe(200);
        expect(planned()).toEqual(moved(before, target, place(at, before.length - 1)));
        expect(errors).toEqual([]);
      } finally {
        // Back where it was, for the next move.
        const { store } = openWorkspace(dbPath);
        try {
          store.queue().reorder(before, {}, "vp");
        } finally {
          store.db.close();
        }
        await context.close();
      }
    });
  }
});
