/// <reference lib="dom" />
/**
 * A parent shows the pull requests of its children, in the built page: the detail's Pull
 * requests row lists its own and then each descendant's with the tickets it is on (a shared
 * one once, naming both), an identifier opens that ticket, the parent's row badge counts the
 * same set, and a parent with none shows nothing. On a phone the set sits in More details.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
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
const refs = { epic: "", a: "", b: "", quiet: "" };

function pr(id: number, state: string): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: "2026-11-25T12:00:00.000Z",
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
  const quiet = store.createIssue({ title: "Quiet parent" });
  store.createIssue({ title: "Quiet child", parent: quiet.id });
  Object.assign(refs, { epic: epic.identifier, a: a.identifier, b: b.identifier, quiet: quiet.identifier });
  const links = store.externalLinks();
  links.link(epic.id, pr(10, "open"), "ada");
  links.link(a.id, pr(20, "merged"), "ada");
  links.link(a.id, pr(30, "draft"), "ada");
  links.link(b.id, pr(30, "draft"), "ada");
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
const subtreeChips = (page: Page) =>
  page.locator("[data-subtree-pr]").evaluateAll((chips) =>
    chips.map((chip) => [chip.getAttribute("data-subtree-pr"), [...chip.querySelectorAll("[data-subtree-ticket]")].map((t) => t.getAttribute("data-subtree-ticket"))]),
  );

describe("a parent's pull requests in the page", () => {
  it("lists its own, then each child's naming its tickets, and an identifier opens that ticket", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      const slot = page.locator('[data-link-chips="pull_request"]').first();
      await slot.waitFor();
      // Its own pull request is its own chip, with nothing after it.
      await expect.poll(() => slot.locator("[data-link-chip] [data-link-key]").allInnerTexts()).toEqual(["#10"]);
      expect(await slot.locator("[data-subtree-tickets]").count()).toBe(2);
      // Each child's, once, with every ticket it is on.
      expect(await subtreeChips(page)).toEqual([
        ["team/repo#20", [refs.a]],
        ["team/repo#30", [refs.a, refs.b]],
      ]);
      await page.locator(`[data-subtree-pr="team/repo#30"] [data-subtree-ticket="${refs.b}"]`).click();
      await page.locator("[data-detail-identifier]").filter({ hasText: refs.b }).first().waitFor();
      // A leaf's row is its own links only.
      expect(await page.locator("[data-subtree-pr]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("draws the same set on the parent's row, and nothing for a parent with none", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?token=${ui.token}`, { waitUntil: "networkidle" });
      const row = page.locator(`[data-identifier="${refs.epic}"]`).first();
      await row.waitFor();
      const badge = row.locator('[data-testid="pr-badge"]');
      await expect.poll(() => badge.getAttribute("aria-label")).toBe(
        `3 pull requests: #10 open on ${refs.epic}, #30 draft on ${refs.a}, ${refs.b}, #20 merged on ${refs.a}`,
      );
      expect(await page.locator(`[data-identifier="${refs.quiet}"]`).first().locator('[data-testid="pr-badge"]').count()).toBe(0);

      await openDetail(page, refs.quiet);
      const slot = page.locator('[data-link-chips="pull_request"]').first();
      await expect.poll(() => slot.innerText()).toContain("None");
      expect(await page.locator("[data-subtree-pr]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("lists the set in More details on a phone", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await openDetail(page, refs.epic);
      await page.locator("[data-more-details] > summary").first().click();
      await expect.poll(() => subtreeChips(page)).toEqual([
        ["team/repo#20", [refs.a]],
        ["team/repo#30", [refs.a, refs.b]],
      ]);
      expect(await page.locator("[data-subtree-pr]").first().isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });
});
