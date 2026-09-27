/**
 * V3 — the property grid's *model*.
 *
 * The grid is the first thing anyone reads in the new detail, and the thing most
 * likely to rot: rows get added by whoever needs one, in whatever order they were
 * thinking in, until it is a bag of fields. So the row set is computed by a pure
 * function and pinned here, and the component is left with nothing to decide.
 *
 * What is actually being defended:
 *   1. A stable spine. Assignee / Created / Updated are ALWAYS rows, empty or not,
 *      so the grid does not reflow into a different shape per issue.
 *   2. Optional rows only when they carry something. A grid of eleven em-dashes is
 *      worse than a grid of four facts.
 *   3. No clock arithmetic. Timestamps render as the server sent them.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so
 * the app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import { detailFacts, formatWhen } from "./properties";
import type { IssueDetail } from "../lib/types";
import { claim, detail, issue } from "./detail-fixture";

const ids = (d: IssueDetail, mode: "workspace" | "hub" = "workspace") =>
  detailFacts(d, mode).map((fact) => fact.id);

const byId = (d: IssueDetail, id: string, mode: "workspace" | "hub" = "workspace") =>
  detailFacts(d, mode).find((fact) => fact.id === id);

describe("formatWhen", () => {
  it("renders the instant in local time WITH its zone, like the tooltips, never a bare UTC slice", () => {
    expect(formatWhen("2026-09-01T22:44:31Z", "UTC")).toBe("Sep 1, 2026, 10:44 PM UTC");
    // The same instant in New York is the evening before midnight, and says so.
    expect(formatWhen("2026-09-02T04:14:00Z", "America/New_York")).toBe("Sep 2, 2026, 12:14 AM EDT");
    expect(formatWhen("2026-09-01T22:44:31Z")).not.toBe("2026-09-01 22:44");
  });

  it("passes null through, so an absent date is absent rather than 'Invalid Date'", () => {
    expect(formatWhen(null)).toBeNull();
  });
});

describe("detailFacts — the spine", () => {
  it("always carries assignee, created and updated, however empty the issue", () => {
    expect(ids(detail())).toEqual(expect.arrayContaining(["assignee", "created", "updated"]));
  });

  it("keeps an empty assignee as a row with no value, not as a missing row", () => {
    const fact = byId(detail(), "assignee");
    expect(fact).toBeDefined();
    expect(fact?.value).toBeNull();
  });

  it("prefixes an assignee the way every other surface does", () => {
    expect(byId(detail({ issue: issue({ assignee: "vp" }) }), "assignee")?.value).toBe("@vp");
  });

  it("never emits a duplicate id, which would collide as a React key", () => {
    const all = ids(
      detail({
        issue: issue({ assignee: "vp", createdBy: "vp", startedAt: "2026-09-01T22:40:00Z", checkoutAgent: "v3-drawer" }),
        claim: claim(),
        documents: [{ issueId: "uuid-1", key: "plan", currentRevision: 3, title: null, updatedAt: "2026-09-01T22:44:31Z" }],
      }),
      "hub",
    );
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("detailFacts — the conditional rows", () => {
  it("shows the workspace only in hub mode, where it disambiguates", () => {
    expect(ids(detail(), "workspace")).not.toContain("workspace");
    expect(ids(detail(), "hub")).toContain("workspace");
    expect(byId(detail(), "workspace", "hub")?.value).toBe("staple");
  });

  it("has no holder row when nobody holds the issue", () => {
    expect(ids(detail())).not.toContain("holder");
  });

  /**
   * The holder row is the one place the grid says something a timestamp cannot:
   * whether the agent sitting on this ticket is alive. It borrows claim.ts's
   * reading rather than recomputing one.
   */
  it("names the holder and how long they have been silent", () => {
    const fact = byId(
      detail({ issue: issue({ checkoutAgent: "v3-drawer" }), claim: claim({ idleSeconds: 2700 }) }),
      "holder",
    );
    expect(fact?.value).toContain("v3-drawer");
    expect(fact?.value).toContain("silent 45m");
  });

  it("still names the holder when the server sent no liveness reading", () => {
    const fact = byId(detail({ issue: issue({ checkoutAgent: "v3-drawer" }), claim: null }), "holder");
    expect(fact?.value).toBe("v3-drawer");
  });

  it("shows started only once the issue has started", () => {
    expect(ids(detail())).not.toContain("started");
    expect(ids(detail({ issue: issue({ startedAt: "2026-09-01T22:40:00Z" }) }))).toContain("started");
  });

  /**
   * Done and cancelled are different endings and the grid says which. Reusing one
   * "Closed" row for both would lose the only fact that distinguishes a shipped
   * ticket from an abandoned one.
   */
  it("labels a completion and a cancellation differently", () => {
    const done = byId(detail({ issue: issue({ status: "done", completedAt: "2026-09-02T09:00:00Z" }) }), "completed");
    expect(done?.label).toBe("Completed");
    const killed = byId(
      detail({ issue: issue({ status: "cancelled", cancelledAt: "2026-09-02T09:00:00Z" }) }),
      "cancelled",
    );
    expect(killed?.label).toBe("Cancelled");
  });

  it("counts documents and comments only when there are some", () => {
    expect(ids(detail())).not.toContain("documents");
    const populated = detail({
      documents: [
        { issueId: "uuid-1", key: "plan", currentRevision: 3, title: null, updatedAt: "2026-09-01T22:44:31Z" },
        { issueId: "uuid-1", key: "worklog", currentRevision: 1, title: null, updatedAt: "2026-09-01T22:44:31Z" },
      ],
      comments: [
        {
          id: "c1",
          issueId: "uuid-1",
          author: "vp",
          authorType: "user",
          body: "hi",
          idempotencyKey: null,
          deletedAt: null,
          createdAt: "2026-09-01T22:44:31Z",
        },
      ],
    });
    expect(byId(populated, "documents")?.value).toBe("2");
    expect(byId(populated, "comments")?.value).toBe("1");
  });
});

describe("detailFacts — the raw values behind More details", () => {
  it("leads with the reference and the status's own name, and ends with the internal id", () => {
    const facts = detailFacts(detail(), "workspace");
    expect(facts[0]).toMatchObject({ id: "identifier", value: "STA-88", mono: true });
    expect(facts[1]).toMatchObject({ id: "status", value: "in_progress", mono: true });
    expect(facts.at(-1)).toMatchObject({ id: "internalId", value: "uuid-1", mono: true });
  });

  it("never sets a person or a date in mono", () => {
    const d = detail({ issue: issue({ assignee: "vp", createdBy: "orchestrator", checkoutAgent: "v3-drawer", startedAt: "2026-09-01T22:40:00Z" }), claim: claim() });
    for (const id of ["assignee", "createdBy", "holder", "created", "updated", "started"]) {
      expect(byId(d, id)?.mono, id).toBeFalsy();
    }
  });
});

describe("detailFacts — what it refuses to do", () => {
  /**
   * claim.ts's rule, carried here: readings come from the server, the page never
   * derives one from its own clock. A grid that said "updated 3 minutes ago" would
   * keep counting in a backgrounded tab and be confidently wrong.
   */
  it("renders timestamps verbatim rather than as a client-computed 'ago'", () => {
    const fact = byId(detail(), "updated");
    expect(fact?.value).toBe(formatWhen("2026-09-01T22:44:31Z"));
    expect(fact?.value).toMatch(/2026, \d{1,2}:\d{2} [AP]M \S+$/);
    expect(fact?.value).not.toMatch(/ago/);
  });

  it("keeps the full instant available as a hover, since the row is truncated", () => {
    expect(byId(detail(), "created")?.title).toBe("2026-09-01T22:13:04Z");
  });

  /**
   * O1b (STA-125). Kind reads exactly like a fact — a short string in a table of short
   * strings — which is precisely why this pin exists. It is not one:
   * `store.assertConfiguredKind()` can refuse a value, and a `DetailFact` has nowhere to
   * put a refusal, so a row rendered from here would show the OLD kind after a rejected
   * write with no sentence saying why. It is an editor (`InlineKind`), mounted into the
   * SAME grid as a `FactRow` so its label stays in the label column.
   *
   * A read-only copy here would also be the second place one field is shown, which is
   * how the two start disagreeing during the 1.5s poll.
   */
  it("does not model kind as a fact — it is an editor, not a value", () => {
    expect(ids(detail())).not.toContain("kind");
    expect(byId(detail(), "kind")).toBeUndefined();
    // And not smuggled in under another name, either.
    expect(detailFacts(detail(), "workspace").map((fact) => fact.label)).not.toContain("Kind");
  });
});
