/**
 * The Autopilot page rendered to markup, as the rest of the app's view tests are (no DOM):
 * which pane is drawn at which width, what the list and a run say, and the states.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEntry } from "@/lib/types";
import { AutopilotLayout, type AutopilotPageProps } from "./AutopilotPage";
import { entry, failedEntry, issue, NOW, run, workingEntry } from "./fixtures";

const never = (name: string) => () => {
  throw new Error(`${name} was called during render`);
};

function render(over: Partial<AutopilotPageProps> & { wide?: boolean | null } = {}): string {
  const { wide = true, ...props } = over;
  return renderToStaticMarkup(
    <AutopilotLayout
      entries={[]}
      selectedRunId={null}
      onSelectRun={never("onSelectRun")}
      onOpenTicket={never("onOpenTicket")}
      showWorkspace={false}
      loading={false}
      error={null}
      now={NOW}
      wide={wide}
      {...props}
    />,
  );
}

/** The markup of one element and everything in it, found by an attribute. */
function part(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, attribute).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  const tag = /^<(\w+)/.exec(html.slice(open))![1]!;
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = open;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe("the run list", () => {
  it("names each run by its title, with its scope and who ran it", () => {
    const epic = workingEntry({
      title: "The person stays in the loop",
      run: { ...workingEntry().run, actor: "claude-epic-runner", scope: { kind: "issue", issueId: "i-369", identifier: "STA-369" } },
    });
    const item = text(part(render({ entries: [epic] }), `data-run-item="${epic.run.id}"`));
    expect(item).toContain("The person stays in the loop");
    expect(item).toContain("Epic STA-369 · claude-epic-runner");
  });

  it("a working run's pill names the ticket it holds, and its tally counts what it did", () => {
    const working = workingEntry();
    const item = text(part(render({ entries: [working] }), `data-run-item="${working.run.id}"`));
    expect(item).toContain("Working on EXE-366");
    expect(item).toContain("2 done");
    expect(item).toContain("1 failed");
  });

  it("groups live runs under Running now and ended ones under Earlier, with the workspace on All workspaces", () => {
    const html = render({ entries: [failedEntry(), workingEntry()], showWorkspace: true });
    const list = text(part(html, "data-run-list"));
    expect(list.indexOf("Running now")).toBeLessThan(list.indexOf("Earlier"));
    expect(list).toContain("ai-inbox-supabase");
  });
});

describe("which pane is drawn", () => {
  const live = workingEntry();
  const ended = failedEntry();

  it("a wide page with nothing selected shows the newest live run, and selects nothing", () => {
    const html = render({ entries: [ended, live], wide: true });
    expect(html).toContain("data-run-list");
    expect(html).toContain(`data-run-detail="${live.run.id}"`);
    expect(part(html, `data-run-item="${live.run.id}"`)).toContain('aria-current="true"');
  });

  it("a narrow page with nothing selected is the list alone", () => {
    const html = render({ entries: [ended, live], wide: false });
    expect(html).toContain("data-run-list");
    expect(html).not.toContain("data-run-detail");
  });

  it("a narrow page with a run selected is that run alone, with a way back", () => {
    const html = render({ entries: [ended, live], wide: false, selectedRunId: ended.run.id });
    expect(html).not.toContain("data-run-list");
    expect(html).toContain(`data-run-detail="${ended.run.id}"`);
    expect(html).toContain("data-run-back");
  });

  it("a run that is not in the list says so and offers every run", () => {
    const html = render({ entries: [live], selectedRunId: "0000000000-gone" });
    expect(html).toContain("data-run-unknown");
    expect(text(html)).toContain("This run is not in the list.");
    expect(text(html)).toContain("Show all runs");
  });
});

describe("the Now panel", () => {
  const now = (e: RunEntry) => part(render({ entries: [e], selectedRunId: e.run.id }), "data-run-now");

  it("leads with the ticket being worked and when it was taken", () => {
    const panel = now(workingEntry());
    expect(panel).toContain('data-ticket-chip="EXE-366"');
    expect(panel).toContain('data-variant="lead"');
    expect(text(panel)).toMatch(/Working on.*taken \d\d:\d\d · 5m so far/);
  });

  it("names an attached driver", () => {
    const panel = now(workingEntry());
    expect(panel).toContain('data-run-driver="true"');
    expect(text(panel)).toContain("Driver attached (claude)");
  });

  it("warns when no driver is attached", () => {
    const panel = now(workingEntry({ driver: null }));
    expect(panel).toContain('data-run-driver="none"');
    expect(text(panel)).toContain("No driver attached: the next ticket waits until an agent continues this run.");
  });

  it("warns, in the risk colour, when the driver stopped responding", () => {
    const silent = workingEntry();
    silent.driver = { ...silent.driver!, alive: false };
    const panel = now(silent);
    expect(panel).toContain('data-run-driver="false"');
    expect(panel).toContain("var(--plain-risk-fg)");
    expect(text(panel)).toContain("The driver stopped responding: the run takes nothing until a driver attaches or you stop it.");
  });

  it("a paused run says it takes nothing until resumed", () => {
    const paused = workingEntry({ run: { ...workingEntry().run, state: "paused" } });
    expect(text(now(paused))).toContain("It takes nothing until you resume it.");
  });

  it("an ended run says how it ended and offers the one thing to do about it", () => {
    const panel = now(failedEntry());
    expect(text(panel)).toContain("AII-37 failed twice in a row");
    expect(panel).toContain('data-ticket-chip="AII-37"');
    expect(panel).toContain('data-run-stop-reason="failure_streak"');
    expect(text(part(panel, "data-run-attention"))).toBe("Open AII-37");
  });

  it("a goal met offers to review the milestone", () => {
    const goalMet = failedEntry({
      run: run({
        state: "completed",
        scope: { kind: "milestone", issueId: "m-553", identifier: "STA-553" },
        stop: { reason: "goal_met", detail: { milestone: "STA-553" }, by: null, note: null, at: "2026-11-26T01:00:00.000Z" },
        endedAt: "2026-11-26T01:00:00.000Z",
      }),
    });
    expect(text(part(now(goalMet), "data-run-attention"))).toBe("Review STA-553");
  });
});

describe("stat tiles", () => {
  const tiles = (e: RunEntry) => [...render({ entries: [e], selectedRunId: e.run.id }).matchAll(/data-run-stat="(\w+)"/g)].map((m) => m[1]);

  it("draws a tile per limit set, and Left in scope only while the run is live", () => {
    expect(tiles(workingEntry())).toEqual(["done", "left", "tickets", "took"]);
    expect(tiles(failedEntry())).toEqual(["done", "tickets", "took"]);
    expect(tiles(failedEntry({ facts: workingEntry().facts }))).toEqual(["done", "tickets", "took"]);
    const all = workingEntry({ run: run({ budget: { maxTickets: 5, until: "2026-11-26T14:00:00.000Z", ceilingPercent: 80, ceilingAccount: null } }) });
    expect(tiles(all)).toEqual(["done", "left", "tickets", "time", "usage", "took"]);
    expect(tiles(entry())).toEqual(["done", "left", "limit", "took"]);
  });
});

describe("the tickets", () => {
  const tickets = (e: RunEntry) => part(render({ entries: [e], selectedRunId: e.run.id }), 'aria-label="Tickets"');

  it("tags a second take of the same ticket as a retry", () => {
    const html = tickets(workingEntry());
    const rows = html.split("data-run-ticket=").slice(1);
    expect(rows.map((row) => row.includes("data-run-retry"))).toEqual([false, false, true, false]);
  });

  it("prints a failed take's reason as a sentence under it, and its outcome as a word", () => {
    const html = tickets(failedEntry());
    const failures = [...html.matchAll(/data-run-failure=""[^>]*>(.*?)<\/p>/g)].map((m) => text(m[1]!));
    expect(failures).toEqual(["The agent session ran out of time.", "It finished without a review."]);
    expect(text(html)).toContain("Failed");
  });

  it("a deleted ticket falls back to the identifier the take recorded", () => {
    const gone = failedEntry({ issues: [] });
    const html = tickets(gone);
    expect(html).toContain('data-ticket-chip="AII-37" data-deleted=""');
    expect(text(html)).toContain("deleted");
  });

  it("a run that took nothing says so", () => {
    expect(text(tickets(entry()))).toContain("It has taken no tickets yet.");
  });

  it("lists changed instruction documents under the tickets", () => {
    const change = { seq: 1, ref: "STA-1", issueId: "i", key: "rules", revision: 2, instructions: true, actor: null, at: NOW.toISOString() };
    const html = render({ entries: [workingEntry({ instructionsChanged: [change] })] });
    expect(text(part(html, "data-run-instructions"))).toBe("1 instruction document changed since its last take: rules");
  });
});

describe("up next", () => {
  it("lists the first five ready tickets in pickup order, then how many more and how many wait", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ issueId: `n-${i}`, identifier: `EXE-${i + 10}`, held: false }));
    const live = workingEntry();
    live.facts = { ...live.facts!, workable: [{ issueId: "i-366", identifier: "EXE-366", held: true }, ...rows] };
    live.issues = [...live.issues, ...rows.map((row) => issue({ issueId: row.issueId, identifier: row.identifier }))];
    const html = part(render({ entries: [live] }), "data-run-next");
    expect([...html.matchAll(/data-ticket-chip="([^"]+)"/g)].map((m) => m[1])).toEqual(["EXE-10", "EXE-11", "EXE-12", "EXE-13", "EXE-14"]);
    expect(text(html)).toContain("2 more ready");
    expect(text(html)).toContain("1 waiting on work others hold");
  });

  it("is not drawn for an ended run, even one that still carries facts", () => {
    expect(render({ entries: [failedEntry({ facts: workingEntry().facts })] })).not.toContain("data-run-next");
  });
});

describe("goal", () => {
  it("counts the criteria met and names whose approval closes it", () => {
    const goal = workingEntry({
      run: run({ scope: { kind: "milestone", issueId: "m-1", identifier: "STA-533" }, goal: { gateOwner: "VP", childCap: 3, children: [], gatedAt: null } }),
      goal: {
        milestone: { identifier: "STA-533", title: "Quick wins", status: "in_progress" },
        criteria: [
          { position: 1, text: "Each member is in review", verdict: "met", marked: "met", evidence: [], note: null, markedBy: null, markedAt: null, runId: null, why: null },
          { position: 2, text: "Each PR is merged", verdict: "unmet", marked: null, evidence: [], note: null, markedBy: null, markedAt: null, runId: null, why: null },
        ],
        counts: { met: 1, unmet: 1, unknown: 0, total: 2 },
        met: false,
        pace: { verdict: "no_target" } as never,
        children: { cap: 3, created: 0, left: 3, refs: [] },
        gate: null,
      },
    });
    const html = part(render({ entries: [goal] }), "data-run-goal");
    expect(text(html)).toContain("1 of 2 criteria met · approved by VP");
    expect(html.match(/data-goal-criterion=/g)).toHaveLength(2);
  });
});

describe("states", () => {
  it("no runs: says what a run is and how one starts", () => {
    const html = render({ entries: [] });
    expect(html).toContain("data-run-history-empty");
    expect(text(html)).toContain("No autopilot runs yet");
    expect(text(html)).toContain("staple run drive --scope queue --agent claude --max-tickets 5");
  });

  it("loading: a skeleton, announced as busy", () => {
    const html = render({ entries: [], loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("data-run-history-empty");
  });

  it("an error is said, not hidden behind an empty page", () => {
    const html = render({ entries: [workingEntry()], error: new Error("The runs could not be read") });
    expect(text(html)).toContain("The runs could not be read");
    expect(html).not.toContain("data-run-list");
  });
});

