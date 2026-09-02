/**
 * The pull-request slot — V5 (STA-97) §9. A contract, and nothing visible.
 *
 * THERE IS NO GIT INTEGRATION. No field, no endpoint, no column. This file ships the
 * component and `lib/types.ts` ships the shape, so that turning the badge on later is a
 * SERVER-ONLY change: the day `/api/issues` starts attaching `pullRequests`, this lights up
 * and no component is touched.
 *
 * ── THE GATE IS THE FEATURE ───────────────────────────────────────────────────────────
 *
 * `undefined` and `[]` produce the SAME outcome: the element is not in the DOM. Not
 * `visibility: hidden`, not `opacity: 0`, not a reserved 40px of nothing. An absent
 * integration must be indistinguishable from an integration with nothing to say, and
 * neither may cost a pixel of a row that has real data to show. Every other right-hand
 * element on this row follows the same rule; this one is just the one most likely to be
 * "helpfully" given a placeholder by someone who wants to see where it will go.
 *
 * `row-render.test.tsx` renders a row with a mocked `PullRequestRef[]` and asserts the
 * badge appears. That test is the whole reason for building the slot before the data
 * exists — without it, this file is an untested guess about a payload nobody has sent.
 *
 * SHAPE CARRIES THE STATE, colour only reinforces it: branch / pull-request / merge /
 * closed are four different outlines, so all four survive greyscale.
 */
import type { PullRequestRef } from "@/lib/types";

const STATE_HUE: Record<PullRequestRef["state"], string> = {
  draft: "var(--text-tertiary)",
  open: "var(--label-hue-3)",
  merged: "var(--label-hue-6)",
  closed: "var(--label-hue-1)",
};

function PrGlyph({ state }: { state: PullRequestRef["state"] }) {
  const stroke = STATE_HUE[state];
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {/* Every state shares the two studs of a git glyph; the linkage between them is what
          differs, which is what makes the four readable without their colours. */}
      <circle cx="4" cy="3.5" r="1.8" {...common} />
      {state === "draft" ? (
        <>
          <circle cx="12" cy="3.5" r="1.8" {...common} />
          <path d="M4 5.3 L4 12.5" {...common} />
          <circle cx="4" cy="14" r="1.5" {...common} strokeDasharray="1.6 1.4" />
        </>
      ) : state === "merged" ? (
        <>
          <path d="M4 5.3 L4 12.5" {...common} />
          <circle cx="4" cy="14" r="1.5" {...common} />
          <path d="M5.6 4.6 A6 6 0 0 0 11 9.4" {...common} />
          <circle cx="12" cy="10.5" r="1.8" {...common} />
        </>
      ) : state === "closed" ? (
        <>
          <path d="M4 5.3 L4 12.5" {...common} />
          <circle cx="4" cy="14" r="1.5" {...common} />
          {/* A cross where the branch would have rejoined: the change never landed. */}
          <path d="M10 2.4 L13.6 6 M13.6 2.4 L10 6" {...common} />
        </>
      ) : (
        <>
          <path d="M4 5.3 L4 12.5" {...common} />
          <circle cx="4" cy="14" r="1.5" {...common} />
          <circle cx="12" cy="3.5" r="1.8" {...common} />
          <path d="M12 5.3 L12 12.5" {...common} />
          <path d="M9.6 10.4 L12 12.8 L14.4 10.4" {...common} />
        </>
      )}
    </svg>
  );
}

export function PrBadge({ pullRequests }: { pullRequests?: PullRequestRef[] }) {
  const prs = pullRequests ?? [];
  if (prs.length === 0) return null; // no element, no space, no placeholder

  const pr = prs[0]!;
  const extra = prs.length - 1;

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
      aria-label={`Pull request #${pr.number}, ${pr.state}${extra > 0 ? `, and ${extra} more` : ""}`}
      title={pr.title ? `#${pr.number} ${pr.title} (${pr.state})` : `#${pr.number} (${pr.state})`}
    >
      <PrGlyph state={pr.state} />
      <span className="staple-pr-number">#{pr.number}</span>
      {extra > 0 ? <span className="staple-pr-more">+{extra}</span> : null}
    </a>
  );
}
