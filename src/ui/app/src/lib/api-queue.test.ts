/**
 * R2d (STA-169) — the queue client and its CAS. Every mutation carries `baseRevision`, a
 * 409 whose code is `revision_conflict` is told apart from a plain refusal, and the retry
 * a conflict offers goes out as a second `reorder` against the revision the server named.
 * `fetch` is stubbed; nothing else is. Written beside `api-milestones.test.ts`, in its
 * shape, because it is the same contract on a second surface.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { entry } from "@/views/queue/fixtures";
import { retryOrder } from "@/views/queue/queue-model";
import {
  ApiError,
  dequeueTask,
  enqueueTask,
  getQueue,
  isRevisionConflict,
  pruneQueue,
  reorderQueue,
  REVISION_CONFLICT_CODE,
} from "./api";

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** A `fetch` that answers every call from `answers` in turn, and remembers what it was asked. */
function stubFetch(answers: Array<{ status: number; payload: unknown }>): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: String(answer.status),
      json: async () => answer.payload,
    } as Response;
  });
  return calls;
}

const ok = (payload: unknown = {}) => stubFetch([{ status: 200, payload }]);

afterEach(() => vi.unstubAllGlobals());

describe("queue reads", () => {
  it("asks for the plan with the workspace and the resolved flag as the server spells them", async () => {
    const calls = ok({ revision: 1, entries: [], effective: [] });
    await getQueue({ ws: "staple", all: true });
    await getQueue();
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/queue?ws=staple&all=1"],
      ["GET", "/api/queue"],
    ]);
  });
});

describe("queue writes carry the CAS base", () => {
  it("reorder posts the whole order with baseRevision and the ui actor", async () => {
    const calls = ok({ revision: 8 });
    const result = await reorderQueue({
      ws: "staple",
      order: ["STA-31", "STA-66", "STA-146"],
      baseRevision: 7,
    });
    expect(result).toEqual({ revision: 8 });
    expect(calls[0]).toEqual({
      url: "/api/queue/reorder",
      method: "POST",
      body: { actor: "ui", ws: "staple", order: ["STA-31", "STA-66", "STA-146"], baseRevision: 7 },
    });
  });

  it("uses the HTTP spelling of every verb, not the CLI's", async () => {
    const calls = ok({});
    await enqueueTask({ ref: "STA-146", baseRevision: 7, note: "the flake" });
    await dequeueTask({ ref: "STA-146", baseRevision: 8 });
    await pruneQueue({ baseRevision: 10 });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/queue/enqueue", { actor: "ui", ref: "STA-146", baseRevision: 7, note: "the flake" }],
      ["/api/queue/remove", { actor: "ui", ref: "STA-146", baseRevision: 8 }],
      ["/api/queue/prune", { actor: "ui", baseRevision: 10 }],
    ]);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });
});

describe("a stale base", () => {
  const envelope = {
    error: "The queue is at revision 8, not 7. Re-read the plan and retry.",
    message: "The queue is at revision 8, not 7. Re-read the plan and retry.",
    code: REVISION_CONFLICT_CODE,
    detail: { currentRevision: 8 },
    retryable: false,
  };

  it("is an ApiError carrying the store's code, message and current revision", async () => {
    stubFetch([{ status: 409, payload: envelope }]);
    const failure = await reorderQueue({ order: ["STA-66", "STA-31"], baseRevision: 7 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).code).toBe("revision_conflict");
    expect((failure as ApiError).message).toContain("at revision 8, not 7");
    expect((failure as ApiError).detail).toEqual({ currentRevision: 8 });
    expect(isRevisionConflict(failure)).toBe(true);
  });

  it("is told apart from every other refusal", async () => {
    stubFetch([{ status: 409, payload: { ...envelope, code: "validation", message: "WOR-12 belongs to another workspace" } }]);
    const failure = await enqueueTask({ ref: "WOR-12", baseRevision: 7 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(isRevisionConflict(failure)).toBe(false);
    expect(isRevisionConflict(new Error("revision_conflict"))).toBe(false);
  });

  /**
   * THE DELIBERATE RETRY, end to end: the first reorder is refused and writes nothing, the
   * page re-reads, and the retry goes out against the revision the store named — carrying
   * the human's intent and the entry the other writer added, which is `retryOrder`'s job.
   */
  it("is followed by a retry at the revision the server named, keeping the other writer's row", async () => {
    const server = { revision: 8, entries: [], effective: [] };
    const calls = stubFetch([
      { status: 409, payload: envelope },
      { status: 200, payload: { revision: 8, entries: [], effective: [] } },
      { status: 200, payload: { revision: 9, entries: [], effective: [] } },
    ]);

    const intended = ["STA-146", "STA-31", "STA-66"];
    const refused = await reorderQueue({ order: intended, baseRevision: 7 }).catch((error: unknown) => error);
    expect(isRevisionConflict(refused)).toBe(true);

    // The page re-reads: the plan is at 8 now, and somebody added STA-190.
    await getQueue();
    const current = ["STA-31", "STA-66", "STA-146", "STA-190"].map((identifier, i) =>
      entry({ identifier, planPosition: i + 1 }),
    );
    const retry = retryOrder(intended, current);
    expect(retry).toEqual(["STA-146", "STA-31", "STA-66", "STA-190"]);

    await reorderQueue({ order: retry!, baseRevision: server.revision });
    expect(calls.map((c) => c.url)).toEqual(["/api/queue/reorder", "/api/queue", "/api/queue/reorder"]);
    expect(calls[2]!.body).toEqual({
      actor: "ui",
      order: ["STA-146", "STA-31", "STA-66", "STA-190"],
      baseRevision: 8,
    });
  });
});
