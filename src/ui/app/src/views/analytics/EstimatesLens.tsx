/**
 * The Estimates lens: how estimates compare with the time the work took, made easy to use.
 *
 * The old Estimates page was a wall of cards, each repeating the same sentence shape. This reads
 * the same report (`GET /api/calibration`, unchanged) and says it three ways, shortest first:
 *
 *   1. the answer in a sentence, and a converter: type an estimate, read what it usually takes;
 *   2. every group of similar work as ONE row on ONE shared scale, where 100% is the estimate, so
 *      groups compare at a glance and "work takes a fraction of its estimate" is visible, not read;
 *   3. a row opens to the plain sentences and the tickets-count behind it.
 *
 * With every workspace in scope it is one row per workspace on the same scale; choosing a row
 * narrows the page to that workspace. Estimate accuracy is always worked out per workspace.
 */
import { ChevronDown, CircleDashed } from "lucide-react";
import { useCallback, useState } from "react";
import { formatHours, formatPercent } from "@/components/analytics/format";
import { StatTile } from "@/components/analytics/StatTile";
import { ConfidencePill } from "@/components/plain/StatusPill";
import { EmptyState, ProblemState } from "@/components/plain/States";
import { Skeleton } from "@/components/ui/skeleton";
import { getCalibration, type AuthError } from "@/lib/api";
import { accuracyGroups, accuracyHeadline, cohortConfidence, cohortRangeWords, groupSentence, kindName, ratioFigure, type AccuracyGroup } from "@/lib/plain-language";
import type { CalibrationCohort, CalibrationReport } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { useIncludeOlderHistory } from "@/views/calibration/older-history";

interface Row {
  id: string;
  name: string;
  /** The kind of work the row belongs to ("*" is all of it), for the table's sections. */
  kind: string;
  /** The cohort whose figure the row shows (a class's figure for a fallback group). */
  figure: CalibrationCohort;
  group: AccuracyGroup | null;
  older: boolean;
  onOpen?: () => void;
}

const cohortsOf = (report: CalibrationReport): CalibrationCohort[] => (report.list === "cohorts" ? (report.items as CalibrationCohort[]) : []);
const figureOf = (group: AccuracyGroup): CalibrationCohort => (group.kind === "own" ? group.cohort : group.figure);

const known = (value: string) => value !== "*" && value !== "unknown";

/**
 * The report's groups as rows, simplified for reading: one row per kind and priority. The report
 * also carries narrower and broader versions of the same pair (a class that stands in for groups
 * too small to measure); of those, the one resting on the most tickets is the row.
 */
function rowsOf(report: CalibrationReport): Row[] {
  const best = new Map<string, Row>();
  accuracyGroups(cohortsOf(report)).forEach((group, index) => {
    const figure = figureOf(group);
    const key = group.kind === "own" ? group.cohort.key : figure.class;
    const older = figure.set === "reconstructed";
    const priority = known(key.priority) ? `${key.priority.charAt(0).toUpperCase()}${key.priority.slice(1)} priority` : "Every priority";
    const row: Row = { id: `${figure.set}:${index}`, kind: key.kind, name: key.kind === "*" ? "All finished work" : priority, figure, group, older };
    const slot = `${figure.set}:${key.kind}:${known(key.priority) ? key.priority : "*"}`;
    const held = best.get(slot);
    if (!held || figure.samples > held.figure.samples) best.set(slot, row);
  });
  const rows = [...best.values()];
  // Kinds with the most finished tickets first; "all finished work" leads; within a kind, the broad row leads.
  const weight = new Map<string, number>();
  for (const row of rows) weight.set(row.kind, Math.max(weight.get(row.kind) ?? 0, row.figure.samples));
  return rows.sort(
    (a, b) => Number(a.older) - Number(b.older) || Number(b.kind === "*") - Number(a.kind === "*") || (weight.get(b.kind) ?? 0) - (weight.get(a.kind) ?? 0) || a.kind.localeCompare(b.kind) || b.figure.samples - a.figure.samples,
  );
}
const fullName = (row: Row) => (row.kind === "*" || row.group === null ? row.name : `${kindName(row.kind)}, ${lowerFirst(row.name)}`);
/** The group that speaks for a whole workspace: the broadest measured one, else the one with most tickets. */
function overallOf(report: CalibrationReport): Row | null {
  const rows = rowsOf(report);
  const measured = rows.filter((row) => !row.older);
  return measured.find((row) => row.kind === "*") ?? [...measured].sort((a, b) => b.figure.samples - a.figure.samples)[0] ?? rows[0] ?? null;
}

export function EstimatesLens({ workspace, workspaces, onChooseWorkspace, onAuthError, version }: { workspace: string; workspaces: readonly { slug: string; prefix: string }[]; onChooseWorkspace: (slug: string) => void; onAuthError: (error: AuthError) => void; version: number }) {
  const single = workspaces.length === 1 ? (workspaces[0]?.slug ?? "") : workspace;
  if (single === "" && workspaces.length > 1) return <AllWorkspaces workspaces={workspaces} onChoose={onChooseWorkspace} onAuthError={onAuthError} version={version} />;
  return <OneWorkspace key={single} workspace={single} onAuthError={onAuthError} version={version} />;
}

/** What the typical share of the estimate means: under it is the agents' speed, over it is work that overran. */
export function leadReading(ratio: number): string {
  if (ratio > 1.05) return "The work usually runs over its estimate here, so plan with that, or estimate higher.";
  if (ratio >= 0.95) return "The estimates here are close to what the work takes.";
  return "Estimates are planning figures, close to what a person would need, so the gap is the speed of the agents, not a planning mistake.";
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" onClick={onRetry} className="focus-ring relative min-h-0 rounded-md border px-2.5 py-1 text-label font-medium before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']">
      Try again
    </button>
  );
}

// ---------------------------------------------------------------- one workspace

function OneWorkspace({ workspace, onAuthError, version }: { workspace: string; onAuthError: (error: AuthError) => void; version: number }) {
  const [older] = useIncludeOlderHistory();
  const load = useCallback(() => getCalibration({ ws: workspace || undefined, limit: 200, ...(older ? { include: "reconstructed" as const } : {}) }), [workspace, older]);
  const report = useResource(load, [workspace, older, version], onAuthError);
  const data = report.data && report.data.filter.include.includes("reconstructed") === older ? report.data : undefined;
  if (report.error && !data) return <ProblemState title="Estimates could not be loaded" message={report.error.message} action={<RetryButton onRetry={report.reload} />} />;
  if (!data) return <LensSkeleton />;
  const rows = rowsOf(data);
  const measured = rows.filter((row) => !row.older);
  const exact = data.sets.find((set) => set.set === "exact");
  if (rows.length === 0) {
    return (
      <EmptyState title="No estimates to compare yet">
        This fills in once tickets that carry an estimate are finished by an agent. Estimate tickets when you plan them.
      </EmptyState>
    );
  }
  const overall = overallOf(data);
  const beat = measured.length > 0 ? measured.filter((row) => row.figure.ratio.expected.value < 1).length : 0;
  return (
    <div className="flex flex-col gap-4" data-estimates>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <section aria-label="The answer" className="flex min-w-0 flex-col justify-center gap-2">
          <p className="text-label font-medium text-muted-foreground">How long work really takes in {workspace || "this workspace"}, against its estimate</p>
          <h2 className="text-display font-semibold text-balance">
            {overall ? (
              <>
                A 10-hour estimate usually takes agents about {formatHours(10 * overall.figure.ratio.expected.value)}.
              </>
            ) : (
              accuracyHeadline(cohortsOf(data).filter((cohort) => cohort.set === "exact"))
            )}
          </h2>
          {overall ? (
            <p className="max-w-3xl text-reading text-text-secondary">
              That is {formatPercent(overall.figure.ratio.expected.value)} of the estimate, from {overall.figure.samples.toLocaleString("en-US")} finished tickets {overall.older ? "in the older history, rebuilt from logs" : "with measured time"}. {leadReading(overall.figure.ratio.expected.value)}
            </p>
          ) : null}
        </section>
        <Converter rows={rows.filter((row) => !row.older)} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Typical share of the estimate" value={overall ? formatPercent(overall.figure.ratio.expected.value) : null} sentence={overall ? `${ratioFigure(overall.figure.ratio.expected.value)}, for ${lowerFirst(fullName(overall))}.` : null} emptyText="Not enough finished work" />
        <StatTile label="Groups that beat their estimate" value={measured.length > 0 ? `${beat} of ${measured.length}` : null} sentence="Kinds and priorities of work whose typical time is under the estimate." emptyText="No measured groups yet" />
        <StatTile
          label="What this rests on"
          value={exact ? exact.samples.toLocaleString("en-US") : null}
          unit="tickets"
          sentence={exact ? `Finished with measured time, out of ${exact.coverage.eligible.toLocaleString("en-US")} finished with an estimate.` : null}
          note={exact && exact.coverage.fraction !== null && exact.coverage.fraction < 1 ? `${formatPercent(exact.coverage.fraction)} coverage` : undefined}
          className="max-md:col-span-2"
          emptyText="No measured tickets yet"
        />
      </div>
      <ScaleTable title="By kind of work" sentence="Each row is one kind and priority of work, read from all finished work. The bar is where 8 in 10 past tickets landed, the mark is the typical one, and the dashed line at 100% is the estimate itself." rows={rows} nameHeader="Work" sections />
    </div>
  );
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Type an estimate, read what it usually takes: the report's ratio, applied where the reader needs it. */
function Converter({ rows }: { rows: readonly Row[] }) {
  const [hours, setHours] = useState("10");
  const [id, setId] = useState(rows[0]?.id ?? "");
  const row = rows.find((item) => item.id === id) ?? rows[0];
  if (!row) return null;
  const amount = Math.min(10000, Math.max(0, Number(hours.replace(/[^0-9.]/g, "")) || 0));
  const { expected, quantiles } = row.figure.ratio;
  return (
    <section aria-label="Try an estimate" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4" data-estimate-converter>
      <p className="text-label font-medium text-muted-foreground">Try an estimate</p>
      <div className="flex flex-wrap items-center gap-2 text-body">
        <span>An estimate of</span>
        <span className="inline-flex h-control-md w-[5.5rem] items-center gap-1 rounded-md border bg-surface-sunken px-2 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring">
          <input aria-label="Estimated hours" value={hours} inputMode="decimal" onChange={(event) => setHours(event.target.value)} onFocus={(event) => event.currentTarget.select()} className="min-h-0 w-full min-w-0 bg-transparent font-medium tabular-nums outline-none" />
          <span aria-hidden className="text-label text-muted-foreground">h</span>
        </span>
        <span>for</span>
        <span className="relative inline-flex min-w-0 max-w-full">
          <select aria-label="Group of work" value={row.id} onChange={(event) => setId(event.target.value)} className="focus-ring h-control-md min-h-0 max-w-full min-w-0 appearance-none truncate rounded-md border bg-card py-0 pr-7 pl-2.5 text-body font-medium">
            {rows.map((item) => (
              <option key={item.id} value={item.id}>
                {fullName(item)}
                {item.older ? " (older history)" : ""}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-text-tertiary" />
        </span>
      </div>
      <div aria-live="polite">
        <p className="text-[26px] leading-[30px] font-semibold tracking-tight" data-figure>
          usually takes {amount > 0 ? formatHours(amount * expected.value) : "—"}
        </p>
        {quantiles && amount > 0 ? (
          <p className="mt-1 text-body text-text-secondary">
            8 in 10 past tickets like it landed between {formatHours(amount * quantiles.p10)} and {formatHours(amount * quantiles.p90)}.
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- every workspace

function AllWorkspaces({ workspaces, onChoose, onAuthError, version }: { workspaces: readonly { slug: string; prefix: string }[]; onChoose: (slug: string) => void; onAuthError: (error: AuthError) => void; version: number }) {
  const slugs = workspaces.map((workspace) => workspace.slug).join(",");
  const load = useCallback(
    () => Promise.all(workspaces.map((workspace) => getCalibration({ ws: workspace.slug, limit: 200 }).then((report) => ({ slug: workspace.slug, report, failed: false }), () => ({ slug: workspace.slug, report: null, failed: true })))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slugs],
  );
  const all = useResource(load, [slugs, version], onAuthError);
  if (all.error && !all.data) return <ProblemState title="Estimates could not be loaded" message={all.error.message} action={<RetryButton onRetry={all.reload} />} />;
  if (!all.data) return <LensSkeleton />;
  const rows: Row[] = [];
  const without: string[] = [];
  const unread: string[] = [];
  for (const { slug, report, failed } of all.data) {
    const overall = report ? overallOf(report) : null;
    if (overall) rows.push({ id: slug, name: slug, kind: "", figure: overall.figure, group: null, older: false, onOpen: () => onChoose(slug) });
    else if (failed) unread.push(slug);
    else without.push(slug);
  }
  rows.sort((a, b) => b.figure.samples - a.figure.samples);
  if (rows.length === 0 && unread.length > 0) return <ProblemState title="Estimates could not be loaded" message={`Could not be read: ${unread.join(", ")}.`} action={<RetryButton onRetry={all.reload} />} />;
  if (rows.length === 0) {
    return (
      <EmptyState title="No estimates to compare yet">
        This fills in once tickets that carry an estimate are finished by an agent. Estimate tickets when you plan them.
      </EmptyState>
    );
  }
  const tickets = rows.reduce((sum, row) => sum + row.figure.samples, 0);
  const typical = rows.reduce((sum, row) => sum + row.figure.ratio.expected.value * row.figure.samples, 0) / tickets;
  return (
    <div className="flex flex-col gap-4" data-estimates="all">
      <section aria-label="The answer" className="flex min-w-0 flex-col gap-2">
        <p className="text-label font-medium text-muted-foreground">How long work really takes, against its estimate</p>
        <h2 className="text-display font-semibold text-balance">Across {rows.length} workspaces, agents finish work in about {formatPercent(typical)} of its estimate.</h2>
        <p className="max-w-3xl text-reading text-text-secondary">
          Estimate accuracy is worked out for each workspace on its own, because estimating habits differ between projects. Choose a workspace to see it by kind of work and to try an estimate.
          {without.length > 0 ? ` Nothing to compare yet in ${without.join(", ")}.` : ""}
          {unread.length > 0 ? <span data-estimates-unread> Could not be read, so left out: {unread.join(", ")}.</span> : null}
        </p>
      </section>
      <ScaleTable title="By workspace" sentence="Each row is all the measured work in one workspace. The bar is where 8 in 10 past tickets landed; the mark is the typical one; the line at 100% is the estimate itself." rows={rows} nameHeader="Workspace" />
    </div>
  );
}

// ---------------------------------------------------------------- the shared-scale table

const TABLE = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 @min-[720px]/estimates:grid-cols-[minmax(0,15rem)_6.5rem_minmax(0,1fr)_7.5rem_1.5rem]";

function ScaleTable({ title, sentence, rows: allRows, nameHeader, sections = false }: { title: string; sentence: string; rows: readonly Row[]; nameHeader: string; sections?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const olderCount = allRows.filter((row) => row.older).length;
  const rows = showOlder ? allRows : allRows.filter((row) => !row.older);
  // One scale for every row: wide enough for the widest band, never narrower than the estimate itself.
  const reach = Math.max(1, ...rows.map((row) => row.figure.ratio.quantiles?.p90 ?? row.figure.ratio.expected.value));
  const max = Math.min(Math.max(reach * 1.08, 1.15), 3);
  const at = (value: number) => `${Math.min(Math.max((value / max) * 100, 0), 100)}%`;
  const ticks = max <= 1.6 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1, 1.5, 2, 2.5].filter((tick) => tick <= max);
  const olderAt = rows.findIndex((row) => row.older);
  return (
    <section aria-label={title} className="@container/estimates rounded-xl border bg-card p-4" data-estimates-table>
      <h3 className="text-title font-semibold">{title}</h3>
      <p className="mt-0.5 max-w-4xl text-label text-pretty text-muted-foreground">{sentence}</p>
      <div aria-hidden className={cn(TABLE, "mt-3 hidden border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase @min-[720px]/estimates:grid")}>
        <span>{nameHeader}</span>
        <span className="text-right">Usually takes</span>
        <span className="relative block h-3.5 normal-case">
          {ticks.map((tick) => (
            <span key={tick} className={cn("absolute -translate-x-1/2 leading-none tabular-nums", tick === 0 && "translate-x-0", tick === 1 && "font-semibold text-foreground")} style={{ left: at(tick) }}>
              {formatPercent(tick)}
            </span>
          ))}
        </span>
        <span>How sure</span>
        <span />
      </div>
      <ul className="@max-[720px]/estimates:mt-2">
        {rows.map((row, index) => {
          const { expected, quantiles } = row.figure.ratio;
          // The row is the group itself (a class row describes the class), so its own figures say how sure it is.
          const confidence = cohortConfidence(row.figure);
          const expanded = open === row.id;
          const range = cohortRangeWords(row.figure);
          const sentences = row.group ? groupSentence(row.group) : null;
          return (
            <li key={row.id} className="border-b last:border-b-0">
              {index === olderAt ? <p className="pt-4 pb-1 text-label font-medium text-muted-foreground">Older history: rebuilt from logs, less precise, kept apart</p> : null}
              {sections && row.kind !== "*" && rows[index - 1]?.kind !== row.kind ? <p className="pt-3 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">{kindName(row.kind)}</p> : null}
              <div className={cn(TABLE, "py-2.5")}>
                <div className="min-w-0">
                  {row.onOpen ? (
                    <button type="button" onClick={row.onOpen} className="focus-ring relative max-w-full min-h-0 truncate rounded-sm text-left text-body font-medium before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:underline">
                      {row.name}
                    </button>
                  ) : (
                    <p className={cn("truncate text-body font-medium", sections && row.kind !== "*" && "pl-3")}>{row.name}</p>
                  )}
                  <p className={cn("text-label text-muted-foreground tabular-nums", sections && row.kind !== "*" && "pl-3")}>{row.figure.samples.toLocaleString("en-US")} finished tickets</p>
                </div>
                <p className="text-right text-title font-semibold tabular-nums @max-[720px]/estimates:order-2">{formatPercent(expected.value)}</p>
                <div
                  role="img"
                  aria-label={`${fullName(row)}: typically ${formatPercent(expected.value)} of the estimate${quantiles ? `; 8 in 10 past tickets between ${formatPercent(quantiles.p10)} and ${formatPercent(quantiles.p90)}` : ""}.`}
                  className="relative h-5 min-w-0 @max-[720px]/estimates:order-4 @max-[720px]/estimates:col-span-2"
                >
                  <span className="absolute inset-x-0 top-1.5 h-2 rounded-full bg-[var(--viz-track)]" />
                  {quantiles ? <span className="absolute top-1.5 h-2 rounded-full bg-[var(--viz-likely)]" style={{ left: at(quantiles.p10), width: `max(calc(${at(quantiles.p90)} - ${at(quantiles.p10)}), 4px)` }} /> : null}
                  <span className="absolute top-0 h-5 w-[3px] -translate-x-1/2 rounded-full bg-[var(--viz-marker)] ring-2 ring-[var(--card)]" style={{ left: at(expected.value) }} />
                  <span className="absolute top-0 h-5 w-0 -translate-x-1/2 border-l-2 border-dashed border-[var(--viz-marker)]" style={{ left: at(1) }} />
                </div>
                <div className="@max-[720px]/estimates:order-5 @max-[720px]/estimates:col-span-2">
                  {confidence.level === "unknown" ? (
                    <span className="inline-flex items-center gap-1.5 text-label text-muted-foreground italic">
                      <CircleDashed aria-hidden className="size-3.5" />
                      Can&apos;t tell yet
                    </span>
                  ) : (
                    <ConfidencePill level={confidence.level} word={confidence.word} />
                  )}
                </div>
                {row.group ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Close" : "Open"} ${fullName(row)}`}
                    onClick={() => setOpen(expanded ? null : row.id)}
                    className="focus-ring relative inline-flex size-6 min-h-0 items-center justify-center justify-self-end rounded-md text-text-tertiary transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:bg-surface-hover hover:text-foreground @max-[720px]/estimates:order-3 @max-[720px]/estimates:col-start-2 @max-[720px]/estimates:row-start-2"
                  >
                    <ChevronDown aria-hidden className={cn("size-4 motion-safe:transition-transform", expanded && "rotate-180")} />
                  </button>
                ) : (
                  <span className="@max-[720px]/estimates:hidden" />
                )}
              </div>
              {expanded && sentences ? (
                <div className="mb-3 space-y-1 rounded-lg bg-surface-sunken p-3 text-body text-text-secondary">
                  <p className="font-medium text-foreground">{ratioFigure(expected.value)}</p>
                  <p>
                    {sentences.answer} {sentences.basis} {sentences.confidence}
                  </p>
                  {range ? (
                    <p>
                      {range.past}. {range.next}.
                    </p>
                  ) : null}
                  {sentences.alsoFor.length > 0 ? <p>Also used for: {sentences.alsoFor.join("; ")}.</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {olderCount > 0 ? (
        <button type="button" aria-expanded={showOlder} onClick={() => setShowOlder((value) => !value)} className="focus-ring relative mt-2 inline-flex h-6 min-h-0 items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
          <ChevronDown aria-hidden className={cn("size-3.5 motion-safe:transition-transform", showOlder && "rotate-180")} />
          {showOlder ? "Hide older history" : `Show older history (${olderCount} more rows, rebuilt from logs)`}
        </button>
      ) : null}
      <ul aria-hidden className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
        <li className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-[var(--viz-likely)]" />8 in 10 past tickets</li>
        <li className="inline-flex items-center gap-1.5"><span className="h-3 w-[3px] rounded-full bg-[var(--viz-marker)]" />Typical</li>
        <li className="inline-flex items-center gap-1.5"><span className="h-3 w-0 border-l-2 border-dashed border-[var(--viz-marker)]" />The estimate (100%)</li>
      </ul>
    </section>
  );
}

function LensSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true">
      <span className="sr-only">Loading estimates</span>
      <Skeleton className="h-3 w-64 rounded-full" />
      <Skeleton className="h-8 w-3/4 rounded-md" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
