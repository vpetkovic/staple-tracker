/**
 * A collapsed epic, as one box — G3 (STA-56).
 *
 * Deliberately the SAME box as TaskNode: same size, same `.staple-accent-edge` stripe
 * driven by the same `data-status`, same truncation. A super-node is not a different
 * kind of thing on this canvas, it is a ticket-shaped stand-in for several, and giving
 * it its own silhouette would make the collapsed view read as a different diagram rather
 * than the same diagram zoomed out. Fixed size is not cosmetic either — dagre packs
 * ranks using NODE_W/NODE_H, so a taller card would overlap its neighbours.
 *
 * The tint is the epic's AGGREGATE status (graph-clusters.ts), which is why this file
 * invents no colour of its own — it hands `data-status` the same vocabulary every other
 * surface uses and app.css does the rest.
 *
 * ── The two clicks ───────────────────────────────────────────────────────────────────
 *
 * The body opens the epic in the detail panel, because an epic is a real ticket and "let
 * me read this thing" is the same gesture it is everywhere else in the app. The chevron
 * expands the cluster. They have to be different targets: making the body expand would
 * leave no way to open the epic, and making expansion the only affordance would break
 * the one rule this canvas has kept since G2 — clicking a node opens it.
 *
 * `nodrag` and `stopPropagation` are both required, and for different reasons. `nodrag`
 * stops React Flow from treating a press on the button as the start of a node drag;
 * `stopPropagation` stops the click from ALSO reaching the pane's onNodeClick and
 * opening the panel behind the expand.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { EpicSummary } from "./graph-clusters";
import { NODE_H, NODE_W } from "./graph-layout";

export interface ClusterNodeData extends Record<string, unknown> {
  epic: EpicSummary;
  showWorkspace: boolean;
  dim: boolean;
  focused: boolean;
  /** Expand this cluster. Wired by GraphView; the node does not own the collapse set. */
  onExpand: (epic: string) => void;
}

export type ClusterFlowNode = Node<ClusterNodeData, "cluster">;

export const ClusterNode = memo(function ClusterNode({ data }: NodeProps<ClusterFlowNode>) {
  const { epic, showWorkspace, dim, focused, onExpand } = data;
  const complete = epic.total > 0 && epic.resolved === epic.total;

  return (
    <div
      data-status={epic.status}
      data-issue={epic.id}
      data-cluster={epic.id}
      data-dim={dim ? "" : undefined}
      style={{ width: NODE_W, height: NODE_H }}
      className={cn(
        "staple-accent-edge staple-rf-node overflow-hidden rounded-md border bg-card px-2.5 py-1.5 text-left",
        // A doubled border is the whole visual argument that this box is several boxes.
        "shadow-[3px_3px_0_-1px_var(--card),3px_3px_0_0_var(--border)]",
        focused && "border-ring ring-1 ring-ring",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />

      <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        {/* Same status dot as TaskNode (G4) — here it carries the AGGREGATE status. */}
        <span
          className="size-1.5 shrink-0 rounded-full bg-[var(--sc,var(--border))]"
          aria-hidden
        />
        <span className="truncate">
          {showWorkspace ? `${epic.workspace} · ` : ""}
          {epic.id}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-sm px-1 font-sans text-[10px] tabular-nums",
            complete ? "text-muted-foreground" : "text-card-foreground",
          )}
          // The count is the reason to collapse; say what it counts out loud for anyone
          // who cannot see the badge.
          title={`${epic.resolved} of ${epic.total} tickets on this canvas are done`}
        >
          {epic.resolved}/{epic.total} done
        </span>
        <button
          type="button"
          // nodrag: a press here must not become a node drag. See the file header.
          className="nodrag shrink-0 rounded-sm px-1 leading-none hover:bg-muted"
          aria-label={`expand ${epic.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onExpand(epic.id);
          }}
        >
          ⊕
        </button>
      </div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug font-medium wrap-anywhere text-card-foreground">
        {epic.title}
      </div>
    </div>
  );
});
