/**
 * The Usage page with live checks, against REAL payloads.
 *
 * A scratch machine links a Claude folder and a Codex home, turns live checks on, and runs
 * one real collection (`collectBudgetNow`, what Refresh and `staple budget collect` run)
 * with a stub provider in front of `fetch` and stub stored sign-ins: Claude refuses the
 * sign-in (401) and Codex answers with its 5-hour window not started and its weekly window
 * in use. The page is then rendered from what the real server serves (`/api/budget`,
 * `/api/budget/polling`) and from that run's own result. Nothing here reads a real keychain
 * or reaches a provider.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshLines } from "@/lib/live-usage";
import type { PollingStatus, RefreshResult } from "@/lib/telemetry-types";
import type { BudgetView } from "@/lib/types";
import { BudgetReportView } from "./BudgetView";
import { tokenCountLine, sessionMetaLine, writeRollout, epoch } from "../../../../../../test/fixtures/budget-support.ts";
import { bindBudgetSource, setBudgetCapture, setLivePolling } from "../../../../../core/telemetry/budget-config.ts";
import { collectBudgetNow } from "../../../../../core/telemetry/collection/service.ts";
import { claudeKeychainServices } from "../../../../../core/telemetry/polling/claude.ts";
import { CODEX_USAGE_URL } from "../../../../../core/telemetry/polling/codex.ts";
import { usagePollingStatus } from "../../../../../core/telemetry/polling/run.ts";
import { setClock } from "../../../../../core/types.ts";
import { startUiServer } from "../../../../server.ts";

/** One of `FIXTURE_SESSION_IDS`, so the real-home guard recognises a leaked row. */
const CODEX_SESSION = "44444444-0000-7000-8000-000000000001";
const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
/** Read six hours after the rollout: its 5-hour window has elapsed, its weekly one has not. */
const READ_AT = T0 + 6 * 3600_000;

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let view: BudgetView;
let polling: PollingStatus;
let refreshed: RefreshResult;
const previousHome = process.env.STAPLE_HOME;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-usage-live-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const claudeDir = join(home, "claude");
  const codexDir = join(home, "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "live-claude", configDir: claudeDir });
  bindBudgetSource(home, { source: "codex_rollout", account: "live-codex", codexHome: codexDir });
  writeRollout(codexDir, CODEX_SESSION, iso(-1), [
    sessionMetaLine({ id: CODEX_SESSION, timestamp: iso(-1) }),
    tokenCountLine({
      timestamp: iso(0),
      primary: { used_percent: 30, window_minutes: 300, resets_at: epoch(iso(120)) },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch(iso(60 * 24 * 3)) },
    }),
  ]);
  setLivePolling(home, true);
  setClock(() => READ_AT);
  const now = () => new Date(READ_AT).toISOString();
  const readAtSeconds = READ_AT / 1000;
  const stub = (async (input: RequestInfo | URL) =>
    String(input) === CODEX_USAGE_URL
      ? new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: readAtSeconds + 18_000 },
              secondary_window: { used_percent: 43, limit_window_seconds: 604_800, reset_after_seconds: 3 * 86_400 - 6 * 3600, reset_at: epoch(iso(60 * 24 * 3)) },
            },
          }),
          { status: 200 },
        )
      : new Response("{}", { status: 401 })) as typeof fetch;
  const token = `x.${Buffer.from(JSON.stringify({ exp: readAtSeconds + 86_400 })).toString("base64url")}.y`;
  const secrets = {
    keychain: async (service: string) =>
      service === claudeKeychainServices(claudeDir)[0] ? JSON.stringify({ claudeAiOauth: { accessToken: "claude-token", expiresAt: READ_AT + 3_600_000, scopes: ["user:profile"] } }) : null,
    file: (path: string) => (path === join(codexDir, "auth.json") ? JSON.stringify({ tokens: { access_token: token, account_id: "acct" } }) : null),
  };
  const collect = await collectBudgetNow({ manual: true }, { home, now, poll: { fetch: stub, secrets, platform: "darwin", userName: "someone" } });
  refreshed = { collect: collect as unknown as RefreshResult["collect"], polling: usagePollingStatus(home) as PollingStatus };
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  view = await get("/api/budget");
  polling = await get("/api/budget/polling");
}, 60_000);

afterAll(() => {
  ui?.close();
  setClock(null);
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

const render = (refresh?: { busy: boolean; lines: ReturnType<typeof refreshLines> | null; finishedAt: number | null }) =>
  renderToStaticMarkup(<BudgetReportView view={view} heldSeconds={0} onRefresh={() => {}} polling={polling} refresh={refresh} />);

function accountHtml(html: string, account: string): string {
  const start = html.indexOf(`data-account="${account}"`);
  expect(start, account).toBeGreaterThan(-1);
  const end = html.indexOf("data-account=", start + 20);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("the Usage page with live checks on", () => {
  it("says in plain words why an account could not be checked, instead of a silent old figure", () => {
    const claude = text(accountHtml(render(), "live-claude"));
    expect(claude).toContain("We couldn't check Claude just now. Claude turned down the sign-in on this computer. Sign in to Claude Code again");
  });

  it("says when an account was last checked, shows the fresh reading, and names a window that has not started as full, not unknown", () => {
    const html = accountHtml(render(), "live-codex");
    const codex = text(html);
    expect(codex).toContain("Checked with Codex just now.");
    expect(html).toContain('data-limit="codex.secondary"');
    expect(codex).toContain("57% left");
    expect(html).toContain('data-limit-idle="codex.primary"');
    expect(codex).toContain("5-hour limit: nothing used since it last reset, so the full allowance is there.");
    expect(codex).not.toContain("can't be read yet");
  });

  it("Refresh shows it is working, then what it did per provider", () => {
    const busy = render({ busy: true, lines: null, finishedAt: null });
    expect(busy).toMatch(/data-testid="budget-refresh"[^>]*disabled=""|disabled=""[^>]*data-testid="budget-refresh"/);
    expect(text(busy)).toContain("Checking…");
    const lines = refreshLines(refreshed, READ_AT);
    expect(lines).toEqual([
      { tone: "warn", text: expect.stringMatching(/^Claude turned down the sign-in on this computer\. Sign in to Claude Code again/) },
      { tone: "ok", text: "Codex: updated just now." },
    ]);
    const done = text(render({ busy: false, lines, finishedAt: Date.now() }));
    expect(done).toContain("Refresh");
    expect(done).toContain("Codex: updated just now.");
    // A minute on, "just now" is no longer true, so the lines are gone.
    expect(text(render({ busy: false, lines, finishedAt: Date.now() - 61_000 }))).not.toContain("Codex: updated just now.");
  });

  it("with every provider answering, Refresh says just 'Updated just now'; with live checks off it says what that means", () => {
    const allGood: RefreshResult = {
      ...refreshed,
      collect: { ...refreshed.collect, poll: { ...refreshed.collect.poll, outcomes: refreshed.collect.poll.outcomes.filter((o) => o.outcome === "stored") } },
    };
    expect(refreshLines(allGood, READ_AT)).toEqual([{ tone: "ok", text: "Updated just now." }]);
    const off: RefreshResult = { ...refreshed, collect: { ...refreshed.collect, poll: { at: refreshed.collect.poll.at, enabled: false, skippedReason: "live_polling_off", outcomes: [] } } };
    expect(refreshLines(off, READ_AT).map((line) => line.text)).toEqual([
      "Updated just now from what this computer has recorded.",
      "Live checks are off, so new Claude and Codex readings only arrive while those tools are running. Turn them on under Settings, Usage.",
    ]);
  });
});
