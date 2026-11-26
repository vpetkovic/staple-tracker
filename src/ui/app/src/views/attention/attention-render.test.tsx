/**
 * The Inbox, rendered to static markup: one section per kind in the server's order, every
 * row with its age and one action named by its verb; the workspace pill only on All
 * workspaces; a blocked row's to-do as words, never as a button; a silent claim offers no
 * takeover; only the dismissible kinds offer Dismiss; a conflict opens in place; a folded
 * section draws no rows; and the empty list says nothing is waiting.
 * The model's sectioning and the action routing are pinned here too.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttentionList, AttentionRow } from "@/lib/types";
import { AttentionLists, type AttentionHandlers } from "./AttentionView";
import { ageText, attentionGo, attentionSections } from "./attention-model";
import { InboxRow, InboxSection } from "./InboxParts";

/** The core registry's kinds and labels, in its order (src/core/attention.ts). */
const KINDS: Record<string, string> = {
  gate_pending: "Gates waiting on approval",
  gate_resubmitted: "Gates resubmitted",
  person_blocked: "Blocked on a person",
  in_review: "In review",
  unblocked: "Ready again: blockers in other workspaces closed",
  run_stopped: "Stopped autopilot runs",
  claim_silent: "Silent claims",
  cloud_conflict: "Sync conflicts",
};

const noop: AttentionHandlers = { act: () => {}, resolve: () => {}, dismiss: () => {} };

function row(over: Partial<AttentionRow> & Pick<AttentionRow, "kind">): AttentionRow {
  const label = KINDS[over.kind] ?? over.label ?? over.kind;
  const ref = over.ref === undefined ? "APP-1" : over.ref;
  return {
    key: `app/${over.kind}/${ref ?? over.runId}`,
    workspace: "app",
    label,
    runId: null,
    conflictId: null,
    conflict: null,
    title: "Title",
    detail: "detail",
    since: "2026-11-25T00:00:00.000Z",
    ageSeconds: 7200,
    action: { verb: "open", label: "Open", command: "staple show APP-1 --ws app" },
    dismissible: false,
    ...over,
    ref,
  };
}

const list = (rows: AttentionRow[], workspaces = ["app", "web"]): AttentionList => ({ rows, workspaces, failed: [], now: "2026-11-25T02:00:00.000Z" });

const CONFLICT = { entity: "issue", field: "status", localValue: "in_review", remoteValue: { done: true } };

const EVERY_KIND: AttentionRow[] = [
  row({ kind: "gate_pending", ref: "APP-1", title: "Email as the second real channel", action: { verb: "review", label: "Approve or request changes", command: "staple approve APP-1 --ws app" } }),
  row({ kind: "gate_resubmitted", ref: "APP-2", action: { verb: "review", label: "Approve or request changes", command: "staple approve APP-2 --ws app" } }),
  row({ kind: "person_blocked", ref: "APP-3", detail: "waiting on VP", action: { verb: "unblock", label: "Add the API key", command: "staple show APP-3 --ws app" } }),
  row({ kind: "in_review", ref: "WEB-1", workspace: "web", action: { verb: "review", label: "Open for review", command: "staple show WEB-1 --ws web" } }),
  row({ kind: "unblocked", ref: "WEB-2", workspace: "web", dismissible: true }),
  row({ kind: "run_stopped", ref: null, runId: "0123456789ab", dismissible: true, action: { verb: "inspect", label: "Inspect", command: "staple run status 0123456789ab --ws app" } }),
  row({ kind: "claim_silent", ref: "APP-4", detail: "held by codex-7 · silent 4h" }),
  row({ kind: "cloud_conflict", ref: "APP-5", conflictId: "c-1", conflict: CONFLICT, action: { verb: "resolve", label: "Resolve", command: "staple cloud resolve c-1 --take local|remote --ws app" } }),
];

const lists = (props: Partial<Parameters<typeof AttentionLists>[0]> = {}) =>
  renderToStaticMarkup(<AttentionLists list={list(EVERY_KIND)} busy={null} handlers={noop} allWorkspaces {...props} />);

/** Every `<button …>…</button>` in the markup, opening tag and contents. */
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);

/** The markup of one row, from its opening tag to the next row or section. */
const rowHtml = (html: string, key: string) => {
  const start = html.lastIndexOf("<", html.indexOf(`data-attention-row="${key}"`));
  const next = html.slice(start + 1).search(/<div role="listitem"|<section/);
  return next === -1 ? html.slice(start) : html.slice(start, start + 1 + next);
};

describe("the Inbox", () => {
  it("draws one section per kind, in the order the rows arrive, each row with its age and action", () => {
    const html = lists();
    const sections = [...html.matchAll(/data-attention-section="([a-z_]+)"/g)].map((match) => match[1]);
    expect(sections).toEqual(Object.keys(KINDS));
    for (const label of Object.values(KINDS)) expect(html).toContain(label);
    for (const r of EVERY_KIND) expect(rowHtml(html, r.key)).toContain("waiting 2h");
    expect(html).toContain("run 01234567");
  });

  it("names each action by its verb, with the row in its accessible name", () => {
    const html = lists();
    const action = (key: string) => /data-attention-action="[a-z]+"[^>]*aria-label="([^"]+)"|aria-label="([^"]+)"[^>]*data-attention-action/.exec(rowHtml(html, key));
    const name = (key: string) => {
      const match = action(key);
      return match?.[1] ?? match?.[2];
    };
    expect(name("app/gate_pending/APP-1")).toBe("Review APP-1 Email as the second real channel");
    expect(name("app/person_blocked/APP-3")).toBe("Open APP-3 Title");
    expect(name("app/unblocked/WEB-2")).toBe("Open WEB-2 Title");
    expect(name("app/run_stopped/0123456789ab")).toBe("View run run 01234567 Title");
    expect(name("app/cloud_conflict/APP-5")).toBe("Resolve APP-5 Title");
    expect(html).not.toContain("Approve or request changes");
    expect(html).not.toContain("Open for review");
  });

  it("prints a blocked row's to-do after its reason, as words and never as a button", () => {
    const html = lists();
    const blocked = rowHtml(html, "app/person_blocked/APP-3");
    expect(blocked).toContain("waiting on VP");
    expect(blocked).toContain("Add the API key");
    expect(buttons(html).filter((button) => button.includes("Add the API key"))).toEqual([]);
  });

  it("shows the workspace pill on All workspaces only", () => {
    expect(lists()).toContain('data-attention-workspace="web"');
    expect(lists({ allWorkspaces: false })).not.toContain("data-attention-workspace");
  });

  it("offers Dismiss only on the kinds a person may dismiss, and nothing that takes a silent claim over", () => {
    const html = lists();
    const dismissible = [...html.matchAll(/data-attention-dismiss="([^"]+)"/g)].map((match) => match[1]);
    expect(dismissible).toEqual(["app/unblocked/WEB-2", "app/run_stopped/0123456789ab"]);
    expect(rowHtml(html, "app/claim_silent/APP-4")).not.toMatch(/steal|take over|release/i);
  });

  it("draws the new dot only for the rows isNew names, and none without it", () => {
    expect(lists()).not.toContain("data-attention-new");
    const html = lists({ isNew: (r) => r.ref === "WEB-1" });
    expect(html.match(/data-attention-new/g)).toHaveLength(1);
    expect(rowHtml(html, "app/in_review/WEB-1")).toContain("data-attention-new");
  });

  it("renders a kind it has never heard of by its label and verb", () => {
    const html = lists({ list: list([row({ kind: "brand_new", label: "Something new", ref: "APP-9", action: { verb: "review", label: "Look", command: "" } })]) });
    expect(html).toContain('data-attention-section="brand_new"');
    expect(html).toContain("Something new");
    expect(html).toContain('aria-label="Review APP-9 Title"');
  });

  it("dims the busy row and marks its buttons disabled without taking them out of the focus order", () => {
    const html = lists({ busy: "app/unblocked/WEB-2" });
    const busy = rowHtml(html, "app/unblocked/WEB-2");
    expect(busy).toContain("opacity-60");
    // `aria-disabled`, not `disabled`: disabling the focused button would drop the focus to the page.
    for (const button of buttons(busy)) {
      expect(button).toContain('aria-disabled="true"');
      expect(button).not.toMatch(/ disabled=""/);
    }
    expect(rowHtml(html, "app/gate_pending/APP-1")).not.toContain("opacity-60");
  });

  it("disables the action of a row that names nothing to open", () => {
    const html = lists({ list: list([row({ kind: "odd", label: "Odd", ref: null, runId: null, conflictId: null, action: { verb: "open", label: "Open", command: "" } })]) });
    const action = buttons(html).find((button) => button.includes("data-attention-action"))!;
    expect(action).toMatch(/ disabled=""/);
  });

  it("marks the row whose ticket is open in the drawer", () => {
    const html = lists({ selected: { workspace: "web", ref: "WEB-1" } });
    expect(rowHtml(html, "app/in_review/WEB-1")).toContain('aria-current="true"');
    expect(rowHtml(html, "app/gate_pending/APP-1")).not.toContain("aria-current");
  });

  it("says nothing is waiting when the list is empty", () => {
    const html = lists({ list: list([]) });
    expect(html).toContain("data-attention-empty");
    expect(html).toContain("Nothing is waiting on you");
    expect(html).not.toContain("waiting in other workspaces");
  });

  it("points at the other workspaces from an empty page and from the foot of a list", () => {
    const empty = lists({ list: list([]), allWorkspaces: false, elsewhere: 13 });
    expect(buttons(empty).some((button) => button.includes("13 waiting in other workspaces"))).toBe(true);
    const html = lists({ allWorkspaces: false, elsewhere: 13 });
    expect(html).toContain("13 more waiting in other workspaces.");
    expect(buttons(html).some((button) => button.includes("Show all workspaces"))).toBe(true);
    expect(lists({ allWorkspaces: true, elsewhere: 13 })).not.toContain("more waiting in other workspaces");
    expect(lists({ allWorkspaces: false, elsewhere: 0 })).not.toContain("more waiting in other workspaces");
  });

  it("names a workspace it could not read, above the rows", () => {
    const html = lists({ list: { ...list(EVERY_KIND), failed: [{ workspace: "gone", message: "no database" }] } });
    expect(html).toContain('data-attention-failed="gone"');
    expect(html).toContain("Could not read gone: no database");
    expect(html.indexOf("data-attention-failed")).toBeLessThan(html.indexOf("data-attention-section"));
  });
});

describe("a folded section", () => {
  const section = attentionSections(EVERY_KIND.slice(0, 2))[0]!;

  it("draws its header with the count and the oldest wait, and no rows", () => {
    const folded = renderToStaticMarkup(
      <InboxSection section={section} folded onToggle={() => {}}>
        <div data-attention-row="x" />
      </InboxSection>,
    );
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain("oldest 2h");
    expect(folded).not.toContain("data-attention-row");
    const open = renderToStaticMarkup(
      <InboxSection section={section} folded={false} onToggle={() => {}}>
        <div data-attention-row="x" />
      </InboxSection>,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("data-attention-row");
  });
});

describe("a conflict", () => {
  const conflictRow = EVERY_KIND[7]!;
  const draw = (r: AttentionRow, expanded: boolean) =>
    renderToStaticMarkup(
      <InboxRow row={r} allWorkspaces isNew={false} selected={false} busy={false} expanded={expanded} active handlers={noop} onExpand={() => {}} />,
    );

  it("says which field differs, and opens in place with both values and both takes", () => {
    expect(draw(conflictRow, false)).toContain("differs between two devices");
    expect(draw(conflictRow, false)).not.toContain("data-attention-conflict");
    const html = draw(conflictRow, true);
    expect(html).toContain("data-attention-conflict");
    expect(html).toContain("This device");
    expect(html).toContain("in_review");
    expect(html).toContain("{&quot;done&quot;:true}");
    expect(html).toContain('data-attention-take="local"');
    expect(html).toContain('data-attention-take="remote"');
    expect(html).toContain('aria-expanded="true"');
  });

  it("still opens in place with both takes when the row carries no values", () => {
    const html = draw({ ...conflictRow, conflict: null }, true);
    expect(html).toContain("data-attention-conflict");
    expect(html).toContain('data-attention-take="local"');
    expect(html).toContain('data-attention-take="remote"');
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});

describe("the model", () => {
  it("groups consecutive rows of a kind and keeps the server's order", () => {
    const sections = attentionSections([EVERY_KIND[0]!, row({ kind: "gate_pending", ref: "APP-9" }), EVERY_KIND[3]!]);
    expect(sections.map((section) => [section.kind, section.rows.length])).toEqual([
      ["gate_pending", 2],
      ["in_review", 1],
    ]);
  });

  it("routes each action: a ticket opens its detail, a run its history, a conflict asks", () => {
    expect(attentionGo(EVERY_KIND[0]!)).toEqual({ to: "issue", workspace: "app", ref: "APP-1" });
    expect(attentionGo(EVERY_KIND[5]!)).toEqual({ to: "run", workspace: "app", runId: "0123456789ab" });
    expect(attentionGo(EVERY_KIND[7]!)).toEqual({ to: "resolve", workspace: "app", conflictId: "c-1" });
    expect(ageText({ ageSeconds: 90 })).toBe("waiting 1m");
  });
});
