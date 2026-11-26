/**
 * THE AUTOPILOT VIEW: `?view=autopilot`, and `?view=autopilot&run=<run id>` for one run.
 *
 * The page (AutopilotPage.tsx) is props in; this is where the app's state meets it. The runs
 * are the root's one read (`useRuns`), the selected run is the address's (`session.run`, set
 * by `session.openRun`, so the list and a run are history steps), and a ticket opens in the
 * drawer.
 *
 * A run the list does not hold (an ended run past `/api/runs`'s limit, or one in another
 * workspace on a hub) is read on its own (`useRunEntry`) and shown beside the listed ones, so
 * a link to any run opens it.
 */
import { useMemo } from "react";
import { useNow } from "@/detail/parts";
import type { AuthError } from "@/lib/api";
import { useRunEntry, useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { AutopilotPage } from "./AutopilotPage";

export function AutopilotView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const runs = useRuns();
  const session = useSession();
  const now = useNow();
  const read = useRunEntry(session.run, onAuthError);
  const linked = read.entry;
  const entries = useMemo(
    () => (linked && !runs.entries.some((entry) => entry.run.id === linked.run.id) ? [...runs.entries, linked] : runs.entries),
    [runs.entries, linked],
  );
  return (
    <AutopilotPage
      entries={entries}
      selectedRunId={session.run}
      selectedLoading={read.loading}
      onSelectRun={session.openRun}
      onOpenTicket={(workspace, ref) => session.open(workspace, ref)}
      showWorkspace={isAllWorkspaces(session)}
      // The runs read has no loading flag of its own: no server clock yet means not read yet.
      loading={runs.now === null}
      error={null}
      now={now}
    />
  );
}
