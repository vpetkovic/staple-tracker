/**
 * The Calibration destination: the workspace's calibration cohorts, as `staple calibrate` reads
 * them (docs/timing-semantics.md, "Calibration cohorts" and "Confidence ranges"; docs/web-ui.md,
 * "Calibration").
 *
 * ## Exact by default, reconstructed only when asked, never pooled
 *
 * The page reads `GET /api/calibration` with no filter: the `exact` set, captured history. The
 * "Include reconstructed history" switch re-reads with `include=reconstructed`, and the store then
 * reports the reconstructed set BESIDE the exact one, with its own samples, coverage and cohorts.
 * The page keeps them apart the same way: the exact section first, unchanged by the switch, and the
 * reconstructed cohorts in their own section under their own heading. The switch is page state,
 * not a saved preference, so every visit opens on exact.
 *
 * ## Rendered, never recomputed
 *
 * Every figure is a field of the report, formatted by lib/forecast-text.ts. The snapshot id the
 * report was computed from sits in the header, so a reader can name the data.
 *
 * `CalibrationReportView` takes the payload as a prop and reads no context, so the e2e test renders
 * it from the real server's answer; `CalibrationView` is the fetch and the switch around it.
 */
import { useCallback, useState } from "react";
import { getCalibration, type AuthError } from "@/lib/api";
import {
  coverageText,
  cohortKeyText,
  fallbackText,
  formatConfidence,
  formatDuration,
  formatRange,
  formatRatio,
  intervalText,
  missingText,
} from "@/lib/forecast-text";
import { useSession } from "@/lib/session";
import type { CalibrationCohort, CalibrationReport, CalibrationSetSummary, EvidenceSet } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";
import { WarningChips } from "@/detail/ForecastSection";

const UNKNOWN = "text-muted-foreground italic";

/** One label/value pair of a cohort. */
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
    <span data-reached={reached ? "yes" : "no"} className={cn(!reached && "text-[var(--status-task-todo)]")}>
      {" "}
      at {formatConfidence(confidence)}
      {reached ? null : " (under the 90% target)"}
    </span>
  );
}

export function CohortRow({ cohort }: { cohort: CalibrationCohort }) {
  const { ratio, workSeconds } = cohort;
  return (
    <article data-cohort-set={cohort.set} className="space-y-1.5 py-3 text-[12px]">
      <header className="flex items-start gap-3">
        <h3 className="min-w-0 flex-1 font-medium break-words">{cohortKeyText(cohort.key)}</h3>
        <span className="shrink-0 font-mono text-[11px] tabular-nums" data-testid="cohort-n" title="samples in the class read">
          n {cohort.samples}
        </span>
      </header>
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
          {ratio.intervals ? (
            <div className="text-[10px] text-muted-foreground">median between {intervalText(ratio.intervals.p50, formatRatio)}</div>
          ) : null}
        </Fact>
        <Fact label="Work">
          <span className="font-mono tabular-nums" data-testid="cohort-work">
            median {formatDuration(workSeconds.median)}
            {workSeconds.quantiles ? ` · p10–p90 ${formatRange(workSeconds.quantiles.p10, workSeconds.quantiles.p90, formatDuration)}` : ""}
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
    </article>
  );
}

/** One set's line: samples, coverage over the whole population, cohorts, and what is not a sample and why. */
function SetSummary({ summary }: { summary: CalibrationSetSummary }) {
  const excluded = Object.entries(summary.excluded.counts).map(([state, count]) => `${state} ${count}`);
  const reasons = Object.entries(summary.excluded.reasons).map(([reason, count]) => `${reason.replace(/_/g, " ")} ${count}`);
  return (
    <p className="text-[11px] text-muted-foreground" data-testid={`set-summary-${summary.set}`}>
      {summary.samples} sample{summary.samples === 1 ? "" : "s"}, {coverageText(summary.coverage)} · {summary.cohorts} cohort{summary.cohorts === 1 ? "" : "s"}
      {excluded.length > 0 ? ` · not samples: ${excluded.join(", ")}` : ""}
      {reasons.length > 0 ? ` (reasons: ${reasons.join(", ")})` : ""}
    </p>
  );
}

const SET_HEADING: Record<EvidenceSet, string> = {
  exact: "Exact: captured history",
  reconstructed: "Reconstructed history: backfilled, never pooled with exact",
};

function SetSection({ set, report }: { set: EvidenceSet; report: CalibrationReport }) {
  const summary = report.sets.find((entry) => entry.set === set);
  // `list` is always `cohorts` here: the page never asks for samples.
  const cohorts = (report.items as CalibrationCohort[]).filter((cohort) => cohort.set === set);
  return (
    <section aria-label={SET_HEADING[set]} data-set={set}>
      <SectionHeading>{SET_HEADING[set]}</SectionHeading>
      {summary ? <SetSummary summary={summary} /> : null}
      {cohorts.length === 0 ? (
        <p className={cn(UNKNOWN, "py-3 text-[12px]")} data-testid={`no-cohorts-${set}`} data-unknown>
          No cohorts: {report.missing.items ? missingText(report.missing.items) : "no samples in this set"}.
        </p>
      ) : (
        <div className="divide-y border-t border-b">
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
  return (
    <div className="space-y-4" data-calibration>
      <header className="space-y-1.5">
        <p className="text-[12px] text-muted-foreground">
          How long work took against its estimate in <span className="font-medium text-foreground">{workspace}</span>, by cohort. A
          forecast scales an estimate by its cohort&apos;s ratio. {report.population.issues} issues, {report.population.ratio} in the ratio
          population (done, with their own estimate).
        </p>
        <label className="inline-flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            data-testid="include-reconstructed"
            checked={includeReconstructed}
            onChange={(event) => onToggleReconstructed(event.target.checked)}
          />
          Include reconstructed history
        </label>
        <p className="text-[10px] text-muted-foreground" data-testid="calibration-snapshot">
          snapshot <span className="font-mono break-all">{report.snapshot.id}</span> · {report.snapshot.members} members · as of{" "}
          <span className="font-mono">{report.asOf}</span>
        </p>
      </header>
      <SetSection set="exact" report={report} />
      {includeReconstructed ? <SetSection set="reconstructed" report={report} /> : null}
      {report.truncated ? (
        <p className="text-[10px] text-muted-foreground">
          Showing the first {report.items.length} cohorts; `staple calibrate --cursor` reads the rest.
        </p>
      ) : null}
    </div>
  );
}

/** The switch's state on every visit: exact only. Reconstructed history is an explicit opt-in. */
export const INCLUDE_RECONSTRUCTED_BY_DEFAULT = false;

/** The page cap: the store's maximum, so a workspace's cohorts fit one read. */
const COHORT_LIMIT = 500;

export function CalibrationView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const [includeReconstructed, setIncludeReconstructed] = useState(INCLUDE_RECONSTRUCTED_BY_DEFAULT);
  const ws = session.ws || undefined;
  const workspace = session.ws || session.workspaces[0]?.slug || "";
  const load = useCallback(
    () => getCalibration({ ws, include: includeReconstructed ? "reconstructed" : undefined, limit: COHORT_LIMIT }),
    [ws, includeReconstructed],
  );
  const report = useResource(load, [ws, includeReconstructed, session.version], onAuthError);
  // While a toggle re-reads, the report on hand answers the other question: show the skeleton, not it.
  const data = report.data && report.data.filter.include.includes("reconstructed") === includeReconstructed ? report.data : undefined;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {session.mode === "hub" && !session.ws && session.workspaces.length > 1 ? (
          <p className="mb-3 text-[11px] text-muted-foreground">Calibration is per workspace: showing {workspace}. Pick another in the switcher.</p>
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
