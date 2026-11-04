/**
 * The progress view: one ticket's current attempt, live, in the agent's thread.
 *
 * It renders a `show_progress` result (`structuredContent.progress`, built by
 * `src/mcp-progress.ts`): the attempt, its timeline of milestones and comments, estimate
 * against elapsed, and the last activity.
 *
 * LIVE. While the attempt is open the view reads the progress again every `refreshSeconds`
 * by calling `show_progress` through the host. That tool is read-only, so a host runs it
 * without asking anyone. One call is in flight at most, and none while the page is hidden.
 *
 * STOPPING. The view stops refreshing, and says why, when:
 *
 *   - the host refuses the call twice in a row (a host whose agent session has ended says so
 *     here: T3 Code answers "The app's thread is not running…"), or the call fails twice;
 *   - the host tears the view down (`ui/resource-teardown`);
 *   - the attempt is no longer open (nothing will move until someone claims the ticket);
 *   - the host said in the handshake that views cannot call tools.
 *
 * Check again reads once more on a person's click, and refreshing resumes if that works.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "../shared/base.css";
import "./progress.css";
import { h, resultText, startView, type ViewHost } from "../shared/runtime.js";

type Kind = "started" | "milestone" | "paused" | "resumed" | "interrupted" | "ended" | "comment";

interface Entry {
  kind: Kind;
  at: string;
  actor: string | null;
  text: string;
  detail: string | null;
}

interface Progress {
  workspace: string;
  identifier: string;
  title: string;
  status: { id: string; label: string; category: string };
  assignee: string | null;
  attempt: {
    id: string;
    ordinal: number;
    agent: string;
    state: string;
    current: boolean;
    startedAt: string;
    endedAt: string | null;
    outcome: string | null;
    endReason: string | null;
  } | null;
  timeline: Entry[];
  earlier: number;
  milestoneCount: number;
  timing: { estimatedSeconds: number | null; elapsedSeconds: number | null };
  lastActivityAt: string | null;
  live: boolean;
  refreshSeconds: number;
  asOf: string;
  url: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(result: CallToolResult): Progress | null {
  const data = result.structuredContent;
  if (!isRecord(data) || !isRecord(data.progress)) return null;
  const progress = data.progress;
  return typeof progress.identifier === "string" && Array.isArray(progress.timeline) ? (progress as unknown as Progress) : null;
}

const root = document.getElementById("view")!;

/** Two failed reads in a row stop the refresh: one can be a blip, two is the host saying no. */
const FAILURES_TO_STOP = 2;

/** The refresh loop's state, for the ticket on screen. */
const loop = {
  identifier: "",
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  inFlight: false,
  failures: 0,
  /** Why refreshing stopped, in the host's or the server's words; null while it runs. */
  stopped: null as string | null,
  tornDown: false,
  /** A Check again click is being answered. */
  checking: false,
};

let host: ViewHost | undefined;
let shown: Progress | null = null;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // The SDK prefixes a JSON-RPC error with its code; the host's sentence is what a person reads.
  return text.replace(/^MCP error -?\d+:\s*/, "").trim() || "The host gave no reason.";
}

/** A refusal's prose line, without the `ERROR(code):` prefix and the JSON envelope under it. */
function refusal(result: CallToolResult): string {
  const text = resultText(result).split("\n", 1)[0] ?? "";
  return text.replace(/^ERROR\([^)]*\):\s*/, "") || "The server gave no reason.";
}

/** The `ws` the agent called with, passed on so every refresh reads the same workspace. */
function wsArgument(): Record<string, unknown> {
  const ws = host?.toolArguments.ws;
  return typeof ws === "string" && ws.trim() !== "" ? { ws } : {};
}

function clearTimer(): void {
  if (loop.timer !== undefined) clearTimeout(loop.timer);
  loop.timer = undefined;
}

/** Whether the view should keep reading on its own, now. */
function refreshing(progress: Progress): boolean {
  return progress.live && loop.stopped === null && !loop.tornDown && host?.canCallTools !== false;
}

function schedule(): void {
  if (shown === null || !refreshing(shown) || loop.timer !== undefined || loop.inFlight) return;
  const seconds = Number.isFinite(shown.refreshSeconds) && shown.refreshSeconds > 0 ? shown.refreshSeconds : 5;
  loop.timer = setTimeout(() => {
    loop.timer = undefined;
    void tick();
  }, seconds * 1000);
}

function fail(reason: string): void {
  loop.failures += 1;
  if (loop.failures >= FAILURES_TO_STOP) {
    loop.stopped = reason;
    clearTimer();
  }
}

/** Read the progress once through the host and show it. */
async function tick(): Promise<void> {
  if (shown === null || host === undefined || loop.inFlight || loop.tornDown) return;
  // A hidden page reads nothing; it reads at once when it is shown again.
  if (document.visibilityState === "hidden") return;
  loop.inFlight = true;
  const identifier = shown.identifier;
  try {
    const result = await host.callTool("show_progress", { ref: identifier, ...wsArgument() });
    if (loop.tornDown || identifier !== loop.identifier) return;
    const next = result.isError ? null : read(result);
    if (next === null) {
      fail(result.isError ? `The server answered: ${refusal(result)}` : "The server's answer had no progress in it.");
    } else {
      loop.failures = 0;
      loop.stopped = null;
      loop.inFlight = false;
      loop.checking = false;
      host.show(result);
      return;
    }
  } catch (error) {
    if (loop.tornDown || identifier !== loop.identifier) return;
    fail(errorText(error));
  } finally {
    loop.inFlight = false;
  }
  loop.checking = false;
  rerender();
  schedule();
}

function rerender(): void {
  if (shown !== null && host !== undefined) render(shown, host);
}

function checkAgain(): void {
  clearTimer();
  loop.stopped = null;
  // A person asked: one more refusal stops it again at once, with the reason.
  loop.failures = FAILURES_TO_STOP - 1;
  loop.checking = true;
  rerender();
  void tick();
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

function formatOptions(view: ViewHost): { locale: string | undefined; timeZone: string | undefined } {
  return {
    locale: typeof view.context?.locale === "string" ? view.context.locale : undefined,
    timeZone: typeof view.context?.timeZone === "string" ? view.context.timeZone : undefined,
  };
}

function formatted(iso: string, view: ViewHost, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const { locale, timeZone } = formatOptions(view);
  try {
    return date.toLocaleString(locale, { ...options, timeZone });
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** The calendar day of an instant in the host's time zone, to tell today from other days. */
function day(iso: string, view: ViewHost): string {
  return formatted(iso, view, { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** A timeline time: the clock alone on the day of the reading, else the date too. */
function entryTime(iso: string, asOf: string, view: ViewHost): string {
  return day(iso, view) === day(asOf, view)
    ? formatted(iso, view, { hour: "2-digit", minute: "2-digit" })
    : formatted(iso, view, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** `40s ago`, `12m ago`, `2h 05m ago`, measured against the server's own clock. */
function ago(iso: string, asOf: string): string {
  const seconds = (Date.parse(asOf) - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return iso;
  return seconds < 5 ? "just now" : `${duration(seconds)} ago`;
}

const words = (value: string): string => value.replace(/_/g, " ");

function liveLine(progress: Progress, view: ViewHost): HTMLElement {
  const updated = formatted(progress.asOf, view, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let state: string;
  let text: string;
  if (loop.stopped !== null) {
    state = "stopped";
    text = `Live updates stopped. ${loop.stopped}`;
  } else if (loop.tornDown) {
    state = "stopped";
    text = "Live updates stopped: the host closed this view.";
  } else if (!progress.live) {
    state = "idle";
    text = progress.attempt === null ? `No attempt yet, so nothing to follow · read ${updated}` : `Attempt ended, so not refreshing · read ${updated}`;
  } else if (view.canCallTools === false) {
    state = "static";
    text = `This host does not let views read on their own, so this will not refresh · read ${updated}`;
  } else if (loop.checking) {
    state = "checking";
    text = "Checking…";
  } else {
    state = "live";
    text = `Live · updated ${updated}`;
  }
  const line = h(
    "div",
    { class: "progress-live", "data-live": state, role: "status" },
    h("span", { class: "progress-live-dot", "aria-hidden": "true" }),
    h("span", { class: "progress-live-text" }, text),
  );
  const canAsk = view.canCallTools !== false && !loop.tornDown;
  if (canAsk && (state === "stopped" || state === "idle")) {
    const again = h("button", { class: "view-button progress-again", type: "button", "data-action": "check-again" }, "Check again");
    again.addEventListener("click", checkAgain);
    line.append(again);
  }
  return line;
}

function attemptLine(progress: Progress, view: ViewHost): HTMLElement {
  const attempt = progress.attempt;
  if (attempt === null) return h("p", { class: "progress-meta view-muted" }, progress.assignee ? `Assigned to ${progress.assignee} · not started` : "Not started");
  const state = `${words(attempt.state)}${attempt.outcome ? ` (${words(attempt.outcome)})` : ""}`;
  return h(
    "p",
    { class: "progress-meta view-muted", "data-attempt": attempt.state },
    `${attempt.current ? "Attempt" : "Last attempt"} #${attempt.ordinal} · ${attempt.agent} · ${state} · since ${formatted(attempt.startedAt, view, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  );
}

function factsSection(progress: Progress): HTMLElement | null {
  const rows: HTMLElement[] = [];
  const { estimatedSeconds, elapsedSeconds } = progress.timing;
  if (estimatedSeconds !== null || (elapsedSeconds ?? 0) > 0) {
    const elapsed = elapsedSeconds ?? 0;
    const over = estimatedSeconds !== null && elapsed > estimatedSeconds;
    const value = h(
      "dd",
      { "data-time": over ? "over" : "within" },
      estimatedSeconds !== null ? `${duration(elapsed)} of ${duration(estimatedSeconds)} estimate` : `${duration(elapsed)}, no estimate`,
    );
    if (estimatedSeconds !== null && estimatedSeconds > 0) {
      const fill = h("span", { class: "progress-bar-fill" });
      fill.style.width = `${Math.round(Math.min(1, elapsed / estimatedSeconds) * 100)}%`;
      value.append(
        h(
          "span",
          {
            class: "progress-bar",
            role: "meter",
            "aria-label": "Time spent against the estimate",
            "aria-valuemin": "0",
            "aria-valuemax": String(estimatedSeconds),
            "aria-valuenow": String(Math.min(elapsed, estimatedSeconds)),
            "data-over": over ? "true" : "false",
          },
          fill,
        ),
      );
    }
    rows.push(h("dt", {}, "Time"), value);
  }
  if (progress.lastActivityAt) {
    rows.push(h("dt", {}, "Last activity"), h("dd", { "data-last-activity": "" }, ago(progress.lastActivityAt, progress.asOf)));
  }
  return rows.length === 0 ? null : h("dl", { class: "progress-facts" }, ...rows);
}

function timelineSection(progress: Progress, view: ViewHost): HTMLElement | null {
  if (progress.attempt === null) return null;
  const items = progress.timeline.map((entry) =>
    h(
      "li",
      { class: "progress-entry", "data-entry": entry.kind },
      h("span", { class: "progress-marker", "aria-hidden": "true" }),
      h(
        "div",
        { class: "progress-entry-body" },
        h(
          "p",
          { class: "progress-entry-line" },
          h("time", { class: "progress-time view-muted", datetime: entry.at }, entryTime(entry.at, progress.asOf, view)),
          h("span", { class: "progress-entry-text" }, entry.text),
        ),
        entry.detail !== null || (entry.kind === "comment" && entry.actor)
          ? h(
              "p",
              { class: "progress-entry-detail view-muted" },
              entry.kind === "comment" ? `comment by ${entry.actor ?? "someone"}` : entry.detail,
            )
          : null,
      ),
    ),
  );
  return h(
    "section",
    { class: "progress-section", "aria-label": "Timeline" },
    h(
      "h2",
      { class: "progress-heading" },
      "Milestones",
      h("span", { class: "view-muted progress-count", "data-milestones": String(progress.milestoneCount) }, String(progress.milestoneCount)),
    ),
    progress.earlier > 0 ? h("p", { class: "progress-earlier view-muted" }, `${progress.earlier} earlier ${progress.earlier === 1 ? "entry" : "entries"} not shown`) : null,
    items.length > 0 ? h("ol", { class: "progress-timeline", "data-timeline": "" }, ...items) : h("p", { class: "view-muted" }, "Nothing recorded yet."),
  );
}

function openButton(progress: Progress, view: ViewHost): HTMLElement | null {
  if (!progress.url) return null;
  const url = progress.url;
  const button = h("button", { class: "view-button", type: "button", "data-action": "open", title: "Open this ticket in the Staple web UI" }, "Open in Staple ↗");
  button.addEventListener("click", () => {
    void view.openLink(url).catch(() => false);
  });
  return h("footer", { class: "progress-foot" }, button);
}

function render(progress: Progress, view: ViewHost): void {
  host = view;
  if (progress.identifier !== loop.identifier) {
    clearTimer();
    Object.assign(loop, { identifier: progress.identifier, failures: 0, stopped: null, checking: false });
  }
  shown = progress;
  root.replaceChildren(
    h(
      "article",
      {
        class: "view-card progress",
        "data-view": "progress",
        "data-ticket": progress.identifier,
        "data-as-of": progress.asOf,
        "aria-label": `${progress.identifier} ${progress.title}: progress`,
      },
      h(
        "header",
        { class: "progress-head" },
        h("span", { class: "progress-id view-mono" }, progress.identifier),
        h("span", { class: "progress-status", "data-category": progress.status.category }, progress.status.label),
      ),
      h("h1", { class: "progress-title" }, progress.title),
      attemptLine(progress, view),
      liveLine(progress, view),
      factsSection(progress),
      timelineSection(progress, view),
      openButton(progress, view),
    ),
  );
  schedule();
}

const started = startView({ name: "progress", root, read, render });
started.onTeardown(() => {
  loop.tornDown = true;
  clearTimer();
  rerender();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shown !== null && refreshing(shown)) {
    clearTimer();
    void tick();
  }
});
