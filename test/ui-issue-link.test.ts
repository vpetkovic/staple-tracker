/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * A LINK OPENS ONE TICKET — `?issue=STA-12` (src/ui/app/src/lib/issue-url.ts), in a real
 * browser against the real server and the built app.
 *
 * Loading an address with `issue` opens that ticket; opening one from the page writes the
 * parameter and closing clears it; a reload keeps it open; Back closes it; an unknown ref
 * shows a not-found state; in hub mode `ws` (and `issue-ws` for a ticket of another
 * workspace) say where the ticket lives. All of that is the browser's history and React's
 * effect order together, which a string render cannot see.
 *
 * SKIPPED, SAYING WHY, when there is no built bundle or no Chromium for `playwright-core`
 * (the same rule as ui-phone-back.test.ts; in CI it must run). Everything is scratch:
 * STAPLE_HOME is a temp dir and the servers are in-process on port 0.
 */
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
if (reason) console.warn(`ui-issue-link: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("ui-issue-link: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`ui-issue-link cannot run in CI: ${reason}.`);
    });
  });
}

let home: string;
let hub: UiHandle;
let single: UiHandle;
let browser: Browser;
const at = (ui: UiHandle) => `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

beforeAll(async () => {
  if (reason) return;
  home = mkdtempSync(join(tmpdir(), "staple-issue-link-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  let singleDb = "";
  for (const slug of ["alpha", "beta"]) {
    const ws = initWorkspace({ global: true, slug });
    for (const title of ["Set up the repository", "Write the README", "Fix the login"]) {
      ws.store.createIssue({ title: `${title} (${slug})` });
    }
    if (slug === "alpha") singleDb = ws.dbPath;
    ws.store.db.close();
  }
  hub = startUiServer({ port: 0, hub: true });
  single = startUiServer({ port: 0, hub: false, db: singleDb });
  await Promise.all([once(hub.server, "listening"), once(single.server, "listening")]);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  hub?.close();
  single?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function open(ui: UiHandle, path: string, device: typeof DESK | typeof PHONE = DESK): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${at(ui)}${path}${path.includes("?") ? "&" : "?"}token=${ui.token}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  return { page, context, errors };
}

const settle = (p: Page, ms = 600) => p.waitForTimeout(ms);
const param = (p: Page, name: string) => new URL(p.url()).searchParams.get(name);
const detail = (p: Page) => p.locator("[data-detail-overlay]");
/** The panel itself, below the dialog's hidden accessible name. */
const heading = (p: Page) => detail(p).locator('aside[aria-label="Issue detail"]');

describe.skipIf(Boolean(reason))("a link opens one ticket", () => {
  it("adds a GitHub connection from an inline form that Escape cancels without closing Settings", async () => {
    const { page, context, errors } = await open(single, "/?view=tasks");
    const connection = { id: "test-gh", providerId: "github", host: "github.com", account: "tester", mode: "cli" };
    let configured: Record<string, unknown> | null = null;
    await page.route("**/api/integrations/read", route => {
      const command = route.request().postDataJSON();
      if (command.action === "connections") return route.fulfill({ json: { connections: configured ? [{ ...connection, health: null }] : [], detected: [] } });
      return route.continue();
    });
    await page.route("**/api/integrations/configure", route => {
      configured = route.request().postDataJSON();
      return route.fulfill({ json: connection });
    });
    // No workspace named: the screen is the computer's.
    await page.goto(`${at(single)}/?settings=integrations&token=${single.token}`, { waitUntil: "networkidle" });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await page.getByLabel("Account", { exact: true }).fill("tester");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByLabel("Account", { exact: true }).count()).toBe(0);
    expect(await settings.isVisible()).toBe(true);
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    const save = page.getByRole("button", { name: "Save", exact: true });
    expect(await save.isDisabled()).toBe(true);
    await page.getByLabel("Account", { exact: true }).fill("tester");
    await save.click();
    await expect.poll(() => page.getByText("tester · through GitHub CLI", { exact: true }).count()).toBe(1);
    expect(configured).toMatchObject({ action: "configure", host: "github.com", account: "tester" });
    expect(await page.getByRole("button", { name: "Add account", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 30_000);

  it("configures Linear, discovers a team, searches and links, refreshes UUID context, and retains cache after revocation", async () => {
    const { page, context, errors } = await open(single, "/?view=tasks", PHONE);
    const account="11111111-1111-4111-8111-111111111111",org="22222222-2222-4222-8222-222222222222",team="33333333-3333-4333-8333-333333333333",id="44444444-4444-4444-8444-444444444444";
    const originalFetch=globalThis.fetch;
    let title="Linear fixture source",identifier="ENG-12",denied=false;
    const previous=process.env.STAPLE_TEST_LINEAR_KEY;
    process.env.STAPLE_TEST_LINEAR_KEY="fixture-key";
    const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input)!=="https://api.linear.app/graphql") return originalFetch(input,init);
      const command=JSON.parse(init!.body as string);
      const source={id,identifier,title,description:"Linear private source context",url:`https://linear.app/acme/issue/${identifier}/fixture`,state:{id:account,name:"In review"},team:{id:team,key:"ENG",name:"Engineering",organization:{id:org}}};
      const pageInfo={hasNextPage:false,endCursor:null};
      const fields=command.query.includes("teams(") ? {teams:{nodes:[source.team],pageInfo}}
        : command.query.includes("team(id:") ? {team:source.team}
        : command.query.includes("searchIssues(") ? {searchIssues:command.variables.after
          ? {nodes:[{...source,id:"55555555-5555-4555-8555-555555555555",identifier:"ENG-13",url:"https://linear.app/acme/issue/ENG-13/second",title:"Second page source"}],pageInfo}
          : {nodes:[source],pageInfo:{hasNextPage:true,endCursor:"page-two"}}}
        : command.query.includes("issues(") ? {issues:{nodes:[source],pageInfo}} : {issue:source};
      return Response.json(denied ? {errors:[{message:"private fixture failure",extensions:{code:"UNAUTHENTICATED"}}]}
        : {data:{viewer:{id:account},organization:{id:org,urlKey:"acme"},...fields}});
    });
    try {
      await page.goto(`${at(single)}/?settings=integrations&settings-ws=alpha&token=${single.token}`,{waitUntil:"networkidle"});
      await page.getByRole("button",{name:"Set up",exact:true}).click();
      await page.getByLabel("API key variable",{exact:true}).fill("STAPLE_TEST_LINEAR_KEY");
      await page.getByLabel("Organization ID",{exact:true}).fill(org);
      await page.getByLabel("Your user ID",{exact:true}).fill(account);
      await page.getByRole("button",{name:"Save",exact:true}).click();
      // Saving reloads the list and checks the new connection.
      await expect.poll(()=>page.locator('[data-connection-row="linear"] [data-connection-state="ready"]').count()).toBe(1);
      await page.getByRole("button",{name:"Add a source to alpha",exact:true}).click();
      await page.getByRole("option",{name:/Engineering \(ENG\)/}).click();
      await expect.poll(()=>page.getByRole("button",{name:"Remove Engineering (ENG) from alpha",exact:true}).count()).toBe(1);
      await page.keyboard.press("Escape");
      await page.goto(`${at(single)}/?issue=ALP-1&token=${single.token}`,{waitUntil:"networkidle"});
      await page.getByRole("button",{name:"Link issue",exact:true}).click();
      expect(await page.getByLabel("Resource type",{exact:true}).inputValue()).toBe("issue");
      expect(await page.getByLabel("Resource type",{exact:true}).locator('option[value="pull_request"]').isDisabled()).toBe(true);
      await page.getByLabel("Issue URL or search").fill("fixture");
      await page.getByRole("button",{name:"Search",exact:true}).click();
      await expect.poll(()=>page.getByRole("button",{name:/Linear fixture source/}).count()).toBe(1);
      await page.getByRole("button",{name:"More results",exact:true}).click();
      await expect.poll(()=>page.getByRole("button",{name:/Second page source/}).count()).toBe(1);
      expect(await page.getByRole("button",{name:/Linear fixture source/}).count()).toBe(1);
      await page.getByRole("button",{name:/Linear fixture source/}).click();
      await page.getByRole("button",{name:"Confirm link",exact:true}).click();
      await expect.poll(()=>page.getByText("Source linked. Local execution fields are unchanged.",{exact:true}).count()).toBe(1);
      await page.keyboard.press("Escape");
      await page.getByRole("tab",{name:"External links",exact:true}).click();
      const card=page.locator("[data-external-resource]");
      await expect.poll(()=>card.innerText()).toContain("In review");
      await card.getByText("Source context",{exact:true}).click();
      expect(await card.innerText()).toContain("Linear private source context");
      title="Linear renamed source";identifier="ENG-99";
      await page.getByRole("button",{name:"Refresh context for ENG-12",exact:true}).click();
      await expect.poll(()=>card.innerText()).toContain("Linear renamed source");
      denied=true;
      await page.getByRole("button",{name:"Refresh context for ENG-99",exact:true}).click();
      await expect.poll(()=>page.getByRole("alert").innerText()).toContain("Linear authentication failed");
      expect(await card.innerText()).toContain("Linear renamed source");
      expect(await heading(page).innerText()).toContain("Set up the repository (alpha)");
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      mock.mockRestore();
      if(previous===undefined) delete process.env.STAPLE_TEST_LINEAR_KEY;else process.env.STAPLE_TEST_LINEAR_KEY=previous;
      await context.close();
    }
  },45_000);

  it("loading an address with issue opens that ticket, and a reload keeps it open", async () => {
    const { page, context, errors } = await open(single, "/?issue=ALP-2");
    await expect.poll(() => detail(page).count()).toBe(1);
    await expect.poll(() => heading(page).innerText()).toContain("Write the README (alpha)");
    expect(param(page, "issue")).toBe("ALP-2");
    // `view` is not needed on the way in; the page writes it once it has started.
    await expect.poll(() => param(page, "view")).toBe("tasks");
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    await expect.poll(() => heading(page).innerText()).toContain("Write the README (alpha)");
    expect(param(page, "issue")).toBe("ALP-2");
    expect(errors).toEqual([]);
    await context.close();
  }, 30_000);

  it("opening a ticket writes the parameter, the next one replaces it, and closing clears it", async () => {
    const { page, context } = await open(single, "/?view=tasks");
    expect(param(page, "issue")).toBeNull();
    const length = await page.evaluate(() => history.length);
    const rows = page.locator('[data-testid="task-row"]:not([data-ghost])');
    const [first, second] = [await rows.nth(0).getAttribute("data-identifier"), await rows.nth(1).getAttribute("data-identifier")];
    await rows.nth(0).click();
    await settle(page);
    expect(await detail(page).count()).toBe(1);
    expect(param(page, "issue")).toBe(first);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    // Next ticket from the keyboard: the address follows, no new history entry.
    await page.keyboard.press("j");
    await settle(page);
    expect(param(page, "issue")).toBe(second);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await page.keyboard.press("Escape");
    await settle(page);
    expect(await detail(page).count()).toBe(0);
    expect(param(page, "issue")).toBeNull();
    expect(param(page, "view")).toBe("tasks");
    await context.close();
  }, 30_000);

  it("Back closes a ticket opened from the page, and Forward opens it again", async () => {
    const { page, context } = await open(single, "/?view=tasks");
    await page.locator('[data-testid="task-row"][data-identifier="ALP-3"]').first().click();
    await settle(page);
    expect(param(page, "issue")).toBe("ALP-3");
    await page.goBack();
    await settle(page);
    expect(await detail(page).count()).toBe(0);
    expect(param(page, "issue")).toBeNull();
    await page.goForward();
    await settle(page);
    await expect.poll(() => heading(page).innerText()).toContain("Fix the login (alpha)");
    await context.close();
  }, 30_000);

  it("closing a ticket that arrived with the address, or after a reload, clears the parameter", async () => {
    const { page, context } = await open(single, "/?view=tasks");
    await page.locator('[data-testid="task-row"][data-identifier="ALP-1"]').first().click();
    await settle(page);
    await page.reload({ waitUntil: "networkidle" });
    await settle(page);
    expect(await detail(page).count()).toBe(1);
    await page.keyboard.press("Escape");
    await settle(page, 900);
    expect(await detail(page).count()).toBe(0);
    expect(param(page, "issue")).toBeNull();
    // Still the app, still the page.
    expect(param(page, "view")).toBe("tasks");
    await context.close();
  }, 30_000);

  it("an unknown ref shows a not-found state with a way out", async () => {
    const { page, context } = await open(single, "/?view=tasks&issue=ALP-404");
    await expect.poll(() => page.locator("[data-issue-not-found]").count()).toBe(1);
    expect(await page.locator("[data-issue-not-found]").innerText()).toContain("ALP-404 was not found");
    await page.locator("[data-issue-not-found] button", { hasText: "Close" }).click();
    await settle(page);
    expect(await detail(page).count()).toBe(0);
    expect(param(page, "issue")).toBeNull();
    await context.close();
  }, 30_000);

  it("hub mode: ws says where the ticket lives, and a ticket from elsewhere carries issue-ws", async () => {
    const { page, context, errors } = await open(hub, "/?ws=beta&issue=BET-3");
    await expect.poll(() => heading(page).innerText()).toContain("Fix the login (beta)");
    expect(param(page, "ws")).toBe("beta");
    expect(param(page, "issue-ws")).toBeNull();
    await page.keyboard.press("Escape");
    await settle(page);

    // All workspaces: opening a row writes the ticket's workspace beside it.
    const all = await open(hub, "/?view=tasks");
    await all.page.locator('[data-testid="task-row"][data-identifier="BET-1"]').first().click();
    await settle(all.page);
    expect(param(all.page, "issue")).toBe("BET-1");
    expect(param(all.page, "issue-ws")).toBe("beta");
    await all.page.reload({ waitUntil: "networkidle" });
    await settle(all.page);
    await expect.poll(() => heading(all.page).innerText()).toContain("Set up the repository (beta)");

    // No workspace named: the ref's prefix finds it.
    const bare = await open(hub, "/?issue=BET-2");
    await expect.poll(() => heading(bare.page).innerText()).toContain("Write the README (beta)");

    // A workspace this hub does not have: not found, and it says why.
    const gone = await open(hub, "/?ws=gamma&issue=GAM-1");
    await expect.poll(() => gone.page.locator("[data-issue-not-found]").innerText()).toContain('no workspace called "gamma"');

    expect(errors).toEqual([]);
    await Promise.all([context.close(), all.context.close(), bare.context.close(), gone.context.close()]);
  }, 45_000);

  it("going to another view or workspace closes a ticket that arrived with the address, and Back does not reopen it", async () => {
    const { page, context } = await open(single, "/?view=tasks&issue=ALP-1");
    await expect.poll(() => detail(page).count()).toBe(1);
    await page.keyboard.press("ControlOrMeta+k");
    await settle(page, 400);
    await page.keyboard.type("Go to Graph");
    await settle(page, 300);
    await page.keyboard.press("Enter");
    await settle(page, 900);
    expect(param(page, "view")).toBe("graph");
    expect(param(page, "issue")).toBeNull();
    expect(await detail(page).count()).toBe(0);
    await page.goBack();
    await settle(page);
    expect(param(page, "view")).toBe("tasks");
    expect(await detail(page).count()).toBe(0);
    await context.close();

    const hubPage = await open(hub, "/?ws=beta&issue=BET-3");
    await expect.poll(() => heading(hubPage.page).innerText()).toContain("Fix the login (beta)");
    await hubPage.page.keyboard.press("ControlOrMeta+k");
    await settle(hubPage.page, 400);
    await hubPage.page.keyboard.type("alpha");
    await settle(hubPage.page, 300);
    await hubPage.page.keyboard.press("Enter");
    await settle(hubPage.page, 900);
    expect(param(hubPage.page, "issue")).toBeNull();
    expect(await detail(hubPage.page).count()).toBe(0);
    await hubPage.context.close();
  }, 45_000);

  it("a link naming a workspace the page lacks keeps saying so after a reload, with no dead Back step", async () => {
    const gone = await open(hub, "/?ws=gamma&issue=GAM-1");
    await expect.poll(() => gone.page.locator("[data-issue-not-found]").innerText()).toContain('no workspace called "gamma"');
    await expect.poll(() => param(gone.page, "issue-ws")).toBe("gamma");
    expect(await gone.page.evaluate(() => history.length)).toBe(2);
    await gone.page.reload({ waitUntil: "networkidle" });
    await expect.poll(() => gone.page.locator("[data-issue-not-found]").innerText()).toContain('no workspace called "gamma"');
    await gone.context.close();

    // A single-workspace page given a short link with ws: no extra entry either.
    const short = await open(single, "/?ws=alpha&issue=ALP-2");
    await expect.poll(() => heading(short.page).innerText()).toContain("Write the README (alpha)");
    expect(await short.page.evaluate(() => history.length)).toBe(2);
    await short.context.close();
  }, 30_000);

  it("on a phone the sheet opens from the link and Back to the list clears it", async () => {
    const { page, context } = await open(single, "/?view=tasks&issue=ALP-1", PHONE);
    await expect.poll(() => detail(page).count()).toBe(1);
    await page.locator("[data-detail-back]").tap();
    await settle(page);
    expect(await detail(page).count()).toBe(0);
    expect(param(page, "issue")).toBeNull();
    await context.close();
  }, 30_000);

  it("keeps an unpromoted idea's internal id out of the phone dialog's accessible name", async () => {
    const post = async (path: string, body: object) => {
      const response = await fetch(`${at(single)}${path}`, {
        method: "POST",
        headers: { "x-staple-token": single.token, "content-type": "application/json" },
        body: JSON.stringify({ actor: "VP", ...body }),
      });
      expect(response.status).toBe(200);
      return await response.json();
    };
    await post("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: true }] });
    const captured = await post("/api/plan/capture", { title: "Larkspur visitor welcome" });
    const id = captured.idea.idea.id as string;
    for (const colorScheme of ["light", "dark"] as const) {
      const { page, context, errors } = await open(single, `/?view=plan&issue=${id}`, { ...PHONE, viewport: { width: 390, height: 844 } });
      try {
        await page.emulateMedia({ colorScheme });
        await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), colorScheme);
        await expect.poll(() => heading(page).innerText()).toContain("Larkspur visitor welcome");
        const dialog = page.getByRole("dialog", { name: "Issue detail", exact: true });
        expect(await dialog.count()).toBe(1);
        expect(await dialog.innerText()).not.toContain(id);
        expect(await heading(page).innerText()).not.toMatch(/ALP-\d+/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 30_000);
});
