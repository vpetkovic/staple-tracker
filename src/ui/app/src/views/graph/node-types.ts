/**
 * The node registry — G3 (STA-56).
 *
 * Its own file because the canvas now draws two kinds of box and neither one should have
 * to import the other to be registered. Before G3 this map lived at the bottom of
 * TaskNode.tsx, which was right while `task` was the only entry and wrong the moment
 * `cluster` joined it: TaskNode would have had to import ClusterNode purely so that
 * GraphView could get one object.
 *
 * Module-level and defined once, which React Flow requires rather than prefers — a
 * `nodeTypes` object rebuilt during render makes it remount every node on every render,
 * and on this canvas that is every 1.5 seconds.
 */
import { ClusterNode, type ClusterFlowNode } from "./ClusterNode";
import { TaskNode, type TaskFlowNode } from "./TaskNode";

/** Every box the canvas can draw. React Flow needs the union to type its handlers. */
export type GraphFlowNode = TaskFlowNode | ClusterFlowNode;

export const nodeTypes = { task: TaskNode, cluster: ClusterNode };
