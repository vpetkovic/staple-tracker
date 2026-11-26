/// <reference lib="dom" />
/**
 * The idea drawer's Plan tab in a real browser: a question answered and deferred from "Where it
 * stands" writes what it wrote before; a section chip brings its section under the stuck chips;
 * a breakdown row opens to its editor and saves; an unwritten section opens from its chip and
 * saves; the Delivered form opens from the end of the tab; the header's Scaffold opens the
 * preview in the panel; the phone keeps the primary in its bottom bar.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { initWorkspace, resolveWorkspace } from "../src/core/workspace.js";
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
let exploring: string;
let shaped: string;
const route = (extra = "") => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}&view=plan${extra}`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-idea-drawer-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "larkspur" });
  const plan = ws.store.plan();
  const person = { person: { via: "plan_view" } } as const;
  plan.enable("Mira", { person: { via: "settings" } });
  const brief = Array.from({ length: 12 }, (_, at) => `Paragraph ${at + 1} of the brief, about who shares what with whom and why.`).join("\n\n");
  // Prose that does not fold, below the breakdown: room for its chip to bring it to the top.
  const outOfScope = Array.from({ length: 30 }, (_, at) => `Not part of it, number ${at + 1}.`).join("\n\n");
  exploring = plan.capture(
    {
      title: "Coach shares a program",
      maturity: "exploring",
      brief,
      plan: {
        goal: "A client opens a coach's program from a link.",
        breakdown: [
          { key: "1.1", title: "Spike the link", estimate: "3h", dependsOn: [], acceptance: "Findings written", owner: null, notes: null },
          { key: "1.2", title: "Build the link", estimate: "1d", dependsOn: ["1.1"], acceptance: null, owner: null, notes: null },
        ],
        acceptance: ["A client opens the link"],
        outOfScope,
      },
    },
    "Mira",
    person,
  ).id;
  plan.addQuestion(exploring, "Does the link expire?", "Mira");
  plan.addQuestion(exploring, "Can a client copy it?", "Mira");
  shaped = plan.capture({ title: "Ready checkout", maturity: "shaped", plan: READY_PLAN }, "Mira", person).id;
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

async function openIdea(id: string, width = 1280): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 768, isMobile: width < 768 });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(route(`&ws=larkspur&issue=${id}`));
  await page.locator(`[data-plan-tab="${id}"]`).waitFor();
  return { page, close: () => context.close() };
}

/** The idea's detail as the store holds it now. */
function stored(id: string) {
  const ws = resolveWorkspace({ ws: "larkspur" });
  try {
    return ws.store.plan().detail(id);
  } finally {
    ws.store.db.close();
  }
}

it("answers one question and defers another from the panel, writing what the old controls wrote", async () => {
  const { page, close } = await openIdea(exploring);
  try {
    const panel = page.locator("[data-plan-standing]");
    await panel.locator('[data-plan-answer="1"]').click();
    await panel.locator("[data-plan-answered-toggle]").waitFor();
    await panel.locator('[data-plan-defer="2"]').click();
    await expect.poll(() => panel.locator('[data-plan-defer="2"]').innerText()).toBe("Undefer");
    expect(await panel.locator('[data-plan-answer="1"]').count()).toBe(0);
    const questions = stored(exploring).questions;
    expect(questions[0]).toMatchObject({ text: "Does the link expire?", resolved: true });
    expect(questions[1]).toMatchObject({ text: "Can a client copy it?", resolved: false, deferred: true });
  } finally {
    await close();
  }
}, 20_000);

for (const width of [1280, 390]) {
  it(`brings a section under the stuck chips when its chip is chosen, at ${width}px`, async () => {
    const { page, close } = await openIdea(exploring, width);
    try {
      await page.locator('[data-plan-chip="breakdown"]').click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const nav = document.querySelector("[data-plan-section-nav]")!.getBoundingClientRect();
            const section = document.querySelector('[data-plan-anchor="breakdown"]')!.getBoundingClientRect();
            return Math.round(section.top - nav.bottom);
          }),
        )
        .toBe(12);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-plan-anchor"))).toBe("breakdown");
    } finally {
      await close();
    }
  }, 20_000);
}

it("opens a breakdown row to its editor and saves a field when it is left", async () => {
  const { page, close } = await openIdea(exploring);
  try {
    expect(await page.locator('[data-plan-breakdown="read"] input').count()).toBe(0);
    await page.locator('[data-plan-row-open="1.2"]').click();
    const editor = page.locator('[data-plan-row-editor="1.2"]');
    await editor.waitFor();
    const owner = editor.getByRole("textbox", { name: "Owner for 1.2" });
    await owner.fill("mira");
    await owner.blur();
    await expect.poll(() => stored(exploring).plan.breakdown[1]?.owner).toBe("mira");
  } finally {
    await close();
  }
}, 20_000);

it("opens an unwritten section from its chip and saves it in place", async () => {
  const { page, close } = await openIdea(exploring);
  try {
    expect(await page.locator('[data-plan-section="risks"]').count()).toBe(0);
    await page.locator('[data-plan-unwritten] [data-plan-section-empty="risks"]').click();
    const input = page.locator('[data-plan-section-input="risks"]');
    await input.waitFor();
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    await input.fill("Links leak; watch the share count.");
    await input.blur();
    await expect.poll(() => stored(exploring).plan.risks).toBe("Links leak; watch the share count.");
    await page.locator('[data-plan-section-read="risks"]').waitFor();
    expect(await page.locator('[data-plan-unwritten] [data-plan-section-empty="risks"]').count()).toBe(0);
  } finally {
    await close();
  }
}, 20_000);

it("opens the Delivered form from the end of the tab, not the top", async () => {
  const { page, close } = await openIdea(exploring);
  try {
    expect(await page.locator("[data-plan-delivered-on]").count()).toBe(0);
    await page.locator("[data-plan-delivered-open]").click();
    await page.locator("[data-plan-delivered-on]").waitFor();
    const order = await page.evaluate(() => {
      const form = document.querySelector("[data-plan-delivered-form]")!;
      const decisions = document.querySelector('[data-plan-section="decisions"]')!;
      return decisions.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
  } finally {
    await close();
  }
}, 20_000);

it("opens the scaffold preview in the panel from the header's Scaffold, and keeps the primary in the phone's bottom bar", async () => {
  const desk = await openIdea(shaped);
  try {
    await desk.page.locator("[data-plan-primary]").click();
    await desk.page.locator("[data-plan-standing] [data-plan-scaffold-confirm]").waitFor();
  } finally {
    await desk.close();
  }
  const phone = await openIdea(shaped, 390);
  try {
    expect(await phone.page.locator("[data-detail-actionbar] [data-plan-primary]").count()).toBe(1);
  } finally {
    await phone.close();
  }
}, 20_000);
