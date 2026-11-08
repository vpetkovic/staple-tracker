/**
 * Plan sections and the importer (design/plan.md, "Plan sections"). The fixtures are invented but
 * shaped like real per-epic plan files: front matter, a title, numbered sections, a task table per
 * lane with its own header, a "step breakdown" with a different column set, revision notes that
 * mention task keys, decision subsections, checklists and a risk note.
 */
import { describe, expect, it } from "vitest";
import { completeness, estimateSeconds, gateSentence, parsePlanMarkdown, readSection, renderSection, sectionOfHeading, shapedGate, splitDepends, emptySections } from "../src/core/plan-sections.js";

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
    expect(plan.warnings).toEqual(["a breakdown row without a key: | | no key |", '"Task breakdown" holds no task rows']);
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
    const sections = parsePlanMarkdown(LANES).sections;
    for (const name of ["goal", "context", "breakdown", "acceptance", "dependencies", "outOfScope", "risks", "sources"] as const) {
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
    expect(splitDepends("42.1 and EPIC-3 SDK")).toEqual(["42.1", "EPIC-3 SDK"]);
  });
});

describe("the shaped gate", () => {
  const ready = () => ({ ...emptySections(), goal: "g", acceptance: ["a"], breakdown: [{ key: "1", title: "t", estimate: null, dependsOn: [], acceptance: "done", owner: null, notes: null }] });

  it("passes a plan with a goal, a breakdown with acceptance on every row, and acceptance criteria", () => {
    expect(shapedGate(ready(), [])).toEqual([]);
  });

  it("names each thing missing", () => {
    expect(shapedGate(emptySections(), [])).toEqual(["a goal", "a task breakdown", "acceptance criteria"]);
    const noRowAcceptance = { ...ready(), breakdown: [{ ...ready().breakdown[0]!, acceptance: null }] };
    expect(shapedGate(noRowAcceptance, [])).toEqual(["acceptance on task 1"]);
    expect(shapedGate(ready(), [{ text: "q", resolved: false }])).toEqual(["1 open question answered or deferred"]);
    expect(shapedGate(ready(), [{ text: "q", resolved: false, deferred: true }])).toEqual([]);
    expect(gateSentence(["a goal", "a task breakdown", "acceptance criteria"])).toBe("it needs a goal, a task breakdown and acceptance criteria before it is shaped");
  });

  it("counts the starred sections and all ten", () => {
    expect(completeness(ready(), [], [])).toEqual({ starred: 3, starredTotal: 3, filled: 3, total: 10 });
  });
});
