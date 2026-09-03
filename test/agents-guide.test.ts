/**
 * C2 — the working protocol `staple init` teaches.
 *
 * `AGENTS.md` beside the workspace database (`.staple/AGENTS.md` since A5, and
 * `.tasks/AGENTS.md` before it) is the only onboarding surface a cold harness is
 * guaranteed to find, so what is pinned here is (a) that every rule the epic
 * depends on is actually IN the text — a guide that quietly loses the identity
 * rule or the "never automatic" rule is worse than no guide — and (b) that init
 * writes it exactly once and never again over an operator's edits.
 *
 * All three surfaces are covered: core initWorkspace(), the CLI, and the MCP
 * `init` tool, because the ticket's promise is that they behave the same.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderAgentsGuide, writeAgentsGuide } from "../src/core/agents-template.js";
import { initWorkspace, stapleHome } from "../src/core/workspace.js";
import { CLI_ENTRY, TSX_CLI, cleanEnv, startMcpClient, toolPayload } from "./fixtures/contract-support.js";

let home: string;
const tempRoots: string[] = [];

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-guide-${label}-`));
  tempRoots.push(dir);
  return dir;
}

/** The CLI in a chosen cwd — repo-local init has no --dir, it uses process.cwd(). */
function cliIn(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd,
    env: cleanEnv({ STAPLE_HOME: home }),
    encoding: "utf8",
  });
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-guide-home-"));
  tempRoots.push(home);
  process.env.STAPLE_HOME = home;
});

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  delete process.env.STAPLE_HOME;
});

// ------------------------------------------------------------- the content

describe("the guide teaches the whole protocol", () => {
  const guide = renderAgentsGuide({ slug: "demo", prefix: "DEM" });

  it("names this workspace, so a cold reader knows which identifiers are theirs", () => {
    expect(guide).toContain("`demo`");
    expect(guide).toContain("DEM-1");
    // Examples use the workspace's own prefix rather than a foreign one.
    expect(guide).toContain("staple checkout DEM-42");
  });

  it("teaches the loop, including that a conflict means pick another task", () => {
    for (const step of ["staple inbox", "staple checkout", "plan", "staple comment", "staple done", "staple events"]) {
      expect(guide, step).toContain(step);
    }
    expect(guide).toMatch(/conflict means pick a different task/i);
    expect(guide).toMatch(/never retry the same one/i);
    expect(guide).toMatch(/blockers_resolved/);
  });

  /**
   * STA-153. An agent that believes it must close an epic by hand will either
   * forget (the bug) or "fix" an epic the tracker already closed. What is pinned
   * is the fact (parents follow their children), the thing the automatic close
   * CANNOT do (write the summary), and the escape hatch, so nobody reads
   * "automatic" as "you may not touch it".
   */
  it("teaches that parents close themselves, and what is still owed", () => {
    expect(guide).toMatch(/epic's status follows its children/i);
    expect(guide).toMatch(/never have to remember to close\s+one/i);
    expect(guide).toMatch(/last open child of a parent lands, the parent goes \`done\`/i);
    expect(guide).toMatch(/cancelled` only if every child was cancelled/i);
    expect(guide).toMatch(/no children.{0,40}untouched/is);
    // The summary is the part a close cannot write for you.
    expect(guide).toMatch(/write the summary/i);
    expect(guide).toContain("children_complete");
    // And closing one by hand is still allowed, and still wins afterwards.
    expect(guide).toMatch(/still allowed/i);
    expect(guide).toMatch(/idempotent/i);
    expect(guide).toMatch(/outranks/i);
  });

  it("teaches the identity rule and why a mismatch reads as idle", () => {
    expect(guide).toContain("STAPLE_AGENT");
    expect(guide).toMatch(/same value you claimed with for the entire session/i);
    // The consequence, not just the instruction — this is the bit that bit us.
    expect(guide).toMatch(/does not count as your activity/i);
    expect(guide).toMatch(/stealable/i);
  });

  it("teaches the worklog protocol with its three sections and SHAs", () => {
    expect(guide).toContain("worklog");
    expect(guide).toContain("## Done");
    expect(guide).toContain("## Next");
    expect(guide).toContain("## Files touched");
    expect(guide).toMatch(/revise it at every\s+milestone/i);
    expect(guide).toMatch(/commit SHAs/i);
    // The reason, which is what makes an agent actually do it.
    expect(guide).toMatch(/written at the end never survives a kill/i);
  });

  /**
   * STA-140. The guide is the only onboarding surface a cold harness is
   * guaranteed to find, and the single most expensive thing it can get wrong now
   * is assuming the seven statuses it saw in some other repo. What is pinned is
   * the instruction to LOOK (`staple statuses ls`), the rule that explains why
   * looking is enough (behaviour is the category's, not the id's), and the rule
   * that stops an agent reordering a human's board on its own initiative.
   */
  it("teaches that the vocabulary is per-workspace and must be read, not assumed", () => {
    expect(guide).toContain("staple statuses ls");
    expect(guide).toContain("staple kinds ls");
    expect(guide).toMatch(/configured per workspace/i);
    expect(guide).toMatch(/do not assume/i);
    // The category set, in full — an agent that knows it can reason about a
    // status nobody has told it about.
    for (const category of ["unstarted", "ready", "active", "review", "gated", "blocked", "cancelled"]) {
      expect(guide, category).toContain(category);
    }
    expect(guide).toMatch(/keys off the category, never off the id/i);
    // The edit surface, including the guard that makes removal safe.
    expect(guide).toContain("staple statuses add");
    expect(guide).toContain("staple statuses reorder");
    expect(guide).toContain("--migrate-to");
    // …and that editing it is a human's decision, like a steal is.
    expect(guide).toMatch(/only when a human asks/i);
    // The MCP half mirrors the CLI half, named so an agent with no shell can act.
    // STA-124: the guide has to teach DECLARING a kind, not just reading the
    // vocabulary — an agent that never passes --kind files everything as `task`
    // and the epic/bug distinction never gets made in the first place.
    expect(guide).toContain("staple new \"Login 500s on retry\" --kind bug");
    expect(guide).toContain("staple ls --kind epic");
    expect(guide).toMatch(/declared, never derived/i);
    expect(guide).toMatch(/default is `task`/i);
    for (const tool of ["list_statuses", "list_kinds", "update_statuses", "update_kinds"]) {
      expect(guide, tool).toContain(tool);
    }
  });

  it("teaches the branch pointer at checkout", () => {
    expect(guide).toContain("Branch pointer");
    expect(guide).toMatch(/at checkout, comment where the\s+physical work lives/i);
    expect(guide).toMatch(/worktree/i);
  });

  it("teaches the inbox QUEUED bucket and that a gated checkout is not retryable", () => {
    // The bucket is not BLOCKED, and the distinction is the whole point: one
    // waits on work, the other waits on a person.
    expect(guide).toContain("**QUEUED**");
    expect(guide).toMatch(/means something different\s+from BLOCKED/i);
    expect(guide).toContain("awaiting_approval");
    expect(guide).toContain("exit code 9");
    expect(guide).toContain("`gated`");
    // The three non-remedies, named, because each one is a thing an agent tries.
    expect(guide).toMatch(/will not clear by retrying, by waiting, or by\s+.--steal-if-stale/i);
  });

  it("teaches the gate step: park the work on a human, do not sit on the claim", () => {
    expect(guide).toContain("Approval gates");
    // Every verb rendered with THIS workspace's prefix, copy-pasteable as printed.
    for (const invocation of [
      "staple gate DEM-42 --owner VP",
      "staple approve DEM-42",
      "staple approve DEM-42 --children DEM-43,DEM-44",
      "staple request-changes DEM-42 -m",
    ]) {
      expect(guide, invocation).toContain(invocation);
    }
    // The instruction that replaces the STA-108 failure mode.
    expect(guide).toMatch(/how a design-first ticket ends\. Not with a held claim/i);
    expect(guide).toMatch(/looks stealable to the next agent/i);
    // A gate is refused on a leaf, and the refusal has a destination.
    expect(guide).toContain("staple status DEM-42 in_review");
    expect(guide).toMatch(/a gate with nobody to chase never opens/i);
    // The half everyone gets wrong: request-changes frees the parent only. STA-154
    // states it as the one sentence the CLI help, the MCP description and the web
    // UI's "Send back" button all carry, so the guide is pinned to that wording.
    expect(guide).toMatch(/keeps the queued children\s+parked until somebody approves/i);
    expect(guide).toMatch(/nobody is re-checked-out/i);
    // STA-154 eligibility: what a gate does NOT hold is as load-bearing as what it does.
    expect(guide).toMatch(/only open work is queued/i);
    expect(guide).toMatch(/nothing open left underneath it/i);
    // And the way back in.
    expect(guide).toMatch(/re-gating is how you resubmit/i);
    expect(guide).toContain("changes_requested");
  });

  it("describes claim liveness exactly as the surfaces report it", () => {
    expect(guide).toContain("held 2h · silent 45m");
    for (const field of ["heldBy", "lastActivityAt", "heldSeconds", "idleSeconds"]) {
      expect(guide, field).toContain(field);
    }
  });

  it("presents steal/release as explicit affordances, never as policy", () => {
    expect(guide).toContain("--steal-if-stale");
    expect(guide).toContain("--if-stale");
    expect(guide).toContain("claim_stolen");
    expect(guide).toContain("claim_released_stale");
    expect(guide).toMatch(/only when a human says "continue\."/i);
    expect(guide).toMatch(/no sweeper, no daemon, no TTL/i);
    expect(guide).toMatch(/blockers still win/i);
    // And that an ordinary refusal is not an invitation to escalate.
    expect(guide).toMatch(/plain checkout of a stale claim is still refused/i);
  });

  it("carries a copy-pasteable MCP wiring line pointing at a real entry point", () => {
    const line = guide.split("\n").find((l) => l.includes("claude mcp add staple"));
    expect(line, "wiring one-liner").toBeTruthy();
    expect(line).toContain("STAPLE_AGENT=");
    const entry = line?.match(/npx tsx (\S+)/)?.[1];
    expect(entry, "resolved mcp entry").toBeTruthy();
    expect(existsSync(entry as string), `${entry} should exist`).toBe(true);
  });

  it("tells the reader their edits are safe", () => {
    expect(guide).toMatch(/will not\s+overwrite your changes/i);
  });
});

// ------------------------------------------------------------- never clobber

describe("writeAgentsGuide", () => {
  it("writes once and reports it", () => {
    const dir = scratch("write");
    const result = writeAgentsGuide(dir, { slug: "demo", prefix: "DEM" });
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(dir, "AGENTS.md"));
    expect(readFileSync(result.path, "utf8")).toContain("Working this repo with staple");
  });

  it("keeps an existing file byte for byte", () => {
    const dir = scratch("keep");
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "# mine\n");
    const result = writeAgentsGuide(dir, { slug: "demo", prefix: "DEM" });
    expect(result.written).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# mine\n");
  });
});

// --------------------------------------------------------------- init: core

describe("initWorkspace", () => {
  it("drops the guide beside a repo workspace's db", () => {
    const dir = scratch("repo");
    const ws = initWorkspace({ dir });
    ws.store.db.close();

    expect(ws.guidePath).toBe(join(dir, ".staple", "AGENTS.md"));
    expect(ws.guideWritten).toBe(true);
    const body = readFileSync(ws.guidePath as string, "utf8");
    // Rendered with THIS workspace's identity, not a placeholder.
    expect(body).toContain(`\`${ws.store.slug}\``);
    expect(body).toContain(`${ws.store.prefix}-1`);
  });

  it("re-init preserves an edited guide and says so", () => {
    const dir = scratch("reinit");
    const first = initWorkspace({ dir });
    first.store.db.close();
    const path = first.guidePath as string;

    const edited = `${readFileSync(path, "utf8")}\n## House rules\nRun \`make check\` before done.\n`;
    writeFileSync(path, edited);

    const second = initWorkspace({ dir });
    second.store.db.close();
    expect(second.created).toBe(false);
    expect(second.guidePath).toBe(path);
    expect(second.guideWritten).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("writes no guide for a global workspace", () => {
    const ws = initWorkspace({ global: true, slug: "guide-global" });
    ws.store.db.close();
    expect(ws.guidePath).toBeNull();
    expect(ws.guideWritten).toBe(false);
    expect(existsSync(join(stapleHome(), "workspaces", "AGENTS.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------- init: CLI

describe("staple init (CLI)", () => {
  it("writes the guide and points at it", () => {
    const dir = scratch("cli");
    const result = cliIn(dir, "init");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(join(dir, ".staple", "AGENTS.md"));
    expect(result.stdout).toMatch(/Wrote the agent protocol guide/);
    expect(existsSync(join(dir, ".staple", "AGENTS.md"))).toBe(true);
  });

  it("says it kept an existing guide instead of silently skipping", () => {
    const dir = scratch("cli-reinit");
    expect(cliIn(dir, "init").status).toBe(0);
    writeFileSync(join(dir, ".staple", "AGENTS.md"), "# mine\n");

    const again = cliIn(dir, "init");
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/Kept the existing/);
    expect(again.stdout).not.toMatch(/Wrote the agent protocol guide/);
    expect(readFileSync(join(dir, ".staple", "AGENTS.md"), "utf8")).toBe("# mine\n");
  });

  it("explains the absence for a global workspace", () => {
    const dir = scratch("cli-global");
    const result = cliIn(dir, "init", "--global", "guide-cli-global");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no AGENTS\.md guide/);
    expect(existsSync(join(dir, ".staple"))).toBe(false);
  });
});

// ---------------------------------------------------------------- init: MCP

describe("init tool (MCP) matches the CLI", () => {
  it("writes the guide, reports the path, and keeps it on re-init", async () => {
    const repo = scratch("mcp");
    const cwd = scratch("mcp-cwd");
    const harness = await startMcpClient({ home, cwd, agent: "guide-agent" });
    try {
      const first = toolPayload(await harness.call("init", { dir: repo })) as Record<string, unknown>;
      expect(first.guidePath).toBe(join(repo, ".staple", "AGENTS.md"));
      expect(first.guideWritten).toBe(true);
      expect(readFileSync(first.guidePath as string, "utf8")).toContain("The worklog protocol");

      writeFileSync(first.guidePath as string, "# mine\n");
      const second = toolPayload(await harness.call("init", { dir: repo })) as Record<string, unknown>;
      expect(second.guideWritten).toBe(false);
      expect(second.guidePath).toBe(first.guidePath);
      expect(readFileSync(first.guidePath as string, "utf8")).toBe("# mine\n");

      // Global stays guide-less on this surface too.
      const global = toolPayload(
        await harness.call("init", { global: true, slug: "guide-mcp-global" }),
      ) as Record<string, unknown>;
      expect(global.guidePath).toBeNull();
      expect(global.guideWritten).toBe(false);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
