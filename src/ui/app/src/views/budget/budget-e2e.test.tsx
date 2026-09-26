/**
 * The Budget view against REAL server payloads.
 *
 * As `detail/forecast-e2e.test.tsx`: the real HTTP server (`src/ui/server.ts`, in this process)
 * serves a machine whose readings were written through the real ingestion
 * (`test/fixtures/budget-pressure-scenario.ts`), and the real component is rendered from what came
 * off the wire with `react-dom/server`. No payload here is hand-written: every figure the
 * assertions name is read from the response, and the assertions pin where the page says it (the
 * measured block or the forecast block), that the unsafe state is a word and a pattern and not a
 * colour alone, and that an unknown is never drawn as 0.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDuration } from "@/lib/forecast-text";
import { perHourText, pressureRatioText } from "@/lib/budget-text";
import type { BudgetLimitReading, BudgetView } from "@/lib/types";
import { BudgetReportView } from "./BudgetView";
import { PRESSURE_ACCOUNTS, seedBudgetPressureScenario } from "../../../../../../test/fixtures/budget-pressure-scenario.ts";
import { setClock } from "../../../../../core/types.ts";
import { startUiServer } from "../../../../server.ts";

const T0 = Date.parse("2026-09-25T10:00:00.000Z");

let home: string;
let bareHome: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let view: BudgetView;
let reserved: BudgetView;
let bare: BudgetView;
const previousHome = process.env.STAPLE_HOME;

async function get<T>(path: string, stapleHome = home): Promise<T> {
  process.env.STAPLE_HOME = stapleHome;
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-budget-ui-e2e-"));
  bareHome = mkdtempSync(join(tmpdir(), "staple-budget-ui-bare-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const scenario = seedBudgetPressureScenario(home, T0);
  setClock(() => scenario.readAt);
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  view = await get("/api/budget");
  reserved = await get("/api/budget?reserve=5");
  bare = await get("/api/budget", bareHome);
}, 60_000);

afterAll(() => {
  ui?.close();
  setClock(null);
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(bareHome, { recursive: true, force: true });
});

const render = (payload: BudgetView, heldSeconds = 0): string => renderToStaticMarkup(<BudgetReportView view={payload} heldSeconds={heldSeconds} onRefresh={() => {}} />);

/** The markup of the element carrying `attribute`, up to its matching close tag. */
function section(html: string, attribute: string): string {
  const start = html.indexOf(attribute);
  expect(start, attribute).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", start);
  const tag = /^<(\w+)/.exec(html.slice(open))![1]!;
  let depth = 0;
  const pattern = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  pattern.lastIndex = open;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, pattern.lastIndex);
  }
  throw new Error(`unclosed ${attribute}`);
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

function limitOf(payload: BudgetView, account: string, key: string): BudgetLimitReading {
  const found = payload.accounts.find((entry) => entry.accountRef === account)?.limits.find((limit) => limit.limitKey === key);
  expect(found, `${account} ${key}`).toBeDefined();
  return found!;
}

/** The card of one limit of one account. */
function card(html: string, account: string, key: string): string {
  return section(section(html, `data-account="${account}"`), `data-limit="${key}"`);
}

describe("a limit within its sustainable pace", () => {
  it("draws the measured figures in the measured block and the forecast in the provisional one", () => {
    const limit = limitOf(view, PRESSURE_ACCOUNTS.within, "five_hour");
    const html = card(render(view), PRESSURE_ACCOUNTS.within, "five_hour");
    expect(html).toContain('data-pressure-state="within"');
    const measured = text(section(html, 'data-block="measured"'));
    const forecast = text(section(html, 'data-block="forecast"'));
    // Measured: remaining, countdown, pace, age, as the payload has them.
    expect(measured).toContain(`${limit.remainingPercent}% left`);
    expect(measured).toContain(formatDuration(limit.pressure.secondsToReset!));
    expect(measured).toContain(perHourText(limit.pressure.observed!.percentPerHour));
    expect(measured).toContain("1m ago · status line");
    // Forecast: sustainable, pressure, safe concurrency not defined, confidence.
    expect(forecast).toMatch(/^Forecast · provisional, as of/);
    expect(forecast).toContain(perHourText(limit.pressure.sustainablePercentPerHour!));
    expect(forecast).toContain(pressureRatioText(limit.pressure.ratio!));
    expect(forecast).toContain("Not defined yet: needs the admission policy");
    expect(forecast).toContain("Medium confidence");
    // No forecast figure in the measured block, and no measured one in the forecast block.
    expect(measured).not.toContain(pressureRatioText(limit.pressure.ratio!));
    expect(forecast).not.toContain(`${limit.remainingPercent}% left`);
  });

  it("ticks the countdown down and the age up by the seconds the page has held the answer", () => {
    const limit = limitOf(view, PRESSURE_ACCOUNTS.within, "five_hour");
    const later = text(section(card(render(view, 125), PRESSURE_ACCOUNTS.within, "five_hour"), 'data-block="measured"'));
    expect(later).toContain(formatDuration(limit.pressure.secondsToReset! - 125));
    expect(later).toContain("3m5s ago");
    // The forecast does not tick: it stays as of the read.
    const forecast = text(section(card(render(view, 125), PRESSURE_ACCOUNTS.within, "five_hour"), 'data-block="forecast"'));
    expect(forecast).toContain(perHourText(limit.pressure.sustainablePercentPerHour!));
  });
});

describe("an unsafe limit", () => {
  it("says unsafe in words, with an icon and a hatched edge, not by colour alone", () => {
    const limit = limitOf(view, PRESSURE_ACCOUNTS.unsafe, "codex.primary");
    expect(limit.pressure.state).toBe("unsafe");
    const html = card(render(view), PRESSURE_ACCOUNTS.unsafe, "codex.primary");
    expect(html).toContain('data-pressure-state="unsafe"');
    expect(html).toContain("data-unsafe-hatch");
    expect(html).toMatch(/data-pressure-badge="unsafe"[^>]*><svg[\s\S]*?<\/svg>Unsafe<\/span>/);
    expect(text(html)).toContain(`Unsafe: pace is ${pressureRatioText(limit.pressure.ratio!)} the sustainable pace (unsafe at ×1.00)`);
    expect(text(section(html, 'data-block="forecast"'))).toContain("before the reset");
    // The header counts it.
    expect(text(render(view))).toContain("1 unsafe limit");
    // Its weekly limit, on the same account, is within.
    expect(card(render(view), PRESSURE_ACCOUNTS.unsafe, "codex.secondary")).toContain('data-pressure-state="within"');
  });

  it("follows the reserve the read was asked with", () => {
    expect(reserved.reserve).toEqual({ percent: 5, source: "argument", note: null });
    expect(text(render(reserved))).toContain("Protected reserve: 5% of each limit, as asked.");
    expect(text(render(view))).toContain("Protected reserve: 20% of each limit, a provisional default until an admission policy sets one.");
  });
});

describe("unknown telemetry is visibly unknown", () => {
  it("keeps a stale window's measured pace and says why nothing is projected", () => {
    const limit = limitOf(view, PRESSURE_ACCOUNTS.stale, "five_hour");
    expect(limit.stale).toBe(true);
    const html = card(render(view), PRESSURE_ACCOUNTS.stale, "five_hour");
    expect(html).toContain('data-pressure-state="unknown"');
    expect(html).toContain("data-stale");
    expect(text(section(html, 'data-block="measured"'))).toContain(perHourText(limit.pressure.observed!.percentPerHour));
    const forecast = text(section(html, 'data-block="forecast"'));
    expect(forecast).toContain("Unknown: the latest reading is over 10 minutes old");
    expect(forecast).not.toMatch(/×\d/);
  });

  it("names a bound account with no reading, and an unbound one with no reset, with their reasons and the setup hint", () => {
    const empty = text(section(render(view), `data-account="${PRESSURE_ACCOUNTS.empty}"`));
    expect(empty).toContain("No reading yet: capture is on and a source is bound");
    const unbound = section(render(view), `data-account="${PRESSURE_ACCOUNTS.unbound}"`);
    expect(unbound).toContain('data-bound="no"');
    expect(unbound).toContain('data-pressure-state="unknown"');
    // One line says why, rather than every figure repeating it.
    expect(text(section(unbound, 'data-testid="budget-no-window"'))).toBe(
      "Unknown: the provider reports no reset time.A reading without a reset instant joins no window; a typed reading takes --resets-at.",
    );
    // Nothing unknown is drawn as a 0.
    expect(text(unbound)).not.toMatch(/\b0%/);
  });

  it("says why a machine with no budget data shows nothing, and what to run", () => {
    expect(bare).toMatchObject({ budgetCapture: false, accounts: [] });
    const html = text(section(render(bare), 'data-testid="budget-none"'));
    expect(html).toContain("Budget capture is off on this machine");
    expect(html).toContain("staple budget setup");
  });
});
