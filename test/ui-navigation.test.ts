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
  at: { server?: UiHandle; search?: string; ready?: (page: Page) => Promise<void>; stored?: Record<string, string> } = {},
): Promise<void> {
  const context = await browser.newContext(options);
  try {
    // What this browser remembered before the page opened: written once, before the first load.
    if (at.stored) {
      await context.addInitScript((entries) => {
        if (sessionStorage.getItem("seeded")) return;
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        sessionStorage.setItem("seeded", "1");
      }, at.stored);
    }
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
    await withPage(
      { ...DESK, colorScheme: "light" },
      async (page) => {
        expect(await dark(page)).toBe(false);
        expect(await stored(page, "staple:theme")).toBeNull();
        expect(await stored(page)).toBeNull();
        await page.emulateMedia({ colorScheme: "dark" });
        await expect.poll(() => dark(page)).toBe(true);
      },
      { stored: { "staple:theme": "dark" } },
    );
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

describe("a workspace the hub does not have", () => {
  /**
   * Tasks filters remembered for each workspace ("" = All workspaces), searching `remembered-<ws or all>`.
   * The stored shape is lib/view-prefs.ts's (`encodeViewPrefs`, scope `sortScopeKey`), which this
   * Node-side program cannot import.
   */
  const remembered = (...workspaces: string[]) => ({
    "staple:view:v1": JSON.stringify({
      version: 3,
      filters: Object.fromEntries(
        workspaces.map((ws) => [`${ws || "*"}::tree`, { dims: { project: [projectId] }, text: `remembered-${ws || "all"}`, showDone: false }]),
      ),
    }),
  });
  const storedScopes = (page: Page) =>
    page.evaluate(() => Object.keys((JSON.parse(localStorage.getItem("staple:view:v1") ?? "{}") as { filters?: object }).filters ?? {}).sort());
  const address = (page: Page) => {
    const params = new URL(page.url()).searchParams;
    return { ws: params.get("ws"), view: params.get("view"), project: params.getAll("project"), q: params.get("q") };
  };
  const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
  const hub = (search: string, stored: Record<string, string>) => ({
    server: hubUi,
    search,
    stored,
    ready: (page: Page) => page.locator('[data-workspace-switcher="head"]').waitFor(),
  });

  it.each([
    ["none, not the remembered ones", "", null],
    ["exactly the ones it carries", "&q=task", "task"],
  ])("lands on All workspaces with the address's own filters: %s", async (_, filters, q) => {
    await withPage(
      DESK,
      async (page) => {
        await expect.poll(() => address(page).ws).toBeNull();
        expect(address(page)).toEqual({ ws: null, view: "tasks", project: [], q });
        // ...and the page shows it: the remembered project and search would hide this task.
        await page.getByText("A task to list").first().waitFor({ timeout: 5000 });
        // Moved, not copied: the workspace that is not there keeps no filters of its own.
        await expect.poll(() => storedScopes(page)).toEqual(["*::tree"]);
      },
      hub(`&view=tasks&ws=nowhere${filters}`, remembered("")),
    );
  });

  it("leaves a known workspace's address as it is", async () => {
    await withPage(
      DESK,
      async (page) => {
        await page.getByText("A task to list").first().waitFor();
        expect(address(page)).toEqual({ ws: "navfocus", view: "tasks", project: [], q: null });
      },
      hub("&view=tasks&ws=navfocus", remembered("navfocus")),
    );
  });

  it("keeps the address's filters when Forward returns to one", async () => {
    await withPage(
      DESK,
      async (page) => {
        await page.getByText("A task to list").first().waitFor();
        // An entry naming a workspace the hub lost, reached by history rather than by a load.
        await page.evaluate(() => {
          const unknown = new URL(location.href);
          unknown.search = `?view=tasks&ws=nowhere&q=task`;
          history.pushState(null, "", unknown);
        });
        await page.goBack();
        await expect.poll(() => address(page).ws).toBe("navfocus");
        await page.goForward();
        await expect.poll(() => address(page).ws).toBeNull();
        expect(address(page)).toEqual({ ws: null, view: "tasks", project: [], q: "task" });
      },
      hub("&view=tasks&ws=navfocus", remembered("")),
    );
  });

  it("keeps the filters on screen when the workspace chosen in the rail leaves the hub", async () => {
    await withPage(
      DESK,
      async (page) => {
        await page.locator('[data-workspace-switcher="head"]').click();
        await page.locator('[data-workspace-option="navfocus"]').click();
        await expect.poll(() => address(page)).toEqual({ ws: "navfocus", view: "tasks", project: [projectId], q: "remembered-navfocus" });
        // navfocus is unregistered: the next bootstrap no longer lists it, and the poll says
        // something changed (after one real answer, the page's baseline) so the page asks for one.
        await page.waitForResponse((response) => response.url().includes("/api/poll"));
        await page.route("**/api/bootstrap*", async (route) => {
          const response = await route.fetch();
          const body = (await response.json()) as { workspaces: { slug: string }[] };
          await route.fulfill({ response, json: { ...body, workspaces: body.workspaces.filter((workspace) => workspace.slug !== "navfocus") } });
        });
        await page.route("**/api/poll*", (route) => route.fulfill({ json: { fingerprint: "navfocus unregistered" } }));
        await expect.poll(() => address(page).ws, { timeout: 10_000 }).toBeNull();
        expect(address(page)).toEqual({ ws: null, view: "tasks", project: [projectId], q: "remembered-navfocus" });
      },
      hub("&view=tasks", remembered("", "navfocus")),
    );
  }, 30_000);

  it("drops a milestone focus and a run of the workspace that is not there", async () => {
    await withPage(
      DESK,
      async (page) => {
        await expect.poll(() => param(page, "ws")).toBeNull();
        expect([param(page, "view"), param(page, "focus")]).toEqual(["milestones", null]);
      },
      hub("&view=milestones&ws=nowhere&focus=NOPE-M1", {}),
    );
    await withPage(
      DESK,
      async (page) => {
        await expect.poll(() => param(page, "ws")).toBeNull();
        expect([param(page, "view"), param(page, "run")]).toEqual(["autopilot", null]);
      },
      hub("&view=autopilot&ws=nowhere&run=0123456789abcdef", {}),
    );
  });

  it.each([
    ["nothing stored for it: All workspaces' remembered filters", [""], "remembered-all"],
    ["filters stored for it: those, which were on screen", ["", "nowhere"], "remembered-nowhere"],
  ])("lands a ticket link (no view) with %s", async (_, workspaces, q) => {
    await withPage(
      DESK,
      async (page) => {
        await expect.poll(() => address(page).ws).toBeNull();
        await expect.poll(() => address(page)).toEqual({ ws: null, view: "tasks", project: [projectId], q });
      },
      hub("&ws=nowhere&issue=NOPE-1", remembered(...workspaces)),
    );
  });

  describe("on a single workspace's page, which names none", () => {
    it("keeps the address's filters when it names another workspace, and drops that one's focus", async () => {
      await withPage(
        DESK,
        async (page) => {
          await expect.poll(() => address(page).ws).toBeNull();
          expect(address(page)).toEqual({ ws: null, view: "tasks", project: [], q: "task" });
        },
        { search: "&view=tasks&ws=nowhere&q=task", stored: remembered("") },
      );
      await withPage(
        DESK,
        async (page) => {
          await expect.poll(() => param(page, "ws")).toBeNull();
          expect(param(page, "focus")).toBeNull();
        },
        { search: "&view=milestones&ws=nowhere&focus=NAV-M1", ready: (page) => page.locator("[data-nav-rail]").waitFor() },
      );
    });

    it("keeps the focus when the address names this workspace", async () => {
      await withPage(
        DESK,
        async (page) => {
          await expect.poll(() => param(page, "ws")).toBeNull();
          expect([param(page, "view"), param(page, "focus")]).toEqual(["milestones", "NAV-M1"]);
        },
        { search: "&view=milestones&ws=navfocus&focus=NAV-M1", ready: (page) => page.locator("[data-nav-rail]").waitFor() },
      );
    });
  });
});
