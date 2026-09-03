/**
 * An EXPANDED epic, as a box its work is drawn inside — O4c (STA-135).
 *
 * ── The other half of ClusterNode ────────────────────────────────────────────────────
 *
 * `ClusterNode` is this epic collapsed: one ticket-shaped card standing in for several.
 * This is the same epic open, and the two are deliberately built out of the same parts —
 * the same aggregate `data-status` driving the same `--sc` accent, the same status dot,
 * the same `resolved/total` badge, the same chevron in the same corner pointing the other
 * way. They even share an id (`clusterId`), so collapsing swaps one for the other in
 * place. A reader who collapses an epic should see the box shrink to a card, not see one
 * diagram replaced by a different one.
 *
 * What is NOT shared is the silhouette: a card is a thing, and a box is a place. Hence no
 * `staple-rf-node` card shadow here, a dashed-quiet border, and a translucent fill that
 * lets the canvas grid read through — the box has to be legible as background behind the
 * cards it holds, because that is literally where they sit.
 *
 * ── The children are NOT inside this DOM ─────────────────────────────────────────────
 *
 * React Flow renders sub-flow children as SIBLINGS of the parent in the viewport, offset
 * by the parent's position, not as descendants of this element. Three consequences worth
 * stating because each one looks like a bug from the outside:
 *
 *   1. Nothing here can be laid out around the members. The header's height is a
 *      CONSTANT that `graph-layout.ts` insets the contents by (`CONTAINER_HEADER_H`), and
 *      a header that grew past it would sit on top of the first row of cards. Hence the
 *      fixed height and the truncation.
 *   2. Dimming this box does not dim its contents; they are separate nodes with their own
 *      opacity. `dimContainers` is what stops a ghost outline being drawn around bright
 *      cards — a box is only dim when everything in it is.
 *   3. The BODY of the box is `pointer-events: none`, and this is the one real design
 *      decision in the file. An expanded epic can cover most of the canvas, and a body
 *      that took the pointer would mean no panning, no marquee, and a click on empty
 *      space inside a box opening a detail panel for the epic. So the HEADER is the drag
 *      handle and the click target — the title-bar idiom, which is what a box that can be
 *      moved as a unit looks like everywhere else — and the interior belongs to the
 *      cards drawn over it and to the canvas underneath.
 */
import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ChevronDown, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IssueKind } from "@/lib/types";
import type { EpicSummary } from "./graph-clusters";
import { CONTAINER_HEADER_H, CONTAINER_PAD } from "./graph-layout";

export interface EpicContainerNodeData extends Record<string, unknown> {
  epic: EpicSummary;
  /** Hub mode prefixes the identifier with its workspace, as every other view does. */
  showWorkspace: boolean;
  /** Outside the emphasis — and, for a box, only when nothing inside it is lit. */
  dim: boolean;
  /** The node the emphasis is being traced FROM. */
  focused: boolean;
  /** The measured box, from `compoundLayout`. Declared, never inferred — see GraphView. */
  width: number;
  height: number;
  /** Collapse this epic back to a super-node. The mirror of ClusterNode's `onExpand`. */
  onCollapse: (epic: string) => void;
}

export type EpicContainerFlowNode = Node<EpicContainerNodeData, "container">;

/**
 * The kind mark, still a placeholder, still in exactly one component per surface.
 *
 * Same reasoning as O4b's `EpicKindMark` in EpicPicker.tsx: `components/task-list` exports
 * no shared `KindGlyph` yet (that is O1b), and inventing a second vocabulary of kind icons
 * in the graph is how an app ends up with two. One monochrome mark, the real kind on the
 * element as `data-epic-kind`, and when the shared glyph lands this becomes
 * `<KindGlyph kind={kind} />` in both places and nothing else moves.
 *
 * `kind: undefined` means an older server omitted the field, never "no kind".
 */
function EpicKindMark({ kind }: { kind?: IssueKind }) {
  return (
    <Layers
      className="size-3 shrink-0 text-muted-foreground"
      aria-hidden
      data-epic-kind={kind ?? "epic"}
    />
  );
}

export const EpicContainerNode = memo(function EpicContainerNode({
  data,
}: NodeProps<EpicContainerFlowNode>) {
  const { epic, showWorkspace, dim, focused, width, height, onCollapse } = data;
  const complete = epic.total > 0 && epic.resolved === epic.total;

  return (
    <div
      data-status={epic.status}
      data-issue={epic.id}
      data-container={epic.id}
      data-dim={dim ? "" : undefined}
      style={{ width, height }}
      className={cn(
        "staple-epic-container staple-accent-edge relative rounded-lg border",
        focused && "border-ring ring-1 ring-ring",
      )}
    >
      {/*
        Handles sit on the box edge, which is the whole point of the boundary rule in
        `boundaryEdges`: when the far side is collapsed, one arrow lands HERE rather than
        nine landing on nine cards inside. Left/Right because the arrangement is LR.
      */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />

      {/*
        The header: drag handle, click target, and the only part of the box that takes
        the pointer. See the file header for why the interior does not.
      */}
      <div
        className="staple-epic-container-bar flex items-center gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
        style={{ height: CONTAINER_HEADER_H - CONTAINER_PAD / 2 }}
      >
        {/* Same status dot as TaskNode and ClusterNode — here the AGGREGATE status. */}
        <span className="size-1.5 shrink-0 rounded-full bg-[var(--sc,var(--border))]" aria-hidden />
        <EpicKindMark kind={epic.kind} />
        <span className="shrink-0">
          {showWorkspace ? `${epic.workspace} · ` : ""}
          {epic.id}
        </span>
        <span className="truncate font-sans text-[11px] font-medium text-card-foreground">
          {epic.title}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-sm px-1 font-sans text-[10px] tabular-nums",
            complete ? "text-muted-foreground" : "text-card-foreground",
          )}
          title={`${epic.resolved} of ${epic.total} tickets on this canvas are done`}
        >
          {epic.resolved}/{epic.total} done
        </span>
        <button
          type="button"
          // nodrag: a press on the chevron must not become a drag of the whole box.
          // stopPropagation: it must not ALSO reach onNodeClick and open the panel behind.
          className="nodrag shrink-0 rounded-sm p-0.5 leading-none hover:bg-muted"
          aria-label={`collapse ${epic.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onCollapse(epic.id);
          }}
        >
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
});
