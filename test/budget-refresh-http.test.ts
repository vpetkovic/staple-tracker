/**
 * The surfaces of live polling (docs/execution-telemetry.md, "Live polling"):
 *
 *   - the UI server's Refresh (`POST /api/budget/collection/refresh`), the one write the
 *     server accepts from a foreign Origin (the phone on the tailnet), while every other
 *     write still refuses one;
 *   - `GET /api/budget/polling` and `POST /api/budget/live`;
 *   - `staple budget live on|off` (a consent: `on` needs --yes), `budget setup --live` and
 *     `budget unsetup`, and `budget collect` running the poll.
 *
 * Only a Codex home is ever bound with live polling on, with a fake auth.json in a scratch
 * directory, and the provider is a stub in front of `fetch`: nothing here reads a real
 * keychain or credential file or reaches a provider. The stub passes loopback requests
 * (this file's own calls to the server) through to the real fetch.
 */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { bindBudgetSource, budgetConfig, setBudgetCapture, setLivePolling, unbindBudgetSource } from "../src/core/telemetry/budget-config.js";
import { applyBudgetSetup, applyBudgetUnsetup, collectBudgetNow, planBudgetSetup, readSetupRecord, type CollectionDeps } from "../src/core/telemetry/collection/service.js";
import { CODEX_USAGE_URL } from "../src/core/telemetry/polling/codex.js";
import { pollStatePath } from "../src/core/telemetry/polling/run.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";

const FOREIGN = "http://100.90.235.4:4440";
const TOKEN_MARKER = "SECRET-codex-token";

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

/** An auth.json whose token expires far in the future. */
const AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: jwt({ exp: 4_102_444_800, marker: TOKEN_MARKER }), account_id: "acct-SECRET", refresh_token: "SECRET-refresh" },
});

const usageBody = () => {
  const now = Math.floor(Date.now() / 1000);
  return {
    email: "someone@example.com",
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 21, limit_window_seconds: 18_000, reset_after_seconds: 9_000, reset_at: now + 9_000 },
      secondary_window: { used_percent: 44, limit_window_seconds: 604_800, reset_after_seconds: 300_000, reset_at: now + 300_000 },
    },
  };
};

let root: string;
let home: string;
let codexDir: string;
let ui: UiHandle;
let origin: string;
const saved: Record<string, string | undefined> = {};
const providerCalls: string[] = [];
const realFetch = globalThis.fetch;

async function call(path: string, init: { body?: unknown; origin?: string; method?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
  const res = await realFetch(`${origin}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "x-staple-token": ui.token, "content-type": "application/json", ...(init.origin ? { origin: init.origin } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

beforeAll(async () => {
  root = tempDir("budget-refresh-http");
  home = join(root, "staple-home");
  codexDir = join(root, "codex");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "auth.json"), AUTH, { mode: 0o600 });
  for (const key of ["STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[key] = process.env[key];
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-unbound");
  process.env.CODEX_HOME = codexDir;
  const ws = initWorkspace({ dir: join(root, "repo"), slug: "budgetrefresh" });
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: join(root, "repo", ".staple", "staple.db") });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    providerCalls.push(url);
    if (url === CODEX_USAGE_URL) return Promise.resolve(new Response(JSON.stringify(usageBody()), { status: 200, headers: { "content-type": "application/json" } }));
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  ui?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(root);
});

beforeEach(() => {
  providerCalls.length = 0;
  // Each test starts with no earlier check, so the freshness floor never carries over.
  mkdirSync(join(home, "telemetry"), { recursive: true });
  writeFileSync(pollStatePath(home), "{}");
});

afterEach(() => {
  setLivePolling(home, false);
  setBudgetCapture(home, false);
  try {
    unbindBudgetSource(home, { source: "codex_rollout", codexHome: codexDir });
  } catch {
    // not bound
  }
});

function optIn(): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "codex_rollout", account: "refresh-codex", codexHome: codexDir });
}

// ------------------------------------------------------------------ Refresh

describe("POST /api/budget/collection/refresh", () => {
  it("with live polling off (the default) collects locally and asks nobody", async () => {
    optIn();
    const { status, body } = await call("/api/budget/collection/refresh", { body: {} });
    expect(status).toBe(200);
    expect(body.collect.poll).toMatchObject({ enabled: false, skippedReason: "live_polling_off", outcomes: [] });
    expect(body.polling).toMatchObject({ livePolling: false, active: false });
    expect(providerCalls).toEqual([]);
  });

  it("with live polling on asks the provider once, stores the reading and reports it; a second press inside a minute asks nobody", async () => {
    optIn();
    setLivePolling(home, true);
    const first = await call("/api/budget/collection/refresh", { body: {} });
    expect(first.status).toBe(200);
    expect(first.body.collect.poll.outcomes).toEqual([
      expect.objectContaining({ poller: "codex", accountRef: "refresh-codex", outcome: "stored", storedCount: 2, failure: null }),
    ]);
    expect(providerCalls).toEqual([CODEX_USAGE_URL]);
    const budget = await call("/api/budget");
    const account = budget.body.accounts.find((a: { accountRef: string }) => a.accountRef === "refresh-codex");
    expect(account.limits.map((l: { limitKey: string; remainingPercent: number }) => [l.limitKey, l.remainingPercent])).toEqual([
      ["codex.primary", 79],
      ["codex.secondary", 56],
    ]);
    const again = await call("/api/budget/collection/refresh", { body: {} });
    expect(again.body.collect.poll.outcomes[0].outcome).toBe("fresh");
    expect(providerCalls).toEqual([CODEX_USAGE_URL]);
    // No secret in the answer the page gets, the poll state or the log.
    for (const text of [JSON.stringify(first.body), readFileSync(pollStatePath(home), "utf8"), readFileSync(join(home, "logs", "budget-collect.log"), "utf8")]) {
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("someone@example.com");
    }
  });

  it("is accepted from a foreign Origin (the phone on the tailnet), and still needs the token", async () => {
    optIn();
    const phone = await call("/api/budget/collection/refresh", { body: {}, origin: FOREIGN });
    expect(phone.status).toBe(200);
    expect(phone.body.collect).toBeDefined();
    const noToken = await realFetch(`${origin}/api/budget/collection/refresh`, { method: "POST", headers: { origin: FOREIGN } });
    expect(noToken.status).toBe(401);
  });

  it("is POST-only", async () => {
    expect((await call("/api/budget/collection/refresh")).status).toBe(405);
  });

  /**
   * The exemption is ONE route. Every route the server names (read from its source, as the
   * route golden in contract-http.test.ts reads it) is POSTed from the foreign Origin: each
   * must refuse, with 403 cross_origin when it is a write and 405 when it takes no POST,
   * except Refresh. A second exemption, or a family rule that swept one in, fails here.
   */
  it("leaves every other write refusing a foreign Origin", async () => {
    const source = readFileSync(join(REPO_ROOT, "src/ui/server.ts"), "utf8");
    const routes = [
      ...new Set(
        [...source.matchAll(/(?:url\.pathname === |case )"(\/api\/[a-z/-]+)"|"(\/api\/[a-z/-]+)": "/g)].map((m) => (m[1] ?? m[2])!),
      ),
    ].sort();
    expect(routes).toContain("/api/budget/collection/refresh");
    const accepted: string[] = [];
    for (const route of routes) {
      const { status, body } = await call(route, { body: {}, origin: FOREIGN });
      if (status === 405) continue;
      if (status === 403 && body.detail?.reason === "cross_origin") continue;
      accepted.push(`${route} ${status}`);
    }
    expect(accepted).toEqual(["/api/budget/collection/refresh 200"]);
  });
});

// ------------------------------------------------------------------ the switch and its status

describe("live polling's switch and status", () => {
  it("GET /api/budget/polling reads the switch and each bound account's last check, and asks nobody", async () => {
    optIn();
    const off = await call("/api/budget/polling");
    expect(off.body).toEqual({
      livePolling: false,
      active: false,
      budgetCapture: true,
      providers: [
        { poller: "codex", name: "Codex", host: "chatgpt.com", provider: "openai", accountRef: "refresh-codex", dir: codexDir, lastAttemptAt: null, lastSuccessAt: null, failure: null, retryAt: null, idle: [] },
      ],
    });
    expect(providerCalls).toEqual([]);
  });

  it("POST /api/budget/live turns it on and off, from this computer only", async () => {
    optIn();
    expect((await call("/api/budget/live", { body: { enabled: true }, origin: FOREIGN })).status).toBe(403);
    expect(budgetConfig(home).livePolling).toBe(false);
    const on = await call("/api/budget/live", { body: { enabled: true } });
    expect(on).toMatchObject({ status: 200, body: { livePolling: true } });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).telemetry.livePolling).toBe(true);
    const off = await call("/api/budget/live", { body: { enabled: false } });
    expect(off.body.livePolling).toBe(false);
    // Off removes the key: the file reads as before anybody opted in.
    expect("livePolling" in JSON.parse(readFileSync(join(home, "config.json"), "utf8")).telemetry).toBe(false);
    expect((await call("/api/budget/live", { body: { enabled: "yes" } })).body.code).toBe("validation");
  });
});

// ------------------------------------------------------------------ the CLI and setup

describe("staple budget live, setup --live and collect", () => {
  function cli(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", ...args], {
      cwd: REPO_ROOT,
      env: bareEnv({ STAPLE_HOME: home, HOME: root, CODEX_HOME: codexDir, CLAUDE_CONFIG_DIR: join(root, "claude-unbound") }),
      timeout: 30_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  }

  it("`live on` without --yes says what it would ask and changes nothing (exit 2); with --yes it is on; `live off` needs no --yes", () => {
    optIn();
    const refused = cli(["live", "on", "--json"]);
    expect(refused.status).toBe(2);
    const envelope = JSON.parse(refused.stderr.trim().split("\n").at(-1)!);
    expect(envelope).toMatchObject({ code: "validation", detail: { reason: "consent_required", hosts: ["Codex (chatgpt.com)"] } });
    expect(budgetConfig(home).livePolling).toBe(false);
    expect(cli(["live", "on", "--yes"]).status).toBe(0);
    expect(budgetConfig(home).livePolling).toBe(true);
    expect(JSON.parse(cli(["live", "--json"]).stdout)).toMatchObject({ livePolling: true, active: true });
    expect(cli(["live", "off"]).status).toBe(0);
    expect(budgetConfig(home).livePolling).toBe(false);
  }, 60_000);

  it("`collect --json` reports the poll beside the passive scan, and asks nobody with live polling off", () => {
    optIn();
    const result = cli(["collect", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).poll).toMatchObject({ enabled: false, skippedReason: "live_polling_off" });
  }, 30_000);

  it("setup --live turns live polling on as one more planned step, and unsetup turns it back off", () => {
    const deps: CollectionDeps = { home, env: { CODEX_HOME: codexDir }, platform: "linux", userHome: root, staple: null, now: () => "2026-01-10T09:00:00.000Z" };
    const options = { codexAccount: "refresh-codex", watcher: false, statusline: false, livePolling: true };
    const plan = planBudgetSetup(options, deps);
    const step = plan.steps.find((s) => s.part === "live_polling")!;
    expect(step.action).toBe("change");
    expect(step.summary).toContain("chatgpt.com");
    expect(step.summary).not.toContain("api.anthropic.com");
    expect(budgetConfig(home).livePolling).toBe(false);
    applyBudgetSetup(options, deps);
    expect(budgetConfig(home).livePolling).toBe(true);
    expect(readSetupRecord(home)?.livePolling).toEqual({ before: false });
    expect(planBudgetSetup(options, deps).steps.find((s) => s.part === "live_polling")!.action).toBe("unchanged");
    const undone = applyBudgetUnsetup(deps);
    expect(undone.applied.map((s) => s.part)).toContain("live_polling");
    expect(budgetConfig(home).livePolling).toBe(false);
  });

  it("collectBudgetNow runs the passive scan and the poll as one run", async () => {
    optIn();
    setLivePolling(home, true);
    const result = await collectBudgetNow({}, { home });
    expect(result.skippedReason).toBeNull();
    expect(result.poll.outcomes.map((o) => [o.poller, o.outcome])).toEqual([["codex", "stored"]]);
    expect(providerCalls).toEqual([CODEX_USAGE_URL]);
  });
});
