/// <reference lib="dom" />
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { openWorkspace } from "../src/core/open.js";
import type { Browser } from "playwright-core";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache = process.platform === "darwin" ? join(userInfo().homedir, "Library", "Caches", "ms-playwright") : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}
const { chromium } = await import("playwright-core");
let browser: Browser;
let ui: UiHandle;
let home: string;
let dbPath: string;
let horizonRef: string;
const name = "Now · Larkspur merchant beta release";
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-horizon-chip-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira");
  const horizon = plan.view().horizons[0];
  if (!horizon) throw new Error("enabled plan has no default horizon");
  horizonRef = horizon.identifier;
  dbPath = ws.dbPath;
  plan.updateHorizon(horizon.id, { name }, "Mira", person);
  const id = plan.capture({ title: "Merchant checkout", maturity: "shaped", plan: READY_PLAN, horizon: horizon.id }, "Mira", person).id;
  const task = ws.store.createIssue({ title: "Take a payment" });
  plan.adopt(id, task.identifier, "agent");
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

describe("the phone horizon chip", () => {
  for (const colorScheme of ["light", "dark"] as const) it(`opens the full horizon name on tap at 390px in ${colorScheme}`, async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}`, { waitUntil: "networkidle" });
      const chip = page.locator("[data-horizon-chip-compact]").first();
      await chip.waitFor();
      await chip.tap();
      const popover = page.locator('[data-slot="popover-content"]');
      await popover.waitFor();
      expect(await popover.innerText()).toContain(name);
      expect(await page.locator("[data-detail-overlay]").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("saves the person's goal and mode from the horizon drawer without starting a run", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&issue=${horizonRef}`, { waitUntil: "networkidle" });
      await page.locator('[data-horizon-action="run"]').click();
      await page.locator('[data-run-mode="goal"]').click();
      await page.locator("[data-run-goal-input]").fill("A merchant can check out\nPayments settle");
      await page.locator("[data-run-setting-save]").click();
      const stored = () => {
        const { store } = openWorkspace(dbPath);
        try {
          return { horizon: store.plan().view().horizons.find((h) => h.identifier === horizonRef), runs: store.runs().list({ all: true }).length };
        } finally { store.db.close(); }
      };
      await expect.poll(() => stored().horizon?.runMode).toBe("goal");
      expect(stored().horizon?.goal).toEqual(["A merchant can check out", "Payments settle"]);
      expect(stored().runs).toBe(0);
    } finally { await context.close(); }
  });
});
