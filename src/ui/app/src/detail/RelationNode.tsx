/**
 * The Relations tab's box — O2b (STA-132).
 *
 * It is `TaskNode`, plus two handles. That is the entire file, and it is a file rather
 * than three lines inside the tab for one reason: React Flow requires `nodeTypes` to be a
 * module-level constant (a fresh object per render remounts every node on every render),
 * so the component and the map it goes into have to live somewhere stable.
 *
 * ── Why a wrapper and not `TaskNode` directly ────────────────────────────────────────
 *
 * `TaskNode` mounts exactly two handles — Left target, Right source — and says why in a
 * comment: the graph view is `rankdir: LR`, so a target on the top of the box would make
 * every arrow loop around the card it points at. That reasoning is right there and wrong
 * here. This canvas draws parent/child edges VERTICALLY, and an arrow forced out of the
 * right side of a parent and back into the left side of the child sitting directly
 * beneath it hooks around the card and covers the title it is pointing at — the same
 * failure, rotated ninety degrees.
 *
 * The fix is two more handles, not an edit to `TaskNode`. Everything that makes the box a
 * box — the accent stripe, the status dot, the `showWorkspace` prefix, the stale-claim
 * badge, the fixed size dagre and this tab both lay out against — stays that file's code,
 * used verbatim. Nothing here re-implements a pixel of it.
 *
 * ── How the two pairs stay out of each other's way ───────────────────────────────────
 *
 * The added handles carry ids (`top`, `bottom`); TaskNode's do not. Parent edges name the
 * ids and so are looked up by id. Blocks edges name nothing, and `@xyflow/system`'s
 * `getHandle` returns `bounds[0]` — the first handle in DOM ORDER — when no id is given.
 * `<TaskNode>` renders first, so `bounds[0]` is its Left/Right pair and blocks edges keep
 * running horizontally exactly as they do on the big canvas. That is why the extra
 * handles are rendered AFTER the card and not before it.
 */
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { TaskNode, type TaskNodeData } from "../views/graph/TaskNode";

export type RelationFlowNode = Node<TaskNodeData, "relation">;

export const RelationNode = memo(function RelationNode(props: NodeProps<RelationFlowNode>) {
  return (
    <>
      {/*
        Cast: `TaskNode` is typed for its own node type and this one differs only in the
        `type` discriminator, which the component never reads — it destructures `data` and
        nothing else. Re-typing TaskNode to accept both would be an edit to a read-only
        file to satisfy a discriminator neither component uses.
      */}
      <TaskNode {...(props as unknown as NodeProps<Node<TaskNodeData, "task">>)} />
      {/*
        Vertical anchors for the generation spine. `opacity-0` and not connectable, for
        the same reason TaskNode's are: dependencies and parents are store writes, never
        a drag gesture, and doubly so on a canvas that is read-only by design.
      */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!opacity-0"
      />
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!opacity-0"
      />
    </>
  );
});

/** Module-level and defined once, which React Flow requires rather than prefers. */
export const relationNodeTypes = { relation: RelationNode };
