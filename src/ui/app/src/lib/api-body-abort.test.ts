/**
 * A request given up while its body is still arriving fails; it does not read as an empty
 * answer. The page's poll is aborted after a timeout, and a poll that came back as `{}`
 * would carry no fingerprint, read as "live", and refetch the whole page twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  const store = new Map<string, string>([["staple:token", "t0ken"]]);
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

const answering = (json: () => Promise<unknown>) =>
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json, clone: () => ({ json }) }) as unknown as Response);

describe("reading a response body", () => {
  it("fails when the request's own signal aborts while the body is read", async () => {
    const controller = new AbortController();
    answering(() => {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      return Promise.reject(controller.signal.reason);
    });
    const api = await import("./api");
    await expect(api.getPoll(controller.signal)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("still reads a body that is not JSON as empty", async () => {
    answering(() => Promise.reject(new SyntaxError("Unexpected end of JSON input")));
    const api = await import("./api");
    await expect(api.getPoll(new AbortController().signal)).resolves.toEqual({});
  });
});
