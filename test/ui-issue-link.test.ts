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
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
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
    // Planned providers are listed and cannot be chosen yet.
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    for (const planned of ["ClickUp"]) {
      const item = page.getByRole("menuitem", { name: new RegExp(`^${planned}`) });
      expect(await item.getAttribute("aria-disabled")).toBe("true");
      expect(await item.innerText()).toContain("Soon");
    }
    expect(await page.getByRole("menuitem", { name: /^Linear workspace/ }).getAttribute("aria-disabled")).toBeNull();
    // Azure DevOps asks for the organization and the token variable, and sends no token and no ids.
    let azure: unknown = null;
    const recordAzure = (route: Route) => { azure = route.request().postDataJSON(); return route.fulfill({ json: { id: "test-ado" } }); };
    await page.route("**/api/integrations/configure", recordAzure);
    await page.getByRole("menuitem", { name: /^Azure DevOps organization/ }).click();
    expect(await page.getByLabel("Token variable", { exact: true }).inputValue()).toBe("STAPLE_AZURE_DEVOPS_PAT");
    await page.getByLabel("Organization", { exact: true }).fill("fabrikam");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => azure).toEqual({ action: "configure", providerId: "azure_devops", organization: "fabrikam", credentialEnv: "STAPLE_AZURE_DEVOPS_PAT" });
    await page.unroute("**/api/integrations/configure", recordAzure);
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    await page.keyboard.press("Escape");
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

  it("the link dialog opens on the field, remembers the last filter, and says when nothing is set up to search", async () => {
    const { page, context, errors } = await open(single, "/?issue=ALP-1");
    const dialog = page.locator("[data-link-external]");
    const pressed = (name: string) => dialog.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
    await page.getByRole("button", { name: "Link pull request", exact: true }).click();
    await expect.poll(() => dialog.getByText("Nothing is set up to search yet.").count()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("placeholder"))).toBe("Search issues and pull requests, or paste a link");
    expect(await pressed("Pull requests")).toBe("true");
    expect(await dialog.getByRole("button", { name: /^Link to ALP-1/ }).count()).toBe(1);
    expect(await dialog.locator("select, details, input[type=checkbox]").count()).toBe(0);
    // The task can be taken back off: the chip returns to asking for one, and a task can be chosen again.
    await dialog.getByRole("button", { name: /^Link to ALP-1/ }).click();
    await page.getByRole("option", { name: /^No task/ }).click();
    expect(await dialog.getByRole("button", { name: "Choose a task", exact: true }).count()).toBe(1);
    await dialog.getByRole("button", { name: "Choose a task", exact: true }).click();
    expect(await page.getByRole("option", { name: /^No task/ }).count()).toBe(0);
    await page.getByRole("option", { name: /ALP-1/ }).click();
    expect(await dialog.getByRole("button", { name: /^Link to ALP-1/ }).count()).toBe(1);
    await dialog.getByRole("button", { name: "Issues", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("staple:link-kind:v1"))).toBe("issue");
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.count()).toBe(0);
    await page.getByRole("tab", { name: /^External links/ }).click();
    await page.getByRole("tabpanel").getByRole("button", { name: "Link", exact: true }).first().click();
    await expect.poll(() => pressed("Issues")).toBe("true");
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
      // Enough teams that the Add source list has to scroll.
      const more=Array.from({length:30},(_,i)=>({...source.team,id:`66666666-6666-4666-8666-${String(i).padStart(12,"0")}`,key:`T${i}`,name:`Team ${i}`}));
      const fields=command.query.includes("teams(") ? {teams:{nodes:[source.team,...more],pageInfo}}
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
      // A window on one workspace lists the others on this computer but only its own row can change.
      expect(await page.locator("[data-workspace-row]").count()).toBeGreaterThan(1);
      expect(await page.getByRole("button",{name:/^Add a source to /}).count()).toBe(1);
      await page.getByRole("button",{name:"Add a source to alpha",exact:true}).click();
      // The list opens outside the Settings dialog, whose scroll lock must not swallow the wheel over it.
      const sources=page.locator("[cmdk-list]");
      await expect.poll(()=>sources.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeGreaterThan(100);
      await sources.hover();
      await page.mouse.wheel(0,120);
      await expect.poll(()=>sources.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
      await sources.evaluate(el=>{el.scrollTop=0;});
      await page.getByRole("option",{name:/Engineering \(ENG\)/}).click();
      // The picker stays open for more; while it is open the screen behind it is inert. Escape closes the picker alone.
      await expect.poll(()=>page.getByRole("option",{name:/Engineering \(ENG\).*chosen/}).count()).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(()=>page.getByRole("button",{name:"Remove Engineering (ENG) from alpha",exact:true}).count()).toBe(1);
      await page.goto(`${at(single)}/?issue=ALP-1&token=${single.token}`,{waitUntil:"networkidle"});
      // The phone summary has one way to link, for both kinds.
      await page.getByRole("button",{name:"Link an issue or pull request",exact:true}).click();
      const dialog=page.locator("[data-link-external]");
      await expect.poll(()=>dialog.getByRole("button",{name:/^Search scope: alpha · 1 source/}).count()).toBe(1);
      await page.keyboard.type("fixture");
      await expect.poll(()=>dialog.getByRole("option",{name:/Linear fixture source/}).count()).toBe(1);
      await dialog.getByRole("button",{name:"Show more",exact:true}).click();
      await expect.poll(()=>dialog.getByRole("option",{name:/Second page source/}).count()).toBe(1);
      expect(await dialog.getByRole("option",{name:/Linear fixture source/}).count()).toBe(1);
      expect(await dialog.getByRole("option",{name:/Linear fixture source/}).getAttribute("aria-selected")).toBe("true");
      await page.keyboard.press("Enter");
      await expect.poll(()=>dialog.getByRole("option",{name:/Linear fixture source/}).innerText()).toContain("Linked here");
      expect(await page.evaluate(()=>document.activeElement?.getAttribute("role"))).toBe("combobox");
      await page.keyboard.press("Escape");
      await page.getByRole("tab",{name:/^External links/}).click();
      const card=page.locator("[data-external-resource]");
      await expect.poll(()=>card.innerText()).toContain("In review");
      // The row opens in place for the saved description.
      await card.locator("[aria-expanded]").first().click();
      await expect.poll(()=>card.innerText()).toContain("Linear private source context");
      title="Linear renamed source";identifier="ENG-99";
      // On a phone a row's actions are its menu.
      const refresh=async(key:string)=>{
        await page.getByRole("button",{name:`More actions for ${key}`,exact:true}).click();
        await page.getByRole("menuitem",{name:"Refresh",exact:true}).click();
      };
      await refresh("ENG-12");
      await expect.poll(()=>card.innerText()).toContain("Linear renamed source");
      denied=true;
      await refresh("ENG-99");
      await expect.poll(()=>card.getByRole("alert").innerText()).toContain("Linear rejected the API key in STAPLE_TEST_LINEAR_KEY");
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

  it("connects Azure DevOps by organization, maps a project, searches and links a work item, refreshes it and keeps it after revocation", async () => {
    const { page, context, errors } = await open(single, "/?view=tasks", PHONE);
    const account = "11111111-1111-4111-8111-111111111111", org = "77777777-7777-4777-8777-777777777777";
    const project = { id: "88888888-8888-4888-8888-888888888888", name: "Fabrikam Web" };
    const originalFetch = globalThis.fetch;
    let title = "Azure fixture work item", denied = false;
    const previous = process.env.STAPLE_TEST_ADO_PAT;
    process.env.STAPLE_TEST_ADO_PAT = "fixture-pat";
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      // A Linear team mapped by an earlier test must not reach the network either.
      if (url.host === "api.linear.app") return new Response(null, { status: 401 });
      // A token made for all accessible organizations lists them for the form.
      if (url.host === "app.vssps.visualstudio.com") {
        if (url.pathname === "/_apis/profile/profiles/me") return Response.json({ id: account });
        return Response.json({ value: [{ accountId: org, accountName: "acme" }, { accountId: "99999999-9999-4999-8999-999999999999", accountName: "zeta" }] });
      }
      // An Azure DevOps Server lists its own collections.
      if (url.host === "tfs.example.test") return Response.json({ value: [{ id: "88888888-8888-4888-8888-000000000001", name: "DefaultCollection" }] });
      if (url.host !== "dev.azure.com") return originalFetch(input, init);
      if (denied) return new Response("private fixture failure", { status: 401 });
      const path = url.pathname;
      if (path === "/acme/_apis/connectionData") return Response.json({ authenticatedUser: { id: account, providerDisplayName: "Ada Lovelace" }, instanceId: org });
      if (path === "/acme/_apis/projects") return Response.json({ value: [project] });
      if (path.startsWith("/acme/_apis/projects/")) return Response.json(project);
      if (path.endsWith("/_apis/wit/wiql")) return Response.json({ workItems: [{ id: 12 }] });
      if (path === "/acme/_apis/wit/workitemsbatch") return Response.json({ value: [{ id: 12, fields: { "System.Title": title, "System.State": "Active", "System.TeamProject": project.name, "System.Description": "<p>Azure private source context</p>" } }] });
      return new Response(null, { status: 404 });
    });
    try {
      await page.goto(`${at(single)}/?settings=integrations&settings-ws=alpha&token=${single.token}`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add connection", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Azure DevOps organization/ }).click();
      await page.getByLabel("Token variable", { exact: true }).fill("STAPLE_TEST_ADO_PAT");
      // The organizations the token reaches are offered; picking one fills the field.
      const reached = page.getByRole("group", { name: "Organizations this token reaches" });
      await reached.getByRole("button", { name: "acme", exact: true }).click();
      expect(await page.getByLabel("Organization", { exact: true }).inputValue()).toBe("acme");
      expect(await reached.getByRole("button", { name: "acme", exact: true }).getAttribute("aria-pressed")).toBe("true");
      // A Server lists its collections instead, and a name picked for Services does not carry over.
      await page.getByLabel("Server (optional)", { exact: true }).fill("tfs.example.test");
      await expect.poll(() => page.getByLabel("Collection", { exact: true }).inputValue()).toBe("DefaultCollection");
      await page.getByLabel("Server (optional)", { exact: true }).fill("");
      await reached.getByRole("button", { name: "acme", exact: true }).click();
      expect(await page.getByLabel("Organization", { exact: true }).inputValue()).toBe("acme");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => page.locator('[data-connection-row="azure_devops"] [data-connection-state="ready"]').count()).toBe(1);
      expect(await page.locator('[data-connection-row="azure_devops"]').innerText()).toContain("acme · token in STAPLE_TEST_ADO_PAT");
      await page.getByRole("button", { name: "Add a source to alpha", exact: true }).click();
      await page.getByRole("option", { name: /Fabrikam Web/ }).click();
      await expect.poll(() => page.getByRole("option", { name: /Fabrikam Web.*chosen/ }).count()).toBe(1);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.getByRole("button", { name: "Remove Fabrikam Web from alpha", exact: true }).count()).toBe(1);
      await page.goto(`${at(single)}/?issue=ALP-2&token=${single.token}`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Link an issue or pull request", exact: true }).click();
      const dialog = page.locator("[data-link-external]");
      // The fixture answers every prefix with the same item, so wait for the answer to the whole
      // text: the dialog ignores Enter on a list that answers an older query.
      const answered = page.waitForResponse(r => r.url().includes("/api/integrations/read") && /"action":"search"/.test(r.request().postData() ?? "") && /"text":"fixture"/.test(r.request().postData() ?? ""));
      await page.keyboard.type("fixture");
      await answered;
      await expect.poll(() => dialog.getByRole("option", { name: /Azure fixture work item/ }).getAttribute("aria-selected")).toBe("true");
      await page.keyboard.press("Enter");
      await expect.poll(() => dialog.getByRole("option", { name: /Azure fixture work item/ }).innerText()).toContain("Linked here");
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: /^External links/ }).click();
      const card = page.locator("[data-external-resource]");
      await expect.poll(() => card.innerText()).toContain("Active");
      await card.locator("[aria-expanded]").first().click();
      await expect.poll(() => card.innerText()).toContain("Azure private source context");
      const refresh = async () => {
        await page.getByRole("button", { name: /^More actions for .*12$/ }).click();
        await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
      };
      title = "Azure renamed work item";
      await refresh();
      await expect.poll(() => card.innerText()).toContain("Azure renamed work item");
      denied = true;
      await refresh();
      await expect.poll(() => card.getByRole("alert").innerText()).toContain("Azure DevOps rejected the personal access token in STAPLE_TEST_ADO_PAT");
      expect(await card.innerText()).toContain("Azure renamed work item");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      mock.mockRestore();
      if (previous === undefined) delete process.env.STAPLE_TEST_ADO_PAT; else process.env.STAPLE_TEST_ADO_PAT = previous;
      await context.close();
    }
  }, 45_000);

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
