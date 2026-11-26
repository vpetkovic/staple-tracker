/// <reference lib="dom" />
/**
 * A project deleted while the create dialog is open leaves the form, not just its label.
 *
 * The control falls back to "No project" for an id it no longer lists. The form used to
 * keep the id, so the task was sent with a project the control did not show and the
 * server refused it. This drives the built page: pick a project, delete it from another
 * client, wait for the control to say No project, create, and read what was stored.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { openWorkspace } from "../src/core/open.js";
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
let dbPath: string;
let origin: string;
let projectId: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-create-deleted-project-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "deleted" });
  ws.store.createIssue({ title: "Something already here" });
  projectId = ws.store.projects().create({ name: "Docs site" }, "setup").id;
  dbPath = ws.dbPath;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function stored(title: string) {
  const { store } = openWorkspace(dbPath);
  try {
    return store.listIssues({}).find((issue) => issue.title === title);
  } finally {
    store.db.close();
  }
}

describe("the create dialog's project", () => {
  it("is dropped from the payload when the project is deleted while the dialog is open", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?token=${ui.token}`, { waitUntil: "networkidle" });
      await page.getByText("Something already here").first().waitFor();
      await page.keyboard.press("c");
      await page.locator("#create-title").fill("Filed while its project went away");
      const control = page.locator("[data-create-project]");
      await control.click();
      await page.getByRole("option", { name: "Docs site" }).click();
      await expect.poll(() => control.innerText()).toContain("Docs site");
      // The page's first poll only sets its baseline; a delete before it would never be seen.
      await page.waitForResponse((response) => response.url().includes("/api/poll"));

      // Another client deletes the project; the page learns of it on its next poll.
      const removed = await fetch(`${origin}/api/project/delete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-staple-token": ui.token, origin },
        body: JSON.stringify({ actor: "someone-else", ref: projectId }),
      });
      expect(removed.status).toBe(200);
      await expect.poll(() => control.innerText(), { timeout: 10_000 }).toContain("No project");

      await page.getByRole("button", { name: "Create task" }).click();
      await expect.poll(() => stored("Filed while its project went away"), { timeout: 10_000 }).toBeDefined();
      expect(stored("Filed while its project went away")?.projectId).toBeNull();
    } finally {
      await context.close();
    }
  });
});
