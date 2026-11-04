/// <reference lib="dom" />
/**
 * staple's MCP Apps views, served by the packaged `staple mcp` and rendered in a minimal,
 * host-agnostic MCP Apps host in Chromium (`npm run test:views`; also part of `npm test`).
 *
 * The server is this run's packaged payload (`test/setup/package-payload.ts`), so this also
 * proves the package ships the view files. Each view must paint at 360px in the host's light
 * and dark themes, follow a live theme change, call tools through the host, and render an
 * error result as an error. A negative control proves the paint check fails on a view that
 * does not paint.
 *
 * The browser half is skipped, saying why, when this machine has no Chromium for
 * playwright-core (and fails in CI instead). The protocol half always runs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { MCP_APPS_EXTENSION, loadView, measurePaint, renderView, type PaintReport } from "./fixtures/mcp-apps-harness.js";

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

const browserReady = await chromiumAvailable();
const reason = browserReady ? "" : "no Chromium for playwright-core";
if (reason) console.warn(`mcp-views-host: browser tests skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("mcp-views-host: a browser to run in", () => {
    it("has Chromium", () => {
      throw new Error(`mcp-views-host cannot run in CI: ${reason}.`);
    });
  });
}

const WIDTH = 360;
const LIGHT_CARD = "rgb(246, 246, 247)"; // the host palette's --color-background-secondary
const DARK_CARD = "rgb(22, 22, 24)";

let home: string;
let dbPath: string;
let slug: string;
let prefix: string;
let version: string;
let browser: Browser | undefined;
const clients: Client[] = [];

/**
 * A client of the packaged `staple mcp`, pinned to the test workspace unless `unpinned` (then
 * no workspace resolves: the server runs in the temp home, with no STAPLE_DB).
 */
async function connect(options: { apps: boolean; unpinned?: boolean }): Promise<Client> {
  const payload = testPackageDir();
  // Built from scratch: a STAPLE_DB or STAPLE_WS from the shell must never reach this server.
  const { STAPLE_DB: _db, STAPLE_WS: _ws, ...inherited } = process.env as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(payload, "staple.mjs"), "mcp"],
    cwd: home,
    env: {
      ...inherited,
      ...(options.unpinned ? {} : { STAPLE_DB: dbPath }),
      STAPLE_AGENT: "view-test",
      NODE_NO_WARNINGS: "1",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "view-test-host", version: "0.0.0" },
    { capabilities: options.apps ? { extensions: MCP_APPS_EXTENSION } : {} },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function expectPainted(report: PaintReport, theme: "light" | "dark"): void {
  expect(report.ready, "the view rendered a result").toBe(true);
  expect(report.height, "the view reported a real height").toBeGreaterThan(60);
  expect(report.colors, "the frame is not one flat colour").toBeGreaterThan(8);
  expect(report.inked, "a real share of the frame is drawn").toBeGreaterThan(0.2);
  expect(report.overflowPx, `no sideways scroll at ${WIDTH}px`).toBeLessThanOrEqual(0);
  expect(report.colorScheme, "the view took the host theme").toBe(theme);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-views-"));
  process.env.STAPLE_HOME = join(home, ".staple");
  const ws = initWorkspace({ global: true, slug: "views" });
  dbPath = ws.dbPath;
  slug = ws.store.slug;
  prefix = ws.store.prefix;
  ws.store.createIssue({ title: "Paint the about view", status: "todo" });
  ws.store.createIssue({ title: "Follow the host theme", status: "in_progress" });
  ws.store.createIssue({ title: "Ship the view files", status: "done" });
  ws.store.db.close();
  version = (JSON.parse(readFileSync(join(testPackageDir(), "package.json"), "utf8")) as { version: string }).version;
  if (!reason) browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("the views over MCP", () => {
  it("lists every view over resources/list as a single-file MCP Apps resource", async () => {
    const client = await connect({ apps: true });
    const { resources } = await client.listResources();
    const about = resources.find((resource) => resource.uri === "ui://staple/about");
    expect(about).toMatchObject({ name: "about", mimeType: "text/html;profile=mcp-app" });
    const read = await client.readResource({ uri: "ui://staple/about" });
    const content = read.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toMatch(/^<!doctype html>/i);
    // One file: no script, stylesheet or image is fetched from anywhere.
    expect(content.text).not.toMatch(/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/i);
  });

  it("links show_about to its view on the tool and on the result, and annotates it read-only", async () => {
    const client = await connect({ apps: true });
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "show_about")!;
    expect(tool._meta).toEqual({ ui: { resourceUri: "ui://staple/about" }, "ui/resourceUri": "ui://staple/about" });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    const result = (await client.callTool({ name: "show_about", arguments: {} })) as CallToolResult;
    expect(result._meta).toEqual({ ui: { resourceUri: "ui://staple/about" } });
    expect(result.structuredContent).toMatchObject({
      server: { name: "staple", version },
      workspace: { slug, prefix, total: 3 },
      views: [{ name: "about", uri: "ui://staple/about" }],
    });
  });

  it("answers a host without MCP Apps in readable text", async () => {
    const client = await connect({ apps: false });
    const result = (await client.callTool({ name: "show_about", arguments: {} })) as CallToolResult;
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    expect(text).toContain(`staple ${version}`);
    expect(text).toContain(`Workspace ${slug} (${prefix}): 3 tickets: 1 todo, 1 in progress, 1 done.`);
    expect(text).toContain("Views: about (ui://staple/about).");
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe.skipIf(Boolean(reason))("the about view in a host", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`paints at ${WIDTH}px in the host's ${theme} theme`, async () => {
      const client = await connect({ apps: true });
      const view = await renderView(browser!, client, await loadView(client, "show_about"), { theme, width: WIDTH });
      try {
        const report = await measurePaint(view);
        expectPainted(report, theme);
        const card = view.frame.locator('[data-view="about"]');
        expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          theme === "light" ? LIGHT_CARD : DARK_CARD,
        );
        const text = await card.innerText();
        expect(text).toContain(`v${version}`);
        expect(text).toContain(`${slug} · ${prefix}`);
        expect(text).toContain(`test-host · ${theme} · ${WIDTH}px`);
        expect((await view.record()).sizes.length).toBeGreaterThan(0);
      } finally {
        await view.context.close();
      }
    });
  }

  it("follows a live change of the host theme", async () => {
    const client = await connect({ apps: true });
    const view = await renderView(browser!, client, await loadView(client, "show_about"), { theme: "light", width: WIDTH });
    try {
      expectPainted(await measurePaint(view), "light");
      await view.setTheme("dark");
      const card = view.frame.locator('[data-view="about"]');
      await expect
        .poll(() => card.evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(DARK_CARD);
      expect(await view.frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
      expect(await view.frame.locator("[data-host]").innerText()).toBe(`test-host · dark · ${WIDTH}px`);
    } finally {
      await view.context.close();
    }
  });

  it("Refresh calls show_about through the host and renders the new answer", async () => {
    const client = await connect({ apps: true });
    const view = await renderView(browser!, client, await loadView(client, "show_about"), { theme: "light", width: WIDTH });
    const ws = initWorkspace({ global: true, slug: "views" });
    try {
      expectPainted(await measurePaint(view), "light");
      ws.store.createIssue({ title: "Arrives after the first render", status: "todo" });
      await view.frame.locator('[data-action="refresh"]').click();
      await view.frame.getByText("Refreshed through the host (1 tool call).").waitFor();
      expect((await view.record()).toolCalls).toEqual(["show_about"]);
      expect(await view.frame.locator('[data-status="todo"]').innerText()).toBe("Todo 2");
    } finally {
      ws.store.db.close();
      await view.context.close();
    }
  });

  it("renders an error result as an error, not a blank frame", async () => {
    // An explicit ws that names no workspace fails the call (a pinned server would ignore ws).
    const client = await connect({ apps: true, unpinned: true });
    const source = await loadView(client, "show_about", { ws: "no-such-workspace" });
    expect(source.toolResult.isError).toBe(true);
    const view = await renderView(browser!, client, source, { theme: "dark", width: WIDTH });
    try {
      const report = await measurePaint(view);
      expect(report.ready).toBe(true);
      expect(report.colors).toBeGreaterThan(8);
      expect(await view.frame.getByRole("alert").innerText()).toContain("no-such-workspace");
    } finally {
      await view.context.close();
    }
  });

  it("the paint check fails on a view that does not paint (negative control)", async () => {
    const client = await connect({ apps: true });
    const source = await loadView(client, "show_about");
    const scriptless = source.html.replace(/<script type="module">[\s\S]*?<\/script>/, "");
    expect(scriptless).not.toBe(source.html);
    const view = await renderView(browser!, client, { ...source, html: scriptless }, { theme: "light", width: WIDTH });
    try {
      const report = await measurePaint(view, 2_000);
      expect(report.ready).toBe(false);
      expect(report.height).toBe(0);
      expect(() => expectPainted(report, "light")).toThrow();
    } finally {
      await view.context.close();
    }
  });
});
