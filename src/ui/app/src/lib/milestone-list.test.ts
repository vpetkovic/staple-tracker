/**
 * The filter menu's milestones on All workspaces come from EVERY workspace, each row tagged
 * with the workspace it lives in — never the server's first workspace alone (lib/milestone-list.ts).
 */
import { describe, expect, it } from "vitest";
import { AuthError } from "./api";
import { readMilestoneList, type ReadMilestones } from "./milestone-list";
import type { MilestoneListRow } from "./types";

const row = (identifier: string): MilestoneListRow =>
  ({ milestone: { identifier, title: `Milestone ${identifier}` }, memberCount: 1 }) as unknown as MilestoneListRow;

/** A reader holding each workspace's milestones, remembering what it was asked. */
function reader(byWs: Record<string, MilestoneListRow[] | Error>): { read: ReadMilestones; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: async ({ ws }) => {
      asked.push(ws);
      const answer = byWs[ws];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
  };
}

const HUB = { booted: true, allWorkspaces: true, ws: "", workspaces: ["alpha", "beta", "gamma"], showDone: false };

describe("readMilestoneList", () => {
  it("on All workspaces asks every workspace and keeps each row's own workspace", async () => {
    const { read, asked } = reader({ alpha: [row("ALP-1")], beta: [row("BET-7"), row("BET-9")], gamma: [] });
    const list = await readMilestoneList(HUB, read);
    expect(asked).toEqual(["alpha", "beta", "gamma"]);
    expect(list.map((entry) => `${entry.ws}:${entry.row.milestone.identifier}`)).toEqual([
      "alpha:ALP-1",
      "beta:BET-7",
      "beta:BET-9",
    ]);
  });

  it("never answers All workspaces with the first workspace alone (nor with a ws-less read)", async () => {
    const { read, asked } = reader({ "": [row("ALP-1")], alpha: [row("ALP-1")], beta: [row("BET-7")] });
    const list = await readMilestoneList({ ...HUB, workspaces: ["alpha", "beta"] }, read);
    expect(asked).not.toContain("");
    expect(list.some((entry) => entry.ws === "beta")).toBe(true);
  });

  it("a workspace that cannot answer contributes nothing; the others still do", async () => {
    const { read } = reader({ alpha: new Error("no milestone kind"), beta: [row("BET-7")] });
    const list = await readMilestoneList({ ...HUB, workspaces: ["alpha", "beta"] }, read);
    expect(list.map((entry) => entry.ws)).toEqual(["beta"]);
  });

  it("an auth failure still fails the read, so the token screen can take over", async () => {
    const { read } = reader({ alpha: new AuthError(401, "unauthorized", "token rejected"), beta: [] });
    await expect(readMilestoneList({ ...HUB, workspaces: ["alpha", "beta"] }, read)).rejects.toBeInstanceOf(AuthError);
  });

  it("one workspace reads that workspace only", async () => {
    const { read, asked } = reader({ beta: [row("BET-7")] });
    const list = await readMilestoneList({ ...HUB, allWorkspaces: false, ws: "beta" }, read);
    expect(asked).toEqual(["beta"]);
    expect(list).toEqual([{ ws: "beta", row: row("BET-7") }]);
  });

  it("asks nothing before bootstrap, when \"\" might mean All workspaces or nothing yet", async () => {
    const { read, asked } = reader({ alpha: [row("ALP-1")] });
    expect(await readMilestoneList({ ...HUB, booted: false }, read)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
