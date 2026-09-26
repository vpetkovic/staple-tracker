/**
 * The Estimate accuracy destination (the `calibration` view): how long finished work really took
 * against its estimate, by group, as `staple calibrate` reads it (docs/timing-semantics.md,
 * "Calibration cohorts" and "Confidence ranges"; docs/web-ui.md, "Estimate accuracy").
 *
 * ## Plain first, exact behind "Show details"
 *
 * The page opens with one answer sentence; each cohort is a card that says, in everyday words,
 * what share of the estimate such work usually takes ("about a fifth of the estimate"), how many
 * finished tasks that rests on, and how sure it is, with a bar against the estimate itself. The
 * figures the page showed before (key, n, class and fallback path, coverage, median and pooled
 * ratio, p10–p90, the bounds with the confidence reached, work medians, warnings, snapshot id)
 * are all still there, unchanged, behind each card's "Show details".
 *
 * ## Exact by default, older history only when asked, never pooled
 *
 * The page reads `GET /api/calibration` with no filter: the `exact` set, captured history. The
 * "Include older history" switch re-reads with `include=reconstructed`, and the store then
 * reports the reconstructed set BESIDE the exact one, with its own samples, coverage and cohorts.
 * The page keeps them apart the same way: the exact section first, unchanged by the switch, and the
 * reconstructed cohorts in their own section under their own heading. The switch is page state,
 * not a saved preference, so every visit opens on exact.
 *
 * ## Rendered, never recomputed
 *
 * Every figure is a field of the report, rounded and phrased by lib/plain-language.ts or
 * formatted by lib/forecast-text.ts.
 *
 * `CalibrationReportView` takes the payload as a prop and reads no context, so the e2e test renders
 * it from the real server's answer; `CalibrationView` is the fetch and the switch around it.
 */
import { useCallback, useState } from "react";
import { getCalibration, type AuthError } from "@/lib/api";
import {
  coverageText,
  cohortKeyText,
  excludedReasonsText,
  excludedStatesText,
  formatEffort,
  fallbackText,
  formatConfidence,
  formatRange,
  formatRatio,
  intervalText,
  missingText,
} from "@/lib/forecast-text";
import {
  accuracyHeadline,
  cohortConfidence,
  cohortName,
  cohortRangeDescription,
  cohortSentence,
  count,
  inTen,
  plainMissing,
  plainRatio,
  plainRatioRange,
  ratioFigure,
} from "@/lib/plain-language";
import { useSession } from "@/lib/session";
import type { CalibrationCohort, CalibrationReport, CalibrationSetSummary, EvidenceSet } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { WarningChips } from "@/detail/ForecastSection";
import { PlainCard, ShowDetails } from "@/components/plain/PlainCard";
import { RangeBar } from "@/components/plain/RangeBar";
import { ConfidencePill, StatusPill } from "@/components/plain/StatusPill";

const UNKNOWN = "text-muted-foreground italic";

/** One label/value pair of a cohort's details. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A figure that can fall short of the 90% target: the confidence it reaches, marked when it does not reach it. */
function Reached({ confidence, reached }: { confidence: number; reached: boolean }) {
  return (
    <span data-reached={reached ? "yes" : "no"} className={cn(!reached && "text-[var(--plain-tight-fg)]")}>
      {" "}
      at {formatConfidence(confidence)}
      {reached ? null : " (under the 90% target)"}
    </span>
  );
}

/** The technical figures of a cohort, exactly as before: behind "Show details". */
function CohortFacts({ cohort }: { cohort: CalibrationCohort }) {
  const { ratio, workSeconds } = cohort;
  return (
    <div className="space-y-1.5 text-[12px]">
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 font-medium break-words">{cohortKeyText(cohort.key)}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums" data-testid="cohort-n" title="samples in the class read">
          n {cohort.samples}
        </span>
      </div>
      <dl className="space-y-1">
        <Fact label="Class">
          <span data-testid="cohort-fallback">{fallbackText(cohort)}</span>
          <div className="text-[10px] text-muted-foreground" data-testid="cohort-path">
            path:{" "}
            {cohort.path.map((step, index) => (
              <span key={step.level}>
                {index > 0 ? " → " : ""}
                {step.name} {step.samples}
                {step.floors > 0 ? ` (+${step.floors} under a minute)` : ""}
              </span>
            ))}
          </div>
        </Fact>
        <Fact label="Coverage">
          <span data-testid="cohort-coverage">{coverageText(cohort.coverage)}</span>
          <span className="text-muted-foreground"> of the ratio population in this class</span>
        </Fact>
        <Fact label="Ratio">
          <span className="font-mono tabular-nums" data-testid="cohort-ratio">
            median {formatRatio(ratio.median)} · pooled {formatRatio(ratio.pooled)}
          </span>
          <div className="text-[10px] text-muted-foreground">
            a forecast scales an estimate by {formatRatio(ratio.expected.value)} ({ratio.expected.method === "pooled" ? "pooled" : "pooled, clipped at the outlier fences: reads low"})
          </div>
        </Fact>
        <Fact label="p10–p90">
          {ratio.quantiles ? (
            <span className="font-mono tabular-nums" data-testid="cohort-quantiles">
              {formatRange(ratio.quantiles.p10, ratio.quantiles.p90, formatRatio)}
            </span>
          ) : (
            <span className={UNKNOWN} data-unknown>
              Unknown: {missingText("no_samples")}
            </span>
          )}
        </Fact>
        <Fact label="Next one lands">
          {ratio.bounds ? (
            <span data-testid="cohort-bounds">
              <span className="font-mono tabular-nums">{formatRange(ratio.bounds.lower, ratio.bounds.upper, formatRatio)}</span>
              <Reached confidence={ratio.bounds.confidence} reached={ratio.bounds.reached} />
            </span>
          ) : (
            <span className={UNKNOWN} data-unknown>
              Unknown: {missingText("no_samples")}
            </span>
          )}
          {ratio.intervals ? <div className="text-[10px] text-muted-foreground">median between {intervalText(ratio.intervals.p50, formatRatio)}</div> : null}
        </Fact>
        <Fact label="Work">
          <span className="font-mono tabular-nums" data-testid="cohort-work">
            median {formatEffort(workSeconds.median)}
            {workSeconds.quantiles ? ` · p10–p90 ${formatRange(workSeconds.quantiles.p10, workSeconds.quantiles.p90, formatEffort)}` : ""}
          </span>
        </Fact>
        {cohort.floors.count > 0 || cohort.tail.heavy ? (
          <Fact label="Also">
            <span className="text-muted-foreground">
              {cohort.floors.count > 0 ? `${cohort.floors.count} under a minute, never samples` : ""}
              {cohort.floors.count > 0 && cohort.tail.heavy ? " · " : ""}
              {cohort.tail.heavy ? `heavy tail: ${cohort.tail.outliers.lower} low and ${cohort.tail.outliers.upper} high outliers` : ""}
            </span>
          </Fact>
        ) : null}
      </dl>
      <WarningChips codes={cohort.warnings} label="Cohort warnings" />
    </div>
  );
}

/**
 * The bar of a cohort: 8 in 10 past tasks (the ratio's p10–p90) inside where the next one lands
 * (the prediction bounds), the typical ratio as the marker, and the estimate itself (a ratio of
 * 1) as a dashed line. Scaled from 0 to a little past the furthest of them.
 */
function CohortRange({ cohort }: { cohort: CalibrationCohort }) {
  const { quantiles, bounds, expected } = cohort.ratio;
  const description = cohortRangeDescription(cohort);
  if (!quantiles || !bounds || description === null) return null;
  return (
    <RangeBar
      testId="cohort-range"
      max={Math.max(bounds.upper, quantiles.p90, expected.value, 1) * 1.1}
      wide={bounds}
      likely={{ lower: quantiles.p10, upper: quantiles.p90 }}
      marker={expected.value}
      reference={{ value: 1, label: "The estimate" }}
      description={description}
      legend={{
        likely: `8 in 10 past tasks: ${plainRatioRange(quantiles.p10, quantiles.p90)}`,
        wide: `Next one, about ${inTen(bounds.confidence)}: ${plainRatioRange(bounds.lower, bounds.upper)}`,
        marker: `Typical: ${plainRatio(expected.value).words}`,
        reference: "The estimate",
      }}
    />
  );
}

export function CohortRow({ cohort }: { cohort: CalibrationCohort }) {
  const sentence = cohortSentence(cohort);
  const confidence = cohortConfidence(cohort);
  return (
    <article data-cohort-set={cohort.set} className="min-w-0">
      <PlainCard
        className="h-full"
        title={cohortName(cohort.key)}
        pill={confidence.level === "unknown" ? <StatusPill status="unknown" /> : <ConfidencePill level={confidence.level} word={confidence.word} />}
        figure={ratioFigure(cohort.ratio.expected.value)}
        headlineTestId="cohort-sentence"
        headline={
          <>
            {sentence.answer} {sentence.basis} {sentence.confidence}
            {sentence.fallback ? ` ${sentence.fallback}` : null}
          </>
        }
        help={
          <>
            A task estimated at 10 hours that &ldquo;usually takes about a fifth of the estimate&rdquo; usually took about 2
            hours of work. The dashed line on the bar is the estimate itself: marks to its left finished faster than
            estimated, marks to its right took longer.
          </>
        }
        details={<CohortFacts cohort={cohort} />}
      >
        <CohortRange cohort={cohort} />
      </PlainCard>
    </article>
  );
}

/** One set's line, the technical way: samples, coverage over the whole population, cohorts, and what is not a sample and why. */
function SetSummary({ summary }: { summary: CalibrationSetSummary }) {
  const excluded = excludedStatesText(summary.excluded.counts);
  const reasons = excludedReasonsText(summary.excluded.reasons);
  return (
    <p className="text-[11px] text-muted-foreground" data-testid={`set-summary-${summary.set}`}>
      {summary.samples} sample{summary.samples === 1 ? "" : "s"}, {coverageText(summary.coverage)} · {summary.cohorts} cohort{summary.cohorts === 1 ? "" : "s"}
      {excluded ? ` · not samples: ${excluded}` : ""}
      {reasons ? ` (why: ${reasons})` : ""}
    </p>
  );
}

/** The same line in everyday words. */
function plainSetSummary(summary: CalibrationSetSummary): string {
  const left = summary.excluded.count > 0 ? ` ${count(summary.excluded.count, "other finished task")} ${summary.excluded.count === 1 ? "isn't" : "aren't"} counted here because ${summary.excluded.count === 1 ? "its" : "their"} timing isn't exact.` : "";
  return `Based on ${count(summary.samples, "finished task")} with measured time, out of ${summary.coverage.eligible} finished with an estimate, in ${count(summary.cohorts, "group")}.${left}`;
}

const SET_HEADING: Record<EvidenceSet, string> = {
  exact: "Finished tasks with measured time",
  reconstructed: "Older history (rebuilt from logs, less precise)",
};

const SET_NOTE: Record<EvidenceSet, string> = {
  exact: "Captured as the work happened.",
  reconstructed: "Rebuilt from older records and kept separate: never mixed with the history above.",
};

function SetSection({ set, report }: { set: EvidenceSet; report: CalibrationReport }) {
  const summary = report.sets.find((entry) => entry.set === set);
  // `list` is always `cohorts` here: the page never asks for samples.
  const cohorts = (report.items as CalibrationCohort[]).filter((cohort) => cohort.set === set);
  return (
    <section aria-label={SET_HEADING[set]} data-set={set} className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold">{SET_HEADING[set]}</h2>
        <p className="text-[13px] text-muted-foreground" data-testid={`set-plain-${set}`}>
          {SET_NOTE[set]} {summary ? plainSetSummary(summary) : null}
        </p>
        {summary ? (
          <ShowDetails>
            <SetSummary summary={summary} />
          </ShowDetails>
        ) : null}
      </div>
      {cohorts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-4">
          <p className="text-[14px]" data-testid={`no-groups-${set}`}>
            We can&apos;t tell yet: {report.missing.items ? plainMissing(report.missing.items) : "there are no finished tasks in this history"}.
          </p>
          <p className={cn(UNKNOWN, "mt-1 text-[11px]")} data-testid={`no-cohorts-${set}`} data-unknown>
            No cohorts: {report.missing.items ? missingText(report.missing.items) : "no samples in this set"}.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 @2xl:grid-cols-2">
          {cohorts.map((cohort) => (
            <CohortRow key={`${cohort.set}:${JSON.stringify(cohort.key)}`} cohort={cohort} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The whole report, from one payload. */
export function CalibrationReportView({
  report,
  workspace,
  includeReconstructed,
  onToggleReconstructed,
}: {
  report: CalibrationReport;
  workspace: string;
  includeReconstructed: boolean;
  onToggleReconstructed: (next: boolean) => void;
}) {
  const exactCohorts = (report.items as CalibrationCohort[]).filter((cohort) => cohort.set === "exact");
  return (
    <div className="@container space-y-6" data-calibration>
      <PlainCard
        title={`How long work really takes in ${workspace}`}
        headline={<span className="text-[16px] font-medium">{accuracyHeadline(exactCohorts)}</span>}
        headlineTestId="accuracy-headline"
        help={
          <>
            Each group below compares how long finished tasks really took with what they were estimated at. Forecasts use this
            to turn an estimate into a realistic figure: if tasks usually take about a fifth of their estimate, a 10-hour
            estimate is forecast at about 2 hours.
          </>
        }
        details={
          <>
            <p className="text-[12px] text-muted-foreground" data-testid="calibration-population">
              How long work took against its estimate in <span className="font-medium text-foreground">{workspace}</span>, by cohort. A
              forecast scales an estimate by its cohort&apos;s ratio. {report.population.issues} issues, {report.population.ratio} in the
              ratio population (done, with their own estimate).
            </p>
            <p className="text-[10px] text-muted-foreground" data-testid="calibration-snapshot">
              snapshot <span className="font-mono break-all">{report.snapshot.id}</span> · {report.snapshot.members} members · as of{" "}
              <span className="font-mono">{report.asOf}</span>
            </p>
          </>
        }
      >
        <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            data-testid="include-reconstructed"
            className="size-4 accent-[var(--viz-likely)]"
            checked={includeReconstructed}
            onChange={(event) => onToggleReconstructed(event.target.checked)}
          />
          Include older history (rebuilt from logs, less precise)
        </label>
      </PlainCard>
      <SetSection set="exact" report={report} />
      {includeReconstructed ? <SetSection set="reconstructed" report={report} /> : null}
      {report.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          Showing the first {report.items.length} groups; <code className="font-mono">staple calibrate --cursor</code> reads the rest.
        </p>
      ) : null}
    </div>
  );
}

/** The switch's state on every visit: exact only. Reconstructed history is an explicit opt-in. */
export const INCLUDE_RECONSTRUCTED_BY_DEFAULT = false;

/** The page cap: the store's maximum, so a workspace's cohorts fit one read. */
const COHORT_LIMIT = 500;

/**
 * What the page asks for: always the workspace it is labelled with (in hub mode with none chosen
 * the server would otherwise pick its own first, which need not be the one named), exact unless
 * the switch is on, and the store's page cap.
 */
export function calibrationRequest(workspace: string, includeReconstructed: boolean): { ws: string; include?: "reconstructed"; limit: number } {
  return { ws: workspace, ...(includeReconstructed ? { include: "reconstructed" as const } : {}), limit: COHORT_LIMIT };
}

export function CalibrationView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const [includeReconstructed, setIncludeReconstructed] = useState(INCLUDE_RECONSTRUCTED_BY_DEFAULT);
  const workspace = session.ws || session.workspaces[0]?.slug || "";
  const load = useCallback(
    () => getCalibration(calibrationRequest(workspace, includeReconstructed)),
    [workspace, includeReconstructed],
  );
  const report = useResource(load, [workspace, includeReconstructed, session.version], onAuthError);
  // While a toggle re-reads, the report on hand answers the other question: show the skeleton, not it.
  const data = report.data && report.data.filter.include.includes("reconstructed") === includeReconstructed ? report.data : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-5">
        {session.mode === "hub" && !session.ws && session.workspaces.length > 1 ? (
          <p className="mb-3 text-[12px] text-muted-foreground">Estimate accuracy is per workspace: showing {workspace}. Pick another in the switcher.</p>
        ) : null}
        {report.error ? (
          <ErrorState error={report.error} />
        ) : data ? (
          <CalibrationReportView
            report={data}
            workspace={workspace}
            includeReconstructed={includeReconstructed}
            onToggleReconstructed={setIncludeReconstructed}
          />
        ) : (
          <LoadingState rows={3} />
        )}
      </div>
    </div>
  );
}
