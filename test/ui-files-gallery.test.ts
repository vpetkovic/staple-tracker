/// <reference lib="dom" />
/**
 * The Files tab in a real browser, at a desk width and a phone width.
 *
 * Skipped, saying why, when the UI bundle is missing (`npm run build:ui`) or
 * this machine has no Chromium for playwright-core. The bytes and the safe
 * content type are pinned in test/ui-file.test.ts; this one checks that a
 * person can filter the files, open an image, download from a shortcut, and
 * that the page does not grow sideways. A file that only downloads is not a
 * row that opens the panel.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
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
if (reason) console.warn(`ui-files-gallery: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-files-gallery: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-files-gallery cannot run in CI: ${reason}.`);
    });
  });
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pngAfter = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let browser: Browser;
let galleryRef = "";
let emptyRef = "";
let htmlId = "";

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
const DESK = { viewport: { width: 1440, height: 900 } };

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-gallery-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "gallery" });
  const gallery = ws.store.createIssue({ title: "Gallery of evidence" });
  const empty = ws.store.createIssue({ title: "Nothing attached" });
  galleryRef = gallery.identifier;
  emptyRef = empty.identifier;
  ws.store.attachFile(gallery.identifier, { filename: "before.png", bytes: png, caption: "before the change", author: "ada" });
  ws.store.attachFile(gallery.identifier, { filename: "after.png", bytes: pngAfter, caption: "after the change", author: "ada" });
  ws.store.attachFile(gallery.identifier, { filename: "notes.pdf", bytes: Buffer.from("%PDF-1.4\n%%EOF\n"), author: "ada" });
  ws.store.attachFile(gallery.identifier, { filename: "build.log", bytes: Buffer.from("build log\nline two\n"), author: "ada" });
  ws.store.attachFile(gallery.identifier, {
    filename: "walk.mp4",
    bytes: Buffer.from("\0\0\0\x18ftypisom\0\0\0\0isom"),
    author: "ada",
  });
  const page = ws.store.attachFile(gallery.identifier, {
    filename: "page.html",
    bytes: Buffer.from("<!DOCTYPE html><html><body><script>parent.STAPLE_PWNED=1</script></body></html>"),
    author: "ada",
  });
  htmlId = page.id;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
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

async function openFiles(device: typeof PHONE | typeof DESK, ref: string): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext(device);
  const p = await context.newPage();
  await p.goto(`${origin}/?view=tasks&token=${token}`, { waitUntil: "domcontentloaded" });
  await p.locator(`[data-testid="task-row"][data-identifier="${ref}"]`).click();
  await p.getByRole("tab", { name: "Files" }).click();
  await p.locator("[data-files]").waitFor();
  return { page: p, context };
}

describe.skipIf(Boolean(reason))("the files gallery", () => {
  it("opens a file in a side panel beside the ticket, and the edge sets the width", async () => {
    const { page: p, context } = await openFiles(DESK, galleryRef);
    await p.locator('[data-file-kind="image"] img').first().waitFor();
    expect(await p.getByRole("tab", { name: "Documents" }).count()).toBe(1);
    expect(await p.locator("[data-file-filter]").count()).toBe(6);
    const strip = await p.locator("[data-file-images]").evaluate((el) => getComputedStyle(el).display);
    expect(strip).toBe("flex");
    expect(await p.locator("[data-file-split]").count()).toBe(0);
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    await p.locator('[data-file-row][data-file-kind="pdf"]').click();
    const panel = p.locator("[data-file-panel]");
    await panel.waitFor();
    await p.locator("[data-file-viewer] iframe").waitFor();
    const task = await p.locator("[data-detail-overlay]").boundingBox();
    const before = await panel.boundingBox();
    expect(task).toBeTruthy();
    expect(before).toBeTruthy();
    expect(Math.abs(before!.x + before!.width - task!.x)).toBeLessThanOrEqual(2);
    const handle = p.locator("[data-file-panel-resize]");
    const grip = await handle.boundingBox();
    expect(grip).toBeTruthy();
    await p.mouse.move(grip!.x + grip!.width / 2, grip!.y + 80);
    await p.mouse.down();
    await p.mouse.move(grip!.x + grip!.width / 2 - 120, grip!.y + 80, { steps: 8 });
    await p.mouse.up();
    const after = await panel.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 80);
    await p.locator('[data-file-row][data-file-kind="video"]').click();
    await p.locator("[data-file-viewer] video").waitFor();
    expect(await p.locator("iframe").count()).toBe(0);
    await p.locator('[data-file-row][data-file-kind="text"]').click();
    await p.locator("[data-file-viewer] pre", { hasText: "build log" }).waitFor();
    expect(await p.locator("video").count()).toBe(0);
    await p.screenshot({ path: join(home, "files-desk.png"), fullPage: true });
    await p.keyboard.press("Escape");
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    expect(await p.getByRole("tab", { name: "Files" }).count()).toBe(1);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });

  it("opens the file across the phone, with no resize edge", async () => {
    const { page: p, context } = await openFiles(PHONE, galleryRef);
    await p.locator('[data-file-kind="image"] img').first().waitFor();
    await p.locator('[data-file-row][data-file-kind="video"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
    await p.locator('[data-file-row][data-file-kind="video"]').click();
    const panel = p.locator("[data-file-panel]");
    await panel.waitFor();
    expect(await p.locator("[data-file-panel-resize]").count()).toBe(0);
    const box = await panel.boundingBox();
    expect(box!.width).toBeGreaterThan(370);
    await p.locator("[data-file-viewer] video").waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await p.locator("[data-file-panel]").getByRole("button", { name: "Close file" }).click();
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    await p.locator('[data-file-row][data-file-kind="text"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
    await p.locator('[data-file-row][data-file-kind="text"]').click();
    await p.locator("[data-file-viewer] pre", { hasText: "build log" }).waitFor();
    await p.screenshot({ path: join(home, "files-phone.png"), fullPage: true });
    await context.close();
  });

  it("downloads and opens from a shortcut, and a download-only row does not open", async () => {
    const { page: p, context } = await openFiles(DESK, galleryRef);
    await p.locator('[data-file-kind="image"] img').first().waitFor();
    const other = p.locator('[data-file-row][data-file-kind="other"]');
    expect(await other.evaluate((el) => el.tagName)).toBe("DIV");
    await other.click();
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    expect(await p.locator("[data-file-lightbox]").count()).toBe(0);

    const pdf = p.locator("[data-file]", { has: p.locator('[data-file-row][data-file-kind="pdf"]') });
    const [download] = await Promise.all([
      p.waitForEvent("download"),
      pdf.getByRole("button", { name: "Download notes.pdf" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("notes.pdf");
    expect(await p.locator("[data-file-panel]").count()).toBe(0);

    const image = p.locator('[data-file-kind="image"]').first();
    const opened = p.waitForEvent("popup");
    await image.getByRole("button", { name: "Open before.png" }).click();
    const popup = await opened;
    expect(await p.locator("[data-file-lightbox]").count()).toBe(0);
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    await popup.close();

    const htmlOpen = p.waitForEvent("popup");
    await p.getByRole("button", { name: "Open page.html" }).click();
    const htmlPopup = await htmlOpen;
    expect(await p.locator("[data-file-panel]").count()).toBe(0);
    await htmlPopup.close();
    expect(await p.getByRole("button", { name: "Download walk.mp4" }).count()).toBe(1);
    await context.close();
  });

  it("opens an image in a lightbox and steps to the next one", async () => {
    const { page: p, context } = await openFiles(DESK, galleryRef);
    const tile = p.locator('[data-file-kind="image"] button').first();
    await tile.locator("img").waitFor({ timeout: 8000 });
    await tile.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await tile.click();
    const dialog = p.locator("[data-file-lightbox]");
    await dialog.waitFor({ timeout: 3000 });
    const opened = await dialog.innerText();
    const startedOnBefore = opened.includes("before the change");
    expect(startedOnBefore || opened.includes("after the change")).toBe(true);
    const next = dialog.getByRole("button", { name: "Next" });
    const previous = dialog.getByRole("button", { name: "Previous" });
    if (await next.isEnabled()) await next.click();
    else await previous.click();
    const stepped = await dialog.innerText();
    expect(stepped.includes(startedOnBefore ? "after the change" : "before the change")).toBe(true);
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await p.locator("[data-file-lightbox]").count()).toBe(0);
    await context.close();
  });

  it("says when a ticket has no files", async () => {
    const { page: p, context } = await openFiles(PHONE, emptyRef);
    expect(await p.locator("[data-files]").innerText()).toContain("No files on this ticket.");
    expect(await p.locator("[data-file-filter]").count()).toBe(0);
    await p.getByRole("tab", { name: "Documents" }).click();
    expect(await p.locator("[data-empty-state]").innerText()).toContain("No plan or notes on this ticket yet.");
    await context.close();
  });

  it("does not run an html file opened from this app", async () => {
    const { page: p, context } = await openFiles(DESK, galleryRef);
    const flagged = await p.evaluate(async ({ url, token: bearer }) => {
      const mark = window as unknown as { STAPLE_PWNED?: number };
      mark.STAPLE_PWNED = 0;
      const frame = document.createElement("iframe");
      frame.src = `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(bearer)}`;
      document.body.append(frame);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return mark.STAPLE_PWNED ?? 0;
    }, { url: `${origin}/api/file?id=${htmlId}`, token });
    expect(flagged).toBe(0);
    const response = await p.request.get(`${origin}/api/file?id=${htmlId}`, { headers: { "x-staple-token": token } });
    expect(response.headers()["content-type"]).toBe("application/octet-stream");
    await context.close();
  });
});
