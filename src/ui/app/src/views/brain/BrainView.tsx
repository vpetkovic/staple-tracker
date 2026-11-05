/**
 * The Brain destination (proof of concept): the shared agent memory, read and
 * written the way `staple brain` does.
 *
 * Four panels, each one call:
 *   - Recall: a question, the ranked hits with their bm25 score (`GET /api/brain/recall`).
 *   - Context preview: the exact block the SessionStart hook injects for a project, with its
 *     token estimate and how many records the budget cut (`GET /api/brain/context`).
 *   - Records: every record, filtered by kind and scope; forget from the row.
 *   - Remember: a small form (`POST /api/brain/remember`).
 *
 * Machine-level like Usage: the brain is its own global workspace, so the view takes no `ws`.
 * Desktop is two columns from the one 768px breakpoint (`lib/use-media.ts`); phone stacks them.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Brain, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, LoadingState, ProblemState } from "@/components/plain/States";
import {
  AuthError,
  forgetBrain,
  getBrainContext,
  getBrainRecords,
  recallBrain,
  rememberBrain,
  type BrainContextBlock,
  type BrainKind,
  type BrainRecord,
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

const FIELD = "h-control-md rounded-md border border-input bg-background px-2 text-body text-foreground focus-ring";
const PANEL = "rounded-lg border border-border bg-card p-4";
const EYEBROW = "text-caption font-medium uppercase tracking-wide text-muted-foreground";

function KindTag({ kind, provisional }: { kind: BrainKind; provisional?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 text-caption text-muted-foreground">
      {kind}
      {provisional ? " · provisional" : ""}
    </span>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

export function BrainView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const desk = useMediaQuery(DESK_QUERY, true);
  const [data, setData] = useState<Load<Awaited<ReturnType<typeof getBrainRecords>>>>({ state: "loading" });

  const reload = useCallback(() => {
    getBrainRecords().then(
      (value) => setData({ state: "ok", value }),
      (error) => {
        if (error instanceof AuthError) onAuthError(error);
        else setData({ state: "error", message: errorText(error) });
      },
    );
  }, [onAuthError]);
  useEffect(reload, [reload]);

  if (data.state === "loading") return <LoadingState rows={6} label="Loading the brain" />;
  if (data.state === "error") {
    return (
      <div className="mx-auto max-w-wide px-page py-4">
        <ProblemState title="The brain could not be read" message={data.message} />
      </div>
    );
  }
  const { records, scopes } = data.value;
  const projectScopes = scopes.filter((s) => s.scope.startsWith("project:"));

  return (
    <div className="h-full overflow-y-auto" data-view="brain">
      <div className={cn("mx-auto max-w-wide px-page py-4", desk ? "grid grid-cols-2 items-start gap-4" : "flex flex-col gap-4")}>
        <div className="flex min-w-0 flex-col gap-4">
          <RecallPanel projectScopes={projectScopes} onAuthError={onAuthError} />
          <RecordsPanel records={records} scopes={scopes} onChanged={reload} onAuthError={onAuthError} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ContextPanel projectScopes={projectScopes} version={records.length} onAuthError={onAuthError} />
          <RememberPanel projectScopes={projectScopes} onSaved={reload} onAuthError={onAuthError} />
        </div>
      </div>
    </div>
  );
}

function ScopeSelect({
  value,
  onChange,
  projectScopes,
  withGlobal,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  projectScopes: Array<{ scope: string; count: number }>;
  withGlobal?: boolean;
  label: string;
}) {
  return (
    <select aria-label={label} className={cn(FIELD, "min-w-0 flex-1")} value={value} onChange={(e) => onChange(e.target.value)}>
      {withGlobal ? <option value="global">global</option> : <option value="">no project (global only)</option>}
      {projectScopes.map((s) => (
        <option key={s.scope} value={s.scope}>
          {scopeLabel(s.scope)} ({s.count})
        </option>
      ))}
    </select>
  );
}

function RecallPanel({
  projectScopes,
  onAuthError,
}: {
  projectScopes: Array<{ scope: string; count: number }>;
  onAuthError: (error: AuthError) => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState("");
  const [result, setResult] = useState<Load<Awaited<ReturnType<typeof recallBrain>>> | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!q.trim()) return;
    setResult({ state: "loading" });
    recallBrain(q, scope ? { scope } : {}).then(
      (value) => setResult({ state: "ok", value }),
      (error) => {
        if (error instanceof AuthError) onAuthError(error);
        else setResult({ state: "error", message: errorText(error) });
      },
    );
  };

  return (
    <section className={PANEL} aria-labelledby="brain-recall">
      <h2 id="brain-recall" className="text-title font-semibold text-foreground">
        Recall
      </h2>
      <p className="mt-1 text-label text-muted-foreground">Full-text search (bm25), as an agent's `recall` runs it. A project boosts its own records 1.5×.</p>
      <form className="mt-3 flex flex-col gap-2" onSubmit={submit} role="search">
        <div className="flex gap-2">
          <Input aria-label="Question" placeholder="Ask what an agent would ask…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" disabled={!q.trim()}>
            <Search /> Search
          </Button>
        </div>
        <ScopeSelect label="Boost project" value={scope} onChange={setScope} projectScopes={projectScopes} />
      </form>
      <div className="mt-3" data-slot="recall-results">
        {result === null ? null : result.state === "loading" ? (
          <LoadingState rows={3} label="Searching" />
        ) : result.state === "error" ? (
          <p className="text-label text-destructive">{result.message}</p>
        ) : result.value.hits.length === 0 ? (
          <EmptyState compact title="No memory matches">Try other words: recall matches words, not meaning.</EmptyState>
        ) : (
          <>
            <p className={EYEBROW}>
              {result.value.hits.length} hits · {result.value.ms} ms
            </p>
            <ol className="mt-2 flex flex-col gap-2">
              {result.value.hits.map((hit, i) => (
                <li key={hit.record.id} className="rounded-md border border-border p-3" data-slot="recall-hit">
                  <div className="flex items-baseline gap-2">
                    <span className="w-6 shrink-0 text-label tabular-nums text-muted-foreground">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{hit.record.name ?? hit.record.id.slice(0, 8)}</span>
                    <span className="shrink-0 text-label tabular-nums text-muted-foreground" title="bm25 score, higher is better">
                      score {hit.score.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 pl-8">
                    <KindTag kind={hit.record.kind} provisional={hit.record.provisional} />
                    <span className="text-caption text-muted-foreground">{scopeLabel(hit.record.scope)}</span>
                  </div>
                  {hit.record.description ? <p className="mt-1 pl-8 text-label text-muted-foreground">{hit.record.description}</p> : null}
                  <details className="mt-1 pl-8">
                    <summary className="cursor-pointer text-label text-muted-foreground">Full text</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-label text-foreground">{hit.record.body}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function ContextPanel({
  projectScopes,
  version,
  onAuthError,
}: {
  projectScopes: Array<{ scope: string; count: number }>;
  version: number;
  onAuthError: (error: AuthError) => void;
}) {
  const [scope, setScope] = useState(projectScopes[0]?.scope ?? "");
  const [budget, setBudget] = useState("1500");
  const [block, setBlock] = useState<Load<BrainContextBlock>>({ state: "loading" });

  useEffect(() => {
    let live = true;
    setBlock({ state: "loading" });
    getBrainContext(scope ? { scope } : {}, Number(budget) || undefined).then(
      (value) => live && setBlock({ state: "ok", value }),
      (error) => {
        if (!live) return;
        if (error instanceof AuthError) onAuthError(error);
        else setBlock({ state: "error", message: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [scope, budget, version, onAuthError]);

  return (
    <section className={PANEL} aria-labelledby="brain-context">
      <h2 id="brain-context" className="text-title font-semibold text-foreground">
        Context preview
      </h2>
      <p className="mt-1 text-label text-muted-foreground">What the SessionStart hook injects into Claude Code and Codex for this project.</p>
      <div className="mt-3 flex gap-2">
        <ScopeSelect label="Project" value={scope} onChange={setScope} projectScopes={projectScopes} />
        <Input aria-label="Token budget" className="w-24 shrink-0" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>
      {block.state === "loading" ? (
        <LoadingState rows={4} label="Building the block" />
      ) : block.state === "error" ? (
        <p className="mt-3 text-label text-destructive">{block.message}</p>
      ) : (
        <>
          <p className={cn(EYEBROW, "mt-3")} data-slot="context-tokens">
            ≈{block.value.tokens.toLocaleString()} tokens (chars/4) of {block.value.budget.toLocaleString()} · {block.value.shown} of {block.value.eligible} shown ·{" "}
            {block.value.project} project · {block.value.global} global
          </p>
          <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-caption text-foreground">
            {block.value.text}
          </pre>
        </>
      )}
    </section>
  );
}

function RecordsPanel({
  records,
  scopes,
  onChanged,
  onAuthError,
}: {
  records: BrainRecord[];
  scopes: Array<{ scope: string; count: number }>;
  onChanged: () => void;
  onAuthError: (error: AuthError) => void;
}) {
  const [kind, setKind] = useState<"" | BrainKind>("");
  const [scope, setScope] = useState("");
  const [arming, setArming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      records
        .filter((r) => (kind ? r.kind === kind : true) && (scope ? r.scope === scope : true))
        .sort((a, b) => (b.verifiedAt ?? b.updatedAt).localeCompare(a.verifiedAt ?? a.updatedAt)),
    [records, kind, scope],
  );

  const forget = (id: string) => {
    setProblem(null);
    forgetBrain(id).then(
      () => {
        setArming(null);
        onChanged();
      },
      (error) => {
        if (error instanceof AuthError) onAuthError(error);
        else setProblem(errorText(error));
      },
    );
  };

  return (
    <section className={PANEL} aria-labelledby="brain-records">
      <h2 id="brain-records" className="text-title font-semibold text-foreground">
        Records <span className="text-body font-normal text-muted-foreground">({shown.length} of {records.length})</span>
      </h2>
      <div className="mt-3 flex gap-2">
        <select aria-label="Kind" className={cn(FIELD, "w-36 shrink-0")} value={kind} onChange={(e) => setKind(e.target.value as "" | BrainKind)}>
          <option value="">all kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select aria-label="Scope" className={cn(FIELD, "min-w-0 flex-1")} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">all scopes</option>
          {scopes.map((s) => (
            <option key={s.scope} value={s.scope}>
              {scopeLabel(s.scope)} ({s.count})
            </option>
          ))}
        </select>
      </div>
      {problem ? <p className="mt-2 text-label text-destructive">{problem}</p> : null}
      {shown.length === 0 ? (
        <EmptyState compact icon={Brain} title="No records here" className="mt-3" />
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border" data-slot="record-list">
          {shown.map((r) => (
            <li key={r.id} className="flex items-start gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <KindTag kind={r.kind} provisional={r.provisional} />
                  <span className={cn("min-w-0 truncate text-body font-medium text-foreground", r.supersededBy && "line-through")}>{r.name ?? r.id.slice(0, 8)}</span>
                  <span className="text-caption text-muted-foreground">{scopeLabel(r.scope)}</span>
                </div>
                {r.description ? <p className="mt-0.5 text-label text-muted-foreground">{r.description}</p> : null}
              </div>
              {arming === r.id ? (
                <div className="flex shrink-0 gap-1">
                  <Button size="xs" variant="destructive" onClick={() => forget(r.id)}>
                    Forget everywhere
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setArming(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button size="icon-xs" variant="ghost" aria-label={`Forget ${r.name ?? r.id}`} onClick={() => setArming(r.id)}>
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RememberPanel({
  projectScopes,
  onSaved,
  onAuthError,
}: {
  projectScopes: Array<{ scope: string; count: number }>;
  onSaved: () => void;
  onAuthError: (error: AuthError) => void;
}) {
  const [kind, setKind] = useState<BrainKind>("feedback");
  const [scope, setScope] = useState("global");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [why, setWhy] = useState("");
  const [provisional, setProvisional] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    rememberBrain({ kind, scope, name, description, body, why, provisional }).then(
      (record) => {
        setBusy(false);
        setStatus({ tone: "ok", text: `Remembered ${record.name ?? record.id.slice(0, 8)}.` });
        setName("");
        setDescription("");
        setBody("");
        setWhy("");
        onSaved();
      },
      (error) => {
        setBusy(false);
        if (error instanceof AuthError) onAuthError(error);
        else setStatus({ tone: "error", text: errorText(error) });
      },
    );
  };

  return (
    <section className={PANEL} aria-labelledby="brain-remember">
      <h2 id="brain-remember" className="text-title font-semibold text-foreground">
        Remember
      </h2>
      <form className="mt-3 flex flex-col gap-2" onSubmit={submit}>
        <div className="flex gap-2">
          <select aria-label="Kind" className={cn(FIELD, "w-36 shrink-0")} value={kind} onChange={(e) => setKind(e.target.value as BrainKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <ScopeSelect label="Scope" value={scope} onChange={setScope} projectScopes={projectScopes} withGlobal />
        </div>
        <Input aria-label="Name" placeholder="short-kebab-name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Description" placeholder="One line: what this is about" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Textarea aria-label="Body" placeholder="The fact, in full" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        <Input aria-label="Why" placeholder="Why it matters (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
        <label className="flex items-center gap-2 text-label text-muted-foreground">
          <input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} /> Provisional (unconfirmed)
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !body.trim()}>
            Remember
          </Button>
          {status ? (
            <p role="status" className={cn("text-label", status.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
              {status.text}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
