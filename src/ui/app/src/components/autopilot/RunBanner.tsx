/**
 * THE RUN BANNER — a live autopilot run, where you can see it and stop it.
 *
 * One line says the whole run, in the order a person asks about it:
 *
 *   Autopilot · ABC-40 · 2/5 done · next ABC-43 · stops after 5 tickets (2 taken)
 *
 * which scope, how far along, what it is on now, and what would stop it. Under it, the run's
 * state (working, paused, or what it waits on) and whether a driver process is attached,
 * because a run nobody is driving is a run that takes nothing; then Stop and Details.
 *
 * ── TWO PLACES, ONE CARD ──────────────────────────────────────────────────────────────
 *
 *   ON A DESK   the rail's "Autopilot" section (NavRail), one card per live run, under the
 *               views: the rail is where the page says where you are and what is going on.
 *   ON A PHONE  the rail is a drawer, closed by default, so a banner only there would be one
 *               nobody sees. `RunStrip` is the same run as one line above the tab bar, with a
 *               44px Stop, on every view; the drawer still has the full cards.
 *
 * Both read `useRuns()`, the page's one `/api/runs` read on the fingerprint poll, so a run
 * started, stopped or paused anywhere shows here within one refresh.
 */
import { Bot, ChevronRight } from "lucide-react";
import { bannerLine, driverText, liveStateText, nextText, progress, scopeText, stopRuleText } from "@/lib/run-text";
import { useRuns } from "@/lib/runs";
import { openRunHistory } from "@/lib/shell-events";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RunStatePill, StopRunButton } from "./RunParts";

/** The rail's card for one live run. */
export function RunCard({ entry, showWorkspace = false, onNavigate }: { entry: RunEntry; showWorkspace?: boolean; onNavigate?: () => void }) {
  const { run, facts, decision, driver } = entry;
  const state = liveStateText(entry);
  const counted = progress(run, facts);
  const next = nextText(run, facts);
  const line = bannerLine(entry);
  return (
    <article
      data-run-banner={run.id}
      aria-label={line}
      className="flex flex-col gap-1.5 rounded-lg border bg-surface-raised px-2.5 py-2 text-body shadow-xs"
    >
      {/* The one line, laid out over three so it fits a 240px rail; the separators stay. */}
      <p className="m-0 flex min-w-0 items-center gap-1.5 font-medium text-foreground" title={line}>
        <Bot aria-hidden className="size-4 shrink-0 text-text-tertiary" />
        <span className="truncate">
          Autopilot · {scopeText(run)}
          {showWorkspace ? <span className="font-normal text-text-tertiary"> · {entry.workspace}</span> : null}
        </span>
      </p>
      <p className="m-0 truncate text-label text-text-secondary" data-run-progress="">
        {[counted ? `${counted.done}/${counted.total} done` : null, next].filter(Boolean).join(" · ") || "nothing taken yet"}
      </p>
      <p className="m-0 text-label text-text-tertiary" data-run-stop-rule="">
        {stopRuleText(run, decision)}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <RunStatePill text={state.text} tone={state.tone} className="max-w-full" />
        <span className="min-w-0 truncate text-caption text-text-tertiary" data-run-driver={driver === null ? "none" : String(driver.alive)}>
          {driverText(driver)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <StopRunButton entry={entry} />
        <button
          type="button"
          data-run-details={run.id}
          onClick={() => {
            onNavigate?.();
            openRunHistory({ runId: run.id });
          }}
          className="inline-flex h-8 items-center gap-0.5 rounded-md px-2 text-label text-text-secondary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:h-11"
        >
          Details
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
    </article>
  );
}

/**
 * The phone's banner: the first live run as one line and a Stop, above the tab bar. More than
 * one live run says how many more; the line opens the history, which lists them all.
 */
export function RunStrip() {
  const { live } = useRuns();
  const entry = live[0];
  if (!entry) return null;
  const state = liveStateText(entry);
  const line = bannerLine(entry);
  const more = live.length - 1;
  const counted = progress(entry.run, entry.facts);
  const head = ["Autopilot", scopeText(entry.run), counted ? `${counted.done}/${counted.total} done` : null].filter(Boolean).join(" · ");
  const next = nextText(entry.run, entry.facts);
  return (
    <div data-run-strip={entry.run.id} className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card py-1 pr-2 pl-1.5">
      <button
        type="button"
        onClick={() => openRunHistory({ runId: entry.run.id })}
        aria-label={`${line}. ${state.text}. Show autopilot runs`}
        className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left focus-ring-inset active:bg-surface-hover")}
      >
        <Bot aria-hidden className="size-5 shrink-0 text-text-tertiary" />
        {/* The line split in two for 390px: what it is and how far, then what it is on now. */}
        <span className="flex min-w-0 flex-col" title={line}>
          <span className="truncate text-body font-medium text-foreground">{head}</span>
          <span className="truncate text-caption text-text-secondary">
            {[next, state.text, more > 0 ? `${more} more ${more === 1 ? "run" : "runs"}` : null].filter(Boolean).join(" · ")}
          </span>
        </span>
      </button>
      <StopRunButton entry={entry} touch />
    </div>
  );
}
