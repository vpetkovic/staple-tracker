/**
 * "A CUSTOM STATUS RENDERS CORRECTLY" — STA-141's acceptance criterion, made executable.
 *
 * The criterion says the icon and the colour must resolve from the CATEGORY, so a
 * workspace that invents `pairing` in `active` gets the in_progress half-ring and the
 * in_progress hue. There is exactly one way to be sure of that and it is to render the
 * component against a vocabulary that contains no built-in id at all — a test written
 * against `in_progress` would keep passing for a component that had kept the id switch.
 *
 * Rendered to a string with `react-dom/server`, the pattern
 * `components/task-list/row-render.test.tsx` established: every claim below is about which
 * elements exist, what their accessible names say, and which CSS custom property the
 * markup names. Colour resolution itself is CSS and belongs to styles/app.css, which is
 * why the assertions are on `data-status-category` and on the `var(--status-task-icon-…)`
 * the glyph reaches for — those are the two contracts the sheet keys on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge, StatusDot } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { publishWorkspaceSettings, resetWorkspaceSettings } from "@/lib/settings";
import { STATUS_CATEGORIES } from "@/lib/types";
import type { StatusCategory, WorkspaceSettings, WorkspaceStatus } from "@/lib/types";

const status = (id: string, category: StatusCategory, label: string): WorkspaceStatus => ({
  id,
  label,
  category,
  sortOrder: 0,
  isBuiltin: false,
});

/**
 * A workspace with NO built-in status id in it. Every assertion below would also pass
 * against a component that keyed on `in_progress`; none of them pass against one that
 * keys on `pairing`, which is the point of renaming everything away.
 */
const CUSTOM: WorkspaceStatus[] = [
  status("icebox", "unstarted", "Icebox"),
  status("queued", "ready", "Queued"),
  status("pairing", "active", "Pairing"),
  status("checking", "review", "Checking"),
  status("awaiting_signoff", "gated", "Awaiting Signoff"),
  status("stuck", "blocked", "Stuck"),
  status("shipped", "done", "Shipped"),
  status("dropped", "cancelled", "Dropped"),
];

function publish(statuses: WorkspaceStatus[]): void {
  const ids = statuses.map((s) => s.id);
  const settings: WorkspaceSettings = {
    workspace: "custom",
    statuses,
    kinds: [],
    groupOrder: ids,
    openOrder: ids,
    pickupOrder: ids,
    categories: [...STATUS_CATEGORIES],
    requiredCategories: ["unstarted", "ready", "active", "blocked", "done", "cancelled"],
    usage: { statuses: {}, kinds: {} },
  };
  publishWorkspaceSettings(settings);
}

afterEach(() => resetWorkspaceSettings());

describe("StatusIcon resolves the glyph from the category", () => {
  it("a custom ACTIVE status draws the in_progress half-ring in the in_progress hue", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusIcon status="pairing" />);
    // The half-ring wedge, verbatim from the built-in in_progress glyph.
    expect(html).toContain("M8 8 L8 4 A4 4 0 0 1 8 12 Z");
    expect(html).toContain("var(--status-task-icon-in_progress)");
    // And it is NAMED by the configured label, not by the id.
    expect(html).toContain("Status: Pairing");
  });

  it("a custom REVIEW status draws the three-quarter ring", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusIcon status="checking" />);
    expect(html).toContain("M8 8 L8 4 A4 4 0 1 1 4 8 Z");
    expect(html).toContain("var(--status-task-icon-in_review)");
  });

  it("a custom UNSTARTED status keeps the dashed ring, a READY one the plain ring", () => {
    publish(CUSTOM);
    const icebox = renderToStaticMarkup(<StatusIcon status="icebox" />);
    const queued = renderToStaticMarkup(<StatusIcon status="queued" />);
    expect(icebox).toContain("stroke-dasharray");
    expect(icebox).toContain("var(--status-task-icon-backlog)");
    expect(queued).not.toContain("stroke-dasharray");
    expect(queued).toContain("var(--status-task-icon-todo)");
  });

  /**
   * The progress ring has to keep reading as a ring that fills up, whatever the statuses
   * are called. Each of the four stops differs from the next in SHAPE — WCAG 1.4.1, and
   * the reason the icon set works at 16px in the first place.
   */
  it("the four progress stops all differ, on a workspace with no built-in ids", () => {
    publish(CUSTOM);
    const rendered = ["icebox", "queued", "pairing", "checking", "shipped"].map((id) =>
      renderToStaticMarkup(<StatusIcon status={id} />),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  /**
   * `gated` shares blocked's HUE (no new tokens) and must not share its shape: an
   * approval you are waiting on and a blocker you are waiting on are two different
   * answers to "why has this not moved".
   */
  it("gated borrows blocked's hue and keeps its own shape", () => {
    publish(CUSTOM);
    const gated = renderToStaticMarkup(<StatusIcon status="awaiting_signoff" />);
    const blocked = renderToStaticMarkup(<StatusIcon status="stuck" />);
    expect(gated).toContain("var(--status-task-icon-blocked)");
    expect(blocked).toContain("var(--status-task-icon-blocked)");
    expect(gated).not.toBe(blocked);
    // Blocked fills the disc (r=7); gated is a ring (r=6) with the same bar.
    expect(blocked).toContain('r="7"');
    expect(gated).toContain('r="6"');
  });

  /**
   * An id the vocabulary has never heard of — a status another process added a second
   * ago — draws as `unstarted` rather than as nothing. A blank status column is the one
   * outcome a render path must not produce.
   */
  it("an unknown id falls back to the unstarted glyph instead of drawing nothing", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusIcon status="added_in_another_tab" />);
    expect(html).toContain("stroke-dasharray");
    expect(html).toContain("Status: Added In Another Tab");
  });

  /** The editor previews a category the store has not been told about yet. */
  it("an explicit category overrides the lookup, for the settings editor's preview", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusIcon status="icebox" category="active" />);
    expect(html).toContain("var(--status-task-icon-in_progress)");
  });

  /** The shipped default must not move. */
  it("a default workspace renders exactly what V5 shipped", () => {
    const html = renderToStaticMarkup(<StatusIcon status="in_progress" />);
    expect(html).toContain("M8 8 L8 4 A4 4 0 0 1 8 12 Z");
    expect(html).toContain("var(--status-task-icon-in_progress)");
    expect(html).toContain("Status: In Progress");
  });
});

describe("StatusBadge carries the category the stylesheet keys on", () => {
  it("emits data-status-category alongside data-status, and prints the label", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusBadge status="pairing" />);
    expect(html).toContain('data-status="pairing"');
    expect(html).toContain('data-status-category="active"');
    expect(html).toContain("Pairing");
  });

  /**
   * A RECATEGORISED built-in is the case the two attributes exist to settle: app.css puts
   * the category rules after the id rules at equal specificity, so `in_review` moved into
   * `active` paints blue rather than staying on the hue its id used to imply.
   */
  it("a recategorised built-in reports its new category", () => {
    publish([status("in_review", "active", "In Review")]);
    const html = renderToStaticMarkup(<StatusBadge status="in_review" />);
    expect(html).toContain('data-status="in_review"');
    expect(html).toContain('data-status-category="active"');
  });

  it("StatusDot does the same, and names itself by the label", () => {
    publish(CUSTOM);
    const html = renderToStaticMarkup(<StatusDot status="shipped" />);
    expect(html).toContain('data-status-category="done"');
    expect(html).toContain('aria-label="Shipped"');
  });
});
