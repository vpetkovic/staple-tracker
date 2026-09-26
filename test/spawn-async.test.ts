import { describe, expect, it } from "vitest";
import { spawnAsync } from "./fixtures/spawn-async.js";

describe("spawnAsync", () => {
  it("returns at the timeout even when a grandchild still holds the pipes, as spawnSync does", async () => {
    const started = Date.now();
    const result = await spawnAsync("/bin/sh", ["-c", "sleep 4; echo late"], { timeout: 300 });
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
