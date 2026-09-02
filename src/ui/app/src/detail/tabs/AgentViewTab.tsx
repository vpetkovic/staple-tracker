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
import { Button } from "@/components/ui/button";
import { getAgentContext } from "@/lib/api";
import type { AgentContext } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { breakdown, CHARS_PER_TOKEN, estimateTokens, thousands, wireJson } from "../agentPayload";
import type { TabProps } from "./registry";

function Stat({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">{label}</div>
      <div className={cn("font-mono tabular-nums", strong ? "text-2xl leading-tight" : "text-sm")}>{value}</div>
      {hint ? <div className="text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

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

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        The exact payload the MCP <code className="rounded bg-muted px-1 font-mono text-[0.85em]">get_task</code>{" "}
        tool returns for this issue — not a rendering of it.
      </p>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-md border bg-muted/40 px-4 py-3">
        <Stat
          strong
          label="context size"
          value={`≈ ${thousands(stats.tokens)} tokens`}
          hint={`estimate · ${thousands(stats.chars)} chars ÷ ${CHARS_PER_TOKEN}`}
        />
        {documentCost !== undefined ? (
          <Stat
            label="document bodies"
            value={`${documentCost > 0 ? "+" : ""}${thousands(documentCost)}`}
            hint={
              documentCost === 0
                ? "no document bodies to inline"
                : `${thousands(leanTokens!)} without · ${thousands(fullTokens!)} with`
            }
          />
        ) : null}
        <Stat label="comments" value={thousands(stats.payload.comments.length)} />
        <Stat
          label="relations"
          value={thousands(stats.payload.blockedBy.length + stats.payload.blocks.length)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={withDocuments ? "secondary" : "outline"}
          className="h-7"
          onClick={() => setWithDocuments((on) => !on)}
        >
          include_documents: {withDocuments ? "true" : "false"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {withDocuments ? "document bodies inlined" : "get_task's default — metadata only"}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={copy}>
          {copied ? "copied" : "copy JSON"}
        </Button>
      </div>

      {/* Where the tokens actually go. "This context is big" is a fact; "your comment
          thread is 60% of it" is something you can act on. */}
      <div className="space-y-1">
        {stats.slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2 text-[11px]">
            <span className="w-28 shrink-0 truncate font-mono">
              {slice.key}
              {slice.count !== null ? <span className="text-muted-foreground"> ({slice.count})</span> : null}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-foreground/40"
                style={{ width: `${Math.max(slice.share * 100, slice.chars > 2 ? 1 : 0)}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
              ≈{thousands(slice.tokens)} · {Math.round(slice.share * 100)}%
            </span>
          </div>
        ))}
      </div>

      <pre className="max-h-[26rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {stats.pretty}
      </pre>
    </div>
  );
}
