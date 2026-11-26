/**
 * THE AUTOPILOT PAGE: every autopilot run in scope, and one run in full.
 *
 * Two panes from 900px of its own width (the run list beside the run, each scrolling on its
 * own), one pane under it (the list, or the run with a way back). The width is the page's
 * container, not the viewport: a narrow content card on a wide screen gets the one-pane page.
 * CSS lays it out (container queries on `@container/auto`); JS measures the same width only to
 * decide which run a wide page shows when none is selected, and to leave the hidden pane out
 * once it knows the page is narrow.
 *
 * `AutopilotPage` is props in: the caller owns the runs, the selection and what opening a
 * ticket means. `AutopilotView` is the thin wrapper that reads them from the app.
 */
import { Bot, Check, Copy } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/detail/parts";
import type { AuthError } from "@/lib/api";
import { useRuns } from "@/lib/runs";
import { isAllWorkspaces, useSession } from "@/lib/session";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useElementWidth } from "@/views/plan/plan-parts";
import { ErrorState } from "@/views/ViewChrome";
import { AUTOPILOT_WIDE, shownRun } from "./autopilot-text";
import { BackLink, RunDetail } from "./RunDetail";
import { RunList } from "./RunList";

export interface AutopilotPageProps {
  /** Every run in scope, newest first (as `useRuns().entries`). */
  entries: readonly RunEntry[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onOpenTicket: (workspace: string, ref: string) => void;
  /** All workspaces: each run names its workspace. */
  showWorkspace: boolean;
  loading: boolean;
  error: Error | null;
  now: Date;
}

/** The command an agent runs to start a run, as the empty page shows it. */
export const START_COMMAND = "staple run drive --scope queue --agent claude --max-tickets 5";

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return (
    <div className="mt-4 flex max-w-full items-center gap-2.5 rounded-lg border bg-surface-sunken py-1.5 pr-1.5 pl-2.5 text-left font-mono text-label text-foreground">
      <code className="min-w-0 overflow-x-auto py-0.5 whitespace-nowrap select-all">{text}</code>
      {clipboard ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Copied" : "Copy the command"}
          title="Copy"
          className="shrink-0 pointer-coarse:size-11"
          onClick={() => {
            clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        </Button>
      ) : null}
    </div>
  );
}

function NoRuns() {
  return (
    <div data-run-history-empty="" className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
      <EmptyState icon={Bot} title="No autopilot runs yet">
        <p className="m-0">
          A run is an agent working through the queue, an epic or a milestone, ticket after ticket, until a limit you set stops it. You watch, pause and stop runs here.
          An agent starts one.
        </p>
        <CopyCommand text={START_COMMAND} />
        <p className="m-0 mt-3 text-label text-text-tertiary">Or ask an agent to keep working through the queue.</p>
      </EmptyState>
    </div>
  );
}

function Loading() {
  return (
    <div role="status" aria-busy="true" data-run-loading="" className="flex min-h-0 flex-1">
      <span className="sr-only">Loading runs</span>
      <div aria-hidden className="w-full shrink-0 @min-[900px]/auto:w-[360px] @min-[900px]/auto:border-r">
        <Skeleton className="h-[34px] rounded-none" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 border-b px-4 py-3">
            <Skeleton className="h-3 w-[70%]" />
            <Skeleton className="h-3 w-[45%]" />
            <Skeleton className="h-4 w-[30%] rounded-full" />
          </div>
        ))}
      </div>
      <div aria-hidden className="hidden min-w-0 flex-1 flex-col gap-5 px-7 pt-5 @min-[900px]/auto:flex">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-[88px] rounded-xl" />
        <Skeleton className="h-[72px] rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}

function UnknownRun({ onShowAll }: { onShowAll: () => void }) {
  return (
    <div data-run-unknown="" className="flex flex-col gap-4 px-4 pt-3 pb-8 @min-[900px]/auto:px-7 @min-[900px]/auto:pt-5">
      <BackLink onBack={onShowAll} />
      <EmptyState
        icon={Bot}
        title="This run is not in the list."
        action={
          <Button type="button" variant="outline" size="sm" onClick={onShowAll} className="pointer-coarse:h-11">
            Show all runs
          </Button>
        }
      />
    </div>
  );
}

/**
 * The page once its width is known (`wide`: true from 900px, false under, null before the
 * first measure, when CSS alone decides). Exported for tests, which render it with a width.
 */
export function AutopilotLayout({ wide, ...props }: AutopilotPageProps & { wide: boolean | null }) {
  const { entries, selectedRunId, onSelectRun, onOpenTicket, showWorkspace, loading, error, now } = props;
  if (error) {
    return (
      <div className="px-4 py-3">
        <ErrorState error={error} />
      </div>
    );
  }
  if (loading && entries.length === 0) return <Loading />;
  if (entries.length === 0) return <NoRuns />;

  // A selection is the reader's; a wide page with none shows a run without selecting it.
  const hasRun = selectedRunId !== null;
  const current = shownRun(entries, selectedRunId, wide === true);
  const showList = wide !== false || !hasRun;
  const showDetail = wide !== false || hasRun;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @min-[900px]/auto:flex-row @min-[900px]/auto:overflow-hidden" data-autopilot-panes={hasRun ? "run" : "list"}>
      {showList ? (
        <RunList
          entries={entries}
          currentRunId={current?.run.id ?? null}
          showWorkspace={showWorkspace}
          onSelectRun={onSelectRun}
          now={now}
          className={cn("shrink-0 @min-[900px]/auto:w-[360px] @min-[900px]/auto:overflow-y-auto @min-[900px]/auto:border-r", hasRun && "@max-[900px]/auto:hidden")}
        />
      ) : null}
      {showDetail ? (
        <div className={cn("min-w-0 flex-1 @min-[900px]/auto:overflow-y-auto", !hasRun && "@max-[900px]/auto:hidden")}>
          {current ? (
            <RunDetail key={current.run.id} entry={current} showWorkspace={showWorkspace} onOpenTicket={onOpenTicket} onBack={() => onSelectRun(null)} now={now} />
          ) : hasRun ? (
            <UnknownRun onShowAll={() => onSelectRun(null)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AutopilotPage(props: AutopilotPageProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const wide = width === null ? null : width >= AUTOPILOT_WIDE;
  return (
    <div ref={ref} data-autopilot-view="" className="@container/auto flex h-full min-h-0 flex-col">
      <AutopilotLayout {...props} wide={wide} />
    </div>
  );
}

/** The page as a view: the app's runs, its workspace scope, and the drawer for a ticket. */
export function AutopilotView(_props: { onAuthError: (error: AuthError) => void }) {
  const runs = useRuns();
  const session = useSession();
  const now = useNow();
  // TEMPORARY: the selected run is page state until the routing lands (`?view=autopilot&run=<id>`);
  // it is then read from and written to the session (`session.run` / `session.openRun`, names to be confirmed).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  return (
    <AutopilotPage
      entries={runs.entries}
      selectedRunId={selectedRunId}
      onSelectRun={setSelectedRunId}
      onOpenTicket={(workspace, ref) => session.open(workspace, ref)}
      showWorkspace={isAllWorkspaces(session)}
      // The runs read has no loading or error flag of its own: no server clock yet means not read yet.
      loading={runs.now === null}
      error={null}
      now={now}
    />
  );
}
