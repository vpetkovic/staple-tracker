/// <reference lib="dom" />
/**
 * A parent shows the pull requests of the tickets inside it, in the built page: its own stay
 * chips, its descendants' are one roll-up whose card lists them by what needs a person, a
 * ticket in the card opens that ticket, "Show in External links" lands on the tab's section,
 * the parent's row draws a tally with the same card, a child's row under "Tasks inside" draws
 * its badge, a parent with none shows None, and on a phone the pill counts the whole set.
 *
 *   Checkout epic        team/repo#10 open, checks pending (Cart child has it too)
 *   ├─ Cart child        team/repo#20 merged, team/repo#30 draft
 *   └─ Payment child     team/repo#31 open, checks passing
 *      └─ Card form      acme/admin#88 open, checks failing; team/repo#30 draft
 *   Quiet parent         nothing
 *   └─ Quiet child
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import type { ExternalItem, PullRequestCheckState } from "../src/core/integrations/contracts.js";
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
let origin: string;
const refs = { epic: "", a: "", b: "", b1: "", quiet: "" };

function pr(id: number, state: string, { repo = "team/repo", container = "42", checks = null as PullRequestCheckState | null, failing = [] as string[] } = {}): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: container, id: String(id), kind: "pull_request" },
    key: `${repo}#${id}`, url: `https://github.com/${repo}/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: "2026-11-25T12:00:00.000Z",
    pullRequest: {
      headBranch: `branch-${id}`,
      headSha: String(id).padStart(40, "0"),
      checks: checks && { state: checks, failing, completedAt: "2026-11-25T11:00:00.000Z" },
    },
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ui-subtree-prs-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "subtree" });
  const { store } = ws;
  const epic = store.createIssue({ title: "Checkout epic", kind: "epic" });
  const a = store.createIssue({ title: "Cart child", parent: epic.id });
  const b = store.createIssue({ title: "Payment child", parent: epic.id });
  const b1 = store.createIssue({ title: "Card form", parent: b.id });
  const quiet = store.createIssue({ title: "Quiet parent" });
  store.createIssue({ title: "Quiet child", parent: quiet.id });
  Object.assign(refs, { epic: epic.identifier, a: a.identifier, b: b.identifier, b1: b1.identifier, quiet: quiet.identifier });
  const links = store.externalLinks();
  links.link(epic.id, pr(10, "open", { checks: "pending" }), "ada");
  links.link(a.id, pr(10, "open", { checks: "pending" }), "ada");
  links.link(a.id, pr(20, "merged"), "ada");
  links.link(a.id, pr(30, "draft"), "ada");
  links.link(b.id, pr(31, "open", { checks: "passing" }), "ada");
  links.link(b1.id, pr(88, "open", { repo: "acme/admin", container: "43", checks: "failing", failing: ["unit", "lint"] }), "ada");
  links.link(b1.id, pr(30, "draft"), "ada");
  const dbPath = ws.dbPath;
  store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath, discoverPullRequests: false });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function openDetail(page: Page, ref: string) {
  await page.goto(`${origin}/?token=${ui.token}&issue=${ref}`, { waitUntil: "networkidle" });
  await page.locator("[data-detail-identifier]").filter({ hasText: ref }).first().waitFor();
}
const desk = () => browser.newContext({ viewport: { width: 1280, height: 900 } });
const card = (page: Page) => page.locator('[data-link-card="pull-requests"]');
const cardRows = (page: Page) => card(page).locator("[data-pr-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-pr-row")));
const ROLLUP_NAME = "In tasks inside: 4 pull requests: 1 with failing checks, 2 open, 1 draft, 1 merged";
/** The descendants' pull requests, the ones that need a person first. */
const INSIDE = ["acme/admin#88", "team/repo#31", "team/repo#30", "team/repo#20"];

describe("a parent's pull requests in the detail", () => {
  it("keeps its own chips and draws one roll-up for the rest, whose card lists them and opens their tickets", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const slot = page.locator('[data-link-chips="pull_request"]').first();
      await slot.waitFor();
      // Its own pull request is its own chip: no repository prefix, though one inside is in another.
      await expect.poll(() => slot.locator("[data-link-chip] [data-link-key]").allInnerTexts()).toEqual(["#10"]);
      expect(await slot.locator("[data-link-chip] [data-checks]").getAttribute("data-checks")).toBe("pending");
      const rollup = slot.locator("[data-subtree-rollup]");
      expect(await rollup.count()).toBe(1);
      expect(await rollup.getAttribute("aria-label")).toBe(ROLLUP_NAME);
      expect(await rollup.innerText()).toContain("4 in tasks inside");
      expect(await page.getByRole("button", { name: ROLLUP_NAME, exact: true }).count()).toBe(1);

      await rollup.click();
      await card(page).waitFor();
      expect(await cardRows(page)).toEqual(INSIDE);
      expect(await card(page).locator("[data-pr-row] span.tabular-nums").allInnerTexts()).toEqual(["admin#88", "#31", "#30", "#20"]);
      // The card never names the parent back to itself.
      expect(await card(page).locator(`[data-pr-ticket="${refs.epic}"]`).count()).toBe(0);
      expect(await card(page).locator('[data-pr-row="team/repo#30"] [data-pr-ticket]').evaluateAll((b) => b.map((x) => x.getAttribute("data-pr-ticket")))).toEqual([refs.a, refs.b1]);
      await card(page).locator(`[data-pr-row="acme/admin#88"] [data-pr-ticket="${refs.b1}"]`).click();
      await page.locator("[data-detail-identifier]").filter({ hasText: refs.b1 }).first().waitFor();
      // A leaf's Pull requests row is its own chips only.
      const leaf = page.locator('[data-link-chips="pull_request"]').first();
      await expect.poll(() => leaf.locator("[data-link-chip]").count()).toBe(2);
      expect(await leaf.locator("[data-subtree-rollup]").count()).toBe(0);
      expect(await leaf.locator('[data-link-chip] [data-checks="failing"]').count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("names the other ticket on an own chip's card", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      await page.locator('[data-link-chips="pull_request"] [data-link-chip]').first().click();
      const single = page.locator('[data-link-card="single"]');
      await single.waitFor();
      expect(await single.locator("[data-link-checks]").innerText()).toBe("Checks pending");
      expect(await single.locator(`[data-link-also] [data-pr-ticket="${refs.a}"]`).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("takes Show in External links to the tab's section, and counts it in the strip", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const tab = page.getByRole("tab", { name: /^External links/ });
      // One of its own plus four only the tickets inside carry.
      await expect.poll(() => tab.innerText()).toMatch(/External links\s*5/);
      await page.locator("[data-subtree-rollup]").first().click();
      await card(page).getByRole("button", { name: "Show in External links" }).click();
      await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
      const section = page.locator("[data-subtree-links]");
      await section.waitFor();
      expect(await section.isVisible()).toBe(true);
      expect(await section.locator("[data-subtree-link]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-subtree-link")))).toEqual(INSIDE);
      expect(await section.getAttribute("aria-label")).toBe(ROLLUP_NAME);
      expect(await page.getByRole("button", { name: /^All, 5$/ }).count()).toBe(1);
      expect(await page.getByRole("button", { name: /^Pull requests, 5$/ }).count()).toBe(1);
      await page.getByRole("button", { name: /^Issues, 0$/ }).click();
      await expect.poll(() => section.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("opens the roll-up's card from the keyboard and gives focus back on Escape", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const slot = page.locator('[data-link-chips="pull_request"]').first();
      await slot.locator("[data-subtree-rollup]").waitFor();
      // The control before the roll-up is the row's add button.
      await slot.getByRole("button", { name: "Link pull request" }).focus();
      await page.keyboard.press("Tab");
      await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-subtree-rollup"))).toBe(true);
      await page.keyboard.press("Enter");
      await card(page).waitFor();
      await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-link-card="pull-requests"]')))).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => card(page).count()).toBe(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-subtree-rollup"))).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("draws each child's badge under Tasks inside: a leaf's own, a sub-parent's tally", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const inside = page.locator('section[aria-label="Children"]');
      const badge = (ref: string) => inside.locator(`[data-identifier="${ref}"]`).first().locator('[data-testid="pr-badge"]');
      await expect.poll(() => badge(refs.a).getAttribute("data-pr-set")).toBe("own");
      expect(await badge(refs.a).getAttribute("aria-label")).toBe("3 pull requests: 1 open, 1 draft, 1 merged");
      expect(await badge(refs.b).getAttribute("data-pr-set")).toBe("subtree");
      expect(await badge(refs.b).getAttribute("aria-label")).toBe("3 pull requests: 1 with failing checks, 2 open, 1 draft");
      expect(await badge(refs.b).locator("[data-pr-tally]").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("shows None for a parent with none", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await openDetail(page, refs.quiet);
      const slot = page.locator('[data-link-chips="pull_request"]').first();
      await expect.poll(() => slot.innerText()).toContain("None");
      expect(await slot.locator("[data-subtree-rollup]").count()).toBe(0);
      await expect.poll(() => page.getByRole("tab", { name: /^External links/ }).innerText()).toBe("External links");
    } finally {
      await context.close();
    }
  });
});

describe("a parent's row", () => {
  it("draws its set as a tally with the same card, and a leaf's row as its own", async () => {
    const context = await desk();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?token=${ui.token}`, { waitUntil: "networkidle" });
      const row = page.locator(`[data-identifier="${refs.epic}"]`).first();
      await row.waitFor();
      const badge = row.locator('[data-testid="pr-badge"]');
      await expect.poll(() => badge.getAttribute("aria-label")).toBe("5 pull requests: 1 with failing checks, 3 open, 1 draft, 1 merged");
      expect(await badge.getAttribute("data-pr-set")).toBe("subtree");
      expect(await badge.locator("[data-pr-segment]").evaluateAll((s) => s.map((x) => x.getAttribute("data-pr-segment")))).toEqual(["failing", "open", "draft", "merged"]);
      expect(await badge.innerText()).not.toContain("#");
      await badge.click();
      await card(page).waitFor();
      // A row's refs carry numbers only, newest first within a state (rowPullRequests), so the
      // card keys them by number and the failing one still leads.
      expect(await cardRows(page)).toEqual(["#88", "#31", "#10", "#30", "#20"]);
      expect(await card(page).getByText(/^5 pull requests$/).count()).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(() => card(page).count()).toBe(0);

      for (const ref of [refs.epic, refs.b]) await page.getByRole("button", { name: `Expand ${ref}`, exact: true }).click();
      const leaf = page.locator(`[data-identifier="${refs.b1}"]`).first();
      await leaf.waitFor();
      const leafBadge = leaf.locator('[data-testid="pr-badge"]');
      expect(await leafBadge.getAttribute("data-pr-set")).toBe("own");
      expect(await leafBadge.locator('[data-checks="failing"]').count()).toBe(1);
      expect(await page.locator(`[data-identifier="${refs.quiet}"]`).first().locator('[data-testid="pr-badge"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

describe("on a phone", () => {
  it("counts the whole set on the pill, which shows the section, with no Pull requests row under More details", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const pill = page.locator('[data-link-pill="pull_request"]').first();
      await pill.waitFor();
      expect(await pill.innerText()).toBe("5 pull requests");
      expect(await pill.getAttribute("aria-label")).toBe("5 pull requests: 1 with failing checks, 3 open, 1 draft, 1 merged; show External links");
      expect(await pill.locator('[data-checks="failing"]').count()).toBe(1);
      const more = page.locator("[data-more-details]").first();
      await more.locator("> summary").click();
      expect(await more.locator('[data-link-chips="pull_request"]').count()).toBe(0);
      expect(await more.innerText()).not.toContain("Pull requests");
      await pill.tap();
      const section = page.locator("[data-subtree-links]");
      await section.waitFor();
      await expect.poll(() => section.isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });
});
