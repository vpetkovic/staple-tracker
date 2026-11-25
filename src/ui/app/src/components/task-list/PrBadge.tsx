/**
 * The pull-request slot — V5 (STA-97) §9, lit by the integrations link store.
 *
 * `/api/issues` attaches `pullRequests` from the ticket's linked pull requests (the ones
 * `staple integrations discover` finds for the ticket's branch, and any linked by hand),
 * the ones still moving first. The badge draws EVERY one of them: the lead one with its
 * number, then one glyph per further pull request, so a replaced or stacked pull request
 * is visible on the row without opening it. Past four glyphs it counts the rest.
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
import { LinkGlyph } from "@/integrations/parts";

/** Glyphs drawn before the rest are counted: the lead one and three more. */
const MAX_GLYPHS = 4;

export function PrBadge({
  pullRequests,
  showNumber = true,
}: {
  pullRequests?: PullRequestRef[];
  /** `#123` beside the glyph — the first thing the row ladder drops (row-layout.ts). */
  showNumber?: boolean;
}) {
  const prs = pullRequests ?? [];
  if (prs.length === 0) return null; // no element, no space, no placeholder

  const pr = prs[0]!;
  const shown = prs.slice(1, MAX_GLYPHS);
  const extra = prs.length - 1 - shown.length;
  const names = prs.map((p) => `#${p.number} ${p.state}`).join(", ");

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
      aria-label={prs.length === 1 ? `Pull request #${pr.number}, ${pr.state}` : `${prs.length} pull requests: ${names}`}
      title={prs.map((p) => (p.title ? `#${p.number} ${p.title} (${p.state})` : `#${p.number} (${p.state})`)).join("\n")}
    >
      <LinkGlyph kind="pull_request" tone={pr.state} className="size-3" />
      {showNumber ? <span className="staple-pr-number">#{pr.number}</span> : null}
      {shown.map((other) => (
        <span key={other.url} className="staple-pr-also" data-state={other.state}>
          <LinkGlyph kind="pull_request" tone={other.state} className="size-3" />
        </span>
      ))}
      {extra > 0 ? <span className="staple-pr-more">+{extra}</span> : null}
    </a>
  );
}
