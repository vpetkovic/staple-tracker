/**
 * Plan sections and the importer (design/plan.md, "Plan sections"). The fixtures are invented but
 * shaped like real per-epic plan files: front matter, a title, numbered sections, a task table per
 * lane with its own header, a "step breakdown" with a different column set, revision notes that
 * mention task keys, decision subsections, checklists and a risk note.
 */
import { describe, expect, it } from "vitest";
import { DOCUMENT_SECTIONS, completeness, estimateProblem, estimateSeconds, planWarnings, gateSentence, parsePlanMarkdown, readSection, renderSection, sectionOfHeading, shapedGate, splitDepends, emptySections, type PlanSections } from "../src/core/plan-sections.js";

const LANES = `---
title: "PLAN-7 — Checkout API"
rung: R2
---

# PLAN-7 — Checkout API

**Window**: 2026-09-15 → 2026-10-31 · **Est**: ~20h

> The gate everything downstream waits on.

## 1. Goal

Turn the cart endpoints into a product a third party can build on.

## 2. Two decisions that need an ADR

### 2.1 Versioning — dated, pinned per application

Pinned per application, upgraded deliberately.

### 2.2 Credentials — applications and tokens

Both, scoped.

## 3. Task breakdown

### Lane A — contract

| # | Task | Est. | Depends on | Notes |
|---|------|------|-----------|-------|
| 7.1 | **Spike**: how payment providers version | 3h | — | owner: lead |
| 7.2 | **ADR**: versioning strategy | 2h | 7.1 | |

### Lane B — build

**7.3 and 7.4 both touch the router; not in parallel.**

| # | Task | Est. | Depends on | Notes |
|---|------|------|-----------|-------|
| 7.3 | Version resolution + routing | 5h | 7.2 | |
| 7.4 | Rate limits per credential | 1.5h | 7.3, PLAN-3 | needs PLAN-3 |

- **7.3: 4h → 5h.** The router rewrite was undercounted.

## 4. Acceptance criteria

- [ ] A pinned application keeps working when a newer version ships
- [ ] Every error carries a documented type

## 5. Out of scope

- Billing on overage.

## 6. Standing risk

Review bandwidth, not build throughput, is the binding constraint.

## 7. Open questions

- [ ] Dated or semantic versions?
- [x] Do tokens expire?
- [~] Webhooks in v1?

## 8. Notes

Anything else lands in context.
`;

const STEPS = `# PLAN-9 — Documentation

## 1. Goal

Docs that stay true.

## 2. Step breakdown

| # | Step | Est | When |
|---|------|-----|------|
| 9.1 | Decision records, entire | 3h | Aug |
| 9.2 | Portability gate | 2h | Sep |

## 3. Acceptance criteria

1. No doc describes a shape that no longer exists
`;

describe("the importer", () => {
  it("reads every task row from every lane's table, with its estimate, dependencies and notes", () => {
    const plan = parsePlanMarkdown(LANES);
    expect(plan.title).toBe("PLAN-7 — Checkout API");
    expect(plan.sections.breakdown.map((row) => row.key)).toEqual(["7.1", "7.2", "7.3", "7.4"]);
    expect(plan.sections.breakdown[0]).toMatchObject({ title: "Spike: how payment providers version", estimate: "3h", dependsOn: [], notes: "owner: lead" });
    expect(plan.sections.breakdown[3]).toMatchObject({ estimate: "1.5h", dependsOn: ["7.3", "PLAN-3"] });
    expect(plan.warnings).toEqual([]);
  });

  it("keeps a revision note about a task out of the task list, and its prose in context", () => {
    const plan = parsePlanMarkdown(LANES);
    expect(plan.sections.breakdown).toHaveLength(4);
    expect(plan.sections.context).toContain("7.3 and 7.4 both touch the router");
    expect(plan.sections.context).toContain("4h → 5h");
  });

  it("maps the headings to their sections and drops nothing", () => {
    const plan = parsePlanMarkdown(LANES);
    expect(plan.sections.goal).toBe("Turn the cart endpoints into a product a third party can build on.");
    expect(plan.sections.acceptance).toEqual(["A pinned application keeps working when a newer version ships", "Every error carries a documented type"]);
    expect(plan.sections.outOfScope).toContain("Billing on overage");
    expect(plan.sections.risks).toContain("Review bandwidth");
    expect(plan.decisions).toEqual(["Versioning — dated, pinned per application", "Credentials — applications and tokens"]);
    expect(plan.sections.context).toContain("Pinned per application, upgraded deliberately.");
    expect(plan.sections.context).toContain("Anything else lands in context.");
    expect(plan.questions).toEqual([
      { text: "Dated or semantic versions?", resolved: false, deferred: false },
      { text: "Do tokens expire?", resolved: true, deferred: false },
      { text: "Webhooks in v1?", resolved: false, deferred: true },
    ]);
    expect(plan.brief).toContain("The gate everything downstream waits on.");
    // What a row waits on outside the plan is the plan's dependency.
    expect(plan.sections.dependencies).toEqual(["PLAN-3"]);
  });

  it("reads a step breakdown whose columns differ, and a numbered acceptance list", () => {
    const plan = parsePlanMarkdown(STEPS);
    expect(plan.sections.breakdown.map((row) => [row.key, row.title, row.estimate, row.notes])).toEqual([
      ["9.1", "Decision records, entire", "3h", "Aug"],
      ["9.2", "Portability gate", "2h", "Sep"],
    ]);
    expect(plan.sections.acceptance).toEqual(["No doc describes a shape that no longer exists"]);
  });

  it("says what it could not place", () => {
    const plan = parsePlanMarkdown("# X\n\n## Task breakdown\n\n| # | Task |\n|---|---|\n| | no key |\n");
    expect(plan.warnings).toEqual(["a breakdown row without a key; kept in Context: | | no key |", '"Task breakdown" holds no task rows; kept in Context']);
    expect(plan.sections.context).toContain("| | no key |");
  });

  it("names sections by their heading's words, numbered or not", () => {
    expect(sectionOfHeading("4. Task breakdown")).toBe("breakdown");
    expect(sectionOfHeading("Step breakdown")).toBe("breakdown");
    expect(sectionOfHeading("7. Standing risk")).toBe("risks");
    expect(sectionOfHeading("6. Explicitly out of scope")).toBe("outOfScope");
    expect(sectionOfHeading("3. VP's ruling — 2026-08-20")).toBe("decisions");
    expect(sectionOfHeading("2. Layering — the line that must not blur")).toBeNull();
  });
});

describe("sections", () => {
  it("round-trip through their documents", () => {
    const sections = parsePlanMarkdown(LANES).sections as unknown as PlanSections;
    for (const name of DOCUMENT_SECTIONS) {
      expect(readSection(name, renderSection(name, sections)), name).toEqual(sections[name]);
    }
  });

  it("read estimates and depends-on cells as written in plans", () => {
    expect(estimateSeconds("3h")).toBe(10800);
    expect(estimateSeconds("1.5h")).toBe(5400);
    expect(estimateSeconds("30m")).toBe(1800);
    expect(estimateSeconds("2d")).toBe(57600);
    expect(estimateSeconds("~4h")).toBe(14400);
    expect(estimateSeconds("Aug")).toBeNull();
    expect(splitDepends("40.6, 40.7")).toEqual(["40.6", "40.7"]);
    expect(splitDepends("—")).toEqual([]);
    expect(splitDepends("none")).toEqual([]);
    expect(splitDepends("N/A")).toEqual([]);
    expect(splitDepends("42.1 and PLAN-3 SDK")).toEqual(["42.1", "PLAN-3 SDK"]);
  });
});

describe("the shaped gate", () => {
  const ready = (): PlanSections => ({ ...emptySections(), goal: "g", acceptance: ["a"], breakdown: [{ id: "r1", key: "1", title: "t", estimate: null, dependsOn: [], acceptance: "done", owner: null, notes: null }] });

  it("passes a plan with a goal, a titled breakdown and acceptance criteria", () => {
    expect(shapedGate(ready(), [])).toEqual([]);
  });

  it("names each thing missing", () => {
    expect(shapedGate(emptySections(), [])).toEqual(["a goal", "a task breakdown", "acceptance criteria"]);
    const noRowAcceptance = { ...ready(), breakdown: [{ ...ready().breakdown[0]!, acceptance: null }] };
    // A row without its own "done when" inherits the plan's acceptance criteria.
    expect(shapedGate(noRowAcceptance, [])).toEqual([]);
    expect(shapedGate({ ...noRowAcceptance, acceptance: [] }, [])).toEqual(["acceptance criteria"]);
    expect(shapedGate(ready(), [{ text: "q", resolved: false }])).toEqual(["1 open question answered or deferred"]);
    expect(shapedGate(ready(), [{ text: "q", resolved: false, deferred: true }])).toEqual([]);
    expect(gateSentence(["a goal", "a task breakdown", "acceptance criteria"])).toBe("it needs a goal, a task breakdown and acceptance criteria before it is shaped");
  });

  it("counts the starred sections and all ten", () => {
    expect(completeness(ready(), [], [])).toEqual({ starred: 3, starredTotal: 3, filled: 3, total: 10 });
  });
});

describe("the importer keeps what it cannot place", () => {
  const AWKWARD = [
    "---",
    "title: x",
    "---",
    "Some intro, before any heading.",
    "",
    "```bash",
    "# install deps",
    "npm i",
    "```",
    "",
    "# Plan T",
    "",
    "## Goal",
    "",
    "the goal",
    "",
    "## Context",
    "",
    "```md",
    "## Acceptance criteria",
    "- not real",
    "```",
    "",
    "## Acceptance criteria",
    "",
    "- first criterion",
    "  continued on a wrapped line",
    "  - nested sub point",
    "- second",
    "",
    "## Dependencies",
    "",
    "We wait on the vendor contract signed in Q1.",
    "",
    "## Task breakdown",
    "",
    "| Key | Task | Est | Depends | Done when |",
    "|---|---|---|---|---|",
    "| 42.1a | First | 2h | — | ok |",
    "| 42.2 | Second | 1 day | 42.1a | done \\| really |",
    "",
    "## Task breakdown",
    "",
    "| Key | Task | Done when |",
    "|---|---|---|",
    "| 42.2 | Dup second | x |",
    "",
    "## Open questions",
    "",
    "Should we ask legal? (prose, not a list)",
    "- [~] deferred one",
  ].join("\r\n");
  const parsed = parsePlanMarkdown(AWKWARD, "fallback");

  it("joins a wrapped line to its item and folds a nested bullet into its parent", () => {
    expect(parsed.sections.acceptance).toEqual(["first criterion continued on a wrapped line; nested sub point", "second"]);
  });

  it("never takes a heading inside a code fence: not as a section, not as the title", () => {
    expect(parsed.title).toBe("Plan T");
    expect(parsed.sections.acceptance).not.toContain("not real");
    expect(parsed.brief).toContain("# install deps");
    expect(parsed.sections.context).toContain("## Acceptance criteria\n- not real");
  });

  it("reads an escaped pipe as part of its cell", () => {
    expect(parsed.sections.breakdown.find((row) => row.key === "42.2")).toMatchObject({ acceptance: "done | really", estimate: "1 day", dependsOn: ["42.1a"] });
  });

  it("keeps the first of a repeated key as the task and the second in Context, with a warning, and does not throw", () => {
    expect(parsed.sections.breakdown.map((row) => row.key)).toEqual(["42.1a", "42.2"]);
    expect(parsed.warnings).toContain("task 42.2 appears twice; the first is the task, the second is kept in Context");
    expect(parsed.sections.context).toContain("| 42.2 | Dup second | x |");
  });

  it("keeps prose under Dependencies and Open questions in Context, and says so", () => {
    expect(parsed.sections.dependencies).toEqual([]);
    expect(parsed.sections.context).toContain("We wait on the vendor contract signed in Q1.");
    expect(parsed.sections.context).toContain("Should we ask legal? (prose, not a list)");
    expect(parsed.questions).toEqual([{ text: "deferred one", resolved: false, deferred: true }]);
    expect(parsed.warnings).toContain('"Dependencies": not a list of dependencies; kept in Context');
    expect(parsed.warnings).toContain('"Open questions": prose beside its questions; kept in Context');
  });

  it("keeps front matter in Context", () => {
    expect(parsed.sections.context).toContain("title: x");
  });

  it("names a depends-on key the breakdown does not hold, and keeps another plan's key as an outside dependency", () => {
    const plan = parsePlanMarkdown("# P\n\n## Task breakdown\n\n| # | Task | Depends on |\n|---|---|---|\n| 7.1 | A | — |\n| 7.2 | B | 7.9, 39.4, PLAN-3 |\n");
    expect(plan.warnings).toContain("task 7.2 waits on 7.9, which is not in the breakdown");
    expect(plan.sections.dependencies).toEqual(["39.4", "PLAN-3"]);
  });
});

describe("estimates", () => {
  it("read the common ways a plan writes a duration, a working day of eight hours and a week of five days", () => {
    const cases: Array<[string, number]> = [
      ["3h", 10_800],
      ["3 hours", 10_800],
      ["3hrs", 10_800],
      ["4 h", 14_400],
      ["0.5h", 1_800],
      ["30m", 1_800],
      ["30 mins", 1_800],
      ["45 minutes", 2_700],
      ["90s", 90],
      ["2h30m", 9_000],
      ["1 day", 28_800],
      ["2 days", 57_600],
      ["1.5d", 43_200],
      ["1w", 144_000],
      ["~4h", 14_400],
      ["2-3h", 10_800],
      ["3h (incl. review)", 10_800],
    ];
    for (const [written, seconds] of cases) expect(estimateSeconds(written), written).toBe(seconds);
  });

  it("say why an estimate reads as none, never a silent null", () => {
    expect(estimateProblem("a while")).toBe('the estimate "a while" is not a duration (write 3h, 30m, 2d or 1w)');
    expect(estimateProblem("3")).toBe('the estimate "3" has no unit (write 3h, 30m, 2d or 1w)');
    expect(estimateProblem("0h")).toBe('the estimate "0h" is zero');
    expect(estimateProblem("400w")).toBe('the estimate "400w" is more than a year');
    expect(estimateProblem("3h")).toBeNull();
    expect(estimateProblem(null)).toBeNull();
    const sections = { ...emptySections(), breakdown: [{ id: "r", key: "1", title: "t", estimate: "soon", dependsOn: [], acceptance: null, owner: null, notes: null }] };
    expect(planWarnings(sections)).toEqual(['task 1: the estimate "soon" is not a duration (write 3h, 30m, 2d or 1w)']);
  });
});

describe("the shaped gate reads the breakdown as a graph", () => {
  const plan = (rows: Array<{ key: string; dependsOn: string[] }>): PlanSections => ({
    ...emptySections(),
    goal: "g",
    acceptance: ["a"],
    breakdown: rows.map((row, at) => ({ id: `r${at}`, title: `T${at}`, estimate: null, acceptance: null, owner: null, notes: null, ...row })),
  });

  it("names a depends-on cycle by its rows, a row waiting on itself included", () => {
    expect(shapedGate(plan([{ key: "1", dependsOn: ["2"] }, { key: "2", dependsOn: ["1"] }]), [])).toEqual(["no depends-on cycle (1 → 2 → 1)"]);
    expect(shapedGate(plan([{ key: "1", dependsOn: ["1"] }]), [])).toEqual(["no depends-on cycle (1 → 1)"]);
  });

  it("names a key the breakdown does not hold, and two rows on one key", () => {
    expect(shapedGate(plan([{ key: "4.1", dependsOn: [] }, { key: "4.2", dependsOn: ["4.7"] }]), [])).toEqual(["task 4.2 to wait on a task that exists (4.7 is not in the breakdown)"]);
    expect(shapedGate(plan([{ key: "1", dependsOn: [] }, { key: "1", dependsOn: [] }]), [])).toEqual(["one key per task (2 tasks share 1)"]);
  });
});
