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
  return KIND_WEIGHT[record.kind] + local + Math.exp(-ageDays / 30) - (record.provisional ? 1 : 0);
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

export function buildContext(records: readonly BrainRecord[], keys: ProjectKeys, budget = DEFAULT_CONTEXT_BUDGET): ContextBlock {
  const ranked = rankForContext(records, keys);
  const header = [
    "# Brain: memories for this project and global",
    "Durable facts from earlier sessions, ranked. Each line is a summary; get the full text with",
    '`staple brain recall "<question>"` (or the MCP tool `recall`), and record new ones with `staple brain remember`.',
  ];
  const footerFor = (left: number) =>
    left > 0 ? [`(${left} more not shown within the ${budget}-token budget; recall finds them.)`] : [];

  const sections: { project: string[]; global: string[] } = { project: [], global: [] };
  let shown = 0;
  let used = estimateTokens(header.join("\n")) + estimateTokens(footerFor(ranked.length).join("\n")) + 12;
  for (const { record, relation } of ranked) {
    const text = line(record);
    const cost = estimateTokens(text) + 1;
    if (used + cost > budget) continue;
    sections[relation].push(text);
    used += cost;
    shown++;
  }
  const out = [...header];
  if (sections.project.length) out.push("", "## This project", ...sections.project);
  if (sections.global.length) out.push("", "## Global", ...sections.global);
  if (shown === 0) out.push("", "(No memories for this directory yet.)");
  out.push(...footerFor(ranked.length - shown).map((l) => `\n${l}`));
  const text = out.join("\n");
  return {
    text,
    tokens: estimateTokens(text),
    shown,
    eligible: ranked.length,
    project: sections.project.length,
    global: sections.global.length,
  };
}

/** The hook answer: `additionalContext` for SessionStart, which Claude Code and Codex both read. */
export function renderHookOutput(block: ContextBlock): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block.text } })}\n`;
}
