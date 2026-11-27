/**
 * Which kind of human work an agent's attempt stands in for: its AGENT TYPE.
 *
 * The ROI page prices agent time at the rate of the person who would otherwise have done the
 * work, so each attempt needs a type (engineering, design, documentation, research,
 * orchestration) that the cost model maps to a role. Nothing records a type today:
 * `attempts.role` is `worker` on every real attempt, agent names are free-form
 * (`autopilot`, `sta223-lifecycle`, `fable-r1a`), and most attempts name no model. So the type
 * is DERIVED, deterministically, from what an attempt does carry, and every derivation says
 * which rule produced it so a person can see why and override it.
 *
 * ## The rules, first match wins
 *
 *  1. The orchestrator lane (`role: orchestrator`) is orchestration. Only the lane decides
 *     this, never a name: `design/timing-semantics.md` ("Orchestration") explains why an
 *     identity like `fxi-orchestrator` that checks out a ticket is doing the ticket's work.
 *  2. The person's own rules, in their order: a match on agent name (a `*` glob), workspace
 *     prefix, ticket kind or ticket label.
 *  3. A ticket label naming the work (`design`, `ux`, `docs`, `research`, …).
 *  4. A token of the agent's name naming the work (`design`, `docs`, `writer` is NOT one: on
 *     the maintainers' tracker `*-writer` agents write specs, which is engineering).
 *  5. A word of the ticket title naming the work (`redesign`, `docs`, `documentation`, …).
 *  6. The ticket kind: a `spike` is research.
 *  7. Otherwise engineering.
 *
 * The model and harness are deliberately not rules: which model ran says nothing about what
 * kind of work it did (a Fable session on the maintainers' tracker shipped schema migrations).
 */

export const AGENT_TYPES = ["engineering", "design", "documentation", "research", "orchestration"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && (AGENT_TYPES as readonly string[]).includes(value);
}

/** A person's rule. Every field given must match; at least one is required. */
export interface AgentTypeRule {
  /** Agent name, case-insensitive, `*` matching any run of characters. */
  readonly agent?: string;
  /** Workspace identifier prefix (`STA`), case-insensitive. */
  readonly workspace?: string;
  readonly kind?: string;
  readonly label?: string;
  readonly type: AgentType;
}

export type AgentTypeReasonCode = "orchestrator_lane" | "rule" | "label" | "agent_name" | "title" | "kind" | "default";

export interface AgentTypeReason {
  readonly code: AgentTypeReasonCode;
  /** What matched: the label, the name token, the title word, the kind; the rule's index for `rule`. */
  readonly detail: string | null;
}

export interface AgentTypeInput {
  readonly agent: string;
  readonly role: string;
  readonly workspace: string;
  readonly kind: string;
  readonly labels: readonly string[];
  readonly title: string;
}

/** Words that name a kind of work, in the order they are tried. */
const VOCABULARY: ReadonlyArray<readonly [AgentType, readonly string[]]> = [
  ["design", ["design", "designer", "redesign", "ux", "ui-design", "mockup", "mockups", "wireframe", "wireframes", "visual"]],
  ["documentation", ["docs", "doc", "documentation", "readme", "changelog", "tech-writer", "techwriter", "copywriting"]],
  ["research", ["research", "spike", "investigation", "investigate"]],
];

/** Label spellings are looser than title words: `area:design`, `type/docs` and `design-system` all count. */
function labelType(label: string): AgentType | null {
  const tokens = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [type, words] of VOCABULARY) if (tokens.some((token) => words.includes(token))) return type;
  return null;
}

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The first vocabulary word among `tokens`, by vocabulary order. */
function wordType(tokens: readonly string[]): { type: AgentType; word: string } | null {
  for (const [type, words] of VOCABULARY) {
    const word = tokens.find((token) => words.includes(token));
    if (word !== undefined) return { type, word };
  }
  return null;
}

/** A `*` glob as a whole-string, case-insensitive match. */
export function globMatches(glob: string, value: string): boolean {
  const source = glob
    .trim()
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value.toLowerCase());
}

function ruleMatches(rule: AgentTypeRule, input: AgentTypeInput): boolean {
  if (rule.agent !== undefined && !globMatches(rule.agent, input.agent)) return false;
  if (rule.workspace !== undefined && rule.workspace.trim().toUpperCase() !== input.workspace.toUpperCase()) return false;
  if (rule.kind !== undefined && rule.kind !== input.kind) return false;
  if (rule.label !== undefined && !input.labels.some((label) => label.toLowerCase() === rule.label!.toLowerCase())) return false;
  return true;
}

/** The type of one attempt's work, and the rule that decided it. */
export function deriveAgentType(input: AgentTypeInput, rules: readonly AgentTypeRule[] = []): { type: AgentType; reason: AgentTypeReason } {
  if (input.role === "orchestrator") return { type: "orchestration", reason: { code: "orchestrator_lane", detail: null } };
  for (const [index, rule] of rules.entries()) {
    if (ruleMatches(rule, input)) return { type: rule.type, reason: { code: "rule", detail: String(index) } };
  }
  for (const label of input.labels) {
    const type = labelType(label);
    if (type !== null) return { type, reason: { code: "label", detail: label } };
  }
  const named = wordType(tokensOf(input.agent));
  if (named !== null) return { type: named.type, reason: { code: "agent_name", detail: named.word } };
  const titled = wordType(tokensOf(input.title));
  if (titled !== null) return { type: titled.type, reason: { code: "title", detail: titled.word } };
  if (input.kind === "spike") return { type: "research", reason: { code: "kind", detail: "spike" } };
  return { type: "engineering", reason: { code: "default", detail: null } };
}
