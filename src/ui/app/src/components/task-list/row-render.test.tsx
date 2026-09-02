/**
 * V5 (STA-97) — what the row actually puts in the DOM.
 *
 * Rendered to a string with `react-dom/server`. That is enough for every claim below,
 * because all of them are about which elements EXIST and what their accessible names say —
 * not about layout, which is CSS and is checked in the screenshot evidence instead.
 *
 * The four properties worth a test, in order of how quietly they would break:
 *
 *   1. The PR badge renders from mocked data and is ABSENT otherwise. There is no git
 *      integration, so this test is the only thing standing between the slot and being a
 *      well-commented guess about a payload nobody has ever sent (§9.2).
 *   2. The working pill appears for a live claim and ONLY a live claim. A pill that breathes
 *      over a claim whose holder died four hours ago is worse than no pill: it is a lie at
 *      60fps, and the takeover buttons would be offering to steal from a ghost.
 *   3. The row is not a `<button>`. It contains a checkbox, a chevron and possibly an
 *      anchor; nesting those inside a button is invalid HTML and Safari genuinely treats
 *      the hit areas differently.
 *   4. Label pills cap at two plus an overflow whose tooltip names what it hid.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { PullRequestRef } from "@/lib/types";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import { buildGroups } from "@/views/tree/tree-model";
import { PrioritySignal } from "./PrioritySignal";
import { StatusIcon } from "./StatusIcon";
import { TaskRowLine } from "./TaskRowLine";
import { resolveTaskListConfig } from "./config";
import { claim, row } from "./fixtures";
import type { Issue, ClaimActivity } from "@/lib/types";

const NOW = new Date("2026-09-02T12:00:00.000Z");

/** Render one row through the real model, so placement and the row agree in the test too. */
function renderRow(
  over: Partial<Issue> = {},
  activity: ClaimActivity | null = null,
  pullRequests?: PullRequestRef[],
): string {
  const source = row(over, activity);
  const built = buildGroups([{ ...source, pullRequests }], {
    isExpanded: () => true,
    showResolved: true,
  })[0]!.rows[0]!;

  return renderToStaticMarkup(
    <TaskRowLine
      row={built}
      config={resolveTaskListConfig("tree", { labelMax: 2 })}
      semantics="grid"
      isExpanded
      isFocused
      now={NOW}
      onOpen={() => {}}
      onOpenParent={() => {}}
      onToggleExpand={() => {}}
      onToggleSelect={() => {}}
      onFocus={() => {}}
      onKeyDown={() => {}}
      registerRef={() => {}}
    />,
  );
}

const html = (node: ReactElement) => renderToStaticMarkup(node);

/** The same row, plus the optional trailing caption (STA-118). */
function renderCaptioned(caption?: string, over: Partial<Issue> = {}): string {
  const built = buildGroups([row(over, null)], {
    isExpanded: () => true,
    showResolved: true,
  })[0]!.rows[0]!;

  return renderToStaticMarkup(
    <TaskRowLine
      row={built}
      config={resolveTaskListConfig("tree", { labelMax: 2 })}
      semantics="grid"
      caption={caption}
      isExpanded
      isFocused
      now={NOW}
      onOpen={() => {}}
      onOpenParent={() => {}}
      onToggleExpand={() => {}}
      onToggleSelect={() => {}}
      onFocus={() => {}}
      onKeyDown={() => {}}
      registerRef={() => {}}
    />,
  );
}

describe("PR badge slot", () => {
  it("puts NOTHING in the DOM when there is no integration — not a hidden placeholder", () => {
    const absent = renderRow();
    const empty = renderRow({}, null, []);

    for (const markup of [absent, empty]) {
      expect(markup).not.toContain('data-testid="pr-badge"');
      // The failure mode this guards against is a reserved, invisible box. An absent
      // integration must be indistinguishable from one with nothing to say.
      expect(markup).not.toContain("staple-pr-badge");
    }
  });

  it("renders from a mocked PullRequestRef[] — the proof the slot works before the data does", () => {
    const markup = renderRow({}, null, [
      { provider: "github", number: 1423, url: "https://example.test/pr/1423", state: "open" },
    ]);

    expect(markup).toContain('data-testid="pr-badge"');
    expect(markup).toContain("#1423");
    expect(markup).toContain('data-state="open"');
    expect(markup).toContain('href="https://example.test/pr/1423"');
    // A link that opens a tab must not also hand the opener a window reference.
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it("shows the newest and counts the rest", () => {
    const prs: PullRequestRef[] = [
      { provider: "github", number: 9, url: "https://example.test/9", state: "merged" },
      { provider: "github", number: 8, url: "https://example.test/8", state: "closed" },
      { provider: "github", number: 7, url: "https://example.test/7", state: "draft" },
    ];
    const markup = renderRow({}, null, prs);

    expect(markup).toContain("#9");
    expect(markup).toContain("+2");
    expect(markup).not.toContain("#8");
  });
});

describe("working pill liveness", () => {
  it("breathes only for a claim that is not stale", () => {
    const markup = renderRow({ status: "in_progress", checkoutAgent: "opus-x" }, claim({ idleSeconds: 30 }));

    expect(markup).toContain('data-testid="working-pill"');
    expect(markup).toContain("staple-working-dot");
    expect(markup).toContain("Working…");
    expect(markup).toContain("opus-x is working");
  });

  it("hands a stale claim to the existing badge, and never shows both", () => {
    const markup = renderRow(
      { status: "in_progress", checkoutAgent: "opus-x" },
      claim({ idleSeconds: STALE_CLAIM_SECONDS }),
    );

    expect(markup).toContain("data-stale-claim");
    // Printing the holder twice on a 36px row turns a signal into noise.
    expect(markup).not.toContain('data-testid="working-pill"');
    expect(markup).not.toContain("staple-working-dot");
  });

  it("shows a STATIC held pill when there is a holder but no liveness reading", () => {
    // `checkoutAgent` says a claim exists, not that anyone is awake. Only the endpoint
    // that carries `claim` has the idle number, so nothing here may animate.
    const markup = renderRow({ checkoutAgent: "opus-x" }, null);

    expect(markup).toContain('data-testid="held-pill"');
    expect(markup).not.toContain("staple-working-dot");
  });

  it("shows nothing at all for a free issue", () => {
    const markup = renderRow();
    expect(markup).not.toContain("working-pill");
    expect(markup).not.toContain("held-pill");
  });
});

describe("row semantics", () => {
  it("is a treegrid row, not a <button>", () => {
    const markup = renderRow({ identifier: "STA-97" });

    expect(markup).toContain('role="row"');
    expect(markup).toContain('role="gridcell"');
    expect(markup).toContain('aria-level="1"');
    // There ARE buttons on the row — the chevron, the breadcrumb, the actions dot — but
    // the row itself must not be one, or those become invalid nested interactives.
    expect(markup.startsWith("<button")).toBe(false);
    expect(markup.startsWith("<div")).toBe(true);
  });

  it("reserves the disclosure, priority and actions columns on every row", () => {
    // A leaf row with no children still holds the disclosure width, or titles stop aligning.
    const leaf = renderRow();
    expect(leaf).toContain("staple-row-chevron-spacer");
    expect(leaf).toContain("staple-row-priority");
    expect(leaf).toContain("staple-row-actions");
    // The SELECT column is deliberately absent since R2 (STA-101) — it is switched off at
    // `SHOW_ROW_CHECKBOXES`, and a column that is off must occupy no width at all. That is
    // asserted, along with the one-line-to-restore wiring, in task-list.test.tsx.
    expect(leaf).not.toContain("staple-row-check");
  });

  it("names an unassigned row calmly — no placeholder avatar", () => {
    expect(renderRow()).not.toContain("staple-row-assignee");
    expect(renderRow({ assignee: "VP" })).toContain("staple-row-assignee");
  });

  it("gives a human assignee a circle and an agent holder a rounded square", () => {
    const markup = renderRow(
      { assignee: "VP", status: "in_progress", checkoutAgent: "opus-x" },
      claim({ heldBy: "opus-x", idleSeconds: 5 }),
    );
    expect(markup).toContain('data-kind="human"');
    expect(markup).toContain('data-kind="agent"');
    expect(markup).toContain(">VP<");
    expect(markup).toContain(">OX<");
  });
});

/**
 * STA-118. The defect these four guard against is not "the caption is missing" — it is the
 * caption coming back as a SECOND ROW, which is how V5 shipped it: an extra `role="row"`
 * under every waiting item, its own hairline, and a block 53px tall in a list whose rows are
 * 36px. Every assertion here is really about the row staying ONE row.
 *
 * Rendered size is deliberately not asserted — there is no DOM here and no layout. That the
 * Waiting rows and the Up next rows measure the same, and that the section-header glyphs
 * match the status-header glyphs, is checked where it is actually observable: the screenshot
 * and `getBoundingClientRect` evidence on the ticket.
 */
describe("trailing caption", () => {
  it("adds NO element at all when there is no caption", () => {
    const markup = renderCaptioned();
    expect(markup).not.toContain("staple-row-caption");
    expect(markup).not.toContain('data-testid="row-caption"');
  });

  it("never emits the second row it replaced", () => {
    const markup = renderCaptioned("blocked by STA-61");
    // The V5 classes, by name: if either returns, the two-row fold has returned with it.
    expect(markup).not.toContain("staple-waiting-note");
    expect(markup).not.toContain("staple-waiting-cell");
    // One row, one cell — the caption must not have smuggled in a second of either.
    expect(markup.match(/role="row"/g)).toHaveLength(1);
    expect(markup.match(/role="gridcell"/g)).toHaveLength(1);
  });

  it("sits inside the title cell, ahead of the meta cluster", () => {
    const markup = renderCaptioned("waiting on VP: decide the schema");
    const titleCell = markup.indexOf("staple-row-title-cell");
    const caption = markup.indexOf("staple-row-caption");
    const meta = markup.indexOf("staple-row-meta");

    // Ordering IS the containment claim in a flat string, and it is the claim that matters:
    // inside the title's `minmax(0, 1fr)` track the caption is clipped by the track, so it
    // cannot reach the date, the avatar or the `⋯` at any window width.
    expect(titleCell).toBeGreaterThan(-1);
    expect(caption).toBeGreaterThan(titleCell);
    expect(meta).toBeGreaterThan(caption);
  });

  it("shows the text and keeps the untruncated version in title", () => {
    const long =
      "waiting on VP: create the Cloudflare zone/DNS records for the staple site domain and confirm the domain name";
    const markup = renderCaptioned(long);

    expect(markup).toContain(long);
    // The ellipsis is CSS; `title` is what pays for it, exactly as the row title does.
    expect(markup).toContain(`title="${long}"`);
  });
});

describe("labels", () => {
  it("caps at two and puts the rest behind a +N whose tooltip names them", () => {
    const markup = renderRow({ labels: ["bug", "wave-2", "infra", "docs"] });

    expect(markup.match(/data-testid="label-pill"/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="label-overflow"');
    expect(markup).toContain("+2");
    expect(markup).toContain('title="infra, docs"');
  });

  it("renders nothing for an unlabelled issue", () => {
    expect(renderRow()).not.toContain("staple-label-cluster");
  });
});

describe("priority glyph", () => {
  it("separates urgent from high by SHAPE, not only by hue", () => {
    const urgent = html(<PrioritySignal priority="critical" />);
    const high = html(<PrioritySignal priority="high" />);

    expect(urgent).toContain("Priority: Urgent"); // the wire says `critical`
    expect(high).toContain("Priority: High");
    // Urgent is one 12×12 rounded square with a bar punched out of it; high is three
    // ascending bars. Two different silhouettes, so the pair survives greyscale.
    expect(urgent).toContain('width="12" height="12" rx="3"');
    expect(urgent.match(/<rect/g)).toHaveLength(2);
    expect(high).not.toContain('rx="3"');
    expect(high.match(/<rect/g)).toHaveLength(3);
    // And the bars themselves must all be lit for `high` — a full stack, full contrast.
    expect(high.match(/var\(--foreground\)/g)).toHaveLength(3);
  });

  it("renders dashes for a null priority, and never treats medium as unset", () => {
    const none = html(<PrioritySignal priority={null} />);
    const medium = html(<PrioritySignal priority="medium" />);

    expect(none).toContain("Priority: No priority");
    expect(none).toContain("var(--priority-track)");
    expect(medium).toContain("Priority: Medium");
    // Two of three bars lit: medium is the most common priority in the database and
    // rendering it as blank would delete the signal this column exists for.
    expect(medium.match(/var\(--muted-foreground\)/g)).toHaveLength(2);
  });

  it("uses --priority-critical for urgent and NEVER --priority-high for high", () => {
    expect(html(<PrioritySignal priority="critical" />)).toContain("var(--priority-critical)");
    expect(html(<PrioritySignal priority="high" />)).not.toContain("var(--priority-high)");
    expect(html(<PrioritySignal priority="high" />)).toContain("var(--foreground)");
  });
});

describe("status icons", () => {
  const STATUSES = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
  ] as const;

  it("draws all seven, each with its own accessible name and its own token", () => {
    for (const status of STATUSES) {
      const markup = html(<StatusIcon status={status} />);
      expect(markup).toContain(`var(--status-task-icon-${status})`);
      expect(markup).toContain('role="img"');
      expect(markup).toContain("Status: ");
    }
  });

  it("makes every glyph structurally different, so none depends on colour alone", () => {
    // Strip the hue and the label; whatever is left is pure shape. Seven statuses must
    // yield seven distinct shapes — this is the WCAG 1.4.1 requirement as an assertion.
    const shapes = STATUSES.map((status) =>
      html(<StatusIcon status={status} />)
        .replace(new RegExp(`var\\(--status-task-icon-${status}\\)`, "g"), "HUE")
        .replace(/aria-label="[^"]*"/, "")
        .replace(/<title>[^<]*<\/title>/, ""),
    );
    expect(new Set(shapes).size).toBe(7);
  });
});
