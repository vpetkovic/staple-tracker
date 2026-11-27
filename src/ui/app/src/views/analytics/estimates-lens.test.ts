/**
 * The Estimates lens's one sentence about what the typical figure means. It used to say "the speed
 * of the agents, not a planning mistake" whatever the figure was, including when work overran.
 */
import { describe, expect, it } from "vitest";
import { leadReading } from "./EstimatesLens";

describe("what the typical share of the estimate means", () => {
  it("under the estimate is the agents' speed", () => {
    expect(leadReading(0.2)).toContain("the speed of the agents, not a planning mistake");
    expect(leadReading(0.94)).toContain("the speed of the agents");
  });

  it("about the estimate says the estimates are close", () => {
    expect(leadReading(0.95)).toBe("The estimates here are close to what the work takes.");
    expect(leadReading(1.05)).toBe("The estimates here are close to what the work takes.");
  });

  it("over the estimate says the work overruns, and never credits speed", () => {
    expect(leadReading(1.4)).toContain("runs over its estimate");
    expect(leadReading(1.4)).not.toContain("speed");
  });
});
