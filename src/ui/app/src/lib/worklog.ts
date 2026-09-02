/**
 * The worklog's two judgements — what to show of it, and whether it is behind the
 * work. Pure, so both can be tested without a browser and reused without a React tree.
 *
 * WHY THIS FILE EXISTS AT ALL. Three surfaces want an excerpt of the same document —
 * the Overview panel (W3), the row cue (W4) and, later, the hover peek — and a
 * worklog excerpted three slightly different ways is three surfaces that quietly
 * disagree about what a ticket says. §5d of the STA-108 spec asks for exactly one
 * module. This is it.
 *
 * IT IS PURE, AND THAT IS LOAD-BEARING. No DOM, no `Date.now()`, and no `@/` imports,
 * so it compiles under the *Node* tsconfig and is unit-testable from `test/` — the
 * precedent `detail/timeline.ts` set and for the same reason. It follows that anything
 * this file needs from `lib/types.ts` is declared here as a plain primitive instead
 * (see `worklogStaleness`): an ISO string is a contract both compilations already
 * share, and importing the type would trade a testable module for a tidier signature.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT THIS FILE IS BUILT ON
 *
 * Before writing it, every worklog in this workspace was read through the CLI — 45
 * bodies, 886 to 13,263 characters:
 *
 *     has a `## Next` heading     19   42%
 *     has a `Next:` prose line     0    0%
 *     has neither                 26   58%
 *
 * So the obvious build — "render the `## Next` section" — renders NOTHING on the
 * majority of live tickets, including all four bodies the ticket names (STA-98,
 * STA-95, STA-106, STA-111 have no Next marker of either kind). An empty box does not
 * read as "this agent wrote no Next section"; it reads as "this feature is broken".
 *
 * The tiers below are therefore not defensive coding around a rare case. Tier 3 is
 * the majority path and is written as a first-class answer, not a shrug. Tier 2
 * matches nothing in today's corpus; it is kept because §3A specifies it, it costs one
 * regex, and the prose form is what an agent writing without headings would reach for.
 */

import { WORKLOG_KEY } from "./types.js";

/**
 * The document key a worklog lives under, RE-EXPORTED rather than re-declared.
 *
 * §5d of the spec nominated this module as the owner of `WORKLOG_KEY`. W1 (STA-113)
 * landed it in `lib/types.ts` instead, and that is the better home: types.ts is where
 * this app mirrors the wire vocabulary, and the canonical value lives in
 * `src/core/types.ts` which the browser cannot import. A second literal here would be
 * exactly the grep-across-files problem the constant exists to prevent.
 *
 * The re-export is not ceremony. §5d's real requirement is that a surface needing the
 * excerpt and the key gets both from ONE import, and callers keep saying
 * `from "@/lib/worklog"`. One source of truth, one import site.
 *
 * `./types.js` is a RELATIVE import, so the `@/` ban is respected and this module still
 * compiles from `test/` under the Node tsconfig — types.ts imports nothing at all, so
 * nothing DOM-shaped comes with it. The `.js` extension is what NodeNext requires;
 * `lib/filters.ts` and `lib/derived-blocked.ts` write the same import extensionless
 * because they are only ever compiled by the bundler config.
 */
export { WORKLOG_KEY };

/** How many lines of a worklog a panel shows before deferring to "show all". */
export const EXCERPT_LINE_CAP = 6;

/**
 * Which rule produced the excerpt. Rendered surfaces use it to decide whether they
 * have a *section* (tiers 1 and 2, which have a name for what you are reading) or
 * merely the *top of the document* (tier 3, which does not and must not pretend to).
 */
export type WorklogExcerptTier = "next-heading" | "next-prose" | "lead";

export interface WorklogExcerpt {
  tier: WorklogExcerptTier;
  /**
   * What the section calls itself, verbatim from the body — `Next`, but also
   * `Next (owned by others)` and `Next / for D3 (CI)`, both of which are real headings
   * in this workspace. Null on the `lead` tier, which found no section to name.
   */
  label: string | null;
  /** The lines to render, already capped, already stripped of junk and blanks. */
  lines: string[];
  /** True when `lines` is not all of what the tier selected — i.e. the cap bit. */
  truncated: boolean;
  /**
   * Every renderable line in the WHOLE body, junk excluded. What "show all" is
   * offering, so the control can be honest about the size of the thing it opens
   * instead of saying "show all" over a document that is three lines long.
   */
  totalLines: number;
}

/** `## Next`, `#### next steps`, `# Next (owned by others)` — captures depth and text. */
const NEXT_HEADING = /^\s{0,3}(#{1,4})\s*(next\b.*)$/i;
/** Any ATX heading, for "where does this section end". */
const ANY_HEADING = /^\s{0,3}(#{1,6})\s+\S/;
/** A top-level `# Title` line — the document's own name, not a section of it. */
const TITLE_HEADING = /^\s{0,3}#\s+\S/;
/** `Next: wire the guard into…` — the heading-less form STA-95's shape would use. */
const NEXT_PROSE = /^\s*next\s*:/i;
/** `Done: …`, `Verified: …`, `Files touched: …` — a sibling label, so a section end. */
const PROSE_LABEL = /^\s*[A-Za-z][A-Za-z ]{0,24}:\s/;

/**
 * Lines that are in the document but are not *of* it.
 *
 * STA-106's worklog opens with a `(node:2574) ExperimentalWarning: SQLite …` banner
 * and its `(Use \`node --trace-warnings …\`)` follow-up — captured stderr, written
 * straight into the body by an agent piping CLI output. Three tickets in this
 * workspace do some version of this.
 *
 * FILTERED IN THE EXCERPT, NEVER IN THE DOCUMENT (VP's answer to Q7). The excerpt has
 * six lines to spend and must not spend two of them on a node warning; the Documents
 * tab renders the body verbatim, so the underlying agent bug stays visible to anyone
 * who goes looking. Hiding it in both places would be the excerpt covering for a bug
 * that ought to get fixed.
 *
 * Fence markers go too, for a different reason: an excerpt is a FRAGMENT, and a
 * fragment that opens a fence it never closes is a fragment that swallows everything
 * rendered after it.
 */
export function isJunkWorklogLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false; // blank is not junk; it is handled separately
  if (/^\(node:\d+\)/.test(trimmed)) return true;
  if (/^\(Use `node\b/i.test(trimmed)) return true;
  // The warning body when it wraps onto its own line, and the "trace-warnings" hint in
  // any phrasing node has used for it.
  if (/\b(Experimental|Deprecation)Warning\b/.test(trimmed)) return true;
  if (/^--trace-warnings\b/.test(trimmed)) return true;
  if (/^(```|~~~)/.test(trimmed)) return true;
  return false;
}

/** Strip the leading `#`s and surrounding space from an ATX heading line. */
function headingText(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s*#*\s*$/, "").trim();
}

/** Renderable = has content, and is not stderr that leaked in. */
function isRenderable(line: string): boolean {
  return line.trim() !== "" && !isJunkWorklogLine(line);
}

/**
 * The tiered excerpt of §3A.
 *
 * Returns null ONLY for a body that is empty or entirely whitespace. That is the
 * acceptance criterion stated as a type: for any body with a single visible
 * character, some tier produces content, and the caller never has to handle "the
 * document exists but I got nothing". Even a body that is *nothing but* junk falls
 * through to the last-resort branch and shows its junk, because at that point the
 * leaked banner genuinely is the entire document and pretending otherwise would be
 * the empty box again.
 *
 * BLANK LINES ARE DROPPED, not preserved. With six lines to spend, a blank costs a
 * line of information and buys paragraph shape that is not legible at six lines
 * anyway. The Documents tab is where the body keeps its formatting.
 */
export function excerptWorklog(body: string, lineCap: number = EXCERPT_LINE_CAP): WorklogExcerpt | null {
  if (body.trim() === "") return null;

  const lines = body.split("\n");
  const totalLines = lines.filter(isRenderable).length;
  const cap = Math.max(1, lineCap);

  const finish = (
    tier: WorklogExcerptTier,
    label: string | null,
    selected: string[],
  ): WorklogExcerpt => ({
    tier,
    label,
    lines: selected.slice(0, cap),
    truncated: selected.length > cap,
    totalLines,
  });

  // ── tier 1 · a Next HEADING ────────────────────────────────────────────────
  // The section ends at the next heading of equal-or-shallower depth. Depth matters:
  // `## Next` containing a `### Blocked on` subsection should keep the subsection,
  // and stopping at "the next heading of any kind" would truncate at exactly the
  // detail the resuming agent needs.
  for (let i = 0; i < lines.length; i++) {
    const match = NEXT_HEADING.exec(lines[i]!);
    if (!match) continue;
    const depth = match[1]!.length;
    const selected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      const heading = ANY_HEADING.exec(line);
      if (heading && heading[1]!.length <= depth) break;
      if (isRenderable(line)) selected.push(line);
    }
    // A `## Next` with nothing under it is a heading, not a section — fall through
    // rather than render a labelled empty box, which is the failure mode this whole
    // module exists to avoid.
    if (selected.length > 0) return finish("next-heading", headingText(match[0]), selected);
    break;
  }

  // ── tier 2 · a `Next:` PROSE LINE ──────────────────────────────────────────
  // The heading-less shape. Ends at a blank line, a heading, or a sibling `Label:`
  // line — STA-95's `Done: … Verified: … Files touched: …` form, where each label
  // owns exactly one line and running past one would paste the next fact onto this one.
  for (let i = 0; i < lines.length; i++) {
    if (!NEXT_PROSE.test(lines[i]!)) continue;
    const head = lines[i]!.replace(NEXT_PROSE, "").trim();
    const selected: string[] = head === "" ? [] : [head];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") break;
      if (ANY_HEADING.test(line) || PROSE_LABEL.test(line)) break;
      if (isRenderable(line)) selected.push(line);
    }
    if (selected.length > 0) return finish("next-prose", "Next", selected);
    break;
  }

  // ── tier 3 · the LEAD ──────────────────────────────────────────────────────
  // 58% of this workspace's worklogs land here, so it is written as an answer rather
  // than as a fallback.
  //
  // Leading `# h1` lines are skipped — they are the document naming itself
  // (`# STA-98 worklog — COMPLETE`, and STA-106 has two in a row because it captured a
  // CLI header), and a reader looking at a panel already titled WORKLOG learns nothing
  // from being told the document is a worklog.
  //
  // `##`+ headings are KEPT, deliberately. `## Done` above five lines is the label
  // that makes those five lines legible; dropping it would hand the reader an
  // unattributed list. The rule is "skip the document's name, keep its structure".
  const lead: string[] = [];
  let started = false;
  for (const line of lines) {
    if (!isRenderable(line)) continue;
    if (!started && TITLE_HEADING.test(line)) continue;
    started = true;
    lead.push(line);
    if (lead.length > cap) break; // one past the cap is enough to know it was truncated
  }
  if (lead.length > 0) return finish("lead", null, lead);

  // ── last resort ────────────────────────────────────────────────────────────
  // Non-empty body, nothing renderable in it: every line was a leaked banner, a fence,
  // or an h1. Show it anyway. The criterion is that a non-empty body never produces an
  // empty excerpt, and it holds here or it does not hold.
  const anything = lines.filter((line) => line.trim() !== "");
  return finish("lead", null, anything);
}

/**
 * One excerpt line, as a reader should SEE it.
 *
 * `lines` is deliberately verbatim — §1b's reader wants what the agent actually wrote,
 * and a module that quietly rewrites its output is a module you cannot trust to have
 * left the substance alone. But an ATX heading inside the excerpt is the one place
 * verbatim reads badly: tier 1 renders a clean `Next` label (its markers are consumed
 * by the tier), so a tier-3 excerpt printing a literal `## Done` two pixels away looks
 * like two different features.
 *
 * So the markers come off HERE, in a named presentation step, rather than in the
 * parser. The caller gets the text and the fact that it was a heading, and decides how
 * to weight it. Inline emphasis (`**bold**`) is left alone on purpose: stripping it
 * would be the first step of writing a second markdown renderer, and the Documents tab
 * one click away is already the properly rendered version.
 *
 * Shared so the panel, the row cue and the future peek all draw a heading the same way.
 */
export function displayExcerptLine(line: string): { text: string; heading: boolean } {
  const heading = ANY_HEADING.test(line);
  return { text: heading ? headingText(line) : line, heading };
}

// ───────────────────────────────────────────────────────────────────────────────
// Freshness
// ───────────────────────────────────────────────────────────────────────────────

/**
 * How far the claim may run ahead of the last checkpoint before the checkpoint is
 * behind the work: ONE HOUR.
 *
 * SEPARATELY NAMED, SEPARATELY ARGUED, AND NOT `STALE_CLAIM_SECONDS`. §4 of the spec is
 * explicit and this is the paragraph it was written for. `lib/claim.ts`'s 30 minutes
 * answers "has this agent gone silent" — it is a *liveness* threshold, and borrowing it
 * would silently assert that "quiet for a while" and "has not checkpointed lately" are
 * the same judgement. They are not: the table in §4 exists precisely because they come
 * apart. This module does not import that constant and must not.
 *
 * Why an hour. `.tasks/AGENTS.md` asks for a checkpoint "at every milestone, not at the
 * end", and a milestone in this workspace is thirty to ninety minutes of work. An agent
 * that has been *active* for a full hour past its last checkpoint has, by that cadence,
 * finished at least one milestone without writing it down — which is the exact failure
 * the protocol exists to prevent. Under an hour, silence about a checkpoint is just an
 * agent in the middle of one.
 */
export const WORKLOG_STALE_MARGIN_SECONDS = 60 * 60;

/**
 * `unknown` is a real answer and not a failure. Nobody is holding the ticket, or the
 * timestamps do not parse, so there is no basis for a judgement — and per §4 rule 4
 * ("the page never invents a fact") the surface renders nothing rather than guessing.
 */
export type WorklogFreshness = "fresh" | "stale" | "unknown";

/**
 * Is the worklog behind the work?
 *
 * RELATIVE, not a fixed age (VP's answer to Q4). "Stale" here means *the holder has
 * been active more recently than the last checkpoint, by a meaningful margin* — i.e.
 * work has happened that the handoff does not describe. A ticket checkpointed six
 * hours ago and untouched since is NOT stale: nothing has happened that the worklog
 * fails to explain, and calling it stale would flag a finished, well-documented ticket
 * as a handoff risk. That is the whole reason this is a comparison rather than a
 * duration — an absolute threshold gets that case exactly backwards.
 *
 * BOTH READINGS ARE SERVER-DERIVED and this function does not consult a clock, which
 * is what keeps it pure and what keeps it honest: `lib/claim.ts` rule 1 says the page
 * never ticks locally, and there is nothing here to tick.
 *
 * Takes ISO strings rather than a `ClaimActivity` and an `IssueDocumentMeta`. Those
 * types live behind `@/lib/types`, which this file may not import (see the header);
 * primitives keep the module compilable from `test/`. A caller holds
 * `claim.lastActivityAt` and `document.updatedAt` already, so the unpacking is at the
 * call site where the types are in scope anyway.
 */
export function worklogStaleness(
  input: {
    /** `documents.updated_at` for the worklog key — when the handoff was last written. */
    worklogUpdatedAt: string | null | undefined;
    /** `claim.lastActivityAt` — when the holder last did anything. Null when unheld. */
    claimLastActivityAt: string | null | undefined;
  },
  marginSeconds: number = WORKLOG_STALE_MARGIN_SECONDS,
): WorklogFreshness {
  const written = Date.parse(input.worklogUpdatedAt ?? "");
  const active = Date.parse(input.claimLastActivityAt ?? "");
  if (!Number.isFinite(written) || !Number.isFinite(active)) return "unknown";
  return (active - written) / 1000 >= marginSeconds ? "stale" : "fresh";
}
