/**
 * Sync state, as ONE small status pill — and nothing at all when there is none.
 *
 * ## It used to be a strip of field names
 *
 * `sync automatic  device vp-macbook  cursor eyJ2IjoxLCJ…  epoch 1` ran across the top of
 * every page, overflowed a phone sideways, and asked a reader to know what a cursor and an
 * epoch are. It is now a pill that says the state in a word or two ("Synced", "Offline",
 * "2 waiting to send"), coloured with the plain-language tones, and a tap opens a short
 * card: one sentence saying what that means, the few facts a person acts on, and the
 * technical values behind "Show details" for whoever wants them. The words are decided in
 * `syncSummary`, a pure function, so they are pinned without a DOM.
 *
 * ## The default is still to render nothing
 *
 * `docs/sync.md`: *"Before connect — render 'not connected' and a static hint naming
 * `staple cloud connect`. Static text. No probe, no reachability check, no 'we noticed you
 * might want to connect'. **The UI does not prompt.**"* A disconnected workspace, a status
 * that has not arrived, and a workspace with no sync identity all render the empty string
 * — the page looks exactly as it would with no cloud feature in it. `report.hint` is
 * carried on the contract and deliberately never read here.
 *
 * ## Why this component cannot cause a network call
 *
 * It takes a report as a prop and performs no fetch. `AppShell` reads `/api/cloud/status`
 * (same-origin loopback, three files and a local database, no `refresh` parameter) once per
 * workspace it shows, never on the 1.5s poll. On All workspaces it reads the hub's list
 * once instead and the pill counts the workspaces that sync (`hubSyncSummary`).
 *
 * ## Values, not prose
 *
 * Every decision below reads a value off the report — `state`, `pending`, `conflicts.open`
 * — and never parses `detail`. `failure.summary` and `failure.remedy` are sentences written
 * for a human, and are shown as such.
 */
import { CircleCheck, CircleHelp, CloudOff, OctagonAlert, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { ShowDetails } from "@/components/plain/PlainCard";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { plainAge, type PlainStatus } from "@/lib/plain-language";
import { openSettings } from "@/lib/shell-events";
import type { CloudSurfaceReport, HubCloudReport } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBackToClose } from "@/lib/back-to-close";

export interface SyncFact {
  label: string;
  value: string;
}

export interface SyncSummary {
  tone: PlainStatus;
  /** The pill: a word or two. */
  pill: string;
  /** What it means, in one or two plain sentences. */
  headline: string;
  /** What a person might act on. Only the ones worth saying. */
  facts: SyncFact[];
  /** The technical values, unchanged, for "Show details". */
  details: SyncFact[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The words for one workspace's sync state, or `null` when there is nothing to say —
 * disconnected, not loaded, or no sync identity. See the file header for why null.
 */
/**
 * "5 min ago", "3h ago", "2 days ago" — how a person reads a sync time. `null` for a value
 * that is not a time; the exact timestamp stays under Show details.
 */
export function syncedAgo(at: string, now: number = Date.now()): string | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const seconds = (now - then) / 1000;
  if (seconds < 45) return "Just now";
  return `${plainAge(seconds)} ago`;
}

export function syncSummary(report: CloudSurfaceReport | null, now: number = Date.now()): SyncSummary | null {
  if (report === null || report.state === "disconnected") return null;
  if (report.failure?.code === "no_identity") return null;

  const facts: SyncFact[] = [];
  const device = report.label ?? report.deviceId;
  if (device) facts.push({ label: "This device", value: device });
  const ago = report.lastSyncAt ? syncedAgo(report.lastSyncAt, now) : null;
  if (ago) facts.push({ label: "Last synced", value: ago });
  if (report.pending > 0) facts.push({ label: "Changes waiting to send", value: String(report.pending) });
  if (report.conflicts.open > 0) facts.push({ label: "Conflicts to resolve", value: String(report.conflicts.open) });
  if (report.leases.held > 0) facts.push({ label: "Tasks reserved by this device", value: String(report.leases.held) });

  const details: SyncFact[] = [{ label: "Sync mode", value: report.mode }];
  if (report.cursor) details.push({ label: "Position in the shared history", value: report.cursor });
  if (report.epoch !== null) details.push({ label: "History generation", value: String(report.epoch) });
  // The exact time, for whoever needs it; the card's facts say it as "5 min ago".
  if (report.lastSyncAt) details.push({ label: "Last synced at", value: report.lastSyncAt });

  if (report.failure) {
    const tone: PlainStatus = report.failure.code === "offline" ? "tight" : "at_risk";
    return {
      tone,
      pill: report.failure.code === "offline" ? "Offline" : "Sync stopped",
      headline: `${report.failure.summary} ${report.failure.remedy}`,
      facts,
      details,
    };
  }
  if (report.conflicts.open > 0) {
    return {
      tone: "tight",
      pill: plural(report.conflicts.open, "conflict", "conflicts"),
      headline: "Some changes from another device disagree with yours. Nothing is lost; they wait here until you choose.",
      facts,
      details,
    };
  }
  if (report.mode === "automatic") {
    return {
      tone: report.pending > 0 ? "unknown" : "on_track",
      pill: report.pending > 0 ? `${report.pending} waiting to send` : "Synced",
      headline:
        report.pending > 0
          ? "Changes sync automatically with your other devices. A few are still waiting to go out."
          : "Changes sync automatically with your other devices.",
      facts,
      details,
    };
  }
  return {
    tone: "unknown",
    pill: report.pending > 0 ? `${report.pending} waiting to send` : "Manual sync",
    headline: "This workspace syncs only when you ask it to (manual sync is on).",
    facts,
    details,
  };
}

/** The same pill for All workspaces: how many of them sync. `null` when none do. */
export function hubSyncSummary(hub: HubCloudReport | null): SyncSummary | null {
  if (hub === null || hub.counts.connected === 0) return null;
  const { connected, total, automatic } = hub.counts;
  return {
    tone: "on_track",
    pill: `${connected} of ${total} syncing`,
    headline: `${connected} of your ${plural(total, "workspace", "workspaces")} sync with your other devices${automatic > 0 ? `, ${automatic} of them automatically` : ""}. Pick a workspace to see its own sync state.`,
    facts: [
      { label: "Workspaces that sync", value: String(connected) },
      { label: "Workspaces on this computer", value: String(total) },
    ],
    details: [],
  };
}

const TONE_ICON: Record<PlainStatus, LucideIcon> = {
  on_track: CircleCheck,
  tight: TriangleAlert,
  at_risk: OctagonAlert,
  unknown: CircleHelp,
};
const TONE: Record<PlainStatus, string> = { on_track: "ok", tight: "tight", at_risk: "risk", unknown: "unknown" };

function Facts({ facts }: { facts: readonly SyncFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[13px]">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 truncate text-right font-medium tabular-nums" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The pill and its card. `compact` (a phone's top bar) shows the icon alone at 44px, with
 * the words as its accessible name; the card is identical.
 */
export function CloudStrip({
  report,
  hub = null,
  compact = false,
}: {
  report: CloudSurfaceReport | null;
  /** All workspaces: the hub's list, summarised. Used only when `report` is null. */
  hub?: HubCloudReport | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useBackToClose(open, () => setOpen(false));
  const summary = syncSummary(report) ?? (report === null ? hubSyncSummary(hub) : null);
  if (summary === null) return null;
  const tone = TONE[summary.tone];
  const Icon = report?.failure?.code === "offline" ? CloudOff : summary.tone === "on_track" && !hub ? RefreshCw : TONE_ICON[summary.tone];
  const style = {
    color: `var(--plain-${tone}-fg)`,
    backgroundColor: `var(--plain-${tone}-bg)`,
    borderColor: `var(--plain-${tone}-border)`,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-cloud-strip
          data-sync-tone={summary.tone}
          aria-label={`Sync: ${summary.pill}. Show sync details`}
          className={cn(
            "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border text-[12px] leading-none font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "size-11 border-transparent bg-transparent" : "h-7 px-2.5",
          )}
          style={compact ? { color: style.color } : style}
        >
          <Icon aria-hidden className={compact ? "size-5" : "size-3.5"} strokeWidth={2.25} />
          {compact ? null : <span className="whitespace-nowrap">{summary.pill}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-1.5rem))] space-y-3 rounded-xl p-4 max-md:[&_summary]:min-h-11 max-md:[&_[data-sync-settings]]:min-h-11"
        data-sync-card
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-[12px] font-medium text-muted-foreground">Sync</h2>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none font-medium"
            style={style}
          >
            <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
            {summary.pill}
          </span>
        </div>
        <p role="status" className="text-[14px] leading-relaxed text-pretty">
          {summary.headline}
        </p>
        <Facts facts={summary.facts} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {summary.details.length > 0 ? (
            <ShowDetails>
              <Facts facts={summary.details} />
            </ShowDetails>
          ) : null}
          <button
            type="button"
            data-sync-settings
            onClick={() => {
              setOpen(false);
              openSettings({ section: report ? "workspace-cloud" : "cloud" });
            }}
            className="inline-flex min-h-6 items-center rounded-md text-[12px] font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sync settings
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
