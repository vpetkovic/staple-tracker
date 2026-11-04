/**
 * THE OPEN TICKET, IN THE ADDRESS — `?issue=STA-12`.
 *
 * A link that opens one ticket: the ticket card an agent shows in its thread has an
 * "Open in Staple" button, and a person shares a ticket by copying the address. Both need
 * the address to name the ticket, and the page to open it on arrival, keep it through a
 * reload, and forget it when the detail closes.
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────────────────
 *
 *   ?ws=staple&view=tasks&issue=STA-12
 *   ?view=tasks&issue=PIN-4&issue-ws=pinecone      (hub, All workspaces)
 *
 * `issue` is the ticket's identifier. `issue-ws` is written only in hub mode, and only when
 * the ticket lives somewhere other than the page's `ws` — on All workspaces, or a blocker
 * from another workspace opened from a workspace's page. A link built by hand or by an
 * agent can say `?ws=staple&issue=STA-12` and needs no `view`.
 *
 * ── WHICH WORKSPACE ───────────────────────────────────────────────────────────────────
 *
 * `resolveIssueWorkspace`: `issue-ws`, else `ws`, else the one workspace whose prefix the
 * identifier carries, else the first. A single-workspace page has one answer. A workspace
 * this hub does not have is kept as asked, so the detail says the ticket was not found
 * there rather than quietly opening something else.
 *
 * ── HISTORY ───────────────────────────────────────────────────────────────────────────
 *
 * `issueHistoryStep` decides what a change of the open ticket does to the address; the
 * wiring lives in detail/IssueDetailMount.tsx. Opening from the page pushes one overlay
 * entry carrying `issue`, so Back closes the detail (lib/back-to-close.ts); moving to
 * another ticket inside the open detail replaces it; closing takes our entry back out, or —
 * when the ticket arrived with the address (a link, a reload) and there is no entry of ours
 * — strips the parameter in place.
 */
import type { Selection } from "./session";
import type { UiMode, WorkspaceRef } from "./types";

export const ISSUE_PARAM = "issue";
export const ISSUE_WS_PARAM = "issue-ws";

/** What the address asks to open: a ref, and the workspace it named (`""` = none). */
export interface IssueRequest {
  ref: string;
  workspace: string;
}

/** The ticket the address names, or `null`. `workspace` is `issue-ws`, else `ws`, else `""`. */
export function readIssueUrl(search: string): IssueRequest | null {
  const params = new URLSearchParams(search);
  const ref = params.get(ISSUE_PARAM)?.trim() ?? "";
  if (ref === "") return null;
  const workspace = params.get(ISSUE_WS_PARAM)?.trim() || params.get("ws")?.trim() || "";
  return { ref, workspace };
}

/**
 * The workspace a ticket link lands the PAGE on when the address carries no `view` — the
 * short form `?ws=staple&issue=STA-12` an agent or a person writes by hand. Such an address
 * does not describe a page (lib/session-url.ts), so the view and its filters stay what this
 * browser remembered; but the link named a workspace, and the page should be on it. `""`
 * (All workspaces, or the one workspace) when the address names no ticket or no workspace.
 */
export function linkWorkspace(search: string): string {
  const params = new URLSearchParams(search);
  if (!readIssueUrl(search)) return "";
  return params.get("ws")?.trim() ?? "";
}

/** The identifier's prefix: `STA` for `STA-12`, upper-cased; `""` when it has none. */
function refPrefix(ref: string): string {
  const at = ref.lastIndexOf("-");
  return at > 0 ? ref.slice(0, at).toUpperCase() : "";
}

/** Which workspace to read the requested ticket from. See the file header. */
export function resolveIssueWorkspace(
  request: IssueRequest,
  scope: { mode: UiMode; workspaces: readonly WorkspaceRef[] },
): string {
  if (scope.mode !== "hub") return scope.workspaces[0]?.slug ?? request.workspace;
  if (request.workspace) return request.workspace;
  const prefix = refPrefix(request.ref);
  const matches = scope.workspaces.filter((workspace) => workspace.prefix.toUpperCase() === prefix);
  if (matches.length === 1) return matches[0]!.slug;
  return scope.workspaces[0]?.slug ?? "";
}

/**
 * The href with the open ticket written in (or removed, `null`), every other parameter kept.
 * `issue-ws` is decided against the `ws` the href carries at the moment of writing, so a
 * write queued behind a navigation compares against the page it lands on.
 */
export function withIssue(href: string, selection: Pick<Selection, "workspace" | "ref"> | null, hub: boolean): string {
  const url = new URL(href);
  const params = url.searchParams;
  params.delete(ISSUE_PARAM);
  params.delete(ISSUE_WS_PARAM);
  if (selection) {
    params.set(ISSUE_PARAM, selection.ref);
    const pageWs = params.get("ws") ?? "";
    if (hub && selection.workspace && selection.workspace !== pageWs) params.set(ISSUE_WS_PARAM, selection.workspace);
  }
  return url.toString();
}

/** The same ticket? By workspace and ref; the pinned id is the detail's business. */
export function sameIssue(
  a: Pick<Selection, "workspace" | "ref"> | null,
  b: Pick<Selection, "workspace" | "ref"> | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.workspace === b.workspace && a.ref === b.ref;
}

/**
 * What a change of the open ticket does to history.
 *
 *   push    — opened from the page: one overlay entry carrying `issue`.
 *   replace — another ticket in the open detail, or a ticket that arrived with the address:
 *             the entry is rewritten in place.
 *   pop     — closed while our entry is still there: step back past it.
 *   strip   — closed with no entry of ours (it arrived with the address): remove the
 *             parameter in place.
 *   none    — nothing changed, or there is nothing to remove.
 */
export type IssueHistoryStep = "push" | "replace" | "pop" | "strip" | "none";

export function issueHistoryStep(input: {
  before: Pick<Selection, "workspace" | "ref"> | null;
  after: Pick<Selection, "workspace" | "ref"> | null;
  /** Our overlay entry exists and is still in the current entry's stack. */
  entryOpen: boolean;
  /** The address carries `issue` right now. */
  addressHasIssue: boolean;
}): IssueHistoryStep {
  const { before, after, entryOpen, addressHasIssue } = input;
  if (sameIssue(before, after)) return "none";
  if (after) return before === null && !entryOpen && !addressHasIssue ? "push" : "replace";
  if (entryOpen) return "pop";
  return addressHasIssue ? "strip" : "none";
}

/**
 * The detail's not-found state, in words: the ticket the address (or a row) asked for is not
 * there. `null` for any other failure, which keeps the plain error chip. A workspace this
 * page does not have is named as such, so a link from another machine does not read as a
 * deleted ticket.
 */
export function issueNotFoundText(
  error: { status?: number } | undefined,
  selection: Pick<Selection, "workspace" | "ref">,
  scope: { mode: UiMode; workspaces: readonly WorkspaceRef[] },
): { title: string; body: string } | null {
  if (!error || error.status !== 404) return null;
  const title = `${selection.ref} was not found`;
  if (scope.mode === "hub" && selection.workspace && !scope.workspaces.some((w) => w.slug === selection.workspace)) {
    return { title, body: `This page has no workspace called "${selection.workspace}". The link may come from another computer.` };
  }
  const where = scope.mode === "hub" && selection.workspace ? ` in the "${selection.workspace}" workspace` : "";
  return { title, body: `There is no ticket ${selection.ref}${where}. It may have been deleted, or the link names another ticket.` };
}
