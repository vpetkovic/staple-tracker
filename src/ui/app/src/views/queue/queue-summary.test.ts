import { describe, expect, it } from "vitest";
import { QUEUE_ELIGIBILITIES } from "@/lib/types";
import { effective } from "./fixtures";
import { BUCKET_OF, queueSummary } from "./queue-summary";

describe("queue summary counts", () => {
  it("files every eligibility the resolver can send in exactly one bucket", () => {
    for (const eligibility of QUEUE_ELIGIBILITIES) expect(BUCKET_OF[eligibility]).toBeDefined();
    expect(BUCKET_OF.claimed).toBe("active");
    expect(BUCKET_OF.eligible).toBe("ready");
    expect(BUCKET_OF.resolved).toBe("done");
  });

  it("counts the plan by bucket and the open work after it apart", () => {
    const summary = queueSummary([
      effective({ identifier: "A" }),
      effective({ identifier: "B", eligibility: "claimed" }),
      effective({ identifier: "C", eligibility: "gated" }),
      effective({ identifier: "D", eligibility: "resolved" }),
      effective({ identifier: "E", unqueued: true }),
    ]);
    expect(summary).toEqual({ planned: 4, counts: { ready: 1, active: 1, waiting: 1, done: 1 }, notPlanned: 1 });
  });
});
