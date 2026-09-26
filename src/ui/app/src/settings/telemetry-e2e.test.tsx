/**
 * The "Usage & budget" settings section against the REAL server, through its REAL wiring.
 *
 * The real HTTP server (`src/ui/server.ts`, in this process) runs on a staple home private
 * to this file, with a private HOME holding a stub `~/.local/bin/staple` launcher (so setup
 * plans and installs the Codex watcher, as on a real machine) and a private, stateful fake
 * `launchctl` (`STAPLE_TEST_LAUNCHCTL`, restored afterwards) that records what is "loaded"
 * and can be told to fail `bootstrap`. The machine's launchd is never asked; the suite's
 * real-agent comparison still runs at teardown.
 *
 * The section is driven through `createTelemetryController` with `PAGE_TELEMETRY_API`: the
 * same handlers and state `TelemetrySection` runs, calling the page's own `lib/api.ts`
 * functions, whose `fetch` is pointed at the test server (the token added as the page has
 * it). The panel is rendered with `react-dom/server` from the controller's state.
 */
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError, applyBudgetCollection, bindBudgetSource, getBudgetCollection, isCrossOriginRefusal, planBudgetCollection, setBudgetCapture, unbindBudgetSource } from "@/lib/api";
import { CROSS_ORIGIN_MESSAGE, describeRefusal } from "@/lib/refusal";
import type { KnownBinding } from "@/lib/telemetry-types";
import { PAGE_TELEMETRY_API, TelemetryPanel, type TelemetryView } from "./TelemetrySection";
import { createTelemetryController, type TelemetryController } from "./telemetry-controller";
import { STALE_PLAN_WHY, confirmPlan, showPlan } from "./telemetry-flow";
import { PRIVACY_NOTE, TELEMETRY_CATEGORY_ID, bindingHomeInput, remoteFromLocation, viewedFromAnotherDevice, withTelemetryCategory } from "./telemetry-settings";
import { CLOUD_CATEGORY } from "./cloud-settings";
import { GuardRefusal } from "@/components/GuardRefusal";
import { REPO_ROOT, runCliAtAsync } from "../../../../../test/fixtures/characterize-support.ts";
import { STATUSLINE_FIXTURE } from "../../../../../test/fixtures/budget-support.ts";
import { ingestBudget } from "../../../../core/telemetry/ingest.ts";
import { initWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";

const PHONE = "http://100.90.235.4:4440";

let root: string;
let userHome: string;
let home: string;
let claudeDir: string;
let codexDir: string;
let loadedFile: string;
let failFile: string;
let plistPath: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let sendOrigin: string | null = null;
let requests = 0;
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};

const SETTINGS = (): string => join(claudeDir, "settings.json");
const ORIGINAL = `{\n  "statusLine": { "type": "command", "command": "~/bin/line" }\n}\n`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "staple-telemetry-e2e-"));
  userHome = join(root, "home");
  home = join(userHome, ".staple");
  claudeDir = join(userHome, ".claude");
  codexDir = join(userHome, ".codex");
  loadedFile = join(root, "launchd-loaded");
  failFile = join(root, "launchd-fail-bootstrap");
  plistPath = join(userHome, "Library", "LaunchAgents", "com.staple.budget-collect.plist");
  for (const dir of [home, claudeDir, codexDir, join(userHome, ".local", "bin"), join(userHome, "Library", "LaunchAgents"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
  // The installed launcher setup points the watcher at. Never run: launchd here is a fake.
  writeFileSync(join(userHome, ".local", "bin", "staple"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(userHome, ".local", "bin", "staple"), 0o755);
  // A launchd that remembers what it loaded, and fails bootstrap on request.
  const fake = join(root, "bin", "launchctl");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  print) if [ -f "${loadedFile}" ]; then printf '\\tpath = %s\\n' "$(cat "${loadedFile}")"; exit 0; fi; echo "Could not find service" >&2; exit 113;;`,
      `  bootstrap) if [ -f "${failFile}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; printf '%s' "$3" > "${loadedFile}"; exit 0;;`,
      `  bootout) rm -f "${loadedFile}"; exit 0;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  for (const key of ["HOME", "STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "STAPLE_TEST_LAUNCHCTL", "STAPLE_TEST_PLATFORM"]) saved[key] = process.env[key];
  process.env.HOME = userHome;
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  process.env.STAPLE_TEST_LAUNCHCTL = fake;
  // The watcher is a launch agent, so the server plans as macOS on every runner (the fake
  // launchctl above is its launchd); one test below plans as Linux.
  process.env.STAPLE_TEST_PLATFORM = "darwin";
  const ws = initWorkspace({ dir: join(root, "repo"), slug: "telemetrye2e" });
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: join(root, "repo", ".staple", "staple.db") });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  // The page's fetch, pointed at the server: relative paths resolved, its token attached.
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    requests += 1;
    const headers = { ...(init.headers as Record<string, string>), "x-staple-token": ui.token, ...(sendOrigin ? { origin: sendOrigin } : {}) };
    return realFetch(`${origin}${String(input)}`, { ...init, headers });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  ui?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  // Back to a machine with nothing set up, through the same consent the page uses.
  sendOrigin = null;
  rmSync(failFile, { force: true });
  const undo = await planBudgetCollection("unsetup");
  if (undo.consent !== null) await applyBudgetCollection("unsetup", undo.consent);
  const status = await getBudgetCollection();
  for (const binding of status.bindings) await unbindBudgetSource(homeOf(binding));
  if (status.budgetCapture) await setBudgetCapture(false);
  writeFileSync(SETTINGS(), ORIGINAL);
});

const homeOf = (binding: KnownBinding) =>
  bindingHomeInput(binding.source === "claude_code_statusline" ? "claude-statusline" : "codex-rollout", binding.source === "claude_code_statusline" ? binding.configDir : binding.home);

async function section(remote = false): Promise<TelemetryController> {
  const controller = createTelemetryController(PAGE_TELEMETRY_API, { remote });
  await controller.reload();
  return controller;
}

const html = (controller: TelemetryController): string =>
  renderToStaticMarkup(<TelemetryPanel view={controller.get() as TelemetryView} on={controller.handlers} />);

const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** Text outside every <details>: what the reader sees without opening "Show details". */
const visible = (markup: string): string => text(markup.replace(/<details[\s\S]*?<\/details>/g, ""));

/** `staple budget …--json` on the same home, asynchronously (the server is in this process). */
async function cli(args: string[]): Promise<Record<string, unknown>> {
  const result = await runCliAtAsync(REPO_ROOT, ["budget", ...args, "--json"], {
    HOME: userHome,
    STAPLE_HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
  });
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function turnOn(controller: TelemetryController, draft = { claudeAccount: "claude-max", codexAccount: "codex-plus", statusline: true, watcher: true }) {
  controller.handlers.onOpenSetup();
  controller.handlers.onSetupDraft(draft);
  await controller.handlers.onPlan("setup");
}

describe("the category and the device check", () => {
  it("sits under Global, after Cloud, and is not in the served registry", () => {
    const composed = withTelemetryCategory([
      { id: "statuses", label: "Statuses", description: "", scope: "workspace", editor: "statuses", order: 10 },
      CLOUD_CATEGORY,
      { id: "machine", label: "This machine", description: "", scope: "global", editor: "fields", order: 90 },
    ]);
    expect(composed.map((category) => category.id)).toEqual(["statuses", "cloud", TELEMETRY_CATEGORY_ID, "machine"]);
    expect(withTelemetryCategory([])).toEqual([]);
  });

  it("a page served from anywhere but this computer's loopback is another device", () => {
    expect(viewedFromAnotherDevice("100.90.235.4")).toBe(true);
    expect(viewedFromAnotherDevice("mac.tailnet.ts.net")).toBe(true);
    expect(viewedFromAnotherDevice("127.0.0.1")).toBe(false);
    expect(viewedFromAnotherDevice("localhost")).toBe(false);
    // What TelemetrySection builds its controller from.
    expect(remoteFromLocation({ hostname: "100.90.235.4" })).toBe(true);
    expect(remoteFromLocation({ hostname: "127.0.0.1" })).toBe(false);
    expect(remoteFromLocation(undefined)).toBe(false);
  });

  it("only the Origin check's refusal reads as cross-origin, and every view words it the same", () => {
    const cross = new ApiError(403, { code: "forbidden", message: "Cross-origin request rejected (Origin: x)", detail: { reason: "cross_origin" } });
    const other = new ApiError(403, { code: "forbidden", message: "not a member" });
    expect(isCrossOriginRefusal(cross)).toBe(true);
    expect(isCrossOriginRefusal(other)).toBe(false);
    expect(describeRefusal(cross)).toMatchObject({ message: CROSS_ORIGIN_MESSAGE, serverMessage: "Cross-origin request rejected (Origin: x)" });
    expect(describeRefusal(other).message).toBe("not a member");
  });
});

describe("automatic collection, through the section's handlers", () => {
  it("a machine with nothing set up reads Off, with the privacy note", async () => {
    const page = await section();
    const markup = html(page);
    expect(markup).toContain('data-status="unknown"');
    expect(text(markup)).toContain("Usage tracking is off. Nothing is being recorded.");
    expect(text(markup)).toContain(PRIVACY_NOTE);
    expect(markup).not.toContain('data-action="unsetup-plan"');
  });

  it("on: the plan in plain words, the watcher planned AND installed; off: all of it undone", async () => {
    const page = await section();
    await turnOn(page);
    const plan = page.get().plan!;
    expect(plan.response.plan.steps.find((step) => step.part === "watcher")?.action).toBe("change");
    const planText = text(html(page));
    expect(planText).toContain("Turn on usage tracking.");
    expect(planText).toContain(`Link your Claude folder (${claudeDir}) to the account "claude-max".`);
    expect(planText).toContain("Add a small step to your Claude status line so it records your usage (a backup of your Claude settings is kept).");
    expect(planText).toContain("Check your Codex sessions every 5 minutes in the background.");
    // Showing the plan changed nothing.
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(existsSync(plistPath)).toBe(false);

    await page.handlers.onConfirmPlan();
    expect(page.get().notice).toMatchObject({ tone: "ok", text: "Automatic collection is on. Done:" });
    expect(page.get().notice?.lines).toContain("Check your Codex sessions every 5 minutes in the background.");
    expect(readFileSync(SETTINGS(), "utf8")).toContain("staple-statusline-wrapper/v2");
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(loadedFile, "utf8")).toBe(plistPath);
    const status = page.get().status!;
    expect(status.watcher).toMatchObject({ installed: true, loaded: true, intervalMinutes: 5 });

    // A real reading through the real ingestion, as the wrapper would hand it over.
    ingestBudget({ source: "claude-statusline", input: readFileSync(STATUSLINE_FIXTURE, "utf8"), configDir: claudeDir }, { home });
    await page.handlers.onRefresh();
    const on = html(page);
    const claude = /<li[^>]*data-source="claude_code_statusline"[\s\S]*?<\/li>/.exec(on)![0];
    const codex = /<li[^>]*data-source="codex_rollout"[\s\S]*?<\/li>/.exec(on)![0];
    expect(text(claude)).toContain("Last reading 1 min ago");
    expect(text(claude)).toContain("Recording from the Claude status line.");
    expect(text(codex)).toContain("Checked in the background every 5 minutes.");

    // Tracking off: the reading says it is from before, beside "Not recording".
    page.handlers.onCaptureAsk();
    await page.handlers.onCaptureConfirm();
    const off = /<li[^>]*data-source="claude_code_statusline"[\s\S]*?<\/li>/.exec(html(page))![0];
    expect(text(off)).toContain("Last reading 1 min ago, before tracking was turned off");
    expect(text(off)).toContain("Not recording: usage tracking is off.");

    await page.handlers.onPlan("unsetup");
    expect(text(html(page))).toContain("Stop and remove the background check of Codex sessions.");
    await page.handlers.onConfirmPlan();
    expect(page.get().notice).toMatchObject({ tone: "ok", text: "Automatic collection is off. Done:" });
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(loadedFile)).toBe(false);
  });

  it("on Linux the watcher is not installed: the plan says so in plain words and gives the cron line", async () => {
    process.env.STAPLE_TEST_PLATFORM = "linux";
    try {
      const page = await section();
      await turnOn(page, { claudeAccount: "", codexAccount: "codex-plus", statusline: false, watcher: true });
      const watcher = page.get().plan!.response.plan.steps.find((step) => step.part === "watcher")!;
      expect(watcher.action).toBe("skip");
      expect(watcher.summary).toContain("budget collect");
      const markup = html(page);
      expect(visible(markup)).toContain("Codex sessions won't be checked in the background (see details); Collect now still works.");
      expect(text(markup)).toContain("crontab -e");
      await page.handlers.onConfirmPlan();
      expect(page.get().notice?.tone).toBe("ok");
      expect(existsSync(plistPath)).toBe(false);
      expect(page.get().status?.watcher).toMatchObject({ supported: false, loaded: null });
      expect(text(html(page))).toContain("Automatic checks aren't available on this system");
    } finally {
      process.env.STAPLE_TEST_PLATFORM = "darwin";
    }
  });

  it("a plan made stale by a change on the machine comes back as a NEW plan to confirm; nothing is applied", async () => {
    const page = await section();
    await turnOn(page, { claudeAccount: "claude-max", codexAccount: "", statusline: true, watcher: false });
    const first = page.get().plan!;
    writeFileSync(SETTINGS(), `{"statusLine": {"type": "command", "command": "other"}}\n`);
    await page.handlers.onConfirmPlan();
    expect(page.get().planWhy).toBe(STALE_PLAN_WHY);
    expect(page.get().plan?.replanned).toBe(true);
    expect(page.get().plan?.response.consent?.id).not.toBe(first.response.consent?.id);
    expect(page.get().status?.budgetCapture).toBe(false);
    expect(readFileSync(SETTINGS(), "utf8")).not.toContain("staple-statusline-wrapper");
    expect(text(html(page))).toContain(STALE_PLAN_WHY);
    await page.handlers.onConfirmPlan();
    expect(page.get().notice?.tone).toBe("ok");
    expect(readFileSync(SETTINGS(), "utf8")).toContain("staple-statusline-wrapper/v2");
  });

  it("a ticket already used (404) is re-planned, never retried", async () => {
    const shown = await showPlan({ plan: planBudgetCollection, apply: applyBudgetCollection }, "setup", { codexAccount: "codex-plus", statusline: false, watcher: false });
    await applyBudgetCollection("setup", shown.response.consent!);
    const again = await confirmPlan({ plan: planBudgetCollection, apply: applyBudgetCollection }, shown);
    expect(again.kind).toBe("replanned");
    if (again.kind === "replanned") expect(again.shown.response.consent).toBeNull();
  });

  it("a plan that refuses has no Confirm, and nothing is applied", async () => {
    writeFileSync(SETTINGS(), "{ not json");
    const page = await section();
    await turnOn(page, { claudeAccount: "claude-max", codexAccount: "", statusline: true, watcher: false });
    const markup = html(page);
    expect(text(markup)).toContain("This can't be done right now. Nothing has been changed.");
    expect(markup).toContain('data-step-action="refuse"');
    expect(markup).not.toContain('data-action="plan-confirm"');
    expect(page.get().status?.budgetCapture).toBe(false);
  });

  it("a setup that really stops partway (launchd refuses the watcher) says so, with what was done", async () => {
    writeFileSync(failFile, "");
    const page = await section();
    await turnOn(page, { claudeAccount: "", codexAccount: "codex-plus", statusline: false, watcher: true });
    await page.handlers.onConfirmPlan();
    const notice = page.get().notice!;
    expect(notice.tone).toBe("error");
    expect(notice.text).toContain("Setup stopped partway through.");
    expect(notice.lines).toEqual(["Turn on usage tracking.", `Link your Codex folder (${codexDir}) to the account "codex-plus".`]);
    expect(notice.details).toContain("Bootstrap failed: 5");
    // What was done is really done, and recorded so "Turn off" undoes it.
    expect(page.get().status).toMatchObject({ budgetCapture: true, setup: { recorded: true } });
    rmSync(failFile);
    await page.handlers.onPlan("unsetup");
    await page.handlers.onConfirmPlan();
    expect(page.get().status).toMatchObject({ budgetCapture: false, bindings: [] });
  });
});

describe("account links, through the section's handlers, as the CLI sees them", () => {
  it("add, edit (in place), remove", async () => {
    const page = await section();
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorDraft({ source: "claude-statusline", folder: "", account: "claude-max", provider: "" });
    await page.handlers.onEditorSave();
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorSource("codex-rollout");
    page.handlers.onEditorDraft({ ...page.get().editor!.draft, folder: join(root, "codex-work"), account: "codex-plus" });
    await page.handlers.onEditorSave();
    expect(page.get().notice).toMatchObject({ tone: "ok", text: "Account link added." });
    expect((await cli(["bindings"])).bindings).toEqual(page.get().status!.bindings);

    const codex = page.get().status!.bindings[1]!;
    page.handlers.onEditorOpen(codex);
    page.handlers.onEditorDraft({ ...page.get().editor!.draft, folder: join(root, "codex-moved"), account: "codex-pro" });
    await page.handlers.onEditorSave();
    expect(page.get().editor).toBeNull();
    expect(page.get().status!.bindings[1]).toEqual({ source: "codex_rollout", home: join(root, "codex-moved"), provider: "openai", accountRef: "codex-pro" });
    expect((await cli(["bindings"])).bindings).toEqual(page.get().status!.bindings);

    page.handlers.onRemoveAsk(page.get().status!.bindings[0]!);
    await page.handlers.onRemoveConfirm();
    expect(page.get().status!.bindings.map((binding) => binding.accountRef)).toEqual(["codex-pro"]);
    expect((await cli(["bindings"])).bindings).toEqual(page.get().status!.bindings);
  });

  it("switching an edited link from Claude to Codex takes Codex's provider, not Anthropic's", async () => {
    const page = await section();
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorDraft({ source: "claude-statusline", folder: join(root, "work-claude"), account: "work-claude", provider: "" });
    await page.handlers.onEditorSave();
    const claude = page.get().status!.bindings[0]!;
    expect(claude.provider).toBe("anthropic");
    page.handlers.onEditorOpen(claude);
    expect(page.get().editor!.draft.provider).toBe("anthropic");
    page.handlers.onEditorSource("codex-rollout");
    expect(page.get().editor!.draft.provider).toBe("");
    await page.handlers.onEditorSave();
    expect(page.get().status!.bindings).toEqual([{ source: "codex_rollout", home: join(root, "work-claude"), provider: "openai", accountRef: "work-claude" }]);
    expect(html(page)).not.toContain("(anthropic)");
  });

  it("editing a link onto a folder another link holds is refused in plain words, and both links stay", async () => {
    const page = await section();
    for (const draft of [
      { source: "claude-statusline" as const, folder: "", account: "work-claude", provider: "" },
      { source: "codex-rollout" as const, folder: "", account: "codex-plus", provider: "" },
    ]) {
      page.handlers.onEditorOpen(null);
      page.handlers.onEditorDraft(draft);
      await page.handlers.onEditorSave();
    }
    const before = page.get().status!.bindings;
    page.handlers.onEditorOpen(before[0]!);
    page.handlers.onEditorSource("codex-rollout");
    page.handlers.onEditorDraft({ ...page.get().editor!.draft, folder: codexDir });
    await page.handlers.onEditorSave();
    expect(page.get().editor?.error?.text).toBe("That folder already has its own account link. Edit or remove that link instead; nothing was changed.");
    expect(page.get().editor?.error?.detail).toContain("already has its own codex_rollout binding");
    expect(page.get().status!.bindings).toEqual(before);
    expect((await cli(["bindings"])).bindings).toEqual(before);
  });

  it("a label or folder the CLI refuses is refused in plain words; the CLI's sentence is only under Show details", async () => {
    const page = await section();
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorDraft({ source: "claude-statusline", folder: "", account: "Claude Max", provider: "" });
    await page.handlers.onEditorSave();
    let markup = html(page);
    expect(visible(markup)).toContain("The account label can only use lowercase letters, digits and dashes");
    expect(visible(markup)).not.toContain("--account");
    expect(text(markup)).toContain("--account must be an account label");
    page.handlers.onEditorDraft({ source: "claude-statusline", folder: "relative/claude", account: "claude-max", provider: "" });
    await page.handlers.onEditorSave();
    markup = html(page);
    expect(visible(markup)).toContain("The folder must be a full path (starting with /) or start with ~ for your home folder.");
    expect(visible(markup)).not.toContain("--config-dir");
    expect(page.get().status!.bindings).toEqual([]);
  });

  it("keeps an account label on one line", async () => {
    await bindBudgetSource({ source: "claude-statusline", account: "claude-max" });
    const markup = html(await section());
    expect(markup).toContain('<span class="whitespace-nowrap">“claude-max”</span>');
  });
});

describe("needs attention", () => {
  it("names each account without a reading, once, instead of repeating one sentence", async () => {
    await setBudgetCapture(true);
    // Labels no earlier test stored a reading under (readings stay in hub.db).
    await bindBudgetSource({ source: "claude-statusline", account: "claude-team" });
    await bindBudgetSource({ source: "codex-rollout", account: "codex-plus" });
    await bindBudgetSource({ source: "codex-rollout", account: "codex-work", codexHome: join(root, "codex-work") });
    const markup = html(await section());
    const lines = [...markup.matchAll(/<li[^>]*data-problem="no_reading"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]!).trim());
    expect(lines).toEqual([
      "No reading yet from claude-team (Claude status line). Claude records one the next time its status line updates.",
      "No reading yet from codex-plus (Codex sessions). Codex records one on the next check.",
      "No reading yet from codex-work (Codex sessions). Codex records one on the next check.",
    ]);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("second review", () => {
  it("the setup form refuses a bad label in plain words; the CLI's flag only under Show details", async () => {
    const page = await section();
    await turnOn(page, { claudeAccount: "Claude Max", codexAccount: "", statusline: true, watcher: false });
    const notice = page.get().notice!;
    expect(notice.tone).toBe("error");
    expect(notice.text).toContain("The account label can only use lowercase letters, digits and dashes");
    expect(notice.details).toContain("--claude-account must be an account label");
    expect(visible(html(page))).not.toContain("--claude-account");
    expect(page.get().plan).toBeNull();
  });

  it("renaming a link's account, same folder, saves in place", async () => {
    const page = await section();
    for (const account of ["rename-me", "after-it"]) {
      page.handlers.onEditorOpen(null);
      page.handlers.onEditorDraft({ source: account === "rename-me" ? "claude-statusline" : "codex-rollout", folder: "", account, provider: "" });
      await page.handlers.onEditorSave();
    }
    page.handlers.onEditorOpen(page.get().status!.bindings[0]!);
    page.handlers.onEditorDraft({ ...page.get().editor!.draft, account: "renamed" });
    await page.handlers.onEditorSave();
    expect(page.get().editor).toBeNull();
    expect(page.get().status!.bindings.map((binding) => binding.accountRef)).toEqual(["renamed", "after-it"]);
  });

  it("switching a link's source away and back restores its own stored provider", async () => {
    const page = await section();
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorDraft({ source: "claude-statusline", folder: "", account: "claude-eu", provider: "anthropic-eu" });
    await page.handlers.onEditorSave();
    page.handlers.onEditorOpen(page.get().status!.bindings[0]!);
    page.handlers.onEditorSource("codex-rollout");
    expect(page.get().editor!.draft.provider).toBe("");
    page.handlers.onEditorSource("claude-statusline");
    expect(page.get().editor!.draft.provider).toBe("anthropic-eu");
  });

  it("names the Claude folder a status line is missing from, and says when a folder has no Claude settings", async () => {
    await setBudgetCapture(true);
    const empty = join(root, "no-settings-claude");
    mkdirSync(empty, { recursive: true });
    await bindBudgetSource({ source: "claude-statusline", account: "claude-home" });
    await bindBudgetSource({ source: "claude-statusline", account: "claude-empty", configDir: empty });
    const markup = html(await section());
    const lines = (code: string) => [...markup.matchAll(new RegExp(`<li[^>]*data-problem="${code}"[^>]*>([\\s\\S]*?)<\\/li>`, "g"))].map((match) => text(match[1]!).trim());
    expect(lines("statusline_not_installed")).toEqual([
      `The Claude folder ${claudeDir} (account claude-home) is linked, but its status line doesn't record usage yet. Turn on automatic collection to add the step.`,
      `The Claude folder ${empty} (account claude-empty) has no Claude settings file, so it has no status line to record from. Check the folder is right, or start Claude there once.`,
    ]);
    expect(lines("no_reading")).toContain(`No reading yet from claude-empty (Claude status line): the folder ${empty} has no Claude settings, so there is no status line to record from.`);
    expect(lines("no_reading").join(" ")).not.toContain("claude-empty (Claude status line). Claude records one");
  });

  it("a page on localhost through a port-forward is remote once the server names its write origins", async () => {
    const forwarded = createTelemetryController(PAGE_TELEMETRY_API, { remote: remoteFromLocation({ hostname: "localhost" }), origin: "http://localhost:1" });
    expect(forwarded.get().remote).toBe(false);
    await forwarded.reload();
    expect(forwarded.get().remote).toBe(true);
    for (const own of [origin, origin.replace("127.0.0.1", "localhost")]) {
      const local = createTelemetryController(PAGE_TELEMETRY_API, { remote: false, origin: own });
      await local.reload();
      expect(local.get().remote, own).toBe(false);
    }
  });

  it("the task dialog's refusal strip frames a cross-origin refusal as 'only from this computer's browser', not as a guard", () => {
    const refusal = describeRefusal(new ApiError(403, { code: "forbidden", message: "Cross-origin request rejected (Origin: x)", detail: { reason: "cross_origin" } }));
    const strip = text(renderToStaticMarkup(<GuardRefusal refusal={refusal} />));
    expect(strip).toContain("only from this computer's browser");
    expect(strip).toContain(CROSS_ORIGIN_MESSAGE);
    expect(strip).not.toMatch(/refused by the store|not retryable/i);
    const guard = text(renderToStaticMarkup(<GuardRefusal refusal={describeRefusal(new ApiError(409, { code: "conflict", message: "in_progress requires an assignee" }))} />));
    expect(guard).toMatch(/refused by the store/i);
  });
});

describe("collect now", () => {
  it("runs one collect and says what it found in plain words", async () => {
    const page = await section();
    await setBudgetCapture(true);
    await bindBudgetSource({ source: "codex-rollout", account: "codex-plus" });
    await page.handlers.onCollect();
    expect(page.get().lastCollect?.ok).toBe(true);
    expect(text(html(page))).toContain("Checked your Codex sessions: nothing new since the last check.");
  });
});

describe("from another device (the tailnet)", () => {
  it("a page that knows it is remote disables its writes and sends none", async () => {
    const page = await section(true);
    const markup = html(page);
    expect(markup).toContain("data-remote-note");
    for (const action of ["capture-on", "collect", "setup-open", "binding-add"]) {
      expect(markup, action).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-action="${action}"|<button[^>]*data-action="${action}"[^>]*disabled=""`));
    }
    const sent = requests;
    page.handlers.onCaptureAsk();
    await page.handlers.onCaptureConfirm();
    expect(page.get().notice).toMatchObject({ tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE });
    // Only the status re-read left the page; the write was never sent.
    expect((await getBudgetCollection()).budgetCapture).toBe(false);
    expect(requests - sent).toBe(1);
  });

  it("a write the server refuses for its origin is shown as that, not as a dead token", async () => {
    const page = await section();
    sendOrigin = PHONE;
    page.handlers.onCaptureAsk();
    await page.handlers.onCaptureConfirm();
    expect(page.get().notice).toMatchObject({ tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE });
    expect(page.get().notice?.details).toContain("Cross-origin request rejected");
    page.handlers.onEditorOpen(null);
    page.handlers.onEditorDraft({ source: "codex-rollout", folder: "", account: "phone", provider: "" });
    await page.handlers.onEditorSave();
    expect(page.get().notice?.tone).toBe("cross_origin");
    sendOrigin = null;
    expect(await getBudgetCollection()).toMatchObject({ budgetCapture: false, bindings: [] });
    expect(text(html(page))).toContain("Changes can only be made from this computer's browser.");
  });
});
