/**
 * The Overview against REAL server payloads.
 *
 * As `views/budget/budget-e2e.test.tsx`: the real HTTP server (`src/ui/server.ts`, in this
 * process, hub mode) serves workspaces written through the real store, and the real components
 * are rendered from what came off the wire with `react-dom/server`. No payload is hand-written:
 * every figure the assertions name is read from the response.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCount, formatMultiple } from "@/components/analytics/format";
import type { AnalyticsReport, RoiResponse } from "@/lib/analytics-api";
import { PageState } from "./AnalyticsView";
import { OverviewBoard } from "./OverviewBoard";
import { EstimatesWidget, PageNotes } from "./overview-parts";
import { caveatOf, caveatSentence, isEmptyScope, OVERVIEW_CAVEATS } from "./overview-data";
import { setClock } from "../../../../../core/types.ts";
import { initWorkspace } from "../../../../../core/workspace.ts";
import { startUiServer } from "../../../../server.ts";

const T0 = Date.parse("2026-09-01T13:00:00.000Z");
const PERIOD = "from=2026-09-01&to=2026-09-07&tz=UTC";
const ORDER = ["alpha", "beta", "empty"];

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let hub: AnalyticsReport;
let roi: RoiResponse;
let alpha: AnalyticsReport;
let alphaAllTime: AnalyticsReport;
let empty: AnalyticsReport;
const previousHome = process.env.STAPLE_HOME;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-overview-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  let clock = T0;
  setClock(() => clock);
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);

  // alpha's first ticket, eleven years back: longer ago than one read covers.
  const a = initWorkspace({ global: true, slug: "alpha" }).store;
  clock = Date.parse("2015-06-01T12:00:00.000Z");
  a.createIssue({ title: "The first idea" });

  // alpha: one feature (an epic of two tickets, one estimated, one worked with no model logged),
  // and a bug closed on import, with no agent and no estimate.
  at(0);
  const epic = a.createIssue({ title: "[EPIC-1] Checkout flow", kind: "epic" }).id;
  const first = a.createIssue({ title: "Card form", parent: epic, estimatedSeconds: 4 * 3600 }).id;
  const second = a.createIssue({ title: "Receipt email", parent: epic }).id;
  a.checkoutIssue(first, "alpha-worker", undefined, { attempt: { harness: "claude_code", model: "claude-opus-5-5" } });
  at(60);
  a.updateIssue(first, { status: "done" }, "alpha-worker");
  at(120);
  a.checkoutIssue(second, "alpha-helper");
  at(150);
  a.updateIssue(second, { status: "done" }, "alpha-helper");
  at(160);
  a.updateIssue(epic, { status: "done" }, "user");
  at(200);
  const bug = a.createIssue({ title: "Fix a typo", kind: "bug" }).id;
  a.updateIssue(bug, { status: "done" }, "user");
  a.db.close();

  // beta: one estimated task worked by a harness that did not log its model.
  const b = initWorkspace({ global: true, slug: "beta" }).store;
  at(1440);
  const task = b.createIssue({ title: "Write the guide", estimatedSeconds: 2 * 3600 }).id;
  b.checkoutIssue(task, "beta-worker", undefined, { attempt: { harness: "codex" } });
  at(1440 + 90);
  b.updateIssue(task, { status: "done" }, "beta-worker");
  b.db.close();

  // empty: registered, nothing in it. ghost: registered, its database gone.
  initWorkspace({ global: true, slug: "empty" }).store.db.close();
  const ghost = initWorkspace({ global: true, slug: "ghost" });
  ghost.store.db.close();
  rmSync(ghost.dbPath, { force: true });
  setClock(null);

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  hub = await get(`/api/analytics?scope=hub&${PERIOD}`);
  roi = await get(`/api/analytics/roi?scope=hub&${PERIOD}`);
  alpha = await get(`/api/analytics?scope=alpha&${PERIOD}`);
  empty = await get("/api/analytics?scope=empty&to=2026-09-07&tz=UTC");
  alphaAllTime = await get("/api/analytics?scope=alpha&to=2026-09-07&tz=UTC");
}, 60_000);

afterAll(() => {
  ui?.close();
  setClock(null);
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const board = (report: AnalyticsReport, answer: RoiResponse | null | undefined = roi): string =>
  renderToStaticMarkup(<OverviewBoard report={report} roi={answer} order={ORDER} onOpenReturn={() => {}} onOpenEstimates={() => {}} onOpenTicket={() => {}} />);

describe("the Overview drawn from the hub's answer", () => {
  it("leads with the period's figures as the server counted them", () => {
    expect(hub.headline.done).toBeGreaterThanOrEqual(4);
    expect(hub.headline.epicsDone).toBe(1);
    const html = text(board(hub));
    expect(html).toContain(`Features shipped ${hub.headline.epicsDone}`);
    expect(html).toContain(`${hub.headline.done} tickets closed, ${hub.headline.bugsFixed} of them bug fixes.`);
    expect(html).toContain(`Agent capacity ${formatCount(hub.headline.agentHours)} h`);
    expect(html).toContain(`of ${hub.reliability.started - hub.reliability.outcomes.open} finished attempts did the job.`);
    // The feature table names the epic without its tracker tag.
    expect(html).toContain("Checkout flow");
    expect(html).not.toContain("[EPIC-1]");
  });

  it("puts each caveat on the widget it limits, and every one under How this is measured", () => {
    const withoutTime = caveatOf(hub, "done_without_agent_time");
    expect(withoutTime, JSON.stringify(hub.caveats)).not.toBeNull();
    const html = board(hub);
    // The features' agent time rests on the tickets that have any: the note sits on that widget.
    expect(text(html)).toContain(`Partial: ${withoutTime!.of! - withoutTime!.count} of ${withoutTime!.of} finished tickets have agent time`);
    const spoken = OVERVIEW_CAVEATS.filter((code) => caveatOf(hub, code) !== null);
    expect(spoken).toEqual(expect.arrayContaining(["done_without_agent_time", "estimates_partial", "no_model", "closed_on_import"]));
    for (const code of spoken) {
      expect(html, code).toContain(`data-method-caveat="${code}"`);
      expect(text(html)).toContain(caveatSentence(caveatOf(hub, code)!, hub));
    }
  });

  it("says the Return figure as the ROI route priced it, and marks default rates as assumed", () => {
    const html = text(board(hub));
    expect(html).toContain("Return on AI spend");
    expect(roi.measured.returnOnTotalCost).not.toBeNull();
    // The figure itself: both counts as the route priced them, low to high (one figure when they print the same).
    const ends = [roi.measured.returnOnTotalCost!, ...(roi.planned.valueHours > 0 ? [roi.planned.returnOnTotalCost!] : [])].sort((a, b) => a - b).map(formatMultiple);
    const figure = ends.length === 2 && ends[0] !== ends[1] ? `${ends[0]!.replace("×", "")}–${ends[1]}` : ends[0]!;
    expect(html).toContain(`Return on AI spend ${figure}`);
    expect(html).toContain("Default rates until you set yours");
    // An ROI read that failed says so instead of loading forever.
    expect(text(board(hub, null))).toContain("Could not be worked out");
  });

  it("says the change in features beside Features shipped, not the change in tickets", () => {
    const now = { ...hub.headline, epicsDone: 2, done: 10 };
    const before = { ...hub.headline, epicsDone: 2, done: 5 };
    const same = text(board({ ...hub, headline: now, previous: { from: "2026-08-01", to: "2026-08-07", headline: before } }));
    // Tickets doubled and features did not move: the tile under "Features shipped" says no change.
    expect(same).toMatch(/Features shipped 2 [^%]*No change/);
    const more = text(board({ ...hub, headline: { ...now, epicsDone: 3 }, previous: { from: "2026-08-01", to: "2026-08-07", headline: before } }));
    expect(more).toMatch(/Features shipped 3 [^%]*\+50%/);
  });

  it("opens the Estimates lens from the widget that sets planned effort against agent time", () => {
    expect(renderToStaticMarkup(<EstimatesWidget report={hub} onOpenEstimates={() => {}} />)).toContain("Open Estimates for accuracy by group");
  });

  it("draws one workspace without a workspace legend or the per-workspace widget", () => {
    expect(alpha.scope.kind).toBe("workspace");
    const html = board(alpha);
    expect(text(html)).toContain(`${alpha.headline.done} tickets closed`);
    expect(html).not.toContain("Other workspaces");
  });
});

describe("what limits the whole page", () => {
  it("names a registered workspace this computer could not open", () => {
    const unavailable = caveatOf(hub, "workspace_unavailable");
    expect(unavailable?.count).toBe(1);
    const html = renderToStaticMarkup(<PageNotes report={hub} />);
    expect(html).toContain('data-page-note="workspace_unavailable"');
    expect(text(html)).toContain(caveatSentence(unavailable!, hub));
    expect(text(html)).toContain("(ghost)");
  });

  it("says the history goes further back when all time was clamped, and stays quiet otherwise", () => {
    expect(alphaAllTime.period.explicit).toBe(false);
    expect(alphaAllTime.period.firstActivity! < alphaAllTime.period.from).toBe(true);
    const html = renderToStaticMarkup(<PageNotes report={alphaAllTime} />);
    expect(html).toContain('data-page-note="history"');
    expect(text(html)).toContain(`The history goes back further, to Jun 1, 2015.`);
    expect(renderToStaticMarkup(<PageNotes report={alpha} />)).toBe("");
  });
});

describe("the page's own states", () => {
  it("shows the empty state for a workspace with nothing in it", () => {
    expect(isEmptyScope(empty)).toBe(true);
    expect(isEmptyScope(hub)).toBe(false);
    const html = text(renderToStaticMarkup(<PageState report={empty} error={undefined} stale={false} onRetry={() => {}}>lens</PageState>));
    expect(html).toContain("Nothing to measure here yet");
    expect(html).not.toContain("lens");
  });

  it("keeps the lens while an answer for another query is still on screen, and offers Try again when the first read failed", () => {
    expect(text(renderToStaticMarkup(<PageState report={empty} error={undefined} stale onRetry={() => {}}>lens</PageState>))).toContain("lens");
    const failed = text(renderToStaticMarkup(<PageState report={undefined} error={new Error("The hub could not be read.")} stale={false} onRetry={() => {}}>lens</PageState>));
    expect(failed).toContain("Analytics could not be loaded");
    expect(failed).toContain("The hub could not be read.");
    expect(failed).toContain("Try again");
    expect(text(renderToStaticMarkup(<PageState report={hub} error={undefined} stale={false} onRetry={() => {}}>lens</PageState>))).toContain("lens");
  });
});
