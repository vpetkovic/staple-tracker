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
