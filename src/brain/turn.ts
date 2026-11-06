/**
 * Per-prompt retrieval: the memories relevant to THIS prompt that the session has not
 * already been shown.
 *
 * The shape is the usual one for per-prompt memory (a top-K over BM25 with a score floor, nothing at
 * all below the floor, a time budget the prompt never waits past), with two differences that
 * matter for an agent: a memory is never repeated within a session, because the session
 * already holds it, and the block carries the memory's text rather than a pointer, so the
 * agent can act on it without a second call.
 *
 * The floor is two-sided. An absolute floor keeps a prompt with only incidental word overlap
 * ("fix the typo") from pulling anything in; a relative floor (a fraction of the best hit)
 * keeps a strong match from dragging weak neighbours along with it.
 */
import { recall } from "./recall.js";
import type { ProjectKeys } from "./scope.js";
import { estimateTokens, type BrainRecord } from "./types.js";

export const TURN_DEFAULTS = {
  topK: 3,
  /** Negated bm25 under the column weights in `recall.ts`; calibrated so an off-topic prompt injects nothing. */
  minScore: 7,
  relativeFloor: 0.5,
  tokenBudget: 600,
  timeBudgetMs: 300,
  excerptChars: 700,
};

export interface TurnBlock {
  text: string;
  ids: string[];
  tokens: number;
  considered: number;
  skippedAsSeen: number;
  belowFloor: number;
  topScore: number | null;
}

function excerpt(body: string, max: number): string {
  const flat = body.replace(/\n{3,}/g, "\n\n").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

export function buildTurn(
  records: readonly BrainRecord[],
  prompt: string,
  options: { keys?: ProjectKeys | null; seen?: ReadonlySet<string>; topK?: number; minScore?: number; relativeFloor?: number; tokenBudget?: number; excerptChars?: number } = {},
): TurnBlock {
  const o = { ...TURN_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as typeof TURN_DEFAULTS & typeof options;
  const hits = recall(records, prompt, { limit: 20, keys: o.keys ?? null });
  const top = hits[0]?.score ?? null;
  const seen = o.seen ?? new Set<string>();
  const floor = top === null ? Infinity : Math.max(o.minScore, top * o.relativeFloor);
  let belowFloor = 0;
  let skippedAsSeen = 0;
  const chosen: BrainRecord[] = [];
  const parts: string[] = [];
  let used = 40;
  for (const hit of hits) {
    if (chosen.length >= o.topK) break;
    if (hit.score < floor) {
      belowFloor++;
      continue;
    }
    if (seen.has(hit.record.id)) {
      skippedAsSeen++;
      continue;
    }
    const r = hit.record;
    const part = [
      `### [${r.kind}] ${r.name ?? r.id.slice(0, 8)} (${r.id.slice(0, 8)}, score ${hit.score.toFixed(1)})`,
      r.description ? `About: ${r.description}` : null,
      excerpt(r.body, o.excerptChars),
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
    const cost = estimateTokens(part) + 1;
    if (used + cost > o.tokenBudget) continue;
    used += cost;
    parts.push(part);
    chosen.push(r);
  }
  if (chosen.length === 0) {
    return { text: "", ids: [], tokens: 0, considered: hits.length, skippedAsSeen, belowFloor, topScore: top };
  }
  const text = [
    "# Brain: memories relevant to this prompt",
    "Not shown earlier in this session. Use them if they apply and cite the ones you used as [brain:<name>]; `recall` has more.",
    "",
    parts.join("\n\n"),
  ].join("\n");
  return { text, ids: chosen.map((r) => r.id), tokens: estimateTokens(text), considered: hits.length, skippedAsSeen, belowFloor, topScore: top };
}
