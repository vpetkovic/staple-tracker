/**
 * The queue view: the pickup queue in lanes, in the agent's thread.
 *
 * It renders a `show_queue` result (`structuredContent.queue`, built by
 * `src/mcp-queue.ts`): Ready in pickup order, Gated grouped by the gate that holds the
 * work, In progress with who holds each ticket and how its attempt is going. `inbox` and
 * `list_queue` declare this view too; their payloads are not lanes, so the view asks for
 * the lanes with `show_queue` through the host (a read, so no host asks the person first).
 *
 * Take on a ready row posts "Work <REF>" into the thread as the person's message
 * (`ui/message`; the host confirms it first), which hands the ticket to the agent. Under a
 * strict queue only the row checkout accepts now offers Take. Approve on a gated row calls
 * `approve_task` through the host, which asks the person before it runs it; the view then
 * reads the lanes again. Refresh reads them again on a click.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "../shared/base.css";
import "./queue.css";
import { h, resultText, startView, type ViewHost } from "../shared/runtime.js";

interface LaneRow {
  identifier: string;
  title: string;
  position: number;
  planPosition: number | null;
  path: string[];
}

interface ReadyRow extends LaneRow {
  takeable: boolean;
}

interface GateGroup {
  identifier: string;
  title: string;
  owner: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  holds: LaneRow[];
  approve: boolean;
}

interface WorkingRow extends LaneRow {
  heldBy: string;
  idleSeconds: number | null;
  attempt: { ordinal: number; state: string; startedAt: string } | null;
  milestoneCount: number;
  lastMilestone: string | null;
  timing: { estimatedSeconds: number | null; elapsedSeconds: number | null };
}

interface Lanes {
  workspace: string;
  revision: number;
  scope: { identifier: string; title: string; kind: string } | null;
  policy: "advisory" | "strict";
  expected: { identifier: string; title: string; position: number } | null;
  next: string | null;
  ready: ReadyRow[];
  gated: GateGroup[];
  inProgress: WorkingRow[];
  blocked: Array<{ identifier: string; title: string; blockers: string[] }>;
  unavailable: Array<{ identifier: string; title: string; status: string }>;
  totals: { ready: number; gated: number; inProgress: number; blocked: number; unavailable: number };
  asOf: string;
}

/** A result that is not lanes (inbox, list_queue): the view reads the lanes itself. */
type Shown = { lanes: Lanes } | { pending: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(result: CallToolResult): Shown | null {
  const data = result.structuredContent;
  if (!isRecord(data)) return null;
  const queue = data.queue;
  if (isRecord(queue) && Array.isArray(queue.ready) && Array.isArray(queue.gated) && Array.isArray(queue.inProgress)) {
    return { lanes: queue as unknown as Lanes };
  }
  // inbox answers {ready, queued, blocked}; list_queue answers {revision, entries, effective}.
  if (Array.isArray(data.ready) || Array.isArray(data.effective)) return { pending: true };
  return null;
}

const root = document.getElementById("view")!;

/** Stored with an approval from the view, so the ticket's history says where it came from. */
const APPROVE_COMMENT = "Approved from the queue in the thread.";

/** How many rows a lane shows before "Show all". */
const FOLDED_ROWS = 5;

/** What survives a re-render (a theme change re-renders). */
const state = {
  busy: false,
  note: "",
  noteTone: "info" as "info" | "error",
  /** Tickets whose Take message the host sent, this session. */
  sent: new Set<string>(),
  /** Lanes a person unfolded. */
  unfolded: new Set<string>(),
  /** A show_queue read for a non-lanes result is in flight. */
  fetching: false,
};

/** The arguments every follow-up read passes on: the same workspace and the same scope. */
function readArguments(host: ViewHost): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const { ws, scope } = host.toolArguments;
  if (typeof ws === "string" && ws.trim() !== "") args.ws = ws;
  if (typeof scope === "string" && scope.trim() !== "") args.scope = scope;
  return args;
}

function wsArgument(host: ViewHost): Record<string, unknown> {
  const ws = host.toolArguments.ws;
  return typeof ws === "string" && ws.trim() !== "" ? { ws } : {};
}

/** A refusal's prose line, without the `ERROR(code):` prefix and the JSON envelope under it. */
function refusal(result: CallToolResult): string {
  const text = resultText(result).split("\n", 1)[0] ?? "";
  return text.replace(/^ERROR\([^)]*\):\s*/, "") || "The call failed.";
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^MCP error -?\d+:\s*/, "").trim() || "The host gave no reason.";
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}

let lastShown: Shown | null = null;
function rerender(host: ViewHost): void {
  if (lastShown) render(lastShown, host);
}

function say(host: ViewHost, note: string, tone: "info" | "error" = "info"): void {
  state.note = note;
  state.noteTone = tone;
  rerender(host);
}

/** Read the lanes again through the host and show them; `after` is the note to keep showing. */
async function refresh(host: ViewHost, after: string): Promise<void> {
  try {
    const result = await host.callTool("show_queue", readArguments(host));
    state.busy = false;
    if (result.isError || read(result) === null || !("lanes" in read(result)!)) {
      say(host, `${after ? `${after} ` : ""}Reading the queue again failed: ${refusal(result)}`, "error");
      return;
    }
    state.note = after;
    state.noteTone = "info";
    host.show(result);
  } catch (error) {
    state.busy = false;
    say(host, `${after ? `${after} ` : ""}Reading the queue again failed: ${errorText(error)}`, "error");
  }
}

async function take(host: ViewHost, row: ReadyRow): Promise<void> {
  const message = `Work ${row.identifier}`;
  state.busy = true;
  say(host, `Asking the host to send “${message}”…`);
  try {
    const sent = await host.sendMessage(message);
    state.busy = false;
    if (!sent) {
      say(host, "The host did not send the message.", "error");
      return;
    }
    state.sent.add(row.identifier);
    say(host, `Sent “${message}” to the thread.`);
  } catch (error) {
    state.busy = false;
    say(host, `The message was not sent: ${errorText(error)}`, "error");
  }
}

async function approve(host: ViewHost, group: GateGroup): Promise<void> {
  state.busy = true;
  say(host, `Asking the host to approve ${group.identifier}…`);
  try {
    const result = await host.callTool("approve_task", { ref: group.identifier, comment: APPROVE_COMMENT, ...wsArgument(host) });
    if (result.isError) {
      state.busy = false;
      say(host, refusal(result), "error");
      return;
    }
    await refresh(host, `Approved ${group.identifier}.`);
  } catch (error) {
    state.busy = false;
    say(host, `Approve did not go through: ${errorText(error)}`, "error");
  }
}

function rowHead(row: { identifier: string; title: string }, ...extra: Array<HTMLElement | null>): HTMLElement {
  return h(
    "p",
    { class: "queue-row-head" },
    h("span", { class: "queue-id view-mono" }, row.identifier),
    ...extra,
    h("span", { class: "queue-title" }, row.title),
  );
}

/** Where a row sits: its effective position, its plan row (or the unqueued band), its path. */
function whereLine(row: LaneRow): string {
  const parts = [`pos ${row.position}`, row.planPosition === null ? "unqueued" : `plan ${row.planPosition}`];
  if (row.path.length > 0) parts.push(row.path.join(" › "));
  return parts.join(" · ");
}

/** A lane: its heading with the count, its rows (folded past {@link FOLDED_ROWS}), or an empty line. */
function lane(
  host: ViewHost,
  key: string,
  title: string,
  total: number,
  items: HTMLElement[],
  empty: string,
): HTMLElement {
  const unfolded = state.unfolded.has(key);
  const visible = unfolded ? items : items.slice(0, FOLDED_ROWS);
  const section = h(
    "section",
    { class: "queue-lane", "data-lane": key, "aria-label": title },
    h("h2", { class: "queue-heading" }, title, h("span", { class: "view-muted queue-count", "data-count": String(total) }, String(total))),
    visible.length > 0 ? h("ul", { class: "queue-rows" }, ...visible) : h("p", { class: "queue-empty view-muted" }, empty),
  );
  const hidden = total - visible.length;
  if (hidden > 0) {
    if (items.length > visible.length) {
      const all = h("button", { class: "queue-more", type: "button", "data-action": "show-all" }, `Show ${items.length - visible.length} more`);
      all.addEventListener("click", () => {
        state.unfolded.add(key);
        rerender(host);
      });
      section.append(all);
    } else {
      section.append(h("p", { class: "queue-empty view-muted" }, `${hidden} more not shown`));
    }
  }
  return section;
}

function readyLane(lanes: Lanes, host: ViewHost): HTMLElement {
  const items = lanes.ready.map((row, index) => {
    const sent = state.sent.has(row.identifier);
    let action: HTMLElement;
    if (sent) {
      action = h("span", { class: "queue-sent", "data-sent": "" }, "Sent");
    } else if (row.takeable) {
      const button = h(
        "button",
        { class: `view-button${index === 0 ? " view-button-primary" : ""}`, type: "button", "data-action": "take", title: `Post “Work ${row.identifier}” into the thread` },
        "Take",
      );
      button.disabled = state.busy;
      button.addEventListener("click", () => void take(host, row));
      action = button;
    } else {
      action = h("span", { class: "queue-wait view-muted", "data-waits-for": lanes.expected?.identifier ?? "" }, `after ${lanes.expected?.identifier ?? "the next row"}`);
    }
    return h(
      "li",
      { class: "queue-row", "data-row": row.identifier, ...(index === 0 ? { "data-next": "" } : {}), ...(sent ? { "data-taken": "" } : {}) },
      h(
        "div",
        { class: "queue-row-body" },
        rowHead(row, index === 0 ? h("span", { class: "queue-badge" }, "Next") : null),
        h("p", { class: "queue-row-detail view-muted" }, whereLine(row)),
      ),
      h("div", { class: "queue-row-action" }, action),
    );
  });
  return lane(host, "ready", "Ready", lanes.totals.ready, items, "Nothing is ready to take.");
}

function gatedLane(lanes: Lanes, host: ViewHost): HTMLElement {
  const items = lanes.gated.map((group) => {
    const held = group.holds.map((row) => row.identifier).filter((id) => id !== group.identifier);
    const detail = [group.owner ? `waiting on ${group.owner}` : "awaiting approval"];
    if (group.requestedBy) detail.push(`asked by ${group.requestedBy}`);
    let action: HTMLElement | null = null;
    if (group.approve) {
      const button = h("button", { class: "view-button view-button-primary", type: "button", "data-action": "approve", title: `Approve the gate on ${group.identifier}` }, "Approve");
      button.disabled = state.busy;
      button.addEventListener("click", () => void approve(host, group));
      action = button;
    }
    return h(
      "li",
      { class: "queue-row", "data-gate": group.identifier },
      h(
        "div",
        { class: "queue-row-body" },
        rowHead(group),
        h(
          "p",
          { class: "queue-row-detail queue-owner", "data-owner": group.owner ?? "" },
          ...detail.flatMap((part, index) => [index > 0 ? " · " : "", h("span", { class: "queue-nowrap" }, part)]),
        ),
        held.length > 0 ? h("p", { class: "queue-row-detail view-muted", "data-holds": held.join(",") }, `holds ${held.join(", ")}`) : null,
      ),
      action ? h("div", { class: "queue-row-action" }, action) : null,
    );
  });
  return lane(host, "gated", "Gated", lanes.totals.gated, items, "Nothing is waiting on a person.");
}

function workingLane(lanes: Lanes, host: ViewHost): HTMLElement {
  const items = lanes.inProgress.map((row) => {
    const facts = [row.heldBy];
    if (row.attempt) facts.push(`#${row.attempt.ordinal} ${row.attempt.state.replace(/_/g, " ")}`);
    facts.push(`${row.milestoneCount} milestone${row.milestoneCount === 1 ? "" : "s"}`);
    const { estimatedSeconds, elapsedSeconds } = row.timing;
    const elapsed = elapsedSeconds ?? 0;
    const over = estimatedSeconds !== null && elapsed > estimatedSeconds;
    let bar: HTMLElement | null = null;
    if (estimatedSeconds !== null && estimatedSeconds > 0) {
      const fill = h("span", { class: "queue-bar-fill" });
      fill.style.width = `${Math.round(Math.min(1, elapsed / estimatedSeconds) * 100)}%`;
      bar = h(
        "span",
        {
          class: "queue-bar",
          role: "meter",
          "aria-label": "Time spent against the estimate",
          "aria-valuemin": "0",
          "aria-valuemax": String(estimatedSeconds),
          "aria-valuenow": String(Math.min(elapsed, estimatedSeconds)),
          "data-over": over ? "true" : "false",
        },
        fill,
      );
    }
    const time =
      estimatedSeconds !== null
        ? `${duration(elapsed)} of ${duration(estimatedSeconds)}`
        : elapsed > 0
          ? `${duration(elapsed)}, no estimate`
          : null;
    return h(
      "li",
      { class: "queue-row", "data-row": row.identifier, "data-held-by": row.heldBy },
      h(
        "div",
        { class: "queue-row-body" },
        rowHead(row),
        h("p", { class: "queue-row-detail", "data-progress": String(row.milestoneCount) }, facts.join(" · ")),
        row.lastMilestone ? h("p", { class: "queue-row-detail view-muted queue-milestone" }, `Last: ${row.lastMilestone}`) : null,
        time ? h("p", { class: "queue-row-detail view-muted queue-time", "data-time": over ? "over" : "within" }, time, bar) : null,
      ),
    );
  });
  return lane(host, "in-progress", "In progress", lanes.totals.inProgress, items, "Nobody is working on anything.");
}

function strictLine(lanes: Lanes): HTMLElement | null {
  if (lanes.policy !== "strict") return null;
  const text = lanes.expected
    ? lanes.ready.some((row) => row.identifier === lanes.expected!.identifier)
      ? `Strict queue: checkout takes ${lanes.expected.identifier} now; the rest wait for it.`
      : `Strict queue: checkout takes ${lanes.expected.identifier} ${lanes.expected.title} first, outside this view.`
    : "Strict queue: no plan row is ready, so any ready row can be taken.";
  return h("p", { class: "queue-strict", "data-expected": lanes.expected?.identifier ?? "" }, text);
}

function footer(lanes: Lanes, host: ViewHost): HTMLElement {
  const parts: HTMLElement[] = [];
  if (lanes.blocked.length > 0) {
    const named = lanes.blocked.map((row) => `${row.identifier}${row.blockers.length > 0 ? ` (by ${row.blockers.join(", ")})` : ""}`);
    const more = lanes.totals.blocked - lanes.blocked.length;
    parts.push(h("p", { class: "queue-aside view-muted", "data-blocked": String(lanes.totals.blocked) }, `Blocked: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`));
  }
  if (lanes.unavailable.length > 0) {
    parts.push(
      h(
        "p",
        { class: "queue-aside view-muted", "data-unavailable": String(lanes.totals.unavailable) },
        `Not takeable now: ${lanes.unavailable.map((row) => `${row.identifier} (${row.status.replace(/_/g, " ")})`).join(", ")}`,
      ),
    );
  }
  const refreshButton = h("button", { class: "view-button", type: "button", "data-action": "refresh" }, "Refresh");
  refreshButton.disabled = state.busy || host.canCallTools === false;
  refreshButton.addEventListener("click", () => {
    state.busy = true;
    say(host, "Reading the queue again…");
    void refresh(host, "");
  });
  return h("footer", { class: "queue-foot" }, h("div", { class: "queue-asides" }, ...parts), refreshButton);
}

function renderLanes(lanes: Lanes, host: ViewHost): void {
  const summary = [`${lanes.totals.ready} ready`, `${lanes.totals.gated} gated`, `${lanes.totals.inProgress} in progress`];
  if (lanes.totals.blocked > 0) summary.push(`${lanes.totals.blocked} blocked`);
  root.replaceChildren(
    h(
      "article",
      {
        class: "view-card queue",
        "data-view": "queue",
        "data-policy": lanes.policy,
        "data-next": lanes.next ?? "",
        "data-revision": String(lanes.revision),
        "aria-label": "Pickup queue",
      },
      h(
        "header",
        { class: "queue-head" },
        h("h1", { class: "queue-name" }, "Queue", lanes.scope ? h("span", { class: "queue-scope view-muted" }, ` · ${lanes.scope.identifier} ${lanes.scope.title}`) : null),
        h("span", { class: "view-pill", "data-policy-pill": lanes.policy, title: "queue.policy" }, lanes.policy),
      ),
      h("p", { class: "queue-summary view-muted" }, summary.join(" · ")),
      strictLine(lanes),
      readyLane(lanes, host),
      gatedLane(lanes, host),
      workingLane(lanes, host),
      state.note ? h("p", { class: `queue-note queue-note-${state.noteTone}`, role: "status", "data-action-note": "" }, state.note) : null,
      footer(lanes, host),
    ),
  );
}

function renderPending(host: ViewHost): void {
  root.replaceChildren(
    h(
      "article",
      { class: "view-card queue", "data-view": "queue", "data-partial": "" },
      h("header", { class: "queue-head" }, h("h1", { class: "queue-name" }, "Queue")),
      h("p", { class: `queue-note queue-note-${state.noteTone}`, role: "status", "data-action-note": "" }, state.note || "Loading the queue…"),
    ),
  );
  if (state.fetching || state.noteTone === "error") return;
  if (host.canCallTools === false) {
    state.note = "This host does not let views read the queue. Ask the agent to call show_queue.";
    state.noteTone = "error";
    rerender(host);
    return;
  }
  state.fetching = true;
  host
    .callTool("show_queue", wsArgument(host))
    .finally(() => {
      state.fetching = false;
    })
    .then((result) => {
      const shown = result.isError ? null : read(result);
      if (shown === null || !("lanes" in shown)) {
        say(host, `Could not load the queue: ${refusal(result)}`, "error");
        return;
      }
      host.show(result);
    })
    .catch((error: unknown) => {
      say(host, `Could not load the queue: ${errorText(error)}`, "error");
    });
}

function render(shown: Shown, host: ViewHost): void {
  lastShown = shown;
  if ("lanes" in shown) renderLanes(shown.lanes, host);
  else renderPending(host);
}

startView({ name: "queue", root, read, render });
