/**
 * The Attention page, rendered to static markup: one section per kind in the server's order,
 * every row naming its workspace, its age and one action; a silent claim offers no takeover;
 * only the dismissible kinds offer Dismiss; and the empty list says nothing is waiting.
 * The model's sectioning and the action routing are pinned here too.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttentionList, AttentionRow } from "@/lib/types";
import { ATTENTION_KINDS } from "@/lib/types";
import { AttentionLists, type AttentionHandlers } from "./AttentionView";
import { ATTENTION_KIND_LABELS, ageText, attentionGo, attentionSections } from "./attention-model";

const noop: AttentionHandlers = { act: () => {}, resolve: () => {}, dismiss: () => {} };

function row(over: Partial<AttentionRow> & Pick<AttentionRow, "kind">): AttentionRow {
  const ref = over.ref === undefined ? "APP-1" : over.ref;
  return {
    key: `app/${over.kind}/${ref ?? over.runId}`,
    workspace: "app",
    runId: null,
    conflictId: null,
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

const EVERY_KIND: AttentionRow[] = [
  row({ kind: "gate_pending", ref: "APP-1", action: { verb: "review", label: "Approve or request changes", command: "staple approve APP-1 --ws app" } }),
  row({ kind: "gate_resubmitted", ref: "APP-2", action: { verb: "review", label: "Approve or request changes", command: "staple approve APP-2 --ws app" } }),
  row({ kind: "person_blocked", ref: "APP-3", action: { verb: "unblock", label: "Add the API key", command: "staple show APP-3 --ws app" } }),
  row({ kind: "in_review", ref: "WEB-1", workspace: "web", action: { verb: "review", label: "Open for review", command: "staple show WEB-1 --ws web" } }),
  row({ kind: "unblocked", ref: "WEB-2", workspace: "web", dismissible: true }),
  row({ kind: "run_stopped", ref: null, runId: "0123456789ab", dismissible: true, action: { verb: "inspect", label: "Inspect", command: "staple run status 0123456789ab --ws app" } }),
  row({ kind: "claim_silent", ref: "APP-4", detail: "held by codex-7 · silent 4h" }),
  row({ kind: "cloud_conflict", ref: "APP-5", conflictId: "c-1", action: { verb: "resolve", label: "Resolve", command: "staple cloud resolve c-1 --take local|remote --ws app" } }),
];

describe("the Attention page", () => {
  it("draws one section per kind, in the order the rows arrive, each row with its workspace, age and action", () => {
    const html = renderToStaticMarkup(<AttentionLists list={list(EVERY_KIND)} busy={null} handlers={noop} />);
    const sections = [...html.matchAll(/data-attention-section="([a-z_]+)"/g)].map((match) => match[1]);
    expect(sections).toEqual([...ATTENTION_KINDS]);
    for (const kind of ATTENTION_KINDS) expect(html).toContain(ATTENTION_KIND_LABELS[kind]);
    expect(html).toContain('data-attention-workspace="web"');
    expect(html.match(/waiting 2h/g)).toHaveLength(EVERY_KIND.length);
    expect(html).toContain("Approve or request changes");
    expect(html).toContain("Add the API key");
    expect(html).toContain("Open for review");
    expect(html).toContain("Inspect");
    expect(html).toContain("Resolve");
    expect(html).toContain("run 01234567");
  });

  it("offers Dismiss only on the kinds a person may dismiss, and nothing that takes a silent claim over", () => {
    const html = renderToStaticMarkup(<AttentionLists list={list(EVERY_KIND)} busy={null} handlers={noop} />);
    const dismissible = [...html.matchAll(/data-attention-dismiss="([^"]+)"/g)].map((match) => match[1]);
    expect(dismissible).toEqual(["app/unblocked/WEB-2", "app/run_stopped/0123456789ab"]);
    const silent = html.slice(html.indexOf('data-attention-kind="claim_silent"'), html.indexOf('data-attention-section="cloud_conflict"'));
    expect(silent).not.toMatch(/steal|take over|release/i);
  });

  it("says nothing is waiting when the list is empty", () => {
    const html = renderToStaticMarkup(<AttentionLists list={list([])} busy={null} handlers={noop} />);
    expect(html).toContain("data-attention-empty");
    expect(html).toContain("Nothing is waiting on you");
    expect(html).toContain("in 2 workspaces");
  });

  it("names a workspace it could not read", () => {
    const html = renderToStaticMarkup(
      <AttentionLists list={{ ...list([]), failed: [{ workspace: "gone", message: "no database" }] }} busy={null} handlers={noop} />,
    );
    expect(html).toContain('data-attention-failed="gone"');
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
    expect(attentionGo(EVERY_KIND[5]!)).toEqual({ to: "run", runId: "0123456789ab" });
    expect(attentionGo(EVERY_KIND[7]!)).toEqual({ to: "resolve", workspace: "app", conflictId: "c-1" });
    expect(ageText({ ageSeconds: 90 })).toBe("waiting 1m");
  });
});
