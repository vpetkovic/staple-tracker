/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
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
const milestoneMenuWired = usesHook("views/milestones/MilestonesView.tsx");
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
    if (slug === "alpha") {
      // A milestone with one member, for the Milestones view's member menu (ALP-5 holds ALP-4).
      ws.store.addKind({ id: "milestone", label: "Milestone" }, null);
      ws.store.milestones().create({ title: "October cut" }, null);
      ws.store.milestones().addMember("ALP-5", "ALP-4", {}, null);
    }
    if (slug === "beta") {
      // One task waiting on another (the Tasks rows carry dependency badges), and an epic
      // holding two more, one waiting on the other: the Graph has a canvas, a toolbar and
      // an epic box to test on.
      ws.store.setBlockedBy("BET-2", ["BET-1"], null);
      ws.store.createIssue({ title: "Release plan (beta)", kind: "epic" });
      ws.store.createChild("BET-5", { title: "Cut the release branch (beta)" });
      ws.store.createChild("BET-5", { title: "Publish the release notes (beta)" });
      ws.store.setBlockedBy("BET-7", ["BET-6"], null);
      // BET-6 both waits and blocks: two badges side by side on a wide row.
      ws.store.setBlockedBy("BET-6", ["BET-2"], null);
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
/** A tablet held upright: the desk layout, under a finger. */
const TABLET = { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function page(path: string, device: typeof PHONE | typeof DESK | typeof TABLET = PHONE): Promise<{ page: Page; context: BrowserContext }> {
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
    // The drawer does not repeat the top bar's New task and Search, and offers a plain close
    // rather than the desktop's collapse-the-rail icon.
    expect(await p.locator("[data-nav-rail] [data-nav-new-task]").isVisible()).toBe(false);
    expect(await p.locator("[data-nav-rail] [data-nav-search]").isVisible()).toBe(false);
    expect(await p.locator('[data-nav-rail] [aria-label="Hide navigation"]').isVisible()).toBe(false);
    expect(await p.locator("[data-nav-close]").isVisible()).toBe(true);
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
      // Focus returns to the trigger; on a touch screen that must not raise a tooltip that
      // nothing can dismiss.
      expect(await count(p, "[role=tooltip]"), `${trigger} leaves no tooltip behind`).toBe(0);
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

  it.skipIf(!detailSheetWired)("[task-list overlay] a desk: going to another view from the palette with the task drawer open closes the drawer first; Back returns to Tasks", async () => {
    const { page: p, context } = await page("/?view=tasks", DESK);
    await p.locator('[data-testid="task-row"]').first().click();
    await settle(p, 800);
    expect(await count(p, "[data-detail-overlay]")).toBe(1);
    // The palette opens over the drawer; its command closes the palette and navigates while
    // the drawer is still open underneath — the drawer's entry must be stepped past first.
    await p.keyboard.press("ControlOrMeta+k");
    await settle(p, 400);
    await p.keyboard.type("Go to Graph");
    await settle(p, 300);
    await p.keyboard.press("Enter");
    await settle(p, 900);
    expect(viewOf(p)).toBe("graph");
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    expect(await overlayIds(p)).toBe(0);
    await back(p);
    expect(viewOf(p)).toBe("tasks");
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    await context.close();
  }, 30_000);

  it.skipIf(!rowMenuWired)("[task-list overlay] a row's menu opened by a long press", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks");
    const cdp = await context.newCDPSession(p);
    const box = (await p.locator('[data-testid="task-row"]').first().boundingBox())!;
    const point = { x: box.x + box.width * 0.55, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await settle(p, 700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(p, 500);
    expect(await count(p, "[data-queue-row-menu]")).toBe(1);
    await back(p);
    expect(await count(p, "[data-queue-row-menu]")).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    await context.close();
  }, 30_000);

  it.skipIf(!rowMenuWired || !detailSheetWired)("[task-list overlay] the row menu's Open hands over to the sheet: one Back closes the sheet, the next leaves the page", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks");
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 600);
    await tap(p, '[data-view-tab="tree"]');
    await settle(p, 600);
    await tap(p, 'button[aria-label^="Actions for"]');
    await settle(p);
    // One tap closes the menu and opens the sheet: the sheet's entry must land after the
    // menu's is gone (lib/back-to-close.ts, `whenHistoryIsFree`).
    await tap(p, '[data-queue-row-menu] [data-menu-item="open"]');
    await settle(p, 800);
    expect(await count(p, "[data-queue-row-menu]")).toBe(0);
    expect(await count(p, "[data-detail-overlay]")).toBe(1);
    expect(await overlayIds(p)).toBe(1);
    await back(p);
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    expect(viewOf(p)).toBe("tasks");
    // No dead entry left by the menu: the next Back is the page before.
    await back(p);
    expect(viewOf(p)).toBe("graph");
    await context.close();
  }, 30_000);

  it.skipIf(!milestoneMenuWired || !detailSheetWired)("[task-list overlay] a milestone member's menu hands over to the sheet: one Back closes the sheet, the next leaves the page", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks");
    await tap(p, '[data-view-tab="milestones"]');
    await settle(p, 600);
    if ((await count(p, '[data-member-actions="ALP-4"]')) === 0) {
      await p.getByRole("button", { name: /October cut/ }).first().tap();
      await settle(p, 600);
    }
    const before = p.url();
    await tap(p, '[data-member-actions="ALP-4"]');
    await settle(p);
    await tap(p, '[role=menu] [data-menu-item="open"]');
    await settle(p, 800);
    expect(await count(p, "[role=menu]")).toBe(0);
    expect(await count(p, "[data-detail-overlay]")).toBe(1);
    expect(await overlayIds(p)).toBe(1);
    await back(p);
    expect(await count(p, "[data-detail-overlay]")).toBe(0);
    expect(p.url()).toBe(before);
    expect(await overlayIds(p)).toBe(0);
    // No dead entry left by the menu: the next Back leaves this page.
    await back(p);
    expect(p.url()).not.toBe(before);
    await context.close();
  }, 30_000);

  it("Graph's View menu: a choice made in it rewrites the address without orphaning the menu's entry", async () => {
    const { page: p, context } = await page("/?ws=beta&view=tasks");
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 800);
    await tap(p, "[data-graph-view]");
    await settle(p);
    expect(await count(p, "[data-graph-view-options]")).toBe(1);
    expect(await overlayIds(p)).toBe(1);
    await tap(p, '[data-view-option="frontier"]');
    await settle(p, 500);
    // The graph wrote its state onto the address, and the menu's entry is still the entry.
    expect(new URL(p.url()).searchParams.get("graph")).toBeTruthy();
    expect(await overlayIds(p)).toBe(1);
    // Closed from the UI: its entry comes out, so one Back is one page.
    await p.keyboard.press("Escape");
    await settle(p, 600);
    expect(await count(p, "[data-graph-view-options]")).toBe(0);
    expect(await overlayIds(p)).toBe(0);
    await back(p);
    expect(viewOf(p)).toBe("tasks");
    // …and phone Back closes the menu itself.
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 800);
    await tap(p, "[data-graph-view]");
    await settle(p);
    await back(p);
    expect(await count(p, "[data-graph-view-options]")).toBe(0);
    expect(viewOf(p)).toBe("graph");
    await context.close();
  }, 30_000);

  it("a task's dependencies dialog, Graph's Epics picker, and a status card's ⋯ menu in Settings", async () => {
    const tasks = await page("/?ws=beta&view=tasks");
    await tap(tasks.page, ".staple-dep-badge");
    await settle(tasks.page, 600);
    expect(await count(tasks.page, '[data-testid="dependencies-dialog"]')).toBe(1);
    await back(tasks.page);
    expect(await count(tasks.page, '[data-testid="dependencies-dialog"]')).toBe(0);
    expect(viewOf(tasks.page)).toBe("tasks");
    await tasks.context.close();

    const graph = await page("/?ws=beta&view=graph");
    await settle(graph.page, 500);
    await tap(graph.page, "[data-epic-picker]");
    await settle(graph.page);
    expect(await count(graph.page, 'input[aria-label="Search epics"]')).toBe(1);
    await back(graph.page);
    expect(await count(graph.page, 'input[aria-label="Search epics"]')).toBe(0);
    expect(viewOf(graph.page)).toBe("graph");
    await graph.context.close();

    const settings = await page("/?ws=alpha&view=tasks&settings=statuses&settings-ws=alpha");
    await settle(settings.page, 800);
    await tap(settings.page, '[data-vocabulary-more="todo"]');
    await settle(settings.page);
    expect(await count(settings.page, "[role=menu]")).toBe(1);
    await back(settings.page);
    expect(await count(settings.page, "[role=menu]")).toBe(0);
    expect(await count(settings.page, "[data-settings-dialog]")).toBe(1);
    expect(await settings.page.locator("[data-settings-shell]").getAttribute("data-pane")).toBe("content");
    await settings.context.close();
  }, 45_000);

  it("Settings: Back over unsaved edits asks, as the X does; Keep stays, Discard closes and leaves no dead step", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=tasks");
    await tap(p, '[data-view-tab="graph"]');
    await settle(p, 600);
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    await tap(p, '[data-nav-rail] button[aria-label="Settings"]');
    await settle(p, 700);
    await tap(p, '[data-settings-category="statuses"]');
    await settle(p, 800);
    await p.getByRole("textbox", { name: "Label for todo" }).fill("Ready to start");
    await settle(p, 300);
    // Back from the section keeps the draft (the section only hides) and shows the list.
    await back(p);
    expect(await p.locator("[data-settings-shell]").getAttribute("data-pane")).toBe("nav");
    expect(await count(p, "[data-confirm-dialog]")).toBe(0);
    // Back from the list would close Settings and throw the edit away: it asks instead.
    await back(p);
    expect(await count(p, "[data-settings-dialog]")).toBe(1);
    expect(await p.locator("[data-confirm-dialog]").textContent()).toContain("Discard unsaved changes?");
    expect(new URL(p.url()).searchParams.has("settings")).toBe(true);
    // Keep editing: Settings stays, holding its entry.
    await p.getByRole("button", { name: "Keep editing" }).tap();
    await settle(p, 500);
    expect(await count(p, "[data-confirm-dialog]")).toBe(0);
    expect(await count(p, "[data-settings-dialog]")).toBe(1);
    expect(await overlayIds(p)).toBe(1);
    // Back while the question is up is the safe answer, too.
    await back(p);
    expect(await count(p, "[data-confirm-dialog]")).toBe(1);
    await back(p);
    expect(await count(p, "[data-confirm-dialog]")).toBe(0);
    expect(await count(p, "[data-settings-dialog]")).toBe(1);
    // Discard: Settings closes, the address drops it, and no dead Back step is left.
    await back(p);
    await p.getByRole("button", { name: "Discard changes" }).tap();
    await settle(p, 700);
    expect(await count(p, "[data-settings-dialog]")).toBe(0);
    expect(new URL(p.url()).searchParams.has("settings")).toBe(false);
    expect(viewOf(p)).toBe("graph");
    expect(await overlayIds(p)).toBe(0);
    await back(p);
    expect(viewOf(p)).toBe("tasks");
    // Clean, Back closes Settings at once, as before.
    await tap(p, 'button[aria-label="Menu"]');
    await settle(p);
    await tap(p, '[data-nav-rail] button[aria-label="Settings"]');
    await settle(p, 700);
    await back(p);
    expect(await count(p, "[data-settings-dialog]")).toBe(0);
    expect(await count(p, "[data-confirm-dialog]")).toBe(0);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    await context.close();
  }, 45_000);

  it.skipIf(!milestoneMenuWired)("[task-list overlay] a milestone member's menu", async () => {
    const { page: p, context } = await page("/?ws=alpha&view=milestones");
    await settle(p, 500);
    // A phone lists the milestones first; the plan (and its members) is one tap in.
    if ((await count(p, '[data-member-actions="ALP-4"]')) === 0) {
      await p.getByRole("button", { name: /October cut/ }).first().tap();
      await settle(p, 600);
    }
    await tap(p, '[data-member-actions="ALP-4"]');
    await settle(p);
    expect(await count(p, "[role=menu]")).toBe(1);
    await back(p);
    expect(await count(p, "[role=menu]")).toBe(0);
    expect(viewOf(p)).toBe("milestones");
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
  /**
   * A control's TOUCH target as a finger meets it: the span around its centre where the
   * browser's hit test lands on it, a pseudo-element's area included and whatever covers or
   * clips it excluded. Quarter-pixel steps, so the span is within 0.25px of each true edge.
   */
  const target = (p: Page, selector: string, index = 0) =>
    p.evaluate(([selector, index]) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const on = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (el === hit || el.contains(hit) || (el instanceof HTMLInputElement && [...(el.labels ?? [])].some((label) => label.contains(hit))));
      };
      const reach = (dx: number, dy: number) => {
        let d = 0;
        while (d < 60 && on(cx + dx * (d + 0.25), cy + dy * (d + 0.25))) d += 0.25;
        return d;
      };
      return { w: reach(-1, 0) + reach(1, 0) + 0.25, h: reach(0, -1) + reach(0, 1) + 0.25, drawnH: r.height };
    }, [selector, index] as const);
  /** Drag the Graph's canvas with a finger until `selector`'s right edge is 90px inside the pane. */
  const dragIntoView = async ({ page: p, context }: { page: Page; context: BrowserContext }, selector: string) => {
    const at = (await p.locator(selector).boundingBox())!;
    const pane = (await p.locator(".react-flow__pane").boundingBox())!;
    const y = pane.y + 50;
    const from = pane.x + pane.width - 20;
    const shift = at.x + at.width - (pane.x + pane.width - 90);
    if (shift <= 0) return;
    const cdp = await context.newCDPSession(p);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
    for (let step = 1; step <= 10; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from - (shift * step) / 10, y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(p, 300);
  };
  const atLeast44 = async (p: Page, selector: string, index = 0) => {
    const t = await target(p, selector, index);
    expect(t, selector).not.toBeNull();
    expect(Math.min(t!.w, t!.h), `${selector} ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(43.75);
    return t!;
  };

  it("the views' small controls are 44px targets on a phone, and keep their drawn size", async () => {
    const queue = await page("/?ws=alpha&view=queue");
    expect((await atLeast44(queue.page, "[data-queue-next-open]")).drawnH).toBeLessThan(30);
    await queue.context.close();

    const tasks = await page("/?ws=beta&view=tasks");
    await settle(tasks.page, 400);
    const phoneBadges = await count(tasks.page, ".staple-dep-badge");
    expect(phoneBadges).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < phoneBadges; index++) expect((await atLeast44(tasks.page, ".staple-dep-badge", index)).drawnH).toBe(20);
    await tasks.context.close();

    const graph = await page("/?ws=beta&view=graph");
    await settle(graph.page, 600);
    for (const control of ["Zoom In", "Zoom Out", "Fit View"]) await atLeast44(graph.page, `.react-flow__controls-button[aria-label="${control}"]`);
    // The epic's box is wider than a phone and its chevron sits at the right end.
    await dragIntoView(graph, '[aria-label="collapse BET-5"]');
    expect((await atLeast44(graph.page, '[aria-label="collapse BET-5"]')).drawnH).toBeLessThan(20);
    await graph.page.locator('[aria-label="collapse BET-5"]').tap();
    await settle(graph.page, 600);
    expect((await atLeast44(graph.page, '[aria-label="expand BET-5"]')).drawnH).toBeLessThan(20);
    await graph.context.close();

    const estimates = await page("/?ws=alpha&view=estimate-accuracy");
    await atLeast44(estimates.page, '[data-testid="include-reconstructed"]');
    await estimates.context.close();

    const usage = await page("/?view=budget");
    expect((await atLeast44(usage.page, '[data-testid="budget-refresh"]')).drawnH).toBeLessThan(30);
    await usage.context.close();

    // A switch in Settings (This machine): the line it sits on is the target.
    const machine = await page("/?view=tasks&settings=machine");
    await settle(machine.page, 600);
    await atLeast44(machine.page, '[data-settings-content] input[role="switch"]');
    await machine.context.close();

    // A desk with a mouse keeps every one of them at its drawn size.
    const heights = async (path: string, selectors: string[]) => {
      const { page: d, context } = await page(path, DESK);
      await settle(d, 400);
      const out = await d.evaluate((list) => list.map((sel) => Math.round(document.querySelector(sel)!.getBoundingClientRect().height)), selectors);
      await context.close();
      return out;
    };
    expect(await heights("/?ws=alpha&view=queue", ["[data-queue-next-open]", 'button[aria-label="Hide navigation"]', '[data-workspace-switcher="rail"]'])).toEqual([24, 28, 28]);
    expect(await heights("/?view=budget", ['[data-testid="budget-refresh"]'])).toEqual([24]);
    expect((await heights("/?ws=alpha&view=estimate-accuracy", ["[data-include-reconstructed-label]"]))[0]).toBeLessThanOrEqual(24);
  }, 60_000);

  it("a tablet's desk layout under a finger: the rail's controls and the rows' small controls are 44px targets", async () => {
    const { page: p, context } = await page("/?ws=beta&view=tasks", TABLET);
    await settle(p, 400);
    for (const control of [
      'button[aria-label="Hide navigation"]',
      'button[aria-label="Open the command palette"]',
      '[data-workspace-switcher="rail"]',
      '[data-nav-action="new-project"]',
    ]) {
      await atLeast44(p, control);
    }
    await atLeast44(p, 'button[aria-label="Actions for BET-2"]');
    // The disclosure keeps its drawn 16px and a 44px target — expanded as well as collapsed
    // (the button used to rotate, turning a 16×44 box into a 44×16 one).
    const chevron = '.staple-row-chevron[aria-label$="BET-5"]';
    expect((await atLeast44(p, chevron)).drawnH).toBe(16);
    await p.locator(chevron).tap();
    await settle(p, 400);
    expect((await atLeast44(p, chevron)).drawnH).toBe(16);
    if ((await p.locator(chevron).getAttribute("data-expanded")) !== "true") {
      await p.locator(chevron).tap();
      await settle(p, 400);
    }
    // Every badge, the two side by side on BET-6's row included.
    expect(await count(p, '.staple-row:has([aria-label="Actions for BET-6"]) .staple-dep-badge')).toBe(2);
    const badges = await count(p, ".staple-dep-badge");
    for (let index = 0; index < badges; index++) expect((await atLeast44(p, ".staple-dep-badge", index)).drawnH).toBe(20);
    await context.close();

    // The Graph frames a tablet at zoom 1, where its handles are drawn smallest.
    const graph = await page("/?ws=beta&view=graph", TABLET);
    await settle(graph.page, 800);
    await dragIntoView(graph, '[aria-label="collapse BET-5"]');
    expect((await atLeast44(graph.page, '[aria-label="collapse BET-5"]')).drawnH).toBeLessThan(20);
    await graph.page.locator('[aria-label="collapse BET-5"]').tap();
    await settle(graph.page, 600);
    expect((await atLeast44(graph.page, '[aria-label="expand BET-5"]')).drawnH).toBeLessThan(20);
    await graph.context.close();
  }, 30_000);

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
        sideways: Array.from(document.querySelectorAll("body *")).filter((e) => e.scrollLeft !== 0).length,
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
    // Reopened on a workspace, the list starts on that workspace.
    await p.locator('[data-workspace-switcher="rail"]').focus();
    await p.keyboard.press("Enter");
    await settle(p, 300);
    expect(await selected()).toBe("alpha");
    await p.keyboard.press("Escape");
    await settle(p, 300);
    expect(await count(p, "[data-workspace-popover]")).toBe(0);
    await context.close();
  }, 30_000);

  it("a Graph the filters emptied says so in the words the task list uses, with the fixes beside it", async () => {
    const { page: p, context } = await page("/?ws=beta&view=graph");
    await settle(p, 500);
    await tap(p, '[data-filter-preset="high-priority"]');
    await settle(p, 600);
    expect(await count(p, "[data-filter-empty-explained]")).toBe(1);
    expect(await p.locator("[data-filter-empty]").innerText()).toContain("No dependencies match these filters");
    expect(await count(p, "[data-filter-explanation-clear]")).toBe(1);
    await context.close();
  }, 30_000);

  it("the quick filters and the Filter button appear only where they narrow something", async () => {
    for (const [view, expected] of [
      ["tasks", true],
      ["graph", true],
      ["queue", false],
      ["milestones", false],
      ["estimate-accuracy", false],
      ["budget", false],
    ] as const) {
      const { page: p, context } = await page(`/?ws=alpha&view=${view}`);
      expect(await count(p, "[data-filter-chips]"), view).toBe(expected ? 1 : 0);
      expect(await count(p, "[data-filter-add]"), view).toBe(expected ? 1 : 0);
      await context.close();
    }
  }, 60_000);

  it("a phone edits statuses as cards: a wide label, 44px controls, nothing off the side", async () => {
    const { page: p, context } = await page("/?view=tasks&settings=statuses&settings-ws=alpha");
    await settle(p, 600);
    const m = await p.evaluate(() => {
      const pane = document.querySelector("[data-settings-content]")!;
      const box = (s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
      };
      return {
        layout: document.querySelector("[data-vocabulary-layout]")?.getAttribute("data-vocabulary-layout"),
        label: box('input[aria-label="Label for todo"]'),
        category: box('[aria-label="Category for todo"]'),
        more: box('[aria-label="More for To do"], [aria-label^="More for"]'),
        overflow: pane.scrollWidth - pane.clientWidth,
      };
    });
    expect(m.layout).toBe("cards");
    expect(m.label.w).toBeGreaterThanOrEqual(200);
    expect(m.label.h).toBeGreaterThanOrEqual(44);
    expect(m.category.h).toBeGreaterThanOrEqual(44);
    expect(Math.min(m.more.w, m.more.h)).toBeGreaterThanOrEqual(44);
    expect(m.more.right).toBeLessThanOrEqual(390);
    expect(m.overflow).toBeLessThanOrEqual(1);
    await context.close();
  }, 30_000);

  it("All workspaces never asks for one workspace's settings without naming it", async () => {
    const context = await browser.newContext(DESK);
    const p = await context.newPage();
    const reads: string[] = [];
    p.on("request", (request) => {
      if (request.url().includes("/api/settings")) reads.push(request.url());
    });
    await p.goto(`${origin}/?view=tasks&token=${token}`, { waitUntil: "networkidle" });
    await settle(p, 500);
    expect(reads.length).toBeGreaterThan(0);
    for (const url of reads) expect(new URL(url).searchParams.get("ws"), url).toBeTruthy();
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
