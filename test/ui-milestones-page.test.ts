/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * THE MILESTONES PAGE, WIRED — in a real browser, against the real server and the built app.
 *
 * The string renders in `src/ui/app/src/views/milestones/*.test.tsx` pin what the page DRAWS;
 * none of them can press anything, so a row whose click opened nothing, an Enter that did
 * nothing, a Done toggle the member list ignored, a date field that never wrote, or a write
 * aimed at the wrong route all passed them. This suite presses the real controls and reads the
 * store back:
 *
 *   - a member row opens its task on a click and on Enter or Space;
 *   - the header's Done toggle hides finished rows and finished milestones, and shows them;
 *   - a milestone whose members are all finished says so, with Show done, not "nothing in it";
 *   - the calendar sets the milestone's own target through the store, signed by the person,
 *     and clearing it falls back to the estimate;
 *   - approving from the page lands the gate as approved, signed by the person.
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
    Object.assign(refs, {
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

async function open(focus: string, ws = WS): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Who this browser is: the name every detail write is signed with.
  await context.addInitScript((name) => localStorage.setItem("staple:me", name), PERSON);
  const page = await context.newPage();
  await page.goto(`${origin}/?ws=${ws}&view=milestones${focus ? `&focus=${focus}` : ""}&token=${token}`, { waitUntil: "networkidle" });
  if (focus) await page.waitForSelector(`[data-milestone-detail="${focus}"]`);
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

/** The task the detail drawer has open, or null. */
const openedTask = async (page: Page): Promise<string | null> => {
  await page.waitForTimeout(500);
  return page.evaluate(() => document.querySelector("[data-detail-identifier]")?.textContent?.trim() ?? null);
};

describe.skipIf(Boolean(reason))("the Milestones page, pressed in a real browser", () => {
  it("opens a member's task on a click anywhere on its row", async () => {
    const { page, context } = await open(refs.plan!);
    await page.locator(`[data-member-row="${refs.open}"] .staple-row-title`).click();
    expect(await openedTask(page)).toBe(refs.open);
    await context.close();
  });

  it("opens it on Enter and on Space while the row has the focus", async () => {
    for (const key of ["Enter", " "]) {
      const { page, context } = await open(refs.plan!);
      await page.locator(`[data-member-row="${refs.open}"]`).focus();
      await page.keyboard.press(key === " " ? "Space" : key);
      expect(await openedTask(page), key).toBe(refs.open);
      await context.close();
    }
  });

  it("hides finished rows and finished milestones while Done is hidden, and shows them on the toggle", async () => {
    const { page, context } = await open(refs.plan!);
    const members = () => page.locator("[data-member-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-member-row")));
    expect(await members()).toEqual([refs.epic, refs.open]);
    expect(await page.locator(`[data-milestone-row="${refs.finished}"]`).count()).toBe(0);
    expect(await page.locator("[data-hidden-done]").getAttribute("data-hidden-done")).toBe("2");
    await page.locator("[data-show-done]").click();
    await page.waitForTimeout(600);
    expect(await members()).toEqual(expect.arrayContaining([refs.epic, refs.open, refs.cancelled, refs.done]));
    expect(await page.locator(`[data-milestone-row="${refs.finished}"]`).count()).toBe(1);
    await context.close();
  });

  it("says a milestone whose members are all finished is finished, and offers them, instead of 'nothing in it'", async () => {
    const { page, context } = await open(refs.gated!);
    const notice = page.locator("[data-hidden-all]");
    expect(await notice.innerText()).toContain("2 finished items hidden");
    expect(await page.getByText("Nothing is in this milestone yet").count()).toBe(0);
    await notice.locator("[data-show-done]").click();
    await page.waitForTimeout(600);
    expect(await page.locator("[data-member-row]").count()).toBe(2);
    await context.close();
  });

  it("sets the milestone's own target from the calendar, signed by the person, and clears it back to the estimate", async () => {
    const { page, context } = await open(refs.plan!);
    const target = page.locator("[data-milestone-detail] [data-milestone-target]").first();
    expect(await target.getAttribute("data-due-source")).toBe("estimate");
    await page.locator("[data-milestone-detail] [data-milestone-due-button]").first().click();
    await page.locator('[data-milestone-due-picker] input[type="date"]').fill("2030-01-15");
    await page.locator("[data-milestone-due-save]").click();
    await page.waitForTimeout(800);
    const set = await get<{ milestone: { targetDate: string | null } }>(`/api/milestone?ws=${WS}&ref=${refs.plan}`);
    expect(set.milestone.targetDate).toBe("2030-01-15");
    expect(await target.getAttribute("data-due-source")).toBe("target");
    expect(lastEventActor("milestone_updated")).toBe(PERSON);

    await page.locator("[data-milestone-detail] [data-milestone-due-button]").first().click();
    await page.locator("[data-milestone-due-clear]").click();
    await page.waitForTimeout(800);
    const cleared = await get<{ milestone: { targetDate: string | null } }>(`/api/milestone?ws=${WS}&ref=${refs.plan}`);
    expect(cleared.milestone.targetDate).toBeNull();
    expect(await target.getAttribute("data-due-source")).toBe("estimate");
    await context.close();
  });

  it("approves the milestone's gate from the page, signed by the person, and the status follows", async () => {
    const { page, context } = await open(refs.gated!);
    expect(await page.locator("[data-milestone-detail] [data-status-menu]").getAttribute("data-status-category")).toBe("gated");
    page.on("dialog", (dialog) => void dialog.accept(PERSON));
    await page.getByRole("button", { name: "Approve and close gate" }).click();
    await page.waitForTimeout(1200);
    const detail = await get<{ issue: { status: string }; gate: { state: string; resolvedBy: string | null } | null }>(`/api/issue?ws=${WS}&ref=${refs.gated}`);
    expect(detail.gate).toMatchObject({ state: "approved", resolvedBy: PERSON });
    expect(lastEventActor("gate_approved")).toBe(PERSON);
    expect(await page.locator("[data-milestone-detail] [data-status-menu]").getAttribute("aria-label")).not.toContain("Awaiting");
    await context.close();
  });

  it("shows a finished milestone a link points at, even while Done is hidden", async () => {
    const { page, context } = await open(refs.finished!);
    expect(await page.locator(`[data-milestone-row="${refs.finished}"]`).count()).toBe(1);
    expect(await page.locator("[data-milestone-detail]").getAttribute("data-milestone-detail")).toBe(refs.finished);
    await context.close();
  });

  it("offers New task with the Milestone kind chosen when a workspace has no milestones yet", async () => {
    const { page, context } = await open("", "beta");
    await page.locator("[data-create-milestone]").click();
    await page.waitForSelector("[data-create-kind]");
    expect(await page.locator("[data-create-kind]").innerText()).toContain("Milestone");
    await context.close();
  });
});
