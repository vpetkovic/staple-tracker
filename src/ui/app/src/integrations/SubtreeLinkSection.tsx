/**
 * A parent's External links tab, after its own links: the pull requests recorded on the
 * tickets inside it. One row each in the tab's list frame, the ones that need a person
 * first (pull-requests.ts), with the tickets it is on as buttons that open them.
 *
 * Read-only here: a link is unlinked, restacked or shared from the ticket that owns it,
 * which is one click away. The row itself opens the pull request at the provider.
 *
 * Layout follows the tab's container like the rows above it (LinkList.tsx): below 520px a
 * row takes two lines.
 */
import { ExternalLink as ExternalLinkIcon } from "lucide-react";
import { ItemGlyph, LinkStatePill } from "./parts";
import { ChecksMark, PullRequestTally, TicketButtons } from "./PullRequestParts";
import { byAttention, checksWords, countWords, entryItem, entryWords, otherTickets, shortKeys, tallyOf, tallyWords, type PullRequestEntry } from "./pull-requests";

/** Identifiers drawn on a row before the rest are counted. */
const MAX_TICKETS = 3;

export function SubtreeLinkSection({ entries, workspace, shownId }: { entries: readonly PullRequestEntry[]; workspace: string; shownId: string }) {
  if (!entries.length) return null;
  const tally = tallyOf(entries);
  const keys = shortKeys(entries);
  return (
    <section className="min-w-0 space-y-1" data-subtree-links="" aria-label={`In tasks inside: ${tallyWords(tally)}`}>
      <h3 className="flex h-7 min-w-0 items-center gap-2 text-label">
        <span className="min-w-0 truncate font-medium text-foreground">In tasks inside</span>
        <PullRequestTally tally={tally} className="shrink-0 text-text-tertiary" />
        <span className="ml-auto shrink-0 pl-2 font-normal text-text-tertiary">{countWords(entries.length)}</span>
      </h3>
      <ul className="overflow-hidden rounded-[10px] border bg-surface-raised">
        {byAttention(entries).map((entry) => {
          const item = entryItem(entry);
          const tickets = otherTickets(entry, shownId);
          const shown = tickets.slice(0, MAX_TICKETS);
          const checks = entry.checks === "passing" ? null : checksWords(entry);
          return (
            <li key={entry.id} data-subtree-link={entry.key} data-pr-state={entry.state} className="group/row relative flex min-w-0 items-stretch border-t first:border-t-0 hover:bg-surface-hover">
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${entryWords(entry)}`}
                title={[entry.title ?? entry.key, checks].filter(Boolean).join(" · ")}
                className="focus-ring-inset flex min-w-0 flex-1 flex-col justify-center py-2 pl-2 text-left @min-[520px]:h-10 @min-[520px]:py-0 @min-[520px]:pointer-coarse:h-11"
              >
                <span className="flex h-5 min-w-0 items-center">
                  {/* The column the rows above give their disclosure chevron, so glyphs line up down the tab. */}
                  <span aria-hidden className="w-[22px] shrink-0" />
                  <ItemGlyph item={item} />
                  <span className="ml-2 min-w-0 truncate text-body">{entry.title || entry.key}</span>
                  <ChecksMark checks={entry.checks} className="ml-1.5 size-3.5" />
                  <span className="min-w-2 flex-1" />
                  <span className="hidden max-w-32 shrink-0 truncate pl-2 text-label text-text-tertiary tabular-nums @min-[520px]:inline">{keys.get(entry.id)}</span>
                  <span className="hidden w-[88px] shrink-0 pl-3 @min-[520px]:flex">
                    <LinkStatePill item={item} className="max-w-full overflow-hidden text-ellipsis" />
                  </span>
                </span>
                <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 pl-[46px] text-label text-text-tertiary tabular-nums @min-[520px]:hidden">
                  <span className="min-w-0 truncate">{keys.get(entry.id)}</span>
                  {entry.state !== "unknown" ? (
                    <>
                      <span aria-hidden>·</span>
                      <LinkStatePill item={item} className="h-auto border-0! bg-transparent! px-0 text-label font-normal" />
                    </>
                  ) : null}
                </span>
              </a>
              <span className="flex shrink-0 items-center justify-end gap-1 pr-2 pl-2 @min-[520px]:w-[144px] @max-[519px]:items-end @max-[519px]:pb-2">
                <TicketButtons workspace={workspace} tickets={shown} />
                {tickets.length > shown.length ? (
                  <span className="text-label text-text-tertiary" title={tickets.slice(MAX_TICKETS).map((ticket) => ticket.identifier).join(", ")}>
                    +{tickets.length - shown.length}
                  </span>
                ) : null}
                <ExternalLinkIcon aria-hidden className="ml-1 hidden size-3.5 shrink-0 text-text-tertiary opacity-0 group-hover/row:opacity-100 @min-[520px]:pointer-fine:block" />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
