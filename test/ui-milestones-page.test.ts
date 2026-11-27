/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * THE MILESTONES PAGE, WIRED — in a real browser, against the real server and the built app.
 *
 * The string renders in `src/ui/app/src/views/milestones/*.test.tsx` pin what the outline
 * DRAWS; none of them can press anything, so a row whose click opened nothing, an Enter that
 * did nothing, a Done toggle the work list ignored, a date field that never wrote, a fold that
 * was never remembered, or a write aimed at the wrong route all passed them. This suite presses
 * the real controls and reads the store back:
 *
 *   - a member row opens its task on a click and on Enter or Space;
 *   - the header's Done toggle hides finished rows; finished milestones stay on the shelf;
 *   - a milestone whose members are all finished says so, with Show done, not "nothing in it";
 *   - the calendar sets the milestone's own target through the store, signed by the person,
 *     and clearing it falls back to the estimate; the `⋯` menu's Change due date opens it too;
 *   - approving from the page lands the gate as approved, signed by the person;
 *   - reorder (buttons, menu, alt+arrow), add and remove, and the queue write, land in the store;
 *   - a fold, Collapse all and Expand all survive a reload; a phone starts folded;
 *   - a `focus=` link lands on its section, a finished one on its line, a missing one says so;
 *   - every control keeps its look on a phone, with a tap of at least 32px;
 *   - All workspaces: each workspace's milestones read-only, whatever the Done toggle says; a
 *     header (click, Enter, Space) or a finished line switches workspace and lands on it.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle (`npm run build:ui`; the gate order
 * builds first) or no Chromium for `playwright-core` on this machine, as ui-phone-back is.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { MilestoneCreateResult } from "../src/core/milestone-store.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { initWorkspace } from "../src/core/workspace.js";
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
if (reason) console.warn(`ui-milestones-page: skipped — ${reason}`);
/**
 * In CI this suite MUST run: CI installs Chromium for playwright-core (.github/workflows/ci.yml),
 * and a skip there would pass the gate having pressed nothing. Locally a missing browser skips.
 */
if (reason && process.env.CI) {
  describe("ui-milestones-page: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-milestones-page cannot run in CI: ${reason}.`);
    });
  });
}

const WS = "alpha";
/** The person this browser says it is (`staple:me`, detail/parts/person.ts). */
const PERSON = "Vera";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let browser: Browser;
const refs: Record<string, string> = {};

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-milestones-page-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const { store } = initWorkspace({ global: true, slug: WS });
  try {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, null);
    // An open milestone: an epic with an open task (estimated), a cancelled one and a done one.
    const epic = store.createIssue({ title: "Release work", kind: "epic" });
    const open = store.createIssue({ title: "Write the notes", parent: epic.id, estimatedSeconds: 7200 });
    const cancelled = store.createIssue({ title: "Old approach", parent: epic.id });
    const done = store.createIssue({ title: "Cut the branch", parent: epic.id });
    store.updateIssue(cancelled.id, { status: "cancelled" }, "w");
    store.updateIssue(done.id, { status: "done" }, "w");
    const plan = store.milestones().create({ title: "October cut" }, null) as MilestoneCreateResult;
    store.milestones().addMember(plan.milestone.id, epic.id, {}, null);
    // A finished milestone, which Done hidden leaves out of the list.
    const shipped = store.createIssue({ title: "Shipped thing" });
    store.updateIssue(shipped.id, { status: "done" }, "w");
    const finished = store.milestones().create({ title: "September cut" }, null) as MilestoneCreateResult;
    store.milestones().addMember(finished.milestone.id, shipped.id, {}, null);
    store.updateIssue(finished.milestone.id, { status: "done" }, "w");
    // A milestone whose members are all done, gated for a person: what a goal run leaves.
    const a = store.createIssue({ title: "Landed A" });
    const b = store.createIssue({ title: "Landed B" });
    for (const issue of [a, b]) store.updateIssue(issue.id, { status: "done" }, "w");
    const gated = store.milestones().create({ title: "Review me" }, null) as MilestoneCreateResult;
    for (const issue of [a, b]) store.milestones().addMember(gated.milestone.id, issue.id, {}, null);
    store.gateIssue(gated.milestone.id, { owner: PERSON }, "autopilot");
    // A gated milestone whose work is still going: nothing queued (membership queues nothing),
    // two tasks open — approving lifts the hold and the milestone follows its work.
    const going = store.milestones().create({ title: "Still going" }, null) as MilestoneCreateResult;
    const busy = store.createIssue({ title: "In hand" });
    store.checkoutIssue(busy.id, "w", undefined, {});
    const waiting = store.createIssue({ title: "Next up" });
    for (const issue of [busy, waiting]) store.milestones().addMember(going.milestone.id, issue.id, {}, null);
    store.gateIssue(going.milestone.id, { owner: PERSON }, "autopilot");
    // A done epic with an open child: the child is lifted into its place, wearing its chip.
    const doneEpic = store.createIssue({ title: "Shipped epic", kind: "epic" });
    const late = store.createIssue({ title: "Late child", parent: doneEpic.id });
    store.updateIssue(doneEpic.id, { status: "done" }, "w");
    const carried = store.milestones().create({ title: "Carried" }, null) as MilestoneCreateResult;
    store.milestones().addMember(carried.milestone.id, doneEpic.id, {}, null);
    // Two open tasks to reorder, add to and remove from.
    const order = store.milestones().create({ title: "Reorder me" }, null) as MilestoneCreateResult;
    const first = store.createIssue({ title: "First thing" });
    const second = store.createIssue({ title: "Second thing" });
    const spare = store.createIssue({ title: "Spare thing" });
    for (const issue of [first, second]) store.milestones().addMember(order.milestone.id, issue.id, {}, null);
    Object.assign(refs, {
      order: order.milestone.identifier,
      first: first.identifier,
      second: second.identifier,
      spare: spare.identifier,
      going: going.milestone.identifier,
      carried: carried.milestone.identifier,
      late: late.identifier,
      epic: epic.identifier,
      open: open.identifier,
      cancelled: cancelled.identifier,
      done: done.identifier,
      plan: plan.milestone.identifier,
      finished: finished.milestone.identifier,
      gated: gated.milestone.identifier,
    });
  } finally {
    store.db.close();
  }
  // A second workspace that uses milestones and has none yet.
  const empty = initWorkspace({ global: true, slug: "beta" }).store;
  try {
    empty.addKind({ id: MILESTONE_KIND, label: "Milestone" }, null);
  } finally {
    empty.db.close();
  }
  // A workspace whose milestones are all finished, and one without the milestone kind.
  const past = initWorkspace({ global: true, slug: "gamma" }).store;
  try {
    past.addKind({ id: MILESTONE_KIND, label: "Milestone" }, null);
    const old = past.milestones().create({ title: "Summer cut" }, null) as MilestoneCreateResult;
    past.updateIssue(old.milestone.id, { status: "done" }, "w");
    refs.summer = old.milestone.identifier;
  } finally {
    past.db.close();
  }
  initWorkspace({ global: true, slug: "bare" }).store.db.close();
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

async function open(focus: string, ws = WS, viewport = { width: 1440, height: 900 }, touch = false): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  // Who this browser is: the name every detail write is signed with.
  await context.addInitScript((name) => localStorage.setItem("staple:me", name), PERSON);
  const page = await context.newPage();
  await page.goto(`${origin}/?ws=${ws}&view=milestones${focus ? `&focus=${focus}` : ""}&token=${token}`, { waitUntil: "networkidle" });
  if (focus) await page.waitForSelector(`[data-milestone-section="${focus}"]`);
  await page.waitForTimeout(300);
  return { page, context };
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

/** Who the store recorded as making the newest event of this type, read from the workspace's own file. */
function lastEventActor(type: string): string | null {
  const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`), { readOnly: true });
  try {
    const row = db.prepare("SELECT actor FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1").get(type) as { actor: string | null } | undefined;
    return row?.actor ?? null;
  } finally {
    db.close();
  }
}

/** A milestone's section. */
const section = (page: Page, ref: string) => page.locator(`[data-milestone-section="${ref}"]`);

/** Unfold a member epic, which starts as one line. */
async function unfoldEpic(page: Page, ref: string, epic: string): Promise<void> {
  await section(page, ref).locator(`[aria-label="Expand ${epic}"]`).click();
  await page.waitForTimeout(200);
}

/** Members of a section, in the order drawn. */
const membersOf = (page: Page, ref: string) => section(page, ref).locator("[data-member-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-member-row")));

/** The task the detail drawer has open, or null. */
const openedTask = async (page: Page): Promise<string | null> => {
  await page.waitForTimeout(500);
  return page.evaluate(() => document.querySelector("[data-detail-identifier]")?.textContent?.trim() ?? null);
};

describe.skipIf(Boolean(reason))("the Milestones page, pressed in a real browser", () => {
  it("opens a member's task on a click anywhere on its row", async () => {
    const { page, context } = await open(refs.plan!);
    await unfoldEpic(page, refs.plan!, refs.epic!);
    await page.locator(`[data-member-row="${refs.open}"] .staple-row-title`).click();
    expect(await openedTask(page)).toBe(refs.open);
    await context.close();
  });

  it("draws a visible focus ring on the row the keyboard is on", async () => {
    const { page, context } = await open(refs.plan!);
    const row = page.locator(`[data-member-row="${refs.epic}"]`);
    await page.keyboard.press("Tab"); // keyboard modality, so :focus-visible applies
    await row.focus();
    const ring = await row.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, visible: element.matches(":focus-visible") };
    });
    expect(ring.visible).toBe(true);
    expect(ring.style).toBe("solid");
    expect(ring.width).toBe("2px");
    expect(ring.color).not.toBe("rgba(0, 0, 0, 0)");
    await context.close();
  });

  it("opens it on Enter and on Space while the row has the focus", async () => {
    for (const key of ["Enter", " "]) {
      const { page, context } = await open(refs.plan!);
      await page.locator(`[data-member-row="${refs.epic}"]`).focus();
      await page.keyboard.press(key === " " ? "Space" : key);
      expect(await openedTask(page), key).toBe(refs.epic);
      await context.close();
    }
  });

  it("starts each member as one line, and the chevron and the right arrow unfold an epic", async () => {
    const { page, context } = await open(refs.plan!);
    expect(await membersOf(page, refs.plan!)).toEqual([refs.epic]);
    await page.locator(`[data-member-row="${refs.epic}"]`).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    expect(await membersOf(page, refs.plan!)).toEqual([refs.epic, refs.open]);
    await context.close();
  });

  it("hides finished rows while Done is hidden and shows them on the toggle; finished milestones stay on the shelf", async () => {
    const { page, context } = await open(refs.plan!);
    await unfoldEpic(page, refs.plan!, refs.epic!);
    expect(await membersOf(page, refs.plan!)).toEqual([refs.epic, refs.open]);
    expect(await section(page, refs.plan!).locator("[data-hidden-done]").getAttribute("data-hidden-done")).toBe("2");
    const shelf = () => page.locator("[data-milestones-shelf]").innerText();
    expect(await shelf()).toMatch(/Finished\s+1\b/);
    await section(page, refs.plan!).locator("[data-show-done]").click();
    await page.waitForTimeout(600);
    expect(await membersOf(page, refs.plan!)).toEqual(expect.arrayContaining([refs.epic, refs.open, refs.cancelled, refs.done]));
    // The shelf does not follow the toggle.
    expect(await shelf()).toMatch(/Finished\s+1\b/);
    await context.close();
  });

  it("says a milestone whose members are all finished is finished, and offers them, instead of 'nothing in it'", async () => {
    const { page, context } = await open(refs.gated!);
    const notice = section(page, refs.gated!).locator("[data-hidden-all]");
    expect(await notice.innerText()).toContain("2 finished items hidden");
    expect(await section(page, refs.gated!).getByText("Nothing is in this milestone yet").count()).toBe(0);
    await notice.locator("[data-show-done]").click();
    await page.waitForTimeout(600);
    expect(await section(page, refs.gated!).locator("[data-member-row]").count()).toBe(2);
    await context.close();
  });

  it("sets the milestone's own target from the calendar, signed by the person, and clears it back", async () => {
    const { page, context } = await open(refs.plan!);
    const target = section(page, refs.plan!).locator("[data-milestone-target]").first();
    // No finished work to calibrate against yet, so the forecast cannot weigh the open task:
    // no projection, and the page says so rather than guessing.
    const before = await target.getAttribute("data-due-source");
    expect(before).toBe("none");
    await section(page, refs.plan!).locator("[data-milestone-due-button]").click();
    await page.locator('[data-milestone-due-picker] input[type="date"]').fill("2030-01-15");
    await page.locator("[data-milestone-due-save]").click();
    await page.waitForTimeout(800);
    const set = await get<{ milestone: { targetDate: string | null } }>(`/api/milestone?ws=${WS}&ref=${refs.plan}`);
    expect(set.milestone.targetDate).toBe("2030-01-15");
    expect(await target.getAttribute("data-due-source")).toBe("target");
    expect(lastEventActor("milestone_updated")).toBe(PERSON);

    // The `⋯` menu's Change due date opens the same field.
    await section(page, refs.plan!).locator("[data-milestone-menu]").click();
    await page.locator('[role=menu] [data-menu-item="due"]').click();
    await page.waitForTimeout(400);
    expect(await page.locator("[data-milestone-due-picker]").isVisible()).toBe(true);
    await page.locator("[data-milestone-due-clear]").click();
    await page.waitForTimeout(800);
    const cleared = await get<{ milestone: { targetDate: string | null } }>(`/api/milestone?ws=${WS}&ref=${refs.plan}`);
    expect(cleared.milestone.targetDate).toBeNull();
    expect(await target.getAttribute("data-due-source")).toBe(before);
    await context.close();
  });

  it("sets the due date of a folded section, which has read nothing, from the calendar and from the menu", async () => {
    const { page, context } = await open("");
    await section(page, refs.plan!).locator("[data-milestone-fold]").click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    expect(await section(page, refs.plan!).getAttribute("data-milestone-folded")).toBe("");
    const written: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/milestone/update")) written.push(String(JSON.parse(request.postData() ?? "{}").ref));
    });
    const targetOf = async () => (await get<{ milestone: { id: string; targetDate: string | null } }>(`/api/milestone?ws=${WS}&ref=${refs.plan}`)).milestone;
    await section(page, refs.plan!).locator("[data-milestone-due-button]").click();
    await page.locator('[data-milestone-due-picker] input[type="date"]').fill("2030-02-20");
    await page.locator("[data-milestone-due-save]").click();
    await page.waitForTimeout(800);
    expect((await targetOf()).targetDate).toBe("2030-02-20");
    expect(await page.locator("[data-milestone-due-picker]").count()).toBe(0);
    // The menu's Change due date, still folded: the reads its menu started have not landed yet.
    await section(page, refs.plan!).locator("[data-milestone-menu]").click();
    await page.locator('[role=menu] [data-menu-item="due"]').click();
    await page.locator('[data-milestone-due-picker] input[type="date"]').fill("2030-03-21");
    await page.locator("[data-milestone-due-save]").click();
    await page.waitForTimeout(800);
    const after = await targetOf();
    expect(after.targetDate).toBe("2030-03-21");
    // Every write named the milestone; none went out with an empty reference.
    expect(written).toEqual([after.id, after.id]);
    await page.locator("[data-milestone-due-button]").first().waitFor();
    await section(page, refs.plan!).locator("[data-milestone-due-button]").click();
    await page.locator("[data-milestone-due-clear]").click();
    await page.waitForTimeout(800);
    expect((await targetOf()).targetDate).toBeNull();
    await context.close();
  });

  it("asks the server nothing for a folded section, also one read before, and two reads when it is unfolded", async () => {
    const { page, context } = await open("");
    /** The one-milestone reads, by the reference each names. */
    const reads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/milestone" || url.pathname === "/api/issue") reads.push(`${url.pathname} ${url.searchParams.get("ref")}`);
    });
    // The page refreshes everything it reads after any of its writes: here the queue's, which is
    // not one of the section's own. Queue a milestone, then take it off again.
    const refresh = async (item: "queue" | "dequeue") => {
      const listed = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/milestones", { timeout: 6000 });
      if (item === "queue") await section(page, refs.carried!).locator("[data-milestone-queue]").click();
      else {
        await section(page, refs.carried!).locator("[data-milestone-menu]").click();
        await page.locator('[role=menu] [data-menu-item="dequeue"]').click();
      }
      await listed;
      await page.waitForTimeout(800);
    };
    // A milestone waiting for approval reads while folded: its gate is shown.
    const rows = await get<Array<{ milestone: { identifier: string; status: string; state: string } }>>(`/api/milestones?ws=${WS}`);
    const waiting = new Set(rows.filter((row) => row.milestone.status === "awaiting_approval").map((row) => row.milestone.identifier));
    const others = () => reads.filter((read) => !waiting.has(read.split(" ")[1]!));
    // Read once, then folded again; then every section folded.
    expect(await section(page, refs.plan!).getAttribute("data-milestone-folded")).toBeNull();
    await section(page, refs.plan!).locator("[data-milestone-fold]").click();
    await page.locator('[data-milestones-fold-all="collapse"]').click();
    await page.waitForTimeout(300);
    reads.length = 0;
    await refresh("queue");
    expect(others()).toEqual([]);
    // Unfolding one reads that one milestone, once each.
    await section(page, refs.order!).locator("[data-milestone-fold]").click();
    await page.waitForTimeout(800);
    expect(others().sort()).toEqual([`/api/issue ${refs.order}`, `/api/milestone ${refs.order}`]);
    // Its menu reads it while open (the menu's Status needs it); the others stay quiet.
    reads.length = 0;
    await refresh("dequeue");
    expect(others().filter((read) => !read.endsWith(` ${refs.order}`) && !read.endsWith(` ${refs.carried}`))).toEqual([]);
    await context.close();
  });

  it("finishes a write the section was folded during, and shows its failure when it is unfolded", async () => {
    const { page, context } = await open(refs.order!);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let sent = 0;
    await page.route("**/api/milestone/reorder", async (route) => {
      sent++;
      await held;
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Refused while folded.", message: "Refused while folded.", code: "validation", retryable: false }) });
    });
    const it_ = section(page, refs.order!);
    await it_.locator(`[data-member-actions="${refs.first}"]`).click();
    await page.locator('[role=menu] [data-menu-item="down"]').click();
    await it_.locator("[data-milestone-fold]").click();
    expect(await it_.getAttribute("data-milestone-folded")).toBe("");
    release();
    await page.waitForTimeout(800);
    expect(sent).toBe(1);
    await it_.locator("[data-milestone-fold]").click();
    await page.waitForTimeout(800);
    expect(await it_.locator("[data-guard-refusal]").innerText({ timeout: 3000 })).toContain("Refused while folded.");
    await context.close();
  });

  it("approves the milestone's gate from the page, signed by the person, and the status follows", async () => {
    const { page, context } = await open(refs.gated!);
    const gated = section(page, refs.gated!);
    // The status is in the `⋯` menu, the detail's own item.
    await gated.locator("[data-milestone-menu]").click();
    expect(await page.locator("[role=menu] [data-status-menu]").getAttribute("data-status-category")).toBe("gated");
    await page.keyboard.press("Escape");
    page.on("dialog", (dialog) => void dialog.accept(PERSON));
    // Everything under it is finished, so the button says approving closes it.
    expect(await gated.locator("[data-milestone-gate]").innerText()).toContain("All work here is finished.");
    await gated.getByRole("button", { name: "Approve and close milestone" }).click();
    await page.waitForTimeout(1200);
    const detail = await get<{ issue: { status: string }; gate: { state: string; resolvedBy: string | null } | null }>(`/api/issue?ws=${WS}&ref=${refs.gated}`);
    expect(detail.gate).toMatchObject({ state: "approved", resolvedBy: PERSON });
    // Everything had landed, so approving closed it, as the button said.
    expect(detail.issue.status).toBe("done");
    expect(lastEventActor("gate_approved")).toBe(PERSON);
    // Closed, it moves to the Finished shelf.
    expect(await page.locator(`[data-milestone-finished-line="${refs.gated}"]`).count()).toBe(1);
    await context.close();
  });

  it("lands a link to a finished milestone on its line on the opened shelf, even while Done is hidden", async () => {
    const { page, context } = await open(refs.finished!);
    expect(await page.locator("[data-milestones-shelf]").getAttribute("aria-expanded")).toBe("true");
    const line = page.locator(`[data-milestone-finished-line="${refs.finished}"]`);
    expect(await line.count()).toBe(1);
    // Its goal and work, read-only, open under it.
    expect(await line.locator("[data-milestone-goal-line]").count()).toBe(1);
    expect(await line.locator("[data-milestone-add-open]").count()).toBe(0);
    await context.close();
  });

  it("lands a link to an open milestone at the top of the page, unfolded for the visit and marked for a moment", async () => {
    const { page, context } = await open(refs.carried!, WS, { width: 390, height: 844 });
    const landed = section(page, refs.carried!);
    // A phone starts folded, but the link unfolds the one it names.
    expect(await landed.getAttribute("data-milestone-folded")).toBeNull();
    // At the top of the scroller, or as near as the page's length lets it come.
    const where = await page.evaluate((ref) => {
      const outline = document.querySelector<HTMLElement>("[data-milestones-outline]")!;
      const top = document.querySelector(`[data-milestone-section="${ref}"]`)!.getBoundingClientRect().top - outline.getBoundingClientRect().top;
      return { top, scrolled: outline.scrollTop, bottom: outline.scrollTop >= outline.scrollHeight - outline.clientHeight - 1 };
    }, refs.carried!);
    expect(where.scrolled).toBeGreaterThan(0);
    expect(Math.abs(where.top) < 2 || where.bottom, JSON.stringify(where)).toBe(true);
    expect(await landed.getAttribute("data-milestone-landed")).toBe("");
    await page.waitForTimeout(1800);
    expect(await landed.getAttribute("data-milestone-landed")).toBeNull();
    // For the visit only: a reload without the link starts it folded again.
    await page.goto(`${origin}/?ws=${WS}&view=milestones&token=${token}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    expect(await section(page, refs.carried!).getAttribute("data-milestone-folded")).toBe("");
    await context.close();
  });

  it("says a link to a milestone the list does not carry is not in it, and offers to open it", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${origin}/?ws=${WS}&view=milestones&focus=${refs.open}&token=${token}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const missing = page.locator(`[data-milestone-missing="${refs.open}"]`);
    expect(await missing.innerText()).toContain(`${refs.open} is not in this list.`);
    await missing.getByRole("button", { name: "Open it" }).click();
    expect(await openedTask(page)).toBe(refs.open);
    await context.close();
  });

  it("remembers a fold, Collapse all and Expand all across a reload, and starts a phone folded", async () => {
    const { page, context } = await open("");
    const folded = () => page.locator("[data-milestone-section][data-milestone-folded]").count();
    const open_ = () => page.locator("[data-milestones-content] > [data-milestone-section]").count();
    expect(await folded()).toBe(0);
    await section(page, refs.plan!).locator("[data-milestone-fold]").click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    expect(await section(page, refs.plan!).getAttribute("data-milestone-folded")).toBe("");
    expect(await folded()).toBe(1);
    await page.locator('[data-milestones-fold-all="collapse"]').click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    expect(await folded()).toBe(await open_());
    await page.locator('[data-milestones-fold-all="expand"]').click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    expect(await folded()).toBe(0);
    await context.close();

    const phone = await open("", WS, { width: 390, height: 844 });
    expect(await phone.page.locator("[data-milestones-content] > [data-milestone-section]:not([data-milestone-folded])").count()).toBe(0);
    // The fold control sits beside the page name, as an icon labelled for a screen reader.
    expect(await phone.page.locator("[data-phone-header-slot] [data-milestones-fold-all]").getAttribute("aria-label")).toBe("Expand all");
    await phone.context.close();
  });

  it("reorders with the buttons, the menu and alt+arrow, adds and removes, and every write lands in the store", async () => {
    const { page, context } = await open(refs.order!);
    const order = async () => (await get<{ members: Array<{ identifier: string }> }>(`/api/milestone?ws=${WS}&ref=${refs.order}`)).members.map((m) => m.identifier);
    const it_ = section(page, refs.order!);
    expect(await order()).toEqual([refs.first, refs.second]);
    // alt+arrow on the row.
    await it_.locator(`[data-member-row="${refs.first}"]`).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await page.waitForTimeout(800);
    expect(await order()).toEqual([refs.second, refs.first]);
    // The hover button.
    await it_.locator(`[data-member-row="${refs.first}"]`).hover();
    await it_.getByRole("button", { name: `Move ${refs.first} up` }).click();
    await page.waitForTimeout(800);
    expect(await order()).toEqual([refs.first, refs.second]);
    // The row's menu.
    await it_.locator(`[data-member-actions="${refs.first}"]`).click();
    await page.locator('[role=menu] [data-menu-item="down"]').click();
    await page.waitForTimeout(800);
    expect(await order()).toEqual([refs.second, refs.first]);
    // Add work, then remove it.
    await it_.locator("[data-milestone-add-open]").click();
    await it_.locator('[aria-label="Identifier to add"]').fill(refs.spare!);
    await it_.locator("[data-milestone-add] button[type=submit]").click();
    await page.waitForTimeout(800);
    expect(await order()).toEqual([refs.second, refs.first, refs.spare]);
    expect(lastEventActor("milestone_member_added")).toBe(PERSON);
    await it_.locator(`[data-member-actions="${refs.spare}"]`).click();
    await page.locator('[role=menu] [data-menu-item="remove"]').click();
    await page.waitForTimeout(800);
    expect(await order()).toEqual([refs.second, refs.first]);
    await context.close();
  });

  it("queues the milestone from its header and takes it off from its menu", async () => {
    const { page, context } = await open(refs.order!);
    const queued = async () => (await get<{ entries: Array<{ identifier: string }> }>(`/api/queue?ws=${WS}`)).entries.map((e) => e.identifier);
    expect(await queued()).not.toContain(refs.order);
    await section(page, refs.order!).locator("[data-milestone-queue]").click();
    await page.waitForTimeout(900);
    expect(await queued()).toContain(refs.order);
    expect(await section(page, refs.order!).locator("[data-milestone-queued]").count()).toBe(1);
    await section(page, refs.order!).locator("[data-milestone-menu]").click();
    await page.locator('[role=menu] [data-menu-item="dequeue"]').click();
    await page.waitForTimeout(900);
    expect(await queued()).not.toContain(refs.order);
    await context.close();
  });

  it("offers a new milestone with the Milestone kind chosen when a workspace has none yet", async () => {
    const { page, context } = await open("", "beta");
    await page.locator("[data-create-milestone]").click();
    await page.waitForSelector("[data-create-kind]");
    expect(await page.locator("[data-create-kind]").innerText()).toContain("Milestone");
    await context.close();
  });

  it("keeps every control's look on a phone, with a tap of at least 32px and no 44px box", async () => {
    // A finger: the base layer's touch floor applies unless a control lifts it.
    const { page, context } = await open(refs.carried!, WS, { width: 390, height: 844 }, true);
    /** The drawn box's height and the tap's: the larger of the box and its invisible `::before`. */
    const measure = (selector: string) =>
      page.locator(selector).first().evaluate((element) => {
        const box = element.getBoundingClientRect();
        const before = getComputedStyle(element, "::before");
        const tap = before.content !== "none" && before.position === "absolute" ? Math.max(box.height, parseFloat(before.height)) : box.height;
        return { drawn: box.height, tap: Math.max(tap, box.height) };
      });
    const carried = `[data-milestone-section="${refs.carried}"]`;
    for (const [selector, drawn] of [
      [`${carried} [data-milestone-fold]`, 20],
      [`${carried} [data-milestone-menu]`, 28],
      // The lifted row's own control: the hidden member's `⋯` it carries.
      [`[data-milestone-member="${refs.late}"] [data-member-actions]`, 28],
      [`${carried} [data-milestone-add-open]`, 28],
      [`${carried} [data-show-done]`, 28],
      ["[data-add-milestone-row]", 32],
      ["[data-phone-header-slot] [data-milestones-fold-all]", 32],
    ] as const) {
      const { drawn: height, tap } = await measure(selector);
      expect(height, selector).toBeCloseTo(drawn, 0);
      expect(tap, selector).toBeGreaterThanOrEqual(32);
    }
    await page.locator(`${carried} [data-milestone-add-open]`).click();
    for (const selector of [`${carried} [data-milestone-add] button[type=submit]`, `${carried} [aria-label="Identifier to add"]`]) {
      const { drawn, tap } = await measure(selector);
      expect(drawn, selector).toBeLessThanOrEqual(32);
      expect(tap, selector).toBeGreaterThanOrEqual(28);
    }
    // The lifted child's parent chip is the Tasks list's own: it keeps its drawn size and grows a 44px target.
    const chip = page.locator(`[data-member-row="${refs.late}"] .staple-row-breadcrumb`);
    const target = await chip.evaluate((element) => parseFloat(getComputedStyle(element, "::before").height));
    expect(target).toBeGreaterThanOrEqual(44);
    await context.close();
  });

  it("says approving a gated milestone with open work continues it, and it does not close", async () => {
    const { page, context } = await open(refs.going!);
    const going = section(page, refs.going!);
    const block = going.locator("[data-milestone-gate]");
    expect(await block.innerText()).toContain("2 tasks are still open. Approving lifts the hold; the milestone closes on its own when they are done.");
    expect(await going.getByRole("button", { name: "Approve and close milestone" }).count()).toBe(0);
    page.on("dialog", (dialog) => void dialog.accept(PERSON));
    await going.getByRole("button", { name: "Approve and continue" }).click();
    await page.waitForTimeout(1200);
    const detail = await get<{ issue: { status: string }; gate: { state: string } | null }>(`/api/issue?ws=${WS}&ref=${refs.going}`);
    expect(detail.gate).toMatchObject({ state: "approved" });
    // The store re-derived it from its work: open, not closed.
    expect(["done", "cancelled"]).not.toContain(detail.issue.status);
    await context.close();
  });
});

describe.skipIf(Boolean(reason))("All workspaces' Milestones, pressed in a real browser", () => {
  async function openAll(viewport = { width: 1440, height: 900 }, touch = false): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    const page = await context.newPage();
    await page.goto(`${origin}/?view=milestones&token=${token}`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-milestone-group]");
    return { page, context };
  }
  const header = (page: Page, ref: string) => page.locator(`[data-milestone-header-link="${ref}"]`);
  /** The page switched to `ws` and landed on the section `ref`, marked. */
  async function landedOn(page: Page, ws: string, ref: string): Promise<void> {
    await page.waitForSelector(`[data-milestone-section="${ref}"][data-milestone-landed]`, { timeout: 5000 });
    expect(new URL(page.url()).searchParams.get("ws")).toBe(ws);
  }

  it("lists each workspace with milestones, finished ones included under Done hidden, and leaves the others out", async () => {
    const { page, context } = await openAll();
    expect(await page.locator("[data-milestone-group]").evaluateAll((groups) => groups.map((group) => group.getAttribute("data-milestone-group")))).toEqual([WS, "gamma"]);
    // The header's Done toggle hides finished rows; it does not decide which milestones are listed.
    expect(await page.locator('[data-filter-done="hidden"]').count()).toBeGreaterThan(0);
    // The store's own count, read back: the presses above close milestones as they go.
    const states = (await get<Array<{ milestone: { state: string } }>>(`/api/milestones?ws=${WS}&all=1`)).map((row) => row.milestone.state);
    const finished = states.filter((state) => state === "done" || state === "cancelled").length;
    expect(finished).toBeGreaterThan(0);
    expect(await page.locator(`[data-milestone-group="${WS}"] [data-milestone-group-counts]`).innerText()).toBe(`${states.length - finished} open · ${finished} finished`);
    expect(await page.locator('[data-milestone-group="gamma"] [data-milestones-none-open]').innerText()).toBe("No open milestones");
    // Read-only: no control inside a header.
    expect(await page.locator("[data-milestone-header-link] button, [data-milestone-header-link] a").count()).toBe(0);
    expect(await header(page, refs.order!).getAttribute("aria-label")).toBe(`Open Reorder me in ${WS}`);
    await context.close();
  });

  it("opens a header in its workspace on a click, and lands on its section", async () => {
    const { page, context } = await openAll();
    await header(page, refs.order!).click();
    await landedOn(page, WS, refs.order!);
    await context.close();
  });

  it("opens a header from the keyboard, on Enter and on Space", async () => {
    for (const key of ["Enter", " "]) {
      const { page, context } = await openAll();
      await header(page, refs.plan!).focus();
      await page.keyboard.press(key === " " ? "Space" : key);
      await landedOn(page, WS, refs.plan!);
      await context.close();
    }
  });

  it("opens a group's Finished line for the visit, and a finished line opens it in its workspace", async () => {
    const { page, context } = await openAll();
    const shelf = page.locator('[data-milestone-group-shelf="gamma"]');
    expect(await shelf.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(`[data-milestone-finished-link="${refs.summer}"]`).count()).toBe(0);
    await shelf.click();
    expect(await shelf.getAttribute("aria-expanded")).toBe("true");
    expect(await shelf.innerText()).toMatch(/Finished\s*1\s*· hide/);
    // Per visit: a reload folds it again.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-milestone-group-shelf="gamma"]');
    expect(await page.locator('[data-milestone-group-shelf="gamma"]').getAttribute("aria-expanded")).toBe("false");
    await page.locator('[data-milestone-group-shelf="gamma"]').click();
    await page.locator(`[data-milestone-finished-link="${refs.summer}"]`).click();
    // Lands on the workspace's own shelf, opened at that milestone's line.
    await page.waitForSelector(`[data-milestone-finished-line="${refs.summer}"]`, { timeout: 5000 });
    expect(new URL(page.url()).searchParams.get("ws")).toBe("gamma");
    await context.close();
  });

  it("keeps its controls' look on a phone, with no 44px box, and its headers in the phone form", async () => {
    // A finger: the base layer's touch floor applies unless a control lifts it.
    const { page, context } = await openAll({ width: 390, height: 844 }, true);
    await page.locator(`[data-milestone-group-shelf="${WS}"]`).click();
    const drawn = (selector: string) => page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().height);
    expect(await drawn(`[data-milestone-group-shelf="${WS}"]`)).toBeCloseTo(36, 0);
    expect(await drawn(`[data-milestone-finished-link="${refs.finished}"]`)).toBeCloseTo(40, 0);
    // A header's name line is the outline's phone line: 44px, with the percent, and the due date in the facts.
    const order = header(page, refs.order!);
    expect(await order.evaluate((element) => getComputedStyle(element).minHeight)).toBe("0px");
    expect(await order.locator("> div").first().evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(44, 0);
    expect(await order.locator("[data-milestone-facts-due]").count()).toBe(1);
    await context.close();
  });

  it("says a workspace without the milestone kind is not turned on, with a 28px button and a 32px tap on a phone", async () => {
    const { page, context } = await open("", "bare", { width: 390, height: 844 }, true);
    const button = page.locator("[data-milestones-turn-on]");
    const { drawn, tap } = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const before = getComputedStyle(element, "::before");
      return { drawn: box.height, tap: before.position === "absolute" ? Math.max(box.height, parseFloat(before.height)) : box.height };
    });
    expect(drawn).toBeCloseTo(28, 0);
    expect(tap).toBeGreaterThanOrEqual(32);
    await context.close();
  });
});
