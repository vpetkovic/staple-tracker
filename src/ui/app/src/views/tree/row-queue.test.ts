/**
 * The row menu in All workspaces queues into the row's OWN workspace (review item 9): it never
 * offers dead, greyed actions — it reads that workspace's plan and acts on it.
 */
import { describe, expect, it } from "vitest";
import { queueRowMenuState } from "@/components/QueueRowMenu";
import { row } from "@/components/task-list/fixtures";
import type { QueueView } from "@/lib/types";
import { rowQueueMenu } from "./row-queue";

const plan = (revision: number, identifiers: string[]) =>
  ({ revision, entries: identifiers.map((identifier) => ({ identifier })), effective: [] }) as unknown as QueueView;

describe("rowQueueMenu", () => {
  it("builds on the row's workspace plan once it is read: its revision, and whether the row is in it", () => {
    const menu = rowQueueMenu({ kind: "ready", view: plan(7, ["MAR-2"]) }, "marketing-site");
    expect(menu.revision).toBe(7);
    expect(menu.reason).toBeUndefined();
    expect(queueRowMenuState(row({ identifier: "MAR-2" }), menu.planIds).queued).toBe(true);
    expect(queueRowMenuState(row({ identifier: "MAR-3" }), menu.planIds).queued).toBe(false);
  });

  it("offers nothing to build on while the plan is being read, and says so in words", () => {
    for (const entry of [undefined, { kind: "loading" as const }]) {
      const menu = rowQueueMenu(entry, "marketing-site");
      expect(menu.revision).toBeNull();
      expect(menu.reason).toBe("Reading the marketing-site queue…");
    }
  });

  it("names the failure when the plan cannot be read", () => {
    const menu = rowQueueMenu({ kind: "failed", refusal: { message: "database is locked" } as never }, "staple");
    expect(menu.revision).toBeNull();
    expect(menu.reason).toBe("Could not read the staple queue: database is locked");
  });
});
