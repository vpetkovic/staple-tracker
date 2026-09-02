/**
 * The subtask tree. Flat rows with ASCII guides rather than nested boxes — it matches
 * what `staple tree` prints in the terminal, which is the point: the same shape in
 * both surfaces means an agent and a human describing a tree describe the same thing.
 */
import { useCallback } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { getIssues } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Issue, IssueRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useResource } from "@/lib/useStaple";
import { EmptyState, SectionHeading, ViewState } from "./ViewChrome";

interface TreeRow {
  issue: Issue;
  depth: number;
}

/**
 * Depth-first walk over parentId. Issues whose parent is missing from the set — a
 * resolved-away parent, or a parent filtered out by the assignee filter — are appended
 * at depth 0 rather than dropped, because silently hiding work is the one thing a
 * tracker must never do.
 */
function flatten(issues: Issue[]): TreeRow[] {
  const byParent = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.parentId ?? "";
    const bucket = byParent.get(key);
    if (bucket) bucket.push(issue);
    else byParent.set(key, [issue]);
  }
  const present = new Set(issues.map((i) => i.id));
  const out: TreeRow[] = [];
  const walk = (parentKey: string, depth: number): void => {
    for (const issue of byParent.get(parentKey) ?? []) {
      out.push({ issue, depth });
      walk(issue.id, depth + 1);
    }
  };
  walk("", 0);
  for (const issue of issues) {
    if (issue.parentId && !present.has(issue.parentId)) {
      // Orphaned subtree root (its parent is filtered out) — and its DESCENDANTS,
      // which neither the root walk nor this fallback would otherwise ever reach.
      out.push({ issue, depth: 0 });
      walk(issue.id, 1);
    }
  }
  return out;
}

function groupByWorkspace(rows: IssueRow[]): Map<string, Issue[]> {
  const byWs = new Map<string, Issue[]>();
  for (const row of rows) {
    const bucket = byWs.get(row.workspace);
    if (bucket) bucket.push(row.issue);
    else byWs.set(row.workspace, [row.issue]);
  }
  return byWs;
}

export function TreeView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { ws, assignee, mode, version, selection } = session;

  const load = useCallback(() => getIssues({ ws, assignee }), [ws, assignee]);
  const resource = useResource(load, [ws, assignee, version], onAuthError);

  return (
    <div className="mx-auto max-w-5xl">
      <ViewState resource={resource} empty="no open issues">
        {(rows) => {
          if (rows.length === 0) return <EmptyState>no open issues</EmptyState>;
          return [...groupByWorkspace(rows)].map(([workspace, issues]) => (
            <section key={workspace}>
              {mode === "hub" ? <SectionHeading className="font-mono">{workspace}</SectionHeading> : null}
              <div className="space-y-1">
                {flatten(issues).map(({ issue, depth }) => (
                  <button
                    key={issue.id}
                    type="button"
                    data-status={issue.status}
                    onClick={() => session.open(workspace, issue.identifier)}
                    className={cn(
                      "staple-accent-edge flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left",
                      "transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                      selection?.ref === issue.identifier && "border-ring ring-1 ring-ring",
                    )}
                  >
                    {depth > 0 ? (
                      <span aria-hidden className="font-mono text-xs whitespace-pre text-border">
                        {"│  ".repeat(depth - 1)}
                        {"├─"}
                      </span>
                    ) : null}
                    <StatusBadge status={issue.status} />
                    <span className="font-mono text-[11px] text-muted-foreground">{issue.identifier}</span>
                    <span className="truncate text-[13px]">{issue.title}</span>
                    {issue.assignee ? (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">@{issue.assignee}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          ));
        }}
      </ViewState>
    </div>
  );
}
