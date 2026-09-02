/**
 * STA-81 — the estimate surface, driven through all three doors at once.
 *
 * The per-surface suites pin each projection's SHAPE. This one closes the loop
 * the other way: it writes an estimate through every surface and reads it back
 * through every other, against ONE workspace, in one run.
 *
 * That is the failure mode a single-surface test cannot see. MCP, the CLI and
 * HTTP each build their own input object before calling the same store — three
 * hand-written mappings of the same field — so a surface that forgets
 * `estimatedSeconds`, spells it differently, or drops a `null` on the floor
 * still passes its own suite and silently refuses to record anything. Here it
 * fails, because the value has to come back out of a door it did not go in
 * through.
 *
 * The three-state convention (absent = leave alone, null = clear, number = set)
 * is asserted per surface rather than once, because "absent" and "null" are the
 * pair every surface has an independent chance to conflate — `if (body.x)` is
 * one keystroke from silently discarding a deliberate clear.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  cliEnvelope,
  mcpEnvelope,
  runCli,
  startMcpClient,
  toolPayload,
  type McpHarness,
} from "./fixtures/contract-support.js";

const WS = "contract";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

/** `staple show <ref> --json`, parsed. The CLI's read of the timing pair. */
function cliShow(ref: string): Record<string, any> {
  const result = cli("show", ref, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function httpJson(input: string, init?: RequestInit) {
  const response = await fetch(`${origin}${input}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-staple-token": token,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const httpAction = (payload: Record<string, unknown>) =>
  httpJson("/api/action", { method: "POST", body: JSON.stringify(payload) });

async function mcpGet(ref: string): Promise<Record<string, any>> {
  const result = await mcp.call("get_task", { ref, ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, any>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-estimate-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-estimate-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: false, ws: WS });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

// ------------------------------------------------------- one store, three doors

describe("an estimate written through one surface is readable through the others", () => {
  it("CLI writes it; MCP and HTTP both read the same number back", async () => {
    expect(cli("new", "Written by CLI", "--ws", WS, "--estimate", "90m").status).toBe(0);

    // 90m is 5400 seconds on every surface. A surface that parsed the duration
    // differently, or stored minutes, shows up right here.
    expect(cliShow("CON-1").issue.estimatedSeconds).toBe(5400);
    expect((await mcpGet("CON-1")).issue.estimatedSeconds).toBe(5400);
    expect((await httpJson("/api/issue?ref=CON-1")).body.issue.estimatedSeconds).toBe(5400);
  });

  it("MCP writes it; the CLI and HTTP both read the same number back", async () => {
    const created = await mcp.call("create_task", {
      title: "Written by MCP",
      estimate_seconds: 7200,
      ws: WS,
    });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    expect((toolPayload(created) as Record<string, any>).estimatedSeconds).toBe(7200);

    expect(cliShow("CON-2").issue.estimatedSeconds).toBe(7200);
    expect((await httpJson("/api/issue?ref=CON-2")).body.issue.estimatedSeconds).toBe(7200);
  });

  it("HTTP writes it; the CLI and MCP both read the same number back", async () => {
    const created = await httpAction({
      type: "create",
      title: "Written by HTTP",
      estimateSeconds: 1800,
    });
    expect(created.status).toBe(200);
    expect(created.body.estimatedSeconds).toBe(1800);

    expect(cliShow("CON-3").issue.estimatedSeconds).toBe(1800);
    expect((await mcpGet("CON-3")).issue.estimatedSeconds).toBe(1800);
  });
});

// ------------------------------------------------------------- three-state, x3

describe("absent leaves it alone, null clears it — on every surface", () => {
  it("MCP: an update with no estimate_seconds does not touch the estimate", async () => {
    const before = (await mcpGet("CON-2")).issue.estimatedSeconds;
    expect(before).toBe(7200);
    await mcp.call("update_task", { ref: "CON-2", priority: "high", ws: WS });
    expect((await mcpGet("CON-2")).issue.estimatedSeconds).toBe(7200);
  });

  it("MCP: an explicit null clears it", async () => {
    await mcp.call("update_task", { ref: "CON-2", estimate_seconds: null, ws: WS });
    expect((await mcpGet("CON-2")).issue.estimatedSeconds).toBeNull();
    // …and it can be set again afterwards, so clearing is not a one-way door.
    await mcp.call("update_task", { ref: "CON-2", estimate_seconds: 3600, ws: WS });
    expect((await mcpGet("CON-2")).issue.estimatedSeconds).toBe(3600);
  });

  it("HTTP: an update with no estimateSeconds key does not touch the estimate", async () => {
    const patched = await httpAction({ type: "update", ref: "CON-3", title: "Renamed by HTTP" });
    expect(patched.status).toBe(200);
    expect(patched.body.estimatedSeconds).toBe(1800);
  });

  it("HTTP: an explicit null clears it, and is not mistaken for 'absent'", async () => {
    /**
     * The specific bug this guards: `if (body.estimateSeconds)` would drop null
     * along with the clear the caller asked for, and the request would return
     * 200 having done nothing. The refusal for an empty patch is what proves
     * the branch ran at all.
     */
    const cleared = await httpAction({ type: "update", ref: "CON-3", estimateSeconds: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.estimatedSeconds).toBeNull();
  });

  it("HTTP: estimateSeconds alone is a sufficient patch", async () => {
    const only = await httpAction({ type: "update", ref: "CON-3", estimateSeconds: 2400 });
    expect(only.status).toBe(200);
    expect(only.body.estimatedSeconds).toBe(2400);
  });

  it("CLI: --no-estimate clears it, and --estimate sets it again", () => {
    expect(cli("status", "CON-1", "backlog", "--ws", WS, "--no-estimate").status).toBe(0);
    expect(cliShow("CON-1").issue.estimatedSeconds).toBeNull();
    expect(cli("status", "CON-1", "backlog", "--ws", WS, "--estimate", "2h").status).toBe(0);
    expect(cliShow("CON-1").issue.estimatedSeconds).toBe(7200);
  });

  it("CLI: a status change with no estimate flag leaves the estimate alone", () => {
    expect(cli("status", "CON-1", "todo", "--ws", WS).status).toBe(0);
    expect(cliShow("CON-1").issue.estimatedSeconds).toBe(7200);
  });

  it("CLI: --estimate accepts every duration shape parseDuration does", () => {
    // Shared with --steal-if-stale/--if-stale, so a caller who learned the
    // vocabulary once does not have to learn a second one here.
    for (const [flag, seconds] of [["45s", 45], ["30m", 1800], ["12h", 43_200], ["3600", 3600]] as const) {
      expect(cli("status", "CON-1", "todo", "--ws", WS, "--estimate", flag).status).toBe(0);
      expect(cliShow("CON-1").issue.estimatedSeconds).toBe(seconds);
    }
  });
});

// ------------------------------------------------------------------- refusals

describe("a bad estimate is refused identically wherever it arrives", () => {
  it("MCP refuses zero with the store's own sentence", async () => {
    const envelope = mcpEnvelope(
      await mcp.call("create_task", { title: "Zero via MCP", estimate_seconds: 0, ws: WS }),
    );
    expect(envelope.code).toBe("validation");
    expect(String(envelope.message)).toMatch(/positive whole number of seconds/);
    expect(envelope.retryable).toBe(false);
  });

  it("HTTP refuses zero with the same sentence and a 409", async () => {
    const refused = await httpAction({ type: "create", title: "Zero via HTTP", estimateSeconds: 0 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("validation");
    expect(String(refused.body.message)).toMatch(/positive whole number of seconds/);
  });

  it("CLI refuses a malformed duration before it ever reaches the store", () => {
    // parseDuration's refusal, not the store's: `--estimate xyz` collapsing to a
    // silent 0 or NaN is exactly the failure the flag must not have.
    const result = cli("new", "Garbage", "--ws", WS, "--estimate", "xyz", "--json");
    expect(result.status).toBe(2);
    expect(String(cliEnvelope(result).message)).toMatch(/must be a duration like/);
  });

  it("CLI refuses --estimate and --no-estimate together rather than picking one", () => {
    const result = cli("status", "CON-1", "todo", "--ws", WS, "--estimate", "1h", "--no-estimate", "--json");
    expect(result.status).toBe(2);
    expect(String(cliEnvelope(result).message)).toMatch(/cannot be used together/);
  });

  it("refuses the whole write — a bad estimate does not half-apply a patch", () => {
    const before = cliShow("CON-1").issue;
    const refused = cli("status", "CON-1", "in_review", "--ws", WS, "--estimate", "xyz", "--json");
    expect(refused.status).toBe(2);
    const after = cliShow("CON-1").issue;
    expect(after.status).toBe(before.status);
    expect(after.estimatedSeconds).toBe(before.estimatedSeconds);
  });
});

// ---------------------------------------------------------- derived numbers

describe("the derived numbers reach every read surface", () => {
  let parent: string;

  beforeAll(async () => {
    // A small epic: one child estimated and finished, one estimated and running,
    // one with no estimate at all.
    expect(cli("new", "Analytics epic", "--ws", WS, "--estimate", "4h").status).toBe(0);
    parent = "CON-4";
    expect(cli("new", "Child done", "--ws", WS, "--parent", parent, "--estimate", "90m").status).toBe(0);
    expect(cli("new", "Child running", "--ws", WS, "--parent", parent, "--estimate", "2h").status).toBe(0);
    expect(cli("new", "Child unplanned", "--ws", WS, "--parent", parent).status).toBe(0);

    expect(cli("start", "CON-5", "--agent", CONTRACT_AGENT, "--ws", WS).status).toBe(0);
    expect(cli("done", "CON-5", "--ws", WS).status).toBe(0);
    expect(cli("start", "CON-6", "--agent", CONTRACT_AGENT, "--ws", WS).status).toBe(0);
    // The running child needs evidence of work after its claim: STA-90 counts an
    // open interval through the HOLDER'S last activity, so a claim with nothing
    // after it is honestly worth zero seconds.
    expect(cli("comment", "CON-6", "working", "--author", CONTRACT_AGENT, "--ws", WS).status).toBe(0);

    /**
     * Backdate through the CLI's own database file. No clock injection in
     * production code: a duration a test can fake through an API is not
     * measuring anything a real agent's runtime would produce.
     *
     * STA-90 moved WHAT gets backdated. `started_at`/`completed_at` no longer
     * feed the derivation at all — the replay reads `events.created_at` — so
     * this fixture writes the history the store actually reconstructs from.
     * Every instant is derived from ONE `base`, so the resulting durations are
     * exact rather than off by the milliseconds between two `Date.now()` calls.
     */
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`));
    const base = Date.now();
    const ago = (s: number) => new Date(base - s * 1000).toISOString();
    const setEvent = (identifier: string, kind: string, secondsAgo: number) =>
      db
        .prepare(
          `UPDATE events SET created_at = ?
            WHERE kind = ? AND issue_id = (SELECT id FROM issues WHERE identifier = ?)`,
        )
        .run(ago(secondsAgo), kind, identifier);

    // CON-5: claimed 2h ago, finished 1h ago -> one closed interval of 1h.
    setEvent("CON-5", "checkout", 7200);
    setEvent("CON-5", "status_changed", 3600);
    // CON-6: claimed 3h10m ago and still talking -> one open interval, counted
    // through the holder's comment.
    setEvent("CON-6", "checkout", 11_400);
    setEvent("CON-6", "comment_added", 0);
    db.prepare("UPDATE issues SET checkout_at = ? WHERE identifier = 'CON-6'").run(ago(11_400));
    db.prepare(
      "UPDATE comments SET created_at = ? WHERE issue_id = (SELECT id FROM issues WHERE identifier = 'CON-6')",
    ).run(ago(0));
    db.close();
  }, 60_000);

  it("MCP get_task carries timing and childrenTiming keyed by identifier", async () => {
    const payload = await mcpGet(parent);
    expect(payload.timing.estimatedSeconds).toBe(14_400);
    expect(payload.timing.childCount).toBe(3);
    expect(payload.timing.childrenEstimatedSeconds).toBe(5400 + 7200);
    expect(payload.timing.childrenActiveSeconds).toBe(3600 + 11_400);
    // The epic has no stopwatch of its own; its headline IS the aggregation.
    expect(payload.timing.ownActiveSeconds).toBeNull();
    expect(payload.timing.activeSeconds).toBe(15_000);
    expect(payload.timing.countedThrough).toBeNull();
    expect(Object.keys(payload.childrenTiming).sort()).toEqual(["CON-5", "CON-6", "CON-7"]);
    expect(payload.childrenTiming["CON-5"].activeSeconds).toBe(3600);
    expect(payload.childrenTiming["CON-6"].activeSeconds).toBe(11_400);
    // The live child names where its open interval was counted through — and it
    // is the holder's own last activity, never `now`.
    expect(payload.childrenTiming["CON-6"].countedThrough).toBe(
      (await mcpGet("CON-6")).claim.lastActivityAt,
    );
    // The unplanned child reports null, not zero — "no estimate recorded".
    expect(payload.childrenTiming["CON-7"].estimatedSeconds).toBeNull();
    expect(payload.childrenTiming["CON-7"].activeSeconds).toBeNull();
    // Reconstructed from a real event log, so nothing here is an approximation.
    expect(payload.timing.approximate).toBe(false);
  });

  it("HTTP /api/issue carries exactly the same derived numbers", async () => {
    const { body } = await httpJson(`/api/issue?ref=${parent}`);
    expect(body.timing.childrenEstimatedSeconds).toBe(12_600);
    expect(body.timing.childrenActiveSeconds).toBe(15_000);
    expect(body.childrenTiming["CON-5"].activeSeconds).toBe(3600);
  });

  it("CLI show --json carries them too", () => {
    const payload = cliShow(parent);
    expect(payload.timing.childrenEstimatedSeconds).toBe(12_600);
    expect(payload.timing.childrenActiveSeconds).toBe(15_000);
    expect(payload.childrenTiming["CON-6"].activeSeconds).toBe(11_400);
  });

  it("CLI show renders the compact human line, and only when there is something to say", () => {
    // The line the ticket asked for, verbatim in shape: `est <dur> · ran <dur>`.
    const child = cli("show", "CON-6", "--ws", WS);
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("time   est 2h · ran 3h10m");

    // A rollup line on the parent, which has children. Its `ran` is labelled
    // `(aggregated)` rather than left to read as an epic's own stopwatch — the
    // CLI half of STA-90's "no parent stopwatch".
    const epic = cli("show", parent, "--ws", WS);
    expect(epic.stdout).toContain("ran 4h10m (aggregated)");
    expect(epic.stdout).toContain("children est 3h30m");
    expect(epic.stdout).toContain("children ran 4h10m");

    // …and nothing at all on an issue with neither an estimate nor a start, so
    // every pinned `show` rendering that predates this feature is unchanged.
    expect(cli("new", "Bare task", "--ws", WS).status).toBe(0);
    expect(cli("show", "CON-8", "--ws", WS).stdout).not.toContain("time   ");
  });

  it("list surfaces carry the scalar estimate but not the rollup object", async () => {
    /**
     * A deliberate asymmetry, pinned so it stays deliberate. `list_tasks` exists
     * to make CHOOSING a task cheap; seven per-status counts on every row of a
     * 50-row page is bulk nobody picking work reads. The scalar stays because
     * "what is a 30m task I could take" is a picking question.
     */
    const listed = await mcp.call("list_tasks", { ws: WS, limit: 50 });
    const items = (toolPayload(listed) as { items: Record<string, any>[] }).items;
    const child = items.find((item) => item.identifier === "CON-6")!;
    expect(child.estimatedSeconds).toBe(7200);
    expect(child).not.toHaveProperty("timing");
    expect(child).not.toHaveProperty("childrenTiming");
  });

  it("the running child's actual is still DERIVED — it re-reads the log, not a column", async () => {
    /**
     * PIN INVERTED BY STA-90. This case used to assert the number GREW between
     * two reads, on the argument that only a derived value can move. That
     * argument was right and its example was the bug: the number grew because it
     * counted to `now`, which is why an agent that died on Friday was days into
     * its estimate by Monday.
     *
     * The property being defended is unchanged — nothing is stored — so it is
     * demonstrated the other way round: move the HISTORY and the answer moves
     * with it, while `now` moving on its own changes nothing.
     */
    const first = (await mcpGet("CON-6")).timing.activeSeconds as number;
    expect((await mcpGet("CON-6")).timing.activeSeconds).toBe(first);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`));
    db.prepare(
      `UPDATE events SET created_at = ?
        WHERE kind = 'checkout' AND issue_id = (SELECT id FROM issues WHERE identifier = 'CON-6')`,
    ).run(new Date(Date.now() - 12_000 * 1000).toISOString());
    db.prepare("UPDATE issues SET checkout_at = ? WHERE identifier = 'CON-6'").run(
      new Date(Date.now() - 12_000 * 1000).toISOString(),
    );
    db.close();

    const second = (await mcpGet("CON-6")).timing.activeSeconds as number;
    expect(second).toBeGreaterThan(first);
  });

  it("a claim with no work after it is worth zero seconds, not the time since", async () => {
    // The honest floor of the clamp, and the resolution limit stated as a test:
    // this measures an agent's WRITE CADENCE. A claim taken and then never
    // spoken to has produced no evidence of work, so the store reports none —
    // rather than the hours of wall clock the old scheme would have billed.
    const created = cli("new", "Claimed and silent", "--ws", WS, "--estimate", "1h", "--json");
    expect(created.status).toBe(0);
    // Read the identifier back rather than hardcoding one: this suite's other
    // cases also mint issues, and a literal here would depend on test order.
    const ref = String((JSON.parse(created.stdout) as { identifier?: string }).identifier);
    expect(ref).toMatch(/^CON-\d+$/);
    expect(cli("start", ref, "--agent", "silent-agent", "--ws", WS).status).toBe(0);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(home, "workspaces", `${WS}.db`));
    const long = new Date(Date.now() - 86_400 * 1000).toISOString();
    db.prepare(
      `UPDATE events SET created_at = ?
        WHERE kind = 'checkout' AND issue_id = (SELECT id FROM issues WHERE identifier = ?)`,
    ).run(long, ref);
    db.prepare("UPDATE issues SET checkout_at = ?, started_at = ? WHERE identifier = ?").run(
      long,
      long,
      ref,
    );
    db.close();

    const payload = await mcpGet(ref);
    expect(payload.claim.idleSeconds).toBeGreaterThan(80_000); // a day dead
    expect(payload.timing.activeSeconds).toBe(0); // and zero work to show for it
  });
});
