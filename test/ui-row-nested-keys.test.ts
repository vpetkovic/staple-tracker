/// <reference lib="dom" />
/**
 * ENTER AND SPACE ON A CONTROL INSIDE A ROW BELONG TO THAT CONTROL, in a real browser against
 * the real server and the built app, in every list whose rows open on Enter.
 *
 * A row is focusable and opens on Enter (the tree also selects on Space), and it holds
 * focusable controls of its own: the `⋯` that opens a menu, a pull request badge, the member
 * controls on the Milestones page. A keydown on one of those bubbles to the row's handler,
 * and a menu's keydown arrives there too through the React portal. The row must act only on
 * a key pressed on the row itself.
 *
 * Per list: Enter on the control does the control's job and leaves the drawer as it was;
 * Enter on an item of the control's menu runs the item and leaves the drawer as it was;
 * Enter on the row itself still opens it. The Tasks-inside list draws no `⋯` (its preset
 * turns the column off), so its control is the pull request badge.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle or no Chromium for `playwright-core`
 * (in CI it must run). Everything is scratch: STAPLE_HOME is a temp dir and the server is
 * in-process on port 0.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import type { MilestoneCreateResult } from "../src/core/milestone-store.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { startUiServer, uiBundleExists, type UiHandle } from "../src/ui/server.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache =
    process.platform === "darwin"
      ? join(userInfo().homedir, "Library", "Caches", "ms-playwright")
      : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

const { chromium } = await import("playwright-core");

async function chromiumAvailable(): Promise<boolean> {
  try {
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const bundle = uiBundleExists();
const browserReady = bundle && (await chromiumAvailable());
const reason = !bundle ? "no UI bundle (run npm run build:ui)" : !browserReady ? "no Chromium for playwright-core" : "";
if (reason) console.warn(`ui-row-nested-keys: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-row-nested-keys: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-row-nested-keys cannot run in CI: ${reason}.`);
    });
  });
}

const WS = "keys";
const PR_URL = "https://github.com/team/repo/pull/7";
let home: string;
let dbPath: string;
let ui: UiHandle;
let browser: Browser;
let origin: string;
const refs = { epic: "", withPr: "", loose: "", member: "", second: "", milestone: "" };

function pr(id: number): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" },
    key: `team/repo#${id}`, url: PR_URL, title: `PR ${id}`, body: null,
    status: { id: "open", name: "open" }, fetchedAt: "2026-11-25T12:00:00.000Z",
    pullRequest: { headBranch: `branch-${id}`, headSha: String(id).padStart(40, "0"), checks: null },
  };
}

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-row-nested-keys-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: WS });
  const { store } = ws;
  const epic = store.createIssue({ title: "Checkout rework", kind: "epic" });
  const withPr = store.createIssue({ title: "Price the basket", parent: epic.id });
  store.createIssue({ title: "Take the payment", parent: epic.id });
  const loose = store.createIssue({ title: "Write the release notes" });
  store.externalLinks().link(withPr.id, pr(7), "vp");
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, null);
  const member = store.createIssue({ title: "Tidy the settings page" });
  const second = store.createIssue({ title: "Rename the export" });
  const plan = store.milestones().create({ title: "October cut" }, null) as MilestoneCreateResult;
  for (const issue of [member, second]) store.milestones().addMember(plan.milestone.id, issue.id, {}, null);
  Object.assign(refs, {
    epic: epic.identifier,
    withPr: withPr.identifier,
    loose: loose.identifier,
    member: member.identifier,
    second: second.identifier,
    milestone: plan.milestone.identifier,
  });
  dbPath = ws.dbPath;
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

const DESK = { width: 1280, height: 860 };
/** Narrower than the Milestones page's roomy width, where a member's controls fold into a `⋯`. */
const NARROW_DESK = { width: 1100, height: 860 };

async function openAt(query: string, viewport = DESK): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/?ws=${WS}&${query}&token=${ui.token}`, { waitUntil: "networkidle" });
  return { page, context, errors };
}

const detail = (page: Page) => page.locator("[data-detail-overlay]");
const openedIssue = (page: Page) => new URL(page.url()).searchParams.get("issue");
/** Long enough for a stray open to have routed and drawn. */
const settle = (page: Page) => page.waitForTimeout(400);

const queued = () => {
  const { store } = openWorkspace(dbPath);
  try {
    return store.queue().entries({ all: true }).map((entry) => entry.identifier);
  } finally {
    store.db.close();
  }
};

const members = () => {
  const { store } = openWorkspace(dbPath);
  try {
    const shown = store.milestones().get(refs.milestone);
    return shown.members.map((entry) => entry.identifier);
  } finally {
    store.db.close();
  }
};

describe.skipIf(Boolean(reason))("the Tasks tree: keys on a row's own controls", () => {
  const row = (page: Page, ref: string) => page.locator(`[role="treegrid"] [data-testid="task-row"][data-identifier="${ref}"]:not([data-ghost])`);

  it("Enter on a row's actions button opens its menu and leaves the drawer closed", async () => {
    const { page, context, errors } = await openAt("view=tasks");
    try {
      const trigger = row(page, refs.loose).getByRole("button", { name: `Actions for ${refs.loose}` });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await settle(page);
      expect(await detail(page).count()).toBe(0);
      expect(openedIssue(page)).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Space on a row's actions button opens its menu and selects nothing", async () => {
    const { page, context, errors } = await openAt("view=tasks");
    try {
      const trigger = row(page, refs.loose).getByRole("button", { name: `Actions for ${refs.loose}` });
      await trigger.focus();
      await page.keyboard.press(" ");
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await settle(page);
      expect(await page.locator('[role="treegrid"] [aria-selected="true"]').count()).toBe(0);
      expect(await detail(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const key of ["Enter", " "] as const) {
    const name = key === " " ? "Space" : key;
    it(`${name} on a menu item runs the item and leaves the drawer closed`, async () => {
      const { page, context, errors } = await openAt("view=tasks");
      try {
        // Two top-level rows, so each case queues a row nobody has queued yet.
        const ref = key === "Enter" ? refs.loose : refs.member;
        const trigger = row(page, ref).getByRole("button", { name: `Actions for ${ref}` });
        await trigger.focus();
        await page.keyboard.press("Enter");
        const item = page.getByRole("menu").locator('[data-menu-item="queue-last"]');
        await item.waitFor({ timeout: 5_000 });
        await expect.poll(() => item.getAttribute("aria-disabled")).toBeNull();
        await item.focus();
        expect(queued()).not.toContain(ref);
        await page.keyboard.press(key);
        await expect.poll(() => queued()).toContain(ref);
        await settle(page);
        expect(await detail(page).count()).toBe(0);
        expect(openedIssue(page)).toBeNull();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  it("Enter on a row's chevron folds it open and leaves the drawer closed", async () => {
    const { page, context, errors } = await openAt("view=tasks");
    try {
      const chevron = row(page, refs.epic).getByRole("button", { name: `Expand ${refs.epic}` });
      await chevron.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => row(page, refs.epic).getAttribute("aria-expanded")).toBe("true");
      await settle(page);
      expect(await detail(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Enter on the row itself still opens it", async () => {
    const { page, context, errors } = await openAt("view=tasks");
    try {
      await row(page, refs.loose).focus();
      await page.keyboard.press("Enter");
      await detail(page).waitFor({ timeout: 5_000 });
      await expect.poll(() => openedIssue(page)).toBe(refs.loose);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Space on the row itself still selects it, and arrows still move between rows", async () => {
    const { page, context, errors } = await openAt("view=tasks");
    try {
      await row(page, refs.loose).focus();
      await page.keyboard.press(" ");
      await expect.poll(() => row(page, refs.loose).getAttribute("aria-selected")).toBe("true");
      const before = await page.evaluate(() => document.activeElement?.getAttribute("data-identifier"));
      await page.keyboard.press("ArrowUp");
      const after = await page.evaluate(() => document.activeElement?.getAttribute("data-identifier"));
      expect(after).not.toBe(before);
      expect(await detail(page).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("the Tasks-inside list in the detail: keys on a row's own controls", () => {
  const children = (page: Page) => page.getByRole("listbox", { name: "Children" });

  it("Enter on a row's pull request badge follows the link and leaves the drawer on the parent", async () => {
    const { page, context, errors } = await openAt(`view=tasks&issue=${refs.epic}`);
    try {
      const badge = children(page).locator(`[data-identifier="${refs.withPr}"] [data-testid="pr-badge"]`);
      await badge.waitFor({ timeout: 5_000 });
      await badge.focus();
      const popup = context.waitForEvent("page", { timeout: 5_000 });
      await page.keyboard.press("Enter");
      expect((await popup).url()).toBe(PR_URL);
      await settle(page);
      expect(openedIssue(page)).toBe(refs.epic);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Enter on the row itself still opens the child", async () => {
    const { page, context, errors } = await openAt(`view=tasks&issue=${refs.epic}`);
    try {
      const child = children(page).locator(`[role="option"][data-identifier="${refs.withPr}"]`);
      await child.waitFor({ timeout: 5_000 });
      await child.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => openedIssue(page)).toBe(refs.withPr);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(Boolean(reason))("the Milestones page: keys on a member row's own controls", () => {
  const memberRow = (page: Page, ref: string) => page.locator(`[data-member-row="${ref}"]`);

  it("Enter on a member's actions button opens its menu and leaves the drawer closed", async () => {
    const { page, context, errors } = await openAt(`view=milestones&focus=${refs.milestone}`, NARROW_DESK);
    try {
      const trigger = memberRow(page, refs.member).getByRole("button", { name: `Actions for ${refs.member}` });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ timeout: 5_000 });
      await settle(page);
      expect(await detail(page).count()).toBe(0);
      expect(openedIssue(page)).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Enter on a menu item runs the item and leaves the drawer closed", async () => {
    const { page, context, errors } = await openAt(`view=milestones&focus=${refs.milestone}`, NARROW_DESK);
    try {
      const trigger = memberRow(page, refs.member).getByRole("button", { name: `Actions for ${refs.member}` });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const item = page.getByRole("menuitem", { name: `Move ${refs.member} down` });
      await item.waitFor({ timeout: 5_000 });
      await item.focus();
      expect(members()).toEqual([refs.member, refs.second]);
      await page.keyboard.press("Enter");
      await expect.poll(() => members()).toEqual([refs.second, refs.member]);
      await settle(page);
      expect(await detail(page).count()).toBe(0);
      expect(openedIssue(page)).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("Enter on the member row itself still opens it", async () => {
    const { page, context, errors } = await openAt(`view=milestones&focus=${refs.milestone}`, NARROW_DESK);
    try {
      await memberRow(page, refs.second).focus();
      await page.keyboard.press("Enter");
      await detail(page).waitFor({ timeout: 5_000 });
      await expect.poll(() => openedIssue(page)).toBe(refs.second);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
