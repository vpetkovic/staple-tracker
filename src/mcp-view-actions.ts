/**
 * Gate decisions a PERSON makes by clicking in a Staple view inside an agent's thread.
 *
 * The ticket card's Approve and Request changes, and the queue's Approve, call two APP-ONLY
 * tools (`approve_gate_from_view`, `request_changes_from_view`). They declare MCP Apps
 * `_meta.ui.visibility: ["app"]`, so a host offers them to the view and never to the model,
 * and they record the decision under the person's name instead of the server's agent:
 *
 *   1. the machine's `humanName` (`staple config set humanName "<name>"`, config.json), else
 *   2. the gate's owner, the person the gate was waiting on.
 *
 * Never `STAPLE_AGENT`, and never a name the caller passes: the tools take no `actor`. The
 * comment the decision writes is the person's (author type `user`) and says which view it came
 * from, and the gate event carries `via`, so a click reads differently from an agent's
 * approve_task call everywhere the history is shown.
 *
 * The trust boundary is the host's. The server cannot tell a call the view made from one the
 * model made; hiding these tools from the model is the host honouring `visibility`. A host that
 * ignores it would let the model call them, and the record would then name the person for a
 * decision the agent took. The views are the only intended caller.
 */
import { readConfig } from "./config/file.js";
import { stapleHome } from "./config/home.js";
import { assertNotReservedActor } from "./core/milestones.js";
import type { WorkspaceStore } from "./core/store.js";
import { StapleError } from "./core/types.js";

/** The views a person decides from, and how a sentence names each. */
export const DECISION_VIEWS = {
  ticket_card: { phrase: "the ticket card", short: "the card" },
  queue: { phrase: "the queue", short: "the queue" },
} as const;

export type DecisionView = keyof typeof DECISION_VIEWS;
export const DECISION_VIEW_IDS = Object.keys(DECISION_VIEWS) as [DecisionView, ...DecisionView[]];

/** `from the card`, `from the queue`: how a view decision is marked where space is short. */
export function viaWords(via: string | null | undefined): string | null {
  if (!via) return null;
  const known = (DECISION_VIEWS as Record<string, { short: string }>)[via];
  return `from ${known ? known.short : via.replace(/_/g, " ")}`;
}

export interface PersonName {
  name: string;
  /** `config`: the machine's humanName. `gate_owner`: unset, so the gate's owner. */
  source: "config" | "gate_owner";
}

/**
 * The machine's configured person, or null when `humanName` is unset. An unreadable config.json
 * is refused (the config module's own sentence), not read as unset: guessing the gate's owner
 * would put a decision under a name the person may have meant to replace.
 */
export function configuredHumanName(home: string = stapleHome()): string | null {
  const name = readConfig(home).config.humanName.trim();
  return name === "" ? null : name;
}

/**
 * Who a view decision on `ref` is recorded under: the configured person, else the gate's
 * owner. Refused when the issue has no gate (nothing to decide) or the name is reserved.
 */
export function personFor(store: WorkspaceStore, ref: string, configured: string | null = configuredHumanName()): PersonName {
  const gate = store.gate(ref);
  if (gate === null) {
    const issue = store.getIssue(ref);
    throw new StapleError("conflict", `${issue.identifier} has no gate to decide.`, { identifier: issue.identifier });
  }
  const person: PersonName = configured ? { name: configured, source: "config" } : { name: gate.owner, source: "gate_owner" };
  assertNotReservedActor(person.name);
  return person;
}

/** The comment an approval from a view writes: `Approved by Mira Lane from the ticket card.` */
export function approvalComment(name: string, view: DecisionView): string {
  return `Approved by ${name} from ${DECISION_VIEWS[view].phrase}.`;
}

/** The comment a send-back from a view writes: the person's note, then where it came from. */
export function sendBackComment(note: string, name: string, view: DecisionView): string {
  return `${note.trim()}\n\nSent back by ${name} from ${DECISION_VIEWS[view].phrase}.`;
}
