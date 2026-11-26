/**
 * The pull-request slot — V5 (STA-97) §9, lit by the integrations link store.
 *
 * `/api/issues` attaches `pullRequests` from the ticket's linked pull requests (the ones
 * `staple integrations discover` finds for the ticket's branch, and any linked by hand),
 * the ones still moving first. A parent's row gets its whole subtree set, each naming the
 * tickets it is on. The badge has three shapes, and which one a row gets says what it is:
 *
 *   one pull request     its glyph and number; a click opens it at the provider.
 *   several of its own   the lead one with its number, then one glyph per further pull
 *                        request, so a replaced or stacked one is visible on the row.
 *   a parent's subtree   a tally by state (failing checks, open, draft, merged, closed). A
 *                        single number would name one child's pull request as if it were the
 *                        parent's, so a set that reaches into the children never leads with one.
 *
 * A badge that stands for several opens their list on hover, focus or tap (PullRequestCard):
 * every title, state and check, each ticket one click away. Failing or pending checks mark
 * the badge in all three shapes.
 *
 * ── THE GATE IS THE FEATURE ───────────────────────────────────────────────────────────
 *
 * `undefined` and `[]` produce the SAME outcome: the element is not in the DOM. Not
 * `visibility: hidden`, not `opacity: 0`, not a reserved 40px of nothing. An absent
 * integration must be indistinguishable from an integration with nothing to say, and
 * neither may cost a pixel of a row that has real data to show.
 *
 * SHAPE CARRIES THE STATE, colour only reinforces it: the glyphs are the integrations'
 * own (`LinkGlyph`, integrations/parts.tsx) — open, draft, merged and closed are four
 * different outlines in the same hues the detail's pull request chips use, so the row and
 * the detail say the same thing about the same pull request, and all four survive greyscale.
 */
import type { PullRequestRef } from "@/lib/types";
import { ROW_COUNT_BADGE, useShowExternalLinks } from "@/integrations/ExternalLinkBadges";
import { LinkHoverCard } from "@/integrations/LinkHoverCard";
import { LinkGlyph } from "@/integrations/parts";
import { ChecksMark, PullRequestCard, PullRequestTally } from "@/integrations/PullRequestParts";
import { checksWords, countWords, entryTone, isSubtreeSet, rowEntry, tallyOf, tallyWords, worstChecks } from "@/integrations/pull-requests";

const word = (state: PullRequestRef["state"]) => (state === "unknown" ? "state unknown" : state);

/** Glyphs drawn before the rest are counted: the lead one and three more. */
const MAX_GLYPHS = 4;

/** A 44px target on a finger, around a control drawn smaller. */
const HIT = "relative pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-3 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";

export function PrBadge({
  pullRequests,
  showNumber = true,
  counted = false,
  workspace = "",
  issueId = "",
  issueRef,
}: {
  pullRequests?: PullRequestRef[];
  /** `#123` beside the glyph, or a parent's breakdown by state — the first thing the row ladder drops (row-layout.ts). */
  showNumber?: boolean;
  /**
   * A phone held upright, where the ladder has dropped this badge and a leaf shows the counted
   * link badge instead: a parent's set is drawn in that badge's shape, a glyph and the total.
   */
  counted?: boolean;
  /** The row's ticket, for the list card: where "Show in External links" goes and which ticket is never named back. */
  workspace?: string;
  issueId?: string;
  issueRef?: string;
}) {
  const showAll = useShowExternalLinks(workspace, issueId, issueRef, "pull_request");
  const prs = pullRequests ?? [];
  if (prs.length === 0) return null; // no element, no space, no placeholder

  const pr = prs[0]!;
  const entries = prs.map((p) => rowEntry(p, issueRef));
  const subtree = isSubtreeSet(prs, issueRef);

  if (prs.length === 1 && !subtree) {
    const checks = entries[0]!.checks === "passing" ? null : checksWords(entries[0]!);
    return (
      <a
        className="staple-pr-badge"
        data-testid="pr-badge"
        data-state={pr.state}
        href={pr.url}
        target="_blank"
        rel="noreferrer noopener"
        // Without this the click opens the PR AND the detail drawer — the one interaction
        // bug this element would otherwise ship with.
        onClick={(event) => event.stopPropagation()}
        aria-label={`Pull request #${pr.number}, ${word(pr.state)}${checks ? `, ${checks}` : ""}`}
        title={[pr.title ? `#${pr.number} ${pr.title} (${word(pr.state)})` : `#${pr.number} (${word(pr.state)})`, checks].filter(Boolean).join(" · ")}
      >
        <LinkGlyph kind="pull_request" tone={entryTone(entries[0]!)} className="size-3" />
        {showNumber ? <span className="staple-pr-number">#{pr.number}</span> : null}
        <ChecksMark checks={entries[0]!.checks} />
      </a>
    );
  }

  const tally = tallyOf(entries);
  const shown = prs.slice(1, MAX_GLYPHS);
  const extra = prs.length - 1 - shown.length;
  return (
    <LinkHoverCard
      className={counted ? ROW_COUNT_BADGE : `staple-pr-badge ${HIT}`}
      data-testid="pr-badge"
      data-pr-state={pr.state}
      data-pr-set={subtree ? "subtree" : "own"}
      aria-label={tallyWords(tally)}
      cardLabel={countWords(prs.length)}
      align="end"
      card={(close) => (
        <PullRequestCard
          heading={countWords(prs.length)}
          entries={entries}
          workspace={workspace}
          shownId={issueRef ?? issueId}
          onShowAll={() => {
            close();
            showAll();
          }}
        />
      )}
    >
      {subtree ? (
        <PullRequestTally tally={tally} fold={counted || !showNumber} className={counted ? "[&_svg]:size-3.5" : undefined} />
      ) : (
        <>
          <LinkGlyph kind="pull_request" tone={entryTone(entries[0]!)} className="size-3" />
          {showNumber ? <span className="staple-pr-number">#{pr.number}</span> : null}
          {shown.map((other) => (
            <span key={other.url} className="staple-pr-also" data-state={other.state}>
              <LinkGlyph kind="pull_request" tone={other.state === "unknown" ? "neutral" : other.state} className="size-3" />
            </span>
          ))}
          {extra > 0 ? <span className="staple-pr-more">+{extra}</span> : null}
          <ChecksMark checks={worstChecks(entries)} className="ml-0.5" />
        </>
      )}
    </LinkHoverCard>
  );
}
