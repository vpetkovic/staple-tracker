/**
 * The pieces every pull request surface shares (pull-requests.ts decides what they say):
 *
 *   ChecksMark        how the head's checks stand, beside the state glyph: a crossed circle
 *                     for failing, a dashed one for pending, nothing for passing or unread.
 *   PullRequestTally  how many are in each state, failing checks first, in the state glyphs.
 *   PullRequestList   one line per pull request: glyph, title, checks, key, its tickets.
 *   PullRequestCard   the list as a hover card, with the way to all of them.
 *
 * A parent's row badge, its detail roll-up, its phone pill and its External links section
 * draw from these, and so do a leaf's, so the same pull request reads the same everywhere.
 */
import { CircleDashed, CircleX } from "lucide-react";
import { useOptionalSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { LinkGlyph } from "./parts";
import {
  TALLY_ORDER,
  byAttention,
  checksWords,
  entryTone,
  entryWords,
  otherTickets,
  segmentWords,
  shortKeys,
  tallyOf,
  tallyWords,
  type ChecksState,
  type EntryTicket,
  type PullRequestEntry,
  type PullRequestTally as Tally,
  type TallySegment,
} from "./pull-requests";

const FAILING = "var(--status-task-icon-blocked)";
const PENDING = "var(--status-task-icon-todo)";

/**
 * The checks on a pull request's head. Decorative: the control it sits in says the words
 * (`checksWords`). Passing draws nothing, so a healthy list stays quiet and a mark means look.
 */
export function ChecksMark({ checks, className }: { checks: ChecksState | null | undefined; className?: string }) {
  if (checks === "failing") return <CircleX aria-hidden data-checks="failing" className={cn("size-3 shrink-0", className)} style={{ color: FAILING }} />;
  if (checks === "pending") return <CircleDashed aria-hidden data-checks="pending" className={cn("size-3 shrink-0", className)} style={{ color: PENDING }} />;
  return null;
}

const SEGMENT_TONE = { open: "open", draft: "draft", merged: "merged", closed: "closed", unknown: "neutral" } as const;

function SegmentGlyph({ segment, className }: { segment: TallySegment; className?: string }) {
  if (segment === "failing") return <CircleX aria-hidden className={cn("size-3 shrink-0", className)} style={{ color: FAILING }} />;
  return <LinkGlyph kind="pull_request" tone={SEGMENT_TONE[segment]} className={cn("size-3", className)} />;
}

/**
 * Counts by state. Decorative as a whole: the control around it carries `tallyWords`.
 * `fold` draws the leading state's glyph and the total instead, with the failing mark kept,
 * for a row with no room for the breakdown.
 */
export function PullRequestTally({ tally, fold = false, className }: { tally: Tally; fold?: boolean; className?: string }) {
  const segments = TALLY_ORDER.filter((segment) => tally[segment] > 0);
  if (fold) {
    const lead = segments.find((segment) => segment !== "failing") ?? "unknown";
    return (
      <span aria-hidden data-pr-tally="folded" className={cn("inline-flex items-center gap-1 tabular-nums", className)}>
        <SegmentGlyph segment={lead} />
        <span>{tally.total}</span>
        {tally.failing > 0 ? <SegmentGlyph segment="failing" /> : null}
      </span>
    );
  }
  return (
    <span aria-hidden data-pr-tally="" className={cn("inline-flex items-center gap-2 tabular-nums", className)}>
      {segments.map((segment) => (
        <span key={segment} data-pr-segment={segment} title={segmentWords(segment, tally[segment])} className="inline-flex items-center gap-0.5">
          <SegmentGlyph segment={segment} />
          <span>{tally[segment]}</span>
        </span>
      ))}
    </span>
  );
}

/** A 44px target on a finger, around a control drawn smaller. */
const HIT = "relative pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";

/** The tickets a pull request is recorded on, each a button that opens that ticket. */
export function TicketButtons({ workspace, tickets, className }: { workspace: string; tickets: readonly EntryTicket[]; className?: string }) {
  const session = useOptionalSession();
  if (!tickets.length) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-label text-text-tertiary", className)} data-pr-tickets="">
      {tickets.map((ticket, index) => (
        <span key={ticket.id} className="inline-flex items-center">
          <button
            type="button"
            data-pr-ticket={ticket.identifier}
            title={ticket.title ? `${ticket.identifier} · ${ticket.title}` : ticket.identifier}
            aria-label={ticket.title ? `Open ${ticket.identifier}, ${ticket.title}` : `Open ${ticket.identifier}`}
            onClick={(event) => {
              event.stopPropagation();
              session?.open(workspace, ticket.identifier);
            }}
            className={cn("focus-ring rounded-sm whitespace-nowrap tabular-nums text-text-secondary hover:text-foreground hover:underline", HIT)}
          >
            {ticket.identifier}
          </button>
          {index < tickets.length - 1 ? <span aria-hidden>,</span> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * One line per pull request, the ones that need a person first. The title opens it at the
 * provider; the identifiers after it open its tickets. `shownId` is the ticket being looked
 * at, which is never named back to itself.
 */
export function PullRequestList({
  entries,
  workspace,
  shownId,
  className,
}: {
  entries: readonly PullRequestEntry[];
  workspace: string;
  shownId: string;
  className?: string;
}) {
  const keys = shortKeys(entries);
  return (
    <ul className={cn("m-0 list-none p-0", className)} data-pr-list="">
      {byAttention(entries).map((entry) => {
        const tickets = otherTickets(entry, shownId);
        return (
          <li key={entry.id} data-pr-row={entry.key} data-pr-state={entry.state} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-[var(--surface-hover)]">
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={entryWords(entry)}
              title={[entry.title ?? entry.key, entry.checks === "passing" ? null : checksWords(entry)].filter(Boolean).join(" · ")}
              className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm text-label text-foreground pointer-coarse:h-11"
            >
              <LinkGlyph kind="pull_request" tone={entryTone(entry)} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{entry.title || entry.key}</span>
              <ChecksMark checks={entry.checks} />
              <span className="shrink-0 text-text-tertiary tabular-nums">{keys.get(entry.id)}</span>
            </a>
            <TicketButtons workspace={workspace} tickets={tickets} />
          </li>
        );
      })}
    </ul>
  );
}

/** The list as a hover card: what the set is, each pull request, and the way to all of them. */
export function PullRequestCard({
  heading,
  entries,
  workspace,
  shownId,
  onShowAll,
}: {
  /** What the card lists, e.g. "8 in tasks inside". */
  heading: string;
  entries: readonly PullRequestEntry[];
  workspace: string;
  shownId: string;
  onShowAll: () => void;
}) {
  const tally = tallyOf(entries);
  return (
    <div className="flex flex-col" data-link-card="pull-requests">
      <p className="m-0 mb-1 flex min-w-0 items-center gap-2 text-label">
        <span className="min-w-0 truncate font-medium text-foreground">{heading}</span>
        <PullRequestTally tally={tally} className="ml-auto shrink-0 text-text-tertiary" />
        <span className="sr-only">{tallyWords(tally)}</span>
      </p>
      {/* Tall enough for eight lines; a longer set scrolls inside the card. */}
      <PullRequestList entries={entries} workspace={workspace} shownId={shownId} className="-mx-1.5 max-h-56 overflow-y-auto pointer-coarse:max-h-[19.25rem]" />
      <div className="-mx-3 mt-1 border-t" />
      <button
        type="button"
        className="focus-ring -mx-1.5 -mb-1 mt-1 flex h-7 items-center rounded-md px-1.5 text-left text-label text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground pointer-coarse:h-11"
        onClick={onShowAll}
      >
        Show in External links
      </button>
    </div>
  );
}
