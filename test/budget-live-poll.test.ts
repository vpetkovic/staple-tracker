/**
 * Live usage polling (docs/execution-telemetry.md, "Live polling"): the two pollers, the
 * runner that schedules them, and the store rule that lets an authoritative reading
 * correct a window. Everything runs against a scratch staple home with a fake `fetch` and
 * fake stored sign-ins: no test here reads a real keychain or credential file, or makes a
 * network call.
 *
 * The response bodies copy the shape of real answers from the two endpoints (2026-09-28),
 * with the account's identifiers and every value that is not a limit replaced.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { BudgetStore, type BudgetReading } from "../src/core/telemetry/budget-store.js";
import { bindBudgetSource, setBudgetCapture, setLivePolling, budgetConfig } from "../src/core/telemetry/budget-config.js";
import { readBudget } from "../src/core/telemetry/read-budget.js";
import { CLAUDE_OAUTH_BETA, CLAUDE_USAGE_URL, claudeKeychainServices, claudePoller, parseClaudeUsage } from "../src/core/telemetry/polling/claude.js";
import { CODEX_USAGE_URL, codexPoller, parseCodexUsage } from "../src/core/telemetry/polling/codex.js";
import { USAGE_POLLERS } from "../src/core/telemetry/polling/registry.js";
import { MANUAL_MIN_SECONDS, SCHEDULED_MIN_SECONDS, pollStatePath, runUsagePollers, usagePollingStatus, type PollDeps } from "../src/core/telemetry/polling/run.js";
import type { PollContext, SecretReader, UsagePoller } from "../src/core/telemetry/polling/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

// ------------------------------------------------------------------ fixtures

const T0 = "2026-01-10T09:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

/** A token-shaped secret: every test checks it never leaves the request headers. */
const CLAUDE_TOKEN = "sk-ant-oat01-SECRET-claude-token-do-not-leak";
const CODEX_TOKEN = jwt({ exp: Date.parse("2026-02-01T00:00:00Z") / 1000, marker: "SECRET-codex-token-do-not-leak" });
const CODEX_ACCOUNT = "acct-SECRET-account-id";

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.signature`;
}

const claudeCredentials = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: CLAUDE_TOKEN,
      refreshToken: "SECRET-refresh",
      expiresAt: Date.parse("2026-01-10T12:00:00Z"),
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
      ...overrides,
    },
  });

const codexAuth = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "SECRET-id", access_token: CODEX_TOKEN, refresh_token: "SECRET-refresh", account_id: CODEX_ACCOUNT, ...overrides }, last_refresh: T0 });

/** The shape of `GET /api/oauth/usage` (Claude Code 2.1.283's `/usage`). */
const claudeBody = (fiveHour: number, sevenDay: number, fiveHourReset: string | null = "2026-01-10T13:30:00.373081+00:00") => ({
  five_hour: { utilization: fiveHour, resets_at: fiveHourReset, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: sevenDay, resets_at: "2026-01-14T04:00:00.373107+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 3.0, resets_at: "2026-01-14T04:00:00+00:00" },
  iguana_necktie: { utilization: 0.0, resets_at: "2026-02-05T07:59:00+00:00", limit_dollars: 250, used_dollars: 0.0, remaining_dollars: 250.0, locked_reason: null },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [{ kind: "session", group: "session", percent: fiveHour, severity: "normal", resets_at: fiveHourReset, scope: null, is_active: true }],
  seven_day_breakdown: { as_of: T0, window_started_at: "2026-01-07T04:00:00+00:00", rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }] },
});

/** The shape of `GET /backend-api/wham/usage` (codex-cli 0.158's `/status`). */
const codexBody = (primary: Record<string, unknown>, secondary: Record<string, unknown> | null) => ({
  user_id: "user-SECRET-user-id",
  account_id: CODEX_ACCOUNT,
  email: "someone@example.com",
  plan_type: "plus",
  rate_limit: { allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
});

const epochOf = (iso: string): number => Date.parse(iso) / 1000;

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly redirect: string | undefined;
}

/** A fetch that answers from a table and records every request. */
function fakeFetch(answer: (url: string) => Response | Promise<Response> | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    const result = await answer(url);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function fakeSecrets(input: { keychain?: Record<string, string>; files?: Record<string, string> }): SecretReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async keychain(service, account) {
      asked.push(`${account}/${service}`);
      return input.keychain?.[service] ?? null;
    },
    file(path) {
      return input.files?.[path] ?? null;
    },
  };
}

let home: string;
let claudeDir: string;
let codexDir: string;

beforeEach(() => {
  home = tempDir("live-poll");
  claudeDir = join(home, "harness", "claude");
  codexDir = join(home, "harness", "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
});

afterEach(() => removeDir(home));

function bindBoth(): void {
  bindBudgetSource(home, { source: "claude_code_statusline", account: "poll-claude", configDir: claudeDir });
  bindBudgetSource(home, { source: "codex_rollout", account: "poll-codex", codexHome: codexDir });
}

function context(overrides: Partial<PollContext> = {}): PollContext {
  return {
    fetch: fakeFetch(() => new Error("no network in this test")).fetch,
    now: () => T0,
    platform: "darwin",
    userName: "someone",
    secrets: fakeSecrets({}),
    timeoutMs: 10_000,
    ...overrides,
  };
}

const claudeBinding = () => budgetConfig(home).bindings.find((b) => b.source === "claude_code_statusline")!;
const codexBinding = () => budgetConfig(home).bindings.find((b) => b.source === "codex_rollout")!;

function samples(): Array<{ limitKey: string; usedPercent: number | null; source: string; field: string; windowId: string | null; observedAt: string }> {
  const hub = Hub.openAt(home);
  try {
    return new BudgetStore(hub.db).listSamples().map((s) => ({ limitKey: s.limitKey, usedPercent: s.usedPercent, source: s.source.kind, field: s.source.field, windowId: s.windowId, observedAt: s.observedAt }));
  } finally {
    hub.close();
  }
}

/** Everything staple wrote into its home, as text. A token must appear in none of it. */
function everythingWritten(): string {
  const texts: string[] = [];
  for (const path of [pollStatePath(home), join(home, "logs", "budget-collect.log"), join(home, "config.json")]) {
    if (existsSync(path)) texts.push(readFileSync(path, "utf8"));
  }
  const hub = join(home, "hub.db");
  if (existsSync(hub)) texts.push(readFileSync(hub).toString("latin1"));
  return texts.join("\n");
}

const SECRETS = ["SECRET", CLAUDE_TOKEN, CODEX_TOKEN, CODEX_ACCOUNT, "someone@example.com"];

// ------------------------------------------------------------------ Claude

describe("the Claude poller", () => {
  beforeEach(bindBoth);

  it("reads the five-hour and weekly limits under the status line's limit keys, and ignores everything else in the answer", () => {
    const parsed = parseClaudeUsage(claudeBody(5, 2), T0)!;
    const readings = parsed.items.flatMap((item) => (item.kind === "reading" ? [item.reading] : []));
    expect(readings.map((r) => [r.limitKey, r.usedPercent, r.resetsAt, r.windowSeconds, r.windowSecondsSource])).toEqual([
      ["five_hour", 5, "2026-01-10T13:30:00.373Z", 18_000, "documented"],
      ["seven_day", 2, "2026-01-14T04:00:00.373Z", 604_800, "documented"],
    ]);
    expect(readings[0]).toMatchObject<Partial<BudgetReading>>({
      unit: "percent_of_limit",
      method: "observed",
      confidence: "medium",
      source: { kind: "usage_poll", harnessVersion: null, field: "oauth/usage.five_hour" },
      observedAt: T0,
      observedAtSource: "provider",
      sessionRef: null,
      missing: { planTier: "not_reported_by_source", sessionRef: "not_reported_by_source" },
    });
    expect(parsed.idle).toEqual([]);
  });

  it("names a limit with no reset instant as idle (no window running) and stores nothing for it", () => {
    const parsed = parseClaudeUsage(claudeBody(0, 2, null), T0)!;
    expect(parsed.idle).toEqual(["five_hour"]);
    expect(parsed.items.filter((item) => item.kind === "reading").map((item) => (item.kind === "reading" ? item.reading.limitKey : ""))).toEqual(["seven_day"]);
  });

  it("asks the OAuth usage endpoint with the keychain sign-in of the default config directory, and sends the token nowhere else", async () => {
    const secrets = fakeSecrets({ keychain: { "Claude Code-credentials": claudeCredentials() } });
    const net = fakeFetch(() => ok(claudeBody(5, 2)));
    // The default directory is the OS home's `.claude`; the fixture binding stands in for it.
    const binding = { ...claudeBinding(), configDir: join(process.env.HOME!, ".claude") };
    const result = await claudePoller.poll(binding, context({ secrets, fetch: net.fetch }));
    expect(result.ok).toBe(true);
    expect(secrets.asked).toEqual(["someone/Claude Code-credentials"]);
    expect(net.calls).toEqual([
      {
        url: CLAUDE_USAGE_URL,
        headers: { Authorization: `Bearer ${CLAUDE_TOKEN}`, "anthropic-beta": CLAUDE_OAUTH_BETA, Accept: "application/json", "User-Agent": "staple-usage-poll" },
        redirect: "error",
      },
    ]);
  });

  it("reads a non-default config directory only from that directory's own keychain item or file, never the default login", async () => {
    const services = claudeKeychainServices(claudeDir);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    const secrets = fakeSecrets({ keychain: { "Claude Code-credentials": claudeCredentials() } });
    const result = await claudePoller.poll(claudeBinding(), context({ secrets }));
    expect(result).toMatchObject({ ok: false, code: "signed_out" });
    expect(secrets.asked).toEqual([`someone/${services[0]}`]);
    // Its own item works.
    const own = fakeSecrets({ keychain: { [services[0]!]: claudeCredentials() } });
    const net = fakeFetch(() => ok(claudeBody(5, 2)));
    expect((await claudePoller.poll(claudeBinding(), context({ secrets: own, fetch: net.fetch }))).ok).toBe(true);
  });

  it("falls back to <config dir>/.credentials.json, and off macOS reads only that file", async () => {
    const files = { [join(claudeDir, ".credentials.json")]: claudeCredentials() };
    const net = fakeFetch(() => ok(claudeBody(5, 2)));
    const secrets = fakeSecrets({ files });
    expect((await claudePoller.poll(claudeBinding(), context({ secrets, fetch: net.fetch, platform: "linux" }))).ok).toBe(true);
    expect(secrets.asked).toEqual([]);
  });

  it("says 'Sign in to Claude Code again' for an expired sign-in, and never sends it", async () => {
    const services = claudeKeychainServices(claudeDir);
    const secrets = fakeSecrets({ keychain: { [services[0]!]: claudeCredentials({ expiresAt: Date.parse(T0) - 1 }) } });
    const net = fakeFetch(() => ok(claudeBody(5, 2)));
    const result = await claudePoller.poll(claudeBinding(), context({ secrets, fetch: net.fetch }));
    expect(result).toMatchObject({ ok: false, code: "expired" });
    expect(!result.ok && result.message).toContain("Sign in to Claude Code again");
    expect(net.calls).toEqual([]);
  });

  it("refuses a setup token (no user:profile scope) without sending it", async () => {
    const services = claudeKeychainServices(claudeDir);
    const secrets = fakeSecrets({ keychain: { [services[0]!]: claudeCredentials({ scopes: ["user:inference"] }) } });
    const net = fakeFetch(() => ok(claudeBody(5, 2)));
    expect(await claudePoller.poll(claudeBinding(), context({ secrets, fetch: net.fetch }))).toMatchObject({ ok: false, code: "unsupported_login" });
    expect(net.calls).toEqual([]);
  });

  it("words each HTTP failure plainly and never quotes the response or the error, which could carry the token", async () => {
    const services = claudeKeychainServices(claudeDir);
    const secrets = fakeSecrets({ keychain: { [services[0]!]: claudeCredentials() } });
    const cases: Array<[() => Response | Error, string]> = [
      [() => new Response(`{"error":"invalid token ${CLAUDE_TOKEN}"}`, { status: 401 }), "rejected"],
      [() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }), "rate_limited"],
      [() => new Response(`oops ${CLAUDE_TOKEN}`, { status: 503 }), "provider_error"],
      [() => new Response(`not json ${CLAUDE_TOKEN}`, { status: 200 }), "unexpected_response"],
      [() => new Error(`connect ECONNREFUSED while sending Bearer ${CLAUDE_TOKEN}`), "network"],
      [() => Object.assign(new Error(`timed out ${CLAUDE_TOKEN}`), { name: "TimeoutError" }), "timeout"],
      [() => ok({ unrelated: true }), "unexpected_response"],
    ];
    for (const [answer, code] of cases) {
      const result = await claudePoller.poll(claudeBinding(), context({ secrets, fetch: fakeFetch(answer).fetch }));
      expect(result, code).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      if (code === "rejected") expect(!result.ok && result.message).toContain("Sign in to Claude Code again");
      if (code === "rate_limited") expect(result).toMatchObject({ retryAfterSeconds: 120 });
    }
  });
});

// ------------------------------------------------------------------ Codex

describe("the Codex poller", () => {
  beforeEach(bindBoth);

  const PRIMARY_RESET = epochOf("2026-01-10T12:00:00Z");
  const SECONDARY_RESET = epochOf("2026-01-15T08:00:00Z");

  it("reads the primary and secondary windows as codex.primary and codex.secondary, as a rollout does, with the plan and the observed length", () => {
    const parsed = parseCodexUsage(
      codexBody(
        { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: PRIMARY_RESET },
        { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 424_800, reset_at: SECONDARY_RESET },
      ),
      T0,
    )!;
    const readings = parsed.items.flatMap((item) => (item.kind === "reading" ? [item.reading] : []));
    expect(readings.map((r) => [r.limitKey, r.usedPercent, r.resetsAt, r.windowSeconds, r.windowSecondsSource, r.planTier, r.source.field])).toEqual([
      ["codex.primary", 12, "2026-01-10T12:00:00.000Z", 18_000, "observed", "plus", "wham/usage.rate_limit.primary_window"],
      ["codex.secondary", 40, "2026-01-15T08:00:00.000Z", 604_800, "observed", "plus", "wham/usage.rate_limit.secondary_window"],
    ]);
    // The account's email and ids are in the answer and in no reading.
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(JSON.stringify(parsed)).not.toContain("someone@example.com");
  });

  it("names a window that has not started (0% and a reset a full window away) as idle instead of minting a window per check", () => {
    const parsed = parseCodexUsage(
      codexBody({ used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: epochOf(T0) + 18_000 }, { used_percent: 11, limit_window_seconds: 604_800, reset_after_seconds: 500_000, reset_at: SECONDARY_RESET }),
      T0,
    )!;
    expect(parsed.idle).toEqual(["codex.primary"]);
    expect(parsed.items.filter((item) => item.kind === "reading")).toHaveLength(1);
  });

  it("asks wham/usage with the access token and account id from <codex home>/auth.json", async () => {
    const net = fakeFetch(() => ok(codexBody({ used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: PRIMARY_RESET }, null)));
    const secrets = fakeSecrets({ files: { [join(codexDir, "auth.json")]: codexAuth() } });
    expect((await codexPoller.poll(codexBinding(), context({ secrets, fetch: net.fetch }))).ok).toBe(true);
    expect(net.calls).toEqual([
      {
        url: CODEX_USAGE_URL,
        headers: { Authorization: `Bearer ${CODEX_TOKEN}`, "ChatGPT-Account-Id": CODEX_ACCOUNT, Accept: "application/json", "User-Agent": "staple-usage-poll" },
        redirect: "error",
      },
    ]);
  });

  it("reports a missing, expired or API-key sign-in without sending anything", async () => {
    const net = fakeFetch(() => ok({}));
    const path = join(codexDir, "auth.json");
    const expired = jwt({ exp: epochOf(T0) - 60 });
    const results = [
      await codexPoller.poll(codexBinding(), context({ fetch: net.fetch, secrets: fakeSecrets({}) })),
      await codexPoller.poll(codexBinding(), context({ fetch: net.fetch, secrets: fakeSecrets({ files: { [path]: codexAuth({ access_token: expired }) } }) })),
      await codexPoller.poll(codexBinding(), context({ fetch: net.fetch, secrets: fakeSecrets({ files: { [path]: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-SECRET" }) } }) })),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["signed_out", "expired", "unsupported_login"]);
    expect(!results[1]!.ok && results[1]!.message).toContain("Sign in to Codex again");
    expect(JSON.stringify(results)).not.toContain("SECRET");
    expect(net.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ the runner

describe("a poll run", () => {
  const PRIMARY_RESET = epochOf("2026-01-10T12:00:00Z");
  let net: ReturnType<typeof fakeFetch>;
  let secrets: ReturnType<typeof fakeSecrets>;

  beforeEach(() => {
    bindBoth();
    net = fakeFetch((url) =>
      url === CLAUDE_USAGE_URL
        ? ok(claudeBody(5, 2))
        : ok(codexBody({ used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: PRIMARY_RESET }, null)),
    );
    secrets = fakeSecrets({ keychain: { [claudeKeychainServices(claudeDir)[0]!]: claudeCredentials() }, files: { [join(codexDir, "auth.json")]: codexAuth() } });
  });

  const deps = (now: string, extra: Partial<PollDeps> = {}): PollDeps => ({ home, now: () => now, fetch: net.fetch, secrets, platform: "darwin", userName: "someone", ...extra });

  it("is off by default: a fresh home with capture on and both homes bound asks nobody and reads no sign-in", async () => {
    setBudgetCapture(home, true);
    expect(budgetConfig(home).livePolling).toBe(false);
    const run = await runUsagePollers({}, deps(T0));
    expect(run).toMatchObject({ enabled: false, skippedReason: "live_polling_off", outcomes: [] });
    expect(net.calls).toEqual([]);
    expect(secrets.asked).toEqual([]);
    expect(existsSync(pollStatePath(home))).toBe(false);
  });

  it("asks nobody while capture is off, even with live polling on", async () => {
    setLivePolling(home, true);
    expect((await runUsagePollers({}, deps(T0))).skippedReason).toBe("capture_disabled");
    expect(net.calls).toEqual([]);
  });

  it("stores each provider's readings through the one store tail, as usage_poll readings the budget view reads unchanged", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    const run = await runUsagePollers({}, deps(T0));
    expect(run.outcomes.map((o) => [o.poller, o.accountRef, o.outcome, o.storedCount, o.failure])).toEqual([
      ["claude", "poll-claude", "stored", 2, null],
      ["codex", "poll-codex", "stored", 1, null],
    ]);
    expect(samples().map((s) => [s.limitKey, s.usedPercent, s.source]).sort()).toEqual([
      ["codex.primary", 12, "usage_poll"],
      ["five_hour", 5, "usage_poll"],
      ["seven_day", 2, "usage_poll"],
    ]);
    const view = readBudget(home, { now: at(60) });
    const claude = view.accounts.find((a) => a.accountRef === "poll-claude")!;
    expect(claude.limits.map((l) => [l.limitKey, l.status, l.remainingPercent, l.stale])).toEqual([
      ["five_hour", "current", 95, false],
      ["seven_day", "current", 98, false],
    ]);
    // One log line per run that asked anybody, with outcomes and no secret.
    const log = readFileSync(join(home, "logs", "budget-collect.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log.at(-1)).toEqual({ at: T0, poll: [
      { poller: "claude", accountRef: "poll-claude", outcome: "stored", storedCount: 2 },
      { poller: "codex", accountRef: "poll-codex", outcome: "stored", storedCount: 1 },
    ] });
    for (const secret of SECRETS) expect(everythingWritten()).not.toContain(secret);
  });

  it("asks a binding at most every 4 minutes on the schedule and every minute on Refresh", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    await runUsagePollers({}, deps(T0));
    expect(net.calls).toHaveLength(2);
    expect((await runUsagePollers({}, deps(at(SCHEDULED_MIN_SECONDS - 1)))).outcomes.map((o) => o.outcome)).toEqual(["fresh", "fresh"]);
    expect((await runUsagePollers({ manual: true }, deps(at(MANUAL_MIN_SECONDS - 1)))).outcomes.map((o) => o.outcome)).toEqual(["fresh", "fresh"]);
    expect(net.calls).toHaveLength(2);
    expect((await runUsagePollers({ manual: true }, deps(at(MANUAL_MIN_SECONDS)))).outcomes.map((o) => o.outcome)).toEqual(["stored", "stored"]);
    expect(net.calls).toHaveLength(4);
    expect((await runUsagePollers({}, deps(at(MANUAL_MIN_SECONDS + SCHEDULED_MIN_SECONDS)))).outcomes.map((o) => o.outcome)).toEqual(["stored", "stored"]);
    expect(net.calls).toHaveLength(6);
  });

  it("keeps a failure's plain reason for the page, waits out a 429's Retry-After, and clears the reason on the next success", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    let claudeAnswer: () => Response = () => new Response("", { status: 429, headers: { "retry-after": "600" } });
    net = fakeFetch((url) => (url === CLAUDE_USAGE_URL ? claudeAnswer() : ok(codexBody({ used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: PRIMARY_RESET }, null))));
    const first = await runUsagePollers({}, deps(T0));
    expect(first.outcomes[0]).toMatchObject({ outcome: "failed", failure: { code: "rate_limited", at: T0 } });
    const deferred = await runUsagePollers({}, deps(at(SCHEDULED_MIN_SECONDS)));
    expect(deferred.outcomes[0]).toMatchObject({ outcome: "deferred", failure: { code: "rate_limited" } });
    expect(usagePollingStatus(home).providers[0]).toMatchObject({ failure: { code: "rate_limited" }, retryAt: at(600) });
    claudeAnswer = () => ok(claudeBody(5, 2));
    const later = await runUsagePollers({}, deps(at(600)));
    expect(later.outcomes[0]).toMatchObject({ outcome: "stored", failure: null, lastSuccessAt: at(600) });
    expect(usagePollingStatus(home).providers[0]).toMatchObject({ failure: null, retryAt: null });
  });

  it("answers busy, asking nobody, while another run holds the poll lock", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = fakeFetch(async () => {
      await held;
      return ok(claudeBody(5, 2));
    });
    const first = runUsagePollers({}, deps(T0, { fetch: slow.fetch }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await runUsagePollers({ manual: true }, deps(T0));
    expect(second.outcomes.map((o) => o.outcome)).toEqual(["busy", "busy"]);
    expect(net.calls).toEqual([]);
    release();
    await first;
  });

  it("stores nothing when live polling is turned off while the provider is being asked", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    const turningOff = fakeFetch((url) => {
      setLivePolling(home, false);
      return url === CLAUDE_USAGE_URL
        ? ok(claudeBody(5, 2))
        : ok(codexBody({ used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 10_800, reset_at: PRIMARY_RESET }, null));
    });
    const run = await runUsagePollers({}, deps(T0, { fetch: turningOff.fetch }));
    expect(run.outcomes.map((o) => o.outcome)).toEqual(["skipped", "skipped"]);
    expect(samples()).toEqual([]);
  });

  it("takes a new provider as one more poller: nothing else learns its name", async () => {
    setBudgetCapture(home, true);
    setLivePolling(home, true);
    bindBudgetSource(home, { source: "claude_code_statusline", account: "acme-team", provider: "acme", configDir: join(home, "harness", "acme") });
    const acme: UsagePoller = {
      id: "acme",
      name: "Acme",
      bindingSource: "claude_code_statusline",
      provider: "acme",
      host: "usage.acme.example",
      isAvailable: (binding) => binding.provider === "acme",
      async poll(_binding, ctx) {
        const reading: BudgetReading = {
          limitKey: "daily",
          unit: "percent_of_limit",
          usedPercent: 30,
          resetsAt: "2026-01-11T00:00:00.000Z",
          resetsAtSource: "observed_absolute",
          windowSeconds: 86_400,
          windowSecondsSource: "observed",
          planTier: null,
          method: "observed",
          confidence: "medium",
          source: { kind: "usage_poll", harnessVersion: null, field: "acme.daily" },
          observedAt: ctx.now(),
          observedAtSource: "provider",
          sessionRef: null,
          missing: {},
        };
        return { ok: true, items: [{ kind: "reading", reading }], idle: [] };
      },
    };
    const run = await runUsagePollers({}, deps(T0, { pollers: [...USAGE_POLLERS, acme] }));
    expect(run.outcomes.map((o) => [o.poller, o.accountRef, o.outcome])).toEqual([
      ["claude", "poll-claude", "stored"],
      ["codex", "poll-codex", "stored"],
      ["acme", "acme-team", "stored"],
    ]);
    expect(readBudget(home, { account: "acme-team", now: at(60) }).accounts[0]!.limits[0]).toMatchObject({ limitKey: "daily", remainingPercent: 70 });
  });
});

// ------------------------------------------------------------------ the correction rule

describe("an authoritative reading can correct the window", () => {
  const RESET = "2026-01-14T04:00:00.000Z";
  const reading = (usedPercent: number, observedAt: string, kind: "usage_poll" | "claude_code_statusline", sessionRef: string | null = null): BudgetReading => ({
    limitKey: "seven_day",
    unit: "percent_of_limit",
    usedPercent,
    resetsAt: RESET,
    resetsAtSource: "observed_absolute",
    windowSeconds: 604_800,
    windowSecondsSource: "documented",
    planTier: null,
    method: "observed",
    confidence: kind === "usage_poll" ? "medium" : "high",
    source: { kind, harnessVersion: null, field: "seven_day" },
    observedAt,
    observedAtSource: kind === "usage_poll" ? "provider" : "capture",
    sessionRef,
    missing: {},
  });

  function record(r: BudgetReading) {
    const hub = Hub.openAt(home);
    try {
      return new BudgetStore(hub.db).record({ reading: r, provider: "anthropic", accountRef: "poll-claude", recordedAt: r.observedAt, attempt: { reason: "no_matching_attempt" } });
    } finally {
      hub.close();
    }
  }

  function windows(): Array<{ id: string; supersededBy: string | null; supersededReason: string | null }> {
    const hub = Hub.openAt(home);
    try {
      return new BudgetStore(hub.db).listWindows({ accountRef: "poll-claude", limitKey: "seven_day" }, at(3600)).map((w) => ({ id: w.id, supersededBy: w.supersededBy, supersededReason: w.supersededReason }));
    } finally {
      hub.close();
    }
  }

  const remaining = () => {
    const hub = Hub.openAt(home);
    try {
      const store = new BudgetStore(hub.db);
      const current = store.listWindows({ accountRef: "poll-claude", limitKey: "seven_day" }, at(3600)).find((w) => w.status === "current")!;
      return store.windowHighWater(current.id)!.remainingPercent;
    } finally {
      hub.close();
    }
  };

  it("supersedes the window (usage_reset) when a poll reads more than a point below its high-water mark, so the figure follows the provider", () => {
    record(reading(35, T0, "claude_code_statusline", "a1b2c3d4e5f60718"));
    expect(remaining()).toBe(65);
    record(reading(2, at(3000), "usage_poll"));
    const [first, second] = windows();
    expect(first).toMatchObject({ supersededBy: second!.id, supersededReason: "usage_reset" });
    expect(second).toMatchObject({ supersededBy: null });
    expect(remaining()).toBe(98);
  });

  it("joins the window when a poll is within a point of the high-water mark (rounding between sources)", () => {
    record(reading(35.4, T0, "claude_code_statusline", "a1b2c3d4e5f60718"));
    record(reading(35, at(600), "usage_poll"));
    expect(windows()).toHaveLength(1);
  });

  it("keeps the high-water mark for a lower PASSIVE reading: an older status-line cache is not evidence of a reset", () => {
    record(reading(35, T0, "claude_code_statusline", "a1b2c3d4e5f60718"));
    record(reading(2, at(600), "claude_code_statusline", "b1b2c3d4e5f60718"));
    expect(windows()).toHaveLength(1);
    expect(remaining()).toBe(65);
  });
});
