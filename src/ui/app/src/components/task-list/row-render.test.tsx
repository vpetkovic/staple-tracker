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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { PullRequestRef } from "@/lib/types";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import { buildGroups, flattenFlat } from "@/views/tree/tree-model";
import { PrioritySignal } from "./PrioritySignal";
import { StatusIcon } from "./StatusIcon";
import { TaskRowLine } from "./TaskRowLine";
import { resolveTaskListConfig } from "./config";
import { flatRow } from "./model";
import { claim, row, worklog } from "./fixtures";
import type { Issue, ClaimActivity, WorklogSummary, IssueDeps, QueueView } from "@/lib/types";
import { ROW_CUE_STATES } from "@/lib/types";
import { PickupCue } from "./RowCues";
import {
  attachRowCues,
  buildRowCueIndex,
  MILESTONE_CUE_GLYPH,
  ROW_CUE_PRESENTATION,
} from "./row-cues";

const NOW = new Date("2026-09-02T12:00:00.000Z");

/** Render one row through the real model, so placement and the row agree in the test too. */
function renderRow(
  over: Partial<Issue> = {},
  activity: ClaimActivity | null = null,
  pullRequests?: PullRequestRef[],
  worklogSummary?: WorklogSummary | null,
): string {
  const source = row(over, activity, worklogSummary);
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

/** A row carrying O6's dependency edges, through whichever preset is asked for. */
function renderDeps(
  deps: IssueDeps | undefined,
  preset: "tree" | "panel" | "popup" = "tree",
): string {
  return renderToStaticMarkup(
    <TaskRowLine
      row={flatRow({ ...row(), deps })}
      config={resolveTaskListConfig(preset)}
      semantics="grid"
      now={NOW}
      onOpen={() => {}}
    />,
  );
}

/** The same row through a NARROW preset — the two containers O5's glyph exists for. */
function renderPreset(preset: "panel" | "popup", over: Partial<Issue> = {}): string {
  const built = flatRow(row(over, null));

  return renderToStaticMarkup(
    <TaskRowLine
      row={built}
      config={resolveTaskListConfig(preset)}
      semantics="list"
      now={NOW}
      onOpen={() => {}}
      onOpenParent={() => {}}
      registerRef={() => {}}
    />,
  );
}

/**
 * A real parent and its real child, built through `buildGroups` so the placement pass — not
 * the test — decides which is which.
 */
function renderFamily(): { parent: string; child: string } {
  const parent = row({ id: "id-p", identifier: "STA-10" });
  const child = row({ id: "id-c", identifier: "STA-11", parentId: "id-p" });
  const rows = buildGroups([parent, child], {
    isExpanded: () => true,
    showResolved: true,
  })[0]!.rows;

  const draw = (built: (typeof rows)[number]) =>
    renderToStaticMarkup(
      <TaskRowLine
        row={built}
        config={resolveTaskListConfig("tree", { labelMax: 2 })}
        semantics="grid"
        isExpanded
        now={NOW}
        onOpen={() => {}}
        onOpenParent={() => {}}
        onToggleExpand={() => {}}
        registerRef={() => {}}
      />,
    );

  return { parent: draw(rows[0]!), child: draw(rows[1]!) };
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

/**
 * W4 (STA-116). The cue's own states are exercised in worklog-cue.test.tsx; what THIS
 * file is for is the wiring — the summary is a sibling of `issue` on the API row, and it
 * has to survive `buildGroups`' placement pass to reach the rendered line. That hop is
 * exactly where `claim` was once dropped (see the note on `TaskRow`), so it gets a test.
 */
describe("worklog cue, threaded through the real placement pass", () => {
  it("reaches the row from the API payload and reads its count and age", () => {
    const markup = renderRow(
      { status: "in_progress", checkoutAgent: "opus-x" },
      claim({ idleSeconds: 30, lastActivityAt: "2026-09-02T11:59:30.000Z" }),
      undefined,
      worklog({ revisions: 4, updatedAt: "2026-09-02T11:19:00.000Z" }),
    );

    expect(markup).toContain('data-testid="worklog-cue"');
    expect(markup).toContain("r4 · 41m");
    // Both facts on one row, neither contradicting the other: someone IS there, and the
    // handoff is current.
    expect(markup).toContain('data-testid="working-pill"');
    expect(markup).toContain('data-state="fresh"');
  });

  it("is absent for a free issue that has never been checkpointed", () => {
    expect(renderRow()).not.toContain("staple-worklog-cue");
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

/**
 * O5 (STA-137). A row that belongs to a parent must be distinguishable from a top-level task
 * WITHOUT the tree's indent — in the pickup queue, the detail panel and the palette every row
 * sits at depth 0, and the only parent signal there today is a breadcrumb chip that reads as
 * part of the title.
 *
 * The four ways this breaks, in order: the glyph never arrives; the glyph arrives on
 * everything; the slot stops being reserved and the identifiers stop aligning down the list;
 * or it lands in the tree only and the two narrow presets — the ones that actually need it —
 * are left with nothing.
 */
describe("subtask connector glyph", () => {
  it("marks a row whose issue has a parent", () => {
    const markup = renderRow({ parentId: "id-999" });

    expect(markup).toContain('data-testid="subtask-glyph"');
    expect(markup).toContain("staple-row-kin");
    // The relation is carried in TEXT beside the drawing, not by the drawing — so a
    // flat-mode row with no breadcrumb chip still says what it is to a screen reader.
    expect(markup).toContain(">Subtask<");
  });

  it("leaves a top-level row and a top-level PARENT unmarked", () => {
    const { parent, child } = renderFamily();

    expect(renderRow()).not.toContain('data-testid="subtask-glyph"');
    expect(parent).not.toContain('data-testid="subtask-glyph"');
    expect(parent).not.toContain(">Subtask<");
    // The parent really was built as one, or this passes for the wrong reason.
    expect(parent).toContain("aria-expanded=");
    // …and its child, which is the control, really was marked.
    expect(child).toContain('data-testid="subtask-glyph"');
  });

  it("reserves NO space on a top-level row — the glyph is inline, not a slot", () => {
    /**
     * The first cut of O5 held a fixed 12px box on every row so the identifiers kept one
     * left edge. VP rejected it on review: an empty reserve reads as a gap in front of every
     * top-level identifier, and it costs 16px of title track on every row of every preset to
     * align a glyph most rows do not carry.
     *
     * So a top-level row emits NOTHING — not the glyph, not a spacer, not a class. The price
     * is that a child's identifier sits one glyph right of a top-level one, and that price is
     * temporary: O1b (STA-125) puts a real kind glyph on every row and gets the edge back by
     * filling the space rather than reserving it.
     */
    const top = renderRow();
    expect(top).not.toContain("staple-row-kin");
    expect(top).not.toContain("staple-row-kin-spacer");
  });

  it("is on in the panel and popup presets too, not only the tree", () => {
    for (const preset of ["panel", "popup"] as const) {
      expect(renderPreset(preset, { parentId: "id-999" })).toContain('data-testid="subtask-glyph"');
      expect(renderPreset(preset)).not.toContain("staple-row-kin");
    }
  });

  it("adds no second row and no second cell", () => {
    // The glyph lives INSIDE the identifier cluster. If it ever becomes its own grid track
    // the row's column template changes for every preset at once, which is the expensive
    // version of this ticket.
    const markup = renderRow({ parentId: "id-999" });
    expect(markup.match(/role="row"/g)).toHaveLength(1);
    expect(markup.match(/role="gridcell"/g)).toHaveLength(1);
    const id = markup.indexOf("staple-row-id");
    const glyph = markup.indexOf('data-testid="subtask-glyph"');
    const status = markup.indexOf("staple-row-status");
    expect(glyph).toBeGreaterThan(id);
    expect(status).toBeGreaterThan(glyph);
  });
});

/**
 * O6 (STA-138). The badges replace the `blocked by STA-67, STA-68, …` caption, which means
 * they inherit its job: on a Waiting row they are now the ONLY thing on the line that says
 * what is in the way. Four failure modes, in the order they would actually happen.
 */
describe("dependency badges", () => {
  it("puts NOTHING in the DOM when there is nothing to report", () => {
    // A row with no edges is the common case and must cost the row exactly nothing — no
    // reserved box, no zero badge, no empty wrapper.
    for (const deps of [undefined, { blockedBy: [], blocks: [] }]) {
      const markup = renderDeps(deps);
      expect(markup).not.toContain('data-testid="dep-badges"');
      expect(markup).not.toContain("staple-dep-badge");
    }
  });

  it("shows a warning triangle with the COUNT for unresolved blockers", () => {
    const markup = renderDeps({ blockedBy: ["STA-67", "STA-68", "STA-69"], blocks: [] });

    expect(markup).toContain('data-testid="dep-badge-blocked-by"');
    expect(markup).toContain('aria-label="Blocked by 3 tasks"');
    // The identifiers did not vanish — they moved to the tooltip, where they cost no width.
    expect(markup).toContain('title="Blocked by STA-67, STA-68, STA-69"');
    expect(markup).toContain(">3<");
    // …and the other direction, which this row has nothing to say about, is absent.
    expect(markup).not.toContain('data-testid="dep-badge-blocks"');
  });

  it("shows a stop sign with the count for open dependents", () => {
    const markup = renderDeps({ blockedBy: [], blocks: ["STA-70"] });

    expect(markup).toContain('data-testid="dep-badge-blocks"');
    // Singular, because a badge that says "Blocks 1 tasks" was written by a machine.
    expect(markup).toContain('aria-label="Blocks 1 task"');
    expect(markup).not.toContain('data-testid="dep-badge-blocked-by"');
  });

  it("is keyboard reachable and does not swallow the row", () => {
    const markup = renderDeps({ blockedBy: ["STA-67"], blocks: ["STA-70"] });

    // Real buttons: focusable, in the tab order, announced as controls. A div with an
    // onClick would be invisible to a keyboard and to a screen reader both.
    expect(markup.match(/<button type="button" class="staple-dep-badge"/g)).toHaveLength(2);
    // Still ONE row and ONE cell — the badges are content, not structure.
    expect(markup.match(/role="row"/g)).toHaveLength(1);
    expect(markup.match(/role="gridcell"/g)).toHaveLength(1);
  });

  it("leads the meta cluster — nearest the title, furthest from the clipped edge", () => {
    const markup = renderDeps({ blockedBy: ["STA-67"], blocks: [] });
    const title = markup.indexOf("staple-row-title-cell");
    const meta = markup.indexOf("staple-row-meta");
    const badge = markup.indexOf("staple-dep-badges");
    const date = markup.indexOf("staple-row-date");

    expect(badge).toBeGreaterThan(title);
    expect(badge).toBeGreaterThan(meta);
    // Before the date, which is the first thing §14 drops. Ordering IS placement here.
    expect(date).toBeGreaterThan(badge);
  });

  it("is ON in the panel and OFF in the popup", () => {
    const deps = { blockedBy: ["STA-67"], blocks: [] };
    expect(renderDeps(deps, "panel")).toContain('data-testid="dep-badge-blocked-by"');
    // A palette row is read in under a second on the way to pressing enter, and its status
    // icon already says `blocked`. See the note on `columns.deps` in config.ts.
    expect(renderDeps(deps, "popup")).not.toContain("staple-dep-badge");
  });
});

/**
 * ── THE COLLAPSED-PARENT ROLLUP — O3b (STA-127) ──────────────────────────────────────
 *
 * The arithmetic is pinned in row-bits.test.ts. What is pinned HERE is the row: which
 * elements exist in which fold state, and the one confusion this element must never create.
 *
 * `flattenFlat` rather than `buildGroups`, because a folded parent needs its children in the
 * SAME bucket to have any — under status grouping a done child of an in-progress epic is
 * filed in a different group by design (§11.3), which is a different ticket's subject.
 */
describe("parent rollup", () => {
  /**
   * A five-child epic through the REAL model, with `rollupSource` doing the job it exists
   * for: the list on screen is the default filter's (no done rows), the counts are the
   * whole payload's.
   */
  function renderEpic(
    over: {
      expanded?: boolean;
      showResolved?: boolean;
      childClaim?: ClaimActivity | null;
      parentClaim?: ClaimActivity | null;
      statuses?: string[];
    } = {},
  ): string {
    const {
      expanded = false,
      showResolved = false,
      childClaim = null,
      parentClaim = null,
      statuses = ["done", "done", "done", "todo", "in_progress"],
    } = over;

    const all = [
      row({ identifier: "STA-1", status: "in_progress" }, parentClaim),
      ...statuses.map((status, index) =>
        row(
          { identifier: `STA-${index + 2}`, parentId: "id-1", status: status as Issue["status"] },
          // The claim, when there is one, goes on the LAST child.
          index === statuses.length - 1 ? childClaim : null,
        ),
      ),
    ];

    const built = flattenFlat(all, {
      isExpanded: () => expanded,
      showResolved,
      rollupSource: all,
    })[0]!;

    return renderToStaticMarkup(
      <TaskRowLine
        row={built}
        config={resolveTaskListConfig("tree", { labelMax: 2 })}
        semantics="grid"
        isExpanded={expanded}
        now={NOW}
      />,
    );
  }

  it("shows resolved/total and the segmented bar when folded", () => {
    const markup = renderEpic();

    expect(markup).toContain('data-testid="parent-rollup"');
    expect(markup).toContain('data-testid="parent-rollup-bar"');
    expect(markup).toContain("3/5");
    // Three segments present, not four: an empty segment is ABSENT rather than a
    // zero-width box, which still paints a hairline at some zoom levels.
    expect(markup).toContain('data-segment="done"');
    expect(markup).toContain('data-segment="in_progress"');
    expect(markup).toContain('data-segment="open"');
    expect(markup).not.toContain('data-segment="blocked"');
    // The bar is silent; the count carries the reading, spelled out rather than "3/5",
    // which a screen reader says as "three slash five".
    expect(markup).toContain('aria-label="3 of 5 done"');
  });

  it("counts the UNFILTERED list — 3 of 5 done while the filter hides the done ones", () => {
    const markup = renderEpic({ showResolved: false });

    // The acceptance criterion, and the reason `rollupSource` is threaded down from
    // TreeView at all. Built from what is on screen this would read 0/2.
    expect(markup).toContain("3/5");
    // And `+N` still means what it always meant: DIRECT children the fold removed, which
    // the filter has already cut to two. The two numbers are allowed to differ.
    expect(markup).toContain("+2");
  });

  it("keeps the count and drops the bar when the parent is expanded", () => {
    const markup = renderEpic({ expanded: true });

    // The bar restates rows that are now on the screen underneath. The count does not: the
    // filter may still be hiding some of the descendants it counts.
    expect(markup).toContain('data-testid="parent-rollup"');
    expect(markup).toContain("3/5");
    expect(markup).not.toContain('data-testid="parent-rollup-bar"');
    // `+N` stays collapsed-only — "+2" printed above two visible children would be a lie.
    expect(markup).not.toContain("staple-row-childcount");
  });

  it("puts NOTHING in the DOM for a leaf", () => {
    const markup = renderRow();

    expect(markup).not.toContain('data-testid="parent-rollup"');
    expect(markup).not.toContain("staple-rollup");
  });

  it("pulses with the holder's initials for a LIVE descendant claim", () => {
    const markup = renderEpic({ childClaim: claim({ heldBy: "opus-x", idleSeconds: 30 }) });

    expect(markup).toContain('data-testid="rollup-child-live"');
    expect(markup).toContain("staple-rollup-live-dot");
    expect(markup).toContain("OX");
    // The name says CHILD and names the ticket, so it can never be read as the parent's
    // own claim — which is the single confusion this element must not create.
    expect(markup).toContain('aria-label="child STA-6: opus-x is working"');
  });

  it("never animates for a STALE descendant claim — it renders nothing at all", () => {
    const markup = renderEpic({ childClaim: claim({ idleSeconds: STALE_CLAIM_SECONDS }) });

    // Not a static variant and not a dimmed one. An agent that died four hours ago is not
    // inside this subtree, and the child's own row says so honestly when you unfold.
    expect(markup).not.toContain('data-testid="rollup-child-live"');
    expect(markup).not.toContain("staple-rollup-live-dot");
    // The count and the bar are unaffected — liveness and progress are different facts.
    expect(markup).toContain("3/5");
    expect(markup).toContain('data-testid="parent-rollup-bar"');
  });

  it("is NOT the claim slot: it never appears there and never claims the parent is held", () => {
    const markup = renderEpic({ childClaim: claim({ heldBy: "opus-x", idleSeconds: 30 }) });
    const titleCell = markup.indexOf("staple-row-title-cell");
    const live = markup.indexOf('data-testid="rollup-child-live"');
    const meta = markup.indexOf("staple-row-meta");

    // In the TITLE cell, at the opposite end of the row from the meta cluster where
    // `RowClaimSlot` lives. Different position, and no working pill on this row at all:
    // the parent is unheld and the rollup must not invent a holder for it.
    expect(live).toBeGreaterThan(titleCell);
    expect(live).toBeLessThan(meta);
    expect(markup).not.toContain('data-testid="working-pill"');
    expect(markup).not.toContain("Working…");
  });

  it("coexists with the parent's OWN claim — two agents, two tickets, two elements", () => {
    const markup = renderEpic({
      parentClaim: claim({ heldBy: "opus-p", idleSeconds: 10 }),
      childClaim: claim({ heldBy: "opus-x", idleSeconds: 30 }),
    });

    // `RowClaimSlot` stays the single place the row's own liveness is written down, and the
    // rollup says something else entirely. Both are true at once and both are drawn.
    expect(markup).toContain('data-testid="working-pill"');
    expect(markup).toContain("opus-p is working");
    expect(markup).toContain('data-testid="rollup-child-live"');
    expect(markup).toContain('aria-label="child STA-6: opus-x is working"');
    // Two dots, two silhouettes — the capsule's and the bare one beside the count.
    expect(markup).toContain("staple-working-dot");
    expect(markup).toContain("staple-rollup-live-dot");
  });

  it("renders no bar when every descendant is cancelled — 0/0 is furniture", () => {
    const markup = renderEpic({ statuses: ["cancelled", "cancelled"], showResolved: true });

    expect(markup).not.toContain('data-testid="parent-rollup"');
    expect(markup).not.toContain("0/0");
  });
});

/**
 * ── THE ROLLED-UP PLAN BESIDE THE BAR — R7c (STA-194) ────────────────────────────────
 *
 * "Without increasing row height" is a CSS fact no string render can measure, so what is
 * pinned is the argument the component makes for it: the plan is an inline `<span>` wearing
 * the count's own class and nothing else — no new class, no style attribute, no block
 * element — inside the rollup O3b already proved fits the row. Break any of those and this
 * fails before a browser is needed to watch the row grow. No screenshot harness exists in
 * this suite and none is added.
 */
describe("parent rollup plan", () => {
  function renderPlanned(
    over: {
      expanded?: boolean;
      density?: "comfortable" | "compact";
      parentEstimate?: number | null;
      estimates?: (number | null)[];
    } = {},
  ): string {
    const {
      expanded = false,
      density = "comfortable",
      parentEstimate = null,
      estimates = [14_400, 10_800, 14_400],
    } = over;

    const all = [
      row({ identifier: "STA-1", status: "in_progress", estimatedSeconds: parentEstimate }),
      ...estimates.map((estimatedSeconds, index) =>
        row({ identifier: `STA-${index + 2}`, parentId: "id-1", status: "todo", estimatedSeconds }),
      ),
    ];

    const built = flattenFlat(all, {
      isExpanded: () => expanded,
      showResolved: false,
      rollupSource: all,
    })[0]!;

    return renderToStaticMarkup(
      <TaskRowLine
        row={built}
        config={resolveTaskListConfig("tree", { density, labelMax: 2 })}
        semantics="grid"
        isExpanded={expanded}
        now={NOW}
      />,
    );
  }

  /** The whole element, attribute by attribute, so a stray one cannot slip in. */
  const PLAN =
    /<span class="staple-rollup-count max-\[719px\]:hidden" data-testid="parent-rollup-plan" data-plan-source="(\w+)" aria-label="([^"]+)" title="([^"]+)">est ([^<]+)<\/span>/;

  it("shows the rolled-up 11h beside the bar when folded, in the O3 slot", () => {
    const markup = renderPlanned();
    const match = PLAN.exec(markup);

    expect(match).not.toBeNull();
    expect(match![4]).toBe("11h");
    expect(match![1]).toBe("descendants");
    expect(match![2]).toBe("planned 11h, rolled up from descendants");
    expect(match![3]).toBe(match![2]);
    // Inside the rollup, after the bar, and in the title cell before the meta cluster —
    // the same place the count and the live dot already live.
    const rollup = markup.indexOf('data-testid="parent-rollup"');
    const bar = markup.indexOf('data-testid="parent-rollup-bar"');
    const plan = markup.indexOf('data-testid="parent-rollup-plan"');
    expect(rollup).toBeLessThan(bar);
    expect(bar).toBeLessThan(plan);
    expect(plan).toBeLessThan(markup.indexOf("staple-row-meta"));
  });

  it("adds no height: an inline span in the count's own class, no style, no new rule", () => {
    const markup = renderPlanned();
    const plan = PLAN.exec(markup)![0];

    expect(plan.startsWith("<span ")).toBe(true);
    expect(plan).not.toContain("style=");
    expect(plan).not.toContain("<div");
    // The class list is the count's class plus the narrow-width utility — nothing that
    // task-list.css does not already size at 11px, nowrap, inline.
    expect(plan).toContain('class="staple-rollup-count max-[719px]:hidden"');
    expect(markup).not.toContain("staple-rollup-plan");
  });

  it("names its source: a parent's own estimate is `own`, and shadows the children", () => {
    const match = PLAN.exec(renderPlanned({ parentEstimate: 21_600 }))!;

    expect(match[4]).toBe("6h");
    expect(match[1]).toBe("own");
    expect(match[2]).toBe("planned 6h, own estimate");
  });

  it("renders NOTHING when the subtree has no plan — no `est —`", () => {
    const markup = renderPlanned({ estimates: [null, null, null] });

    expect(markup).not.toContain('data-testid="parent-rollup-plan"');
    expect(markup).not.toContain("est —");
    // The count and the bar are unaffected — progress and plan are different facts.
    expect(markup).toContain('data-testid="parent-rollup-bar"');
    expect(markup).toContain("0/3");
  });

  it("sums the partial coverage it has — one planned child of three is that child's figure", () => {
    expect(PLAN.exec(renderPlanned({ estimates: [3600, null, null] }))![4]).toBe("1h");
  });

  it("goes with the bar when the parent is expanded — the children say it themselves", () => {
    const markup = renderPlanned({ expanded: true });

    expect(markup).not.toContain('data-testid="parent-rollup-plan"');
    expect(markup).toContain('data-testid="parent-rollup"');
    expect(markup).toContain("0/3");
  });

  it("stays out of compact density — the row decides; the component never reads the config", () => {
    const markup = renderPlanned({ density: "compact" });

    expect(markup).not.toContain('data-testid="parent-rollup-plan"');
    expect(markup).toContain('data-testid="parent-rollup-bar"');
  });

  it("hides below the two-line breakpoint with a utility class, not a new rule in the sheet", () => {
    // Below 720px §14 gives the title track the whole row width and there is no room for an
    // aside; the plan yields there and the count and the bar stay.
    expect(PLAN.exec(renderPlanned())![0]).toContain("max-[719px]:hidden");
  });
});

/**
 * ── THE GHOST PARENT CONTEXT ROW — O3c (STA-128) ──────────────────────────────────────
 *
 * A parent that is NOT in this bucket, drawn inside it so the children that ARE can nest
 * under it. Built through the real `buildGroups` rather than a hand-made `TaskRow`, because
 * the whole claim of this ticket is that the model and the row agree about what a ghost is
 * — a fixture asserting the row alone would still pass on the day the model stopped
 * producing one.
 *
 * Three ways this could quietly become wrong, and one test each:
 *
 *   1. It grows a SELECTION affordance. A ghost is not in this bucket, so a checkbox here
 *      offers to select a row that is not in the group the selection was made in.
 *      (The FOLD used to be on this list and is not any more — see O8c below.)
 *   2. It loses its geometry. The select and actions columns are reserved width, so
 *      dropping either element slides this one row's glyphs out of the list's columns.
 *   3. It says something about the parent it cannot know — a claim, in particular, which
 *      `hiddenParents` could never supply and which belongs to the parent's real row.
 *
 * ── O8c (STA-151) — THE CHEVRON IS A BUTTON NOW ───────────────────────────────────────
 *
 * O3c drew a static glyph here on the grounds that a fold would "remove real rows from the
 * group they belong to". STA-148 answers that a group is a way of DISPLAYING rows, so a
 * fold hides rows from the display and changes nothing about membership — and the group's
 * `count` is `bucket.length`, which no fold can reach. What is left of O3c's argument is
 * that the ghost is CONTEXT: it stays dimmed, carries no claim and joins no selection.
 */
describe("the ghost parent context row", () => {
  const family = () => [
    row(
      { id: "p", identifier: "STA-1", title: "The epic", status: "backlog" },
      claim({ heldBy: "opus-p", idleSeconds: 10 }),
    ),
    row({ id: "c", identifier: "STA-2", title: "The task", status: "in_progress", parentId: "p" }),
    row({ id: "d", identifier: "STA-3", title: "Shipped", status: "done", parentId: "p" }),
  ];

  /** The In Progress group: `[ghost STA-1, STA-2]`. */
  function inProgressRows(isExpanded: (issue: { id: string }) => boolean | undefined = () => true) {
    const rows = family();
    return buildGroups(rows, { isExpanded, rollupSource: rows }).find(
      (g) => g.status === "in_progress",
    )!.rows;
  }

  /**
   * The ghost, rendered the way `TreeGrid.renderGhost` renders it: no selection, no
   * `isCurrent` — the click that opens the parent, and (since O8c) the fold.
   *
   * `isExpanded` comes from the ROW rather than being asserted at the call site, which is
   * the seam this ticket moved: `renderGhost` used to pass a hard `true`.
   */
  const renderGhostRow = (rows = inProgressRows()) =>
    renderToStaticMarkup(
      <TaskRowLine
        row={rows[0]!}
        config={resolveTaskListConfig("tree", { labelMax: 2 })}
        semantics="grid"
        isExpanded={rows[0]!.isExpanded}
        now={NOW}
        onOpen={() => {}}
        onToggleExpand={() => {}}
        onFocus={() => {}}
        onKeyDown={() => {}}
        registerRef={() => {}}
      />,
    );

  it("is the parent, marked as a ghost and dimmed by class rather than by hue", () => {
    const markup = renderGhostRow();

    expect(inProgressRows()[0]!.ghost).toBe(true);
    expect(markup).toContain('data-identifier="STA-1"');
    expect(markup).toContain('data-ghost="true"');
    expect(markup).toContain("staple-row-ghost");
    // Still a real treegrid row at the top level of the group, with the children it
    // brackets one level down — `aria-level` is 1-based.
    expect(markup).toContain('role="row"');
    expect(markup).toContain('aria-level="1"');
    expect(markup).toContain('aria-expanded="true"');
  });

  it("FOLDS — the chevron is the same button a real parent gets — O8c (STA-151)", () => {
    const markup = renderGhostRow();

    // The static glyph is gone, and with it the class that styled it.
    expect(markup).not.toContain("staple-row-chevron-static");
    // A real chevron, labelled exactly as a real row's is, so a screen reader hears one
    // control rather than two that happen to look alike.
    expect(markup).toContain("Collapse STA-1");
    expect(markup).toContain('aria-expanded="true"');
  });

  it("stays dimmed and stays context when it is FOLDED — O8c (STA-151)", () => {
    // The model's fold arrives through the ROW, which is the whole point: the ghost and
    // the parent's real row read one entry, keyed by the issue id.
    const folded = inProgressRows((issue) => (issue.id === "p" ? false : undefined));

    expect(folded.map((r) => [r.issue.identifier, r.ghost === true])).toEqual([["STA-1", true]]);

    const markup = renderGhostRow(folded);
    expect(markup).toContain("Expand STA-1");
    expect(markup).toContain('aria-expanded="false"');
    // Dimming is the signal for "context", and a fold is not a promotion out of it.
    expect(markup).toContain("staple-row-ghost");
    expect(markup).toContain('data-ghost="true"');
    expect(markup).toContain("parent shown for context");
  });

  it("offers NO selection and NO row menu — the fold and the click are the interactions", () => {
    const markup = renderGhostRow();

    // No `⋯`, and no `aria-selected` advertising a selection it cannot join.
    expect(markup).not.toContain("Open details for STA-1");
    expect(markup).not.toContain("aria-selected");
    // Not the tab stop, because it is not the focused row in this fixture. It IS in the
    // arrow sequence now (TreeGrid), under a prefixed key; the roving `tabIndex` is what
    // makes exactly one row in the list tabbable, and it is not this one.
    expect(markup).toContain('tabindex="-1"');
  });

  it("keeps every reserved column, so one dimmed row cannot break the list's alignment", () => {
    const wide = renderToStaticMarkup(
      <TaskRowLine
        row={inProgressRows()[0]!}
        // The checkbox gutter is off by default (STA-101). Forced on here, because the
        // failure this guards is invisible until somebody turns it back on: the row is a
        // GRID, so an absent element does not leave a gap, it shifts every later glyph one
        // track left.
        config={resolveTaskListConfig("tree", { labelMax: 2, columns: { select: true } })}
        semantics="grid"
        isExpanded
        now={NOW}
        onOpen={() => {}}
      />,
    );

    expect(wide).toContain("staple-row-check-spacer");
    expect(wide).not.toContain("Select STA-1");
    expect(renderGhostRow()).toContain("staple-row-actions-spacer");
  });

  it("says what is UNDER the parent and nothing about the parent's own liveness", () => {
    const markup = renderGhostRow();

    // The rollup rides along — it is the epic's own progress, over the unfiltered source,
    // so the `done` child the default filter hides is still in the denominator.
    expect(markup).toContain('data-testid="parent-rollup"');
    expect(markup).toContain("1/2");
    // Expanded form: the count, no bar. The rows the bar would restate are on the screen
    // directly underneath it.
    expect(markup).not.toContain('data-testid="parent-rollup-bar"');
    // And NO claim, even though this parent is genuinely held — `hiddenParents` yields an
    // `Issue` alone, so a ghost could never report liveness consistently, and the parent's
    // real row in the Backlog group is where it is written down.
    expect(markup).not.toContain('data-testid="working-pill"');
    expect(markup).not.toContain("opus-p is working");
  });

  it("tells a screen reader it is context, since the dimming tells it nothing", () => {
    expect(renderGhostRow()).toContain("parent shown for context");
  });

  it("takes the chip off the child it brackets — the elbow is now saying it", () => {
    const child = inProgressRows()[1]!;
    const markup = renderToStaticMarkup(
      <TaskRowLine
        row={child}
        config={resolveTaskListConfig("tree", { labelMax: 2 })}
        semantics="grid"
        now={NOW}
        onOpen={() => {}}
        onOpenParent={() => {}}
        registerRef={() => {}}
      />,
    );

    expect(child.depth).toBe(1);
    expect(markup).not.toContain("staple-row-breadcrumb");
    expect(markup).not.toContain("Parent STA-1");
    // Nested, so it draws the connector the chip used to stand in for.
    expect(markup).toContain("staple-guide-elbow");
    expect(markup).toContain('aria-level="2"');
    // An ordinary row in every other respect: focusable, selectable, and NOT dimmed.
    expect(markup).not.toContain('data-ghost="true"');
    expect(markup).toContain('aria-selected="false"');
  });
});

/**
 * O1b (STA-125) — the kind glyph.
 *
 * Four things can go wrong here and only one of them is "the glyph is missing".
 *
 *   1. TWO KINDS DRAW THE SAME MARK. Monochrome means shape carries the whole signal, so
 *      a copy-paste between two `case` arms is invisible on the page and fatal to the
 *      feature. Every kind's markup is compared against every other kind's.
 *   2. A CONFIGURED KIND DRAWS NOTHING. `staple kinds add milestone` is supported, so a
 *      switch that only knows the five built-ins would drop the glyph — and with it the
 *      16px that puts that row's identifier on the same left edge as every other row.
 *   3. THE GLYPH LANDS RIGHT OF THE IDENTIFIER. It has to lead the cluster, in the DOM as
 *      well as visually, because that ordering is also what a screen reader reads.
 *   4. IT IS ON THE TREE AND NOWHERE ELSE. The panel, the palette and the ghost rows all
 *      get it from this one component, with no code of their own — which is only true if
 *      it is gated on `columns.identifier` and carries no `ghost` guard.
 */
describe("kind glyph", () => {
  const BUILT_INS = ["epic", "task", "bug", "chore", "spike"] as const;

  /** Just the glyph element, sliced out of a rendered row. */
  function glyphOf(markup: string): string {
    const start = markup.indexOf('<span class="staple-kind-glyph"');
    expect(start).toBeGreaterThan(-1);
    const end = markup.indexOf("</span></span>", start);
    return markup.slice(start, end + "</span></span>".length);
  }

  /** The drawing alone — the attribute names the kind, so it cannot be compared. */
  const drawingOf = (kind: string) =>
    glyphOf(renderRow({ kind })).replace(`data-issue-kind="${kind}"`, "");

  it("draws a distinct mark for every built-in kind", () => {
    for (const kind of BUILT_INS) {
      expect(glyphOf(renderRow({ kind }))).toContain(`data-issue-kind="${kind}"`);
    }
    // The whole set, pairwise. `new Set(...).size` would also catch a duplicate, but it
    // would not say WHICH two collided, and a duplicated `case` arm is the failure this
    // test exists for.
    for (const a of BUILT_INS) {
      for (const b of BUILT_INS) {
        if (a === b) continue;
        expect(drawingOf(a), `${a} and ${b} draw the same mark`).not.toBe(drawingOf(b));
      }
    }
  });

  it("gives an epic the only solid mark in the set", () => {
    // Not decoration: colour is unavailable in this cluster, so MASS is the entire reason
    // an epic is recognisable in a folded list. Every other kind is an outline.
    expect(glyphOf(renderRow({ kind: "epic" }))).toContain('fill="currentColor"');
    for (const kind of ["task", "bug", "chore", "spike"] as const) {
      expect(glyphOf(renderRow({ kind })), kind).toContain('fill="none"');
    }
  });

  it("draws task as the hollow twin of epic — the container and the unit", () => {
    // The one pair allowed to share a silhouette, and the assertion is what stops the
    // relationship from being quietly redesigned into two unrelated shapes: epic and
    // task must both be diamonds, and must differ ONLY in fill and size.
    const epic = glyphOf(renderRow({ kind: "epic" }));
    const task = glyphOf(renderRow({ kind: "task" }));
    expect(epic).toMatch(/d="M8 [\d.]+ L[\d.]+ 8 L8 [\d.]+ L[\d.]+ 8 Z"/);
    expect(task).toMatch(/d="M8 [\d.]+ L[\d.]+ 8 L8 [\d.]+ L[\d.]+ 8 Z"/);
    // And it must not echo the priority column: `critical` is a filled rounded RECT one
    // column to the left, which is why neither of these may be a rect at all.
    expect(epic).not.toContain("<rect");
    expect(task).not.toContain("<rect");
  });

  it("gives a kind the operator added a neutral mark rather than nothing", () => {
    const markup = renderRow({ kind: "milestone" });

    expect(markup).toContain('data-issue-kind="milestone"');
    // It must not impersonate one of the five: this file cannot know what `milestone`
    // means, and guessing a shape for it would be worse than staying quiet.
    for (const kind of BUILT_INS) {
      expect(drawingOf("milestone"), kind).not.toBe(drawingOf(kind));
    }
    // …and it is still announced, by the title-cased id the settings module falls back to.
    expect(markup).toContain("Kind: Milestone");
  });

  it("leads the identifier cluster — before the identifier and before the connector", () => {
    const child = renderRow({ identifier: "STA-2", kind: "bug", parentId: "p" });

    const glyph = child.indexOf("staple-kind-glyph");
    const connector = child.indexOf("staple-row-kin");
    const identifier = child.indexOf("STA-2<");

    expect(glyph).toBeGreaterThan(-1);
    expect(glyph).toBeLessThan(connector);
    expect(connector).toBeLessThan(identifier);
  });

  it("is decoration to the eye and text to a screen reader", () => {
    const markup = renderRow({ kind: "epic" });

    // aria-hidden rather than role="img": an image announced in the middle of the row's
    // name would break the sentence the cluster reads as.
    expect(glyphOf(markup)).toContain('aria-hidden="true"');
    expect(glyphOf(markup)).not.toContain('role="img"');
    // Said in the flow instead, before the identifier, so the row reads
    // "Kind: Epic, STA-n, the title".
    expect(markup).toContain('<span class="sr-only">Kind: Epic</span>');
    expect(markup.indexOf("Kind: Epic")).toBeLessThan(markup.indexOf("staple-row-status"));
  });

  it("says the label the workspace configured, not the raw id", () => {
    // `kindLabel` is the only thing that knows what the operator called a kind. A row
    // printing the raw id would be this component holding a second copy of the vocabulary.
    expect(renderRow({ kind: "spike" })).toContain("Kind: Spike");
    expect(renderRow({ kind: "chore" })).toContain("Kind: Chore");
  });

  it("is on every preset that shows an identifier, including the palette's bare row", () => {
    const built = buildGroups([row({ kind: "epic" })], {
      isExpanded: () => true,
      showResolved: true,
    })[0]!.rows[0]!;

    for (const preset of ["tree", "panel", "popup"] as const) {
      const markup = renderToStaticMarkup(
        <TaskRowLine
          row={built}
          config={resolveTaskListConfig(preset)}
          semantics={preset === "popup" ? "bare" : "grid"}
          now={NOW}
        />,
      );
      // R5's criterion, and it is delivered by a MECHANISM rather than by a third call
      // site: the glyph is gated on `columns.identifier`, which every preset sets.
      expect(markup, preset).toContain('data-issue-kind="epic"');
    }
  });
});

/**
 * O1b (STA-125) again, from the other side: the ghost keeps its glyph.
 *
 * O3c's worklog asked for this explicitly and gave the reason — a dimmed epic that does
 * not LOOK like an epic defeats the point of drawing the parent at all. It is the one
 * element added since O3c that has no `ghost` guard, and this is what says that is
 * deliberate rather than forgotten.
 */
describe("kind glyph on a ghost parent", () => {
  const family = () => [
    row({ id: "p", identifier: "STA-1", title: "The epic", status: "backlog", kind: "epic" }),
    row({ id: "c", identifier: "STA-2", title: "The task", status: "in_progress", parentId: "p" }),
  ];

  const ghostMarkup = () => {
    const rows = family();
    const group = buildGroups(rows, { isExpanded: () => true, rollupSource: rows }).find(
      (g) => g.status === "in_progress",
    )!;
    return renderToStaticMarkup(
      <TaskRowLine
        row={group.rows[0]!}
        config={resolveTaskListConfig("tree", { labelMax: 2 })}
        semantics="grid"
        isExpanded
        now={NOW}
        onOpen={() => {}}
      />,
    );
  };

  it("keeps the epic's glyph, dimmed with the rest of the row", () => {
    const markup = ghostMarkup();

    expect(markup).toContain('data-ghost="true"');
    expect(markup).toContain('data-issue-kind="epic"');
    // No glyph-specific dimming rule anywhere: `.staple-row-ghost` is one `opacity` on
    // the row, so anything added inside it fades with it and nothing has to be told to.
    expect(markup).not.toContain("staple-kind-glyph-ghost");
  });

  it("still reads its kind before the note that it is only context", () => {
    const markup = ghostMarkup();
    expect(markup.indexOf("Kind: Epic")).toBeLessThan(markup.indexOf("parent shown for context"));
  });
});

/**
 * R4c (STA-188) — the two cues, in the DOM.
 *
 * The derivation is argued in `row-cues.test.ts`; what is left for the markup is the half of
 * the ticket that is about the ROW rather than about the queue:
 *
 *   1. Every cue carries a `title` AND screen-reader text, and both say the same sentence.
 *      A tooltip alone is a cue only a mouse can read.
 *   2. The state is legible without colour: a distinct glyph per state, and the WORD leading
 *      the sentence. Nothing here paints.
 *   3. THE ROW DOES NOT GROW. Two inline 11px spans in the title track, no `style`, no
 *      `<div>`, and `--row-height` unchanged in every density preset — the same structural
 *      proof R7c's "adds no height" makes one element to the right.
 *   4. The GROUPED shapes are untouched: a row that was never joined against the queue
 *      renders no cue at all, which is what the ungrouped-only fetch in TreeView buys.
 */
describe("row cues", () => {
  const QUEUE: QueueView = {
    revision: 3,
    entries: [
      { issueId: "epic", identifier: "STA-9", title: "The epic", kind: "epic", status: "todo", planPosition: 2, rank: 2000, parent: null, resolved: false, addedBy: "VP", addedAt: "2026-09-01T00:00:00.000Z", note: null },
    ],
    effective: [
      { issueId: "a", identifier: "STA-1", title: "first", kind: "task", status: "todo", position: 1, planPosition: 1, via: null, unqueued: false, eligibility: "eligible", reason: null, detail: null, dueAt: null, milestonePath: ["STA-50"], epicPath: [], parent: null },
      { issueId: "b", identifier: "STA-2", title: "second", kind: "task", status: "todo", position: 2, planPosition: 2, via: "STA-9", unqueued: false, eligibility: "eligible", reason: null, detail: null, dueAt: null, milestonePath: [], epicPath: ["STA-9"], parent: "epic" },
      { issueId: "c", identifier: "STA-3", title: "third", kind: "task", status: "todo", position: 3, planPosition: null, via: null, unqueued: false, eligibility: "blocked", reason: "STA-3 is blocked by STA-1.", detail: null, dueAt: null, milestonePath: [], epicPath: [], parent: null },
    ],
  };
  const TITLES = new Map([["STA-50", "Q4 launch"]]);

  /** One ungrouped row, joined against the queue exactly as TreeView joins it. */
  function renderCued(
    identifier: string,
    over: Partial<Issue> = {},
    density: "comfortable" | "compact" = "comfortable",
  ): string {
    const sources = attachRowCues(
      [row({ id: "epic", identifier: "STA-9", kind: "epic" }), row({ identifier, ...over })],
      buildRowCueIndex(QUEUE, TITLES),
    );
    const built = flattenFlat(sources, { isExpanded: () => true, showResolved: true }).find(
      (line) => line.issue.identifier === identifier,
    )!;

    return renderToStaticMarkup(
      <TaskRowLine
        row={built}
        config={resolveTaskListConfig("tree", { density, labelMax: 2 })}
        semantics="grid"
        isExpanded
        now={NOW}
        onOpen={() => {}}
        onOpenMilestone={() => {}}
      />,
    );
  }

  it("puts the pickup cue and the milestone marker at the head of the title cell", () => {
    const markup = renderCued("STA-1");
    const status = markup.indexOf("staple-row-status");
    const pickup = markup.indexOf('data-testid="row-pickup-cue"');
    const milestone = markup.indexOf('data-testid="row-milestone-cue"');
    const title = markup.indexOf('class="staple-row-title"');

    // Immediately right of the identifier and status cluster — "near the identifier", in
    // the one track that can take an aside without a new grid column.
    expect(status).toBeLessThan(pickup);
    expect(pickup).toBeLessThan(milestone);
    expect(milestone).toBeLessThan(title);
    expect(markup.indexOf("staple-row-title-cell")).toBeLessThan(pickup);
    expect(pickup).toBeLessThan(markup.indexOf("staple-row-meta"));
  });

  it("says `next` on the one row the resolver would hand out, with the word in both places", () => {
    const markup = renderCued("STA-1");
    const sentence = `Pickable — ${ROW_CUE_PRESENTATION.pickable.hint} Queue position 1.`;

    expect(markup).toContain('data-pickup-cue="pickable"');
    expect(markup).toContain(`title="${sentence}"`);
    expect(markup).toContain(`<span class="sr-only">${sentence}</span>`);
    expect(markup).toContain(ROW_CUE_PRESENTATION.pickable.glyph);
    expect(markup).toContain("next");
  });

  it("gives a queued actionable row its effective number and a blocked row its reason", () => {
    const queued = renderCued("STA-2");
    expect(queued).toContain('data-pickup-cue="queued"');
    expect(queued).toContain('data-cue-position="2"');
    expect(queued).toContain('data-cue-scope="effective"');
    expect(queued).toContain("#2");

    const blocked = renderCued("STA-3");
    expect(blocked).toContain('data-pickup-cue="waiting"');
    // The resolver's own sentence, not a second derivation in the browser.
    expect(blocked).toContain("STA-3 is blocked by STA-1.");
    // No number: a blocked row's place in the order is not what a reader needs from it.
    expect(blocked).not.toContain("data-cue-position");
  });

  it("gives a queued CONTAINER the plan number, spelled out so it cannot be misread", () => {
    const markup = renderCued("STA-9", { id: "epic", kind: "epic" });

    expect(markup).toContain('data-pickup-cue="queued"');
    expect(markup).toContain('data-cue-scope="plan"');
    expect(markup).toContain("plan #2");
    expect(markup).toContain("Plan position 2.");
  });

  it("is distinguishable by glyph and word, never by colour", () => {
    // Every state renders its own glyph, and the sentence LEADS with the word — the two
    // channels WCAG 1.4.1 allows. Nothing in the markup carries a hue.
    for (const state of ROW_CUE_STATES) {
      const cue = { state, position: null, scope: "effective" as const, reason: null };
      const markup = renderToStaticMarkup(<PickupCue cue={cue} />);

      expect(markup, state).toContain(ROW_CUE_PRESENTATION[state].glyph);
      expect(markup, state).toContain(`${ROW_CUE_PRESENTATION[state].label} —`);
      expect(markup, state).toContain(`data-pickup-cue="${state}"`);
      expect(markup, state).not.toContain("color");
      expect(markup, state).not.toContain("style=");
    }
  });

  it("makes the milestone marker a real control that names where it goes", () => {
    const markup = renderCued("STA-1");
    const sentence = "Planned under milestone STA-50: Q4 launch — open the milestone plan";

    expect(markup).toContain('data-milestone="STA-50"');
    expect(markup).toContain(`aria-label="${sentence}"`);
    expect(markup).toContain(`title="${sentence}"`);
    // A button, so it is reachable by keyboard; the pickup cue is a span, because the list
    // reads the queue and may never write it.
    expect(markup).toContain('<button type="button" class="staple-row-milestone"');
    expect(markup).toContain(MILESTONE_CUE_GLYPH);
  });

  it("adds no height: two inline spans in the title track, no style, no block box", () => {
    for (const density of ["comfortable", "compact"] as const) {
      const markup = renderCued("STA-1", {}, density);
      const cue = /<span class="staple-row-cue"[\s\S]*?<\/span><\/span>/.exec(markup)![0];

      expect(cue.startsWith("<span "), density).toBe(true);
      expect(cue, density).not.toContain("style=");
      expect(cue, density).not.toContain("<div");
      // The density preset is unchanged by the presence of the cue — the row's height is
      // `.staple-row`'s and nothing here touches it.
      expect(markup, density).toContain(`data-density="${density}"`);
    }
  });

  it("leaves every density preset's row height exactly where it was", () => {
    // The structural half of "all density presets keep the existing row height". The three
    // declarations are the default, the coarse-pointer target and the compact preset (plus
    // its own coarse-pointer value) — the same four the sheet shipped with before R4c, and
    // no cue rule adds a fifth.
    const CSS = readFileSync(
      fileURLToPath(new URL("./task-list.css", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    expect(CSS.match(/--row-height:\s*[^;]+;/g)).toEqual([
      "--row-height: 36px;",
      "--row-height: 44px;",
      "--row-height: 28px;",
      "--row-height: 36px;",
    ]);
    // And no cue rule sets a box that could grow the line beyond the 13px title beside it.
    const cueRules = CSS.split("}")
      .filter((rule) => /\.staple-row-(cue|milestone)\b/.test(rule.split("{")[0] ?? ""))
      .join("}");
    expect(cueRules).not.toMatch(/(^|[^-])height:/);
    expect(cueRules).not.toMatch(/padding/);
    expect(cueRules).not.toMatch(/border/);
    expect(cueRules).toContain("font-size: 11px");
  });

  it("leaves the grouped shapes untouched — no join, no cue", () => {
    // TreeView fetches the queue only in the ungrouped shape, so a grouped row is built
    // from sources that were never joined. This is what that produces.
    const rows = [
      row({ id: "epic", identifier: "STA-9", kind: "epic", status: "backlog" }),
      row({ id: "a", identifier: "STA-1", status: "in_progress", parentId: "epic" }),
    ];
    const group = buildGroups(rows, { isExpanded: () => true, rollupSource: rows }).find(
      (g) => g.status === "in_progress",
    )!;

    for (const built of group.rows) {
      const markup = renderToStaticMarkup(
        <TaskRowLine row={built} config={resolveTaskListConfig("tree", { labelMax: 2 })} semantics="grid" isExpanded now={NOW} />,
      );
      expect(markup).not.toContain("row-pickup-cue");
      expect(markup).not.toContain("row-milestone-cue");
    }
  });

  it("gives a ghost no cue — a bracket around rows is not a row an agent could take", () => {
    const rows = attachRowCues(
      [
        row({ id: "epic", identifier: "STA-9", kind: "epic", status: "backlog" }),
        row({ id: "b", identifier: "STA-2", status: "in_progress", parentId: "epic" }),
      ],
      buildRowCueIndex(QUEUE, TITLES),
    );
    const group = buildGroups(rows, { isExpanded: () => true, rollupSource: rows }).find(
      (g) => g.status === "in_progress",
    )!;
    const ghost = group.rows.find((line) => line.ghost)!;

    expect(ghost.cues).toBeNull();
  });
});
