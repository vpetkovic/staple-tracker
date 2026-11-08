/**
 * "What the agent sees" for an idea: the MCP `get_idea` payload, verbatim.
 *
 * `/api/plan-idea` answers the same `PlanStore.detail` the get_idea handler returns, so the pane
 * shows exactly what an agent asking for this idea receives: its state and the actions that state
 * offers, the brief, questions, decisions, sub-ideas and linked work. Nothing is assembled here.
 */
import { useCallback, useMemo } from "react";
import { getPlanIdea } from "@/lib/api";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { estimateTokens, thousands, wireJson } from "../agentPayload";
import { planRecordOf } from "../plan-record";
import type { TabProps } from "./registry";

export function IdeaAgentViewTab({ detail, workspace, onAuthError }: TabProps) {
  const record = planRecordOf(detail);
  const ref = record?.idea.id ?? detail.issue.id;
  const version = `${detail.issue.updatedAt}:${record?.idea.updatedAt ?? ""}`;
  const payload = useResource(useCallback(() => getPlanIdea({ ws: workspace, ref }), [workspace, ref]), [workspace, ref, version], onAuthError);
  const stats = useMemo(() => {
    if (!payload.data) return null;
    const wire = wireJson(payload.data);
    return { pretty: JSON.stringify(payload.data, null, 2), tokens: estimateTokens(wire), chars: wire.length };
  }, [payload.data]);
  if (payload.error) return <ErrorState error={payload.error} />;
  if (!stats) return <LoadingState rows={3} />;
  return (
    <div className="space-y-3" data-idea-agent-view={ref}>
      <p className="m-0 text-body text-text-secondary">
        What an agent receives from <span className="font-mono">get_idea</span>: about {thousands(stats.tokens)} tokens ({thousands(stats.chars)} characters). Its{" "}
        <span className="font-mono">actions</span> are what this idea's state lets it do.
      </p>
      <pre className="m-0 max-h-[60vh] overflow-auto rounded-md border bg-surface-raised p-3 text-caption leading-relaxed" data-idea-agent-payload>
        {stats.pretty}
      </pre>
    </div>
  );
}
