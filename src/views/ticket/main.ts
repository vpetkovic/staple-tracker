/**
 * The ticket card: one ticket in the agent's thread.
 *
 * It renders the card in a tool result (`structuredContent.ticket`, built by
 * `src/mcp-ticket-card.ts`). `show_ticket` answers with it, `checkout_task` carries it, and
 * so do the two gate tools below. The view never reads the ticket back through the host:
 * hosts such as T3 Code ask the person before every call a view makes, reads included.
 *
 * While the ticket's gate is pending the card offers Approve and Request changes, which
 * call the app-only `approve_gate_from_view` and `request_changes_from_view` through the host
 * (hidden from the model). They write, so the host asks the person before it runs them, and
 * the server records the decision under the person (the machine's humanName, else the gate's
 * owner), never the agent. Their answer carries the ticket as it now stands, so the card
 * redraws with the gate decided: "Gate approved by <person> · from the card". Open in Staple
 * asks the host to open the web UI's deep link.
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
  /** How the gate was decided while it stands decided; `via` names the view a person clicked in. */
  decision: { state: string; by: string | null; via: string | null; at: string } | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(result: CallToolResult): Card | null {
  const ticket = isRecord(result.structuredContent) ? result.structuredContent.ticket : undefined;
  return isRecord(ticket) && typeof ticket.identifier === "string" && Array.isArray(ticket.criteria) ? (ticket as unknown as Card) : null;
}

const root = document.getElementById("view")!;

/** Stored with an approval from the card, so the ticket's history says where it came from. */
/** The app-only tools the buttons call; the server records the person, not the agent. */
const APPROVE_TOOL = "approve_gate_from_view";
const SEND_BACK_TOOL = "request_changes_from_view";
type GateTool = typeof APPROVE_TOOL | typeof SEND_BACK_TOOL;

/** `from the card`, `from the queue`: where a person decided, as the card says it. */
function viaWords(via: string | null | undefined): string | null {
  if (!via) return null;
  return via === "ticket_card" ? "from the card" : `from the ${via.replace(/_/g, " ")}`;
}

/** The person a view decision was recorded under, from the tool's answer. */
function decidedBy(result: CallToolResult): string | null {
  const decision = (result.structuredContent as { decision?: { by?: unknown } } | undefined)?.decision;
  return typeof decision?.by === "string" && decision.by !== "" ? decision.by : null;
}

/** What survives a re-render (a theme change re-renders): per ticket, the open form and notes. */
const state = {
  identifier: "",
  busy: false,
  composing: false,
  draft: "",
  note: "",
  noteTone: "info" as "info" | "error",
  /**
   * A write went through but its answer carried no card, so the card on screen predates it:
   * its gate buttons stay hidden until a fresh card arrives, so nobody approves or sends back twice.
   */
  stale: false,
};

function resetFor(identifier: string): void {
  if (state.identifier === identifier) return;
  Object.assign(state, { identifier, busy: false, composing: false, draft: "", note: "", noteTone: "info", stale: false });
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

let lastShown: Card | null = null;
function rerender(host: ViewHost): void {
  if (lastShown) render(lastShown, host);
}

async function act(host: ViewHost, card: Card, tool: GateTool, args: Record<string, unknown>, done: string): Promise<void> {
  state.busy = true;
  state.note = tool === APPROVE_TOOL ? "Asking the host to approve the gate…" : "Asking the host to send it back…";
  state.noteTone = "info";
  rerender(host);
  try {
    const result = await host.callTool(tool, { ref: card.identifier, view: "ticket_card", ...args, ...wsArgument(host) });
    if (result.isError) {
      state.busy = false;
      state.note = refusal(result);
      state.noteTone = "error";
      rerender(host);
      return;
    }
    state.composing = false;
    state.draft = "";
    const by = decidedBy(result);
    state.busy = false;
    state.note = by ? `${done} Recorded as ${by}.` : done;
    state.noteTone = "info";
    if (read(result) === null) {
      // The write went through, but the answer has no card to redraw from.
      state.stale = true;
      state.note += " The card below predates it.";
      rerender(host);
      return;
    }
    state.stale = false;
    host.show(result);
  } catch (error) {
    state.busy = false;
    state.note = `${tool === APPROVE_TOOL ? "Approve" : "Request changes"} did not go through: ${errorText(error)}`;
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
  const from = gate.state === "pending" ? null : viaWords(card.decision?.via);
  const decided = (label: string) => [
    h("strong", {}, label),
    gate.resolvedBy ? ` by ${gate.resolvedBy}` : "",
    from ? h("span", { class: "ticket-gate-via", "data-via": card.decision?.via ?? "" }, ` · ${from}`) : "",
  ];
  const heading =
    gate.state === "pending"
      ? [h("strong", {}, "Gate pending"), ` · waiting on ${gate.owner}`]
      : decided(gate.state === "approved" ? "Gate approved" : "Changes requested");
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
      void act(host, card, SEND_BACK_TOOL, { comment }, "Sent back with your note.");
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
    // The server records the person (humanName, else the gate's owner) and writes the
    // comment that says it came from the card; the host asked them first.
    approve.addEventListener("click", () => void act(host, card, APPROVE_TOOL, {}, "Approved."));
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

function render(card: Card, host: ViewHost): void {
  lastShown = card;
  renderCard(card, host);
}

startView({ name: "ticket", root, read, render });
