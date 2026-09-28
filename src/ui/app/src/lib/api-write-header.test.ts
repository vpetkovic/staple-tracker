/**
 * THE PAGE'S HALF OF THE WRITE RULE. The server accepts a write from a foreign Origin (the
 * app opened on a phone through the tailnet forwarder) only when it carries the UI token in
 * the `X-Staple-Token` header (`writeAllowed` in src/ui/server.ts). So every request this
 * app makes, every write included, must send it: `request()` in lib/api.ts is the one place
 * that calls fetch, and this pins that it attaches the token it holds to reads and writes
 * alike, whichever write family the call belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "t0ken-held-by-the-page";

beforeEach(() => {
  vi.resetModules();
  const store = new Map<string, string>([["staple:token", TOKEN]]);
  vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every request carries the token header", () => {
  it("reads and every write family, with the token the page holds", async () => {
    const seen: Array<{ url: string; method: string; token: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, method: init?.method ?? "GET", token: headers["x-staple-token"] });
      return { ok: true, status: 200, json: async () => ({}), clone: () => ({ json: async () => ({}) }) } as unknown as Response;
    });
    const api = await import("./api");
    expect(api.hasToken()).toBe(true);
    await api.getIssues({});
    await api.action({ ref: "ABC-1" }, { type: "comment", body: "from the phone" } as never);
    await api.stopRun({ id: "run-1" });
    await api.pauseRun({ id: "run-1" });
    await api.enqueueTask({ ref: "ABC-1", baseRevision: 1 });
    await api.addMilestoneMember({ milestone: "ABC-9", ref: "ABC-1", baseRevision: 1 });
    await api.setBudgetCapture(true);
    const writes = seen.filter((call) => call.method === "POST");
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const call of seen) expect(call.token, `${call.method} ${call.url}`).toBe(TOKEN);
  });
});
