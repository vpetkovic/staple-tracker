/**
 * Milestones across every workspace, and the page a workspace without milestones gets.
 *
 * ALL WORKSPACES. A milestone belongs to one workspace — its members, its order and its
 * revision live in one store — so editing one needs that workspace. Reading them does not.
 * This page is the Milestones outline, read-only: per workspace with milestones, a heading
 * strip with its name and counts, its open milestones drawn as the outline's section headers,
 * then its own Finished line. Workspaces with none are left out. Each header is one control:
 * opening it is the moment the page switches to that workspace, landing on the milestone's
 * section — the same place the row's milestone marker takes you. Every milestone is listed,
 * whatever the header's Done toggle says, as on one workspace's page.
 *
 * MILESTONES NOT TURNED ON. A workspace whose vocabulary has no `milestone` kind cannot hold
 * milestones, and the store says so in a sentence written for the command line. Here it is a
 * plain sentence and one button that opens this workspace's kinds in Settings, where the kind
 * is added.
 */
import { ChevronDown, ChevronRight, Milestone, Settings2 } from "lucide-react";
import { useCallback, useId, useMemo, useState, type KeyboardEvent } from "react";
import { PlainCard } from "@/components/plain/PlainCard";
import { EmptyState as PlainEmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import { AuthError, getMilestones, getQueue } from "@/lib/api";
import { useSession, type StapleSession } from "@/lib/session";
import { openSettings } from "@/lib/shell-events";
import type { EffectiveQueueRow, MilestoneListRow, QueueView, WorkspaceRef } from "@/lib/types";
import { useIsDesk } from "@/lib/use-media";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { useElementWidth } from "@/views/plan/plan-parts";
import { ErrorState } from "@/views/ViewChrome";
import { dueText, progressSentence, projectedDue, shownState } from "./milestone-plain";
import { MilestoneGlyph, QueuedMark } from "./milestone-parts";
import { MilestoneDueControl } from "./MilestoneDue";
import { HeaderFacts, NAME_LINE, NAME_TEXT, NarrowPercent } from "./MilestoneSection";
import { groupAllMilestones, type AllMilestones, type WorkspaceMilestonesResult } from "./milestones-model";
import { MILESTONES_NARROW } from "./milestones-memory";
import { MilestonesSkeleton, outlineGroups } from "./MilestonesOutline";

/**
 * Read every workspace's list, and its queue: the same two inputs the workspace page reads, so
 * a header here says what the same header says there. One workspace failing never hides the
 * others; a queue that cannot be read leaves that workspace's risk lines silent rather than wrong.
 */
export async function readAllMilestones(
  workspaces: readonly Pick<WorkspaceRef, "slug">[],
  all: boolean,
  read: typeof getMilestones = getMilestones,
  readQueue: (params: { ws: string }) => Promise<Pick<QueueView, "effective">> = getQueue,
): Promise<WorkspaceMilestonesResult[]> {
  return Promise.all(
    workspaces.map(async ({ slug }): Promise<WorkspaceMilestonesResult> => {
      try {
        const rows = await read({ ws: slug, all });
        const effective = rows.length === 0 ? [] : await readQueue({ ws: slug }).then((queue) => queue.effective, (error: unknown) => {
          if (error instanceof AuthError) throw error;
          return [];
        });
        return { workspace: slug, ok: true, rows, effective };
      } catch (error) {
        // A bad credential is the page's problem, not this workspace's: let the token screen have it.
        if (error instanceof AuthError) throw error;
        return { workspace: slug, ok: false, error };
      }
    }),
  );
}

export function AllWorkspacesMilestones({
  workspaces,
  onAuthError,
}: {
  workspaces: readonly WorkspaceRef[];
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  // Keyed on the slugs, not the array: the scope hands over a fresh array every render, and
  // an array dependency would refetch every workspace on every render. Every milestone is read
  // and listed, finished ones included: the open ones are headers, the rest each group's
  // Finished line. The Done toggle governs rows inside a milestone's work, not this list.
  const slugs = workspaces.map((workspace) => workspace.slug).join("\n");
  const load = useCallback(() => readAllMilestones(slugs.split("\n").map((slug) => ({ slug })), true), [slugs]);
  const resource = useResource(load, [slugs, session.version], onAuthError);
  const all = useMemo(() => (resource.data ? groupAllMilestones(resource.data, true) : null), [resource.data]);
  const open = (workspace: string, ref: string) => openMilestoneIn(session, workspace, ref);

  if (resource.error) {
    return (
      <div className="px-gutter" data-all-milestones="">
        <ErrorState error={resource.error} />
      </div>
    );
  }
  if (!all) {
    return (
      <div className="h-full" data-all-milestones="">
        <MilestonesSkeleton />
      </div>
    );
  }
  return <AllWorkspacesOutline all={all} onOpen={open} />;
}

/** Every workspace's milestones as the outline, read-only. Drawn from the grouped lists alone. */
export function AllWorkspacesOutline({ all, now = new Date(), onOpen }: { all: AllMilestones; now?: Date; onOpen: (workspace: string, ref: string) => void }) {
  const desk = useIsDesk();
  const { ref: frame, width } = useElementWidth<HTMLDivElement>();
  // The page container's width; before it is measured (and in a string render), the shell's.
  const narrow = width === null ? !desk : width < MILESTONES_NARROW;
  const empty = all.groups.length === 0 && all.failed.length === 0;
  return (
    <div ref={frame} className="@container/ms h-full min-h-0 overflow-y-auto overscroll-contain pb-6" data-all-milestones="">
      {empty ? (
        // The outline's own empty state, without "+ Milestone": creating one needs a workspace.
        <div className="px-gutter py-10" data-all-milestones-empty="">
          <PlainEmptyState compact icon={Milestone} title="No milestones here yet">
            A milestone gathers tasks that should be finished by a date. Open a workspace to create one, or ask an agent to.
          </PlainEmptyState>
        </div>
      ) : null}
      {all.groups.map((group) => (
        <WorkspaceGroup key={group.workspace} workspace={group.workspace} rows={group.rows} effective={group.effective} now={now} narrow={narrow} onOpen={onOpen} />
      ))}
      {all.failed.map((failure) => (
        <section key={failure.workspace} aria-label={failure.workspace} data-milestone-group-failed={failure.workspace}>
          <GroupHeading workspace={failure.workspace} />
          <p className="m-0 border-b px-4 py-2.5 text-label text-text-secondary @max-[760px]/ms:px-3">
            Could not read this workspace's milestones: {failure.error instanceof Error ? failure.error.message : String(failure.error)}
          </p>
        </section>
      ))}
    </div>
  );
}

/** The strip that opens a workspace's group: its name and, when it was read, its quiet counts. */
function GroupHeading({ workspace, counts }: { workspace: string; counts?: { open: number; finished: number } }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b bg-surface-sunken px-4 py-2.5 @max-[760px]/ms:px-3" data-milestone-group-heading="">
      <h2 className="m-0 text-body font-semibold">{workspace}</h2>
      {counts ? (
        <span className="text-label text-text-tertiary tabular-nums" data-milestone-group-counts="">
          {counts.open} open · {counts.finished} finished
        </span>
      ) : null}
    </div>
  );
}

/** One workspace: its heading strip, its open milestones' headers, then its own Finished line. */
function WorkspaceGroup({
  workspace,
  rows,
  effective,
  now,
  narrow,
  onOpen,
}: {
  workspace: string;
  rows: readonly MilestoneListRow[];
  effective: readonly EffectiveQueueRow[];
  now: Date;
  narrow: boolean;
  onOpen: (workspace: string, ref: string) => void;
}) {
  const { open, finished } = useMemo(() => outlineGroups(rows), [rows]);
  // Per visit: nothing about this page is remembered.
  const [shelfOpen, setShelfOpen] = useState(false);
  return (
    <section aria-label={workspace} data-milestone-group={workspace}>
      <GroupHeading workspace={workspace} counts={{ open: open.length, finished: finished.length }} />
      {open.length === 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-2.5 pr-4 pl-[42px] @max-[760px]/ms:px-3" data-milestones-none-open="">
          <span className="text-body font-semibold text-text-secondary">No open milestones</span>
        </div>
      ) : null}
      {open.map((row) => (
        <HeaderLink key={row.milestone.identifier} row={row} workspace={workspace} effective={effective} now={now} narrow={narrow} onOpen={() => onOpen(workspace, row.milestone.identifier)} />
      ))}
      {finished.length > 0 ? (
        <>
          <button
            type="button"
            className="focus-ring-inset flex min-h-9 w-full items-center gap-2 border-b bg-surface-sunken py-1.5 pr-4 pl-[15px] text-left text-label text-text-secondary hover:bg-surface-hover @max-[760px]/ms:pl-[11px]"
            aria-expanded={shelfOpen}
            onClick={() => setShelfOpen(!shelfOpen)}
            data-milestone-group-shelf={workspace}
          >
            {shelfOpen ? <ChevronDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />}
            <span className="ml-1.5 font-semibold">Finished</span>
            <span className="tabular-nums text-text-tertiary">{finished.length}</span>
            <span className="text-text-tertiary">· {shelfOpen ? "hide" : "show"}</span>
          </button>
          {shelfOpen ? finished.map((row) => <FinishedLink key={row.milestone.identifier} row={row} workspace={workspace} now={now} onOpen={() => onOpen(workspace, row.milestone.identifier)} />) : null}
        </>
      ) : null}
    </section>
  );
}

/** Enter and Space press a control that is not a `<button>`, as a button's do. */
function pressOnKey(onPress: () => void) {
  return (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onPress();
  };
}

/**
 * An open milestone as the outline's section header, read-only: the glyph, the name, the due
 * date in words and `Queued #n` as text, then the bar, the flags and the facts. No fold, no `⋯`,
 * no calendar and no Queue: the whole header is one control that opens the milestone in its
 * workspace. It holds a bar and a paragraph, which a `<button>` may not, so it is a `role="button"`
 * box; the facts are its description.
 */
function HeaderLink({ row, workspace, effective, now, narrow, onOpen }: { row: MilestoneListRow; workspace: string; effective: readonly EffectiveQueueRow[]; now: Date; narrow: boolean; onOpen: () => void }) {
  const { milestone, progress } = row;
  const facts = useId();
  const due = <MilestoneDueControl milestone={milestone} projection={projectedDue(row.remaining, now)} now={now} editable={false} />;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${milestone.title} in ${workspace}`}
      aria-describedby={facts}
      onClick={onOpen}
      onKeyDown={pressOnKey(onOpen)}
      className="focus-ring-inset min-h-0 cursor-pointer border-b px-4 pt-3 pb-2.5 hover:bg-surface-hover @max-[760px]/ms:px-3 @max-[760px]/ms:pt-0"
      data-milestone-header-link={milestone.identifier}
    >
      <div className={NAME_LINE}>
        <MilestoneGlyph state={shownState(milestone, now)} percent={progress.percent} />
        <span className={cn("min-w-0 truncate", NAME_TEXT)}>{milestone.title}</span>
        {narrow ? null : <span className="shrink-0 text-label text-text-secondary">{due}</span>}
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          <NarrowPercent percent={progress.percent} />
          {narrow ? null : <QueuedMark position={milestone.planPosition} />}
        </span>
      </div>
      <div id={facts} className="mt-1.5 @max-[760px]/ms:mt-0">
        <HeaderFacts row={row} effective={effective} now={now} narrow={narrow} due={due} />
      </div>
    </div>
  );
}

/** A finished or cancelled milestone: the outline's one-line finished row without a chevron, as one button that opens it in its workspace. */
function FinishedLink({ row, workspace, now, onOpen }: { row: MilestoneListRow; workspace: string; now: Date; onOpen: () => void }) {
  const { milestone, progress } = row;
  return (
    <button
      type="button"
      aria-label={`Open ${milestone.title} in ${workspace}`}
      onClick={onOpen}
      className="focus-ring-inset flex min-h-10 w-full min-w-0 items-center gap-x-2.5 border-b px-4 text-left hover:bg-surface-hover @max-[760px]/ms:gap-x-2 @max-[760px]/ms:px-3"
      data-milestone-finished-link={milestone.identifier}
    >
      <MilestoneGlyph state={milestone.state} percent={progress.percent} />
      <span className="min-w-0 truncate text-body font-medium text-text-secondary">{milestone.title}</span>
      <span className="ms-auto shrink-0 text-label text-text-tertiary @max-[760px]/ms:hidden">{progressSentence(progress)}</span>
      <span className="shrink-0 text-label text-text-tertiary @max-[760px]/ms:ms-auto">{dueText(milestone, null, now)}</span>
    </button>
  );
}

/**
 * Opening a milestone that lives in `workspace` (the All-workspaces list, a row's milestone
 * marker, the detail drawer): switch to its workspace when the page is on another (All
 * workspaces included), then point the page at it. In this order, in one handler, so React
 * applies both together — the switch clears any milestone focus (it belonged to the workspace
 * being left), and the focus then names this one. A page already on that workspace, or a
 * single-workspace page (which has nowhere to switch to), only moves the focus.
 */
export function openMilestoneIn(
  session: Pick<StapleSession, "mode" | "ws" | "setWs" | "focusMilestone">,
  workspace: string,
  ref: string,
): void {
  if (session.mode === "hub" && workspace !== "" && workspace !== session.ws) session.setWs(workspace);
  session.focusMilestone(ref);
}

/** The one fix for a workspace without milestones: its kinds, in Settings. */
export function turnOnMilestones(workspace: string): void {
  openSettings({ section: "kinds", workspace });
}

/** A workspace with no milestone kind: what it means and the one place to fix it. */
export function MilestonesOff({ workspace }: { workspace: string }) {
  return (
    <div className="h-full overflow-y-auto" data-milestones-off={workspace}>
      <div className="mx-auto max-w-2xl px-4 py-5">
        <PlainCard
          title="Milestones"
          headline={`Milestones are not turned on in ${workspace}.`}
          headlineTestId="milestones-off-sentence"
          help={
            <>
              A milestone gathers tasks that should be finished by a date, so you can see how
              much is left. Each workspace chooses which kinds of item it uses. The button opens
              this workspace's kinds: add one named <span className="font-mono">milestone</span>{" "}
              and save, and milestones are turned on here.
            </>
          }
        >
          <Button
            variant="outline"
            size="sm"
            // 28px at every width; on a phone a 32px tap through an invisible inset.
            className="relative h-7 min-h-0 self-start max-md:before:absolute max-md:before:-inset-y-0.5 max-md:before:inset-x-0 max-md:before:content-['']"
            data-milestones-turn-on={workspace}
            onClick={() => turnOnMilestones(workspace)}
          >
            <Settings2 aria-hidden />
            Turn on milestones in Settings
          </Button>
        </PlainCard>
      </div>
    </div>
  );
}
