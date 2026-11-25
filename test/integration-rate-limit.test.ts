import { describe, expect, it } from "vitest";
import { RequestBudget } from "../src/core/integrations/rate-limit.js";

function clock(start = 1_764_000_000_000) {
  const state = { now: start, slept: [] as number[] };
  return { state, clock: { now: () => state.now, sleep: async (ms: number) => { state.slept.push(ms); state.now += ms; } } };
}
const headers = (values: Record<string, string>) => new Headers(values);

describe("per-provider request budget", () => {
  it("spends a window of requests, then refuses with a typed retryable error instead of waiting a minute", async () => {
    const { clock: c } = clock();
    const budget = new RequestBudget("ClickUp", 3, c);
    for (let i = 0; i < 3; i++) await budget.take();
    await expect(budget.take()).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 60 } });
  });

  it("waits briefly when the window is about to free up", async () => {
    const { clock: c, state } = clock();
    const budget = new RequestBudget("ClickUp", 1, c);
    await budget.take();
    state.now += 57_000;
    await budget.take();
    expect(state.slept).toEqual([3_000]);
  });

  it("adopts the limit the server advertises", async () => {
    const { clock: c } = clock();
    const budget = new RequestBudget("ClickUp", 100, c);
    budget.observe(headers({ "x-ratelimit-limit": "2", "x-ratelimit-remaining": "1" }), 200);
    await budget.take();
    await budget.take();
    await expect(budget.take()).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("blocks until X-RateLimit-Reset when the server says none remain, in seconds or milliseconds", async () => {
    for (const unit of [1, 1000]) {
      const { clock: c, state } = clock();
      const budget = new RequestBudget("ClickUp", 100, c);
      budget.observe(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(((state.now + 30_000) / 1000) * unit) }), 200);
      await expect(budget.take()).rejects.toMatchObject({ code: "rate_limited", detail: { retryAfterSeconds: 30 } });
    }
  });

  it("honours Retry-After on a 429, as seconds or an HTTP date, ahead of the reset header", async () => {
    const { clock: c, state } = clock();
    const budget = new RequestBudget("ClickUp", 100, c);
    expect(budget.observe(headers({ "retry-after": "2", "x-ratelimit-reset": String(Math.floor(state.now / 1000) + 50) }), 429)).toBe(2_000);
    await budget.take();
    expect(state.slept).toEqual([2_000]);
    const dated = new RequestBudget("ClickUp", 100, c);
    expect(dated.observe(headers({ "retry-after": new Date(state.now + 20_000).toUTCString() }), 429)).toBe(20_000);
    await expect(dated.take()).rejects.toMatchObject({ detail: { retryAfterSeconds: 20 } });
  });

  it("falls back to the reset header, then a whole window, on a 429 without Retry-After", async () => {
    const { clock: c, state } = clock();
    const reset = new RequestBudget("ClickUp", 100, c);
    expect(reset.observe(headers({ "x-ratelimit-reset": String((state.now + 10_000) / 1000) }), 429)).toBe(10_000);
    const bare = new RequestBudget("ClickUp", 100, c);
    expect(bare.observe(headers({}), 429)).toBe(60_000);
    const nonsense = new RequestBudget("ClickUp", 100, c);
    expect(nonsense.observe(headers({ "retry-after": "soon", "x-ratelimit-reset": "-4" }), 429)).toBe(60_000);
  });

  it("ignores a past reset and caps a far one at an hour", async () => {
    const { clock: c, state } = clock();
    const budget = new RequestBudget("ClickUp", 100, c);
    budget.observe(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(state.now / 1000) - 5) }), 200);
    await budget.take();
    expect(budget.observe(headers({ "retry-after": "999999" }), 429)).toBe(3_600_000);
  });

  it("treats Retry-After: 0 as retry now, not a whole window", () => {
    const budget = new RequestBudget("ClickUp", 100, { now: () => 1_000_000, sleep: async () => {} });
    expect(budget.observe(new Headers({ "retry-after": "0" }), 429)).toBe(0);
  });
});
