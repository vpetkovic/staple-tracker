/**
 * THE AUTOPILOT PAGE — `?view=autopilot`, and `?view=autopilot&run=<run id>` for one run.
 *
 * The routing's own minimal page: every run by name, newest first, each a link to that run;
 * and one run with its details, Stop and Pause, and a way back to the list. It replaces the
 * run history dialog so every place that names a run is a link with an address, Back and
 * Forward. The page's design (STA-557) replaces this layout; the data and the address stay.
 *
 * A run the list does not hold (an ended run past `/api/runs`'s limit, or one in another
 * workspace on a hub) is read on its own (`useRunEntry`), so a link to any run opens it.
 */
import { ArrowLeft } from "lucide-react";
import { RunHistoryItem } from "@/components/autopilot/RunHistoryDialog";
import { RunStatePill } from "@/components/autopilot/RunParts";
import type { AuthError } from "@/lib/api";
import { endedStateText, isLiveRun, liveStateText } from "@/lib/run-text";
import { useRunEntry, useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { runHref } from "@/lib/session-url";
import type { RunEntry } from "@/lib/types";
import { ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";

export function AutopilotView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  return (
    <div className="h-full overflow-y-auto" data-autopilot-view="">
      <div className="mx-auto max-w-3xl px-4 py-5">
        {session.run === null ? <RunList /> : <OneRun runId={session.run} onAuthError={onAuthError} />}
      </div>
    </div>
  );
}

function RunList() {
  const session = useSession();
  const { entries } = useRuns();
  const all = isAllWorkspaces(session);
  if (entries.length === 0) {
    return (
      <p className="m-0 text-body text-text-secondary" data-autopilot-empty="">
        No autopilot runs yet. An agent starts one when you ask it to keep working through the queue, an epic or a milestone.
      </p>
    );
  }
  const section = (label: string, rows: readonly RunEntry[]) =>
    rows.length === 0 ? null : (
      <section aria-label={label} className="flex flex-col gap-2">
        <SectionHeading>{label}</SectionHeading>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((entry) => {
            const state = isLiveRun(entry.run) ? liveStateText(entry) : endedStateText(entry.run);
            return (
              <li key={`${entry.workspace}/${entry.run.id}`}>
                <a
                  href={runHref(window.location.href, entry.run.id)}
                  data-autopilot-run={entry.run.id}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    session.openRun(entry.run.id);
                  }}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-3 py-2 hover:bg-surface-hover focus-ring pointer-coarse:min-h-11"
                >
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{entry.title}</span>
                  <RunStatePill text={state.text} tone={state.tone} />
                  {all ? <span className="text-caption text-text-tertiary">{entry.workspace}</span> : null}
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    );
  return (
    <div className="flex flex-col gap-5">
      {section("Running now", entries.filter((entry) => isLiveRun(entry.run)))}
      {section("Earlier", entries.filter((entry) => !isLiveRun(entry.run)))}
    </div>
  );
}

function OneRun({ runId, onAuthError }: { runId: string; onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { entry, error, loading } = useRunEntry(runId, onAuthError);
  return (
    <div className="flex flex-col gap-3" data-autopilot-one-run={runId}>
      <button
        type="button"
        data-autopilot-back=""
        onClick={() => session.openRun(null)}
        className="inline-flex w-fit items-center gap-1 rounded-md text-label text-text-secondary hover:text-foreground focus-ring pointer-coarse:min-h-11"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        All runs
      </button>
      {entry ? (
        <>
          <h1 className="m-0 text-title font-semibold">{entry.title}</h1>
          <ul className="m-0 list-none p-0">
            <RunHistoryItem entry={entry} showWorkspace={isAllWorkspaces(session)} onOpenTicket={(workspace, ref) => session.open(workspace, ref)} />
          </ul>
        </>
      ) : loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} />
      ) : null}
    </div>
  );
}
