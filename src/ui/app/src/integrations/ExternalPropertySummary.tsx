/**
 * A task's linked issues or pull requests in its properties: one chip per link with the
 * shortest key that is still unambiguous, and a `+` to link another. Linked issues stop at four
 * and then "+N more"; pull requests are all listed, since the ticket's replaced and stacked
 * pull requests are what this row is for, and each carries its checks mark.
 *
 * A parent's pull requests row keeps the parent's own chips, exactly a leaf's, and adds one
 * roll-up for the pull requests of its descendants: how many, their tally by state, the list
 * on hover, focus or tap (PullRequestParts.tsx). One line whether the subtree has three or
 * thirty, so the properties under it never move.
 *
 * On the phone (`compact`) it is one counted pill per kind beside the other chips. A parent's
 * pull request pill counts the whole set, because External links, which it opens, lists it.
 */
import { useRef } from "react";
import { Plus } from "lucide-react";
import type { IssueDetail } from "@/lib/types";
import { openLinkExternal } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { openDetailTab } from "@/detail/tabs/registry";
import { requestExternalSection } from "./external-section";
import { leadingTone, linkTone, shortKey, stateLabel } from "./link-state";
import { countLabel, LinkHoverCard, SingleLinkCard } from "./LinkHoverCard";
import { ItemGlyph, LinkGlyph } from "./parts";
import { ChecksMark, PullRequestCard, PullRequestTally } from "./PullRequestParts";
import { checksWords, descendantEntries, entryTone, linkEntry, otherTickets, subtreeEntries, tallyOf, tallyWords, type PullRequestEntry } from "./pull-requests";

const MAX_CHIPS = 4;

/** The phone summary's chip shape, matching the status and priority chips beside it. */
const PILL =
  "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover pointer-coarse:h-11";

/** The phone summary's one way to link: the dialog filters by kind itself, so two buttons would say the same thing twice. */
export function ExternalLinkAdd({ detail }: { detail: IssueDetail }) {
  return (
    <button
      type="button"
      data-link-add=""
      aria-label="Link an issue or pull request"
      className={cn(PILL, "border-dashed bg-transparent font-normal text-muted-foreground")}
      onClick={() => openLinkExternal({ workspace: detail.workspace, ref: detail.issue.id })}
    >
      <Plus aria-hidden className="size-3.5" />
      Link
    </button>
  );
}

/** A 44px target on a finger, around a control drawn smaller (so it opts out of the base layer's 44px floor). */
const HIT = "relative pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";

const CHIP =
  "focus-ring inline-flex h-6 min-w-0 items-center gap-1 rounded-md border px-1.5 text-label tabular-nums text-foreground hover:bg-[var(--surface-hover)] data-[state=open]:bg-[var(--surface-selected)]";

/**
 * Every pull request a ticket's detail stands for: a leaf's own links, or a parent's whole
 * subtree set (its own among them, flagged `own`).
 */
export function detailPullRequests(detail: IssueDetail): PullRequestEntry[] {
  const subtree = subtreeEntries(detail);
  if (subtree.length) return subtree;
  return (detail.externalLinks ?? []).filter((link) => link.resource.ref.kind === "pull_request").map(linkEntry);
}

const showAll = (kind: "issue" | "pull_request") => {
  requestExternalSection(kind);
  openDetailTab("external-links");
};

export function ExternalPropertySummary({
  detail,
  kind,
  compact = false,
  refresh = () => {},
}: {
  detail: IssueDetail;
  kind: "issue" | "pull_request";
  compact?: boolean;
  refresh?: () => void;
}) {
  const links = (detail.externalLinks ?? []).filter((l) => l.resource.ref.kind === kind);
  const peers = links.map((l) => l.resource);
  const addLabel = kind === "issue" ? "Link issue" : "Link pull request";
  const addRef = useRef<HTMLButtonElement>(null);
  const add = () => openLinkExternal({ workspace: detail.workspace, ref: detail.issue.id, kind });
  // A parent's: its whole set, and the part of it only its descendants carry.
  const subtree = kind === "pull_request" ? subtreeEntries(detail) : [];
  const descendants = descendantEntries(subtree);

  if (compact) {
    if (kind === "pull_request") {
      const entries = detailPullRequests(detail);
      if (!entries.length) return null;
      const tally = tallyOf(entries);
      return (
        <button type="button" className={PILL} data-link-pill={kind} aria-label={`${tallyWords(tally)}; show External links`} onClick={() => showAll(kind)}>
          {/* Own links keep their provider's reading of the state; a parent's descendants add theirs. */}
          <LinkGlyph kind={kind} tone={leadingTone([...peers.map(linkTone), ...descendants.map(entryTone)])} className="size-3.5" />
          {`${entries.length} pull request${entries.length === 1 ? "" : "s"}`}
          {tally.failing > 0 ? <ChecksMark checks="failing" className="size-3.5" /> : null}
        </button>
      );
    }
    if (!links.length) return null;
    return (
      <button type="button" className={PILL} data-link-pill={kind} aria-label={`${countLabel(links.length, kind)}; show External links`} onClick={() => showAll(kind)}>
        <LinkGlyph kind={kind} tone={leadingTone(peers.map(linkTone))} className="size-3.5" />
        {`${links.length} issue${links.length === 1 ? "" : "s"}`}
      </button>
    );
  }

  const shown = kind === "pull_request" ? links : links.slice(0, MAX_CHIPS);
  const more = links.length - shown.length;
  const inSubtree = new Map(subtree.map((entry) => [entry.id, entry]));
  const rollup = descendants.length ? <SubtreeRollup detail={detail} entries={descendants} /> : null;
  return (
    <span className="flex min-w-0 max-w-full flex-col items-start gap-1.5 py-1 pointer-coarse:gap-3 pointer-coarse:py-2" data-link-chips={kind}>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 pointer-coarse:gap-y-5">
        <span className="sr-only">{countLabel(links.length, kind)}</span>
        {links.length === 0 && !rollup ? <span className="text-body text-text-tertiary">None</span> : null}
        {shown.map((link) => {
          const item = link.resource;
          const state = stateLabel(item);
          const entry = kind === "pull_request" ? linkEntry(link) : null;
          const checks = entry && entry.checks !== "passing" ? checksWords(entry) : null;
          return (
            <LinkHoverCard
              key={link.id}
              data-link-chip={item.id}
              aria-label={[item.key, item.title, state, checks].filter(Boolean).join(", ")}
              cardLabel={item.key}
              className={cn(CHIP, HIT)}
              card={(close) => (
                <SingleLinkCard
                  link={link}
                  workspace={detail.workspace}
                  issueId={detail.issue.id}
                  also={inSubtree.has(item.id) ? otherTickets(inSubtree.get(item.id)!, detail.issue.id) : []}
                  refresh={refresh}
                  onUnlinked={() => addRef.current?.focus()}
                  onShowAll={() => {
                    close();
                    showAll(kind);
                  }}
                />
              )}
            >
              <ItemGlyph item={item} className="size-3.5" />
              <span data-link-key="">{shortKey(item, peers)}</span>
              <ChecksMark checks={entry?.checks} />
            </LinkHoverCard>
          );
        })}
        {/* With none of its own, a parent's roll-up takes the chips' place on the one line. */}
        {links.length === 0 ? rollup : null}
        {more > 0 ? (
          <button
            type="button"
            className={cn("focus-ring inline-flex h-6 items-center rounded-md px-1 text-label text-muted-foreground hover:text-foreground hover:underline", HIT)}
            onClick={() => showAll(kind)}
          >
            +{more} more
          </button>
        ) : null}
        <button
          type="button"
          className={cn(
            "focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground",
            HIT,
            "pointer-coarse:before:-inset-x-2.5",
          )}
          ref={addRef}
          aria-label={addLabel}
          onClick={add}
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </span>
      {links.length > 0 ? rollup : null}
    </span>
  );
}

/** "8 in tasks inside" and their tally: a parent's descendants' pull requests as one control. */
function SubtreeRollup({ detail, entries }: { detail: IssueDetail; entries: PullRequestEntry[] }) {
  const tally = tallyOf(entries);
  const heading = `${entries.length} in tasks inside`;
  return (
    <LinkHoverCard
      data-subtree-rollup=""
      aria-label={`In tasks inside: ${tallyWords(tally)}`}
      cardLabel={`Pull requests in tasks inside`}
      className={cn(CHIP, HIT, "max-w-full gap-2 text-text-secondary")}
      card={(close) => (
        <PullRequestCard
          heading={heading}
          entries={entries}
          workspace={detail.workspace}
          shownId={detail.issue.id}
          onShowAll={() => {
            close();
            showAll("pull_request");
          }}
        />
      )}
    >
      <span className="truncate">{heading}</span>
      <PullRequestTally tally={tally} className="shrink-0" />
    </LinkHoverCard>
  );
}
