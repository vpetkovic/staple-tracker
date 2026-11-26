/**
 * The Inbox's one read, narrowed to the page's workspace (lib/attention.ts).
 */
import { describe, expect, it } from "vitest";
import { scopeAttention } from "./attention";
import type { AttentionList, AttentionRow } from "./types";

const row = (workspace: string, id: string) => ({ key: `${workspace}/gate_pending/${id}`, workspace }) as AttentionRow;
const all: AttentionList = {
  rows: [row("app", "APP-1"), row("web", "WEB-1"), row("app", "APP-2")],
  workspaces: ["app", "web", "gone"],
  failed: [{ workspace: "gone", message: "no database" }],
  now: "2026-11-26T18:00:00.000Z",
};

describe("scopeAttention", () => {
  it("is the whole read on All workspaces, with nothing elsewhere", () => {
    expect(scopeAttention(all, "")).toEqual({ list: all, elsewhere: 0 });
  });

  it("narrows to one workspace's rows, workspaces and failures, and counts what waits elsewhere", () => {
    const { list, elsewhere } = scopeAttention(all, "app");
    expect(list.rows.map((entry) => entry.key)).toEqual(["app/gate_pending/APP-1", "app/gate_pending/APP-2"]);
    expect(list.workspaces).toEqual(["app"]);
    expect(list.failed).toEqual([]);
    expect(elsewhere).toBe(1);
    expect(scopeAttention(all, "gone").list.failed).toEqual(all.failed);
  });
});
