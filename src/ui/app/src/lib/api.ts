/**
 * The only thing in this app that calls fetch().
 *
 * It owns three things nobody else should re-implement:
 *   1. the token — captured from the URL `staple ui` printed, kept in sessionStorage,
 *      scrubbed from the address bar, and sent as X-Staple-Token on every request;
 *   2. the 401/403 contract — those become a typed AuthError, never an unhandled
 *      rejection, so the shell can render the token screen instead of a blank page;
 *   3. the error envelope — the server answers { error, message, code, retryable } for
 *      every failure, and this turns that into an Error with those fields attached.
 *
 * WAVE 2: import from here. Adding an endpoint means adding a function here.
 */
import type {
  ActionPayload,
  AgentContext,
  Bootstrap,
  DocumentRevision,
  ErrorEnvelope,
  Graph,
  InboxRow,
  IssueDetail,
  IssueDocument,
  IssueRow,
  Poll,
  StapleEvent,
} from "./types";

const TOKEN_KEY = "staple:token";

/**
 * Thrown for 401 and 403. The shell catches this specific type and swaps the whole
 * page for the token screen — every other failure is local to the view that asked.
 */
export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

/** A non-auth failure carrying the server's envelope fields. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;
  constructor(status: number, envelope: Partial<ErrorEnvelope>) {
    super(envelope.message ?? envelope.error ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope.code ?? "unknown";
    this.retryable = envelope.retryable ?? false;
    if (envelope.detail) this.detail = envelope.detail;
  }
}

function readSession(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return ""; // private mode
  }
}

function writeSession(value: string): void {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lives for this page load only */
  }
}

/**
 * Runs once at module load, before React mounts.
 *
 * The server hands the token over exactly once, in the URL it printed. Stash it in
 * sessionStorage — origin-scoped, so it is per staple instance and dies with the tab —
 * then strip it from the address bar so it stays out of bookmarks, history, and the
 * Referer of any external link a rendered document happens to contain.
 */
let token: string = (() => {
  /**
   * NO BROWSER, NO TOKEN — O6 (STA-138).
   *
   * This IIFE reads `location` at module scope, which is correct in the app and fatal
   * anywhere else: the task-list suites render the row with `react-dom/server` in a Node
   * environment, and since the row can now open the Dependencies dialog, this module is in
   * the row's import graph. Without the guard, importing a ROW throws `location is not
   * defined` before a single assertion runs.
   *
   * Returning "" is the honest answer rather than a workaround. There is no URL to read a
   * token out of and no session to fall back on, so the module is left in exactly the state
   * `forgetToken()` leaves it in — `hasToken()` false — and every caller already handles
   * that. Nothing that is supposed to work in a browser behaves differently.
   */
  if (typeof location === "undefined") return "";
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (!fromUrl) return readSession();
  writeSession(fromUrl);
  params.delete("token");
  const qs = params.toString();
  history.replaceState({}, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  return fromUrl;
})();

export function hasToken(): boolean {
  return token.length > 0;
}

/** Drop the token we hold — called when the server tells us it is no longer valid. */
export function forgetToken(): void {
  token = "";
  writeSession("");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-staple-token": token },
  });

  if (res.status === 401 || res.status === 403) {
    // 401 is almost always a restarted server: the old token died with the old
    // process. Forget it so a reload shows the token screen rather than retrying
    // a credential that can never work again.
    if (res.status === 401) forgetToken();
    const envelope = (await res.json().catch(() => ({}))) as Partial<ErrorEnvelope>;
    const failure = new AuthError(res.status, envelope.code ?? "unauthorized", envelope.message ?? envelope.error ?? res.statusText);
    // Write handlers catch errors locally to render refusals; an AuthError must
    // still reach the shell, so it is broadcast as well as thrown.
    window.dispatchEvent(new CustomEvent("staple:auth-error", { detail: failure }));
    throw failure;
  }

  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new ApiError(res.status, body as Partial<ErrorEnvelope>);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
};

// ---------- reads ----------

export const getBootstrap = () => request<Bootstrap>("/api/bootstrap");

export const getPoll = () => request<Poll>("/api/poll");

export const getIssues = (params: { ws?: string; assignee?: string } = {}) =>
  request<IssueRow[]>(`/api/issues${qs(params)}`);

export const getInbox = (params: { assignee?: string } = {}) =>
  request<InboxRow[]>(`/api/inbox${qs(params)}`);

export const getIssue = (params: { ws?: string; ref: string }) =>
  request<IssueDetail>(`/api/issue${qs(params)}`);

export const getDocument = (params: { ws?: string; ref: string; key: string; revision?: number }) =>
  request<IssueDocument>(`/api/document${qs(params)}`);

/** A document's history, newest revision first. */
export const getRevisions = (params: { ws?: string; ref: string; key: string }) =>
  request<DocumentRevision[]>(`/api/revisions${qs(params)}`);

/**
 * The MCP `get_task` payload for one issue, byte-identical to what an agent receives.
 * `documents` maps to get_task's `include_documents` and defaults off, as it does there.
 */
export const getAgentContext = (params: { ws?: string; ref: string; documents?: boolean }) =>
  request<AgentContext>(
    `/api/agent-context${qs({ ws: params.ws, ref: params.ref, documents: params.documents ? "1" : undefined })}`,
  );

export const getGraph = () => request<Graph>("/api/graph");

/**
 * The event log. Workspace-scoped by default and capped at 100; pass `issue` (a ref)
 * for one issue's whole history instead — the detail timeline needs the latter, since
 * on a busy workspace an issue's first status change falls outside the 100.
 */
export const getEvents = (params: { ws?: string; since?: number; issue?: string } = {}) =>
  request<StapleEvent[]>(`/api/events${qs(params)}`);

// ---------- writes ----------

/**
 * The single write endpoint. The server pins it to POST and checks Origin, so this
 * must stay a same-origin POST with a JSON body — do not "helpfully" switch it to a
 * GET with query params.
 *
 * `ref` is optional because `{ type: "create" }` has no issue to point at yet. Every
 * other action needs one, and the server's `not_found` on a missing ref is the guard
 * for that — one refusal path rather than a client-side pre-check that could disagree
 * with it.
 */
export const action = <T = unknown>(target: { ws?: string; ref?: string; actor?: string }, payload: ActionPayload) =>
  request<T>("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...target, ...payload }),
  });
