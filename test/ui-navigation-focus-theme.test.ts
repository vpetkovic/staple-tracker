/// <reference lib="dom" />
/**
 * Navigation behaviour that only a browser can show: where keyboard focus goes when the rail
 * is hidden or shown, whether the phone drawer keeps focus inside itself, whether the theme
 * follows the system until a person picks one, what the rail's Tasks row means once a
 * project has narrowed the list, and where choosing a workspace from Usage lands. None of this is visible to a string
 * render (no jsdom in this suite), so this drives the built page.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContextOptions, Page } from "playwright-core";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache = process.platform === "darwin" ? join(userInfo().homedir, "Library", "Caches", "ms-playwright") : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}
const { chromium } = await import("playwright-core");

let browser: Browser;
let ui: UiHandle;
let hubUi: UiHandle;
let home: string;
let projectId: string;
let dbPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-nav-focus-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "navfocus" });
  ws.store.createIssue({ title: "A task to list" });
  projectId = ws.store.projects().create({ name: "Docs site" }, "setup").id;
  dbPath = ws.dbPath;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  hubUi = startUiServer({ port: 0, hub: true });
  await once(hubUi.server, "listening");
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  hubUi?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const DESK = { viewport: { width: 1440, height: 900 } } satisfies BrowserContextOptions;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } satisfies BrowserContextOptions;

/** Opens the single-workspace page on Tasks, or `at.search` on `at.server` (the hub page), and waits for `at.ready`. */
async function withPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
  at: { server?: () => UiHandle; search?: string; ready?: (page: Page) => Promise<void> } = {},
): Promise<void> {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const target = (at.server ?? (() => ui))();
    await page.goto(`http://127.0.0.1:${(target.server.address() as AddressInfo).port}/?token=${target.token}${at.search ?? ""}`, { waitUntil: "networkidle" });
    await (at.ready ?? ((ready) => ready.getByText("A task to list").first().waitFor()))(page);
    await run(page);
  } finally {
    await context.close();
  }
}

/** The focused element's accessible name, or "BODY" when focus has fallen out of the page's controls. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "BODY";
    return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName;
  });

describe("focus when the desk rail is hidden and shown", () => {
  it("moves to Show navigation when the rail is hidden, and back into the rail when it is shown", async () => {
    await withPage(DESK, async (page) => {
      await page.getByRole("button", { name: "Hide navigation" }).focus();
      await page.keyboard.press("Enter");
      await page.locator("[data-nav-show]").waitFor();
      expect(await focused(page)).toBe("Show navigation");

      await page.keyboard.press("Enter");
      await page.locator("[data-nav-rail]").waitFor();
      expect(await focused(page)).toBe("Hide navigation");
    });
  });

  it("leaves focus where it is when [ is pressed from outside the rail", async () => {
    await withPage(DESK, async (page) => {
      const search = page.locator("[data-top-search]");
      await search.focus();
      await page.keyboard.press("[");
      await page.locator("[data-nav-show]").waitFor();
      expect(await focused(page)).toBe("Find a task or run a command");
    });
  });
});

describe("the phone drawer", () => {
  it("keeps Tab inside the drawer and makes the page behind it inert while it is open", async () => {
    await withPage(PHONE, async (page) => {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.locator("[data-nav-overlay]").waitFor();
      expect(await page.locator("[data-content-frame]").evaluate((frame) => (frame as HTMLElement).inert)).toBe(true);
      const escaped: string[] = [];
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        // Past the drawer's last control Tab may leave the document for the browser's own
        // controls (BODY here), as it does from a native modal dialog. What must never take
        // focus is a control of the page behind the scrim.
        const behind = await page.evaluate(() => {
          const element = document.activeElement;
          return element !== null && element !== document.body && !element.closest("[data-nav-overlay]");
        });
        if (behind) escaped.push(await focused(page));
      }
      expect(escaped).toEqual([]);

      await page.keyboard.press("Escape");
      await page.locator("[data-nav-overlay]").waitFor({ state: "detached" });
      expect(await page.locator("[data-content-frame]").evaluate((frame) => (frame as HTMLElement).inert)).toBe(false);
      expect(await focused(page)).toBe("Menu");
    });
  });
});

describe("the theme", () => {
  const stored = (page: Page) => page.evaluate(() => localStorage.getItem("staple:theme"));
  const dark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

  it("follows the system, live, until a person chooses, and records only that choice", async () => {
    await withPage({ ...DESK, colorScheme: "dark" }, async (page) => {
      expect(await dark(page)).toBe(true);
      // Opening the page is not a choice.
      expect(await stored(page)).toBeNull();
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => dark(page)).toBe(false);
      expect(await page.getByRole("switch", { name: "Dark mode" }).getAttribute("aria-checked")).toBe("false");

      await page.getByRole("switch", { name: "Dark mode" }).click();
      expect(await dark(page)).toBe(true);
      expect(await stored(page)).toBe("dark");
      // A choice outlives the system changing its mind, and a reload.
      await page.emulateMedia({ colorScheme: "dark" });
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForTimeout(100);
      expect(await dark(page)).toBe(true);
      await page.reload({ waitUntil: "networkidle" });
      expect(await dark(page)).toBe(true);
    });
  });
});

describe("the rail's Tasks row", () => {
  it("shows every task again after a project narrowed the list, and keeps the other filters", async () => {
    await withPage(DESK, async (page) => {
      await page.locator(`[data-nav-project="${projectId}"]`).click();
      await expect.poll(() => new URL(page.url()).searchParams.getAll("project")).toEqual([projectId]);
      expect(await page.locator(`[data-nav-project="${projectId}"]`).getAttribute("aria-current")).toBe("true");
      // Another filter on the same page, which the Tasks row must leave alone.
      const withDone = new URL(page.url());
      withDone.searchParams.set("done", "1");
      await page.goto(withDone.toString(), { waitUntil: "networkidle" });

      await page.locator("[data-nav-item='view:tree']").click();
      await expect.poll(() => new URL(page.url()).searchParams.getAll("project")).toEqual([]);
      expect(new URL(page.url()).searchParams.get("done")).toBe("1");
      expect(await page.locator(`[data-nav-project="${projectId}"]`).getAttribute("aria-current")).toBeNull();
      expect(await page.locator("[data-nav-item='view:tree']").getAttribute("aria-current")).toBe("page");
    });
  });
});

describe("the page's poll", () => {
  it("gives up a poll that hangs, so the page keeps refreshing", async () => {
    await withPage(DESK, async (page) => {
      // The first poll only sets the page's baseline; let one be answered.
      await page.waitForResponse((response) => response.url().includes("/api/poll"));
      // The next poll is lost on the way (a network change): it is never answered.
      let held = false;
      await page.route("**/api/poll*", async (route) => {
        if (!held) {
          held = true;
          return; // neither answered nor failed
        }
        await route.continue();
      });
      await expect.poll(() => held, { timeout: 5000 }).toBe(true);
      const { store } = openWorkspace(dbPath);
      try {
        store.createIssue({ title: "Written while a poll hung" });
      } finally {
        store.db.close();
      }
      await page.getByText("Written while a poll hung").first().waitFor({ timeout: 15_000 });
    });
  }, 30_000);
});

describe("choosing a workspace from Usage", () => {
  it("lands on the workspace's Tasks, since Usage reads the same in every workspace", async () => {
    await withPage(
      DESK,
      async (page) => {
        expect(await page.locator("[data-nav-workspace][aria-current]").count()).toBe(0);
        await page.locator('[data-nav-workspace="navfocus"]').click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("tasks");
        expect(new URL(page.url()).searchParams.get("ws")).toBe("navfocus");
        expect(await page.locator('[data-nav-workspace="navfocus"]').getAttribute("aria-current")).toBe("true");
        expect(await page.locator("[data-nav-item='view:tree']").getAttribute("aria-current")).toBe("page");
      },
      { server: () => hubUi, search: "&view=budget", ready: (page) => page.locator('[data-nav-workspace="navfocus"]').waitFor() },
    );
  });
});
