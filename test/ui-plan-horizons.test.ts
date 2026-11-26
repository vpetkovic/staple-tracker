/// <reference lib="dom" />
/**
 * The Horizons outline in a real browser: the rows are one tab stop that the arrow keys walk and
 * fold, a refused rename keeps its editor open and writes once, a drag marks only the
 * sections the idea's state may be moved to, and the header's small controls take a phone tap.
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
let next: { id: string; identifier: string; name: string };
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
  // A dated horizon, so its header offers "clear" beside the first one's "add a date".
  plan.updateHorizon(next.id, { date: "2099-03-05" }, "Mira", person);
  // Enough on the second horizon for the lens to scroll under its header, with work linked so it has a percent.
  for (const title of ["Gift wrap", "Store credit", "Loyalty points", "Price alerts", "Wish lists", "Bundles", "Back in stock", "Size guide", "Reviews", "Returns"]) {
    plan.capture({ title, maturity: "shaped", plan: READY_PLAN, horizon: next.id }, "Mira", person);
  }
  const linked = plan.view().ideas.find((idea) => idea.title === "Gift wrap")!.id;
  plan.adopt(linked, ws.store.createIssue({ title: "Wrap paper" }).identifier, "agent");
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

async function onHorizons(width = 1280, height = 844): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height } });
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

it("gives the header's fold, name, clear and add a date a tap area of at least 32px on a phone", async () => {
  for (const width of [320, 414]) {
    const { page, close } = await onHorizons(width);
    try {
      const controls = {
        fold: `[data-plan-horizon-fold="${launch.identifier}"]`,
        name: `[data-plan-horizon="${launch.identifier}"] h2 button`,
        date: `[data-plan-horizon-date="${launch.identifier}"]`,
        clear: `[data-plan-horizon-clear-date]`,
      };
      for (const [name, selector] of Object.entries(controls)) {
        // A tap 16px either side of the control's centre still lands on it.
        // Under 760px the date links sit below the header's first line; the copy drawn at this width.
        const reach = await page.locator(selector).filter({ visible: true }).first().evaluate((control) => {
          const box = control.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const hits = (px: number, py: number) => document.elementFromPoint(px, py)?.closest("button") === control;
          return { above: hits(x, y - 15.5), below: hits(x, y + 15.5), height: Math.round(box.height) };
        });
        expect(reach, `${name} at ${width}px`).toMatchObject({ above: true, below: true });
      }
      const fold = await page.locator(controls.fold).evaluate((control) => {
        const box = control.getBoundingClientRect();
        const y = box.top + box.height / 2;
        return document.elementFromPoint(box.left + box.width / 2 + 15.5, y)?.closest("button") === control;
      });
      expect(fold, `fold sideways at ${width}px`).toBe(true);
    } finally {
      await close();
    }
  }
}, 30_000);

it("shows a row's ⋯ without hover on a touch device at tablet width, and keeps it for hover on a desk", async () => {
  const opacity = async (touch: boolean) => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(route("&ws=larkspur&plan-lens=horizons"));
      const menu = page.locator(`[data-plan-card-menu="${solo}"]`);
      await menu.waitFor({ state: "attached" });
      // The outline is wide here: the ⋯ would wait for hover.
      expect(await page.locator("[data-plan-tree]").first().evaluate((tree) => tree.getBoundingClientRect().width)).toBeGreaterThanOrEqual(760);
      return await menu.evaluate((button) => getComputedStyle(button.parentElement!).opacity);
    } finally {
      await context.close();
    }
  };
  expect(await opacity(true)).toBe("1");
  expect(await opacity(false)).toBe("0");
}, 30_000);

/** Scroll the lens so the second horizon's header is stuck with its rows under it. */
async function stickNext(page: Page) {
  await page.locator(`[data-plan-column="h:${next.id}"]`).evaluate((section: HTMLElement) => {
    const board = section.closest<HTMLElement>("[data-plan-board]")!;
    board.scrollTop = section.offsetTop + 120;
    if (Math.round(board.scrollTop) !== section.offsetTop + 120) throw new Error(`the lens scrolls only to ${board.scrollTop}`);
  });
  await page.waitForTimeout(100);
}

it("sticks only a one-line horizon header on a phone, with the name and the percent", async () => {
  const { page, close } = await onHorizons(390);
  try {
    const hairline = () => page.locator(`[data-plan-column="h:${next.id}"]`).evaluate((section) => {
      const line = [...section.querySelectorAll<HTMLElement>("*")].find((el) => getComputedStyle(el).position === "sticky" && getComputedStyle(el).display !== "contents")!;
      return getComputedStyle(line).borderBottomColor;
    });
    // In place, the line and the bar below it read as one header; stuck, a hairline ends it.
    expect(await hairline()).toBe("rgba(0, 0, 0, 0)");
    await stickNext(page);
    await expect.poll(hairline).not.toBe("rgba(0, 0, 0, 0)");
    const stuck = await page.locator(`[data-plan-column="h:${next.id}"]`).evaluate((section) => {
      const board = section.closest<HTMLElement>("[data-plan-board]")!.getBoundingClientRect();
      // What sits at the top of the scroller is the stuck part of the header.
      const top = document.elementFromPoint(board.left + 60, board.top + 4)!;
      // The header box gives way on a phone (`display: contents`): the stuck part is a sticky element with a box.
      const line = [...section.querySelectorAll<HTMLElement>("*")].find((el) => el.contains(top) && getComputedStyle(el).position === "sticky" && getComputedStyle(el).display !== "contents")!;
      const box = line.getBoundingClientRect();
      const bar = section.querySelector("[data-plan-tree-bar]")!.getBoundingClientRect();
      return { offset: Math.round(box.top - board.top), height: Math.round(box.height), text: line.textContent ?? "", barGone: bar.bottom <= box.bottom };
    });
    expect(stuck.offset).toBe(0);
    expect(stuck.height).toBeLessThanOrEqual(44);
    expect(stuck.text).toContain(next.name);
    expect(stuck.text).toMatch(/\d+%/);
    // The bar, its flags and the counts went with the content.
    expect(stuck.barGone).toBe(true);
  } finally {
    await close();
  }
}, 30_000);

it("keeps the whole horizon header stuck on a desk", async () => {
  const { page, close } = await onHorizons(1280, 480);
  try {
    await stickNext(page);
    const stuck = await page.locator(`[data-plan-horizon="${next.identifier}"]`).evaluate((header) => {
      const board = header.closest<HTMLElement>("[data-plan-board]")!.getBoundingClientRect();
      const box = header.getBoundingClientRect();
      const bar = header.querySelector("[data-plan-tree-bar]")!.getBoundingClientRect();
      return { offset: Math.round(box.top - board.top), barInside: bar.top >= box.top && bar.bottom <= box.bottom, height: Math.round(box.height) };
    });
    expect(stuck).toMatchObject({ offset: 0, barInside: true });
    expect(stuck.height).toBeGreaterThan(60);
  } finally {
    await close();
  }
}, 30_000);

it("draws the empty Not scheduled section as one line on a phone", async () => {
  const { page, close } = await onHorizons(390);
  try {
    const empty = page.locator('[data-plan-column="h:"]');
    expect(await empty.evaluate((section) => Math.round(section.getBoundingClientRect().height))).toBeLessThanOrEqual(44);
    expect(await empty.innerText()).toMatch(/^Not scheduled\s+nothing here$/);
  } finally {
    await close();
  }
}, 30_000);
