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
import { asOfText, forecastMode, formatDuration, formatEffort, spreadText, bandText, warningText } from "@/lib/forecast-text";
import {
  AWAITING_HEADLINE,
  accuracyGroups,
  accuracyHeadline,
  confidenceHeadline,
  forecastHeadline,
  gaugeDescription,
  groupSentence,
  limitSentence,
  limitStatus,
  notCountedText,
  plainCountdown,
  pathHeadline,
  rangeWords,
  setSummaryText,
} from "@/lib/plain-language";
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
let stale: ForecastReport;
let later: ForecastReport;
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
    // The same store method a quarter of an hour later: the readings are stale.
    // Six hours later: the 5-hour windows have reset since their last reading and can't be read.
    later = JSON.parse(JSON.stringify(store.forecast({ ref: scenario.epic }, new Date(scenario.readAt + 6 * 3_600_000).toISOString(), home))) as ForecastReport;
    stale = JSON.parse(JSON.stringify(store.forecast({ ref: scenario.epic }, new Date(scenario.readAt + 15 * 60_000).toISOString(), home))) as ForecastReport;
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
    expect(text(section(budget, 'data-testid="budget-subtitle"'))).toBe("Usage measured on this computer");
    // Headed with the same word as the page it reads from (the rail's "Usage"), never "Budget".
    expect(html).toContain('aria-label="Usage forecast"');
    expect(budget).toMatch(/<h3[^>]*>Usage<\/h3>/);
    expect(text(budget)).not.toMatch(/\bBudget\b/);
    expect(text(budget)).toContain("This machine only");
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
    // Here no draw went under: "at least 0%" would be true and empty, so it says what the draws showed.
    expect(limit.reserve!.breachProbability).toBe(0);
    expect(words).toContain("No draw went under the provisional 20% reserve (the burn is a lower bound)");
    expect(words).not.toContain("at least 0%");
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
    expect(text(none)).toBe("No usage forecast: this computer has no usage readings or bindings.");
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
    // Every cohort's technical figures are on the page, one block each, whichever card holds them.
    const facts = [...html.matchAll(/data-cohort-facts="exact"/g)];
    expect(facts.length).toBe(cohorts.length);
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
    expect(on).toMatch(/data-testid="include-reconstructed"[^>]*checked=""/);
    const reconstructed = section(on, 'data-set="reconstructed"');
    expect(text(reconstructed)).toContain("Older history (rebuilt from logs, less precise)");
    expect(text(reconstructed)).toContain("kept separate: never mixed with the history above");
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

// ------------------------------------------------------------------ the plain-language layer

/** Whether the element carrying `attribute` sits inside a closed <details> ("Show details"). */
function insideClosedDetails(html: string, attribute: string): boolean {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const stack: boolean[] = [];
  for (const match of html.slice(0, at).matchAll(/<details([^>]*)>|<\/details>/g)) {
    if (match[0] === "</details>") stack.pop();
    else stack.push(/\sopen[\s=>]/.test(`${match[1]}>`));
  }
  return stack.length > 0 && stack.every((open) => !open);
}

/** The status pill inside a markup fragment: its state, its word, and whether it has an icon. */
function pill(html: string): { status: string; word: string; icon: boolean } {
  const match = /<span data-status="([^"]+)"[^>]*>(<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec(html);
  expect(match, "status pill").not.toBeNull();
  return { status: match![1]!, icon: Boolean(match![2]), word: match![3]! };
}

/** The accessible name of the first `role="img"` in a fragment: the visual's text alternative. */
const imgLabel = (html: string): string => text(/role="img" aria-label="([^"]*)"/.exec(html)?.[1] ?? "");

describe("the plain-language layer, over the same payloads", () => {
  it("opens the work-left card with a plain answer that keeps the lower bound and names what is not counted", () => {
    const html = render(epic);
    const expected = forecastHeadline(epic.completion, "full");
    const headline = text(section(html, 'data-testid="forecast-headline"'));
    expect(headline).toBe(expected.sentence);
    // The labor is partial: "at least", and why, from the payload's unknown units.
    expect(headline).toMatch(/^At least .* of work is left, probably more: 1 task can't be estimated yet\.$/);
    expect(epic.completion.units.unknownRefs.length).toBe(1);
    // The review wait is said here, as not counted, not as a doubt about the figure.
    // The headline already says 1 task can't be estimated: "Not counted" does not say it again.
    expect(text(section(html, 'data-testid="forecast-not-counted"'))).toBe(notCountedText(1, 0));
    expect(text(section(html, 'data-testid="forecast-not-counted"'))).toBe("Not counted: 1 task waiting for review (time waiting for review isn't work).");
    // The pill says the confidence in a word with an icon, dashed when a rough guess.
    expect(html).toMatch(/<span data-confidence="low"[^>]*border-dashed[^>]*><svg[\s\S]*?<\/svg>Rough guess<\/span>/);
  });

  it("says ONE range under the bar, with a text alternative carrying every mark, lower bounds included", () => {
    const html = section(render(epic), 'data-testid="forecast-range"');
    const words = rangeWords(epic.completion.labor)!;
    expect(imgLabel(html)).toBe(words.description);
    expect(words.likely).toMatch(/^Most likely .*, or more \(8 in 10 chances\)$/);
    // A lower bound promises no upper end: no "rarely beyond".
    expect(words.beyond).toBeNull();
    const legend = [...html.matchAll(/data-legend="([^"]+)"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</g)].map((match) => [match[1], text(match[2]!)]);
    expect(legend).toEqual([
      ["likely", words.likely],
      ["marker", "Expected"],
    ]);
    // One range in words: the hours appear in the legend once.
    expect(text(html).match(/Most likely/g)!.length).toBe(1);
    for (const mark of ["wide", "likely", "expected"]) expect(html).toContain(`data-mark="${mark}"`);
  });

  it("names the wide band only when it says something new, on a full figure", () => {
    const words = rangeWords(leaf.completion.labor)!;
    const html = section(render(leaf, "compact"), 'data-testid="forecast-range"');
    expect(imgLabel(html)).toBe(words.description);
    expect(html.includes('data-legend="wide"')).toBe(words.beyond !== null);
  });

  it("says the critical path in words, and the outside wait, without its identifiers up front", () => {
    const html = render(epic);
    expect(text(section(html, 'data-testid="forecast-path-headline"'))).toBe(pathHeadline(epic.completion.path).sentence);
    expect(text(section(html, 'data-testid="forecast-path-headline"'))).toMatch(/^At least .* of it has to happen one step after another\.$/);
    expect(text(section(html, 'data-testid="forecast-outside-plain"'))).toBe("1 task also waits on work outside this, which isn't counted here.");
  });

  it("states confidence as a word once, what it rests on, and why it is not surer", () => {
    const html = render(epic);
    const line = text(section(html, 'data-testid="forecast-confidence-headline"'));
    expect(line).toBe(confidenceHeadline(epic.completion.confidence, epic.snapshot.calibration.samples));
    expect(line).toMatch(new RegExp(`^Based on ${epic.snapshot.calibration.samples} finished tasks with measured time\\. Why not surer: `));
    expect(line).not.toMatch(/Rough guess|review/);
  });

  it("keeps every technical figure, unchanged, behind a closed Show details", () => {
    const html = render(epic);
    for (const attribute of [
      'data-testid="forecast-labor"',
      'data-testid="forecast-path"',
      'aria-label="Critical path chain"',
      'data-testid="forecast-outside"',
      'data-testid="forecast-confidence"',
      'aria-label="Forecast warnings"',
      'data-testid="forecast-awaiting"',
      'data-testid="forecast-unknown"',
      'data-testid="forecast-units"',
      'data-testid="budget-rate"',
      'data-testid="budget-breach"',
      'data-testid="budget-reserve"',
      'data-testid="budget-account-ref"',
    ]) {
      expect(insideClosedDetails(html, attribute), attribute).toBe(true);
    }
    // And the plain layer is outside every disclosure.
    for (const attribute of ['data-testid="forecast-headline"', 'data-testid="forecast-range"', 'data-testid="budget-headline"', 'data-testid="budget-gauge"']) {
      expect(insideClosedDetails(html, attribute), attribute).toBe(false);
    }
    expect(text(section(html, 'data-testid="budget-details"'))).toMatch(/^Show reserve details/);
  });

  it("gives each limit a status word with an icon, a plain sentence and a gauge with its text alternative", () => {
    const limit = epic.budget.accounts.find((a) => a.accountRef === "personal-max")!.limits.find((l) => l.limitKey === "five_hour")!;
    // The burn is a lower bound and no draw went under: not "On track", which the data does not claim.
    expect(limit.work!.lowerBound).toBe(true);
    expect(limit.reserve!.breachProbability).toBe(0);
    expect(limitStatus(limit)).toEqual({ status: "tight", reason: "lower_bound" });
    const card = section(render(epic), 'data-limit="five_hour"');
    expect(pill(card)).toEqual({ status: "tight", word: "Tight", icon: true });
    expect(text(card)).toContain(`${Math.round(limit.remainingPercent!)}% left`);
    const sentence = limitSentence(limit);
    expect(sentence.reset).toBe("Resets in 3h 58m.");
    expect(text(section(card, 'data-testid="budget-headline"'))).toBe(`Resets in 3h 58m. ${sentence.verdict}`);
    expect(sentence.verdict).toBe("Probably fits, but we could only measure part of this work, so it may need more (a rough guess: little usage measured so far).");
    const gauge = section(card, 'data-testid="budget-gauge"');
    expect(imgLabel(gauge)).toBe(gaugeDescription(limit));
    expect(imgLabel(gauge)).toContain(`This work would use at least ${Math.round(limit.work!.consumedPercent.expected)}%, leaving at most ${Math.round(limit.work!.remainingAtResetPercent.expected)}% when it resets.`);
    for (const mark of ["left-after", "this-work", "reserve"]) expect(gauge).toContain(`data-mark="${mark}"`);
    // The dashed reserve line wears a card-coloured ring, so it reads over the blue fill in both modes.
    expect(gauge).toMatch(/data-mark="reserve" class="[^"]*shadow-\[0_0_0_2px_var\(--card\)\]/);
  });

  it("names each account for people, with the operator's label beside it and the raw reference behind details", () => {
    const html = render(epic);
    const claude = section(html, 'data-account="personal-max"');
    expect(text(claude)).toMatch(/^Claude \(Anthropic\)personal-max/);
    const codex = section(html, 'data-account="codex-plus"');
    expect(text(codex)).toMatch(/^Codex \(OpenAI\)codex-plus/);
    expect(text(section(codex, 'data-testid="budget-account-ref"'))).toBe("codex-plus · openai");
    // The cards do not stretch to their neighbour's height.
    expect(claude).toMatch(/class="grid items-start /);
  });

  it("explains only the marks a card draws", () => {
    const codex = epic.budget.accounts.find((a) => a.accountRef === "codex-plus")!;
    for (const limit of codex.limits) {
      const card = section(render(epic), `data-limit="${limit.limitKey}"`);
      const help = text(section(card, 'data-testid="plain-help"'));
      // No projection of this work: no stripes are drawn, and the help does not mention them.
      expect(limit.work).toBeNull();
      expect(card).not.toContain('data-mark="this-work"');
      expect(help).not.toContain("stripes");
    }
  });

  it("says Unknown, with the reason in everyday words, where nothing projects this work", () => {
    // A quarter of an hour later the readings are stale: nothing is projected off them.
    const secondary = stale.budget.accounts.find((a) => a.accountRef === "codex-plus")!.limits.find((limit) => limit.limitKey === "codex.secondary")!;
    expect(secondary.work).toBeNull();
    expect(secondary.exhaustion).toBeNull();
    const card = section(render(stale), 'data-limit="codex.secondary"');
    expect(pill(card)).toEqual({ status: "unknown", word: "Unknown", icon: true });
    expect(text(section(card, 'data-testid="budget-headline"'))).toContain("We can't tell yet what this work does to it: the last reading is more than 10 minutes old.");
    expect(text(section(card, 'data-testid="budget-headline"'))).not.toMatch(/\b0%/);
  });

  it("says Tight, not Unknown, when the account's own pace runs the limit out and this work's use is unknown", () => {
    const primary = epic.budget.accounts.find((a) => a.accountRef === "codex-plus")!.limits.find((limit) => limit.limitKey === "codex.primary")!;
    // The payload's own pace: 20%/hour on 60% left, before a reset about 4 hours away.
    expect(primary.work).toBeNull();
    expect(primary.exhaustion?.atPace).toBe("before_reset");
    expect(limitStatus(primary)).toEqual({ status: "tight", reason: "pace_unknown_work" });
    const card = section(render(epic), 'data-limit="codex.primary"');
    expect(pill(card)).toEqual({ status: "tight", word: "Tight", icon: true });
    expect(text(section(card, 'data-testid="budget-headline"'))).toBe(
      `Resets in ${plainCountdown(primary.secondsToReset!)}. At the account's current pace this limit runs out before it resets; what this work adds is unknown.`,
    );
  });

  it("says At risk when the limit is already under the reserve asked for", () => {
    const limit = highReserve.budget.accounts.find((a) => a.accountRef === "personal-max")!.limits.find((l) => l.limitKey === "five_hour")!;
    const card = section(render(highReserve), 'data-limit="five_hour"');
    expect(pill(card)).toEqual({ status: "at_risk", word: "At risk", icon: true });
    expect(text(section(card, 'data-testid="budget-headline"'))).toContain("It's already below the 90% safety reserve.");
    expect(limitStatus(limit).reason).toBe("already_below");
  });

  it("with no samples, says it can't tell yet, with Unknown and the reason, never a figure", () => {
    const html = render(empty);
    const headline = text(section(html, 'data-testid="forecast-headline"'));
    expect(headline).toBe("We can't tell yet how long this will take: none of the remaining tasks can be estimated yet.");
    expect(pill(section(html, 'data-block="completion"'))).toEqual({ status: "unknown", word: "Unknown", icon: true });
    expect(html).not.toContain('data-testid="forecast-range"');
    // No figure, nothing to be sure about: no confidence card, and no "Not counted" line repeating the headline.
    expect(html).not.toContain('data-testid="forecast-confidence-headline"');
    expect(html).not.toContain("How sure we are");
    expect(html).not.toContain('data-testid="forecast-not-counted"');
    // The technical confidence line is still there, behind the work-left card's details.
    expect(insideClosedDetails(html, 'data-testid="forecast-confidence"')).toBe(true);
  });

  it("gives the compact leaf a plain answer", () => {
    const html = render(leaf, "compact");
    const headline = text(section(html, 'data-testid="forecast-headline"'));
    expect(headline).toBe(forecastHeadline(leaf.completion, "compact").sentence);
    expect(headline).toMatch(/^About .* of work is left on this task\.$/);
    expect(html).not.toContain('data-testid="forecast-path-headline"');
  });

  it("says a settled forecast is done, and a leaf in review is waiting, in words and a pill", () => {
    const settledHtml = render(settled);
    expect(text(section(settledHtml, 'data-testid="forecast-headline"'))).toBe("Everything here is done: there is nothing left to forecast.");
    expect(pill(section(settledHtml, 'data-block="completion"'))).toEqual({ status: "on_track", word: "Done", icon: true });
    const awaiting = renderToStaticMarkup(<AwaitingForecast />);
    expect(text(section(awaiting, 'data-testid="forecast-awaiting-plain"'))).toBe(AWAITING_HEADLINE);
    expect(pill(awaiting)).toEqual({ status: "unknown", word: "In review", icon: true });
  });

  it("gives a stale figure its age, from the payload's reading instant", () => {
    const limit = stale.budget.accounts.find((a) => a.accountRef === "personal-max")!.limits.find((l) => l.limitKey === "five_hour")!;
    expect(limit.stale).toBe(true);
    expect(limit.readingAgeSeconds).toBeGreaterThan(600);
    const card = section(render(stale), 'data-limit="five_hour"');
    expect(text(section(card, 'data-testid="budget-age"'))).toBe(` · ${Math.round(limit.readingAgeSeconds! / 60)} min ago`);
    expect(text(section(card, 'data-testid="budget-headline"'))).toContain("the last reading is more than 10 minutes old");
    expect(text(section(card, 'data-testid="plain-help"'))).toContain("The reading is not recent");
    // A fresh reading carries no age.
    expect(section(render(epic), 'data-limit="five_hour"')).not.toContain('data-testid="budget-age"');
  });

  it("collapses the limits that can't be read into one line per account, their rows behind the account's details", () => {
    const html = render(later);
    for (const account of later.budget.accounts) {
      const unreadable = account.limits.filter((limit) => limit.remainingPercent === null);
      const block = section(html, `data-account="${account.accountRef}"`);
      // No card for a limit that can't be read: its only data-limit is inside the account's details.
      for (const limit of unreadable) {
        expect(block).not.toMatch(new RegExp(`<section[^>]*data-limit="${limit.limitKey.replace(".", "\\.")}"`));
        expect(insideClosedDetails(block, `data-limit="${limit.limitKey}"`)).toBe(true);
      }
      if (unreadable.length > 0) {
        const line = text(section(block, 'data-testid="budget-unreadable"'));
        expect(line).toMatch(new RegExp(`^${unreadable.length} (other )?(Claude|Codex) limits? can't be read yet: `));
        expect(line).toContain(unreadable.length === 1 ? "it has reset since the last reading" : "they have reset since the last reading");
      } else {
        expect(block).not.toContain('data-testid="budget-unreadable"');
      }
    }
    // The scenario's 5-hour windows are among them.
    expect(later.budget.accounts.flatMap((account) => account.limits).some((limit) => limit.remainingPercent === null && limit.missing.remainingPercent === "window_elapsed")).toBe(true);
  });

  it("with no budget data, opens the budget block with a plain 'can't tell yet'", () => {
    expect(text(section(render(noBudget), 'data-testid="budget-intro"'))).toBe("We can't tell yet: no usage has been measured on this computer.");
    expect(render(noBudget)).not.toContain('data-testid="budget-gauge"');
  });
});

describe("estimate accuracy, in everyday words", () => {
  it("gives the cohort that fell back ONE card named for its class, never its own figures", () => {
    const html = renderCalibration(exact, false);
    const cohorts = exact.items as CalibrationCohort[];
    const bug = cohorts.find((cohort) => cohort.key.kind === "bug")!;
    // The scenario's one bug fix fell back to all finished work.
    expect(bug.fallback).toBe("below_minimum");
    expect(bug.levelName).toBe("all");
    const groups = accuracyGroups(cohorts);
    expect(groups.map((group) => group.kind)).toEqual(["own", "class"]);
    const klass = section(html, 'data-group="class"');
    expect(text(klass)).toMatch(/^All finished work \(every kind\)/);
    expect(text(section(klass, 'data-testid="cohort-sentence"'))).toBe(Object.values(groupSentence(groups[1]!)).slice(0, 3).join(" "));
    expect(text(section(klass, 'data-testid="cohort-sentence"'))).toContain(`Based on ${bug.samples} finished tasks.`);
    expect(text(section(klass, 'data-testid="cohort-also-for"'))).toBe(`Also used for: Bug fixes (high priority): too few of their own (${bug.path[0]!.samples})`);
    expect(bug.path[0]!.samples).toBe(1);
    // Never presented as the bug fixes' own figure, and never "Quite sure".
    expect(text(html)).not.toMatch(/Bug fixes \(high priority\)( usually|:\s*a 10-hour)/);
    expect(klass).toMatch(/data-confidence="low"/);
    expect(text(klass)).not.toContain("Quite sure");
  });

  it("opens with one answer sentence, and presents each card as plain sentences, with details behind", () => {
    const html = renderCalibration(exact, false);
    const cohorts = exact.items as CalibrationCohort[];
    expect(text(section(html, 'data-testid="accuracy-headline"'))).toBe(accuracyHeadline(cohorts));
    // Identical clauses are said once, together, and the class says what it spans.
    expect(text(section(html, 'data-testid="accuracy-headline"'))).toMatch(/^Tasks \(high priority\) and all finished work \(every kind\) usually take /);
    expect(text(section(html, 'data-testid="accuracy-headline"')).match(/of the estimate/g)!.length).toBe(1);
    const own = accuracyGroups(cohorts).find((group) => group.kind === "own")!;
    const words = groupSentence(own);
    expect(text(section(html, 'data-group="own"'))).toContain(`${words.answer} ${words.basis} ${words.confidence}`);
    for (const attribute of ['data-testid="cohort-n"', 'data-testid="cohort-quantiles"', 'data-testid="cohort-bounds"', 'data-testid="calibration-snapshot"']) {
      expect(insideClosedDetails(html, attribute), attribute).toBe(true);
    }
    expect(html).toContain('data-mark="reference"');
    expect(html).toMatch(/data-mark="reference" class="[^"]*shadow-\[0_0_0_2px_var\(--card\)\]/);
    expect(imgLabel(section(html, 'data-testid="cohort-range"'))).toMatch(/^8 in 10 past tasks: .*The dashed line is the estimate itself\.$/);
  });

  it("says, per state, what each set leaves out: the older history's exact tasks are in the history above", () => {
    const off = renderCalibration(exact, false);
    const exactSummary = exact.sets.find((entry) => entry.set === "exact")!;
    expect(text(section(off, 'data-testid="set-plain-exact"'))).toContain(setSummaryText(exactSummary).basis);
    const on = renderCalibration(withReconstructed, true);
    const older = withReconstructed.sets.find((entry) => entry.set === "reconstructed")!;
    // The older history's non-samples include the exact ones: they are named as such, never "not exact".
    expect(older.excluded.counts.exact).toBeGreaterThan(0);
    const line = text(section(on, 'data-testid="set-plain-reconstructed"'));
    expect(setSummaryText(older).notUsed).not.toContain("above");
    expect(line).toContain(`${older.excluded.counts.exact} ${older.excluded.counts.exact === 1 ? "is" : "are"} in the measured history above`);
    expect(line).toContain(setSummaryText(older, { measuredAbove: true }).notUsed!);
    expect(line).toContain("timing rebuilt from logs");
    expect(line).not.toMatch(/isn't exact/);
  });

  it("says the same answer whether older history is shown or not (never pooled)", () => {
    const off = renderCalibration(exact, false);
    const on = renderCalibration(withReconstructed, true);
    expect(text(section(on, 'data-testid="accuracy-headline"'))).toBe(text(section(off, 'data-testid="accuracy-headline"')));
    // And it is the measured history's answer alone, whatever the payload holds beside it.
    expect(text(section(on, 'data-testid="accuracy-headline"'))).toBe(
      accuracyHeadline((withReconstructed.items as CalibrationCohort[]).filter((cohort) => cohort.set === "exact")),
    );
    expect(accuracyHeadline(withReconstructed.items as CalibrationCohort[])).not.toBe(text(section(on, 'data-testid="accuracy-headline"')));
  });

  it("calls the switch 'Include older history (rebuilt from logs, less precise)'", () => {
    expect(text(renderCalibration(exact, false))).toContain("Include older history (rebuilt from logs, less precise)");
  });

  it("with no samples, says it can't tell yet", () => {
    const html = renderCalibration(emptyCalibration, false, EMPTY_WS);
    expect(text(section(html, 'data-testid="accuracy-headline"'))).toBe(
      "We can't tell yet: there are no finished tasks with measured time to compare with their estimates.",
    );
    expect(text(section(html, 'data-testid="no-groups-exact"'))).toBe("We can't tell yet: there are no finished tasks with an estimate yet.");
  });
});
