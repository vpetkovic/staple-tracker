/// <reference lib="dom" />
/**
 * The `c` shortcut opens the create dialog only when nothing else is floating.
 *
 * Rows carry a `⋯` menu, and a bare `c` pressed while one was open stacked the create
 * dialog over it. A menu cannot be opened without a browser (no jsdom in this suite),
 * so this drives the built page: open a row menu, send c, and check the menu still
 * owns the screen; then the dialog case the guard already covered; then the plain case,
 * so a guard that refused everything would fail too.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache = process.platform === "darwin" ? join(userInfo().homedir, "Library", "Caches", "ms-playwright") : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}
const { chromium } = await import("playwright-core");

let browser: Browser;
let ui: UiHandle;
let home: string;
let ref: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-create-shortcut-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "shortcut" });
  ref = ws.store.createIssue({ title: "A row with a menu" }).identifier;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const createDialog = (page: Page) => page.locator('[role="dialog"]', { hasText: "New task" });

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}`, { waitUntil: "networkidle" });
    await page.getByText("A row with a menu").first().waitFor();
    await run(page);
  } finally {
    await context.close();
  }
}

describe("the c shortcut", () => {
  it("is ignored while a row menu is open", async () => {
    await withPage(async (page) => {
      await page.getByText("A row with a menu").first().hover();
      await page.locator(`button[aria-label="Actions for ${ref}"]`).first().click();
      const menu = page.locator(`[data-queue-row-menu="${ref}"]`);
      await menu.waitFor();
      // From inside the menu, where focus sits.
      await page.keyboard.press("c");
      // And from the page behind it. The menu's content stops keydown propagation for its
      // own reasons (components/ui/dropdown-menu.tsx), which hides a missing guard from the
      // press above; a key that reaches the window must still be refused by the guard.
      await page.evaluate(() =>
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true })),
      );
      // Give a stray open the time it would need to render before asserting it did not.
      await page.waitForTimeout(300);
      expect(await page.locator('[role="dialog"]').count()).toBe(0);
      expect(await menu.isVisible()).toBe(true);
    });
  });

  it("is still ignored while another dialog is open", async () => {
    await withPage(async (page) => {
      await page.keyboard.press("Control+k");
      const palette = page.locator('[role="dialog"]');
      await palette.first().waitFor();
      // Off the palette's search box, so the typing guard is not what refuses the key.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("c");
      await page.waitForTimeout(300);
      expect(await page.locator('[role="dialog"]').count()).toBe(1);
      expect(await createDialog(page).count()).toBe(0);
    });
  });

  it("opens the create dialog when nothing is open", async () => {
    await withPage(async (page) => {
      await page.keyboard.press("c");
      await createDialog(page).waitFor();
    });
  });
});
