/// <reference lib="dom" />
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
let idea: string;
let epic: string;
let horizon: string;
let secondWorkspace: string;
const route = (view: string, extra = "") => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=${view}${extra}`;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-tweaks-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira");
  const launch = plan.view().horizons[0]!;
  horizon = launch.identifier;
  plan.updateHorizon(launch.id, { date: "2027-02-01" }, "Mira", person);
  for (let i = 0; i < 36; i++) {
    const record = plan.capture({ title: `Merchant checkout ${i}`, maturity: "shaped", plan: READY_PLAN, horizon: launch.id, plannedStart: "2026-10-01", plannedTarget: "2027-02-01" }, "Mira", person);
    if (i === 0) idea = record.id;
    if (i === 1) { plan.promote(record.id, "Mira", person); epic = record.id; }
  }
  ws.store.db.close();
  const other = initWorkspace({ global: true, slug: "meadow" });
  other.store.plan().enable("Mira");
  secondWorkspace = other.store.slug;
  other.store.db.close();
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); ui?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

async function goView(page: Page, view: string, width: number) {
  await page.locator(width < 768 ? `[data-view-tab="${view}"]` : `[data-nav-item="view:${view}"]`).click();
}
for (const width of [1280, 390]) {
  it(`restores Plan lens, drawer, filters and both scroll axes at ${width}px; URL wins and workspaces stay separate`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(route("plan", "&ws=larkspur"));
      const ideasTab = page.locator('[data-plan-lens="ideas"]');
      await ideasTab.waitFor();
      await ideasTab.focus();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => page.locator('[data-plan-lens="horizons"]').getAttribute("aria-selected")).toBe("true");
      const strip = page.locator('[aria-label="Plan lens"]');
      expect(await strip.getAttribute("data-variant")).toBe(width < 768 ? "default" : "line");
      expect(await strip.getAttribute("class")).toContain("staple-detail-tabstrip");
      await page.locator('[data-plan-lens="timeline"]').click();
      await page.getByRole("textbox", { name: "Filter ideas", exact: true }).fill("Merchant");
      const frame = page.locator("[data-plan-timeline-frame]");
      await frame.waitFor();
      await page.locator(`[data-plan-timeline-row="${idea}"] button`).last().click();
      await page.locator('[aria-label="Issue detail"]').waitFor();
      await frame.evaluate(el => { el.scrollTop = 360; el.scrollLeft = 160; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
      const position = await frame.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }));
      expect(position.top).toBeGreaterThan(0);
      await page.goto(route("tasks", "&ws=larkspur"));
      await goView(page, "plan", width);
      await page.locator('[aria-label="Issue detail"]').waitFor();
      await expect.poll(() => page.locator('[data-plan-lens="timeline"]').getAttribute("aria-selected")).toBe("true");
      expect(await page.locator('input[aria-label="Filter ideas"]').inputValue()).toBe("Merchant");
      await expect.poll(() => frame.evaluate(el => Math.round(el.scrollTop))).toBe(Math.round(position.top));
      await expect.poll(() => frame.evaluate(el => Math.round(el.scrollLeft))).toBe(Math.round(position.left));
      await page.reload();
      await page.locator('[aria-label="Issue detail"]').waitFor();
      expect(await page.locator('[data-plan-lens="timeline"]').getAttribute("aria-selected")).toBe("true");
      await page.goto(route("plan", `&ws=${secondWorkspace}`));
      await page.locator('[data-plan-lens="ideas"]').waitFor();
      expect(await page.locator('[data-plan-lens="ideas"]').getAttribute("aria-selected")).toBe("true");
      expect(await page.locator('[aria-label="Issue detail"]').count()).toBe(0);
      await page.goto(route("plan", "&ws=larkspur&plan-lens=horizons"));
      await expect.poll(() => page.locator('[data-plan-lens="horizons"]').getAttribute("aria-selected")).toBe("true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30_000);

  it(`opens planned ideas from Milestones and horizon drawer, with a promoted epic backlink at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(route("milestones", `&ws=larkspur&focus=${horizon}`));
      const link = page.locator(`[data-open-plan-idea="${idea}"]`).first();
      await link.waitFor();
      await link.click();
      await page.locator(`[data-detail-idea="${idea}"]`).waitFor();
      expect(new URL(page.url()).searchParams.get("view")).toBe("plan");
      await page.goto(route("plan", `&ws=larkspur&issue=${horizon}`));
      await page.locator(`[data-open-plan-idea="${idea}"]`).click();
      await page.locator(`[data-detail-idea="${idea}"]`).waitFor();
      await page.goto(route("tasks", `&ws=larkspur&issue=${epic}`));
      await page.locator("[data-original-idea]").click();
      await page.locator("[data-plan-view]").waitFor();
      expect(new URL(page.url()).searchParams.get("issue")).toBe(epic);
      await page.locator('[aria-label="Issue detail"]').waitFor();
    } finally { await context.close(); }
  }, 30_000);
}
