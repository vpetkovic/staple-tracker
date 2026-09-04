/**
 * STA-175 (R3e) — the Milestones view against a REAL server payload.
 *
 * WHAT "BROWSER TEST" MEANS HERE. There is no jsdom in this repo, no screenshot harness,
 * and no new dependency was added for this file. A browser test is the real HTTP server
 * (`src/ui/server.ts`, started in this process) serving the real scenario workspace
 * (`test/fixtures/milestones-scenario.ts`), and the real view components rendered to
 * markup with `react-dom/server` — the same technique `milestones-render.test.tsx` and
 * `components/task-list/row-render.test.tsx` use. Nothing here is a hand-written fixture:
 * every number, identifier, order and date in the assertions came off the wire.
 *
 * WHY THE PANES AND NOT `<MilestonesView/>` ITSELF. The exported top-level component
 * reads `window.innerWidth` and the app-wide session, neither of which exists without a
 * DOM. So this file composes the SAME three exported pieces that `MilestonesView`
 * composes — `MilestonesLayout` around `MilestoneListPane` and `MilestoneDetailPane`,
 * with `memberListRows` and `sortMilestones` deriving their props exactly as it does —
 * and drives the layout through `layoutFor(width)`, which is the function
 * `MilestonesView`'s own `useLayout` calls. Everything the component owns above that is
 * fetch plumbing, and this file does that plumbing against the real routes.
 *
 * WHY THE TWO DYNAMIC IMPORTS. The Node-side modules (the server, the fixture builder)
 * are compiled by the ROOT tsconfig; pulling them into the browser app's program with a
 * static import would typecheck `src/core/**` under the app's stricter options and fail
 * on code this ticket does not own. A dynamic `import()` of an absolute URL keeps them
 * out of the app's program and still runs the real thing.
 *
 * WHAT IT PINS: the list and the detail drawn from the wire at narrow, split and
 * full-screen; the accessible row order matching the server's member order; a name on
 * every reorder control; status legible as glyph AND word with the glyph hidden from a
 * screen reader; the keyboard move and the button move being one computation, accepted
 * verbatim by the real store; and the conflict banner after a genuinely stale reorder.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeRefusal } from "@/lib/refusal";
import type { IssueRow, MilestoneListRow, MilestoneState, MilestoneView } from "@/lib/types";
import {
  MilestoneDetailPane,
  MilestoneListPane,
  MilestonesLayout,
  StateBadge,
  type MemberWriteFailure,
} from "./MilestonesView";
import {
  layoutFor,
  memberListRows,
  movedOrder,
  sortMilestones,
  SPLIT_MIN_WIDTH_PX,
  STATE_PRESENTATION,
} from "./milestones-model";

/** Load a module the ROOT tsconfig owns, without dragging it into this program. */
const nodeSide = async (path: string): Promise<any> => import(/* @vite-ignore */ new URL(path, import.meta.url).href);

/** The store's own code for a stale base; `lib/api.ts` names it REVISION_CONFLICT_CODE. */
const REVISION_CONFLICT = "revision_conflict";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};
/** Below Tailwind's `md`, and comfortably above it — the two ends of `layoutFor`. */
const NARROW_PX = 420;
const WIDE_PX = 1280;

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let ws: string;
/** Everything the page loads: the list, the two details, and the issue list it indents from. */
let list: MilestoneListRow[];
let issues: IssueRow[];
let october: MilestoneView;
let november: MilestoneView;
let refs: Record<string, string>;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json" },
    body: JSON.stringify({ ws, actor: "r3e-browser", ...body }),
  });
  return { status: response.status, body: await response.json() };
}

async function reload(): Promise<void> {
  list = await get<MilestoneListRow[]>(`/api/milestones?ws=${ws}&all=1`);
  issues = await get<IssueRow[]>(`/api/issues?ws=${ws}`);
  october = await get<MilestoneView>(`/api/milestone?ws=${ws}&ref=${refs.october}`);
  november = await get<MilestoneView>(`/api/milestone?ws=${ws}&ref=${refs.november}`);
}

/** The detail pane exactly as `MilestonesView` builds it: view + memberListRows + now. */
function renderDetail(view: MilestoneView, over: Partial<Parameters<typeof MilestoneDetailPane>[0]> = {}): string {
  return renderToStaticMarkup(
    <MilestoneDetailPane
      view={view}
      members={memberListRows(view, issues, ws)}
      now={NOW}
      busy={false}
      failure={null}
      fullScreen={false}
      onToggleFullScreen={noop}
      onOpen={noop}
      onMove={noop}
      onRemove={noop}
      onAdd={noop}
      onReload={noop}
      onDismissFailure={noop}
      {...over}
    />,
  );
}

function renderList(selected: string | null): string {
  return renderToStaticMarkup(
    <MilestoneListPane rows={sortMilestones(list)} selectedRef={selected} onSelect={noop} />,
  );
}

/** The whole page at a viewport width, the way `MilestonesView` assembles it. */
function renderPage(widthPx: number, selected: MilestoneView | null, fullScreen = false): string {
  const layout = layoutFor(widthPx);
  return renderToStaticMarkup(
    <MilestonesLayout
      layout={layout}
      fullScreen={fullScreen}
      hasSelection={selected !== null}
      list={<MilestoneListPane rows={sortMilestones(list)} selectedRef={selected?.milestone.identifier ?? null} onSelect={noop} />}
      detail={selected ? <MilestoneDetailPane
        view={selected}
        members={memberListRows(selected, issues, ws)}
        now={NOW}
        busy={false}
        failure={null}
        fullScreen={fullScreen}
        onToggleFullScreen={noop}
        onOpen={noop}
        onMove={noop}
        onRemove={noop}
        onAdd={noop}
        onReload={noop}
        onDismissFailure={noop}
      /> : null}
      onBack={noop}
    />,
  );
}

/** Every member/child row in the order the markup puts it — the accessible tree's order. */
function rowOrder(html: string): string[] {
  return [...html.matchAll(/data-milestone-member="([^"]+)"/g)].map((match) => match[1]!);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ms-ui-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const scenario = await nodeSide("../../../../../../test/fixtures/milestones-scenario.ts");
  const { startUiServer } = await nodeSide("../../../../server.ts");
  scenario.seedScenarioWorkspace(home);
  ws = scenario.SCENARIO_WS;
  refs = scenario.SCENARIO;

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  await reload();
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------- the payload

describe("the page draws what the server sent", () => {
  it("lists both plans in plan order, with the server's own dates, progress and next work", () => {
    const html = renderList(refs.october!);

    // Plan position beats the target date, and `sortMilestones` is what orders it.
    expect(rowsInOrder(html)).toEqual([refs.november, refs.october]);
    expect(html).toContain("November cut");
    expect(html).toContain("October cut");
    // Every number below is the store's, not a fixture's: October counts five leaves,
    // one cancelled, one done — 1/4 at 25% — and its queue answer is MSC-3 at #4.
    expect(october.progress).toMatchObject({ total: 5, countable: 4, percent: 25 });
    expect(html).toContain("1/4 done · 25%");
    expect(html).toContain(`next: ${october.next!.identifier} (#${october.next!.position})`);
    expect(html).toContain(`target ${october.milestone.targetDate}`);
    expect(html).toContain(`plan #${october.milestone.planPosition}`);
    // The four members October reported, said as a count.
    expect(html).toContain(`${list.find((row) => row.milestone.identifier === refs.october)!.memberCount} members`);
    // Selection is announced, not merely coloured.
    expect(html).toContain(`data-milestone-row="${refs.october}"`);
    expect(html).toMatch(new RegExp(`data-milestone-row="${refs.october}"[^>]*aria-current="true"`));
  });

  it("draws the detail's members and their epic's children from the same payload", () => {
    const html = renderDetail(october);
    expect(html).toContain(`data-milestone-detail="${refs.october}"`);
    expect(html).toContain(`start ${october.milestone.startDate}`);
    expect(html).toContain(`target ${october.milestone.targetDate}`);
    // The note the member was added with, verbatim from the store.
    expect(html).toContain("pull the surfaces forward");
    // The rollups are the store's counts, and the blocked/gated cells are the ones
    // `docs/milestones.md` records as under-reporting (see the `it.todo` below).
    expect(html).toContain("data-milestone-rollups");
    expect(html).toContain("1/4 done · 25%");

    // Four direct members, and the member epic's own remaining child indented under it.
    expect(html.match(/data-member-role="member"/g)).toHaveLength(october.members.length);
    expect(html).toContain(`data-milestone-member="${refs.q1}"`);
    expect(html).toContain('data-member-role="child"');
  });

  it("stacks below the md breakpoint, splits above it, and gives the detail the box in full screen", () => {
    expect(layoutFor(NARROW_PX)).toBe("stacked");
    expect(layoutFor(SPLIT_MIN_WIDTH_PX)).toBe("split");
    expect(layoutFor(WIDE_PX)).toBe("split");

    // Narrow, nothing selected: the list alone.
    const narrowList = renderPage(NARROW_PX, null);
    expect(narrowList).toContain('data-milestones-layout="stacked"');
    expect(narrowList).toContain('data-milestones-pane="list"');
    expect(narrowList).not.toContain('data-milestones-pane="detail"');
    expect(narrowList).toContain("November cut");

    // Narrow, a plan selected: the detail alone, with the way back.
    const narrowDetail = renderPage(NARROW_PX, october);
    expect(narrowDetail).toContain('data-milestones-pane="detail"');
    expect(narrowDetail).not.toContain('data-milestones-pane="list"');
    expect(narrowDetail).toContain("Back to milestones");
    expect(rowOrder(narrowDetail)).toEqual(rowOrder(renderDetail(october)));

    // Split: both panes, no Back — the list is still on screen to go back to.
    const split = renderPage(WIDE_PX, october);
    expect(split).toContain('data-milestones-layout="split"');
    expect(split).toContain('data-milestones-pane="list"');
    expect(split).toContain('data-milestones-pane="detail"');
    expect(split).not.toContain("Back to milestones");

    // Full screen: the detail owns the box at EITHER width, and says it is expanded.
    for (const width of [NARROW_PX, WIDE_PX]) {
      const full = renderPage(width, october, true);
      expect(full).toContain('data-full-screen="true"');
      expect(full).not.toContain('data-milestones-pane="list"');
      expect(full).toContain('aria-label="Collapse from full screen"');
      expect(full).toContain('aria-pressed="true"');
    }
    expect(renderPage(WIDE_PX, october)).toContain('aria-label="Expand to full screen"');
  });
});

// -------------------------------------------------------- the accessible tree

describe("the accessible tree", () => {
  it("puts the member rows in the server's order, with the epic's children under it", () => {
    const order = rowOrder(renderDetail(october));
    // The direct members, in the order the store returned them…
    expect(order.filter((identifier) => october.members.some((member) => member.identifier === identifier))).toEqual(
      october.members.map((member) => member.identifier),
    );
    // …and the member epic's own open child immediately after it, indented rather
    // than folded, so a screen reader walks the plan in the order it will be worked.
    const epicAt = order.indexOf(refs.queueEpic!);
    expect(order[epicAt + 1]).toBe(refs.q1);
    // Nothing is drawn twice: MSC-4 is a member AND a child of member 1, and appears once.
    expect(new Set(order).size).toBe(order.length);
  });

  it("names every control after the member it acts on, and disables only the true edges", () => {
    const html = renderDetail(october);
    const members = october.members.map((member) => member.identifier);
    for (const identifier of members) {
      expect(html, identifier).toContain(`aria-label="Open ${identifier}"`);
      expect(html, identifier).toContain(`aria-label="Move ${identifier} up"`);
      expect(html, identifier).toContain(`aria-label="Move ${identifier} down"`);
      expect(html, identifier).toContain(`aria-label="Remove ${identifier} from this milestone"`);
    }
    // The first member cannot move up and the last cannot move down; nothing else
    // is disabled, which is the same edge `movedOrder` refuses to compute.
    expect(html).toMatch(new RegExp(`aria-label="Move ${members[0]} up"[^>]*disabled=""`));
    expect(html).toMatch(new RegExp(`aria-label="Move ${members.at(-1)} down"[^>]*disabled=""`));
    expect(html).not.toMatch(new RegExp(`aria-label="Move ${members[0]} down"[^>]*disabled=""`));

    // A child is context, not plan: it gets Open and nothing that would rewrite an order.
    expect(html).toContain(`aria-label="Open ${refs.q1}"`);
    expect(html).not.toContain(`aria-label="Move ${refs.q1} up"`);
    expect(html).not.toContain(`aria-label="Remove ${refs.q1} from this milestone"`);

    // The add form and the progress bar are named too — a screen reader gets a label
    // for every interactive thing on the pane, not just the buttons.
    expect(html).toContain('aria-label="Identifier to add"');
    expect(html).toContain('aria-label="Note for the new member"');
    expect(renderList(refs.october!)).toContain('aria-label="Progress"');
    expect(renderList(refs.october!)).toContain('aria-label="Milestones"');
  });

  it("announces a milestone's status as a word, with the glyph present but hidden", () => {
    // The two real states in the payload, off the wire.
    expect([october.milestone.state, november.milestone.state]).toEqual(["active", "planned"]);
    const html = renderList(refs.october!);
    for (const state of [october.milestone.state, november.milestone.state]) {
      expect(html).toContain(`data-milestone-state="${state}"`);
      expect(html).toContain(STATE_PRESENTATION[state].label);
    }

    // Every state, in isolation: a glyph AND a word, the glyph aria-hidden so the
    // screen reader hears the word, and no two states sharing either one. Colour is
    // therefore never the only carrier of the status (WCAG 1.4.1).
    const glyphs = new Set<string>();
    const words = new Set<string>();
    for (const state of Object.keys(STATE_PRESENTATION) as MilestoneState[]) {
      const { glyph, label } = STATE_PRESENTATION[state];
      const badge = renderToStaticMarkup(<StateBadge state={state} />);
      expect(badge).toContain(`data-milestone-state="${state}"`);
      expect(badge, state).toContain(`<span aria-hidden="true" class="font-mono">${glyph}</span>`);
      expect(badge, state).toContain(label);
      glyphs.add(glyph);
      words.add(label);
    }
    expect(glyphs.size).toBe(Object.keys(STATE_PRESENTATION).length);
    expect(words.size).toBe(Object.keys(STATE_PRESENTATION).length);

    // "Every member landed but nobody closed the plan" is said in words too.
    expect(renderToStaticMarkup(<StateBadge state="active" complete />)).toContain("all members done");
  });
});

// -------------------------------------------------------------- reordering

describe("reordering members", () => {
  it("computes one move for the buttons and the Alt+Arrow keys, and the store takes it verbatim", async () => {
    const members = october.members.map((member) => member.identifier);
    // The keyboard handler on each member row and its two buttons call the same
    // `onMove(from, to)`, which goes through `movedOrder` — so proving the function
    // proves both paths. At the edges it returns null, which is why the edge buttons
    // are disabled: a move that would change nothing never becomes a write.
    expect(movedOrder(october.members, 0, -1)).toBeNull();
    expect(movedOrder(october.members, members.length - 1, members.length)).toBeNull();
    expect(movedOrder(october.members, 1, 1)).toBeNull();

    const order = movedOrder(october.members, 1, 0)!;
    expect(order).toEqual([members[1], members[0], ...members.slice(2)]);

    // The real route, with the revision the page actually holds.
    const written = await post("/api/milestone/reorder", {
      milestone: refs.october,
      order,
      baseRevision: october.revision,
    });
    expect(written.status).toBe(200);
    // A writer redraws from its own result, exactly as a reader does.
    const after = written.body as MilestoneView;
    expect(after.members.map((member) => member.identifier)).toEqual(order);
    expect(after.revision).toBe(october.revision + 1);
    // And the accessible order followed the store, without a re-read.
    const html = renderDetail(after);
    expect(rowOrder(html).filter((identifier) => order.includes(identifier))).toEqual(order);
    // The edge that moved is the edge that is disabled now.
    expect(html).toMatch(new RegExp(`aria-label="Move ${order[0]} up"[^>]*disabled=""`));

    // Put the plan back and re-read, so the conflict case below starts from the store.
    const restored = await post("/api/milestone/reorder", {
      milestone: refs.october,
      order: members,
      baseRevision: after.revision,
    });
    expect(restored.status).toBe(200);
    await reload();
    expect(october.members.map((member) => member.identifier)).toEqual(members);
  });

  it("shows a genuinely stale reorder as a conflict, in the store's own words, with the order untouched", async () => {
    const order = movedOrder(october.members, 0, 1)!;
    // Somebody else moved first: the page's revision is now one behind.
    const theirs = await post("/api/milestone/reorder", {
      milestone: refs.october,
      order,
      baseRevision: october.revision,
    });
    expect(theirs.status).toBe(200);

    // Our write, with the base we still believe in.
    const ours = await post("/api/milestone/reorder", {
      milestone: refs.october,
      order: october.members.map((member) => member.identifier),
      baseRevision: october.revision,
    });
    expect(ours.status).toBe(409);
    expect(ours.body.code).toBe(REVISION_CONFLICT);

    // The page turns the envelope into a failure exactly as `MilestonesView` does.
    const failure: MemberWriteFailure = {
      kind: ours.body.code === REVISION_CONFLICT ? "conflict" : "refusal",
      refusal: describeRefusal(ours.body),
    };
    expect(failure.refusal.fromServer).toBe(true);

    const html = renderDetail(october, { failure });
    expect(html).toContain("data-milestone-conflict");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Member order changed elsewhere.");
    // The store's sentence, verbatim — the banner never paraphrases a guard.
    expect(html).toContain(ours.body.message);
    // That sentence names both revisions — the one the store is at and the one we sent —
    // which is what makes "reload and retry" actionable rather than an apology.
    expect(ours.body.message).toContain(`at revision ${theirs.body.revision}, not ${october.revision}`);
    expect(html).toContain("Reload");
    // A conflict is not a refusal: the guard-refusal presentation stays away.
    expect(html).not.toContain("data-guard-refusal");

    // And the refused write changed nothing: the server still holds THEIR order.
    const server = await get<MilestoneView>(`/api/milestone?ws=${ws}&ref=${refs.october}`);
    expect(server.members.map((member) => member.identifier)).toEqual(order);
  });

  /**
   * DEFECT, recorded rather than fixed (R3e touches no `src/**`).
   *
   * `milestoneRisk` reads `progress.counts.blocked` and `progress.counts.gated`, which
   * are STATUS-CATEGORY counts of the milestone's leaves. But staple does not move a
   * status when work is blocked or gated: a blocker lives in the blocker table and an
   * approval gate queues the descendants through `queuedBy`, leaving both at whatever
   * status they had. On this fixture October has one genuinely blocked leaf and November
   * has two genuinely gated ones, and both risk lines read zero — so the rollups and the
   * "⊘ n blocked / ◇ n gated" cues are silent exactly when they matter.
   *
   * docs/milestones.md already says the right answer: "Blocked and gated are not
   * milestone states — they are facts about members, which the view shows per row FROM
   * THE QUEUE'S ELIGIBILITY." The fix is to count the queue's `eligibility` over the
   * rows whose `milestonePath` names this milestone, rather than the status categories.
   */
  it.todo("counts blocked and gated members from the queue's eligibility, not from status categories");
});

/** The list rows in the order the markup puts them. */
function rowsInOrder(html: string): string[] {
  return [...html.matchAll(/data-milestone-row="([^"]+)"/g)].map((match) => match[1]!);
}
