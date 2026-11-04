/**
 * The ticket card: one ticket in the agent's thread.
 *
 * It renders a `show_ticket` result (`structuredContent.ticket`, built by
 * `src/mcp-ticket-card.ts`). `get_task` and `checkout_task` declare this view too; their
 * payloads are not cards, so the view paints what they carry at once and asks for the card
 * with `show_ticket` through the host (a read, so no host asks the person first).
 *
 * While the ticket's gate is pending the card offers Approve and Request changes, which
 * call `approve_task` and `request_changes` through the host. Those tools write, so the
 * host asks the person before it runs them; the card then reads the ticket again and shows
 * the gate as it now stands. Open in Staple asks the host to open the web UI's deep link.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "../shared/base.css";
import "./ticket.css";
import { h, resultText, startView, type ViewHost } from "../shared/runtime.js";

type Mark = "met" | "unmet" | "open";

interface Gate {
  state: "pending" | "approved" | "changes_requested";
  owner: string;
  requestedBy: string | null;
  requestedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

interface Card {
  workspace: string;
  identifier: string;
  title: string;
  status: { id: string; label: string; category: string };
  kind: { id: string; label: string };
  priority: string;
  assignee: string | null;
  criteria: Array<{ text: string; mark: Mark }>;
  gate: Gate | null;
  queuedBy: { identifier: string; owner: string } | null;
  attempt: {
    ordinal: number;
    agent: string;
    state: string;
    current: boolean;
    startedAt: string;
    endedAt: string | null;
    outcome: string | null;
  } | null;
  branch: { name: string; base: string | null; author: string; at: string } | null;
  timing: { estimatedSeconds: number | null; elapsedSeconds: number | null };
  url: string | null;
  actions: { approve: boolean; requestChanges: boolean };
}

/** What a get_task or checkout_task result carries: enough for the header, not the card. */
interface Header {
  identifier: string;
  title: string;
  status: string;
  kind: string;
}

type Shown = { card: Card } | { header: Header };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headerFrom(issue: Record<string, unknown>): Header | null {
  const { identifier, title, status, kind } = issue;
  if (typeof identifier !== "string" || typeof title !== "string") return null;
  return { identifier, title, status: typeof status === "string" ? status : "", kind: typeof kind === "string" ? kind : "" };
}

function read(result: CallToolResult): Shown | null {
  const data = result.structuredContent;
  if (!isRecord(data)) return null;
  const ticket = data.ticket;
  if (isRecord(ticket) && typeof ticket.identifier === "string" && Array.isArray(ticket.criteria)) {
    return { card: ticket as unknown as Card };
  }
  // get_task: the issue is nested. checkout_task: the issue's fields are the payload.
  const header = isRecord(data.issue) ? headerFrom(data.issue) : headerFrom(data);
  return header ? { header } : null;
}

const root = document.getElementById("view")!;

/** Stored with an approval from the card, so the ticket's history says where it came from. */
const APPROVE_COMMENT = "Approved from the ticket card in the thread.";

/** What survives a re-render (a theme change re-renders): per ticket, the open form and notes. */
const state = {
  identifier: "",
  busy: false,
  composing: false,
  draft: "",
  note: "",
  noteTone: "info" as "info" | "error",
  /** A show_ticket fetch for the header is in flight, so a re-render does not start another. */
  fetching: false,
  /**
   * A write went through but the card on screen predates it (re-reading it failed): its gate
   * buttons stay hidden until a fresh card arrives, so nobody approves or sends back twice.
   */
  stale: false,
};

function resetFor(identifier: string): void {
  if (state.identifier === identifier) return;
  Object.assign(state, { identifier, busy: false, composing: false, draft: "", note: "", noteTone: "info", fetching: false, stale: false });
}

/** The `ws` the agent called with, passed on so every follow-up call reads the same workspace. */
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
  return error instanceof Error ? error.message : String(error);
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

function when(iso: string, host: ViewHost): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const locale = typeof host.context?.locale === "string" ? host.context.locale : undefined;
  const timeZone = typeof host.context?.timeZone === "string" ? host.context.timeZone : undefined;
  try {
    return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Read the card again through the host and show it; `after` is the note to keep showing. */
async function refresh(host: ViewHost, identifier: string, after: string): Promise<void> {
  try {
    const result = await host.callTool("show_ticket", { ref: identifier, ...wsArgument(host) });
    state.busy = false;
    if (result.isError || read(result) === null) {
      // The write went through; keep the card on screen and say the re-read did not.
      state.stale = true;
      state.note = `${after} Reading the ticket again failed: ${refusal(result)}`;
      state.noteTone = "error";
      rerender(host);
      return;
    }
    state.note = after;
    state.noteTone = "info";
    state.stale = false;
    host.show(result);
  } catch (error) {
    state.busy = false;
    state.stale = true;
    state.note = `${after} Reading the ticket again failed: ${errorText(error)}`;
    state.noteTone = "error";
    rerender(host);
  }
}

let lastShown: Shown | null = null;
function rerender(host: ViewHost): void {
  if (lastShown) render(lastShown, host);
}

async function act(host: ViewHost, card: Card, tool: "approve_task" | "request_changes", args: Record<string, unknown>, done: string): Promise<void> {
  state.busy = true;
  state.note = tool === "approve_task" ? "Asking the host to approve the gate…" : "Asking the host to send it back…";
  state.noteTone = "info";
  rerender(host);
  try {
    const result = await host.callTool(tool, { ref: card.identifier, ...args, ...wsArgument(host) });
    if (result.isError) {
      state.busy = false;
      state.note = refusal(result);
      state.noteTone = "error";
      rerender(host);
      return;
    }
    state.composing = false;
    state.draft = "";
    await refresh(host, card.identifier, done);
  } catch (error) {
    state.busy = false;
    state.note = `${tool === "approve_task" ? "Approve" : "Request changes"} did not go through: ${errorText(error)}`;
    state.noteTone = "error";
    rerender(host);
  }
}

function statusPill(label: string, category: string): HTMLElement {
  return h("span", { class: "ticket-status", "data-category": category, "data-status-pill": "" }, label);
}

function gateSection(card: Card, host: ViewHost): HTMLElement | null {
  const gate = card.gate;
  if (gate === null) {
    if (card.queuedBy === null) return null;
    return h(
      "div",
      { class: "ticket-gate", "data-gate": "queued" },
      h("p", { class: "ticket-gate-line" }, h("strong", {}, "Queued"), ` behind ${card.queuedBy.identifier}, waiting on ${card.queuedBy.owner}`),
    );
  }
  const heading =
    gate.state === "pending"
      ? [h("strong", {}, "Gate pending"), ` · waiting on ${gate.owner}`]
      : gate.state === "approved"
        ? [h("strong", {}, "Gate approved"), gate.resolvedBy ? ` by ${gate.resolvedBy}` : ""]
        : [h("strong", {}, "Changes requested"), gate.resolvedBy ? ` by ${gate.resolvedBy}` : ""];
  const detail =
    gate.state === "pending"
      ? `Requested${gate.requestedBy ? ` by ${gate.requestedBy}` : ""} · ${when(gate.requestedAt, host)}`
      : `Owner ${gate.owner}${gate.resolvedAt ? ` · ${when(gate.resolvedAt, host)}` : ""}`;
  const section = h(
    "div",
    { class: "ticket-gate", "data-gate": gate.state },
    h("p", { class: "ticket-gate-line" }, ...heading),
    h("p", { class: "ticket-gate-detail view-muted" }, detail),
  );
  if (!state.stale && (card.actions.approve || card.actions.requestChanges)) section.append(gateActions(card, host));
  return section;
}

function gateActions(card: Card, host: ViewHost): HTMLElement {
  const wrap = h("div", { class: "ticket-gate-actions" });
  if (state.composing) {
    const field = h("textarea", {
      class: "ticket-note-field",
      rows: "3",
      "aria-label": "Note for the next agent",
      placeholder: "What should change? This becomes a comment on the ticket.",
      "data-note-field": "",
    });
    field.value = state.draft;
    field.disabled = state.busy;
    const send = h("button", { class: "view-button view-button-primary", type: "button", "data-action": "send-back" }, "Send back");
    const cancel = h("button", { class: "view-button", type: "button", "data-action": "cancel" }, "Cancel");
    send.disabled = state.busy || state.draft.trim() === "";
    cancel.disabled = state.busy;
    field.addEventListener("input", () => {
      state.draft = field.value;
      send.disabled = state.busy || field.value.trim() === "";
    });
    send.addEventListener("click", () => {
      const comment = state.draft.trim();
      if (comment === "") return;
      void act(host, card, "request_changes", { comment }, "Sent back with your note.");
    });
    cancel.addEventListener("click", () => {
      state.composing = false;
      rerender(host);
    });
    wrap.append(field, h("div", { class: "ticket-buttons" }, send, cancel));
    return wrap;
  }
  const buttons = h("div", { class: "ticket-buttons" });
  if (card.actions.approve) {
    const approve = h("button", { class: "view-button view-button-primary", type: "button", "data-action": "approve" }, "Approve");
    approve.disabled = state.busy;
    // The write is attributed to the server's agent identity; the comment says a person
    // pressed the button (the host asked them first).
    approve.addEventListener("click", () => void act(host, card, "approve_task", { comment: APPROVE_COMMENT }, "Approved."));
    buttons.append(approve);
  }
  if (card.actions.requestChanges) {
    const request = h("button", { class: "view-button", type: "button", "data-action": "request-changes" }, "Request changes");
    request.disabled = state.busy;
    request.addEventListener("click", () => {
      state.composing = true;
      state.note = "";
      rerender(host);
      root.querySelector<HTMLTextAreaElement>("[data-note-field]")?.focus();
    });
    buttons.append(request);
  }
  wrap.append(buttons);
  return wrap;
}

function criteriaSection(card: Card): HTMLElement | null {
  if (card.criteria.length === 0) return null;
  const met = card.criteria.filter((criterion) => criterion.mark === "met").length;
  return h(
    "section",
    { class: "ticket-section", "aria-label": "Acceptance criteria" },
    h("h2", { class: "ticket-heading" }, "Done when", h("span", { class: "view-muted ticket-count" }, `${met}/${card.criteria.length}`)),
    h(
      "ul",
      { class: "ticket-criteria", "data-criteria": "" },
      ...card.criteria.map((criterion) =>
        h(
          "li",
          { "data-criterion": criterion.mark },
          h("span", { class: "ticket-mark", "aria-label": criterion.mark === "met" ? "met" : criterion.mark === "unmet" ? "not met" : "open" }),
          h("span", { class: "ticket-criterion-text" }, criterion.text),
        ),
      ),
    ),
  );
}

function factsSection(card: Card, host: ViewHost): HTMLElement | null {
  const rows: HTMLElement[] = [];
  if (card.attempt) {
    const attempt = card.attempt;
    rows.push(
      h("dt", {}, attempt.current ? "Attempt" : "Last attempt"),
      h(
        "dd",
        { "data-attempt": attempt.state },
        `#${attempt.ordinal} · ${attempt.agent} · ${attempt.state}${attempt.outcome ? ` (${attempt.outcome})` : ""}`,
        h("span", { class: "view-muted" }, ` · since ${when(attempt.startedAt, host)}`),
      ),
    );
  }
  if (card.branch) {
    rows.push(
      h("dt", {}, "Branch"),
      h(
        "dd",
        { "data-branch": card.branch.name },
        h("span", { class: "view-mono" }, card.branch.name),
        card.branch.base ? h("span", { class: "view-muted" }, ` · base `, h("span", { class: "view-mono" }, card.branch.base)) : null,
      ),
    );
  }
  const { estimatedSeconds, elapsedSeconds } = card.timing;
  if (estimatedSeconds !== null || (elapsedSeconds ?? 0) > 0) {
    const elapsed = elapsedSeconds ?? 0;
    const over = estimatedSeconds !== null && elapsed > estimatedSeconds;
    const value = h(
      "dd",
      { "data-time": over ? "over" : "within" },
      estimatedSeconds !== null ? `${duration(elapsed)} of ${duration(estimatedSeconds)} estimate` : `${duration(elapsed)}, no estimate`,
    );
    if (estimatedSeconds !== null && estimatedSeconds > 0) {
      const share = Math.min(1, elapsed / estimatedSeconds);
      const bar = h("span", { class: "ticket-bar-fill" });
      bar.style.width = `${Math.round(share * 100)}%`;
      value.append(h("span", { class: "ticket-bar", "data-over": over ? "true" : "false", "aria-hidden": "true" }, bar));
    }
    rows.push(h("dt", {}, "Time"), value);
  }
  return rows.length === 0 ? null : h("dl", { class: "ticket-facts" }, ...rows);
}

function renderHeader(partial: Header, host: ViewHost): void {
  resetFor(partial.identifier);
  root.replaceChildren(
    h(
      "article",
      { class: "view-card ticket", "data-view": "ticket", "data-ticket": partial.identifier, "data-partial": "" },
      h(
        "header",
        { class: "ticket-head" },
        h("span", { class: "ticket-id view-mono" }, partial.identifier),
        partial.status ? statusPill(partial.status.replace(/_/g, " "), "") : null,
      ),
      h("h1", { class: "ticket-title" }, partial.title),
      h("p", { class: `ticket-note ticket-note-${state.noteTone}`, role: "status", "data-action-note": "" }, state.note || "Loading the card…"),
    ),
  );
  if (state.fetching) return;
  state.fetching = true;
  host
    .callTool("show_ticket", { ref: partial.identifier, ...wsArgument(host) })
    .finally(() => {
      state.fetching = false;
    })
    .then((result) => {
      if (result.isError || read(result) === null) {
        state.note = `Could not load the card: ${refusal(result)}`;
        state.noteTone = "error";
        rerender(host);
        return;
      }
      host.show(result);
    })
    .catch((error: unknown) => {
      state.note = `Could not load the card: ${errorText(error)}`;
      state.noteTone = "error";
      rerender(host);
    });
}

function renderCard(card: Card, host: ViewHost): void {
  resetFor(card.identifier);
  const meta = [card.kind.label, `${card.priority} priority`, card.assignee ? card.assignee : "unassigned"];
  const open = card.url
    ? (() => {
        const url = card.url;
        const button = h("button", { class: "view-button ticket-open", type: "button", "data-action": "open", title: "Open this ticket in the Staple web UI" }, "Open in Staple ↗");
        button.addEventListener("click", async () => {
          try {
            const opened = await host.openLink(url);
            if (!opened) {
              state.note = "The host did not open the link.";
              state.noteTone = "error";
              rerender(host);
            }
          } catch (error) {
            state.note = `The host did not open the link: ${errorText(error)}`;
            state.noteTone = "error";
            rerender(host);
          }
        });
        return button;
      })()
    : null;
  root.replaceChildren(
    h(
      "article",
      { class: "view-card ticket", "data-view": "ticket", "data-ticket": card.identifier, "aria-label": `${card.identifier} ${card.title}` },
      h(
        "header",
        { class: "ticket-head" },
        h("span", { class: "ticket-id view-mono" }, card.identifier),
        statusPill(card.status.label, card.status.category),
      ),
      h("h1", { class: "ticket-title" }, card.title),
      h("p", { class: "ticket-meta view-muted" }, meta.join(" · ")),
      gateSection(card, host),
      criteriaSection(card),
      factsSection(card, host),
      state.note ? h("p", { class: `ticket-note ticket-note-${state.noteTone}`, role: "status", "data-action-note": "" }, state.note) : null,
      open ? h("footer", { class: "ticket-foot" }, open) : null,
    ),
  );
}

function render(shown: Shown, host: ViewHost): void {
  lastShown = shown;
  if ("card" in shown) renderCard(shown.card, host);
  else renderHeader(shown.header, host);
}

startView({ name: "ticket", root, read, render });
