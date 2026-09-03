import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTRACT_AGENT,
  cliEnvelope,
  mcpEnvelope,
  runCli,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { ERROR_CONTRACT, CLI_EXIT_CODES, tripleOf } from "./fixtures/error-contract.js";

/**
 * STA-143 — the gate verbs across the CLI and MCP.
 *
 * `store-gates.test.ts` pins the semantics against the store. This pins the two
 * agent-facing SURFACES: that both expose all three verbs, that they agree with
 * each other and with the canonical error contract, and — the assertion this
 * file exists for — that a queued issue is refused with the SAME triple on both,
 * because an agent that gets a different answer from the CLI than from MCP will
 * eventually act on the wrong one.
 */

let home: string;
let workspace: string;
let harness: McpHarness;
const WS = "gates";

function cli(...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT, USER: CONTRACT_AGENT });
}

function json(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** A fresh epic with two children, in the shared workspace. Returns their refs. */
function freshEpic(title: string): { epic: string; a: string; b: string } {
  const epic = json(cli("new", title, "--ws", WS, "--json")).identifier as string;
  const a = json(cli("new", `${title} A`, "--parent", epic, "--ws", WS, "--json"))
    .identifier as string;
  const b = json(cli("new", `${title} B`, "--parent", epic, "--ws", WS, "--json"))
    .identifier as string;
  return { epic, a, b };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-gates-home-"));
  workspace = mkdtempSync(join(tmpdir(), "staple-gates-cwd-"));
  expect(cli("init", "--global", WS, "--json").status).toBe(0);
  harness = await startMcpClient({ home, cwd: workspace, agent: CONTRACT_AGENT });
});

afterAll(async () => {
  await harness?.close();
  for (const dir of [home, workspace]) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ CLI

describe("the CLI gate verbs", () => {
  it("gate parks the parent and says who it is waiting on", () => {
    const { epic } = freshEpic("CLI gate");
    const result = cli("gate", epic, "--owner", "VP", "-m", "please read", "--ws", WS);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("awaiting_approval");
    expect(result.stdout).toContain("[awaiting VP]");
  });

  it("marks the gated parent and the queued children in `ls`", () => {
    const { epic, a } = freshEpic("CLI ls");
    cli("gate", epic, "--owner", "VP", "--ws", WS);
    const out = cli("ls", "--ws", WS).stdout;

    // Matched on the IDENTIFIER COLUMN, not on `includes`: a queued child's line
    // mentions its gate's identifier in the cue, so a substring search finds the
    // wrong row — which is the sort of thing that makes a green test lie.
    const rowFor = (ref: string) =>
      out.split("\n").find((l) => l.trim().split(/\s+/)[1] === ref)!;
    const parentLine = rowFor(epic);
    const childLine = rowFor(a);
    expect(parentLine).toContain("[awaiting VP]");
    // The child says both halves: behind WHAT, awaiting WHOM. Either alone
    // leaves the reader with another lookup to do.
    expect(childLine).toContain(`[queued: ${epic}/VP]`);
  });

  it("prints a gate line and a queued line in `show`", () => {
    const { epic, a } = freshEpic("CLI show");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    expect(cli("show", epic, "--ws", WS).stdout).toContain("gate:  awaiting VP");
    const child = cli("show", a, "--ws", WS).stdout;
    expect(child).toContain(`queued: behind ${epic}`);
    expect(child).toContain("checkout is refused");
  });

  it("prints QUEUED between READY and BLOCKED in `inbox`", () => {
    const { epic, a } = freshEpic("CLI inbox");
    cli("gate", epic, "--owner", "VP", "--ws", WS);
    const out = cli("inbox", "--ws", WS).stdout;

    const readyAt = out.indexOf("READY (pickup order):");
    const queuedAt = out.indexOf("QUEUED (waiting on a human");
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(queuedAt).toBeGreaterThan(readyAt);
    expect(out).toContain(`awaiting VP on ${epic}`);
    /**
     * The parked parent leads its own queue, saying who it waits on.
     *
     * It is the only row in the section a human can act on, so it goes first —
     * a CLI presentation choice, not the store's order, which keeps the
     * ordinary pickup rank for its MCP and HTTP consumers.
     */
    const queuedLines = out
      .slice(queuedAt)
      .split("\n")
      .slice(1)
      .filter((l) => l.trim().length > 0 && !l.startsWith("BLOCKED"));
    const rowAt = (ref: string) =>
      queuedLines.findIndex((l) => l.trim().split(/\s+/)[1] === ref);
    // Relative, not absolute: this workspace is shared by the whole file and
    // accumulates other gates, so the claim is that THIS gate leads ITS queue —
    // not that it leads the section.
    expect(rowAt(epic)).toBeGreaterThanOrEqual(0);
    expect(rowAt(epic)).toBeLessThan(rowAt(a));
    expect(queuedLines[rowAt(epic)]).toContain("awaiting VP");
    // …and neither is in READY.
    const readySection = out.slice(readyAt, queuedAt);
    expect(readySection).not.toContain(a);
    expect(readySection).not.toContain(epic);
  });

  it("refuses checkout of a queued child with exit 9 and a sentence naming both", () => {
    const { epic, a } = freshEpic("CLI checkout");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const refused = cli("checkout", a, "--ws", WS);
    expect(refused.status).toBe(CLI_EXIT_CODES.gated);
    expect(refused.stderr).toContain("error(gated):");
    expect(refused.stderr).toContain(epic);
    expect(refused.stderr).toContain("VP");
    // Prose on the bare surface, JSON only when asked — the rule every other
    // command on this CLI follows.
    expect(() => JSON.parse(refused.stderr)).toThrow();
  });

  it("projects the canonical `gated` triple in --json", () => {
    const { epic, a } = freshEpic("CLI gated triple");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const refused = cli("checkout", a, "--ws", WS, "--json");
    expect(tripleOf(cliEnvelope(refused))).toEqual(
      ERROR_CONTRACT.checkoutGated(epic, "VP", "backlog"),
    );
  });

  it("--steal-if-stale does not open the gate", () => {
    const { epic, a } = freshEpic("CLI steal");
    cli("gate", epic, "--owner", "VP", "--ws", WS);
    const refused = cli("checkout", a, "--steal-if-stale", "0s", "--ws", WS, "--json");
    expect(cliEnvelope(refused).code).toBe("gated");
  });

  it("approve --children releases only what it names", () => {
    const { epic, a, b } = freshEpic("CLI partial");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const approved = cli("approve", epic, "--children", a, "--ws", WS);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain(`released ${a}`);
    expect(approved.stdout).toContain("still awaiting VP");

    expect(cli("checkout", a, "--ws", WS).status).toBe(0);
    expect(cli("checkout", b, "--ws", WS).status).toBe(CLI_EXIT_CODES.gated);
  });

  it("approve with no --children drains the whole queue", () => {
    const { epic, a, b } = freshEpic("CLI approve all");
    cli("gate", epic, "--owner", "VP", "--ws", WS);
    expect(cli("approve", epic, "--ws", WS).stdout).toContain("[gate approved]");

    for (const child of [a, b]) {
      expect(cli("show", child, "--ws", WS).stdout).not.toContain("queued: behind");
    }
    expect(cli("show", epic, "--ws", WS).stdout).toContain("gate:  VP · approved by");
  });

  it("request-changes needs a message and says what stays queued", () => {
    const { epic, a } = freshEpic("CLI changes");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const bare = cli("request-changes", epic, "--ws", WS, "--json");
    expect(bare.status).toBe(CLI_EXIT_CODES.validation);

    const sent = cli("request-changes", epic, "-m", "split the migration out", "--ws", WS);
    expect(sent.stdout).toContain("todo");
    expect(sent.stdout).toContain("children stay queued");
    // And they really do: the surprising half is the one the sentence promises.
    expect(cli("checkout", a, "--ws", WS).status).toBe(CLI_EXIT_CODES.gated);
  });

  it("`wait` does not call a queued issue ready", () => {
    const { epic, a } = freshEpic("CLI wait");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const waited = cli("wait", a, "--timeout", "1", "--interval", "50", "--ws", WS, "--json");
    expect(waited.status).toBe(CLI_EXIT_CODES.timeout);
    const envelope = cliEnvelope(waited);
    expect(envelope.code).toBe("timeout");
    // Naming the gate is the difference between a useful timeout and a mystery.
    expect(String(envelope.message)).toContain(epic);
    expect((envelope.detail as { queuedBy: unknown }).queuedBy).toEqual({
      identifier: epic,
      owner: "VP",
    });
  });

  it("refuses to move a parked parent with `status`, and names the way out", () => {
    const { epic } = freshEpic("CLI status guard");
    cli("gate", epic, "--owner", "VP", "--ws", WS);

    const refused = cli("status", epic, "todo", "--ws", WS, "--json");
    expect(refused.status).toBe(CLI_EXIT_CODES.validation);
    expect(String(cliEnvelope(refused).message)).toContain("staple approve");
  });
});

// ------------------------------------------------------------------ MCP

describe("the MCP gate tools", () => {
  const structured = (result: { structuredContent?: unknown }) =>
    result.structuredContent as Record<string, unknown>;

  it("gate_task returns the parked issue with its gate", async () => {
    const { epic } = freshEpic("MCP gate");
    const result = await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    expect(result.isError).toBeFalsy();
    const body = structured(result);
    expect(body.status).toBe("awaiting_approval");
    expect(body.gate).toMatchObject({ state: "pending", owner: "VP", requestedBy: CONTRACT_AGENT });
    // The text block and the structured content are the same payload, as on
    // every other tool on this server.
    expect(toolPayload(result)).toBeTruthy();
  });

  it("puts the whole gated set in the inbox `queued` bucket, never `ready`", async () => {
    const { epic, a } = freshEpic("MCP inbox");
    await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    const body = structured(await harness.call("inbox", { limit: 200, ws: WS }));
    const queued = body.queued as Array<Record<string, unknown>>;
    const ready = body.ready as Array<Record<string, unknown>>;
    const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.identifier);

    expect(ids(queued)).toEqual(expect.arrayContaining([epic, a]));
    expect(ids(ready)).not.toContain(a);
    expect(ids(ready)).not.toContain(epic);

    const child = queued.find((r) => r.identifier === a)!;
    expect(child.queuedBy).toEqual({ identifier: epic, owner: "VP" });
    const parent = queued.find((r) => r.identifier === epic)!;
    expect(parent.queuedBy).toBeNull();
    expect(parent.gate).toMatchObject({ state: "pending", owner: "VP" });
  });

  it("carries the gate pair on list_tasks and get_task", async () => {
    const { epic, a } = freshEpic("MCP reads");
    await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    const list = structured(await harness.call("list_tasks", { limit: 200, ws: WS }));
    const row = (list.items as Array<Record<string, unknown>>).find((i) => i.identifier === a)!;
    expect(row.queuedBy).toEqual({ identifier: epic, owner: "VP" });
    expect(row.gate).toBeNull();

    const detail = structured(await harness.call("get_task", { ref: a, ws: WS }));
    expect(detail.queuedBy).toEqual({ identifier: epic, owner: "VP" });
    expect(detail.gate).toBeNull();
  });

  it("refuses checkout_task of a queued issue with the SAME triple the CLI gives", async () => {
    const { epic, a } = freshEpic("MCP refusal");
    await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    const refused = await harness.call("checkout_task", { ref: a, ws: WS });
    expect(refused.isError).toBe(true);
    // One logical failure, one triple, on every surface. That is the whole
    // reason the contract lives in a fixture instead of in each suite.
    expect(tripleOf(mcpEnvelope(refused))).toEqual(
      ERROR_CONTRACT.checkoutGated(epic, "VP", "backlog"),
    );
  });

  it("approve_task releases named children and then the whole gate", async () => {
    const { epic, a, b } = freshEpic("MCP approve");
    await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    const partial = await harness.call("approve_task", { ref: epic, children: [a], ws: WS });
    expect(structured(partial).status).toBe("awaiting_approval");
    expect((await harness.call("checkout_task", { ref: a, ws: WS })).isError).toBeFalsy();
    expect((await harness.call("checkout_task", { ref: b, ws: WS })).isError).toBe(true);

    const whole = await harness.call("approve_task", { ref: epic, ws: WS });
    expect(structured(whole).gate).toMatchObject({ state: "approved", resolvedBy: CONTRACT_AGENT });
    expect((await harness.call("checkout_task", { ref: b, ws: WS })).isError).toBeFalsy();
  });

  it("request_changes requires its comment and keeps the queue", async () => {
    const { epic, a } = freshEpic("MCP changes");
    await harness.call("gate_task", { ref: epic, owner: "VP", ws: WS });

    const sent = await harness.call("request_changes", { ref: epic, comment: "not yet", ws: WS });
    expect(structured(sent).status).toBe("todo");
    expect(structured(sent).gate).toMatchObject({ state: "changes_requested" });

    const comments = structured(await harness.call("list_comments", { ref: epic, ws: WS }));
    expect((comments.items as Array<{ body: string }>).map((c) => c.body)).toContain("not yet");

    expect(mcpEnvelope(await harness.call("checkout_task", { ref: a, ws: WS })).code).toBe("gated");
  });

  it("refuses a gate on a leaf, pointing at the status that means leaf-in-review", async () => {
    const leaf = json(cli("new", "MCP leaf", "--ws", WS, "--json")).identifier as string;
    const refused = await harness.call("gate_task", { ref: leaf, owner: "VP", ws: WS });
    expect(refused.isError).toBe(true);
    const envelope = mcpEnvelope(refused);
    expect(envelope.code).toBe("validation");
    expect(String(envelope.message)).toContain("in_review");
  });
});
