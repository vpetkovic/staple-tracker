/**
 * PHONE BACK CLOSES WHAT IS OPEN — in a real browser, against the real server and the
 * built app.
 *
 * Every overlay the web UI opens (the menu drawer, the workspace sheet, Settings and its
 * sections, the command palette, New task, the filter and view menus, the detail sheet, a
 * row's menu) pushes one history entry through `useBackToClose` (src/ui/app/src/lib/
 * back-to-close.ts), so the phone's Back gesture closes it instead of leaving the page. That
 * is a property of the browser's history and of React's effect order together, which no
 * string render can see; so this suite drives Chromium through `playwright-core` at a phone
 * size (390x844, touch) and asserts on the page and the address.
 *
 * It also pins the shell rules that only a browser can measure: the phone search never
 * pushes the page sideways, the quick-filter strip returns to its start after a tap, the
 * desktop workspace switcher answers the keyboard with six workspaces or fewer, and saving a
 * setting reloads the page's data once.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle (`npm run build:ui`; the gate order
 * builds first) or no Chromium for `playwright-core` on this machine. Everything is scratch:
 * STAPLE_HOME is a temp dir, the server is in-process on port 0.
 *
 * TWO OVERLAYS BELONG TO THE TASK-LIST LANE — the detail sheet (detail/IssueDetailMount.tsx)
 * and the row menu (components/QueueRowMenu.tsx). Their cases are written here now so the
 * behaviour is pinned, and each RUNS as soon as its file uses `useBackToClose`; until then it
 * is skipped and says so. They are marked [task-list overlay] below.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, uiBundleExists, type UiHandle } from "../src/ui/server.js";

const APP = join(import.meta.dirname, "..", "src", "ui", "app", "src");

/**
 * Where Playwright keeps its browsers. The suite runs with HOME pointed at a scratch dir, and
 * Playwright looks for its cache under HOME — so the browsers of the account running the
 * tests (the passwd home, which HOME does not change) are named explicitly. Only browser
 * binaries are read from there; nothing of staple's.
 */
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache =
    process.platform === "darwin"
      ? join(userInfo().homedir, "Library", "Caches", "ms-playwright")
      : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

// Imported after the path is set: Playwright reads it when the module loads.
const { chromium } = await import("playwright-core");

/** Can `playwright-core` start a browser here? Asked by starting one, which is the only sure answer. */
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
if (reason) console.warn(`ui-phone-back: skipped — ${reason}`);

/** Does a task-list-lane overlay use the shared hook yet? Its case runs once it does. */
const usesHook = (file: string) => {
  const path = join(APP, file);
  return existsSync(path) && readFileSync(path, "utf8").includes("useBackToClose");
};
const detailSheetWired = usesHook("detail/IssueDetailMount.tsx");
const rowMenuWired = usesHook("components/QueueRowMenu.tsx") || usesHook("views/TreeView.tsx") || usesHook("components/task-list/TaskRowLine.tsx");

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let browser: Browser;

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-phone-back-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  for (const slug of ["alpha", "beta"]) {
    const ws = initWorkspace({ global: true, slug });
    for (const title of ["Set up the repository", "Write the README", "Fix the login", "Plan the release"]) {
      ws.store.createIssue({ title: `${title} (${slug})` });
    }
    ws.store.db.close();
  }
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESK = { viewport: { width: 1440, height: 900 } };

async function page(path: string, device: typeof PHONE | typeof DESK = PHONE): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext(device);
  const p = await context.newPage();
  const errors: string[] = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  (p as Page & { errors: string[] }).errors = errors;
  await p.goto(`${origin}${path}${path.includes("?") ? "&" : "?"}token=${token}`, { waitUntil: "networkidle" });
  await p.waitForTimeout(300);
  return { page: p, context };
}

const settle = (p: Page, ms = 450) => p.waitForTimeout(ms);
const back = async (p: Page) => {
  await p.goBack();
  await settle(p, 500);
};
const viewOf = (p: Page) => new URL(p.url()).searchParams.get("view");
const overlayIds = (p: Page) =>
  p.evaluate(() => ((history.state as Record<string, unknown> | null)?.stapleOverlay as unknown[] | undefined)?.length ?? 0);
const count = (p: Page, selector: string) => p.locator(selector).count();
const tap = (p: Page, selector: string) => p.locator(selector).first().tap();

describe.skipIf(Boolean(reason))("phone Back closes the overlay on top, and the page stays", () => {
  it("the menu drawer", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    expect(await count(p, "[data-nav-overlay]")).toBe(1);
    await back(p);
    expect(await count(p, "[data-nav-overlay]")).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it("the workspace sheet", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, '[data-workspace-switcher="bar"]');
    await settle(p);
    expect(await count(p, '[data-sheet="workspaces"]')).toBe(1);
    await back(p);
    expect(await count(p, '[data-sheet="workspaces"]')).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it("Settings opened from the drawer: Back from a section returns to the list, Back again closes it", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    // One tap closes the drawer AND opens Settings: Settings' entry must land after the
    // drawer's has gone, or the drawer's pop would take Settings with it.
    await tap(p, '[data-nav-rail] button[aria-label="Settings"]');
    await settle(p, 700);
    expect(await count(p, "[data-settings-dialog]")).toBe(1);
    expect(await count(p, "[data-nav-overlay]")).toBe(0);
    await tap(p, '[data-settings-category="statuses"]');
    await settle(p, 600);
    expect(await p.locator("[data-settings-shell]").getAttribute("data-pane")).toBe("content");
    await back(p);
    expect(await count(p, "[data-settings-dialog]")).toBe(1);
    expect(await p.locator("[data-settings-shell]").getAttribute("data-pane")).toBe("nav");
    await back(p);
    expect(await count(p, "[data-settings-dialog]")).toBe(0);
    expect(new URL(p.url()).searchParams.has("settings")).toBe(false);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it("the command palette, New task, and the filter, group and sort menus", async () => {
    const { page: p, context } = await page("/?view=tasks");
    const cases: [string, string][] = [
      ['button[aria-label="Search and commands"]', "[role=dialog] [cmdk-root]"],
      ['[data-bar-new-task]', "[role=dialog]"],
      ['button[aria-label="Add a filter"]', "[data-radix-popper-content-wrapper] [role=dialog]"],
      ['button[aria-label="Group tasks"]', "[data-radix-popper-content-wrapper] [role=dialog]"],
      ['button[aria-label^="Sort:"]', "[data-radix-popper-content-wrapper] [role=dialog]"],
    ];
    for (const [trigger, surface] of cases) {
      await tap(p, trigger);
      await settle(p);
      expect(await count(p, surface), `${trigger} opens`).toBeGreaterThan(0);
      await back(p);
      expect(await count(p, surface), `${trigger} closes on Back`).toBe(0);
      expect(viewOf(p)).toBe("tasks");
    }
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("closing from the UI takes the entry back out: no dead Back step is left", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 600);
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    expect(await overlayIds(p)).toBe(1);
    await tap(p, "[data-nav-close]");
    await settle(p, 600);
    expect(await overlayIds(p)).toBe(0);
    // One Back is one page: Graph → Tasks, not Graph → Graph.
    await back(p);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it("a view chosen in the drawer: the drawer closes first, and Back returns to the page before", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    await tap(p, '[data-nav-item="view:graph"]');
    await settle(p, 700);
    expect(viewOf(p)).toBe("graph");
    expect(await overlayIds(p)).toBe(0);
    await back(p);
    expect(viewOf(p)).toBe("tasks");
    expect(await count(p, "[data-nav-overlay]")).toBe(0);
    await context.close();
  }, 30_000);

  it("a filter chosen inside an open menu survives the menu closing, by Back or from the UI", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, 'button[aria-label="Add a filter"]');
    await settle(p);
    await p.getByRole("option", { name: /Priority/ }).first().tap();
    await settle(p);
    await p.getByRole("option", { name: /Medium/ }).first().tap();
    await settle(p, 500);
    expect(new URL(p.url()).searchParams.getAll("priority")).toEqual(["medium"]);
    expect(await overlayIds(p)).toBe(1);
    await back(p);
    expect(await count(p, "[data-radix-popper-content-wrapper] [role=dialog]")).toBe(0);
    expect(new URL(p.url()).searchParams.getAll("priority")).toEqual(["medium"]);
    // …and closed from the UI (Escape): the entry it steps back to is rewritten too.
    await tap(p, 'button[aria-label="Edit Priority filter"]');
    await settle(p);
    await p.getByRole("option", { name: /Medium/ }).first().tap();
    await settle(p, 300);
    await p.keyboard.press("Escape");
    await settle(p, 600);
    expect(await count(p, "[data-radix-popper-content-wrapper] [role=dialog]")).toBe(0);
    expect(new URL(p.url()).searchParams.getAll("priority")).toEqual([]);
    await p.reload({ waitUntil: "networkidle" });
    expect(new URL(p.url()).searchParams.getAll("priority")).toEqual([]);
    await context.close();
  }, 30_000);

  it.skipIf(!detailSheetWired)("[task-list overlay] a fresh tab: open a task, Back closes the sheet and stays in the app", async () => {
    const { page: p, context } = await page("/");
    await tap(p, '[data-testid="task-row"]');
    await settle(p, 800);
    expect(await count(p, "[data-detail-overlay]")).toBe(1);
    await back(p);
    expect(p.url().startsWith(origin)).toBe(true);
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    await context.close();
  }, 30_000);

  it.skipIf(!detailSheetWired)("[task-list overlay] Tasks → Graph → Tasks → open a task: Back closes the sheet and the page stays Tasks", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 600);
    await tap(p, '[data-view-tab="tree"]');
    await settle(p, 600);
    await tap(p, '[data-testid="task-row"]');
    await settle(p, 800);
    expect(await count(p, "[data-detail-overlay]")).toBe(1);
    await back(p);
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it.skipIf(!rowMenuWired)("[task-list overlay] a row's menu", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks");
    await tap(p, 'button[aria-label^="Actions for"]');
    await settle(p);
    expect(await count(p, "[data-queue-row-menu]")).toBe(1);
    await back(p);
    expect(await count(p, "[data-queue-row-menu]")).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);
});

describe.skipIf(Boolean(reason))("the shell, measured", () => {
  it("phone search takes the header row: nothing wider than the screen, nothing scrolled sideways", async () => {
    const { page: p, context } = await page("/?view=tasks");
    await tap(p, 'button[aria-label="Search tasks"]');
    await settle(p);
    await p.keyboard.type("login");
    await settle(p);
    const m = await p.evaluate(() => {
      const field = document.querySelector("[data-filter-search]")!.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        sideways: [...document.querySelectorAll("body *")].filter((e) => e.scrollLeft !== 0).length,
        field: [Math.round(field.left), Math.round(field.right), Math.round(field.height)],
      };
    });
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
    expect(m.sideways).toBe(0);
    expect(m.field[0]).toBeGreaterThanOrEqual(0);
    expect(m.field[1]).toBeLessThanOrEqual(390);
    expect(m.field[2]).toBeGreaterThanOrEqual(44);
    await context.close();
  }, 30_000);

  it("after a quick filter is tapped at the end of the strip, the strip is back at its start with the lit chip and Clear all on screen", async () => {
    const { page: p, context } = await page("/?view=tasks");
    const strip = p.locator("[data-filter-chips]");
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await tap(p, '[data-filter-preset="unassigned"]');
    await settle(p, 500);
    const m = await p.evaluate(() => {
      const t = document.querySelector("[data-filter-chips]")!;
      const box = (s: string) => {
        const r = t.querySelector(s)!.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.right)];
      };
      return { scrollLeft: t.scrollLeft, lit: box('[data-filter-preset="unassigned"]'), clear: box("[data-filter-clear]") };
    });
    expect(m.scrollLeft).toBe(0);
    expect(m.lit[0]).toBeGreaterThanOrEqual(0);
    expect(m.clear[1]).toBeLessThanOrEqual(390);
    await context.close();
  }, 30_000);

  it("the desktop switcher answers the keyboard without a search box: current first, Up wraps, Home/End, Enter switches, Escape closes", async () => {
    const { page: p, context } = await page("/?view=tasks", DESK);
    const selected = () =>
      p.evaluate(() => document.querySelector("[data-workspace-list] [cmdk-item][data-selected=true]")?.getAttribute("data-workspace-option"));
    await p.locator('[data-workspace-switcher="rail"]').focus();
    await p.keyboard.press("Enter");
    await settle(p, 300);
    expect(await selected()).toBe("");
    await p.keyboard.press("ArrowUp");
    expect(await selected()).toBe("beta");
    await p.keyboard.press("Home");
    expect(await selected()).toBe("");
    await p.keyboard.press("End");
    expect(await selected()).toBe("beta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    expect(await selected()).toBe("alpha");
    await p.keyboard.press("Enter");
    await settle(p, 500);
    expect(new URL(p.url()).searchParams.get("ws")).toBe("alpha");
    await p.locator('[data-workspace-switcher="rail"]').focus();
    await p.keyboard.press("Enter");
    await settle(p, 300);
    await p.keyboard.press("Escape");
    await settle(p, 300);
    expect(await count(p, "[data-workspace-popover]")).toBe(0);
    await context.close();
  }, 30_000);

  it("saving a setting reloads the page's data once, not once for the write and again for the poll", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks&settings=statuses", DESK);
    await settle(p, 1800);
    const reads: string[] = [];
    p.on("request", (request) => {
      if (request.url().includes("/api/issues")) reads.push(request.url());
    });
    const label = p.getByRole("textbox", { name: "Label for todo" });
    await label.fill("Ready to start");
    await label.press("Enter");
    await p.getByRole("button", { name: "Save changes" }).click();
    // Past two poll intervals: a second reload would have happened by now.
    await settle(p, 4000);
    expect(reads).toHaveLength(1);
    await context.close();
  }, 30_000);
});
