/**
 * Settings → Brain → the tools: recall with scores, what an agent gets (the session-start
 * block and a sample prompt's turn), and record management (view, edit, supersede, forget,
 * new) in a dialog. Each calls the `/api/brain/*` route that runs what `staple brain` runs.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Brain, Pencil, Replace, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, LoadingState } from "@/components/plain/States";
import {
  AuthError,
  forgetBrain,
  getBrainContext,
  previewBrainTurn,
  recallBrain,
  rememberBrain,
  type BrainContextBlock,
  type BrainKind,
  type BrainRecord,
  type BrainTurnPreview,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export const KINDS: readonly BrainKind[] = ["feedback", "user", "project", "reference"];

/** `project:-Users-me-work-staple-tracker` reads as `…work-staple-tracker`. */
export function scopeLabel(scope: string): string {
  if (!scope.startsWith("project:")) return scope;
  const parts = scope.slice("project:".length).split("-").filter(Boolean);
  return parts.length > 3 ? `…${parts.slice(-3).join("-")}` : parts.join("-");
}

export const shortTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const EYEBROW = "text-caption font-medium uppercase tracking-wide text-muted-foreground";

export type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[], onAuthError: (e: AuthError) => void): [Load<T>, () => void] {
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

export function KindTag({ kind, provisional }: { kind: BrainKind; provisional?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 text-caption text-muted-foreground">
      {kind}
      {provisional ? " · provisional" : ""}
    </span>
  );
}

// ------------------------------------------------------------------ tools

/**
 * The Settings sheet's select (`FieldsForm`'s enum control), for a list of options. Radix
 * Select refuses an empty value, so "" travels as a sentinel.
 */
export function Picker({ label, value, onChange, options, className }: { label: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }>; className?: string }) {
  const NONE = "__none__";
  return (
    <Select value={value === "" ? NONE : value} onValueChange={(next) => onChange(next === NONE ? "" : next)}>
      <SelectTrigger aria-label={label} size="sm" className={cn("w-full min-w-0 text-[12px]", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || NONE} value={o.value === "" ? NONE : o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ScopeSelect({ value, onChange, projectScopes, withGlobal, label, emptyLabel = "no project (global only)", className }: { value: string; onChange: (value: string) => void; projectScopes: Array<{ scope: string; count: number }>; withGlobal?: boolean; label: string; emptyLabel?: string; className?: string }) {
  const first = withGlobal ? { value: "global", label: "Global" } : { value: "", label: emptyLabel };
  return <Picker label={label} value={value} onChange={onChange} className={cn("md:flex-1", className)} options={[first, ...projectScopes.map((s) => ({ value: s.scope, label: `${scopeLabel(s.scope)} (${s.count})` }))]} />;
}

export function RecallTool({ projectScopes, onOpen, onAuthError }: { projectScopes: Array<{ scope: string; count: number }>; onOpen: (id: string) => void; onAuthError: (e: AuthError) => void }) {
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
        <Input aria-label="Question" className="h-8 text-[13px] md:flex-[2]" placeholder="Ask what an agent would ask…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ScopeSelect label="Boost project" value={scope} onChange={setScope} projectScopes={projectScopes} emptyLabel="no project boost" />
        <Button type="submit" size="sm" disabled={!q.trim()}>
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

export function ContextTool({ projectScopes, version, onAuthError, desk }: { projectScopes: Array<{ scope: string; count: number }>; version: number; onAuthError: (e: AuthError) => void; desk: boolean }) {
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
        <Picker label="Agent" value={agent} onChange={(v) => setAgent(v as typeof agent)} className="md:w-40" options={AGENTS.map((a) => ({ value: a.id, label: a.label }))} />
        <ScopeSelect label="Project" value={scope} onChange={setScope} projectScopes={projectScopes} />
        <Input aria-label="Token budget" className="h-8 text-[13px] md:w-28" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
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
            <Input aria-label="Sample prompt" className="h-8 text-[13px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Button type="submit" size="sm" variant="outline">
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

export function RecordsTool({ records, scopes, onOpen }: { records: BrainRecord[]; scopes: Array<{ scope: string; count: number }>; onOpen: (record: BrainRecord) => void }) {
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
        <Input aria-label="Filter by name" className="h-8 text-[13px] md:flex-[2]" placeholder="Filter by name or description" value={text} onChange={(e) => setText(e.target.value)} />
        <Picker label="Kind" value={kind} onChange={(v) => setKind(v as "" | BrainKind)} className="md:w-36" options={[{ value: "", label: "All kinds" }, ...KINDS.map((k) => ({ value: k, label: k }))]} />
        <Picker label="Scope" value={scope} onChange={setScope} className="md:flex-1" options={[{ value: "", label: "All scopes" }, ...scopes.map((s) => ({ value: s.scope, label: `${s.scope === "global" ? "Global" : scopeLabel(s.scope)} (${s.count})` }))]} />
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
        <ul className="flex min-w-0 flex-col divide-y divide-border/60" data-slot="record-list">
          {shown.slice(0, 200).map((r) => (
            <li key={r.id} className="min-w-0">
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

export function RecordDialog({
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
        <Picker label="Kind" value={kind} onChange={(v) => setKind(v as BrainKind)} className="sm:w-36" options={KINDS.map((k) => ({ value: k, label: k }))} />
        <ScopeSelect label="Scope" value={scope} onChange={setScope} projectScopes={scopes} withGlobal />
      </div>
      <Input aria-label="Name" className="h-8 text-[13px]" placeholder="short-kebab-name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="Description" className="h-8 text-[13px]" placeholder="One line: what this is about" value={description} onChange={(e) => setDescription(e.target.value)} />
      <Textarea aria-label="Body" placeholder="The fact, in full" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      <Input aria-label="Why" className="h-8 text-[13px]" placeholder="Why it matters (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
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
