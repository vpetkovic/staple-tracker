/**
 * "What the agent sees" — the exact MCP `get_task` payload for this issue, and what it
 * costs.
 *
 * The gap it closes: a human hands an issue to an agent believing the ticket says
 * something, the agent receives a payload that says something slightly different, and
 * nothing anywhere shows the two side by side. This pane is the agent's side.
 *
 * The payload comes from GET /api/agent-context, which is the get_task handler's
 * expression verbatim — see the comment on that route in src/ui/server.ts and the
 * cross-surface equality test in test/ui-agent-context.test.ts. Nothing is assembled
 * here; assembling it here is exactly how the old version of this tab drifted.
 *
 * Both values of `include_documents` are fetched, because the delta between them is the
 * fact worth knowing: document bodies are usually most of the payload, and an agent that
 * asks for them is working with a very different context window than one that does not.
 */
import { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgentContext } from "@/lib/api";
import type { AgentContext } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { breakdown, CHARS_PER_TOKEN, estimateTokens, thousands, wireJson } from "../agentPayload";
import type { TabProps } from "./registry";
import "./tabs.css";
import { cn } from "../parts";

const plural = (n: number, one: string, many: string) => `${thousands(n)} ${n === 1 ? one : many}`;

export function AgentViewTab({ detail, workspace, onAuthError }: TabProps) {
  const ref = detail.issue.identifier;
  const [withDocuments, setWithDocuments] = useState(false);
  const [copied, setCopied] = useState(false);

  const version = `${detail.issue.updatedAt}:${detail.comments.length}:${detail.documents
    .map((doc) => doc.currentRevision)
    .join(".")}`;

  // Two real calls, one per value of include_documents, rather than deriving one from
  // the other client-side. The derivation would be right today and wrong the first time
  // store.context() does anything else with the flag.
  const lean = useResource<AgentContext>(
    useCallback(() => getAgentContext({ ws: workspace, ref }), [workspace, ref]),
    [workspace, ref, version],
    onAuthError,
  );
  const full = useResource<AgentContext>(
    useCallback(() => getAgentContext({ ws: workspace, ref, documents: true }), [workspace, ref]),
    [workspace, ref, version],
    onAuthError,
  );

  const shown: AgentContext | undefined = withDocuments ? full.data : lean.data;

  const stats = useMemo(() => {
    if (!shown) return undefined;
    const wire = wireJson(shown);
    return {
      payload: shown,
      wire,
      pretty: JSON.stringify(shown, null, 2),
      chars: wire.length,
      tokens: estimateTokens(wire),
      slices: breakdown(shown as unknown as Record<string, unknown>),
    };
  }, [shown]);

  const leanTokens = lean.data ? estimateTokens(wireJson(lean.data)) : undefined;
  const fullTokens = full.data ? estimateTokens(wireJson(full.data)) : undefined;
  const documentCost =
    leanTokens !== undefined && fullTokens !== undefined ? fullTokens - leanTokens : undefined;

  const copy = () => {
    if (!stats) return;
    void navigator.clipboard?.writeText(stats.wire).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const error = withDocuments ? full.error : lean.error;
  if (error) return <ErrorState error={error} />;
  if (!stats) return <LoadingState rows={3} />;

  const relations = stats.payload.blockedBy.length + stats.payload.blocks.length;

  return (
    <div className="mx-auto w-full max-w-readable space-y-4">
      <div className="space-y-1">
        <p className="text-reading text-foreground">This is exactly what an AI agent sees when it opens this task.</p>
        <p className="text-body text-text-secondary">
          It is the same data the agent tools return, word for word, so you can check the task says what you think it
          says before you hand it over.
        </p>
      </div>

      {/* The size, in a sentence. The estimate is labelled as one wherever it is shown:
          chars ÷ 4 is close for prose and not exact for anything. */}
      <p className="text-body text-text-secondary" title={`Estimate: ${thousands(stats.chars)} characters ÷ ${CHARS_PER_TOKEN}`}>
        About <span className="font-medium text-foreground">{plural(stats.tokens, "token", "tokens")}</span> of context
        {" · "}
        {plural(stats.payload.comments.length, "comment", "comments")}
        {" · "}
        {relations === 0 ? "no connections" : plural(relations, "connection", "connections")}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          role="switch"
          aria-checked={withDocuments}
          onClick={() => setWithDocuments((on) => !on)}
          className="focus-ring inline-flex min-h-10 items-center gap-2.5 rounded-lg text-body text-foreground"
        >
          <span
            aria-hidden
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150",
              withDocuments ? "bg-foreground" : "bg-text-tertiary/45",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform duration-150 motion-reduce:transition-none",
                withDocuments ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </span>
          Include document bodies
        </button>
        {documentCost !== undefined ? (
          <span className="text-label text-text-secondary">
            {documentCost === 0
              ? "This task has no document text to add."
              : `Adds about ${plural(documentCost, "token", "tokens")}. Agents get these only when they ask.`}
          </span>
        ) : null}
      </div>

      <section aria-label="Agent payload" className="overflow-hidden rounded-xl border border-border bg-surface-sunken">
        <header className="flex items-center gap-2 border-b border-border bg-surface-raised px-3.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-label text-text-secondary">
            {withDocuments ? "Task with document bodies" : "Task as agents receive it"}
          </span>
          <Button size="sm" variant="ghost" className="shrink-0 max-sm:h-10" onClick={copy} aria-live="polite">
            {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </header>
        <pre className="tab-code max-h-[28rem] overflow-auto p-3.5 font-mono text-[12px] leading-relaxed text-foreground max-sm:whitespace-pre-wrap max-sm:[overflow-wrap:anywhere]">
          {stats.pretty}
        </pre>
      </section>

      {/* Where the tokens actually go. "This context is big" is a fact; "your comment
          thread is 60% of it" is something you can act on. Secondary, so it folds away. */}
      <details className="group rounded-xl border border-border bg-surface-raised">
        <summary className="focus-ring-inset flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3.5 text-body text-foreground select-none [&::-webkit-details-marker]:hidden">
          <span className="flex-1">Where the size goes</span>
          <ChevronDown
            aria-hidden
            className="size-4 text-text-tertiary transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="space-y-2 border-t border-border px-3.5 py-3">
          {stats.slices.map((slice) => (
            <div key={slice.key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-label">
              <span className="truncate text-foreground">
                {slice.key}
                {slice.count !== null ? <span className="text-text-tertiary"> ({slice.count})</span> : null}
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className="block h-full rounded-full bg-foreground/40"
                  style={{ width: `${Math.max(slice.share * 100, slice.chars > 2 ? 1 : 0)}%` }}
                />
              </span>
              <span className="text-right text-text-secondary tabular-nums">{Math.round(slice.share * 100)}%</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
