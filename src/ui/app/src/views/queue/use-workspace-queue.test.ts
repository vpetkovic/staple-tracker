/**
 * The hub read, sliced per section (use-workspace-queue.ts `sectionRead`). The hook bodies are
 * driven in a browser by test/ui-queue-reliability.test.ts; this pins the pure slice.
 */
import { describe, expect, it } from "vitest";
import { queue } from "./fixtures";
import { sectionRead, type HubQueue } from "./use-workspace-queue";

const reload = () => {};
const section = { ...queue(), slug: "acme", prefix: "ACM", policy: "advisory" as const };

function hub(over: Partial<HubQueue> = {}): HubQueue {
  return { workspaces: [section], failed: [], error: undefined, loading: false, reload, ...over };
}

describe("one section's slice of the hub read", () => {
  it("is that workspace's own answer", () => {
    expect(sectionRead(hub(), "acme")).toEqual({ data: section, error: undefined, reload });
  });

  it("carries the server's message for a workspace it could not read, instead of loading forever", () => {
    const read = sectionRead(hub({ failed: [{ workspace: "blog", message: "database is locked" }] }), "blog");
    expect(read.data).toBeUndefined();
    expect(read.error?.message).toBe("database is locked");
  });

  it("carries the request's own failure for every section", () => {
    const failure = new Error("offline");
    expect(sectionRead(hub({ workspaces: [], error: failure }), "acme").error).toBe(failure);
  });
});
