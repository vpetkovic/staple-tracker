import { describe, expect, it } from "vitest";
import { PROJECT_KINDS, PROJECT_SOURCE_KINDS } from "../src/core/types.js";
import * as mirror from "../src/ui/app/src/lib/types.js";

/**
 * The browser keeps hand-kept mirrors of core's project vocabulary — it cannot import
 * src/core (Node-only) — and a mirror that drifts is a form that offers what the store
 * refuses. Same discipline as `kind-appearance.test.ts`: equality, asserted, across the
 * module boundary the bundler enforces.
 */
describe("the browser's project mirrors equal core's", () => {
  it("project kinds", () => {
    expect([...mirror.PROJECT_KINDS]).toEqual([...PROJECT_KINDS]);
  });

  it("source kinds", () => {
    expect([...mirror.PROJECT_SOURCE_KINDS]).toEqual([...PROJECT_SOURCE_KINDS]);
  });
});
