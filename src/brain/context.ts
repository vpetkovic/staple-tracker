/**
 * The session-start block: what every agent should know before its first turn in a
 * directory, as plain text any agent CLI can inject.
 *
 * Provider-neutral by construction. The block is the same text for every CLI; only the
 * envelope differs (`renderHookOutput`): Claude Code and Codex both read a SessionStart
 * hook's `hookSpecificOutput.additionalContext`.
 *
 * Ranking, with no query to rank against: this project's records before global ones,
 * then by kind (feedback and user facts change how the agent works on every turn;
 * project and reference facts matter when the work touches them), then most recently
 * verified. Superseded records never appear; provisional ones are marked. Records are
 * added one line each until the token budget is spent, and the block says how many were
 * left out and how to recall them, so a budget cut costs a lookup rather than the fact.
 */
import { scopeRelation, type ProjectKeys } from "./scope.js";
import { estimateTokens, type BrainKind, type BrainRecord } from "./types.js";

export const DEFAULT_CONTEXT_BUDGET = 1500;

const KIND_WEIGHT: Record<BrainKind, number> = { feedback: 3, user: 3, project: 2, reference: 1 };

export interface ContextBlock {
  text: string;
  /** The records the block shows, in order: what the usage log records as injected. */
  ids: string[];
  tokens: number;
  shown: number;
  eligible: number;
  project: number;
  global: number;
}

function line(r: BrainRecord): string {
  const handle = r.name ?? r.id.slice(0, 8);
  const about = (r.description ?? r.body.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  const clipped = about.length > 160 ? `${about.slice(0, 157)}...` : about;
  return `- [${r.kind}${r.provisional ? ", provisional" : ""}] ${handle} (${r.id.slice(0, 8)}): ${clipped}`;
}

/** A global record written from this project (`from:<slug>` tag) is about this project too. */
function fromHere(record: BrainRecord, keys: ProjectKeys): boolean {
  return record.tags.some((tag) => tag.startsWith("from:") && scopeRelation(`project:${tag.slice(5)}`, keys) === "project");
}

/**
 * One score, so no single dimension starves the others: kind (feedback and user rules
 * change every turn), then relevance to this directory, then a freshness term that halves
 * in about three weeks, minus a penalty for provisional records.
 */
export function contextScore(record: BrainRecord, relation: "project" | "global", keys: ProjectKeys, now = Date.now()): number {
  const local = relation === "project" ? 2 : fromHere(record, keys) ? 1.5 : 0;
  const at = Date.parse(record.verifiedAt ?? record.updatedAt);
  const ageDays = Number.isFinite(at) ? Math.max(0, (now - at) / 86_400_000) : 365;
  // A record written in the last week is news: it outranks older local lines, so what one
  // agent learned yesterday is in front of the next agent today, not cut by the budget.
  const created = Date.parse(record.createdAt);
  const fresh = Number.isFinite(created) && now - created < 7 * 86_400_000 ? 2 : 0;
  return KIND_WEIGHT[record.kind] + local + fresh + Math.exp(-ageDays / 30) - (record.provisional ? 1 : 0);
}

export function rankForContext(records: readonly BrainRecord[], keys: ProjectKeys): Array<{ record: BrainRecord; relation: "project" | "global" }> {
  const scored: Array<{ record: BrainRecord; relation: "project" | "global"; score: number }> = [];
  for (const record of records) {
    if (record.supersededBy !== null) continue;
    const relation = scopeRelation(record.scope, keys);
    if (relation) scored.push({ record, relation, score: contextScore(record, relation, keys) });
  }
  scored.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  return scored.map(({ record, relation }) => ({ record, relation }));
}

/**
 * How to work with the brain, in a few lines: the effort/criteria/evidence loop, and when
 * to reach for `recall` and `remember`. Always first in the block, inside the budget.
 */
export const WORKING_BRIEF = [
  "How to work here:",
  "- Size the effort first: a quick fix just acts; anything larger states what done means before building.",
  "- Make each criterion verifiable, then verify it with evidence (command output, a test, a screenshot). Never claim \"should work\".",
  "- Call `recall` (the staple MCP server's tool; if your tools load lazily, search for \"staple recall\". Shell fallback: `staple brain recall \"<question>\"`) BEFORE acting when the task touches past decisions, preferences, deploys, tests or setup, or when a line below is relevant and you need its full text. Each prompt also brings in new matching memories.",
  "- Call `remember` when you learn something durable: a correction, a preference, a gotcha, a non-obvious command, where something lives. One fact per call, with why; pass supersedes to replace an outdated one.",
  "- Cite a memory you relied on as [brain:<name>].",
];

export function buildContext(records: readonly BrainRecord[], keys: ProjectKeys, budget = DEFAULT_CONTEXT_BUDGET): ContextBlock {
  const ranked = rankForContext(records, keys);
  const header = ["# Brain: shared memory for this session", ...WORKING_BRIEF, "", "Memories (one line each, ranked):"];
  const footerFor = (left: number) =>
    left > 0 ? [`(${left} more not shown within the ${budget}-token budget; recall finds them.)`] : [];

  const sections: { project: string[]; global: string[] } = { project: [], global: [] };
  const ids: string[] = [];
  let used = estimateTokens(header.join("\n")) + estimateTokens(footerFor(ranked.length).join("\n")) + 12;
  for (const { record, relation } of ranked) {
    const text = line(record);
    const cost = estimateTokens(text) + 1;
    if (used + cost > budget) continue;
    sections[relation].push(text);
    ids.push(record.id);
    used += cost;
  }
  const shown = ids.length;
  const out = [...header];
  if (sections.project.length) out.push("", "## This project", ...sections.project);
  if (sections.global.length) out.push("", "## Global", ...sections.global);
  if (shown === 0) out.push("", "(No memories for this directory yet.)");
  out.push(...footerFor(ranked.length - shown).map((l) => `\n${l}`));
  const text = out.join("\n");
  return {
    text,
    ids,
    tokens: estimateTokens(text),
    shown,
    eligible: ranked.length,
    project: sections.project.length,
    global: sections.global.length,
  };
}

/** The hook answer: `additionalContext`, which Claude Code and Codex both read for these events. */
export function renderHookOutput(block: { text: string }, event: "SessionStart" | "UserPromptSubmit" = "SessionStart"): string {
  if (!block.text) return "";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: block.text } })}\n`;
}
