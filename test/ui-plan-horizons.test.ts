/// <reference lib="dom" />
/**
 * The Horizons outline in a real browser: the rows are one tab stop that the arrow keys walk and
 * fold, a refused rename keeps its editor open and writes once, and a drag marks only the
 * sections the idea's state may be moved to.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import type { Browser, Page } from "playwright-core";
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache = join(userInfo().homedir, process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}
const { chromium } = await import("playwright-core");
let browser: Browser;
let ui: UiHandle;
let home: string;
let launch: { id: string; identifier: string; name: string };
let next: { id: string };
let parent: string;
let first: string;
let second: string;
let solo: string;
const route = (extra = "") => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=plan${extra}`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-horizons-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira", { person: { via: "settings" } });
  const horizons = plan.view().horizons;
  launch = horizons[0]!;
  next = horizons[1]!;
  // One group of two sub-ideas, and one idea on its own, all shaped on the first horizon.
  parent = plan.capture({ title: "Checkout", maturity: "shaped", plan: READY_PLAN, horizon: launch.id }, "Mira", person).id;
  first = plan.capture({ title: "Card payments", maturity: "shaped", plan: READY_PLAN, horizon: launch.id, parent }, "Mira", person).id;
  second = plan.capture({ title: "Refunds", maturity: "shaped", plan: READY_PLAN, horizon: launch.id, parent }, "Mira", person).id;
  solo = plan.capture({ title: "Audit trail", maturity: "shaped", plan: READY_PLAN, horizon: launch.id }, "Mira", person).id;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function onHorizons(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route("&ws=larkspur&plan-lens=horizons"));
  await page.locator(`[data-plan-tree-row="${parent}"]`).waitFor();
  return { page, close: () => context.close() };
}

const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.planTreeRow ?? null);

it("walks the rows with the arrow keys as one tab stop, folds a group and opens a row with Enter", async () => {
  const { page, close } = await onHorizons();
  try {
    const tree = page.locator(`[data-plan-column="h:${launch.id}"] [role="treegrid"]`);
    // One row of the tree takes Tab; the rest wait for the arrow keys.
    expect(await tree.locator('[role="row"][tabindex="0"]').count()).toBe(1);
    await tree.locator('[role="row"][tabindex="0"]').focus();
    expect(await focused(page)).toBe(parent);
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe(first);
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe(second);
    await page.keyboard.press("ArrowLeft");
    expect(await focused(page)).toBe(parent);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => page.locator(`[data-plan-tree-row="${parent}"]`).getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(`[data-plan-tree-row="${first}"]`).count()).toBe(0);
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe(solo);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    await page.locator(`[data-plan-tree-row="${first}"]`).waitFor();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe(first);
    // Tab from the focused row reaches its own menu, not another row.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.planCardMenu ?? null)).toBe(first);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.locator(`[data-detail-idea="${first}"]`).waitFor();
  } finally {
    await close();
  }
}, 30_000);

it("keeps the rename editor open with the name typed when the write is refused, and writes it once", async () => {
  const { page, close } = await onHorizons();
  try {
    let writes = 0;
    await page.route("**/api/plan/horizon-update", async (request) => {
      writes += 1;
      await request.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "refused", code: "conflict", message: "That name is taken." }) });
    });
    await page.locator(`[data-plan-horizon="${launch.identifier}"] h2 button`).click();
    const field = page.getByRole("textbox", { name: "Horizon name" });
    await field.fill("Renamed");
    await field.press("Enter");
    await page.locator("[data-plan-refusal]").waitFor();
    expect(writes).toBe(1);
    expect(await field.inputValue()).toBe("Renamed");
    // Leaving the field does not send the refused name again, and the editor stays.
    await page.locator("[data-plan-board]").click({ position: { x: 5, y: 400 } });
    await page.waitForTimeout(300);
    expect(writes).toBe(1);
    expect(await field.isVisible()).toBe(true);
  } finally {
    await close();
  }
}, 30_000);

it("marks during a drag only the sections the idea may move to, and clears them when it ends", async () => {
  const { page, close } = await onHorizons();
  try {
    const row = page.locator(`[data-plan-tree-row="${solo}"]`);
    expect(await row.getAttribute("draggable")).toBe("true");
    await row.dispatchEvent("dragstart", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    const rail = page.locator("[data-plan-drop-rail]");
    await rail.waitFor();
    const state = (key: string) => rail.locator(`[data-plan-drop-target="${key}"]`).getAttribute("data-plan-drop");
    expect(await state("h:")).toBe("allowed");
    expect(await state(`h:${launch.id}`)).toBe("refused");
    expect(await state(`h:${next.id}`)).toBe("allowed");
    // Its own section would change nothing: no highlight there.
    const own = page.locator(`[data-plan-column="h:${launch.id}"]`);
    expect(await own.getAttribute("data-plan-drop")).toBe("refused");
    expect(await own.locator("[data-plan-horizon]").evaluate((header) => getComputedStyle(header).boxShadow)).toBe("none");
    expect(await page.locator(`[data-plan-column="h:${next.id}"] [data-plan-horizon]`).evaluate((header) => getComputedStyle(header).boxShadow)).not.toBe("none");
    await row.dispatchEvent("dragend");
    await rail.waitFor({ state: "detached" });
  } finally {
    await close();
  }
}, 30_000);
