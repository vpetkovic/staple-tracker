/**
 * The "Usage & budget" settings section against the REAL server.
 *
 * The real HTTP server (`src/ui/server.ts`, in this process) runs on an isolated staple
 * home with a scratch Claude folder; launchd is the suite's fake (test/setup/isolated-home.ts),
 * and no staple launcher exists in the scratch HOME, so the watcher step is planned as
 * skipped and nothing is ever loaded. The page's own `lib/api.ts` functions are driven through
 * a `fetch` that forwards to that server (the token added as the page would have it), so the
 * consent flow, the binding writes and the cross-origin refusal go through the same code the
 * browser runs. The panel is rendered with `react-dom/server` from what came off the wire.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  applyBudgetCollection,
  bindBudgetSource,
  collectBudgetNow,
  getBudgetCollection,
  isCrossOriginRefusal,
  planBudgetCollection,
  setBudgetCapture,
  unbindBudgetSource,
} from "@/lib/api";
import type { CollectionStatus, KnownBinding } from "@/lib/telemetry-types";
import { TelemetryPanel, type TelemetryHandlers, type TelemetryView } from "./TelemetrySection";
import { STALE_PLAN_WHY, confirmPlan, showPlan, type CollectionTransport } from "./telemetry-flow";
import {
  CROSS_ORIGIN_MESSAGE,
  EMPTY_BINDING_DRAFT,
  PRIVACY_NOTE,
  TELEMETRY_CATEGORY_ID,
  bindInputOf,
  bindingHomeInput,
  draftOf,
  withTelemetryCategory,
} from "./telemetry-settings";
import { CLOUD_CATEGORY } from "./cloud-settings";
import { STATUSLINE_FIXTURE } from "../../../../../test/fixtures/budget-support.ts";
import { applyBudgetSetup } from "../../../../core/telemetry/collection/service.ts";
import { ingestBudget } from "../../../../core/telemetry/ingest.ts";
import { errorEnvelope, StapleError } from "../../../../core/types.ts";
import { initWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";

const REPO_ROOT = join(__dirname, "../../../../..");
const PHONE = "http://100.90.235.4:4440";

let root: string;
let home: string;
let claudeDir: string;
let codexDir: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
/** The Origin header the forwarded fetch sends; null for none (a same-origin page sends its own loopback origin). */
let sendOrigin: string | null = null;
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};

const SETTINGS = (): string => join(claudeDir, "settings.json");
const ORIGINAL = `{\n  "statusLine": { "type": "command", "command": "~/bin/line" }\n}\n`;

const pageTransport: CollectionTransport = { plan: planBudgetCollection, apply: applyBudgetCollection };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "staple-telemetry-e2e-"));
  home = join(root, "staple-home");
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  mkdirSync(home, { recursive: true });
  for (const key of ["STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[key] = process.env[key];
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  const ws = initWorkspace({ dir: join(root, "repo"), slug: "telemetrye2e" });
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: join(root, "repo", ".staple", "staple.db") });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  // The page's fetch, pointed at the server: relative paths resolved, its token attached.
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
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

beforeEach(() => {
  sendOrigin = null;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(SETTINGS(), ORIGINAL);
});

afterEach(async () => {
  // Back to a machine with nothing set up, through the same consent the page uses.
  sendOrigin = null;
  const undo = await planBudgetCollection("unsetup");
  if (undo.consent !== null) await applyBudgetCollection("unsetup", undo.consent);
  const status = await getBudgetCollection();
  for (const binding of status.bindings) await unbindBudgetSource(homeOf(binding));
  if (status.budgetCapture) await setBudgetCapture(false);
});

const homeOf = (binding: KnownBinding) =>
  bindingHomeInput(binding.source === "claude_code_statusline" ? "claude-statusline" : "codex-rollout", binding.source === "claude_code_statusline" ? binding.configDir : binding.home);

const noop = () => {};
const HANDLERS: TelemetryHandlers = {
  onRefresh: noop,
  onOpenSetup: noop,
  onSetupDraft: noop,
  onPlan: noop,
  onConfirmPlan: noop,
  onCancelPlan: noop,
  onCaptureAsk: noop,
  onCaptureConfirm: noop,
  onCaptureCancel: noop,
  onCollect: noop,
  onEditorOpen: noop,
  onEditorDraft: noop,
  onEditorSave: noop,
  onEditorCancel: noop,
  onRemoveAsk: noop,
  onRemoveConfirm: noop,
  onRemoveCancel: noop,
};

function viewOf(status: CollectionStatus, extra: Partial<TelemetryView> = {}): TelemetryView {
  return {
    status,
    busy: null,
    notice: null,
    remote: false,
    setupForm: null,
    plan: null,
    planWhy: null,
    captureConfirm: false,
    editor: null,
    removing: null,
    lastCollect: null,
    ...extra,
  };
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const render = (view: TelemetryView): string => renderToStaticMarkup(<TelemetryPanel view={view} on={HANDLERS} />);

/** `staple budget …--json` on the same home as the server, asynchronously (the server is in this process). */
async function cli(args: string[]): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), join(REPO_ROOT, "src/cli.ts"), "budget", ...args, "--json"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  const [status] = (await once(child, "close")) as [number | null];
  expect(status, args.join(" ")).toBe(0);
  return JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, unknown>;
}

describe("the category", () => {
  it("sits under Global, after Cloud, and is not in the served registry", () => {
    const composed = withTelemetryCategory([
      { id: "statuses", label: "Statuses", description: "", scope: "workspace", editor: "statuses", order: 10 },
      CLOUD_CATEGORY,
      { id: "machine", label: "This machine", description: "", scope: "global", editor: "fields", order: 90 },
    ]);
    expect(composed.map((category) => category.id)).toEqual(["statuses", "cloud", TELEMETRY_CATEGORY_ID, "machine"]);
    expect(composed.find((category) => category.id === TELEMETRY_CATEGORY_ID)?.scope).toBe("global");
    expect(withTelemetryCategory([])).toEqual([]);
  });
});

describe("status at a glance, from the real status", () => {
  it("a machine with nothing set up reads Off, says why, and carries the privacy note", async () => {
    const status = await getBudgetCollection();
    const html = render(viewOf(status));
    expect(html).toContain('data-glance="off"');
    expect(text(html)).toContain("Usage tracking is off. Nothing is being recorded.");
    expect(text(html)).toContain(PRIVACY_NOTE);
    expect(text(html)).toContain("Turn on automatic collection");
    expect(html).not.toContain('data-action="unsetup-plan"');
    expect(html).not.toContain("data-remote-note");
  });

  it("after setup and a real status-line reading: each source with its account, reading age and feed", async () => {
    const shown = await showPlan(pageTransport, "setup", { claudeAccount: "claude-max", codexAccount: "codex-plus", statusline: true, watcher: true });
    const applied = await confirmPlan(pageTransport, shown);
    expect(applied.kind).toBe("applied");
    // A real reading through the real ingestion, as the wrapper would hand it over.
    ingestBudget({ source: "claude-statusline", input: readFileSync(STATUSLINE_FIXTURE, "utf8"), configDir: claudeDir }, { home });
    const status = await getBudgetCollection();
    const html = render(viewOf(status));
    const claude = /<li[^>]*data-source="claude_code_statusline"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    const codex = /<li[^>]*data-source="codex_rollout"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(text(claude)).toContain("Claude status line");
    expect(text(claude)).toContain("claude-max");
    expect(text(claude)).toContain("Last reading just now");
    expect(text(claude)).toContain("Recording from the Claude status line.");
    expect(text(codex)).toContain("codex-plus");
    expect(text(codex)).toContain("No reading yet");
    // No launcher in the scratch HOME: no watcher, said in words, and as a problem.
    expect(text(codex)).toContain("Not checked automatically");
    expect(html).toContain('data-problem="no_reading"');
    expect(html).toContain('data-glance="attention"');
    expect(html).toContain('data-action="unsetup-plan"');
  });
});

describe("turning automatic collection on and off, with consent", () => {
  it("plan -> the plan in plain words -> confirm applies exactly it; off restores the file byte for byte", async () => {
    const shown = await showPlan(pageTransport, "setup", { claudeAccount: "claude-max", codexAccount: "codex-plus", statusline: true, watcher: true });
    // Nothing is changed by showing the plan.
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect((await getBudgetCollection()).budgetCapture).toBe(false);
    const planHtml = text(render(viewOf(await getBudgetCollection(), { plan: shown })));
    expect(planHtml).toContain("This will:");
    expect(planHtml).toContain("Turn on usage tracking.");
    expect(planHtml).toContain(`Link your Claude folder (${claudeDir}) to the account "claude-max".`);
    expect(planHtml).toContain("Add a small step to your Claude status line so it records your usage (a backup of your Claude settings is kept).");
    expect(planHtml).toContain(`Link your Codex folder (${codexDir}) to the account "codex-plus".`);
    expect(planHtml).toContain("Confirm and turn on");

    const result = await confirmPlan(pageTransport, shown);
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.outcome.applied.map((step) => step.part)).toEqual(["capture", "claude_binding", "statusline", "codex_binding"]);
    expect(readFileSync(SETTINGS(), "utf8")).toContain("staple-statusline-wrapper/v2");
    expect((await cli(["bindings"])).bindings).toHaveLength(2);

    const off = await showPlan(pageTransport, "unsetup");
    expect(text(render(viewOf(await getBudgetCollection(), { plan: off })))).toContain("Put your Claude status line back exactly as it was.");
    expect((await confirmPlan(pageTransport, off)).kind).toBe("applied");
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(await cli(["bindings"])).toMatchObject({ budgetCapture: false, bindings: [] });
  });

  it("a plan made stale by a change on the machine comes back as a NEW plan to confirm, and nothing is applied", async () => {
    const shown = await showPlan(pageTransport, "setup", { claudeAccount: "claude-max", statusline: true, watcher: false });
    writeFileSync(SETTINGS(), `{"statusLine": {"type": "command", "command": "other"}}\n`);
    const result = await confirmPlan(pageTransport, shown);
    expect(result.kind).toBe("replanned");
    if (result.kind !== "replanned") return;
    expect(result.why).toBe(STALE_PLAN_WHY);
    expect(result.shown.replanned).toBe(true);
    expect(result.shown.response.consent?.id).not.toBe(shown.response.consent?.id);
    // Nothing was applied.
    expect((await getBudgetCollection()).budgetCapture).toBe(false);
    expect(readFileSync(SETTINGS(), "utf8")).not.toContain("staple-statusline-wrapper");
    // The page shows the reason above the fresh plan, with a Confirm of its own.
    const html = render(viewOf(await getBudgetCollection(), { plan: result.shown, planWhy: result.why }));
    expect(html).toContain("data-replanned");
    expect(text(html)).toContain(STALE_PLAN_WHY);
    // Confirming the fresh plan applies it.
    expect((await confirmPlan(pageTransport, result.shown)).kind).toBe("applied");
    expect(readFileSync(SETTINGS(), "utf8")).toContain("staple-statusline-wrapper/v2");
  });

  it("a ticket already used (404) is re-planned too, never retried", async () => {
    const shown = await showPlan(pageTransport, "setup", { codexAccount: "codex-plus", statusline: false, watcher: false });
    await applyBudgetCollection("setup", shown.response.consent!);
    const again = await confirmPlan(pageTransport, shown);
    expect(again.kind).toBe("replanned");
    if (again.kind !== "replanned") return;
    // Everything is already so: the fresh plan has nothing to consent to.
    expect(again.shown.response.plan.changes).toBe(0);
    expect(again.shown.response.consent).toBeNull();
    const html = render(viewOf(await getBudgetCollection(), { plan: again.shown, planWhy: again.why }));
    expect(text(html)).toContain("Everything is already set up. There is nothing to change.");
    expect(html).not.toContain('data-action="plan-confirm"');
  });

  it("a plan that refuses is shown as refused, with no Confirm, and nothing can be applied", async () => {
    writeFileSync(SETTINGS(), "{ not json");
    const shown = await showPlan(pageTransport, "setup", { claudeAccount: "claude-max", statusline: true, watcher: false });
    expect(shown.response.plan.refusals).toBeGreaterThan(0);
    expect(shown.response.consent).toBeNull();
    const html = render(viewOf(await getBudgetCollection(), { plan: shown }));
    expect(text(html)).toContain("This can't be done right now. Nothing has been changed.");
    expect(html).toContain('data-step-action="refuse"');
    expect(html).not.toContain('data-action="plan-confirm"');
    expect(await confirmPlan(pageTransport, shown)).toMatchObject({ kind: "refused" });
    expect((await getBudgetCollection()).budgetCapture).toBe(false);
  });

  it("setup that stopped partway is reported honestly, with what was already done", async () => {
    // The envelope a real partial setup produces: the watcher's launchctl fails after capture
    // and the binding were written (an injected runner, so launchd is never asked).
    const agentHome = join(root, "partial");
    mkdirSync(agentHome, { recursive: true });
    let envelope: ReturnType<typeof errorEnvelope> | null = null;
    try {
      applyBudgetSetup(
        { codexAccount: "codex-plus", statusline: false },
        {
          home: join(root, "partial-staple"),
          platform: "darwin",
          userHome: agentHome,
          staple: join(agentHome, "staple"),
          launchctl: (args) => (args[0] === "print" ? { status: 113, stdout: "", stderr: "not loaded" } : { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }),
        },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(StapleError);
      envelope = errorEnvelope(error);
    }
    expect(envelope?.detail?.reason).toBe("setup_incomplete");
    const stub: CollectionTransport = {
      plan: pageTransport.plan,
      apply: async () => {
        throw new ApiError(409, envelope!);
      },
    };
    const result = await confirmPlan(stub, { action: "setup", options: { codexAccount: "codex-plus" }, response: { plan: { action: "setup", steps: [], changes: 1, refusals: 0, platform: "darwin" }, consent: { id: "x", digest: "y", expiresAt: "" } }, replanned: false });
    expect(result.kind).toBe("incomplete");
    if (result.kind !== "incomplete") return;
    expect(result.failedStep).toBe("watcher");
    expect(result.applied.map((step) => step.part)).toEqual(["capture", "codex_binding"]);
  });
});

describe("account links: add, edit, remove, as the CLI sees them", () => {
  it("the page's writes land in config.json exactly as `staple budget bindings` reads them", async () => {
    await bindBudgetSource(bindInputOf({ ...EMPTY_BINDING_DRAFT, account: "claude-max" }, null));
    await bindBudgetSource(bindInputOf({ source: "codex-rollout", folder: join(root, "codex-work"), account: "codex-plus", provider: "" }, null));
    let status = await getBudgetCollection();
    expect((await cli(["bindings"])).bindings).toEqual(status.bindings);
    expect(status.bindings.map((binding) => binding.accountRef)).toEqual(["claude-max", "codex-plus"]);

    // Edit: the Codex link moves to another folder and account, in place.
    const codex = status.bindings[1]!;
    await bindBudgetSource(bindInputOf({ ...draftOf(codex), folder: join(root, "codex-moved"), account: "codex-pro" }, codex));
    status = await getBudgetCollection();
    expect((await cli(["bindings"])).bindings).toEqual(status.bindings);
    expect(status.bindings[1]).toEqual({ source: "codex_rollout", home: join(root, "codex-moved"), provider: "openai", accountRef: "codex-pro" });
    const html = render(viewOf(status));
    expect(html).toContain(`data-binding="codex-rollout:${join(root, "codex-moved")}"`);
    expect(html).not.toContain(`data-binding="codex-rollout:${join(root, "codex-work")}"`);

    // Remove.
    await unbindBudgetSource(homeOf(status.bindings[0]!));
    status = await getBudgetCollection();
    expect((await cli(["bindings"])).bindings).toEqual(status.bindings);
    expect(status.bindings.map((binding) => binding.accountRef)).toEqual(["codex-pro"]);
  });

  it("a label the CLI refuses is refused with the CLI's sentence, shown on the form", async () => {
    const refusal = await bindBudgetSource(bindInputOf({ ...EMPTY_BINDING_DRAFT, account: "Claude Max" }, null)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    const message = (refusal as ApiError).message;
    expect(message).toContain("--account must be an account label");
    const html = render(viewOf(await getBudgetCollection(), { editor: { editing: null, draft: { ...EMPTY_BINDING_DRAFT, account: "Claude Max" }, error: message } }));
    expect(html).toContain('data-binding-form="add"');
    expect(html).toMatch(/role="alert"[^>]*>[^<]*--account must be an account label/);
  });
});

describe("collect now", () => {
  it("runs one collect and says what it found in plain words", async () => {
    await setBudgetCapture(true);
    await bindBudgetSource(bindInputOf({ source: "codex-rollout", folder: "", account: "codex-plus", provider: "" }, null));
    const result = await collectBudgetNow();
    expect(result.ok).toBe(true);
    const html = text(render(viewOf(await getBudgetCollection(), { lastCollect: result })));
    expect(html).toContain("Checked your Codex sessions: nothing new since the last check.");
  });
});

describe("a write from another device (the tailnet)", () => {
  it("is refused as cross_origin, surfaces as an ordinary refusal (not a dead token), and the page says why", async () => {
    sendOrigin = PHONE;
    // Reading works from the phone.
    const status = await getBudgetCollection();
    for (const write of [() => setBudgetCapture(true), () => planBudgetCollection("setup", { codexAccount: "codex-plus" }), () => bindBudgetSource({ source: "codex-rollout", account: "phone" })]) {
      const refusal = await write().catch((error: unknown) => error);
      // An ApiError, so lib/api did not take the AuthError path (which would have tried to
      // broadcast on `window`, absent here, and blanked the page to the token screen).
      expect(refusal).toBeInstanceOf(ApiError);
      expect(isCrossOriginRefusal(refusal)).toBe(true);
    }
    sendOrigin = null;
    expect((await getBudgetCollection()).budgetCapture).toBe(false);
    const html = render(viewOf(status, { remote: true, notice: { tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE, details: "Cross-origin request rejected" } }));
    expect(html).toContain('data-notice="cross_origin"');
    expect(text(html)).toContain("Changes can only be made from this computer's browser.");
    expect(html).toContain("data-remote-note");
  });
});
