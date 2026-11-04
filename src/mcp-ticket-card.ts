/**
 * The ticket card: one ticket as the `ui://staple/ticket` view draws it in an agent's thread.
 *
 * `ticketCard` reads everything the card shows in one place, and both halves of a
 * `show_ticket` answer come from it: `structuredContent.ticket` for a host that renders the
 * view, and `ticketCardText` for a host that does not. The card is a read: the buttons on it
 * (Approve, Request changes) call the ordinary gate tools through the host, which asks a
 * person first because those tools write.
 *
 * Two facts the tracker does not store as fields are read off what it does store:
 *
 *   - the BRANCH POINTER is the newest comment that follows the claim-time convention
 *     (`Branch pointer: branch feat/x, base 3f2a1bc.`, docs/working-a-ticket.md), or the
 *     shorter `working on branch feat/x (off main 3f2a1bc)`;
 *   - a criterion's MARK is the milestone goal check's verdict on a milestone, and on any
 *     other ticket "met" once it is done and "open" before (the tracker keeps no tick per
 *     criterion; the web UI's Done when list reads it the same way).
 *
 * The card's "Open in Staple" link is the web UI's deep link, `?ws=<slug>&issue=<REF>`. The
 * server cannot see a UI process, so the base comes from `STAPLE_UI_URL` when it is set
 * (`off` leaves the link out) and otherwise from the port `staple ui` asks for first. A
 * `token` parameter is always removed: the link reaches the agent's context, and the UI
 * token must not.
 */
import { readConfig } from "./config/file.js";
import { stapleHome } from "./config/home.js";
import { MILESTONE_KIND } from "./core/milestones.js";
import type { WorkspaceStore } from "./core/store.js";
import type { IssueComment, IssueGate, QueuedBy } from "./core/types.js";

export type CriterionMark = "met" | "unmet" | "open";

export interface TicketCard {
  /** The workspace slug, as the web UI's `ws` parameter names it. */
  workspace: string;
  identifier: string;
  title: string;
  status: { id: string; label: string; category: string };
  kind: { id: string; label: string };
  priority: string;
  assignee: string | null;
  criteria: Array<{ text: string; mark: CriterionMark }>;
  gate: IssueGate | null;
  /** The pending gate above this ticket that keeps it out of the queue, if any. */
  queuedBy: QueuedBy | null;
  /** The open worker attempt, else the newest ended one; null before the first claim. */
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
  /** The web UI's deep link to this ticket; null when no UI base is known. */
  url: string | null;
  /** What the card offers: the gate buttons show only while a gate is pending. */
  actions: { approve: boolean; requestChanges: boolean };
}

const POINTER_LINE = /^\s*(?:branch pointer\s*:|working on branch\s)/i;
const BRANCH_NAME = /\bbranch\s+`?([^\s,;()`]+)`?/i;
const BRANCH_BASE = /\b(?:base|off)\s+(.+)$/i;

/** The base as written: up to the first `)`, `,`, `;` or sentence end, without backticks. */
function baseOf(rest: string): string | null {
  const raw = BRANCH_BASE.exec(rest)?.[1];
  if (raw === undefined) return null;
  const cut = raw.split(/[),;]|\.(?:\s|$)/, 1)[0]!.replace(/`/g, "").trim();
  return cut === "" ? null : cut;
}

/** The newest comment that records the branch a ticket is worked on, read apart. */
export function branchPointer(comments: readonly IssueComment[]): TicketCard["branch"] {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    const line = comment.body.split("\n", 1)[0]!;
    if (!POINTER_LINE.test(line)) continue;
    const pointer = line.replace(/^\s*branch pointer\s*:\s*/i, "");
    // "Branch pointer: branch feat/x, ..." names it after "branch"; "Branch pointer: feat/x ..." first.
    const named = BRANCH_NAME.exec(pointer) ?? /^`?([^\s,;()`]+)`?/.exec(pointer);
    const name = named?.[1]?.replace(/\.+$/, "");
    if (!name || /^(?:none|n\/a|tbd)$/i.test(name)) continue;
    const base = baseOf(pointer.slice(named!.index + named![0].length));
    return { name, base, author: comment.author, at: comment.createdAt };
  }
  return null;
}

/**
 * The web UI address the card links to, without the ticket: `STAPLE_UI_URL` (an http or
 * https URL; `off`, `none` or an unusable value leave the link out), else the loopback
 * address on the configured UI port. Never carries a `token` parameter.
 */
export function stapleUiBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.STAPLE_UI_URL?.trim();
  let raw: string;
  if (configured) {
    if (/^(?:off|none|false|0)$/i.test(configured)) return null;
    raw = configured;
  } else {
    try {
      raw = `http://127.0.0.1:${readConfig(stapleHome()).config.port}/`;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // The link reaches the agent's context: no credential of any kind rides along.
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase() === "token") url.searchParams.delete(key);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** `<base>?ws=<slug>&issue=<REF>`: the link form the web UI opens one ticket from. */
export function ticketUrl(base: string, workspace: string, identifier: string): string {
  const url = new URL(base);
  url.searchParams.set("ws", workspace);
  url.searchParams.set("issue", identifier);
  return url.href;
}

/** How many of a ticket's newest comments are searched for its branch pointer. */
const BRANCH_POINTER_WINDOW = 200;

/** Everything the ticket card shows, for one ticket. */
export function ticketCard(store: WorkspaceStore, ref: string, uiBase: string | null = stapleUiBase()): TicketCard {
  const issue = store.getIssue(ref);
  const status = store.getStatuses().find((candidate) => candidate.id === issue.status);
  const kind = store.getKinds().find((candidate) => candidate.id === issue.kind);
  const category = status?.category ?? issue.status;
  const texts = issue.acceptanceCriteria ?? [];
  let criteria: TicketCard["criteria"] = texts.map((text) => ({ text, mark: category === "done" ? "met" : "open" }));
  if (issue.kind === MILESTONE_KIND && texts.length > 0) {
    try {
      const goal = store.milestones().get(issue.id).goal;
      criteria = goal.criteria.map((criterion) => ({
        text: criterion.text,
        mark: criterion.verdict === "met" ? "met" : criterion.verdict === "unmet" ? "unmet" : "open",
      }));
    } catch {
      // A milestone whose plan cannot be read still shows its criteria, unmarked.
    }
  }
  const gate = store.gate(issue.id);
  const summary = store.attemptSummary(issue.id);
  const shown = summary.current ?? summary.last;
  const { timing } = store.detailTiming(issue.id);
  return {
    workspace: store.slug,
    identifier: issue.identifier,
    title: issue.title,
    status: { id: issue.status, label: status?.label ?? issue.status, category },
    kind: { id: issue.kind, label: kind?.label ?? issue.kind },
    priority: issue.priority,
    assignee: issue.assignee,
    criteria,
    gate,
    queuedBy: store.queuedBy(issue.id),
    attempt: shown
      ? {
          ordinal: shown.ordinal,
          agent: shown.agent,
          state: shown.state,
          current: summary.current !== null,
          startedAt: shown.startedAt,
          endedAt: shown.endedAt,
          outcome: shown.outcome,
        }
      : null,
    branch: branchPointer(store.latestComments(issue.id, BRANCH_POINTER_WINDOW)),
    timing: {
      estimatedSeconds: timing.subtreePlan?.estimatedSeconds ?? timing.estimatedSeconds,
      elapsedSeconds: timing.activeSeconds,
    },
    url: uiBase === null ? null : ticketUrl(uiBase, store.slug, issue.identifier),
    actions: { approve: gate?.state === "pending", requestChanges: gate?.state === "pending" },
  };
}

/** `2h 05m`, `12m`, `40s`: how long, for a person. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}m`;
}

const GATE_WORDS: Record<string, string> = {
  pending: "pending",
  approved: "approved",
  changes_requested: "changes requested",
};

/** The card as prose: the whole answer for a host without MCP Apps. */
export function ticketCardText(card: TicketCard): string {
  const lines = [`${card.identifier} ${card.title}`];
  lines.push(
    [card.status.label, card.kind.label, `${card.priority} priority`, card.assignee ? `assigned to ${card.assignee}` : "unassigned"].join(" · "),
  );
  if (card.gate) {
    const gate = card.gate;
    lines.push(
      gate.state === "pending"
        ? `Gate pending: waiting on ${gate.owner}${gate.requestedBy ? ` (requested by ${gate.requestedBy})` : ""}. Approve with approve_task, or send it back with request_changes.`
        : `Gate ${GATE_WORDS[gate.state] ?? gate.state}${gate.resolvedBy ? ` by ${gate.resolvedBy}` : ""} (owner ${gate.owner}).`,
    );
  }
  if (card.queuedBy) lines.push(`Queued behind ${card.queuedBy.identifier}, waiting on ${card.queuedBy.owner}.`);
  if (card.attempt) {
    const attempt = card.attempt;
    lines.push(`${attempt.current ? "Attempt" : "Last attempt"} #${attempt.ordinal} by ${attempt.agent}: ${attempt.state}${attempt.outcome ? ` (${attempt.outcome})` : ""}.`);
  }
  if (card.branch) lines.push(`Branch ${card.branch.name}${card.branch.base ? ` (base ${card.branch.base})` : ""}.`);
  const { estimatedSeconds, elapsedSeconds } = card.timing;
  if (estimatedSeconds !== null || elapsedSeconds) {
    lines.push(
      [
        estimatedSeconds !== null ? `Estimate ${formatDuration(estimatedSeconds)}` : "No estimate",
        `ran ${formatDuration(elapsedSeconds ?? 0)}`,
      ].join(", ") + ".",
    );
  }
  if (card.criteria.length > 0) {
    lines.push("Done when:");
    for (const criterion of card.criteria) {
      lines.push(`  ${criterion.mark === "met" ? "[x]" : criterion.mark === "unmet" ? "[!]" : "[ ]"} ${criterion.text}`);
    }
  }
  if (card.url) lines.push(`Open in Staple: ${card.url}`);
  return lines.join("\n");
}
