/**
 * One ticket on the canvas — G2 (STA-55).
 *
 * This is the SVG `<g>` the old view drew, re-expressed as HTML so it can carry the same
 * vocabulary every other surface uses: `data-status` drives the accent stripe through
 * `--sc` (app.css), `.staple-accent-edge` is the same border-left the board cards wear,
 * and the stale-claim badge is the SAME component the inbox and the detail header render
 * rather than a graph-flavoured copy of it. Nothing here invents a colour.
 *
 * WHY IT IS NOT `IssueCard`. That card takes an `Issue` — priority, assignee,
 * checkoutAgent, a dozen fields the graph endpoint does not return — and it is a
 * `<button>`, which cannot be the drag handle of a React Flow node without fighting it
 * for the pointer. The overlap is the accent stripe and the badge, and both are shared
 * as the things they are rather than by forcing one component to be two.
 *
 * FIXED SIZE, AND IT MATTERS. dagre packs ranks using the box sizes it was given
 * (NODE_W/NODE_H in graph-layout.ts), so a card allowed to grow to its content would
 * overlap its neighbours no matter how good the arrangement is. Hence the truncation.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { StaleClaimBadge } from "@/components/StaleClaimBadge";
import { isStaleClaim } from "@/lib/claim";
import type { GraphNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NODE_H, NODE_W } from "./graph-layout";

export interface TaskNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** Hub mode prefixes the identifier with its workspace, as every other view does. */
  showWorkspace: boolean;
  /** Outside the focused node's lineage — fade back. */
  dim: boolean;
  /** The node the lineage is being traced FROM. */
  focused: boolean;
}

export type TaskFlowNode = Node<TaskNodeData, "task">;

/**
 * `memo` is load-bearing rather than decorative.
 *
 * The nodes array is rebuilt on every hover (to restamp `dim`) and on every 1.5s poll.
 * Without memo that is a full re-render of every card per mouse move; with it, and with
 * GraphView preserving object identity for nodes whose data did not change, only the
 * cards that actually changed state re-render.
 */
export const TaskNode = memo(function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { node, showWorkspace, dim, focused } = data;
  const stale = isStaleClaim(node.claim);

  return (
    <div
      data-status={node.status}
      data-issue={node.id}
      data-dim={dim ? "" : undefined}
      style={{ width: NODE_W, height: NODE_H }}
      className={cn(
        "staple-accent-edge staple-rf-node overflow-hidden rounded-md border bg-card px-2.5 py-1.5 text-left",
        focused && "border-ring ring-1 ring-ring",
      )}
    >
      {/*
        Handles are what React Flow attaches edges to. Left/Right rather than Top/Bottom
        because the arrangement is rankdir: LR — a target on the top of the box would
        make every arrow loop around the card it is pointing at.
        `opacity-0`: they are anchor points, not affordances. Nothing here is connectable
        by hand; dependencies are a store write, not a drag gesture (and making them one
        is not this ticket).
      */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />

      <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        {/*
          The status dot — G4 (STA-57).
          The 3px accent stripe is legible on a card you are reading and marginal on a
          canvas zoomed out to fit fifty of them, which is exactly the moment status
          matters most. A filled dot survives that zoom. It invents NO colour: `--sc` is
          already in scope from `data-status` on the wrapper, so this is the same value
          the stripe uses and there is still only one place a status colour is decided.
        */}
        <span
          className="size-1.5 shrink-0 rounded-full bg-[var(--sc,var(--border))]"
          aria-hidden
        />
        <span className="truncate">
          {showWorkspace ? `${node.workspace} · ` : ""}
          {node.id}
        </span>
      </div>
      {/* Two lines, hard-clamped. See the fixed-size note at the top of the file. */}
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug font-medium wrap-anywhere text-card-foreground">
        {node.title}
      </div>
      {/*
        Renders only when the payload carried a claim AND that claim is past the silence
        threshold — see the `claim` note on GraphNode. Today /api/graph sends no claim, so
        this is dormant; the ticket asked for the state to be handled, not faked.
      */}
      {stale && node.claim ? <StaleClaimBadge claim={node.claim} className="mt-0.5" /> : null}
    </div>
  );
});

/** The map React Flow wants. Defined once, module-level, so it is referentially stable. */
export const nodeTypes = { task: TaskNode };
