/**
 * `milestone show` names its next ticket with the number it actually has: the ticket's
 * position in the pickup queue. That number is not a member position (the next ticket
 * may sit under an epic member and have none), so the text must not call it one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MilestoneView } from "../src/core/milestone-store.js";
import { CONTRACT_AGENT, runCliAsync, type CliResult } from "./fixtures/contract-support.js";

const WS = "nextlabel";
let home: string;

async function cli(...args: string[]): Promise<CliResult> {
  const result = await runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

async function json<T>(...args: string[]): Promise<T> {
  return JSON.parse((await cli(...args, "--json")).stdout) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-next-label-"));
  expect((await runCliAsync(["init", "--no-planning", "--global", WS], { STAPLE_HOME: home })).status).toBe(0);
  await cli("kinds", "add", "milestone", "--label", "Milestone");
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("milestone show: the next line", () => {
  it("labels the number as the queue position, not a member position", { timeout: 60_000 }, async () => {
    // Outside work queues first, so the milestone's only member (member 1) is queue position 2.
    await json("new", "Outside work");
    const inside = (await json<{ identifier: string }>("new", "Inside work")).identifier;
    const milestone = (await json<{ milestone: { identifier: string } }>("milestone", "new", "Beta")).milestone.identifier;
    await cli("milestone", "add", milestone, inside);

    const view = await json<MilestoneView>("milestone", "show", milestone);
    expect(view.members.map((member) => [member.identifier, member.position])).toEqual([[inside, 1]]);
    expect(view.next).toEqual({ identifier: inside, position: 2 });

    const text = (await cli("milestone", "show", milestone)).stdout;
    expect(text).toContain(`next     ${inside} (queue position 2)`);
    expect(text).not.toContain("(member ");
  });
});
