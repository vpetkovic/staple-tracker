/// <reference lib="dom" />
/**
 * The Horizons lens's folds in a real browser: a fold the person chose survives a reload and a
 * lens change, Collapse all and Expand all fold every section and are remembered, a focus or
 * filter holds the control and applies none of it, Not scheduled's chevron is a horizon's, and
 * under 900px of the Plan container the control is a small text button at the right end of the
 * outline's first line.
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
let now: { id: string; identifier: string };
let next: { id: string; identifier: string };
let onNow: string;
let onNext: string;
let waiting: string;
const route = (extra = "") => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=plan${extra}`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-folds-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira", { person: { via: "settings" } });
  const [first, second] = plan.view().horizons;
  now = first!;
  next = second!;
  onNow = plan.capture({ title: "Checkout", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "Mira", person).id;
  onNext = plan.capture({ title: "Gift wrap", maturity: "shaped", plan: READY_PLAN, horizon: next.id }, "Mira", person).id;
  // One shaped idea with no horizon, so Not scheduled is a section with a row.
  waiting = plan.capture({ title: "Dark mode", maturity: "shaped", plan: READY_PLAN }, "Mira", person).id;
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

async function onHorizons(width: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route("&ws=larkspur&plan-lens=horizons"));
  await page.locator(`[data-plan-horizon="${now.identifier}"]`).waitFor();
  return { page, close: () => context.close() };
}

const rows = (page: Page) => page.locator("[data-plan-tree-row]").evaluateAll((all) => all.map((row) => (row as HTMLElement).dataset.planTreeRow));
const toolbarControl = (page: Page) => page.locator("[data-plan-bar] [data-plan-fold-all]");

it("remembers a fold across a reload and a lens change, and folds every section with Collapse all", async () => {
  const { page, close } = await onHorizons(1600);
  try {
    expect(await rows(page)).toEqual([waiting, onNow, onNext]);
    await page.locator(`[data-plan-horizon-fold="${now.identifier}"]`).click();
    await expect.poll(() => rows(page)).toEqual([waiting, onNext]);
    await page.reload();
    await page.locator(`[data-plan-horizon="${now.identifier}"]`).waitFor();
    expect(await rows(page)).toEqual([waiting, onNext]);
    expect(await page.locator(`[data-plan-horizon-fold="${now.identifier}"]`).getAttribute("aria-expanded")).toBe("false");
    await page.locator('[data-plan-lens="ideas"]').click();
    await page.locator('[data-plan-lens="horizons"]').click();
    await page.locator(`[data-plan-horizon="${now.identifier}"]`).waitFor();
    expect(await rows(page)).toEqual([waiting, onNext]);

    // Not scheduled folds with its chevron like a horizon.
    await page.locator("[data-plan-ready-fold]").click();
    await expect.poll(() => rows(page)).toEqual([onNext]);
    expect(await toolbarControl(page).innerText()).toBe("Collapse all");
    await toolbarControl(page).click();
    await expect.poll(() => rows(page)).toEqual([]);
    expect(await toolbarControl(page).innerText()).toBe("Expand all");
    await page.reload();
    await page.locator(`[data-plan-horizon="${now.identifier}"]`).waitFor();
    expect(await rows(page)).toEqual([]);
    expect(await toolbarControl(page).innerText()).toBe("Expand all");
    await toolbarControl(page).click();
    await expect.poll(() => rows(page)).toEqual([waiting, onNow, onNext]);
    expect(await toolbarControl(page).innerText()).toBe("Collapse all");
    // It sits immediately left of + Horizon, in its look.
    const pair = await page.locator("[data-plan-bar]").evaluate((bar) => {
      const fold = bar.querySelector("[data-plan-fold-all]")!.getBoundingClientRect();
      const add = bar.querySelector("[data-plan-add-horizon]")!.getBoundingClientRect();
      return { gap: Math.round(add.left - fold.right), height: [fold.height, add.height] };
    });
    expect(pair).toEqual({ gap: 8, height: [32, 32] });
  } finally {
    await close();
  }
}, 30_000);

it("holds the control while a filter is on, applying none of the folds, and keeps them for after", async () => {
  const { page, close } = await onHorizons(1600);
  try {
    await toolbarControl(page).click();
    await expect.poll(() => rows(page)).toEqual([]);
    await page.getByRole("textbox", { name: "Filter the plan" }).fill("Gift");
    await expect.poll(() => rows(page)).toEqual([onNext]);
    expect(await toolbarControl(page).isDisabled()).toBe(true);
    expect(await toolbarControl(page).getAttribute("title")).toBe("Clear the focus and filter to fold sections");
    expect(await page.locator("[data-plan-horizon-fold], [data-plan-ready-fold]").count()).toBe(0);
    await page.getByRole("textbox", { name: "Filter the plan" }).fill("");
    await expect.poll(() => rows(page)).toEqual([]);
    expect(await toolbarControl(page).isDisabled()).toBe(false);
  } finally {
    await close();
  }
}, 30_000);

it("gives Not scheduled a horizon's chevron: the same x, size and tap area", async () => {
  for (const width of [1600, 375]) {
    const { page, close } = await onHorizons(width);
    try {
      const boxes = await page.evaluate((identifier) => {
        const box = (selector: string) => {
          const control = document.querySelector<HTMLElement>(selector)!;
          const rect = control.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hits = (dx: number, dy: number) => document.elementFromPoint(x + dx, y + dy)?.closest("button") === control;
          return { left: rect.left, width: rect.width, height: rect.height, reach: [hits(0, -15.5), hits(0, 15.5), hits(15.5, 0)] };
        };
        return { ready: box("[data-plan-ready-fold]"), horizon: box(`[data-plan-horizon-fold="${identifier}"]`) };
      }, now.identifier);
      expect(boxes.ready, `at ${width}px`).toEqual(boxes.horizon);
      if (width < 760) expect(boxes.ready.reach, `tap at ${width}px`).toEqual([true, true, true]);
    } finally {
      await close();
    }
  }
}, 30_000);

it("puts the control at the right end of the outline's first line where the toolbar has no room", async () => {
  for (const width of [375, 768]) {
    const { page, close } = await onHorizons(width);
    try {
      expect(await toolbarControl(page).isVisible(), `toolbar at ${width}px`).toBe(false);
      const control = page.locator("[data-plan-board] [data-plan-fold-all]");
      expect(await control.count()).toBe(1);
      const placed = await control.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const line = button.closest("header, section")!.getBoundingClientRect();
        const board = button.closest("[data-plan-board]")!.getBoundingClientRect();
        const firstHorizon = document.querySelector("[data-plan-horizon-line]")!.getBoundingClientRect();
        return { height: box.height, inFirstLine: box.top >= line.top && box.bottom <= line.bottom, aboveHorizons: box.bottom <= firstHorizon.top, atRight: board.right - box.right < 16 };
      });
      expect(placed, `at ${width}px`).toEqual({ height: 28, inFirstLine: true, aboveHorizons: true, atRight: true });
      await control.click();
      await expect.poll(() => rows(page)).toEqual([]);
      expect(await control.innerText()).toBe("Expand all");
    } finally {
      await close();
    }
  }
}, 30_000);

it("lands a link to a horizon on its section: unfolded for the visit, marked, and nothing remembered changes", async () => {
  const { page, close } = await onHorizons(1600);
  try {
    await toolbarControl(page).click();
    await expect.poll(() => rows(page)).toEqual([]);
    // The address a row's horizon chip writes: the focus names the horizon.
    await page.goto(route(`&ws=larkspur&plan-lens=horizons&focus=${next.identifier}`));
    await page.locator(`[data-plan-horizon="${next.identifier}"]`).waitFor();
    await expect.poll(() => rows(page)).toEqual([onNext]);
    const section = page.locator(`[data-plan-column="h:${next.id}"]`);
    expect(await section.getAttribute("data-plan-landed")).toBe("");
    // The mark goes; the section stays unfolded for the visit.
    await expect.poll(() => section.getAttribute("data-plan-landed"), { timeout: 4000 }).toBeNull();
    expect(await rows(page)).toEqual([onNext]);
    // Folding it by hand ends the visit's unfold.
    await page.locator(`[data-plan-horizon-fold="${next.identifier}"]`).click();
    await expect.poll(() => rows(page)).toEqual([]);
    // Without the focus the lens is as it was remembered: everything folded.
    await page.goto(route("&ws=larkspur&plan-lens=horizons"));
    await page.locator(`[data-plan-horizon="${now.identifier}"]`).waitFor();
    expect(await rows(page)).toEqual([]);
    expect(await toolbarControl(page).innerText()).toBe("Expand all");
  } finally {
    await close();
  }
}, 30_000);
