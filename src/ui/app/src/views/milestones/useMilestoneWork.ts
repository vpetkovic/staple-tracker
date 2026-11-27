/**
 * One milestone's reads and writes, lifted out of `WorkspaceMilestones` so every section of the
 * outline runs the same behaviour the page has always run for its one selected milestone:
 *
 * - the view (`/api/milestone`), and the milestone as the task detail reads it (`/api/issue`)
 *   with the detail's own action controller, for its status, its gate and their refusals;
 * - the ordered members under the Tasks list's done gate, with its fold;
 * - add, remove and reorder through `/api/milestone/{add,remove,reorder}`, each carrying
 *   `baseRevision: view.revision`. A stale base is `revision_conflict`, shown as a conflict
 *   with a Reload; any other error is the store's own sentence. A write's result IS the view,
 *   so the section is redrawn from it directly and the page fingerprint is bumped for the list.
 *
 * `ref` null reads nothing: a folded section that was never opened asks the server for nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { personActor } from "@/detail/parts/person";
import { useIssueActions, type IssueActionsController } from "@/detail/IssueActions";
import { addMilestoneMember, getIssue, getMilestone, isRevisionConflict, removeMilestoneMember, reorderMilestoneMembers, type AuthError } from "@/lib/api";
import { passesDone, withShowDone } from "@/lib/filters";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { IssueDetail, IssueRow, MilestoneView as MilestoneViewData } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { idsOf, pinnedRef } from "@/lib/write-ref";
import { projectedDue, type ProjectedDue } from "./milestone-plain";
import { useSetMilestoneTarget } from "./MilestoneDue";
import { hiddenMemberCount, memberListRows, movedOrder, type MemberListRow } from "./milestones-model";

/** What a section shows when a write went wrong, and how it went wrong. */
export interface MemberWriteFailure {
  kind: "conflict" | "refusal";
  refusal: Refusal;
}

export interface MilestoneWork {
  view: MilestoneViewData | null;
  /** The view's read failed. */
  error: Error | undefined;
  now: Date;
  members: readonly MemberListRow[];
  /** Rows the Done toggle hides, and how to show them (`HiddenDoneNotice`). */
  hiddenDone: number;
  onShowDone: () => void;
  /** A write is in flight: the section's controls are disabled. */
  busy: boolean;
  failure: MemberWriteFailure | null;
  onMove: (from: number, to: number) => void;
  onRemove: (identifier: string) => void;
  onAdd: (ref: string, note: string) => void;
  /** Read the view again, dropping the last write's answer and its failure. */
  onReload: () => void;
  onDismissFailure: () => void;
  /** Fold or unfold a member epic's children, as the chevron does in the Tasks list. */
  onToggle: (identifier: string) => void;
  onOpen: (workspace: string, identifier: string) => void;
  /** When the work still estimated in it would land; shown while no target is set. */
  projection: ProjectedDue | null;
  /** The due-date write, for the calendar. */
  due: { busy: boolean; error: string | null; onSetTarget: (targetDate: string | null) => Promise<boolean>; onOpen: () => void };
  /**
   * The milestone as the task detail reads it and the detail's own action controller: the status
   * control, the approval gate and its refusals are the detail's. Null until it loads.
   */
  decision: { detail: IssueDetail; controller: IssueActionsController } | null;
  /** A real reference from this workspace, for the add field's example. */
  exampleRef: string | null;
}

/**
 * `showAll`: a finished milestone is a record, so its work is listed whatever the Done toggle says.
 * `startFolded`: each member starts as one line (an epic shows its own count) until it is unfolded.
 * `milestoneId`: the milestone's id from its list row, for the due-date write while the view has not arrived.
 */
export function useMilestoneWork(
  workspace: string,
  ref: string | null,
  onAuthError: (error: AuthError) => void,
  { showAll = false, startFolded = false, milestoneId = "" }: { showAll?: boolean; startFolded?: boolean; milestoneId?: string } = {},
): MilestoneWork {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MemberWriteFailure | null>(null);
  /** The last write's answer, shown until the next read lands — a writer redraws from its result. */
  const [written, setWritten] = useState<MilestoneViewData | null>(null);

  // Always the workspace the page names — never the server's own first (workspace-scope.ts).
  const ws = workspace || undefined;

  const loadDetail = useCallback(() => (ref ? getMilestone({ ws, ref }) : Promise.resolve(null)), [ws, ref]);
  const detail = useResource(loadDetail, [ws, ref, session.version], onAuthError);

  // The milestone as the task detail reads it, for its status control and approval gate, and
  // the detail's own action controller — one write path, one set of hold-back rules.
  const loadIssue = useCallback(() => (ref ? getIssue({ ws, ref }) : Promise.resolve(null)), [ws, ref]);
  const issueRead = useResource(loadIssue, [ws, ref, session.version], onAuthError);
  const controller = useIssueActions(session.refresh, { workspaces: session.workspaces.map((w) => w.slug) });
  const milestoneIssue = issueRead.data && issueRead.data.issue.identifier === ref ? issueRead.data : null;
  useEffect(() => setWritten(null), [detail.data]);
  useEffect(() => {
    setFailure(null);
    setWritten(null);
  }, [ref]);

  // `useResource` keeps the previous answer while the next one loads; a milestone must
  // not be drawn under another milestone's identifier for even one frame.
  const loaded = detail.data && detail.data.milestone.identifier === ref ? detail.data : null;
  const view = written ?? loaded;
  const now = useMemo(() => new Date(), [view]);
  const projection = useMemo(() => (view ? projectedDue(view.remaining, now) : null), [view, now]);
  const dueWrite = useSetMilestoneTarget(ws, view?.milestone.id ?? milestoneId);
  // The Tasks list's own done gate and its fold, so "Done hidden" hides the same rows here.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback(
    (identifier: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(identifier)) next.add(identifier);
        return next;
      }),
    [],
  );
  // Each member starts as one line, once per milestone: later reads keep what the reader unfolded.
  const foldedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!startFolded || !view || foldedFor.current === view.milestone.id) return;
    foldedFor.current = view.milestone.id;
    setCollapsed(new Set(view.members.map((member) => member.identifier)));
  }, [startFolded, view]);
  const filters = session.filters;
  // This workspace's rows only: two workspaces may share a prefix in hub mode.
  const wsIssues = useMemo(
    () => (session.issues.data ?? []).filter((row) => !workspace || row.workspace === workspace),
    [session.issues.data, workspace],
  );
  const doneGate = useCallback((row: IssueRow) => showAll || passesDone(row, filters), [filters, showAll]);
  const members = useMemo(
    () => (view ? memberListRows(view, wsIssues, workspace, { visible: doneGate, collapsed }) : []),
    [view, wsIssues, workspace, doneGate, collapsed],
  );
  const hiddenDone = useMemo(() => (view ? hiddenMemberCount(view, wsIssues, workspace, doneGate) : 0), [view, wsIssues, workspace, doneGate]);

  const write = useCallback(
    async (run: () => Promise<MilestoneViewData>) => {
      setBusy(true);
      try {
        const next = await run();
        setWritten(next);
        setFailure(null);
        session.refresh();
      } catch (error) {
        setFailure({ kind: isRevisionConflict(error) ? "conflict" : "refusal", refusal: describeRefusal(error) });
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const onMove = useCallback(
    (from: number, to: number) => {
      if (!view) return;
      const order = movedOrder(view.members, from, to);
      if (!order) return;
      void write(() =>
        reorderMilestoneMembers({
          ws,
          // By id (`lib/write-ref.ts`): the milestone and the members the reader sees.
          milestone: view.milestone.id,
          order: idsOf(view.members.map((member) => ({ identifier: member.identifier, id: member.issueId })), order),
          baseRevision: view.revision,
          actor: personActor(),
        }),
      );
    },
    [view, ws, write],
  );

  const onRemove = useCallback(
    (identifier: string) => {
      if (!view) return;
      void write(() =>
        removeMilestoneMember({
          ws,
          milestone: view.milestone.id,
          ref: idsOf(view.members.map((member) => ({ identifier: member.identifier, id: member.issueId })), [identifier])[0]!,
          baseRevision: view.revision,
          actor: personActor(),
        }),
      );
    },
    [view, ws, write],
  );

  const onAdd = useCallback(
    (added: string, note: string) => {
      if (!view) return;
      void write(() =>
        addMilestoneMember({
          ws,
          milestone: view.milestone.id,
          ref: pinnedRef(session.issues.data ?? [], workspace, added),
          baseRevision: view.revision,
          actor: personActor(),
          ...(note ? { note } : {}),
        }),
      );
    },
    [view, ws, write, session.issues.data, workspace],
  );

  const onReload = useCallback(() => {
    setFailure(null);
    setWritten(null);
    detail.reload();
  }, [detail]);

  const onOpen = useCallback(
    (rowWorkspace: string, identifier: string) => session.open(rowWorkspace || workspace, identifier),
    [session, workspace],
  );
  const onShowDone = useCallback(() => session.setFilters(withShowDone(session.filters, true)), [session]);

  return {
    view,
    error: detail.error,
    now,
    members,
    hiddenDone,
    onShowDone,
    busy,
    failure,
    onMove,
    onRemove,
    onAdd,
    onReload,
    onDismissFailure: () => setFailure(null),
    onToggle,
    onOpen,
    projection,
    due: { busy: dueWrite.busy, error: dueWrite.error, onSetTarget: dueWrite.set, onOpen: dueWrite.clear },
    decision: milestoneIssue ? { detail: milestoneIssue, controller } : null,
    exampleRef: (session.issues.data ?? []).find((r) => r.workspace === workspace && r.issue.kind !== "milestone")?.issue.identifier ?? null,
  };
}
