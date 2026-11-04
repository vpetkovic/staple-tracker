/**
 * The open ticket in the address — lib/issue-url.ts. What a link says, which workspace it
 * is read from, and what opening, moving and closing do to history. The browser half (the
 * page opening it, Back, reload) is test/ui-issue-link.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  issueHistoryStep,
  issueNotFoundText,
  linkWorkspace,
  readIssueUrl,
  resolveIssueWorkspace,
  sameIssue,
  withIssue,
} from "./issue-url";
import { readShellUrl, withShellState } from "./session-url";
import { emptyFilters } from "./filters";

const BASE = "http://127.0.0.1:4400/";
const search = (href: string) => new URL(href).search;
const HUB = {
  mode: "hub" as const,
  workspaces: [
    { slug: "staple", prefix: "STA" },
    { slug: "pinecone", prefix: "PIN" },
  ],
};
const SINGLE = { mode: "workspace" as const, workspaces: [{ slug: "demo", prefix: "DEM" }] };

describe("what the address asks to open", () => {
  it("reads issue, with issue-ws over ws", () => {
    expect(readIssueUrl("?issue=STA-12")).toEqual({ ref: "STA-12", workspace: "" });
    expect(readIssueUrl("?ws=staple&issue=STA-12")).toEqual({ ref: "STA-12", workspace: "staple" });
    expect(readIssueUrl("?ws=staple&view=tasks&issue=PIN-4&issue-ws=pinecone")).toEqual({ ref: "PIN-4", workspace: "pinecone" });
  });

  it("says nothing without a ref", () => {
    expect(readIssueUrl("")).toBeNull();
    expect(readIssueUrl("?view=tasks")).toBeNull();
    expect(readIssueUrl("?issue=")).toBeNull();
    expect(readIssueUrl("?issue=%20")).toBeNull();
  });
});

describe("the page a short ticket link lands on", () => {
  it("takes ws from an address that names a ticket", () => {
    expect(linkWorkspace("?ws=staple&issue=STA-12")).toBe("staple");
    expect(linkWorkspace("?issue=STA-12")).toBe("");
    expect(linkWorkspace("?ws=staple")).toBe("");
  });
});

describe("which workspace the ticket is read from", () => {
  it("a single-workspace page has one answer, whatever the link says", () => {
    expect(resolveIssueWorkspace({ ref: "DEM-1", workspace: "" }, SINGLE)).toBe("demo");
    expect(resolveIssueWorkspace({ ref: "DEM-1", workspace: "elsewhere" }, SINGLE)).toBe("demo");
  });

  it("hub: the named workspace, even one this hub lacks (the detail then says so)", () => {
    expect(resolveIssueWorkspace({ ref: "STA-1", workspace: "pinecone" }, HUB)).toBe("pinecone");
    expect(resolveIssueWorkspace({ ref: "STA-1", workspace: "gone" }, HUB)).toBe("gone");
  });

  it("hub with no workspace named: the one whose prefix the ref carries, else the first", () => {
    expect(resolveIssueWorkspace({ ref: "PIN-4", workspace: "" }, HUB)).toBe("pinecone");
    expect(resolveIssueWorkspace({ ref: "pin-4", workspace: "" }, HUB)).toBe("pinecone");
    expect(resolveIssueWorkspace({ ref: "ZZZ-4", workspace: "" }, HUB)).toBe("staple");
    const twins = { mode: "hub" as const, workspaces: [{ slug: "a", prefix: "X" }, { slug: "b", prefix: "X" }] };
    expect(resolveIssueWorkspace({ ref: "X-1", workspace: "" }, twins)).toBe("a");
  });
});

describe("writing the open ticket", () => {
  it("sets issue and keeps every other parameter", () => {
    const href = withIssue(`${BASE}?ws=staple&view=tasks&status=todo&settings=kinds`, { workspace: "staple", ref: "STA-12" }, true);
    expect(search(href)).toBe("?ws=staple&view=tasks&status=todo&settings=kinds&issue=STA-12");
  });

  it("names the workspace only in hub mode and only when it is not the page's", () => {
    const sel = { workspace: "pinecone", ref: "PIN-4" };
    expect(new URL(withIssue(`${BASE}?ws=pinecone&view=tasks`, sel, true)).searchParams.has("issue-ws")).toBe(false);
    expect(new URL(withIssue(`${BASE}?ws=staple&view=tasks`, sel, true)).searchParams.get("issue-ws")).toBe("pinecone");
    expect(new URL(withIssue(`${BASE}?view=tasks`, sel, true)).searchParams.get("issue-ws")).toBe("pinecone");
    expect(new URL(withIssue(`${BASE}?view=tasks`, { workspace: "demo", ref: "DEM-1" }, false)).searchParams.has("issue-ws")).toBe(false);
  });

  it("removes both parameters on close, and round-trips through the reader", () => {
    const open = withIssue(`${BASE}?view=tasks`, { workspace: "pinecone", ref: "PIN-4" }, true);
    const request = readIssueUrl(search(open))!;
    expect(resolveIssueWorkspace(request, HUB)).toBe("pinecone");
    expect(request.ref).toBe("PIN-4");
    const closed = new URL(withIssue(open, null, true));
    expect(closed.searchParams.has("issue")).toBe(false);
    expect(closed.searchParams.has("issue-ws")).toBe(false);
    expect(closed.searchParams.get("view")).toBe("tasks");
  });

  it("survives the page's own address writes, which keep parameters they do not own", () => {
    const open = withIssue(`${BASE}?ws=staple&view=tasks`, { workspace: "staple", ref: "STA-12" }, true);
    const rewritten = withShellState(open, { ws: "staple", view: "tree", filters: { ...emptyFilters(), text: "login" }, focus: null });
    expect(readIssueUrl(search(rewritten))).toEqual({ ref: "STA-12", workspace: "staple" });
    expect(readShellUrl(search(rewritten))?.filters.text).toBe("login");
  });
});

describe("what a change of the open ticket does to history", () => {
  const a = { workspace: "staple", ref: "STA-1" };
  const b = { workspace: "staple", ref: "STA-2" };
  const step = (over: Partial<Parameters<typeof issueHistoryStep>[0]>) =>
    issueHistoryStep({ before: null, after: null, entryOpen: false, addressHasIssue: false, ...over });

  it("opening from the page pushes one entry", () => {
    expect(step({ after: a })).toBe("push");
  });

  it("a ticket that arrived with the address is written in place, not pushed", () => {
    expect(step({ after: a, addressHasIssue: true })).toBe("replace");
  });

  it("moving to another ticket in the open detail replaces, so Back still means the page", () => {
    expect(step({ before: a, after: b, entryOpen: true, addressHasIssue: true })).toBe("replace");
    expect(step({ before: a, after: b, addressHasIssue: true })).toBe("replace");
  });

  it("closing takes our entry out, or strips the parameter when there is none", () => {
    expect(step({ before: a, entryOpen: true, addressHasIssue: true })).toBe("pop");
    expect(step({ before: a, addressHasIssue: true })).toBe("strip");
    expect(step({ before: a })).toBe("none");
  });

  it("a pinned id is not a change", () => {
    expect(step({ before: a, after: { ...a, id: "x" } as typeof a, entryOpen: true, addressHasIssue: true })).toBe("none");
    expect(sameIssue(null, null)).toBe(true);
    expect(sameIssue(a, null)).toBe(false);
  });
});

describe("the not-found state", () => {
  it("only for a 404", () => {
    expect(issueNotFoundText(undefined, { workspace: "demo", ref: "DEM-9" }, SINGLE)).toBeNull();
    expect(issueNotFoundText({ status: 500 }, { workspace: "demo", ref: "DEM-9" }, SINGLE)).toBeNull();
  });

  it("names the ref, and the workspace in hub mode", () => {
    expect(issueNotFoundText({ status: 404 }, { workspace: "demo", ref: "DEM-9" }, SINGLE)).toEqual({
      title: "DEM-9 was not found",
      body: "There is no ticket DEM-9. It may have been deleted, or the link names another ticket.",
    });
    expect(issueNotFoundText({ status: 404 }, { workspace: "staple", ref: "STA-99" }, HUB)?.body).toContain('in the "staple" workspace');
  });

  it("says so when the workspace itself is not on this page", () => {
    expect(issueNotFoundText({ status: 404 }, { workspace: "gone", ref: "GON-1" }, HUB)?.body).toBe(
      'This page has no workspace called "gone". The link may come from another computer.',
    );
  });
});
