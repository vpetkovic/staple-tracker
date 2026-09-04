/**
 * R3c (STA-173) — the milestone client and its CAS. Every membership write carries
 * `baseRevision`, and a 409 whose code is `revision_conflict` surfaces as an `ApiError`
 * the view can tell apart from a plain refusal. `fetch` is stubbed; nothing else is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMilestoneMember,
  ApiError,
  getMilestone,
  getMilestones,
  isRevisionConflict,
  removeMilestoneMember,
  reorderMilestoneMembers,
  REVISION_CONFLICT_CODE,
} from "./api";

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** A `fetch` that answers every call with `status` and `payload`, and remembers what it was asked. */
function stubFetch(status: number, payload: unknown): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => payload,
    } as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("milestone reads", () => {
  it("lists with the workspace and the resolved flag as the server spells them", async () => {
    const calls = stubFetch(200, []);
    await getMilestones({ ws: "staple", all: true });
    await getMilestones();
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/milestones?ws=staple&all=1"],
      ["GET", "/api/milestones"],
    ]);
  });

  it("fetches one milestone by ref", async () => {
    const calls = stubFetch(200, {});
    await getMilestone({ ref: "STA-190" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/milestone?ref=STA-190" });
  });
});

describe("milestone writes carry the CAS base", () => {
  it("reorder posts the whole order with baseRevision and the ui actor", async () => {
    const calls = stubFetch(200, { revision: 4 });
    const result = await reorderMilestoneMembers({
      ws: "staple",
      milestone: "STA-190",
      order: ["STA-68", "STA-66", "STA-146"],
      baseRevision: 3,
    });
    expect(result).toEqual({ revision: 4 });
    expect(calls[0]).toEqual({
      url: "/api/milestone/reorder",
      method: "POST",
      body: { actor: "ui", ws: "staple", milestone: "STA-190", order: ["STA-68", "STA-66", "STA-146"], baseRevision: 3 },
    });
  });

  it("add and remove name the milestone, the member and the base", async () => {
    const calls = stubFetch(200, {});
    await addMilestoneMember({ milestone: "STA-190", ref: "STA-146", baseRevision: 3, note: "the flake" });
    await removeMilestoneMember({ milestone: "STA-190", ref: "STA-146", baseRevision: 4 });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/milestone/add", { actor: "ui", milestone: "STA-190", ref: "STA-146", baseRevision: 3, note: "the flake" }],
      ["/api/milestone/remove", { actor: "ui", milestone: "STA-190", ref: "STA-146", baseRevision: 4 }],
    ]);
  });
});

describe("a stale base", () => {
  const envelope = {
    error: "STA-190 members are at revision 4, not 3. Re-read the milestone and retry.",
    message: "STA-190 members are at revision 4, not 3. Re-read the milestone and retry.",
    code: REVISION_CONFLICT_CODE,
    detail: { currentRevision: 4 },
    retryable: false,
  };

  it("is an ApiError carrying the store's code, message and current revision", async () => {
    stubFetch(409, envelope);
    const failure = await reorderMilestoneMembers({ milestone: "STA-190", order: ["STA-66"], baseRevision: 3 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).code).toBe("revision_conflict");
    expect((failure as ApiError).message).toContain("at revision 4, not 3");
    expect((failure as ApiError).detail).toEqual({ currentRevision: 4 });
    expect(isRevisionConflict(failure)).toBe(true);
  });

  it("is told apart from every other refusal", async () => {
    stubFetch(409, { ...envelope, code: "validation", message: "STA-66 is an epic, not a milestone" });
    const failure = await addMilestoneMember({ milestone: "STA-66", ref: "STA-1", baseRevision: 1 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(isRevisionConflict(failure)).toBe(false);
    expect(isRevisionConflict(new Error("revision_conflict"))).toBe(false);
  });
});
