/**
 * Milestones across every workspace, and the page a workspace without milestones gets.
 *
 * ALL WORKSPACES. A milestone belongs to one workspace — its members, its order and its
 * revision live in one store — so editing one needs that workspace. Reading them does not.
 * This page lists every workspace's milestones, grouped under the workspace's name, read-only.
 * Workspaces with none are left out. Opening a milestone is the moment the page switches to
 * that workspace, with the milestone already open — the same place the row's milestone marker
 * takes you.
 *
 * MILESTONES NOT TURNED ON. A workspace whose vocabulary has no `milestone` kind cannot hold
 * milestones, and the store says so in a sentence written for the command line. Here it is a
 * plain sentence and one button that opens this workspace's kinds in Settings, where the kind
 * is added.
 */
import { Settings2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { PlainCard } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import { AuthError, getMilestones } from "@/lib/api";
import { useSession, type StapleSession } from "@/lib/session";
import { openSettings } from "@/lib/shell-events";
import type { WorkspaceRef } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { MilestoneListPane } from "./MilestonesView";
import { groupAllMilestones, type WorkspaceMilestonesResult } from "./milestones-model";

/** Read every workspace's list; one workspace failing never hides the others. */
export async function readAllMilestones(
  workspaces: readonly Pick<WorkspaceRef, "slug">[],
  all: boolean,
  read: typeof getMilestones = getMilestones,
): Promise<WorkspaceMilestonesResult[]> {
  return Promise.all(
    workspaces.map(async ({ slug }): Promise<WorkspaceMilestonesResult> => {
      try {
        return { workspace: slug, ok: true, rows: await read({ ws: slug, all }) };
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
  const showDone = session.filters.showDone;
  // Keyed on the slugs, not the array: the scope hands over a fresh array every render, and
  // an array dependency would refetch every workspace on every render.
  const slugs = workspaces.map((workspace) => workspace.slug).join("\n");
  const load = useCallback(
    () => readAllMilestones(slugs.split("\n").map((slug) => ({ slug })), showDone),
    [slugs, showDone],
  );
  const resource = useResource(load, [slugs, showDone, session.version], onAuthError);
  const all = useMemo(() => (resource.data ? groupAllMilestones(resource.data) : null), [resource.data]);

  const open = (workspace: string, ref: string) => openMilestoneIn(session, workspace, ref);

  return (
    <div className="h-full overflow-y-auto" data-all-milestones="">
      <div className="mx-auto max-w-3xl px-4 py-5">
        <h2 className="text-[17px] font-semibold tracking-[var(--tracking-heading)]">Milestones in every workspace</h2>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Open a milestone to see what is left in it. That switches to its workspace.
        </p>
        {resource.error ? <ErrorState error={resource.error} /> : null}
        {!all ? (
          resource.error ? null : <LoadingState />
        ) : all.groups.length === 0 && all.failed.length === 0 ? (
          <p className="mt-6 text-[14px]" data-all-milestones-empty="">
            No workspace has milestones yet. A milestone gathers tasks that should be finished by a date.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-6">
            {all.groups.map((group) => (
              <section key={group.workspace} aria-label={group.workspace} data-milestone-group={group.workspace}>
                <h3 className="mb-2 border-b pb-1.5 text-[13px] font-semibold">{group.workspace}</h3>
                <MilestoneListPane rows={group.rows} selectedRef={null} onSelect={(ref) => open(group.workspace, ref)} />
              </section>
            ))}
            {all.failed.map((failure) => (
              <section key={failure.workspace} aria-label={failure.workspace} data-milestone-group-failed={failure.workspace}>
                <h3 className="mb-2 border-b pb-1.5 text-[13px] font-semibold">{failure.workspace}</h3>
                <p className="text-[13px] text-muted-foreground">
                  Could not read this workspace's milestones:{" "}
                  {failure.error instanceof Error ? failure.error.message : String(failure.error)}
                </p>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Opening a milestone from the All-workspaces list: switch to its workspace, then point the
 * page at it. In this order, in one handler, so React applies both together — the switch
 * clears any milestone focus (it belonged to the workspace being left), and the focus then
 * names this one.
 */
export function openMilestoneIn(
  session: Pick<StapleSession, "setWs" | "focusMilestone">,
  workspace: string,
  ref: string,
): void {
  session.setWs(workspace);
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
            className="min-h-11 self-start"
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
