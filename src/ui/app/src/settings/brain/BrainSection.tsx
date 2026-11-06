/**
 * THE "BRAIN" SECTION of the settings sheet: Overview (is it healthy, is it helping), Controls
 * (the synced policy, and this computer's hook installs), and the tools (recall, what an agent
 * gets, records).
 *
 * Built only from what the other sections are built from: `PlainCard` and `StatusPill` for the
 * overview (as Usage), `Section`, `Field` and `ActionBar` for the controls (as This computer),
 * the same checkbox, number and select controls `FieldsForm` renders, and the shared States.
 *
 * Synced and machine-local are never mixed in one row: every field says "Synced" or "This
 * computer" in the same quiet tag the other sections use for their scope.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, Loader2, OctagonAlert, TriangleAlert } from "lucide-react";
import { PlainCard } from "@/components/plain/PlainCard";
import { StatusPill } from "@/components/plain/StatusPill";
import { LoadingState, ProblemState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AuthError,
  getBrainConfig,
  getBrainOverview,
  getBrainRecords,
  saveBrainConfig,
  setBrainHooks,
  type BrainConfig,
  type BrainHookStatus,
  type BrainRecord,
  type BrainWritePolicy,
} from "@/lib/api";
import { DESK_QUERY, useMediaQuery } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { ActionBar, Field, Section } from "../form/primitives";
import { actionBarState, type SaveStatus } from "../form/form-model";
import { ContextTool, KINDS, RecallTool, RecordDialog, RecordsTool, errorText, scopeLabel, useLoad } from "./BrainTools";
import { BRAIN_TABS, VERDICT_WORDS, changeText, ms, num, pct, type BrainTab } from "./brain-settings";

/** The shell answers auth failures itself (the api module broadcasts them); a section only stops loading. */
const ignoreAuth = (_error: AuthError) => undefined;

const ROW = "flex items-baseline justify-between gap-3 border-t border-border/70 py-1.5 text-[13px] first:border-t-0";

function MetricRow({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className={ROW}>
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="shrink-0 text-right tabular-nums text-foreground">
        {value}
        {hint ? <span className="ml-1.5 text-[12px] text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

/** A 0–100% fill in the gauge's own tokens (`BudgetGauge`), with its sentence for a screen reader. */
function Meter({ value, description }: { value: number; description: string }) {
  const width = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div role="img" aria-label={description} className="h-3.5 overflow-hidden rounded-full border border-[var(--viz-track-edge)] bg-[var(--viz-track)]">
      <div className="h-full bg-[var(--viz-likely)]" style={{ width: `${width}%` }} />
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-surface-sunken px-2 py-px text-caption text-text-tertiary">{children}</span>;
}

// ---------------------------------------------------------------- section

export function BrainSection() {
  const desk = useMediaQuery(DESK_QUERY, true);
  const [tab, setTab] = useState<BrainTab>("overview");
  const [records, reloadRecords] = useLoad(getBrainRecords, [], ignoreAuth);
  const [open, setOpen] = useState<{ mode: "view" | "edit" | "supersede" | "new"; record: BrainRecord | null } | null>(null);
  const byId = useMemo(() => new Map((records.state === "ok" ? records.value.records : []).map((r) => [r.id, r])), [records]);
  const projectScopes = records.state === "ok" ? records.value.scopes.filter((s) => s.scope.startsWith("project:")) : [];
  const openId = (id: string) => {
    const record = byId.get(id);
    if (record) setOpen({ mode: "view", record });
  };

  return (
    <div data-brain-section className="space-y-5">
      <Tabs value={tab} onValueChange={(value) => setTab(value as BrainTab)} className="gap-4">
        {desk ? (
          <TabsList>
            {BRAIN_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="flex-none">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : (
          <Select value={tab} onValueChange={(value) => setTab(value as BrainTab)}>
            <SelectTrigger aria-label="Brain section" size="sm" className="w-full text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BRAIN_TABS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <TabsContent value="overview">
          <OverviewTab onOpen={openId} />
        </TabsContent>
        <TabsContent value="controls">
          <ControlsTab />
        </TabsContent>
        <TabsContent value="recall">
          <RecallTool projectScopes={projectScopes} onOpen={openId} onAuthError={ignoreAuth} />
        </TabsContent>
        <TabsContent value="context">
          <ContextTool projectScopes={projectScopes} version={records.state === "ok" ? records.value.records.length : 0} onAuthError={ignoreAuth} desk={false} />
        </TabsContent>
        <TabsContent value="records">
          {records.state === "ok" ? (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setOpen({ mode: "new", record: null })}>
                  New memory
                </Button>
              </div>
              <RecordsTool records={records.value.records} scopes={records.value.scopes} onOpen={(record) => setOpen({ mode: "view", record })} />
            </div>
          ) : records.state === "error" ? (
            <ProblemState title="The brain's records could not be read" message={records.message} />
          ) : (
            <LoadingState rows={6} />
          )}
        </TabsContent>
      </Tabs>
      <RecordDialog
        open={open}
        projectScopes={projectScopes}
        onClose={() => setOpen(null)}
        onMode={(mode) => setOpen((o) => (o ? { ...o, mode } : o))}
        onChanged={(record) => {
          reloadRecords();
          setOpen(record ? { mode: "view", record } : null);
        }}
        onAuthError={ignoreAuth}
      />
    </div>
  );
}

// ---------------------------------------------------------------- overview

function CheckIcon({ severity }: { severity: "ok" | "warn" | "critical" }) {
  const Icon = severity === "ok" ? CircleCheck : severity === "warn" ? TriangleAlert : OctagonAlert;
  const tone = severity === "ok" ? "ok" : severity === "warn" ? "tight" : "risk";
  return <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: `var(--plain-${tone}-fg)` }} />;
}

function OverviewTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [overview, reload] = useLoad(() => getBrainOverview(days), [days], ignoreAuth);
  const desk = useMediaQuery(DESK_QUERY, true);

  if (overview.state === "loading") return <LoadingState rows={6} label="Reading the brain" />;
  if (overview.state === "error") return <ProblemState title="The brain could not be read" message={overview.message} action={<Button size="sm" variant="outline" onClick={reload}>Try again</Button>} />;
  const o = overview.value;
  const v = VERDICT_WORDS[o.verdict];
  const h = o.helping;

  return (
    <div data-brain-overview className="space-y-4">
      <PlainCard
        title="At a glance"
        pill={<StatusPill status={v.status} label={v.label} />}
        headline={v.headline}
        help="The verdict is the worst of the checks below. Each check that is not green says what to do about it."
        data-brain-verdict={o.verdict}
      >
        <ul className="space-y-1.5">
          {o.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-2 text-[13px] leading-relaxed">
              <CheckIcon severity={c.severity} />
              <span className="min-w-0">{c.text}</span>
            </li>
          ))}
        </ul>
      </PlainCard>

      <div className={cn("grid gap-4", desk ? "grid-cols-2" : "grid-cols-1")}>
        <PlainCard
          title="Always-loaded memory"
          figure={pct(o.budget.utilization)}
          headline={
            o.budget.avgTokens === null
              ? `No session has started with the brain yet. The block may use up to ${num(o.budget.tokens)} tokens.`
              : `of the ${num(o.budget.tokens)}-token session-start budget: about ${num(o.budget.avgTokens)} tokens, ${num(o.budget.shown)} of the ${num(o.budget.eligible)} memories that apply.`
          }
          help="Every session starts with a short working brief and the memories that matter most for its project, ranked, cut at this budget. The rest stay one recall away."
          data-brain-card="budget"
        >
          {o.budget.utilization !== null ? <Meter value={o.budget.utilization} description={`${pct(o.budget.utilization)} of the session-start budget used`} /> : null}
        </PlainCard>

        <PlainCard
          title="Is it helping"
          figure={pct(h.citationRate)}
          headline="of sessions cited a memory they were shown."
          help="A citation is an agent naming a memory it relied on ([brain:name]). Prompts that found a memory are turns where per-prompt retrieval had something above its score floor that the session had not seen."
          data-brain-card="helping"
        >
          <div>
            <MetricRow label="Sessions that were given memories" value={`${num(h.sessionsWithMemories)} of ${num(h.sessions)}`} />
            <MetricRow label="Prompts that found a memory" value={pct(h.turnHitRate)} />
            <MetricRow label="Recalls that found something" value={pct(h.recallHitRate)} />
            <MetricRow label="Citations" value={num(h.citations)} />
          </div>
        </PlainCard>

        <PlainCard
          title="Recall quality"
          figure={h.eval ? pct(h.eval.r3) : "—"}
          headline={
            h.eval
              ? `of eval questions find the right memory in the top 3, ${pct(h.eval.r1)} first. ${num(h.eval.misses)} misses in ${num(h.eval.questions)} questions.`
              : "Not measured yet. Run staple brain eval with a question set."
          }
          help="The eval asks questions a person wrote from the memories themselves and checks whether recall ranks the memory that answers each one first, or in the top three."
          data-brain-card="eval"
        />

        <PlainCard
          title="Cost and speed"
          figure={h.tokensPerSessionStart === null ? "—" : `≈${num(h.tokensPerSessionStart)}`}
          headline={`tokens per session start, plus about ${num(h.tokensPerTurn)} on a prompt that finds something. Token counts are estimates.`}
          data-brain-card="cost"
        >
          <div>
            <MetricRow label="Session start" value={ms(h.latency.start.p50)} hint={`p95 ${ms(h.latency.start.p95)}`} />
            <MetricRow label="Each prompt" value={ms(h.latency.turn.p50)} hint={`p95 ${ms(h.latency.turn.p95)}`} />
            <MetricRow label="Recall" value={ms(h.latency.recall.p50)} hint={`p95 ${ms(h.latency.recall.p95)}`} />
          </div>
        </PlainCard>

        <PlainCard
          title="What it holds"
          figure={num(o.corpus.live)}
          headline={`memories in use: ${num(o.corpus.global)} global, the rest across ${num(o.corpus.projects)} projects.`}
          data-brain-card="corpus"
        >
          <div>
            {KINDS.map((k) => (
              <MetricRow key={k} label={k} value={num(o.corpus.byKind[k])} />
            ))}
          </div>
        </PlainCard>

        <PlainCard
          title="Provisional to durable"
          figure={num(o.corpus.provisional)}
          headline={`provisional now. ${num(o.corpus.promoted)} promoted by verify, ${num(o.corpus.expired)} expired unreviewed.`}
          help="Under the review policy, what agents write lands provisional until someone verifies it; a provisional memory past its expiry stops being used."
          data-brain-card="flow"
        >
          <div>
            <MetricRow label="Awaiting review" value={num(o.corpus.awaitingReview)} />
            <MetricRow label="Stale (unverified 30+ days, or a missing path)" value={num(o.corpus.stale)} />
            <MetricRow label="Superseded" value={num(o.corpus.superseded)} />
          </div>
        </PlainCard>
      </div>

      <PlainCard title="By agent" headline="Who uses the brain, and how." data-brain-card="agents">
        {o.agents.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No agent has used the brain yet.</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[30rem] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-muted-foreground">
                  {["Agent", "Sessions", "Prompts with memories", "Recalls", "Remembers", "Citations"].map((label, i) => (
                    <th key={label} className={cn("border-b border-border px-1 pb-1.5 font-medium", i > 0 && "text-right")}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {o.agents.map((a) => (
                  <tr key={a.agent} className="border-b border-border/70 last:border-0">
                    <td className="px-1 py-1.5">{a.label}</td>
                    {[a.sessions, a.turnInjections, a.recalls, a.remembers, a.citations].map((value, i) => (
                      <td key={i} className="px-1 py-1.5 text-right tabular-nums">
                        {num(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PlainCard>

      <div className={cn("grid gap-4", desk ? "grid-cols-2" : "grid-cols-1")}>
        <PlainCard
          title={`Last ${days} days`}
          pill={
            <Tabs value={String(days)} onValueChange={(value) => setDays(value === "30" ? 30 : 7)}>
              <TabsList className="h-7">
                <TabsTrigger value="7" className="flex-none text-[12px]">
                  7 days
                </TabsTrigger>
                <TabsTrigger value="30" className="flex-none text-[12px]">
                  30 days
                </TabsTrigger>
              </TabsList>
            </Tabs>
          }
          headline={`${num(o.delta.sessions)} sessions used the brain.`}
          data-brain-card="delta"
        >
          <div>
            <MetricRow label="Sessions" value={num(o.delta.sessions)} hint={changeText(o.delta.sessions, o.delta.sessionsBefore, o.delta.days)} />
            <MetricRow label="Prompts with memories" value={num(o.delta.turnsInjected)} hint={changeText(o.delta.turnsInjected, o.delta.turnsInjectedBefore, o.delta.days)} />
            <MetricRow label="Memories written by agents" value={num(o.delta.recordsAdded)} hint={changeText(o.delta.recordsAdded, o.delta.recordsAddedBefore, o.delta.days)} />
            <MetricRow label="Citations" value={num(o.delta.citations)} hint={changeText(o.delta.citations, o.delta.citationsBefore, o.delta.days)} />
          </div>
        </PlainCard>

        <PlainCard title="Most used" headline={`${num(o.neverUsed)} memories have never been shown, recalled or cited.`} data-brain-card="most-used">
          {o.mostUsed.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No memory has been used yet.</p>
          ) : (
            <div>
              {o.mostUsed.map((m) => (
                <div key={m.id} className={ROW}>
                  <button type="button" className="min-w-0 truncate text-left text-foreground underline-offset-2 hover:underline focus-ring" onClick={() => onOpen(m.id)}>
                    {m.name ?? m.id.slice(0, 8)}
                  </button>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {m.uses} shown · {m.cites} cited
                  </span>
                </div>
              ))}
            </div>
          )}
        </PlainCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- controls

const POLICY_TEXT: Record<BrainWritePolicy, string> = {
  auto: "Accept",
  review: "Review first",
  off: "Off",
};

const AGENT_ROWS = [
  { id: "claude", label: "Claude Code", description: "Gets the brain at session start and on each prompt through its hooks, and through the MCP tools." },
  { id: "codex", label: "Codex", description: "Gets the brain at session start and on each prompt through its hooks, and through the MCP tools." },
  { id: "mcp", label: "Other MCP clients", description: "Any other client of the staple MCP server: recall, remember, verify and forget." },
] as const;

function Checkbox({ id, checked, onChange, label, disabled }: { id: string; checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex h-7 items-center gap-2 text-[13px] pointer-coarse:h-11">
      <input id={id} type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="accent-primary size-4" />
      <span>{label}</span>
    </label>
  );
}

function NumberInput({ id, value, onChange, min, max, unit }: { id: string; value: number; onChange: (next: number) => void; min: number; max: number; unit: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-7 w-40 font-mono text-[12px]"
      />
      <span className="text-[12px] text-muted-foreground">{unit}</span>
    </div>
  );
}

function ControlsTab() {
  const [view, reload] = useLoad(getBrainConfig, [], ignoreAuth);
  const [draft, setDraft] = useState<BrainConfig | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hookBusy, setHookBusy] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);
  const served = view.state === "ok" ? view.value.synced : null;
  useEffect(() => {
    if (served && draft === null) setDraft(served);
  }, [served, draft]);
  const dirty = useMemo(() => Boolean(served && draft && JSON.stringify(served) !== JSON.stringify(draft)), [served, draft]);
  const set = useCallback((patch: (c: BrainConfig) => BrainConfig) => setDraft((d) => (d ? patch(structuredClone(d)) : d)), []);

  if (view.state === "loading" || !draft) return view.state === "error" ? <ProblemState title="The brain's settings could not be read" message={view.message} /> : <LoadingState rows={6} label="Reading the brain's settings" />;
  if (view.state === "error") return <ProblemState title="The brain's settings could not be read" message={view.message} />;
  const machine = view.value.machine;
  const synced = <Tag>Synced</Tag>;
  const local = <Tag>This computer</Tag>;
  const allScopes = draft.sync.scopes.length === 0;

  const save = () => {
    setStatus("pending");
    setError(null);
    saveBrainConfig(draft).then(
      (saved) => {
        setStatus("idle");
        setDraft(saved);
        reload();
      },
      (e) => {
        setStatus("failed");
        setError(errorText(e));
      },
    );
  };
  const hook = (h: BrainHookStatus, action: "install" | "remove") => {
    setHookBusy(h.agent);
    setHookError(null);
    setBrainHooks(h.agent, action).then(
      () => {
        setHookBusy(null);
        reload();
      },
      (e) => {
        setHookBusy(null);
        setHookError(`${h.label}: ${errorText(e)}`);
      },
    );
  };

  return (
    <div data-brain-controls className="space-y-8">
      <Section title="On this computer" description="What is true of this computer only, and never syncs: the hooks that put the brain in front of each CLI, and the sync connection. This preview only writes an isolated config home." error={hookError}>
        <div className="space-y-4">
          {machine.hooks.map((h) => {
            const installed = h.events.SessionStart && h.events.UserPromptSubmit;
            return (
              <Field
                key={h.agent}
                id={`brain-hooks-${h.agent}`}
                label={`${h.label} hooks`}
                tag={local}
                description={h.file ? `In ${h.file}` : (h.refusal ?? "")}
              >
                <div className="space-y-2">
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                    {(["SessionStart", "UserPromptSubmit", "Stop"] as const).map((event) => (
                      <li key={event} className="inline-flex items-center gap-1.5">
                        {h.events[event] ? <CircleCheck aria-hidden className="size-3.5" style={{ color: "var(--plain-ok-fg)" }} /> : <span aria-hidden className="inline-block size-3.5 rounded-full border border-border" />}
                        <span className={h.events[event] ? "text-foreground" : "text-muted-foreground"}>{event}</span>
                        <span className="sr-only">{h.events[event] ? "installed" : "not installed"}</span>
                      </li>
                    ))}
                  </ul>
                  {h.file ? (
                    <Button size="sm" variant={installed ? "ghost" : "outline"} disabled={hookBusy !== null || (!installed && !machine.hookBundlePresent)} onClick={() => hook(h, installed ? "remove" : "install")}>
                      {hookBusy === h.agent ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                      {installed ? "Remove hooks" : "Install hooks"}
                    </Button>
                  ) : null}
                </div>
              </Field>
            );
          })}
          <Field id="brain-sync-connection" label="Connection" tag={local} description={machine.sync.connected ? "This computer syncs the brain with your other devices." : "This computer is not connected, so nothing syncs from here yet. Connect the brain workspace with staple cloud connect --ws brain."}>
            <p className="flex h-7 items-center text-[13px]">{machine.sync.connected ? "Connected" : "Not connected"}</p>
          </Field>
        </div>
      </Section>

      <Section title="Brain" description="What every agent on every synced computer gets. These settings sync with the brain itself.">
        <div className="space-y-4">
          <Field id="brain-enabled" label="Brain" tag={synced} description="Off: agents start without memories, per-prompt retrieval stops, and the MCP tools say the brain is off.">
            <Checkbox id="brain-enabled" checked={draft.enabled} onChange={(next) => set((c) => ({ ...c, enabled: next }))} label={draft.enabled ? "On" : "Off"} />
          </Field>
        </div>
      </Section>

      <Section title="Agents" description="Which agents get the brain, and which may write to it with remember.">
        <div className="space-y-4">
          {AGENT_ROWS.map((a) => (
            <Field key={a.id} id={`brain-agent-${a.id}`} label={a.label} tag={synced} description={a.description}>
              <div className="flex flex-wrap gap-x-5">
                <Checkbox id={`brain-agent-${a.id}`} checked={draft.agents[a.id].enabled} onChange={(next) => set((c) => ((c.agents[a.id].enabled = next), c))} label="Gets the brain" />
                <Checkbox
                  id={`brain-agent-${a.id}-write`}
                  checked={draft.agents[a.id].write}
                  disabled={!draft.agents[a.id].enabled}
                  onChange={(next) => set((c) => ((c.agents[a.id].write = next), c))}
                  label="May write"
                />
              </div>
            </Field>
          ))}
        </div>
      </Section>

      <Section title="Writing" description="What happens to what agents learn.">
        <div className="space-y-4">
          <Field id="brain-write-policy" label="Write policy" tag={synced} description="Accept: what agents write is used right away. Review first: it stays provisional, out of every session, until a person verifies it under Records. Off: agents cannot write.">
            <Select value={draft.writePolicy} onValueChange={(value) => set((c) => ({ ...c, writePolicy: value as BrainWritePolicy }))}>
              <SelectTrigger id="brain-write-policy" size="sm" className="w-full text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(POLICY_TEXT) as BrainWritePolicy[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {POLICY_TEXT[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="brain-expiry" label="Provisional expiry" tag={synced} description="A provisional memory nobody verifies stops being used after this many days. 0 keeps it forever.">
            <NumberInput id="brain-expiry" value={draft.provisionalExpiryDays} min={0} max={3650} unit="days" onChange={(next) => set((c) => ({ ...c, provisionalExpiryDays: next }))} />
          </Field>
        </div>
      </Section>

      <Section title="Budgets" description="How much of an agent's context the brain may use, and how long a prompt may wait for it.">
        <div className="space-y-4">
          <Field id="brain-budget-session" label="Session start" tag={synced} description="The working brief and the ranked memories every session starts with.">
            <NumberInput id="brain-budget-session" value={draft.budgets.sessionTokens} min={200} max={20000} unit="tokens" onChange={(next) => set((c) => ((c.budgets.sessionTokens = next), c))} />
          </Field>
          <Field id="brain-budget-turn" label="Each prompt" tag={synced} description="Memories matching the prompt that the session has not seen yet.">
            <NumberInput id="brain-budget-turn" value={draft.budgets.turnTokens} min={0} max={10000} unit="tokens" onChange={(next) => set((c) => ((c.budgets.turnTokens = next), c))} />
          </Field>
          <Field id="brain-budget-ms" label="Prompt wait" tag={synced} description="Past this, per-prompt retrieval is skipped with a one-line notice so the prompt never waits on memory.">
            <NumberInput id="brain-budget-ms" value={draft.budgets.turnMs} min={50} max={5000} unit="ms" onChange={(next) => set((c) => ((c.budgets.turnMs = next), c))} />
          </Field>
        </div>
      </Section>

      <Section title="Sync" description="Which memories leave this computer. The sync connection itself is this computer's, set up under Cloud account.">
        <div className="space-y-4">
          <Field id="brain-sync" label="Sync memories" tag={synced} description="Off: new and changed memories stay on the computer that wrote them.">
            <Checkbox id="brain-sync" checked={draft.sync.enabled} onChange={(next) => set((c) => ((c.sync.enabled = next), c))} label={draft.sync.enabled ? "On" : "Off"} />
          </Field>
          <Field id="brain-sync-scopes" label="Scopes that sync" tag={synced} description="Global and each project's memories, one by one. Memories in a scope left out stay on this computer.">
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border px-2 py-1">
              <Checkbox id="brain-sync-scopes" checked={allScopes} disabled={!draft.sync.enabled} onChange={(next) => set((c) => ((c.sync.scopes = next ? [] : view.value.scopes.map((s) => s.scope)), c))} label="All scopes" />
              {view.value.scopes.map((s) => (
                <Checkbox
                  key={s.scope}
                  id={`brain-sync-scope-${s.scope}`}
                  checked={allScopes || draft.sync.scopes.includes(s.scope)}
                  disabled={!draft.sync.enabled || allScopes}
                  onChange={(next) => set((c) => ((c.sync.scopes = next ? [...c.sync.scopes, s.scope] : c.sync.scopes.filter((x) => x !== s.scope)), c))}
                  label={`${s.scope === "global" ? "Global" : scopeLabel(s.scope)} (${s.count})`}
                />
              ))}
            </div>
          </Field>
        </div>
      </Section>

      <ActionBar
        state={actionBarState({ dirty, status, resettable: true })}
        error={status === "failed" ? error : null}
        onSave={save}
        onCancel={() => setDraft(served)}
        onReset={() => setDraft(structuredClone(DEFAULTS))}
      />

    </div>
  );
}

const DEFAULTS: BrainConfig = {
  enabled: true,
  sync: { enabled: true, scopes: [] },
  agents: { claude: { enabled: true, write: true }, codex: { enabled: true, write: true }, mcp: { enabled: true, write: true } },
  writePolicy: "auto",
  budgets: { sessionTokens: 1500, turnTokens: 600, turnMs: 300 },
  provisionalExpiryDays: 30,
};

