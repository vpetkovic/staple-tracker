import { describe, expect, it } from "vitest";
import { QUEUE_ELIGIBILITIES } from "@/lib/types";
import { BUCKET_OF, summarySentence, type QueueSummary } from "./queue-summary";

describe("queue summary words", () => {
  it("files every eligibility the resolver can send in exactly one bucket", () => {
    for (const eligibility of QUEUE_ELIGIBILITIES) expect(BUCKET_OF[eligibility]).toBeDefined();
    expect(BUCKET_OF.claimed).toBe("active");
    expect(BUCKET_OF.eligible).toBe("ready");
    expect(BUCKET_OF.resolved).toBe("done");
  });

  it("leaves out empty buckets and joins the rest in plain English", () => {
    const summary: QueueSummary = { planned: 6, counts: { ready: 3, active: 1, waiting: 2, done: 0 }, notPlanned: 4 };
    expect(summarySentence(summary)).toBe(
      "6 tasks are in the plan: 3 ready to pick up, 1 being worked on and 2 waiting on something.",
    );
  });

  it("says what happens when nothing is planned", () => {
    expect(summarySentence({ planned: 0, counts: { ready: 0, active: 0, waiting: 0, done: 0 }, notPlanned: 56 })).toBe(
      "Nothing is planned yet, so agents take the 56 open tasks in list order.",
    );
  });
});
