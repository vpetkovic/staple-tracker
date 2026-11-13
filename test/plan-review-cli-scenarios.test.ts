/**
 * From the review: two CLI scenarios, step for step as the reviewer ran them.
 *
 * 1. Cancelling the only work on a horizon must not cancel the horizon, so the column stays.
 * 2. Removing a horizon that holds work (a promoted idea's epic and a hand-placed task) and is
 *    queued must be refused, naming what to move, and must change nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_AGENT, runCli } from "./fixtures/contract-support.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(slug: string): (...args: string[]) => { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "staple-review-home-"));
  const dir = mkdtempSync(join(tmpdir(), "staple-review-ws-"));
  made.push(home, dir);
  const env = { STAPLE_HOME: home, HOME: home, STAPLE_AGENT: CONTRACT_AGENT };
  expect(runCli(["init", "--yes", "--slug", slug, "--dir", dir], env).status).toBe(0);
  const db = join(dir, ".staple", "staple.db");
  return (...args: string[]) => runCli(args[0] === "config" ? args : [...args, "--db", db], env);
}

const json = (result: { status: number; stdout: string; stderr: string }): any => {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

describe("scenario 1: cancelling a horizon's only work", () => {
  it("keeps the horizon a column, not cancelled, holding the work", () => {
    const st = workspace("wsa");
    expect(st("config", "set", "humanName", "VP").status).toBe(0);
    expect(st("plan", "enable", "--person").status).toBe(0);
    const id = json(st("idea", "new", "Horizon probe", "--json")).idea.id as string;
    // Shaping needs a plan that passes the gate: a goal, a task with acceptance, acceptance criteria.
    expect(st("idea", "plan", id, "--goal", "Probe the horizon", "--acceptance", "It behaves as described").status).toBe(0);
    expect(st("idea", "task", id, "add", "1", "Probe it", "--acceptance", "Observed").status).toBe(0);
    expect(st("idea", "set", id, "--maturity", "shaped", "--horizon", "WSA-1", "--person").status).toBe(0);
    expect(st("idea", "promote", id, "--person", "--json").status).toBe(0);
    const epic = json(st("idea", "show", id, "--json")).idea.identifier as string;
    expect(epic).toMatch(/^WSA-\d+$/);

    const cancelled = st("status", epic, "cancelled");
    expect(cancelled.status, cancelled.stderr).toBe(0);
    const plan = json(st("plan", "show", "--json"));
    expect(plan.horizons.map((h: { identifier: string }) => h.identifier)).toContain("WSA-1");
    const now = json(st("show", "WSA-1", "--json")).issue;
    expect(now.status).not.toBe("cancelled");
    const milestone = json(st("milestone", "show", "WSA-1", "--json"));
    expect(JSON.stringify(milestone)).toContain(epic);
  });
});

describe("scenario 2: removing a horizon that holds work and is queued", () => {
  it("is refused, names what to move, and changes nothing", () => {
    const st = workspace("wsb");
    expect(st("config", "set", "humanName", "VP").status).toBe(0);
    expect(st("plan", "enable", "--person").status).toBe(0);
    const id = json(st("idea", "new", "Promoted on Now", "--json")).idea.id as string;
    // Shaping needs a plan that passes the gate: a goal, a task with acceptance, acceptance criteria.
    expect(st("idea", "plan", id, "--goal", "Probe the horizon", "--acceptance", "It behaves as described").status).toBe(0);
    expect(st("idea", "task", id, "add", "1", "Probe it", "--acceptance", "Observed").status).toBe(0);
    expect(st("idea", "set", id, "--maturity", "shaped", "--horizon", "WSB-1", "--person").status).toBe(0);
    expect(st("idea", "promote", id, "--person").status).toBe(0);
    const epic = json(st("idea", "show", id, "--json")).idea.identifier as string;
    const task = json(st("new", "Hand placed task", "--json")).identifier as string;
    expect(st("milestone", "add", "WSB-1", task).status).toBe(0);
    expect(st("queue", "add", "WSB-1").status).toBe(0);

    const queued = st("horizon", "rm", "WSB-1", "--person");
    expect(queued.status).not.toBe(0);
    expect(queued.stderr).toContain("staple queue rm WSB-1");
    expect(st("queue", "rm", "WSB-1").status).toBe(0);

    const holding = st("horizon", "rm", "WSB-1", "--person");
    expect(holding.status).not.toBe(0);
    expect(holding.stderr).toContain(epic);
    expect(holding.stderr).toContain(`staple milestone rm WSB-1 ${task}`);

    // Nothing moved: the horizon is open and listed, the epic still on it, the task still in it.
    expect(json(st("show", "WSB-1", "--json")).issue.status).not.toBe("cancelled");
    expect(json(st("plan", "show", "--json")).horizons.map((h: { identifier: string }) => h.identifier)).toContain("WSB-1");
    expect(json(st("idea", "show", id, "--json")).idea.horizonId).not.toBeNull();
    expect(JSON.stringify(json(st("milestone", "show", "WSB-1", "--json")))).toContain(task);
  });
});
