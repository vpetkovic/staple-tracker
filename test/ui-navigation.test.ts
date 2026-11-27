/// <reference lib="dom" />
/**
 * Navigation behaviour that only a browser can show: whether the theme follows the system
 * until a person picks one, what the rail's Tasks row means once a project has narrowed the
 * list, whether a poll that hangs stops the page refreshing, and where choosing a workspace
 * from Usage lands. None of this is visible to a string render (no jsdom in this suite), so
 * this drives the built page.
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
  home = mkdtempSync(join(tmpdir(), "staple-navigation-"));
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
  at: { server?: UiHandle; search?: string; ready?: (page: Page) => Promise<void> } = {},
): Promise<void> {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const target = at.server ?? ui;
    await page.goto(`http://127.0.0.1:${(target.server.address() as AddressInfo).port}/?token=${target.token}${at.search ?? ""}`, { waitUntil: "networkidle" });
    await (at.ready ?? ((ready) => ready.getByText("A task to list").first().waitFor()))(page);
    await run(page);
  } finally {
    await context.close();
  }
}

describe("the theme", () => {
  const stored = (page: Page, key = "staple:theme:v2") => page.evaluate((name) => localStorage.getItem(name), key);
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

  it("follows the system with the rail narrowed, and the switch agrees when the rail comes back", async () => {
    await withPage({ ...DESK, colorScheme: "light" }, async (page) => {
      await page.keyboard.press("[");
      await page.locator('[data-nav-rail][data-rail-mode="narrow"]').waitFor();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => dark(page)).toBe(true);
      await page.keyboard.press("[");
      await page.locator('[data-nav-rail][data-rail-mode="full"]').waitFor();
      expect(await page.getByRole("switch", { name: "Dark mode" }).getAttribute("aria-checked")).toBe("true");
    });
  });

  it("follows the system on a phone, where no theme switch is on screen", async () => {
    await withPage({ ...PHONE, colorScheme: "dark" }, async (page) => {
      expect(await page.getByRole("switch", { name: "Dark mode" }).count()).toBe(0);
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => dark(page)).toBe(false);
    });
  });

  it("does not read the old key as a pick, and removes it", async () => {
    // Builds before this one wrote the first visit's system answer to `staple:theme` on every load.
    const context = await browser.newContext({ ...DESK, colorScheme: "light" });
    try {
      await context.addInitScript(() => {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem("staple:theme", "dark");
          sessionStorage.setItem("seeded", "1");
        }
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${(ui.server.address() as AddressInfo).port}/?token=${ui.token}`, { waitUntil: "networkidle" });
      await page.getByText("A task to list").first().waitFor();
      expect(await dark(page)).toBe(false);
      expect(await stored(page, "staple:theme")).toBeNull();
      expect(await stored(page)).toBeNull();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => dark(page)).toBe(true);
    } finally {
      await context.close();
    }
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

describe("Tasks from the phone's tab bar and the palette", () => {
  const projectOf = (page: Page) => new URL(page.url()).searchParams.getAll("project");
  const narrowed = () => `&view=tasks&project=${projectId}`;

  it("shows every task from the tab bar after a project narrowed the list", async () => {
    await withPage(
      PHONE,
      async (page) => {
        expect(projectOf(page)).toEqual([projectId]);
        await page.locator('[data-view-tab="queue"]').click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("queue");
        await page.locator('[data-view-tab="tree"]').click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("tasks");
        expect(projectOf(page)).toEqual([]);
      },
      { search: narrowed(), ready: (page) => page.locator("[data-view-tabs]").waitFor() },
    );
  });

  it("shows every task from the palette's Go to Tasks after a project narrowed the list", async () => {
    await withPage(
      DESK,
      async (page) => {
        await page.locator("[data-nav-item='view:queue']").click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("queue");
        await page.keyboard.press("Control+k");
        await page.keyboard.type("Go to Tasks");
        await page.getByRole("option", { name: /Go to Tasks/ }).first().click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("tasks");
        expect(projectOf(page)).toEqual([]);
      },
      { search: narrowed(), ready: (page) => page.locator("[data-nav-rail]").waitFor() },
    );
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
        // On Usage the rail's head steps back: the page is in no workspace.
        const name = page.locator('[data-workspace-switcher="head"] [data-workspace-name]');
        expect(await name.getAttribute("class")).toContain("text-text-secondary");
        await page.locator('[data-workspace-switcher="head"]').click();
        await page.locator('[data-workspace-option="navfocus"]').click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("tasks");
        expect(new URL(page.url()).searchParams.get("ws")).toBe("navfocus");
        expect(await name.textContent()).toBe("navfocus");
        expect(await name.getAttribute("class")).not.toContain("text-text-secondary");
        expect(await page.locator("[data-nav-item='view:tree']").getAttribute("aria-current")).toBe("page");
      },
      { server: hubUi, search: "&view=budget", ready: (page) => page.locator('[data-workspace-switcher="head"]').waitFor() },
    );
  });
});

describe("the rail under the keyboard", () => {
  const focused = (page: Page) =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return "body";
      const hook = ["data-nav-item", "data-nav-settings", "data-nav-toggle", "data-view-tab"].find((name) => element.hasAttribute(name));
      return hook ? `${hook}=${element.getAttribute(hook)}` : element.tagName;
    });

  it("keeps the focus on the same row when [ changes the rail's width, a project going to Tasks", async () => {
    await withPage(DESK, async (page) => {
      await page.locator("[data-nav-item='view:graph']").focus();
      await page.keyboard.press("[");
      await page.locator('[data-nav-rail][data-rail-mode="narrow"]').waitFor();
      expect(await focused(page)).toBe("data-nav-item=view:graph");
      await page.keyboard.press("[");
      await page.locator('[data-nav-rail][data-rail-mode="full"]').waitFor();
      expect(await focused(page)).toBe("data-nav-item=view:graph");
      // A project row has no narrow twin: its parent row takes the focus.
      await page.locator(`[data-nav-project="${projectId}"]`).focus();
      await page.keyboard.press("[");
      await page.locator('[data-nav-rail][data-rail-mode="narrow"]').waitFor();
      expect(await focused(page)).toBe("data-nav-item=view:tree");
      await page.keyboard.press("[");
    });
  });

  it("gets the focus back on Settings from the dialog it opened", async () => {
    await withPage(DESK, async (page) => {
      await page.locator("[data-nav-settings]").focus();
      await page.keyboard.press("Enter");
      await page.locator("[data-settings-dialog]").waitFor();
      await page.keyboard.press("Escape");
      await page.locator("[data-settings-dialog]").waitFor({ state: "detached" });
      await expect.poll(() => focused(page)).toBe("data-nav-settings=true");
    });
  });

  it("gets the focus back on the More tab from a dialog the More sheet opened", async () => {
    await withPage(
      PHONE,
      async (page) => {
        await page.locator('[data-view-tab="more"]').click();
        await page.locator("[data-more-new-project]").click();
        await page.locator("[data-project-dialog]").waitFor();
        await page.keyboard.press("Escape");
        await page.locator("[data-project-dialog]").waitFor({ state: "detached" });
        await expect.poll(() => focused(page)).toBe("data-view-tab=more");
      },
      { ready: (page) => page.locator("[data-view-tabs]").waitFor() },
    );
  });
});

describe("the rail while the server does not answer", () => {
  it("keeps Reconnecting in sight above the foot however long the list of projects", async () => {
    const { store } = openWorkspace(dbPath);
    const made: string[] = [];
    try {
      for (let i = 0; i < 32; i++) made.push(store.projects().create({ name: `Long list ${String(i).padStart(2, "0")}` }, "setup").id);
    } finally {
      store.db.close();
    }
    try {
      await withPage({ viewport: { width: 1280, height: 720 } }, async (page) => {
        await page.locator(`[data-nav-project="${made.at(-1)}"]`).waitFor({ state: "attached" });
        await page.route("**/api/poll*", (route) => route.abort());
        const status = page.locator('[data-nav-connection="reconnecting"]');
        await status.waitFor({ timeout: 15_000 });
        const seen = await status.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          const scroller = document.querySelector("[data-nav-rail] .overflow-y-auto")!;
          return { inView: box.top >= 0 && box.bottom <= innerHeight, onTop: element === hit || element.contains(hit), listScrolls: scroller.scrollHeight > scroller.clientHeight };
        });
        expect(seen).toEqual({ inView: true, onTop: true, listScrolls: true });
      });
    } finally {
      const again = openWorkspace(dbPath);
      try {
        for (const id of made) again.store.projects().remove(id, "setup");
      } finally {
        again.store.db.close();
      }
    }
  }, 40_000);
});
