/**
 * The worklog excerpt and the freshness judgement. Pure input -> pure output, no
 * server and no DOM — the same shape as timeline.test.ts, for the same reason.
 *
 * THE FIXTURES ARE REAL. Every body below is a verbatim (trimmed) excerpt of a
 * document actually in this workspace, pulled with `staple doc <ref> worklog --json`.
 * That is deliberate: the whole risk in this module is that worklogs do not look the
 * way the protocol says they look, so a fixture invented to match the parser would
 * test nothing. The four shapes STA-115 names are:
 *
 *   heading      STA-97   `## Next` under a `## Done` — the shape the protocol asks for
 *   prose-label  STA-95   bare `Done: / Verified: / Files touched:` lines, no headings
 *   title-first  STA-98   `# STA-98 worklog — COMPLETE` then `## The mechanism`
 *   stderr-leak  STA-106  opens with a leaked `(node:2574) ExperimentalWarning …`
 *
 * Measured over all 45 worklogs in this workspace when the module was written: 19 have
 * a `## Next` heading, ZERO have a `Next:` prose line, and 26 have neither. Three of
 * the four fixtures above therefore reach tier 3, which is why the tier-3 assertions
 * are the load-bearing ones here and not the afterthought they look like.
 */
import { describe, expect, it } from "vitest";
import {
  EXCERPT_LINE_CAP,
  WORKLOG_KEY,
  WORKLOG_STALE_MARGIN_SECONDS,
  displayExcerptLine,
  excerptWorklog,
  isJunkWorklogLine,
  worklogStaleness,
} from "../src/ui/app/src/lib/worklog.js";

/** STA-97 — the shape the protocol asks for: `## Done`, then `## Next`, then more. */
const HEADING_BODY = [
  "# STA-97 (V5) worklog — v5-rows",
  "",
  "## Done — COMPLETE. Gates green, evidence captured.",
  "",
  "Rows are one grid, one row component, three presets.",
  "",
  "## Next",
  "- Nothing outstanding on STA-97. Open items are the four §18 questions for VP and the two",
  "  PARTIAL checklist rows above.",
  "",
  "## Files touched",
  "New — `src/ui/app/src/views/tree/`: `tree-model.ts`, `label-hue.ts`, `avatar.ts`",
  "New — `vitest.config.ts`",
].join("\n");

/** STA-95 — 886 chars, three lines, no headings at all. Verbatim. */
const PROSE_LABEL_BODY = [
  "Done: README npx-first rewrite (quickstart = npx staple-cli + claude mcp add via npx -y staple-cli mcp; ui->open; connect mention removed).",
  "Verified: grep gate (npx tsx|build:ui|alias staple) hits only CONTRIBUTING.md; every documented command cross-checked against node dist-package/staple.mjs help.",
  "Files touched: README.md, CONTRIBUTING.md, site/index.html, site/docs.html",
  "",
].join("\n");

/** STA-98 — names itself, then goes straight into an h2 that is not `Next`. */
const TITLE_FIRST_BODY = [
  "# STA-98 worklog — COMPLETE",
  "",
  "## The mechanism",
  "",
  "`markAncestorsInProgress` is GONE. In its place, in `src/core/store.ts`:",
  "",
  "- `recomputeAncestorStatuses(child, actor)` — the walk. Bounded by",
  "  MAX_TREE_DEPTH, cycle-proof, inside the caller's transaction.",
  "- `deriveOneAncestor(...)` — one rung: decide, check permission, CAS.",
  "- `static deriveStatusFromChildren(...)` — the ladder, over OPEN children only.",
  "- `isDerivationOwned(row)` — reversibility, read from the event log.",
  "",
  "### Writability law",
  "",
  "- done/cancelled: never (terminal both ways)",
].join("\n");

/** STA-106 — captured stderr, then a captured CLI header, then the real document. */
const STDERR_LEAK_BODY = [
  "",
  "(node:2574) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "# worklog @ r1 (2026-09-02T14:40)",
  "",
  "# STA-106 · R6 — prev/next through the list, from inside the detail",
  "",
  "## Done",
  "",
  "**Two chevrons in the chrome bar**, left of the frame controls and separated from",
  "them by a hairline. Expand and close act on the PANEL; these act on which ISSUE the",
  "panel is showing.",
  "",
  "**`detail/navigation.ts`** holds all of the logic and imports no React.",
].join("\n");

describe("WORKLOG_KEY", () => {
  it("is the key the protocol writes under", () => {
    expect(WORKLOG_KEY).toBe("worklog");
  });
});

describe("isJunkWorklogLine", () => {
  it("catches the leaked node banner STA-106 opens with, and its follow-up", () => {
    expect(isJunkWorklogLine("(node:2574) ExperimentalWarning: SQLite is an experimental feature")).toBe(true);
    expect(isJunkWorklogLine("(Use `node --trace-warnings ...` to show where the warning was created)")).toBe(true);
  });

  it("catches a fence marker, which would otherwise swallow everything after the excerpt", () => {
    expect(isJunkWorklogLine("```ts")).toBe(true);
    expect(isJunkWorklogLine("~~~")).toBe(true);
  });

  it("leaves ordinary prose, headings and list items alone", () => {
    expect(isJunkWorklogLine("## Next")).toBe(false);
    expect(isJunkWorklogLine("- wire the guard into the HTTP surface")).toBe(false);
    // Mentions node, is not a node banner.
    expect(isJunkWorklogLine("Ran the suite under node 22 and it passed.")).toBe(false);
  });

  it("does not call a blank line junk — blankness is handled separately", () => {
    expect(isJunkWorklogLine("")).toBe(false);
    expect(isJunkWorklogLine("   ")).toBe(false);
  });
});

describe("excerptWorklog — the four real shapes", () => {
  it("heading (STA-97): takes the Next section, and stops at the next h2", () => {
    const excerpt = excerptWorklog(HEADING_BODY)!;
    expect(excerpt.tier).toBe("next-heading");
    expect(excerpt.label).toBe("Next");
    expect(excerpt.lines).toEqual([
      "- Nothing outstanding on STA-97. Open items are the four §18 questions for VP and the two",
      "  PARTIAL checklist rows above.",
    ]);
    // The proof it stopped: `## Files touched` is a sibling section, not part of Next.
    expect(excerpt.lines.join("\n")).not.toContain("Files touched");
    expect(excerpt.truncated).toBe(false);
  });

  it("prose-label (STA-95): no heading anywhere, so the lead carries it", () => {
    const excerpt = excerptWorklog(PROSE_LABEL_BODY)!;
    expect(excerpt.tier).toBe("lead");
    expect(excerpt.label).toBeNull();
    expect(excerpt.lines).toHaveLength(3);
    expect(excerpt.lines[0]).toMatch(/^Done: README npx-first rewrite/);
    expect(excerpt.lines[2]).toMatch(/^Files touched: README\.md/);
    expect(excerpt.truncated).toBe(false);
  });

  it("title-first (STA-98): skips the document's own name, keeps its section structure", () => {
    const excerpt = excerptWorklog(TITLE_FIRST_BODY)!;
    expect(excerpt.tier).toBe("lead");
    // The h1 is the document naming itself and is dropped …
    expect(excerpt.lines).not.toContain("# STA-98 worklog — COMPLETE");
    // … the h2 is the label that makes the lines under it legible, and is kept.
    expect(excerpt.lines[0]).toBe("## The mechanism");
    expect(excerpt.lines).toHaveLength(EXCERPT_LINE_CAP);
    expect(excerpt.truncated).toBe(true);
  });

  it("stderr-leak (STA-106): drops the banner and BOTH leading h1s, starts at the content", () => {
    const excerpt = excerptWorklog(STDERR_LEAK_BODY)!;
    expect(excerpt.tier).toBe("lead");
    expect(excerpt.lines.join("\n")).not.toContain("ExperimentalWarning");
    expect(excerpt.lines.join("\n")).not.toContain("trace-warnings");
    // Two consecutive h1s — the captured CLI header and the real title — both go.
    expect(excerpt.lines.join("\n")).not.toContain("# worklog @ r1");
    expect(excerpt.lines.join("\n")).not.toContain("# STA-106 · R6");
    expect(excerpt.lines[0]).toBe("## Done");
    expect(excerpt.lines[1]).toMatch(/^\*\*Two chevrons in the chrome bar\*\*/);
  });

  it("counts the whole body's renderable lines, so 'show all' can be honest", () => {
    // 14 lines in: 5 blank and 2 leaked banner lines are not renderable, leaving 7.
    // The two h1 titles ARE counted — the lead tier skips them, but the Documents tab
    // that "show all" opens does render them, and this number describes that document.
    const excerpt = excerptWorklog(STDERR_LEAK_BODY)!;
    expect(excerpt.totalLines).toBe(7);
    expect(excerpt.totalLines).toBeGreaterThan(excerpt.lines.length);
  });
});

describe("excerptWorklog — the criterion: never empty for a non-empty body", () => {
  it("returns null ONLY for an empty or whitespace body", () => {
    expect(excerptWorklog("")).toBeNull();
    expect(excerptWorklog("   \n\n\t\n")).toBeNull();
  });

  it.each([
    ["heading", HEADING_BODY],
    ["prose-label", PROSE_LABEL_BODY],
    ["title-first", TITLE_FIRST_BODY],
    ["stderr-leak", STDERR_LEAK_BODY],
  ])("produces content for the %s shape", (_name, body) => {
    const excerpt = excerptWorklog(body)!;
    expect(excerpt).not.toBeNull();
    expect(excerpt.lines.length).toBeGreaterThan(0);
    expect(excerpt.lines.join("").trim()).not.toBe("");
  });

  it("shows the junk when the junk is genuinely the entire document", () => {
    const excerpt = excerptWorklog("(node:2574) ExperimentalWarning: SQLite is experimental\n")!;
    expect(excerpt.lines).toHaveLength(1);
    expect(excerpt.lines[0]).toContain("ExperimentalWarning");
  });

  it("does not render a labelled empty box for a Next heading with nothing under it", () => {
    const excerpt = excerptWorklog("# Title\n\n## Done\n- shipped it\n\n## Next\n")!;
    expect(excerpt.tier).toBe("lead");
    expect(excerpt.lines).toEqual(["## Done", "- shipped it", "## Next"]);
  });

  it("survives a body that is one bare line with no structure at all", () => {
    const excerpt = excerptWorklog("still going")!;
    expect(excerpt.tier).toBe("lead");
    expect(excerpt.lines).toEqual(["still going"]);
    expect(excerpt.truncated).toBe(false);
  });
});

describe("excerptWorklog — tiers 1 and 2 in detail", () => {
  it("keeps a deeper subsection inside the Next section rather than truncating at it", () => {
    const body = [
      "## Next",
      "- port the guard",
      "### Blocked on",
      "- STA-113's wire field",
      "## Files touched",
      "- store.ts",
    ].join("\n");
    const excerpt = excerptWorklog(body)!;
    expect(excerpt.tier).toBe("next-heading");
    expect(excerpt.lines).toEqual(["- port the guard", "### Blocked on", "- STA-113's wire field"]);
  });

  it("keeps the heading's own words — `## Next (owned by others)` is a real one here", () => {
    const excerpt = excerptWorklog("## Next (owned by others)\n- W1 owns the store method\n")!;
    expect(excerpt.label).toBe("Next (owned by others)");
  });

  it("matches a Next heading at any depth, case-insensitively", () => {
    expect(excerptWorklog("#### next steps\n- one\n")!.tier).toBe("next-heading");
    expect(excerptWorklog("# NEXT\n- one\n")!.tier).toBe("next-heading");
  });

  it("does not mistake a word merely starting with 'next' for the section", () => {
    const excerpt = excerptWorklog("## Nextcloud integration\n- unrelated\n")!;
    expect(excerpt.tier).toBe("lead");
  });

  it("prefers a heading over a prose line when the body has both", () => {
    const body = ["Next: the prose one", "", "## Next", "- the heading one"].join("\n");
    const excerpt = excerptWorklog(body)!;
    expect(excerpt.tier).toBe("next-heading");
    expect(excerpt.lines).toEqual(["- the heading one"]);
  });

  it("tier 2: reads a `Next:` prose line and stops at the sibling label", () => {
    // Zero worklogs in this workspace use this form today; the tier exists because
    // §3A specifies it and because it is what a heading-less agent would write.
    const body = [
      "Done: ported the claim guard.",
      "Next: wire the same guard into the HTTP surface,",
      "then re-run npm run smoke:mcp.",
      "Files touched: store.ts, server.ts",
    ].join("\n");
    const excerpt = excerptWorklog(body)!;
    expect(excerpt.tier).toBe("next-prose");
    expect(excerpt.label).toBe("Next");
    expect(excerpt.lines).toEqual([
      "wire the same guard into the HTTP surface,",
      "then re-run npm run smoke:mcp.",
    ]);
    expect(excerpt.lines.join("\n")).not.toContain("Files touched");
  });
});

describe("excerptWorklog — the cap", () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  it("caps at six rendered lines by default and says it truncated", () => {
    const excerpt = excerptWorklog(body)!;
    expect(EXCERPT_LINE_CAP).toBe(6);
    expect(excerpt.lines).toHaveLength(6);
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.totalLines).toBe(20);
  });

  it("honours an explicit cap, and never reports truncation when nothing was cut", () => {
    expect(excerptWorklog(body, 3)!.lines).toHaveLength(3);
    const exact = excerptWorklog(["a", "b", "c"].join("\n"), 3)!;
    expect(exact.truncated).toBe(false);
  });

  it("treats a zero or negative cap as one line rather than producing nothing", () => {
    expect(excerptWorklog(body, 0)!.lines).toHaveLength(1);
  });
});

describe("displayExcerptLine", () => {
  it("takes the markers off a heading and says it was one", () => {
    expect(displayExcerptLine("## Done")).toEqual({ text: "Done", heading: true });
    expect(displayExcerptLine("#### Next steps")).toEqual({ text: "Next steps", heading: true });
  });

  it("leaves an ordinary line completely alone", () => {
    expect(displayExcerptLine("- port the guard")).toEqual({ text: "- port the guard", heading: false });
  });

  it("does NOT strip inline emphasis — that is the Documents tab's job, not a half-renderer's", () => {
    const line = "**Two chevrons in the chrome bar**, left of the frame controls";
    expect(displayExcerptLine(line)).toEqual({ text: line, heading: false });
  });

  it("gives a tier-3 heading the same text a tier-1 label gets, which is the point", () => {
    const tierOne = excerptWorklog("## Next\n- something\n")!;
    const tierThree = excerptWorklog("# Title\n\n## Next\n")!;
    expect(tierOne.label).toBe("Next");
    expect(displayExcerptLine(tierThree.lines[0]!).text).toBe("Next");
  });
});

describe("worklogStaleness", () => {
  const written = "2026-09-02T12:00:00Z";
  const plus = (minutes: number) => new Date(Date.parse(written) + minutes * 60_000).toISOString();

  it("is fresh when the holder has done nothing since the checkpoint", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: written })).toBe("fresh");
  });

  it("is fresh while the holder is still inside one milestone", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: plus(59) })).toBe("fresh");
  });

  it("is stale once activity has run a full margin past the last checkpoint", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: plus(60) })).toBe("stale");
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: plus(240) })).toBe("stale");
  });

  it("is RELATIVE: an old worklog on a quiet ticket is not stale", () => {
    // The case a fixed threshold gets backwards. Checkpointed six hours ago, nothing
    // has happened since — the handoff still describes the work completely.
    const old = "2026-09-02T06:00:00Z";
    expect(worklogStaleness({ worklogUpdatedAt: old, claimLastActivityAt: old })).toBe("fresh");
  });

  it("is unknown when nobody is holding the ticket — no basis, so no claim", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: null })).toBe("unknown");
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: undefined })).toBe("unknown");
  });

  it("is unknown, never a guess, when a timestamp is missing or unparseable", () => {
    expect(worklogStaleness({ worklogUpdatedAt: null, claimLastActivityAt: written })).toBe("unknown");
    expect(worklogStaleness({ worklogUpdatedAt: "not a date", claimLastActivityAt: written })).toBe("unknown");
  });

  it("never treats a claim that predates the checkpoint as stale", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: plus(-300) })).toBe("fresh");
  });

  it("takes an explicit margin, so a caller can be stricter without a second definition", () => {
    expect(worklogStaleness({ worklogUpdatedAt: written, claimLastActivityAt: plus(10) }, 5 * 60)).toBe("stale");
  });

  it("uses an hour, and does NOT borrow the 30-minute liveness threshold", () => {
    expect(WORKLOG_STALE_MARGIN_SECONDS).toBe(3600);
    expect(WORKLOG_STALE_MARGIN_SECONDS).not.toBe(30 * 60);
  });
});
