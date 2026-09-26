/**
 * The forecast and calibration pages against REAL server payloads.
 *
 * As in `views/milestones/milestones-e2e.test.tsx`: the real HTTP server (`src/ui/server.ts`, in
 * this process) serves a scenario written through the real store and the real budget ingestion
 * (`test/fixtures/forecast-scenario.ts`), and the real components are rendered from what came off
 * the wire with `react-dom/server`. No payload here is hand-written: every figure the assertions
 * name is read from the response the page was drawn from, and the assertions pin how the page
 * says it, where it says it, and that an unknown is never drawn as 0.
 *
 * The clock is pinned (`setClock`) at the scenario's read instant, so the budget readings are
 * fresh and the reset countdown is a known 3h58m.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asOfText, forecastMode, formatDuration, formatEffort, formatProbability, spreadText, bandText, warningText } from "@/lib/forecast-text";
import type { CalibrationCohort, CalibrationReport, ForecastReport } from "@/lib/types";
import { CalibrationReportView, INCLUDE_RECONSTRUCTED_BY_DEFAULT, calibrationRequest } from "@/views/calibration/CalibrationView";
import { AwaitingForecast, ForecastReportView } from "./ForecastSection";
import { EMPTY_WS, FORECAST_WS, seedForecastScenario, type ForecastScenario } from "../../../../../test/fixtures/forecast-scenario.ts";
import { setClock } from "../../../../core/types.ts";
import { resolveWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";

const T0 = Date.parse("2026-09-25T10:00:00.000Z");

let home: string;
let bareHome: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let scenario: ForecastScenario;
let epic: ForecastReport;
let leaf: ForecastReport;
let empty: ForecastReport;
let settled: ForecastReport;
let noBudget: ForecastReport;
let reviewLeaf: ForecastReport;
let highReserve: ForecastReport;
let exact: CalibrationReport;
let withReconstructed: CalibrationReport;
let emptyCalibration: CalibrationReport;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-forecast-ui-e2e-"));
  bareHome = mkdtempSync(join(tmpdir(), "staple-forecast-ui-bare-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  scenario = seedForecastScenario(home, T0);

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  epic = await get(`/api/forecast?ws=${FORECAST_WS}&ref=${scenario.epic}`);
  leaf = await get(`/api/forecast?ws=${FORECAST_WS}&ref=${scenario.leaf}`);
  empty = await get(`/api/forecast?ws=${EMPTY_WS}&ref=${scenario.emptyEpic}`);
  reviewLeaf = await get(`/api/forecast?ws=${FORECAST_WS}&ref=${scenario.review}`);
  highReserve = await get(`/api/forecast?ws=${FORECAST_WS}&ref=${scenario.epic}&reserve=90`);
  settled = await get(`/api/forecast?ws=${EMPTY_WS}&ref=${scenario.settledEpic}`);
  exact = await get(`/api/calibration?ws=${FORECAST_WS}&limit=500`);
  withReconstructed = await get(`/api/calibration?ws=${FORECAST_WS}&include=reconstructed&limit=500`);
  emptyCalibration = await get(`/api/calibration?ws=${EMPTY_WS}&limit=500`);

  // A machine with no budget data at all: the same store method, read against a bare home.
  const { store } = resolveWorkspace({ ws: FORECAST_WS });
  try {
    noBudget = JSON.parse(JSON.stringify(store.forecast({ ref: scenario.epic }, new Date(scenario.readAt).toISOString(), bareHome))) as ForecastReport;
  } finally {
    store.db.close();
  }
}, 60_000);

afterAll(() => {
  ui?.close();
  setClock(null);
  rmSync(home, { recursive: true, force: true });
  rmSync(bareHome, { recursive: true, force: true });
});

const render = (report: ForecastReport, mode: "full" | "compact" = "full"): string =>
  renderToStaticMarkup(<ForecastReportView report={report} mode={mode} onOpen={() => {}} />);

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

/** Text with the tags stripped and entities decoded, for sentence assertions. */
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

// ------------------------------------------------------------------ the epic

describe("an epic's forecast, as the server computed it", () => {
  it("draws completion and budget as two separate blocks, completion first, and blends nothing", () => {
    const html = render(epic);
    const completion = section(html, 'data-block="completion"');
    const budget = section(html, 'data-block="budget"');
    expect(html.indexOf('data-block="completion"')).toBeLessThan(html.indexOf('data-block="budget"'));
    // The budget block is framed apart and says whose data it is.
    expect(budget).toContain("border-dashed");
    expect(text(budget)).toContain("this machine only");
    // No budget figure in the completion block, and no completion figure in the budget block.
    const labor = formatDuration(epic.completion.labor.expectedSeconds!);
    expect(text(completion)).toContain(labor);
    expect(text(budget)).not.toContain(labor);
    expect(text(completion)).not.toMatch(/work-hour|reserve|resets in/);
  });

  it("states remaining labor and path as lower bounds, with the draws' p10-p90 and 90% band", () => {
    const { labor, path } = epic.completion;
    // The scenario's unestimated unit makes both partial: the page must say "at least".
    expect(labor.partial).toBe(true);
    expect(path.partial).toBe(true);
    const html = render(epic);
    const laborRow = text(section(html, 'data-testid="forecast-labor"'));
    expect(laborRow).toContain(`Remaining labor`);
    expect(laborRow).toContain(`at least ${formatDuration(labor.expectedSeconds!)}`);
    expect(laborRow).toContain(spreadText(labor.simulated!));
    expect(laborRow).toContain(bandText(labor.simulated!));
    expect(bandText(labor.simulated!)).toMatch(/^90% band /);
    expect(laborRow).toContain("(lower bounds)");
    const pathRow = text(section(html, 'data-testid="forecast-path"'));
    expect(pathRow).toContain(`at least ${formatDuration(path.expectedSeconds!)}`);
    expect(pathRow).toContain(spreadText(path.simulated!));
  });

  it("lists the critical path as issue links, first to last, each at its expected remaining work", () => {
    const chain = epic.completion.path.chain;
    expect(chain.map((step) => step.ref)).toEqual([scenario.inProgress, scenario.blocked]);
    const html = section(render(epic), 'aria-label="Critical path chain"');
    const buttons = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(chain.map((step) => step.ref));
    // An identifier never breaks across lines, and keeps its size under a touch screen's 44px floor.
    for (const button of html.match(/<button[^>]*>/g)!) {
      expect(button).toContain('data-size="xs"');
      expect(button).toMatch(/class="[^"]*\bshrink-0\b[^"]*\bwhitespace-nowrap\b/);
    }
    for (const step of chain) expect(text(html)).toContain(formatEffort(step.seconds!));
  });

  it("names the open outside blocker by reference, not only as a chip", () => {
    const open = epic.completion.path.crossSubtreeBlockers.filter((blocker) => !blocker.resolved);
    expect(open.map((blocker) => [blocker.blocked, blocker.blocker])).toEqual([[scenario.blocked, scenario.outside]]);
    const list = section(render(epic), 'data-testid="forecast-outside"');
    const buttons = [...list.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual([scenario.blocked, scenario.outside]);
    expect(text(list)).toContain("waits on");
    expect(render(epic)).toContain('data-warning="unresolved_outside_blockers"');
  });

  it("marks low confidence visibly, with what the bounds reach and why it is not high", () => {
    const confidence = epic.completion.confidence;
    expect(confidence.label).toBe("low");
    const html = render(epic);
    expect(html).toMatch(/data-confidence="low"[^>]*border-dashed/);
    const line = text(section(html, 'data-testid="forecast-confidence"'));
    expect(line).toContain(`Low confidence: the classes' bounds reach ${Math.round(confidence.achieved! * 100)}% of the 90% target.`);
    expect(line).toContain(`Not high because: ${confidence.reasons.map((code) => warningText(code).label.toLowerCase()).join(", ")}.`);
  });

  it("puts every warning in a chip, in the payload's order, with a plain-language tooltip", () => {
    const html = section(render(epic), 'aria-label="Forecast warnings"');
    const codes = [...html.matchAll(/data-warning="([^"]+)"/g)].map((match) => match[1]);
    expect(codes).toEqual(epic.completion.warnings);
    for (const code of epic.completion.warnings) {
      const { label, tip } = warningText(code);
      // A focusable button, whose accessible name carries the sentence; the tooltip and the
      // inline disclosure (both client-side) show the same sentence.
      expect(html).toMatch(new RegExp(`<button type="button" data-size="xs" data-warning="${code}" aria-expanded="false"`));
      expect(text(html)).toContain(`${label}: ${tip}`);
    }
  });

  it("lists the unit in review as not forecast, and the unestimated unit as unknown with its reason", () => {
    expect(epic.completion.units.awaitingReviewRefs).toEqual([scenario.review]);
    expect(epic.completion.units.unknownRefs).toEqual([scenario.unestimated]);
    const html = render(epic);
    const awaiting = text(section(html, 'data-testid="forecast-awaiting"'));
    expect(awaiting).toContain("Not forecast");
    expect(awaiting).toContain(scenario.review);
    const unknown = text(section(html, 'data-testid="forecast-unknown"'));
    expect(unknown).toContain(scenario.unestimated);
    expect(unknown).toContain("no estimate to scale");
    // Neither is anywhere counted as a figure.
    expect(unknown).not.toMatch(/\b0s\b/);
  });

  it("reads each limit on its own: remaining, reset countdown, work rate and breach against the provisional reserve", () => {
    const account = epic.budget.accounts.find((candidate) => candidate.accountRef === "personal-max")!;
    const limit = account.limits.find((candidate) => candidate.limitKey === "five_hour")!;
    expect(limit.workRate).not.toBeNull();
    expect(limit.reserve!.source).toBe("provisional_default");
    const html = section(render(epic), 'data-limit="five_hour"');
    const words = text(html);
    expect(words).toContain(`${Math.round(limit.remainingPercent!)}% left`);
    expect(words).toContain(`resets in ${formatDuration(limit.secondsToReset!)}`);
    expect(formatDuration(limit.secondsToReset!)).toBe("3h58m");
    expect(words).toContain(`${Math.round(limit.workRate!.percentPerWorkHour)}%/work-hour`);
    expect(words).toContain(`low confidence (${limit.workRate!.confidence.spans} of ${limit.workRate!.confidence.minimum} spans)`);
    expect(html).toContain('data-warning="small_sample"');
    // The burn behind it is a lower bound, so the breach chance is one too.
    expect(words).toContain(`at least ${formatProbability(limit.reserve!.breachProbability!)} chance of going under the provisional 20% reserve`);
    expect(words).toContain(`(${asOfText(epic.asOf)})`);
    // The labor is partial, so the burn is a lower bound: it says "at least" and "at most".
    expect(limit.work!.lowerBound).toBe(true);
    expect(words).toContain(`uses at least ${Math.round(limit.work!.consumedPercent.expected)}% and leaves at most ${Math.round(limit.work!.remainingAtResetPercent.expected)}% at the reset`);
    // Other use was not measured: unknown, with the reason, never 0%.
    expect(limit.reserve!.withOtherUse).toBeNull();
    expect(words).toContain("With other use of the account: unknown, too little time measured outside the attempts");
    expect(text(section(render(epic), 'data-testid="budget-reserve"'))).toContain("provisional until an admission policy sets one");
  });

  it("shows an unmeasured work rate as unknown with its reason, and never draws a breach figure from it", () => {
    const codex = epic.budget.accounts.find((candidate) => candidate.accountRef === "codex-plus")!;
    for (const limit of codex.limits) {
      expect(limit.workRate).toBeNull();
      const html = section(render(epic), `data-limit="${limit.limitKey}"`);
      const rate = section(html, 'data-testid="budget-rate"');
      expect(rate).toContain("data-unknown");
      expect(text(rate)).toBe("Work rate unknown: no attempt of this workspace was measured on this account");
      const breach = section(html, 'data-testid="budget-breach"');
      expect(breach).toContain("data-unknown");
      expect(text(breach)).toBe("Chance of going under the reserve unknown: no measured work rate");
      expect(text(breach)).not.toMatch(/\d+%/);
    }
  });

  it("keeps the snapshot ids in a closed Data disclosure", () => {
    const html = section(render(epic), 'data-testid="forecast-data"');
    expect(html.startsWith("<details")).toBe(true);
    expect(html).not.toContain(" open");
    for (const id of [epic.snapshot.id, epic.snapshot.calibration.id, epic.snapshot.budget.id]) expect(html).toContain(id);
  });
});

describe("the other forecast states", () => {
  it("gives an open estimated leaf the compact forecast: its remaining work, no path, no unit lists", () => {
    expect(leaf.subject.scope).toBe("unit");
    const html = render(leaf, "compact");
    expect(html).toContain('data-forecast-mode="compact"');
    const row = text(section(html, 'data-testid="forecast-labor"'));
    expect(row).toContain(`Remaining work${formatDuration(leaf.completion.labor.expectedSeconds!)}`);
    expect(row).not.toContain("at least");
    expect(html).not.toContain('data-testid="forecast-path"');
    expect(html).not.toContain('data-testid="forecast-units"');
    expect(html).not.toContain('data-testid="forecast-awaiting"');
    expect(html).not.toContain('data-testid="forecast-unknown"');
    expect(html).toContain(`data-confidence="${leaf.completion.confidence.label}"`);
    // The budget block comes with it.
    expect(html).toContain('data-block="budget"');
  });

  it("gives a leaf in review one line, not a forecast of 0 that lists itself", () => {
    // The payload for the leaf in review: nothing left as work, and itself awaiting review.
    expect(reviewLeaf.completion.labor.expectedSeconds).toBe(0);
    expect(reviewLeaf.completion.units.awaitingReviewRefs).toEqual([scenario.review]);
    // The tab never draws that as a forecast: the leaf gets one line and no request.
    expect(forecastMode({ childCount: 0, estimatedSeconds: 3600, category: "review" })).toBe("awaiting");
    const line = renderToStaticMarkup(<AwaitingForecast />);
    expect(text(line)).toContain("In review: not forecast.");
    expect(text(line)).not.toMatch(/\b0s\b/);
    // And the unit lists are the full report's: a compact rendering never lists the issue itself.
    const compact = render(reviewLeaf, "compact");
    expect(compact).not.toContain('data-testid="forecast-awaiting"');
    expect(compact).not.toContain('data-testid="forecast-unknown"');
  });

  it("with the remaining figure already under the reserve, says so, against the reserve that was asked for", () => {
    const limit = highReserve.budget.accounts.find((a) => a.accountRef === "personal-max")!.limits.find((l) => l.limitKey === "five_hour")!;
    expect(limit.reserve!.alreadyBelow).toBe(true);
    expect(limit.reserve!.source).toBe("argument");
    const words = text(section(render(highReserve), 'data-limit="five_hour"'));
    expect(words).toContain("chance of going under the 90% reserve (already below it)");
    expect(words).not.toContain("provisional");
  });

  it("with no samples at all, reads every sum as unknown with its reason, never 0", () => {
    expect(empty.completion.labor.expectedSeconds).toBeNull();
    const html = render(empty);
    const labor = section(html, 'data-testid="forecast-labor"');
    expect(labor).toContain("data-unknown");
    expect(text(labor)).toContain("Unknown: no unit's remaining work is known");
    expect(text(labor)).not.toMatch(/\b0s\b/);
    expect(text(section(html, 'data-testid="forecast-path"'))).toContain("Unknown");
    expect(text(section(html, 'data-testid="forecast-confidence"'))).toContain("Low confidence: no unit drew from a class");
    const unknown = text(section(html, 'data-testid="forecast-unknown"'));
    for (const ref of empty.completion.units.unknownRefs) expect(unknown).toContain(ref);
    expect(unknown).toContain("no calibration samples to read");
    // The budget can read the limits but not what unknown work does to them.
    const breach = section(section(html, 'data-limit="five_hour"'), 'data-testid="budget-work"');
    expect(text(breach)).toContain("the remaining labor is unknown");
  });

  it("says a settled forecast is settled rather than drawing a 0 figure", () => {
    expect(settled.completion.settled).toBe(true);
    const html = render(settled);
    expect(text(section(html, 'data-testid="forecast-settled"'))).toBe("Every unit is done: nothing is left to forecast.");
    expect(html).not.toContain('data-testid="forecast-labor"');
    expect(html).toContain('data-confidence="high"');
  });

  it("with no budget data on the machine, says so with the reason instead of projecting from nothing", () => {
    expect(noBudget.budget.accounts).toEqual([]);
    const none = section(render(noBudget), 'data-testid="budget-none"');
    expect(none).toContain("data-unknown");
    expect(text(none)).toBe("No budget forecast: this machine has no budget readings or bindings.");
    // The completion block is unchanged by the budget: the two never blend.
    expect(section(render(noBudget), 'data-block="completion"')).toBe(section(render(epic), 'data-block="completion"'));
  });
});

// ------------------------------------------------------------------ calibration

const renderCalibration = (report: CalibrationReport, includeReconstructed: boolean, workspace = FORECAST_WS): string =>
  renderToStaticMarkup(
    <CalibrationReportView report={report} workspace={workspace} includeReconstructed={includeReconstructed} onToggleReconstructed={() => {}} />,
  );

describe("the workspace calibration report", () => {
  it("is exact by default: the switch is off and no reconstructed section is drawn", () => {
    expect(INCLUDE_RECONSTRUCTED_BY_DEFAULT).toBe(false);
    expect(exact.filter.include).toEqual(["exact"]);
    const html = renderCalibration(exact, false);
    expect(html).toMatch(/<input type="checkbox" data-testid="include-reconstructed"(?![^>]*checked)[^>]*>/);
    expect(html).toContain('data-set="exact"');
    expect(html).not.toContain('data-set="reconstructed"');
    expect(html).not.toContain('data-cohort-set="reconstructed"');
    expect(text(section(html, 'data-testid="calibration-snapshot"'))).toContain(exact.snapshot.id);
  });

  it("lists every cohort with n, the class it read and how, coverage with its denominator, ratios and ranges", () => {
    const html = renderCalibration(exact, false);
    const cohorts = exact.items as CalibrationCohort[];
    expect(cohorts.length).toBe(2);
    const rows = [...html.matchAll(/<article data-cohort-set="exact"/g)];
    expect(rows.length).toBe(cohorts.length);
    for (const cohort of cohorts) {
      const title = `${cohort.key.kind} · ${cohort.key.priority} · type ${cohort.key.workType} · area ${cohort.key.area} · model ${cohort.key.model}`;
      const start = html.indexOf(title);
      expect(start, title).toBeGreaterThan(-1);
      const row = section(html.slice(html.lastIndexOf("<article", start)), "data-cohort-set");
      const words = text(row);
      expect(words).toContain(`n ${cohort.samples}`);
      expect(words).toContain(`${cohort.coverage.samples} of ${cohort.coverage.eligible} eligible`);
      expect(words).toContain(`median ×${cohort.ratio.median.toFixed(2)} · pooled ×${cohort.ratio.pooled.toFixed(2)}`);
      expect(words).toContain(`×${cohort.ratio.quantiles!.p10.toFixed(2)}–×${cohort.ratio.quantiles!.p90.toFixed(2)}`);
      expect(words).toContain(`×${cohort.ratio.bounds!.lower.toFixed(2)}–×${cohort.ratio.bounds!.upper.toFixed(2)}`);
      expect(words).toContain(`median ${formatDuration(cohort.workSeconds.median)}`);
      expect(words).toContain(`path: ${cohort.path.map((step) => `${step.name} ${step.samples}`).join(" → ")}`);
      const codes = [...row.matchAll(/data-warning="([^"]+)"/g)].map((match) => match[1]);
      expect(codes).toEqual(cohort.warnings);
      // Bounds under the 90% target are marked, in words.
      expect(cohort.ratio.bounds!.reached).toBe(false);
      expect(row).toContain('data-reached="no"');
      expect(words).toContain("(under the 90% target)");
    }
    // The bug's key had one sample: it fell back to the whole set, and says so.
    const bug = cohorts.find((cohort) => cohort.key.kind === "bug")!;
    expect(bug.fallback).toBe("below_minimum");
    expect(text(html)).toContain(`fell back to all: its key has 1 sample`);
    const task = cohorts.find((cohort) => cohort.key.kind === "task")!;
    expect(task.fallback).toBe("none");
    expect(text(html)).toContain("read at full, its own key");
  });

  it("with the switch on, draws the reconstructed cohorts as their own section and leaves the exact section as it was", () => {
    expect(withReconstructed.filter.include).toEqual(["exact", "reconstructed"]);
    const off = renderCalibration(exact, false);
    const on = renderCalibration(withReconstructed, true);
    expect(on).toMatch(/data-testid="include-reconstructed" checked=""/);
    const reconstructed = section(on, 'data-set="reconstructed"');
    expect(text(reconstructed)).toContain("Reconstructed history: backfilled, never pooled with exact");
    const rows = [...reconstructed.matchAll(/<article data-cohort-set="([^"]+)"/g)].map((match) => match[1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows)).toEqual(new Set(["reconstructed"]));
    expect(reconstructed).toContain('data-warning="reconstructed_only"');
    // Never pooled: the exact section is byte-identical with the switch on or off.
    expect(section(on, 'data-set="exact"')).toBe(section(off, 'data-set="exact"'));
    expect(on.indexOf('data-set="exact"')).toBeLessThan(on.indexOf('data-set="reconstructed"'));
    // The snapshot names the selection it read.
    expect(withReconstructed.snapshot.id).not.toBe(exact.snapshot.id);
    expect(text(section(on, 'data-testid="calibration-snapshot"'))).toContain(withReconstructed.snapshot.id);
  });

  it("asks for the workspace it is labelled with, exact unless the switch is on", () => {
    expect(calibrationRequest(FORECAST_WS, false)).toEqual({ ws: FORECAST_WS, limit: 500 });
    expect(calibrationRequest(FORECAST_WS, true)).toEqual({ ws: FORECAST_WS, include: "reconstructed", limit: 500 });
  });

  it("with no samples, says there are no cohorts and why, with no figure", () => {
    expect(emptyCalibration.items).toEqual([]);
    const html = renderCalibration(emptyCalibration, false, EMPTY_WS);
    const none = section(html, 'data-testid="no-cohorts-exact"');
    expect(none).toContain("data-unknown");
    expect(text(none)).toBe("No cohorts: nothing eligible to calibrate from.");
    expect(text(section(html, 'data-testid="set-summary-exact"'))).toContain("0 samples, 0 of 0 eligible (no eligible records)");
  });
});
