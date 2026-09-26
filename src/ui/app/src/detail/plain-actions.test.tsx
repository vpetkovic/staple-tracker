/**
 * The detail's verbs in plain words (review B-polish): no "set status", "claim" or "release",
 * no raw status ids as labels — the command names live under "Show details".
 * And the sheet's Previous/Next are 44×44 targets.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { issue } from "@/components/task-list/fixtures";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { IssueActions } from "./IssueActions";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { ACTION_WORDS, statusChoices } from "./plain-actions";

const noop = () => {};

function actions(over: Parameters<typeof issue>[0] = {}): string {
  return renderToStaticMarkup(<IssueActions issue={issue({ identifier: "STA-83", status: "blocked", ...over })} workspace="staple" refresh={noop} />);
}

/** Text a person sees: the markup minus the collapsed "Show details" block and tags. */
function visibleText(html: string): string {
  return html
    .replace(/<details[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

describe("the detail's verbs", () => {
  it("say what they do to the task, not the command's name", () => {
    const text = visibleText(actions());
    expect(text).toContain(ACTION_WORDS.status);
    expect(text).toContain(ACTION_WORDS.checkout);
    expect(text).toContain(ACTION_WORDS.release);
    for (const jargon of [/\bset status\b/, /\bclaim\b/, /\brelease\b/]) expect(text).not.toMatch(jargon);
  });

  it("never show a status id as a label (the menu's labels portal out of a static render; the browser evidence reads them)", () => {
    const text = visibleText(actions({ status: "in_progress" }));
    expect(text).not.toContain("in_progress");
  });

  it("keep the tracker's own names one tap away, under Show details", () => {
    const html = actions({ status: "blocked", checkoutAgent: "codex-1" });
    const details = /<details[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(details).toContain("Show details");
    expect(details).toContain(">blocked<");
    expect(details).toContain("codex-1");
    expect(details).toContain("staple checkout");
  });

  it("offer the workspace's own statuses, and always the task's current one", () => {
    expect(statusChoices(["todo", "doing", "done"], ["backlog"], "doing")).toEqual(["todo", "doing", "done"]);
    expect(statusChoices(["todo", "done"], ["backlog"], "pairing")).toEqual(["pairing", "todo", "done"]);
    expect(statusChoices([], ["backlog", "todo"], "todo")).toEqual(["backlog", "todo"]);
  });
});

describe("the sheet's Previous and Next", () => {
  const panel = (presentation: "sheet" | "drawer") =>
    renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession()}>
        <IssueDetailPanel
          selection={{ workspace: "staple", ref: "STA-60" }}
          mode="drawer"
          presentation={presentation}
          onToggleMode={noop}
          nav={{ prev: null, next: null, index: -1, total: 0 }}
          onNavigate={noop}
          onClose={noop}
          onAuthError={noop}
        />
      </SessionContext.Provider>,
    );
  const navClass = (html: string, direction: string) =>
    new RegExp(`<button[^>]*data-detail-nav="${direction}"[^>]*>`).exec(html)?.[0].match(/class="([^"]*)"/)?.[1] ?? "";

  it("are full 44×44 targets on the phone sheet", () => {
    const html = panel("sheet");
    for (const direction of ["prev", "next"]) expect(navClass(html, direction).split(" ")).toContain("size-11");
  });

  it("keep the desktop drawer's compact buttons, widened only under a finger", () => {
    const html = panel("drawer");
    for (const direction of ["prev", "next"]) {
      const classes = navClass(html, direction).split(" ");
      expect(classes).not.toContain("size-11");
      expect(classes).toContain("pointer-coarse:min-w-11");
    }
  });
});
