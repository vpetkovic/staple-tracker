/// <reference lib="dom" />
/**
 * The Ideas lens in a real browser: two panes that scroll on their own from 760px of Plan
 * width and one stacked scroller below it, no column switcher; a capture lands at the top of
 * Raw; Explore and Mark shaped run the offered actions and the idea moves on.
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
let rawIdea: string;
let readyIdea: string;
let thinIdea: string;
const route = () => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=plan&ws=larkspur&plan-lens=ideas`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-ideas-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira", { person: { via: "settings" } });
  rawIdea = plan.capture({ title: "Raw to explore" }, "Mira", person).id;
  readyIdea = plan.capture({ title: "Ready to shape", maturity: "exploring", plan: READY_PLAN }, "Mira", person).id;
  thinIdea = plan.capture({ title: "Thin plan", maturity: "exploring" }, "Mira", person).id;
  // Enough raw rows that the stacked lens has something to scroll.
  for (let i = 0; i < 14; i++) plan.capture({ title: `Raw filler ${i}` }, "Mira", person);
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

async function onIdeas(width: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 760 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route());
  await page.locator('[data-plan-column="m:exploring"]').waitFor();
  return { page, close: () => context.close() };
}

const overflowY = (page: Page, selector: string) => page.locator(selector).evaluateAll((all) => all.map((element) => getComputedStyle(element).overflowY));

for (const [width, board, panes] of [
  [1280, "visible", "auto"],
  [390, "auto", "visible"],
] as const) {
  it(`scrolls the ${board === "auto" ? "stacked lens as one" : "two panes each on their own"}, with no column switcher, at ${width}px`, async () => {
    const { page, close } = await onIdeas(width);
    try {
      expect(await overflowY(page, "[data-plan-board]")).toEqual([board]);
      expect(await overflowY(page, "[data-plan-column]")).toEqual([panes, panes]);
      expect(await page.locator("[data-plan-column-switcher]").count()).toBe(0);
      expect(await page.locator(`[data-plan-column="m:exploring"] [data-plan-card="${thinIdea}"]`).isVisible()).toBe(true);
      const scroller = page.locator(width === 1280 ? '[data-plan-column="m:raw"]' : "[data-plan-board]");
      expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    } finally {
      await close();
    }
  }, 20_000);
}

it("lands a capture at the top of Raw", async () => {
  const { page, close } = await onIdeas(1280);
  try {
    const field = page.locator('[data-plan-column="m:raw"] [data-plan-capture] input');
    await field.fill("Freshly captured");
    await field.press("Enter");
    await expect.poll(() => page.locator('[data-plan-column="m:raw"] [data-plan-card]').first().textContent()).toContain("Freshly captured");
    expect(await field.inputValue()).toBe("");
  } finally {
    await close();
  }
}, 20_000);

it("explores a raw idea with one click, and marks a ready one shaped, which hands it to Horizons", async () => {
  const { page, close } = await onIdeas(1280);
  try {
    expect(await page.locator(`[data-plan-card="${thinIdea}"] [data-plan-action="shape"]`).count()).toBe(0);
    await page.locator(`[data-plan-card="${rawIdea}"]`).hover();
    await page.locator(`[data-plan-card="${rawIdea}"] [data-plan-action="explore"]`).click();
    await page.locator(`[data-plan-column="m:exploring"] [data-plan-card="${rawIdea}"]`).waitFor();
    expect(await page.locator('[aria-label="Issue detail"]').count()).toBe(0);
    await page.locator(`[data-plan-card="${readyIdea}"] [data-plan-action="shape"]`).click();
    await page.locator(`[data-plan-card="${readyIdea}"]`).waitFor({ state: "detached" });
    expect(await page.locator('[aria-label="Issue detail"]').count()).toBe(0);
  } finally {
    await close();
  }
}, 20_000);
