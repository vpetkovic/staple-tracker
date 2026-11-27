/**
 * The Milestones destination: every workspace's milestones read-only (All workspaces), or one
 * workspace's as an outline (`MilestonesOutline.tsx`), the shape of Plan's Horizons lens.
 *
 * `WorkspaceMilestones` reads the workspace's milestone list and its queue; each section of the
 * outline reads its own milestone (`useMilestoneWork.ts`) once it is unfolded.
 */
import { useCallback, useMemo } from "react";
import { getMilestones, getQueue, type AuthError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { ErrorState } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import { AllWorkspacesMilestones, MilestonesOff } from "./AllWorkspacesMilestones";
import { isMissingMilestoneKind, sortMilestones } from "./milestones-model";
import { MilestonesOutline, MilestonesSkeleton } from "./MilestonesOutline";

export function MilestonesView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const scope = workspaceScope(session.mode, session.ws, session.workspaces);
  if (scope.kind === "choose") {
    return <AllWorkspacesMilestones workspaces={scope.workspaces} onAuthError={onAuthError} />;
  }
  return <WorkspaceMilestones key={scope.slug} workspace={scope.slug} onAuthError={onAuthError} />;
}

function WorkspaceMilestones({ workspace, onAuthError }: { workspace: string; onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  // Always the workspace the page names — never the server's own first (workspace-scope.ts).
  const ws = workspace || undefined;
  // Every milestone, finished ones included: the open ones are sections, the rest the Finished shelf.
  const loadList = useCallback(() => getMilestones({ ws, all: true }), [ws]);
  const list = useResource(loadList, [ws, session.version], onAuthError);
  const sorted = useMemo(() => (list.data ? sortMilestones(list.data) : []), [list.data]);

  // Blocked and gated are the resolver's verdict, not a status category, so the page reads
  // the queue alongside the list and counts them off `effective` (see `milestoneRisk`). A
  // queue that has not loaded leaves the risk lines silent rather than wrong; a queue that
  // fails is not this page's error state, so it is deliberately not surfaced. Its revision is
  // what a section's Queue writes against.
  const loadQueue = useCallback(() => getQueue({ ws }), [ws]);
  const queue = useResource(loadQueue, [ws, session.version], onAuthError);
  const effective = queue.data?.effective ?? [];

  // The workspace has no milestone kind: the whole page says so, in words, with the fix.
  if (list.error && isMissingMilestoneKind(list.error)) return <MilestonesOff workspace={workspace} />;
  if (list.error) {
    return (
      <div className="px-gutter" data-milestones-error="">
        <ErrorState error={list.error} />
      </div>
    );
  }
  if (list.data === undefined) return <MilestonesSkeleton />;
  return <MilestonesOutline workspace={workspace} rows={sorted} effective={effective} queueRevision={queue.data?.revision} onAuthError={onAuthError} />;
}
