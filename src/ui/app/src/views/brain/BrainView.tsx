/**
 * The Brain destination (proof of concept): a dashboard of the shared agent
 * memory first, its tools second.
 *
 *   - KPI strip: records, sessions served, tokens per session start and per turn, the turn
 *     and recall hit rates, citations, hook latency.
 *   - Health: what is in it, by kind and scope; provisional against durable; stale records
 *     (unverified for 30 days, or naming a path that is gone); duplicate candidates.
 *   - Usage: per agent and per session, from the usage log; the most and never used memories.
 *   - Activity: a 60-day timeline of writes and injections, and the latest writes by source.
 *   - Eval: the latest recall@1/@3 and the misses.
 *   - Tools, in tabs: recall with scores; the exact block an agent gets at session start and on
 *     a sample prompt; record management (view, edit, supersede, forget, new) in a dialog.
 *
 * Every figure is a field of `GET /api/brain/stats` (`staple brain stats --json`), rendered,
 * never recomputed. Machine-level like Usage: no `ws`. Full width on desktop; one column under
 * the 768px breakpoint (`lib/use-media.ts`).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Brain, Pencil, Plus, RefreshCw, Replace, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, LoadingState, ProblemState } from "@/components/plain/States";
import {
  AuthError,
  forgetBrain,
  getBrainContext,
  getBrainRecords,
  getBrainStats,
  previewBrainTurn,
  recallBrain,
  rememberBrain,
  type BrainContextBlock,
  type BrainKind,
  type BrainRecord,
  type BrainStats,
  type BrainTurnPreview,
} from "@/lib/api";
import { DESK_QUERY, useMediaQuery } from "@/lib/use-media";
import { cn } from "@/lib/utils";

const KINDS: readonly BrainKind[] = ["feedback", "user", "project", "reference"];

/** `project:-Users-me-work-staple-tracker` reads as `…work-staple-tracker`. */
export function scopeLabel(scope: string): string {
  if (!scope.startsWith("project:")) return scope;
  const parts = scope.slice("project:".length).split("-").filter(Boolean);
  return parts.length > 3 ? `…${parts.slice(-3).join("-")}` : parts.join("-");
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude Code (hooks)",
  "claude-code": "Claude Code (MCP)",
  codex: "Codex (hooks)",
  "codex-mcp-client": "Codex (MCP)",
  cli: "staple CLI",
  web: "This page",
  probe: "Probes",
};
const providerLabel = (p: string | null) => (p ? (PROVIDER_LABEL[p] ?? p) : "unknown");

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString());
const ms = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x)} ms`);
const shortTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const FIELD = "h-control-md min-w-0 rounded-md border border-input bg-background px-2 text-body text-foreground focus-ring";
const EYEBROW = "text-caption font-medium uppercase tracking-wide text-muted-foreground";

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[], onAuthError: (e: AuthError) => void): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetcher().then(
      (value) => live && setLoad({ state: "ok", value }),
      (error) => {
        if (!live) return;
        if (error instanceof AuthError) onAuthError(error);
        else setLoad({ state: "error", message: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, onAuthError]);
  return [load, () => setTick((t) => t + 1)];
}

// ------------------------------------------------------------------ building blocks

function Panel({ title, description, action, children, className, testId }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section aria-label={title} data-panel={testId} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground", className)}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-label text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div data-slot="brain-stat" className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <span className="truncate text-caption font-medium text-muted-foreground">{label}</span>
      <span className="text-title font-semibold tabular-nums tracking-tight text-foreground">{value}</span>
      {hint ? <span className="truncate text-caption text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function BarRow({ label, value, max, note, tone = "strong", narrow = false }: { label: ReactNode; value: number; max: number; note?: ReactNode; tone?: "strong" | "soft"; narrow?: boolean }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cn("grid items-center gap-2", narrow ? "grid-cols-[2.25rem_minmax(0,1fr)_3rem]" : "grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto]")}>
      <span className="truncate text-label text-foreground">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn("block h-full rounded-full", tone === "strong" ? "bg-foreground/70" : "bg-muted-foreground/45")} style={{ width: `${width}%` }} />
      </span>
      <span className="text-right text-label tabular-nums text-muted-foreground">
        {value.toLocaleString()}
        {note ?? null}
      </span>
    </div>
  );
}

function KindTag({ kind, provisional }: { kind: BrainKind; provisional?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 text-caption text-muted-foreground">
      {kind}
      {provisional ? " · provisional" : ""}
    </span>
  );
}

/** `textCols` leading columns are text (left-aligned); the rest are figures (right-aligned, tabular). */
function Table({ head, rows, empty, textCols = 1 }: { head: string[]; rows: ReactNode[][]; empty: string; textCols?: number }) {
  if (rows.length === 0) return <p className="text-label text-muted-foreground">{empty}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[28rem] border-collapse text-label">
        <thead>
          <tr className="text-left text-caption text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={cn("border-b border-border px-1 pb-1.5 font-medium", i >= textCols && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border/60 last:border-0">
              {row.map((cell, i) => (
                <td key={i} className={cn("px-1 py-1.5 text-foreground", i >= textCols && "text-right tabular-nums")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ the page

export function BrainView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const desk = useMediaQuery(DESK_QUERY, true);
  const [stats, reloadStats] = useLoad(getBrainStats, [], onAuthError);
  const [records, reloadRecords] = useLoad(getBrainRecords, [], onAuthError);
  const [open, setOpen] = useState<{ mode: "view" | "edit" | "supersede" | "new"; record: BrainRecord | null } | null>(null);
  const reload = useCallback(() => {
    reloadStats();
    reloadRecords();
  }, [reloadStats, reloadRecords]);

  const byId = useMemo(() => new Map((records.state === "ok" ? records.value.records : []).map((r) => [r.id, r])), [records]);
  const openId = (id: string) => {
    const record = byId.get(id);
    if (record) setOpen({ mode: "view", record });
  };

  if (stats.state === "loading" || records.state === "loading") return <LoadingState rows={8} label="Loading the brain" />;
  const failure = stats.state === "error" ? stats.message : records.state === "error" ? records.message : null;
  if (failure !== null || stats.state !== "ok" || records.state !== "ok") {
    return (
      <div className="px-page py-4">
        <ProblemState title="The brain could not be read" message={failure ?? undefined} />
      </div>
    );
  }
  const s = stats.value;
  const projectScopes = records.value.scopes.filter((x) => x.scope.startsWith("project:"));

  return (
    <div className="h-full overflow-y-auto" data-view="brain">
      <div className="flex w-full flex-col gap-4 px-page py-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-label text-muted-foreground">
            Shared memory for every agent. Figures as of {shortTime(s.generatedAt)}, from {num(s.usage.events)} logged events.
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw /> Refresh
          </Button>
          <Button size="sm" onClick={() => setOpen({ mode: "new", record: null })}>
            <Plus /> New memory
          </Button>
        </div>

        <KpiStrip stats={s} />

        <div className={cn("grid items-start gap-4", desk ? "grid-cols-3" : "grid-cols-1")}>
          <HealthPanel stats={s} onOpen={openId} />
          <UsagePanel stats={s} className={desk ? "col-span-2" : undefined} />
          <ActivityPanel stats={s} onOpen={openId} className={desk ? "col-span-2" : undefined} />
          <div className="flex min-w-0 flex-col gap-4">
            <EvalPanel stats={s} />
            <MostUsedPanel stats={s} onOpen={openId} />
          </div>
        </div>

        <section aria-label="Tools" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
          <Tabs defaultValue="recall">
            <TabsList>
              <TabsTrigger value="recall">Recall</TabsTrigger>
              <TabsTrigger value="context">What an agent gets</TabsTrigger>
              <TabsTrigger value="records">Records</TabsTrigger>
            </TabsList>
            <TabsContent value="recall" className="pt-3">
              <RecallTool projectScopes={projectScopes} onOpen={openId} onAuthError={onAuthError} />
            </TabsContent>
            <TabsContent value="context" className="pt-3">
              <ContextTool projectScopes={projectScopes} version={s.health.total} onAuthError={onAuthError} desk={desk} />
            </TabsContent>
            <TabsContent value="records" className="pt-3">
              <RecordsTool records={records.value.records} scopes={records.value.scopes} onOpen={(record) => setOpen({ mode: "view", record })} />
            </TabsContent>
          </Tabs>
        </section>
      </div>

      <RecordDialog
        open={open}
        projectScopes={projectScopes}
        onClose={() => setOpen(null)}
        onMode={(mode) => setOpen((o) => (o ? { ...o, mode } : o))}
        onChanged={(record) => {
          reload();
          setOpen(record ? { mode: "view", record } : null);
        }}
        onAuthError={onAuthError}
      />
    </div>
  );
}

function KpiStrip({ stats: s }: { stats: BrainStats }) {
  const start = s.usage.latency.session_start;
  const turn = s.usage.latency.turn;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8" data-slot="kpis">
      <Stat label="Memories" value={num(s.health.live)} hint={`${num(s.health.superseded)} superseded · ${num(s.health.provisional)} provisional`} />
      <Stat label="Sessions served" value={num(s.usage.sessions)} hint={`${s.usage.byProvider.filter((p) => p.sessions > 0).length} agents`} />
      <Stat label="Tokens at session start" value={num(s.usage.avgTokens.sessionStart)} hint="average, chars/4" />
      <Stat label="Tokens per injecting turn" value={num(s.usage.avgTokens.turn)} hint="average, chars/4" />
      <Stat label="Turns that injected" value={pct(s.usage.turnInjectionRate)} hint="above the score floor, unseen" />
      <Stat label="Recall hit rate" value={pct(s.usage.recallHitRate)} hint="recalls returning a memory" />
      <Stat label="Citations" value={num(s.usage.citations)} hint="memories agents said they used" />
      <Stat label="Hook latency p95" value={ms(Math.max(start?.p95 ?? 0, turn?.p95 ?? 0) || null)} hint={`p50 start ${ms(start?.p50)} · turn ${ms(turn?.p50)}`} />
    </div>
  );
}

function HealthPanel({ stats: s, onOpen }: { stats: BrainStats; onOpen: (id: string) => void }) {
  const kindMax = Math.max(...KINDS.map((k) => s.health.byKind[k]), 1);
  const scopeMax = Math.max(s.health.global, ...s.health.projects.map((p) => p.count), 1);
  return (
    <Panel title="Health" description={`${num(s.health.live)} live of ${num(s.health.total)} records`} testId="health">
      <div className="flex flex-col gap-1.5">
        <p className={EYEBROW}>By kind</p>
        {KINDS.map((k) => (
          <BarRow key={k} label={k} value={s.health.byKind[k]} max={kindMax} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <p className={EYEBROW}>By scope</p>
        <BarRow label="global" value={s.health.global} max={scopeMax} />
        {s.health.projects.slice(0, 5).map((p) => (
          <BarRow key={p.scope} label={<span title={p.scope}>{scopeLabel(p.scope)}</span>} value={p.count} max={scopeMax} tone="soft" />
        ))}
        {s.health.projects.length > 5 ? <p className="text-caption text-muted-foreground">+{s.health.projects.length - 5} more projects</p> : null}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Durable", s.health.durable],
          ["Provisional", s.health.provisional],
          ["Superseded", s.health.superseded],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg border p-2">
            <p className="text-title font-semibold tabular-nums">{num(value as number)}</p>
            <p className="text-caption text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <p className={EYEBROW}>Stale · {s.health.stale.length}</p>
        {s.health.stale.length === 0 ? (
          <p className="text-label text-muted-foreground">Nothing unverified for 30 days, and no record names a missing path.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {s.health.stale.slice(0, 5).map((x) => (
              <li key={x.id} className="min-w-0">
                <button type="button" className="max-w-full truncate text-left text-label text-foreground underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(x.id)}>
                  {x.name ?? x.id.slice(0, 8)}
                </button>
                <p className="truncate text-caption text-muted-foreground">{x.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className={EYEBROW}>Duplicate candidates · {s.health.duplicates.length}</p>
        {s.health.duplicates.length === 0 ? (
          <p className="text-label text-muted-foreground">No two records describe themselves alike.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {s.health.duplicates.slice(0, 4).map((d) => (
              <li key={`${d.a.id}-${d.b.id}`} className="flex min-w-0 items-center gap-1 text-label">
                <button type="button" className="truncate underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(d.a.id)}>
                  {d.a.name ?? d.a.id.slice(0, 8)}
                </button>
                <span className="shrink-0 text-muted-foreground">≈</span>
                <button type="button" className="truncate underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(d.b.id)}>
                  {d.b.name ?? d.b.id.slice(0, 8)}
                </button>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{pct(d.similarity)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function UsagePanel({ stats: s, className }: { stats: BrainStats; className?: string }) {
  const latencyRows = Object.entries(s.usage.latency)
    .filter(([event]) => event !== "eval")
    .map(([event, l]) => [event.replace("_", " "), num(l.n), ms(l.p50), ms(l.p95)]);
  return (
    <Panel title="Usage" description="From the usage log: every injection, recall, write and citation." className={className} testId="usage">
      <div className="flex flex-col gap-1.5">
        <p className={EYEBROW}>By agent</p>
        <Table
          head={["Agent", "Sessions", "Injections", "Recalls", "Writes", "Citations"]}
          rows={s.usage.byProvider.map((p) => [providerLabel(p.provider), num(p.sessions), num(p.injections), num(p.recalls), num(p.writes), num(p.cites)])}
          empty="No agent has used the brain yet."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className={EYEBROW}>Recent sessions</p>
        <Table
          head={["Session", "Agent", "Started", "Turns", "Memories shown", "Tokens", "Cited"]}
          textCols={3}
          rows={s.usage.perSession.slice(0, 8).map((x) => [
            <span key="s" className="font-mono text-caption">{x.session.slice(0, 8)}</span>,
            providerLabel(x.provider),
            shortTime(x.startedAt),
            num(x.turns),
            num(x.injected),
            num(x.tokens),
            num(x.cites),
          ])}
          empty="No hooked session yet. Install the SessionStart and UserPromptSubmit hooks."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className={EYEBROW}>Latency</p>
        <Table head={["Event", "Count", "p50", "p95"]} rows={latencyRows} empty="No timings yet." />
      </div>
    </Panel>
  );
}

function ActivityPanel({ stats: s, onOpen, className }: { stats: BrainStats; onOpen: (id: string) => void; className?: string }) {
  const days = s.activity.timeline.slice(-30);
  // Two series, two scales: one busy day of injections must not flatten a month of writes.
  const series = [
    { key: "written", label: "Memories written", value: (d: (typeof days)[number]) => d.created + d.updated, tone: "bg-foreground/70" },
    { key: "used", label: "Injected or recalled", value: (d: (typeof days)[number]) => d.injections + d.recalls, tone: "bg-muted-foreground/50" },
  ];
  return (
    <Panel title="Activity" description="The last 30 active days, and the latest writes by agents and people." className={className} testId="activity">
      <div className="flex flex-col gap-3" data-slot="timeline">
        {series.map((line) => {
          const max = Math.max(1, ...days.map(line.value));
          const total = days.reduce((n, d) => n + line.value(d), 0);
          return (
            <div key={line.key} className="flex flex-col gap-1">
              <p className="flex items-baseline gap-2 text-caption text-muted-foreground">
                <span className={cn("size-2 shrink-0 self-center rounded-sm", line.tone)} aria-hidden />
                <span className="font-medium text-foreground">{line.label}</span>
                <span className="tabular-nums">{total.toLocaleString()} total · peak {max.toLocaleString()}/day</span>
              </p>
              <div className="flex h-12 items-end gap-1 border-b border-border" role="img" aria-label={`${line.label} per day`}>
                {days.map((d) => {
                  const v = line.value(d);
                  return (
                    <div key={d.day} className="flex h-full min-w-0 flex-1 items-end" title={`${d.day}: ${v}`}>
                      <span className={cn("block w-full rounded-t-sm", line.tone)} style={{ height: v ? `${Math.max(6, (v / max) * 100)}%` : "0" }} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
          {days.length ? (
            <span className="ml-auto tabular-nums">
              {days[0]!.day} – {days[days.length - 1]!.day}
            </span>
          ) : null}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={EYEBROW}>Latest writes</p>
          {s.activity.recentWrites.length === 0 ? (
            <p className="text-label text-muted-foreground">Only imported memories so far.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {s.activity.recentWrites.slice(0, 6).map((w) => (
                <li key={w.id} className="flex min-w-0 items-center gap-2 py-1.5">
                  <KindTag kind={w.kind} />
                  <button type="button" className={cn("min-w-0 flex-1 truncate text-left text-label text-foreground underline-offset-2 hover:underline focus-ring", w.superseded && "line-through")} onClick={() => onOpen(w.id)}>
                    {w.name ?? w.id.slice(0, 8)}
                  </button>
                  <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">{w.source ?? "unknown"}</span>
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{shortTime(w.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={EYEBROW}>Written by</p>
          {s.activity.bySource.map((x) => (
            <BarRow key={x.source} label={x.source} value={x.count} max={Math.max(...s.activity.bySource.map((y) => y.count), 1)} tone="soft" />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function EvalPanel({ stats: s }: { stats: BrainStats }) {
  const e = s.eval?.detail;
  if (!s.eval || !e?.all) {
    return (
      <Panel title="Recall eval" testId="eval">
        <EmptyState compact title="No eval run yet">Run `staple brain eval --questions FILE` to measure recall.</EmptyState>
      </Panel>
    );
  }
  const row = (label: string, x?: { n: number; unscoped: { r1: number; r3: number } }) =>
    x ? (
      <div key={label} className="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
        <span className="text-label text-muted-foreground">
          {label} <span className="tabular-nums">({x.n})</span>
        </span>
        <BarRow narrow label="R@1" value={Math.round(x.unscoped.r1 * 100)} max={100} note="%" />
        <BarRow narrow label="R@3" value={Math.round(x.unscoped.r3 * 100)} max={100} note="%" />
      </div>
    ) : null;
  return (
    <Panel title="Recall eval" description={`${num(e.questions)} questions over ${num(e.records)} records · ${shortTime(s.eval.at)}`} testId="eval">
      <div className="flex items-baseline gap-4">
        <p className="text-[26px] font-semibold leading-tight tracking-tight tabular-nums">{pct(e.all.unscoped.r3)}</p>
        <p className="text-label text-muted-foreground">
          found in the top 3 · {pct(e.all.unscoped.r1)} first
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {row("easy", e.easy)}
        {row("hard", e.hard)}
      </div>
      <div className="flex flex-col gap-1">
        <p className={EYEBROW}>Misses · {e.misses?.length ?? 0}</p>
        {(e.misses ?? []).map((m) => (
          <div key={m.id} className="min-w-0 text-label">
            <p className="truncate text-foreground">
              {m.id} <span className="text-muted-foreground">[{m.difficulty}] rank {m.rank ?? ">10"}</span>
            </p>
            <p className="truncate text-caption text-muted-foreground">
              wanted {m.target} · got {m.got.join(", ")}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function MostUsedPanel({ stats: s, onOpen }: { stats: BrainStats; onOpen: (id: string) => void }) {
  return (
    <Panel title="What agents use" description={`${num(s.usage.neverUsed.length)} memories never shown, recalled or cited`} testId="most-used">
      {s.usage.mostUsed.length === 0 ? (
        <p className="text-label text-muted-foreground">No memory has been used yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {s.usage.mostUsed.slice(0, 6).map((m, i) => (
            <li key={m.id} className="flex min-w-0 items-center gap-2 text-label">
              <span className="w-4 shrink-0 tabular-nums text-muted-foreground">{i + 1}</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(m.id)}>
                {m.name ?? m.id.slice(0, 8)}
              </button>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {m.uses} shown · {m.cites} cited
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ tools

function ScopeSelect({ value, onChange, projectScopes, withGlobal, label, emptyLabel = "no project (global only)" }: { value: string; onChange: (value: string) => void; projectScopes: Array<{ scope: string; count: number }>; withGlobal?: boolean; label: string; emptyLabel?: string }) {
  return (
    <select aria-label={label} className={cn(FIELD, "flex-1")} value={value} onChange={(e) => onChange(e.target.value)}>
      {withGlobal ? <option value="global">global</option> : <option value="">{emptyLabel}</option>}
      {projectScopes.map((s) => (
        <option key={s.scope} value={s.scope}>
          {scopeLabel(s.scope)} ({s.count})
        </option>
      ))}
    </select>
  );
}

function RecallTool({ projectScopes, onOpen, onAuthError }: { projectScopes: Array<{ scope: string; count: number }>; onOpen: (id: string) => void; onAuthError: (e: AuthError) => void }) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const [result, setResult] = useState<Load<Awaited<ReturnType<typeof recallBrain>>> | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!q.trim()) return;
    setResult({ state: "loading" });
    recallBrain(q, scope ? { scope } : {}).then(
      (value) => setResult({ state: "ok", value }),
      (error) => (error instanceof AuthError ? onAuthError(error) : setResult({ state: "error", message: errorText(error) })),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-label text-muted-foreground">Full-text search (bm25), as an agent's `recall` runs it. A chosen project boosts its own memories 1.5×.</p>
      <form className="flex flex-col gap-2 md:flex-row" onSubmit={submit} role="search">
        <Input aria-label="Question" className="md:flex-[2]" placeholder="Ask what an agent would ask…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ScopeSelect label="Boost project" value={scope} onChange={setScope} projectScopes={projectScopes} emptyLabel="no project boost" />
        <Button type="submit" disabled={!q.trim()}>
          <Search /> Search
        </Button>
      </form>
      {result === null ? null : result.state === "loading" ? (
        <LoadingState rows={3} label="Searching" />
      ) : result.state === "error" ? (
        <p className="text-label text-destructive">{result.message}</p>
      ) : result.value.hits.length === 0 ? (
        <EmptyState compact title="No memory matches">Recall matches words, not meaning. Try other words.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          <p className={EYEBROW}>
            {result.value.hits.length} hits · {result.value.ms} ms
          </p>
          <ol className="grid gap-2 xl:grid-cols-2">
            {result.value.hits.map((hit, i) => (
              <li key={hit.record.id} className="flex min-w-0 flex-col gap-1 rounded-lg border p-3" data-slot="recall-hit">
                <div className="flex items-baseline gap-2">
                  <span className="w-5 shrink-0 text-label tabular-nums text-muted-foreground">{i + 1}.</span>
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-body font-medium text-foreground underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(hit.record.id)}>
                    {hit.record.name ?? hit.record.id.slice(0, 8)}
                  </button>
                  <span className="shrink-0 text-label tabular-nums text-muted-foreground" title="bm25 score, higher is better">
                    {hit.score.toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-7">
                  <KindTag kind={hit.record.kind} provisional={hit.record.provisional} />
                  <span className="text-caption text-muted-foreground">{scopeLabel(hit.record.scope)}</span>
                </div>
                {hit.record.description ? <p className="pl-7 text-label text-muted-foreground">{hit.record.description}</p> : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

function Envelope({ agent, event, text, testId }: { agent: string; event: string; text: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-caption text-muted-foreground">
        {agent} reads this as <code className="font-mono">hookSpecificOutput.additionalContext</code> on <code className="font-mono">{event}</code>.
      </p>
      <pre data-slot={testId} className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted p-3 text-caption text-foreground">
        {text || "(nothing: the hook answers empty, so the agent sees no block)"}
      </pre>
    </div>
  );
}

function ContextTool({ projectScopes, version, onAuthError, desk }: { projectScopes: Array<{ scope: string; count: number }>; version: number; onAuthError: (e: AuthError) => void; desk: boolean }) {
  const [scope, setScope] = useState(projectScopes[0]?.scope ?? "");
  const [agent, setAgent] = useState<(typeof AGENTS)[number]["id"]>("claude");
  const [budget, setBudget] = useState("1500");
  const [prompt, setPrompt] = useState("How do I run the tests here?");
  const [asked, setAsked] = useState(prompt);
  const target = scope ? { scope } : {};
  const [block] = useLoad<BrainContextBlock>(() => getBrainContext(target, Number(budget) || undefined), [scope, budget, version], onAuthError);
  const [turn] = useLoad<BrainTurnPreview>(() => previewBrainTurn(target, asked), [scope, asked, version], onAuthError);
  const agentLabel = AGENTS.find((a) => a.id === agent)!.label;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-label text-muted-foreground">
        Exactly what the brain's hooks hand an agent in this project: the session-start block, then what its first prompt adds (memories the start block already showed are left out, as in a real session).
      </p>
      <div className="flex flex-col gap-2 md:flex-row">
        <select aria-label="Agent" className={cn(FIELD, "md:w-40")} value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)}>
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <ScopeSelect label="Project" value={scope} onChange={setScope} projectScopes={projectScopes} />
        <Input aria-label="Token budget" className="md:w-28" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>
      <div className={cn("grid gap-4", desk ? "grid-cols-2" : "grid-cols-1")}>
        <div className="flex min-w-0 flex-col gap-2">
          <p className={EYEBROW} data-slot="context-tokens">
            {block.state === "ok"
              ? `Session start · ≈${block.value.tokens.toLocaleString()} tokens of ${block.value.budget.toLocaleString()} · ${block.value.shown} of ${block.value.eligible} memories`
              : "Session start"}
          </p>
          {block.state === "ok" ? <Envelope agent={agentLabel} event="SessionStart" text={block.value.text} testId="context-block" /> : block.state === "error" ? <p className="text-label text-destructive">{block.message}</p> : <LoadingState rows={4} />}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(prompt);
            }}
          >
            <Input aria-label="Sample prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Button type="submit" variant="outline">
              Preview turn
            </Button>
          </form>
          <p className={EYEBROW} data-slot="turn-tokens">
            {turn.state === "ok"
              ? `First prompt · ≈${turn.value.tokens.toLocaleString()} tokens · ${turn.value.ids.length} new · ${turn.value.skippedAsSeen} already shown · ${turn.value.belowFloor} below the floor · ${turn.value.ms} ms`
              : "First prompt"}
          </p>
          {turn.state === "ok" ? <Envelope agent={agentLabel} event="UserPromptSubmit" text={turn.value.text} testId="turn-block" /> : turn.state === "error" ? <p className="text-label text-destructive">{turn.message}</p> : <LoadingState rows={3} />}
        </div>
      </div>
    </div>
  );
}

function RecordsTool({ records, scopes, onOpen }: { records: BrainRecord[]; scopes: Array<{ scope: string; count: number }>; onOpen: (record: BrainRecord) => void }) {
  const [kind, setKind] = useState<"" | BrainKind>("");
  const [scope, setScope] = useState("");
  const [text, setText] = useState("");
  const [showSuperseded, setShowSuperseded] = useState(false);
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return records
      .filter((r) => (kind ? r.kind === kind : true) && (scope ? r.scope === scope : true) && (showSuperseded || r.supersededBy === null))
      .filter((r) => !needle || `${r.name ?? ""} ${r.description ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [records, kind, scope, text, showSuperseded]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <Input aria-label="Filter by name" className="md:flex-[2]" placeholder="Filter by name or description" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Kind" className={cn(FIELD, "md:w-36")} value={kind} onChange={(e) => setKind(e.target.value as "" | BrainKind)}>
          <option value="">all kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select aria-label="Scope" className={cn(FIELD, "md:flex-1")} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">all scopes</option>
          {scopes.map((s) => (
            <option key={s.scope} value={s.scope}>
              {scopeLabel(s.scope)} ({s.count})
            </option>
          ))}
        </select>
        <label className="flex shrink-0 items-center gap-2 text-label text-muted-foreground">
          <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} /> superseded
        </label>
      </div>
      <p className={EYEBROW}>
        {shown.length} of {records.length}
      </p>
      {shown.length === 0 ? (
        <EmptyState compact icon={Brain} title="No records here" />
      ) : (
        <ul className="grid divide-y divide-border/60" data-slot="record-list">
          {shown.slice(0, 200).map((r) => (
            <li key={r.id}>
              <button type="button" className="flex w-full min-w-0 items-center gap-2 py-2 text-left hover:bg-surface-hover focus-ring" onClick={() => onOpen(r)}>
                <KindTag kind={r.kind} provisional={r.provisional} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-body font-medium text-foreground", r.supersededBy && "line-through")}>{r.name ?? r.id.slice(0, 8)}</span>
                  {r.description ? <span className="block truncate text-label text-muted-foreground">{r.description}</span> : null}
                </span>
                <span className="hidden shrink-0 text-caption text-muted-foreground md:inline">{scopeLabel(r.scope)}</span>
                <span className="hidden shrink-0 text-caption tabular-nums text-muted-foreground lg:inline">{shortTime(r.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the record dialog

function RecordDialog({
  open,
  projectScopes,
  onClose,
  onMode,
  onChanged,
  onAuthError,
}: {
  open: { mode: "view" | "edit" | "supersede" | "new"; record: BrainRecord | null } | null;
  projectScopes: Array<{ scope: string; count: number }>;
  onClose: () => void;
  onMode: (mode: "view" | "edit" | "supersede") => void;
  onChanged: (record: BrainRecord | null) => void;
  onAuthError: (e: AuthError) => void;
}) {
  const record = open?.record ?? null;
  const mode = open?.mode ?? "view";
  const [arming, setArming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setArming(false);
    setProblem(null);
  }, [open]);

  const fail = (error: unknown) => (error instanceof AuthError ? onAuthError(error) : setProblem(errorText(error)));
  const title = mode === "new" ? "New memory" : mode === "edit" ? "Edit memory" : mode === "supersede" ? "Supersede memory" : (record?.name ?? record?.id.slice(0, 8) ?? "");

  return (
    <Dialog open={open !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-brain-dialog>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "supersede"
              ? "Write the corrected memory. The old one stays in history, marked as replaced, and agents stop seeing it."
              : mode === "new"
                ? "One durable fact an agent should know next time."
                : record
                  ? `${record.kind} · ${scopeLabel(record.scope)} · ${record.source ?? "unknown source"}`
                  : ""}
          </DialogDescription>
        </DialogHeader>
        {problem ? <p className="text-label text-destructive">{problem}</p> : null}
        {mode === "view" && record ? (
          <>
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
              <dt className="text-muted-foreground">Id</dt>
              <dd className="truncate font-mono text-caption">{record.id}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{shortTime(record.createdAt)}</dd>
              <dt className="text-muted-foreground">Verified</dt>
              <dd>{record.verifiedAt ? shortTime(record.verifiedAt) : "never"}</dd>
              {record.supersededBy ? (
                <>
                  <dt className="text-muted-foreground">Replaced by</dt>
                  <dd className="truncate font-mono text-caption">{record.supersededBy}</dd>
                </>
              ) : null}
              {record.description ? (
                <>
                  <dt className="text-muted-foreground">About</dt>
                  <dd>{record.description}</dd>
                </>
              ) : null}
              {record.why ? (
                <>
                  <dt className="text-muted-foreground">Why</dt>
                  <dd>{record.why}</dd>
                </>
              ) : null}
            </dl>
            <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted p-3 text-label text-foreground">{record.body}</pre>
            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              {arming ? (
                <div className="flex gap-2">
                  <Button variant="destructive" onClick={() => forgetBrain(record.id).then(() => onChanged(null), fail)}>
                    Forget everywhere
                  </Button>
                  <Button variant="ghost" onClick={() => setArming(false)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setArming(true)}>
                  <Trash2 /> Forget
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onMode("supersede")} disabled={record.supersededBy !== null}>
                  <Replace /> Supersede
                </Button>
                <Button onClick={() => onMode("edit")}>
                  <Pencil /> Edit
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : open ? (
          <RecordForm
            key={`${mode}-${record?.id ?? "new"}`}
            mode={mode as "edit" | "supersede" | "new"}
            record={record}
            projectScopes={projectScopes}
            onSaved={onChanged}
            onError={fail}
            onCancel={() => (record ? onMode("view") : onClose())}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RecordForm({ mode, record, projectScopes, onSaved, onError, onCancel }: { mode: "edit" | "supersede" | "new"; record: BrainRecord | null; projectScopes: Array<{ scope: string; count: number }>; onSaved: (r: BrainRecord) => void; onError: (e: unknown) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<BrainKind>(record?.kind ?? "feedback");
  const [scope, setScope] = useState(record?.scope ?? "global");
  const [name, setName] = useState(record?.name ?? "");
  const [description, setDescription] = useState(record?.description ?? "");
  const [body, setBody] = useState(record?.body ?? "");
  const [why, setWhy] = useState(record?.why ?? "");
  const [provisional, setProvisional] = useState(record?.provisional ?? false);
  const [busy, setBusy] = useState(false);
  const scopes = record && record.scope !== "global" && !projectScopes.some((s) => s.scope === record.scope) ? [{ scope: record.scope, count: 0 }, ...projectScopes] : projectScopes;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    rememberBrain({
      kind,
      scope,
      name,
      description,
      body,
      why,
      provisional,
      ...(mode === "edit" && record ? { id: record.id } : {}),
      ...(mode === "supersede" && record ? { supersedes: record.id } : {}),
    }).then(
      (saved) => {
        setBusy(false);
        onSaved(saved);
      },
      (error) => {
        setBusy(false);
        onError(error);
      },
    );
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select aria-label="Kind" className={cn(FIELD, "sm:w-36")} value={kind} onChange={(e) => setKind(e.target.value as BrainKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <ScopeSelect label="Scope" value={scope} onChange={setScope} projectScopes={scopes} withGlobal />
      </div>
      <Input aria-label="Name" placeholder="short-kebab-name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="Description" placeholder="One line: what this is about" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Textarea aria-label="Body" placeholder="The fact, in full" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      <Input aria-label="Why" placeholder="Why it matters (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
      <label className="flex items-center gap-2 text-label text-muted-foreground">
        <input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} /> Provisional (unconfirmed)
      </label>
      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !body.trim()}>
          {mode === "edit" ? "Save changes" : mode === "supersede" ? "Write replacement" : "Remember"}
        </Button>
      </DialogFooter>
    </form>
  );
}
