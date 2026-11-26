/**
 * THE RUN LIST: the live runs under "Running now", the ended ones under "Earlier", newest
 * first in each. One button per run, three lines: its state dot, name and time; its scope,
 * who ran it and where; its state in words and what it got done.
 */
import { RunStatePill } from "@/components/autopilot/RunParts";
import { isLiveRun } from "@/lib/run-text";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isWorking, listTime, runPill, runTitle, scopeLine, tally, type TallyTone } from "./autopilot-text";
import { RunDot, WorkspacePill } from "./autopilot-parts";

const TALLY_CLASS: Record<TallyTone, string> = {
  ok: "text-[var(--plain-ok-fg)]",
  risk: "text-[var(--plain-risk-fg)]",
  quiet: "text-text-tertiary",
};

function RunItem({
  entry,
  current,
  showWorkspace,
  onSelect,
  now,
}: {
  entry: RunEntry;
  current: boolean;
  showWorkspace: boolean;
  onSelect: (runId: string) => void;
  now: Date;
}) {
  const { run } = entry;
  const pill = runPill(entry);
  const title = runTitle(entry);
  return (
    <li>
      <button
        type="button"
        data-run-item={run.id}
        aria-current={current ? "true" : undefined}
        onClick={() => onSelect(run.id)}
        className="focus-ring-inset grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 border-b px-4 py-2.5 text-left hover:bg-surface-hover aria-[current=true]:bg-surface-selected"
      >
        <RunDot tone={pill.tone} pulse={isWorking(entry)} className="justify-self-center" />
        <span className="truncate text-body font-medium text-foreground" title={title}>
          {title}
        </span>
        <span className="text-label whitespace-nowrap text-text-tertiary tabular-nums">{listTime(run, now)}</span>
        <span className="col-[2/-1] flex min-w-0 items-center gap-1.5 text-label text-text-tertiary">
          <span className="truncate">
            {scopeLine(entry)} · {run.actor}
          </span>
          {showWorkspace ? <WorkspacePill workspace={entry.workspace} /> : null}
        </span>
        <span className="col-[2/-1] mt-[3px] flex min-w-0 items-center gap-2">
          <RunStatePill text={pill.text} tone={pill.tone} />
          <span className="ml-auto inline-flex shrink-0 gap-2 text-label whitespace-nowrap tabular-nums">
            {tally(run).map((part) => (
              <span key={part.text} className={TALLY_CLASS[part.tone]}>
                {part.text}
              </span>
            ))}
          </span>
        </span>
      </button>
    </li>
  );
}

interface Shared {
  currentRunId: string | null;
  showWorkspace: boolean;
  onSelectRun: (runId: string) => void;
  now: Date;
}

function Group({ label, entries, ...rest }: { label: string; entries: readonly RunEntry[] } & Shared) {
  if (entries.length === 0) return null;
  const id = `autopilot-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <div className="sticky top-0 z-[2] flex h-[34px] items-center gap-2 border-b bg-surface-sunken px-4">
        <h2 id={id} className="m-0 text-label font-semibold text-text-secondary">
          {label}
        </h2>
        <span className="text-label text-text-tertiary tabular-nums">{entries.length}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {entries.map((entry) => (
          <RunItem
            key={`${entry.workspace}/${entry.run.id}`}
            entry={entry}
            current={entry.run.id === rest.currentRunId}
            showWorkspace={rest.showWorkspace}
            onSelect={rest.onSelectRun}
            now={rest.now}
          />
        ))}
      </ul>
    </section>
  );
}

/** `currentRunId` is the run the detail shows, marked `aria-current`. */
export function RunList({
  entries,
  currentRunId,
  showWorkspace,
  onSelectRun,
  now,
  className,
}: {
  entries: readonly RunEntry[];
  className?: string;
} & Shared) {
  const live = entries.filter((entry) => isLiveRun(entry.run));
  const ended = entries.filter((entry) => !isLiveRun(entry.run));
  const shared = { currentRunId, showWorkspace, onSelectRun, now };
  return (
    <div data-run-list="" aria-label="Runs" role="region" className={cn("min-w-0", className)}>
      <Group label="Running now" entries={live} {...shared} />
      <Group label="Earlier" entries={ended} {...shared} />
    </div>
  );
}
