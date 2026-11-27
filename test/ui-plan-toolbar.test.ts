/// <reference lib="dom" />
/**
 * The Plan toolbar in a real browser: capture from Horizons keeps the lens and offers a way to
 * the new idea, a refused write can be dismissed, a "Show only" pill narrows the lens, and the
 * bar is one row on every lens from 620px of the Plan container up.
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
let horizonName: string;
let idle: string;
let busy: string;
const route = (extra = "") => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=plan${extra}`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-toolbar-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira", { person: { via: "settings" } });
  const launch = plan.view().horizons[0]!;
  horizonName = launch.name;
  // One idea whose planned start has passed with no work linked (not started), one still ahead.
  idle = plan.capture({ title: "Idle checkout", maturity: "shaped", plan: READY_PLAN, horizon: launch.id, plannedStart: "2026-01-05", plannedTarget: "2099-02-01" }, "Mira", person).id;

  busy = plan.capture({ title: "Upcoming checkout", maturity: "shaped", plan: READY_PLAN, horizon: launch.id, plannedStart: "2099-01-05", plannedTarget: "2099-02-01" }, "Mira", person).id;
  ws.store.db.close();
  // A second workspace whose toolbar carries all three pills, the widest it gets.
  const crowded = initWorkspace({ global: true, slug: "fernhill" });
  const other = crowded.store.plan();
  other.enable("Mira", { person: { via: "settings" } });
  const past = other.createHorizon({ name: "Spring", date: "2026-01-01" }, "Mira", person);
  const late = other.capture({ title: "Gift cards", maturity: "shaped", plan: READY_PLAN, horizon: past.id }, "Mira", person).id;
  other.adopt(late, crowded.store.createIssue({ title: "Open work" }).identifier, "agent");
  other.capture({ title: "Reports", maturity: "shaped", plan: READY_PLAN, horizon: past.id, plannedStart: "2026-01-05", plannedTarget: "2099-02-01" }, "Mira", person);
  other.addQuestion(other.capture({ title: "Refunds", maturity: "exploring", horizon: past.id }, "Mira", person).id, "Who approves a refund?", "agent");
  crowded.store.db.close();
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
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route("&ws=larkspur&plan-lens=horizons"));
  await page.locator('[data-plan-lens="horizons"][aria-selected="true"]').waitFor();
  return { page, close: () => context.close() };
}

for (const width of [1280, 390]) {
  it(`captures from Horizons without leaving it, then opens Ideas on request, at ${width}px`, async () => {
    const { page, close } = await onHorizons(width);
    try {
      await page.locator("[data-plan-capture-open]").click();
      const field = page.locator("[data-plan-capture] input");
      await field.fill(`Captured at ${width}`);
      await field.press("Enter");
      await page.locator("[data-plan-captured]").waitFor();
      expect(await page.locator('[data-plan-lens="horizons"]').getAttribute("aria-selected")).toBe("true");
      expect(await field.inputValue()).toBe("");
      await page.locator("[data-plan-captured-view]").click();
      await expect.poll(() => page.locator('[data-plan-lens="ideas"]').getAttribute("aria-selected")).toBe("true");
      await page.locator("[data-plan-card]", { hasText: `Captured at ${width}` }).waitFor();
    } finally {
      await close();
    }
  }, 20_000);
}

it("dismisses a refused write", async () => {
  const { page, close } = await onHorizons(1280);
  try {
    await page.locator("[data-plan-add-horizon]").click();
    await page.getByRole("textbox", { name: "New horizon name" }).fill(horizonName);
    await page.locator("[data-plan-add-horizon-form] button[type=submit]").click();
    const refusal = page.locator("[data-plan-refusal]");
    await refusal.waitFor();
    await refusal.getByRole("button", { name: "Dismiss" }).click();
    await refusal.waitFor({ state: "detached" });
  } finally {
    await close();
  }
}, 20_000);

it("narrows Horizons to the ideas a pill shows, and back", async () => {
  const { page, close } = await onHorizons(1280);
  try {
    const rows = page.locator("[data-plan-tree-row]");
    const shown = async () => (await rows.evaluateAll((all) => all.map((row) => (row as HTMLElement).dataset.planTreeRow))).sort();
    await expect.poll(shown).toEqual([idle, busy].sort());
    const pill = page.getByRole("group", { name: "Show only" }).getByRole("button", { name: /Not started/ });
    await pill.click();
    expect(await pill.getAttribute("aria-pressed")).toBe("true");
    await expect.poll(shown).toEqual([idle]);
    await pill.click();
    await expect.poll(shown).toEqual([idle, busy].sort());
  } finally {
    await close();
  }
}, 20_000);

// Widths of the Plan container, as the app's sidebar leaves it on a 900 to 1440px screen.
const CONTAINER = [621, 650, 700, 774, 800, 900, 1000, 1100];

it("keeps the toolbar to one row on every lens from 620px of the Plan container up, with all three pills", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    for (const lens of ["ideas", "horizons", "timeline"]) {
      await page.goto(route(`&ws=fernhill&plan-lens=${lens}`));
      await page.locator(`[data-plan-lens="${lens}"][aria-selected="true"]`).waitFor();
      expect(await page.getByRole("group", { name: "Show only" }).getByRole("button").allTextContents()).toHaveLength(3);
      for (const width of CONTAINER) {
        await page.evaluate((w) => {
          const view = document.querySelector<HTMLElement>("[data-plan-view]")!;
          view.style.flex = "none";
          view.style.width = `${w}px`;
        }, width);
        // Every part of the bar sits on one line: their vertical centres agree.
        await expect
          .poll(() =>
            page.locator("[data-plan-bar]").first().evaluate((bar) => {
              const centres = [...bar.children].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0).map((box) => box.top + box.height / 2);
              return Math.round(Math.max(...centres) - Math.min(...centres));
            }),
            { message: `${lens} at ${width}px` },
          )
          .toBeLessThanOrEqual(2);
        if (lens === "horizons") {
          // Under 900px + Horizon is the outline's last row, not a toolbar button.
          expect(await page.locator("[data-plan-add-horizon]").isVisible(), `+ Horizon in the bar at ${width}`).toBe(width >= 900);
          expect(await page.locator("[data-plan-add-horizon-row]").isVisible(), `+ Horizon row at ${width}`).toBe(width < 900);
        }
        if (lens !== "ideas") {
          const capture = page.locator("[data-plan-capture-open]");
          expect(await capture.getAttribute("aria-label")).toBe("Capture an idea");
          // Icon-only under 900px; its word is drawn from 900px.
          expect(await capture.evaluate((button) => button.getBoundingClientRect().width), `+ Idea at ${width}`)[width < 900 ? "toBeLessThanOrEqual" : "toBeGreaterThan"](34);
        }
      }
    }
  } finally {
    await context.close();
  }
}, 60_000);

it("never hides a filter that is on behind the folded search button", async () => {
  const { page, close } = await onHorizons(1280);
  try {
    const width = (w: number) =>
      page.evaluate((px) => {
        const view = document.querySelector<HTMLElement>("[data-plan-view]")!;
        view.style.flex = "none";
        view.style.width = `${px}px`;
      }, w);
    // Typed where the field is drawn open, then the Plan container narrows past 1100px, where
    // search folds to a button: a filter that is on stays open.
    await width(1200);
    const field = page.getByRole("textbox", { name: "Filter the plan" });
    await field.fill("checkout");
    await width(900);
    await expect.poll(() => field.isVisible()).toBe(true);
    expect(await field.inputValue()).toBe("checkout");
    expect(await page.locator("[data-plan-search-toggle]").getAttribute("aria-label")).toBe("Close the filter");
  } finally {
    await close();
  }
}, 20_000);

it("closes the + Horizon form on Escape and returns focus to its button", async () => {
  const { page, close } = await onHorizons(1280);
  try {
    await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-plan-view]")!;
      view.style.flex = "none";
      view.style.width = "1100px";
    });
    await page.locator("[data-plan-add-horizon]").click();
    await page.getByRole("textbox", { name: "New horizon name" }).press("Escape");
    await page.locator("[data-plan-add-horizon-form]").waitFor({ state: "detached" });
    await expect.poll(() => page.locator("[data-plan-add-horizon]").evaluate((button) => button === document.activeElement)).toBe(true);
  } finally {
    await close();
  }
}, 20_000);

/** Does a tap `dx`, `dy` from the control's centre still land on it? */
const reaches = (page: Page, selector: string, reach: number) =>
  page.locator(selector).evaluate((control, r) => {
    const box = control.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hits = (px: number, py: number) => document.elementFromPoint(px, py)?.closest("button") === control;
    return { above: hits(x, y - r), below: hits(x, y + r), left: hits(x - r, y), right: hits(x + r, y) };
  }, reach);

async function phone(width: number, lens = "horizons", ws = "fernhill"): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route(`&ws=${ws}&plan-lens=${lens}`));
  await page.locator(`[data-plan-lens="${lens}"][aria-selected="true"]`).waitFor();
  return { page, close: () => context.close() };
}

it("puts the lens tabs beside the page name on a phone, and switches lens through them", async () => {
  const { page, close } = await phone(390);
  try {
    const slot = page.locator("header [data-phone-header-slot]");
    expect(await slot.locator("[data-plan-lens]").count()).toBe(3);
    expect(await page.locator("[data-plan-bar] [data-plan-lens]").count()).toBe(0);
    // One line: "Plan" and the three segments share a centre, and the row is as tall as before.
    const row = await page.locator("header h1").evaluate((title) => {
      const centre = (box: DOMRect) => box.top + box.height / 2;
      const tabs = [...document.querySelectorAll("[data-phone-header-slot] [data-plan-lens]")].map((tab) => tab.getBoundingClientRect());
      return {
        spread: Math.round(Math.max(...tabs.map(centre), centre(title.getBoundingClientRect())) - Math.min(...tabs.map(centre), centre(title.getBoundingClientRect()))),
        height: Math.round(title.parentElement!.parentElement!.getBoundingClientRect().height),
        segment: Math.round(tabs[0]!.height),
      };
    });
    expect(row.spread).toBeLessThanOrEqual(2);
    expect(row.height).toBeLessThanOrEqual(53);
    expect(row.segment).toBe(36);
    await slot.locator('[data-plan-lens="timeline"]').click();
    await expect.poll(() => page.locator('[data-plan-lens="timeline"]').getAttribute("aria-selected")).toBe("true");
    await page.locator("[data-plan-timeline-frame]").waitFor();
    await slot.locator('[data-plan-lens="ideas"]').click();
    await expect.poll(() => page.locator('[data-plan-lens="ideas"]').getAttribute("aria-selected")).toBe("true");
  } finally {
    await close();
  }
}, 20_000);

it("fits the three lens tabs and their counts beside the page name at 320px", async () => {
  const { page, close } = await phone(320);
  try {
    const fit = await page.locator("[data-phone-header-slot] [role=tablist]").evaluate((list) => ({ scroll: list.scrollWidth, client: list.clientWidth, right: Math.round(list.getBoundingClientRect().right) }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    expect(fit.right).toBeLessThanOrEqual(320);
    expect(await page.locator('[data-plan-lens="ideas"]').textContent()).toMatch(/Ideas\s*\d+/);
  } finally {
    await close();
  }
}, 20_000);

it("keeps the phone toolbar to one row of 44px with every pill, the filter and + Idea in view, each with a 40px tap", async () => {
  const { page, close } = await phone(375);
  try {
    const bar = page.locator("[data-plan-bar]");
    expect(Math.round(await bar.evaluate((element) => element.getBoundingClientRect().height))).toBeLessThanOrEqual(44);
    const pills = page.getByRole("group", { name: "Show only" });
    expect(await pills.getByRole("button").allTextContents()).toHaveLength(3);
    // Nothing is clipped: the pills need no sideways scroll and every control is inside the screen.
    expect(await pills.evaluate((group) => group.scrollWidth - group.clientWidth)).toBeLessThanOrEqual(0);
    const controls = ['[data-plan-focus="you"]', '[data-plan-focus="late"]', '[data-plan-focus="notStarted"]', "[data-plan-search-toggle]", "[data-plan-capture-open]"];
    for (const selector of controls) {
      const box = await page.locator(selector).evaluate((control) => control.getBoundingClientRect().toJSON() as DOMRect);
      expect(box.left, selector).toBeGreaterThanOrEqual(0);
      expect(box.right, selector).toBeLessThanOrEqual(375);
      // 19px either side of its centre still lands on it: a 40px area (the filter and + Idea meet
      // edge to edge, and Chromium rounds a hit point to whole pixels, so 19.5 would test the 41st).
      expect(await reaches(page, selector, 19), selector).toEqual({ above: true, below: true, left: true, right: true });
    }
    // The filter and + Idea are icons at 32px.
    for (const selector of ["[data-plan-search-toggle]", "[data-plan-capture-open]"]) {
      expect(await page.locator(selector).evaluate((control) => Math.round(control.getBoundingClientRect().width)), selector).toBe(32);
    }
  } finally {
    await close();
  }
}, 20_000);

it("offers Import in the phone toolbar on Ideas, and through + Idea on Horizons, where the bar has no room for both", async () => {
  const ideas = await phone(375, "ideas");
  try {
    const open = ideas.page.locator("[data-plan-import-open]");
    expect(await open.isVisible()).toBe(true);
    const box = await open.evaluate((control) => control.getBoundingClientRect().toJSON() as DOMRect);
    expect(box.right).toBeLessThanOrEqual(375);
    expect(Math.round(await ideas.page.locator("[data-plan-bar]").evaluate((element) => element.getBoundingClientRect().height))).toBeLessThanOrEqual(44);
    expect(await ideas.page.getByRole("group", { name: "Show only" }).evaluate((group) => group.scrollWidth - group.clientWidth)).toBeLessThanOrEqual(0);
  } finally {
    await ideas.close();
  }
  const horizons = await phone(375);
  try {
    expect(await horizons.page.locator("[data-plan-import-open]").isVisible()).toBe(false);
    await horizons.page.locator("[data-plan-capture-open]").click();
    await horizons.page.locator("[data-plan-capture-import]").click();
    expect(await horizons.page.locator("[data-plan-import] [data-plan-import-choose]").isVisible()).toBe(true);
  } finally {
    await horizons.close();
  }
}, 20_000);

it("keeps the lens tabs in the toolbar at 1280px, and on their own compact row in a narrow desk container", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(route("&ws=fernhill&plan-lens=horizons"));
    await page.locator('[data-plan-lens="horizons"][aria-selected="true"]').waitFor();
    expect(await page.locator("[data-plan-bar] [data-plan-lens]").count()).toBe(3);
    expect(await page.locator("[data-phone-header-slot]").count()).toBe(0);
    await page.setViewportSize({ width: 768, height: 844 });
    await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-plan-view]")!;
      view.style.flex = "none";
      view.style.width = "510px";
    });
    expect(await page.locator("[data-plan-bar] [data-plan-lens]").count()).toBe(3);
    await expect.poll(() => page.locator('[data-plan-bar] [data-plan-lens="ideas"]').evaluate((tab) => Math.round(tab.getBoundingClientRect().height))).toBe(36);
    expect(await page.locator('[data-plan-focus="late"]').evaluate((pill) => Math.round(pill.getBoundingClientRect().height))).toBe(30);
  } finally {
    await context.close();
  }
}, 20_000);
