/**
 * C4 — the takeover drill. The acceptance test for the continuity epic (STA-46).
 *
 * C1 proved a stale claim can be taken over. C2 proved init teaches the protocol.
 * Neither proves the thing the epic actually claims:
 *
 *   a killed agent's work can be FINISHED by a DIFFERENT identity on a
 *   DIFFERENT surface using ONLY what the tracker holds.
 *
 * So this suite runs the whole death-and-resume once, end to end, against real
 * processes: agent A (`drill-claude`) works a scratch repo through the CLI and
 * is killed mid-task; agent B (`drill-codex`) picks it up through a real MCP
 * server over stdio and finishes it.
 *
 * ── How sufficiency is actually enforced ────────────────────────────────────
 *
 * The weak version of this test hands B the file path and the remaining work as
 * test locals. That proves nothing: the test itself would be the handoff
 * channel, and the tracker could be empty.
 *
 * Here, B's resume is a pure function of ONE MCP payload — `resumeFromTracker()`
 * takes the `get_task` result and nothing else, and must recover three
 * coordinates from it:
 *
 *   WHERE the physical work lives  <- A's branch-pointer comment  (protocol §Branch pointer)
 *   WHICH file and WHAT to append  <- the `## Next` section of A's worklog (protocol §worklog)
 *
 * Delete either artifact and `resumeFromTracker()` throws — the drill fails
 * loudly instead of quietly passing on out-of-band knowledge. That is what makes
 * the branch pointer and the checkpoint load-bearing rather than decorative.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * One throwaway STAPLE_HOME and one scratch repo per run. The whole drill runs
 * ONCE in beforeAll and every test asserts against recorded results, so the
 * timeline is a single honest pass and no test depends on another having run.
 * Death is simulated by backdating in direct SQL, exactly as C1 does: production
 * has no clock injection and must not grow any, or staleness would be something
 * tests can fake but a real usage-limit death cannot.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import {
  CLI_ENTRY,
  TSX_CLI,
  cleanEnv,
  mcpEnvelope,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
  type ToolCallResult,
} from "./fixtures/contract-support.js";

/** The doomed agent. Works through the CLI. */
const A = "drill-claude";
/** The resumer. A different identity on a different surface. */
const B = "drill-codex";

/** The artifact A half-writes and B has to finish, in the scratch repo. */
const WORK_FILE = "greeting.txt";
const LINE_A = "Hello from the agent that got killed.";
const LINE_B = "Signed off by the agent that finished it.";

/** How dead A looks by the time B arrives, and the threshold B chooses. */
const DEAD_FOR_SECONDS = 4 * 3600;
const STEAL_THRESHOLD_SECONDS = 2 * 3600;
/** An intermediate age with a stable rendering: 200s floors to "3m" up to 239s. */
const ALIVE_FOR_SECONDS = 200;

/**
 * The refusal, verbatim. C1 owns this sentence; the drill pins it again from the
 * consumer's side, because "the guard names the previous holder" is the fact a
 * resuming agent actually depends on. Reformat it and this fails.
 */
const REFUSAL_3M = `Checkout refused: held by ${A}, active 3m ago. Pick a different task.`;

let home: string;
let repo: string;
let dbPath: string;
let guidePath: string;
let ref: string;
let mcp: McpHarness;

// --- everything the scripted drill records, asserted by the tests below ------
let initOut: CliResult;
let guideText: string;
let refusedLive: ToolCallResult;
let refusedStale: ToolCallResult;
let refusedPlain: ToolCallResult;
let discoveredInbox: InboxPayload;
let discoveredList: ListPayload;
let stolen: Record<string, unknown>;
let handoff: TaskContext;
let recovered: Resume;
let finished: Record<string, unknown>;
let finalEvents: StoredEvent[];
let worklogRevisions: Array<{ revision: number; author: string | null }>;

interface Claim {
  heldBy: string;
  lastActivityAt: string;
  heldSeconds: number;
  idleSeconds: number;
}
interface InboxPayload {
  ready: Array<{ identifier: string; status: string; claim: Claim | null }>;
  blocked: Array<{ identifier: string; claim: Claim | null }>;
}
interface ListPayload {
  items: Array<{ identifier: string; assignee: string | null; claim: Claim | null }>;
}
interface TaskContext {
  issue: Record<string, unknown>;
  comments: Array<{ author: string; body: string }>;
  documents: Array<{ key: string; currentRevision: number; body?: string }>;
}
interface StoredEvent {
  seq: number;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------- surfaces

/**
 * The CLI, run from inside the scratch repo (not the staple checkout) so the
 * workspace is found by walk-up and `doc --put` resolves files the way an agent
 * working that repo would. contract-support's runCli always sits in REPO_ROOT,
 * which is exactly the wrong cwd for a drill about a repo somewhere else.
 */
function cliAs(agent: string, ...args: string[]): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: repo,
    env: cleanEnv({ STAPLE_HOME: home, STAPLE_AGENT: agent }),
    encoding: "utf8",
  });
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/** Write a file inside the scratch repo — A's and B's actual product. */
function writeInRepo(name: string, body: string): void {
  writeFileSync(join(repo, name), body, "utf8");
}

function readInRepo(name: string): string {
  return readFileSync(join(repo, name), "utf8");
}

/**
 * The usage-limit death, in SQL. Backdates the claim AND every trace `agent`
 * left on this issue — events and comments both, since liveness is derived from
 * `checkout_at` plus the newest of either BY THE HOLDER. Backdating only events
 * would leave the branch-pointer comment reading as fresh activity and the
 * holder would still look alive.
 */
function backdate(seconds: number, agent: string): void {
  const at = new Date(Date.now() - seconds * 1000).toISOString();
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT id FROM issues WHERE identifier = ?").get(ref) as { id: string };
    db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(at, row.id);
    db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ? AND actor = ?").run(at, row.id, agent);
    db.prepare("UPDATE comments SET created_at = ? WHERE issue_id = ? AND author = ?").run(at, row.id, agent);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------- the sufficiency gate

interface Resume {
  /** Where the physical work lives — from the branch-pointer comment. */
  repoDir: string;
  /** Which file to finish — from the worklog's Next. */
  file: string;
  /** What to append — from the worklog's Next. */
  line: string;
}

/**
 * Everything B is allowed to know, derived from ONE `get_task` payload.
 *
 * A real resuming agent reads this prose and understands it. A test needs a
 * deterministic reader, so the parse is literal — but the INPUT is the whole
 * point: nothing here is closed over from the drill's setup, so if the tracker
 * did not carry a coordinate, this throws and the drill fails.
 */
function resumeFromTracker(payload: TaskContext): Resume {
  const pointer = payload.comments.find((c) => c.body.startsWith("Branch pointer:"));
  if (!pointer) {
    throw new Error("no branch-pointer comment: the tracker never recorded WHERE the work lives");
  }
  const where = /worktree (\S+) on branch \S+/.exec(pointer.body);
  if (!where) throw new Error(`branch pointer is unparseable: ${pointer.body}`);

  const worklog = payload.documents.find((d) => d.key === "worklog");
  if (!worklog) throw new Error("no worklog document: the dead agent left no checkpoint");
  if (worklog.body === undefined) {
    throw new Error("worklog has no body: get_task did not inline documents in this payload");
  }
  const next = /## Next\n([\s\S]*?)(?:\n## |$)/.exec(worklog.body);
  if (!next) throw new Error("worklog has no `## Next` section — the protocol's three headings are not optional");
  const instruction = /Append the line `([^`]+)` to `([^`]+)`/.exec(next[1]!);
  if (!instruction) throw new Error(`worklog Next does not name the remaining work: ${next[1]!}`);

  return { repoDir: where[1]!, file: instruction[2]!, line: instruction[1]! };
}

// ------------------------------------------------------------- the drill

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-drill-home-"));
  // realpath: macOS hands out /var/... symlinks into /private/var/..., and the
  // branch pointer B parses must match the cwd the CLI actually reported.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "staple-drill-repo-")));
  process.env.NODE_NO_WARNINGS = "1";

  // ---- 1. init a repo workspace. The protocol travels with it. --------------
  initOut = cliAs(A, "init", "--slug", "drill");
  expect(initOut.status, initOut.stderr).toBe(0);
  dbPath = join(repo, ".staple", "staple.db");
  guidePath = join(repo, ".staple", "AGENTS.md");
  guideText = existsSync(guidePath) ? readFileSync(guidePath, "utf8") : "";

  const created = cliAs(
    A,
    "new",
    "Write the greeting file",
    "--description",
    `${WORK_FILE} must carry a greeting line and a sign-off line, in that order.`,
    "--criteria",
    `${WORK_FILE} contains the greeting line;${WORK_FILE} contains the sign-off line;the task is done`,
    "--json",
  );
  expect(created.status, created.stderr).toBe(0);
  ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;

  // ---- 2. agent A works the ticket through the CLI, and gets half done -----
  expect(cliAs(A, "checkout", ref, "--agent", A).status).toBe(0);

  // The branch pointer, per the protocol: the task says what, not where.
  expect(
    cliAs(
      A,
      "comment",
      ref,
      `Branch pointer: worktree ${repo} on branch drill/greeting, base 0000000. Project subdir: .`,
      "--author",
      A,
    ).status,
  ).toBe(0);

  writeInRepo(
    "plan.md",
    `# Plan\n\n1. Write the greeting line to \`${WORK_FILE}\`.\n2. Append the sign-off line.\n3. Mark the task done.\n`,
  );
  expect(cliAs(A, "doc", ref, "plan", "--put", "plan.md").status).toBe(0);

  // The real, partial work — step 1 of the plan and nothing more.
  writeInRepo(WORK_FILE, `${LINE_A}\n`);

  // The checkpoint, written BEFORE the interruption because that is the only
  // kind that survives one. Concrete artifact in Done; actionable Next.
  writeInRepo(
    "worklog.md",
    [
      "## Done",
      `- Wrote the greeting line to \`${WORK_FILE}\` in this worktree: "${LINE_A}".`,
      "- The file exists and has exactly one line. Nothing else in the repo was touched.",
      "",
      "## Next",
      `- Append the line \`${LINE_B}\` to \`${WORK_FILE}\`, then mark this task done.`,
      "",
      "## Files touched",
      `- ${WORK_FILE} (new)`,
      "",
    ].join("\n"),
  );
  expect(
    cliAs(A, "doc", ref, "worklog", "--put", "worklog.md", "--summary", "checkpoint: line 1 written").status,
  ).toBe(0);

  // ---- 3. death. No release, no goodbye, no handoff comment. ---------------
  // (A simply stops existing here. Everything below is B, cold.)

  mcp = await startMcpClient({ home, cwd: repo, agent: B });

  // NEGATIVE, with NO backdating at all: A's claim is seconds old and the steal
  // is refused, naming A. Staleness is a fact about the claim, not a mood.
  refusedLive = await mcp.call("checkout_task", { ref, steal_if_idle_seconds: 3600 });

  // NEGATIVE again at a pinned age, so the sentence can be asserted verbatim.
  backdate(ALIVE_FOR_SECONDS, A);
  refusedStale = await mcp.call("checkout_task", { ref, steal_if_idle_seconds: 3600 });
  // ...and a PLAIN checkout of the same claim is still refused: a refusal is not
  // an invitation to escalate to a steal.
  refusedPlain = await mcp.call("checkout_task", { ref });

  // ---- 4. four hours later, a human says "continue" in a codex thread ------
  backdate(DEAD_FOR_SECONDS, A);

  discoveredInbox = toolPayload(await mcp.call("inbox", {})) as InboxPayload;
  discoveredList = toolPayload(await mcp.call("list_tasks", { status: ["in_progress"] })) as ListPayload;

  const steal = await mcp.call("checkout_task", { ref, steal_if_idle_seconds: STEAL_THRESHOLD_SECONDS });
  expect(steal.isError, JSON.stringify(steal.content)).toBeFalsy();
  stolen = toolPayload(steal) as Record<string, unknown>;

  // The whole handoff, in ONE call.
  handoff = toolPayload(await mcp.call("get_task", { ref, include_documents: true })) as TaskContext;

  // ---- 5. B finishes the work knowing only what that payload carried ------
  recovered = resumeFromTracker(handoff);
  const target = join(recovered.repoDir, recovered.file);
  writeFileSync(target, `${readFileSync(target, "utf8")}${recovered.line}\n`, "utf8");

  // Revise the checkpoint, then close it out with evidence.
  const worklogMeta = handoff.documents.find((d) => d.key === "worklog")!;
  await mcp.call("put_document", {
    ref,
    key: "worklog",
    base_revision: worklogMeta.currentRevision,
    change_summary: "resumed after takeover: line 2 appended",
    body: [
      "## Done",
      `- (${A}) Wrote the greeting line to \`${recovered.file}\`.`,
      `- (${B}) Appended the sign-off line, per the Next left in r${worklogMeta.currentRevision}.`,
      "",
      "## Next",
      "- Nothing. Both lines are present and the task is done.",
      "",
      "## Files touched",
      `- ${recovered.file}`,
      "",
    ].join("\n"),
  });

  const done = await mcp.call("update_task", {
    ref,
    status: "done",
    comment: `Resumed ${A}'s interrupted work after a ${STEAL_THRESHOLD_SECONDS}s-idle takeover. Both lines present in ${recovered.file}; no information came from outside the tracker.`,
  });
  expect(done.isError, JSON.stringify(done.content)).toBeFalsy();
  finished = toolPayload(done) as Record<string, unknown>;

  finalEvents = toolPayload(await mcp.call("events_since", { since: 0, limit: 500 })) as StoredEvent[];
  worklogRevisions = JSON.parse(cliAs(B, "doc", ref, "worklog", "--revisions", "--json").stdout) as Array<{
    revision: number;
    author: string | null;
  }>;
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("the protocol travels with init", () => {
  it("writes .staple/AGENTS.md beside the workspace and says so", () => {
    expect(existsSync(guidePath)).toBe(true);
    expect(initOut.stdout).toContain("Wrote the agent protocol guide");
    expect(initOut.stdout).toContain(guidePath);
  });

  it("teaches the three things this drill then depends on", () => {
    // If a harness arrives cold in this repo, everything B does below is
    // learnable from this file alone. These are the load-bearing sections.
    expect(guideText).toContain("## The worklog protocol");
    expect(guideText).toContain("## Branch pointer");
    expect(guideText).toContain("--steal-if-stale");
    expect(guideText).toContain("## Next");
  });
});

describe("a live claim is not takeable, however badly you want it", () => {
  it("refuses a steal of a claim seconds old, naming the holder", () => {
    const envelope = mcpEnvelope(refusedLive);
    expect(envelope.code).toBe("conflict");
    expect(envelope.retryable).toBe(false);
    expect(envelope.message).toMatch(
      new RegExp(`^Checkout refused: held by ${A}, active \\d+s ago\\. Pick a different task\\.$`),
    );
    expect((envelope.detail as Record<string, unknown>).heldBy).toBe(A);
  });

  it("refuses a steal below the threshold with the guard sentence, verbatim", () => {
    const envelope = mcpEnvelope(refusedStale);
    expect(envelope.code).toBe("conflict");
    expect(envelope.message).toBe(REFUSAL_3M);
    expect((envelope.detail as Record<string, unknown>).heldBy).toBe(A);
  });

  it("still refuses a PLAIN checkout of the same claim — a refusal is not an invitation to escalate", () => {
    const envelope = mcpEnvelope(refusedPlain);
    expect(envelope.code).toBe("conflict");
    expect((envelope.detail as Record<string, unknown>).heldBy).toBe(A);
  });
});

describe("B discovers the interrupted work by reading, not by being told", () => {
  it("inbox surfaces the held task with a claim that reads as dead", () => {
    const entry = discoveredInbox.ready.find((i) => i.identifier === ref);
    expect(entry, "the interrupted task is not in the inbox at all").toBeDefined();
    expect(entry!.status).toBe("in_progress");
    expect(entry!.claim).not.toBeNull();
    expect(entry!.claim!.heldBy).toBe(A);
    expect(entry!.claim!.idleSeconds).toBeGreaterThanOrEqual(DEAD_FOR_SECONDS);
    expect(entry!.claim!.heldSeconds).toBeGreaterThanOrEqual(DEAD_FOR_SECONDS);
  });

  it("list_tasks reports the same liveness, so either entry point works", () => {
    const item = discoveredList.items.find((i) => i.identifier === ref);
    expect(item?.claim?.heldBy).toBe(A);
    expect(item!.claim!.idleSeconds).toBeGreaterThanOrEqual(DEAD_FOR_SECONDS);
  });
});

describe("the takeover is explicit and leaves a named trail", () => {
  it("hands the issue to B, as holder and as assignee", () => {
    expect(stolen.checkoutAgent).toBe(B);
    expect(stolen.assignee).toBe(B);
    expect(stolen.status).toBe("in_progress");
  });

  it("logs claim_stolen carrying the previous holder, not a bare checkout", () => {
    const steals = finalEvents.filter((e) => e.kind === "claim_stolen");
    expect(steals).toHaveLength(1);
    const event = steals[0]!;
    expect(event.actor).toBe(B);
    expect(event.payload.previousHolder).toBe(A);
    expect(event.payload.previousIdleSeconds as number).toBeGreaterThanOrEqual(DEAD_FOR_SECONDS);
    expect(event.payload.stealIfIdleSeconds).toBe(STEAL_THRESHOLD_SECONDS);
    // A takeover must not also read as an ordinary claim by B.
    expect(finalEvents.filter((e) => e.kind === "checkout" && e.actor === B)).toHaveLength(0);
  });
});

describe("ONE payload is the whole handoff", () => {
  it("get_task --include_documents carries the worklog body, the plan, and the branch pointer", () => {
    const worklog = handoff.documents.find((d) => d.key === "worklog");
    expect(worklog?.body, "worklog body missing from the payload").toContain(LINE_B);
    expect(handoff.documents.find((d) => d.key === "plan")?.body).toContain(WORK_FILE);
    expect(handoff.comments.some((c) => c.author === A && c.body.startsWith("Branch pointer:"))).toBe(true);
    // Written by A, readable by B: the audit trail keeps the authorship straight.
    expect(worklog?.body).toContain("## Done");
    expect(worklog?.body).toContain("## Files touched");
  });

  it("yields all three coordinates B needed, from that payload alone", () => {
    expect(recovered.repoDir).toBe(repo);
    expect(recovered.file).toBe(WORK_FILE);
    expect(recovered.line).toBe(LINE_B);
  });

  it("fails loudly rather than silently when a coordinate is missing", () => {
    // The guarantee is only worth something if its absence is detectable.
    expect(() => resumeFromTracker({ ...handoff, comments: [] })).toThrow(/branch-pointer/);
    expect(() => resumeFromTracker({ ...handoff, documents: [] })).toThrow(/no worklog/);
    expect(() =>
      resumeFromTracker({
        ...handoff,
        documents: handoff.documents.map((d) => (d.key === "worklog" ? { ...d, body: undefined } : d)),
      }),
    ).toThrow(/did not inline documents/);
  });
});

describe("the work is actually finished, by the other agent", () => {
  it("the scratch file carries A's line and then B's", () => {
    expect(readInRepo(WORK_FILE)).toBe(`${LINE_A}\n${LINE_B}\n`);
  });

  it("the ticket is done and belongs to B", () => {
    expect(finished.status).toBe("done");
    expect(finished.assignee).toBe(B);
    expect(finished.completedAt).not.toBeNull();
  });

  it("the worklog history shows the checkpoint changing hands", () => {
    // Newest revision first, as `doc --revisions` prints it: B's resume sits on
    // top of A's checkpoint, and A's original is still there to be read.
    expect(worklogRevisions.map((r) => [r.revision, r.author])).toEqual([
      [2, B],
      [1, A],
    ]);
  });
});

describe("the event log tells the whole story on its own", () => {
  it("reads: created and claimed by A, stolen by B, finished by B", () => {
    const story = finalEvents
      .filter((e) =>
        ["issue_created", "checkout", "claim_stolen", "status_changed"].includes(e.kind),
      )
      .map((e) => `${e.kind}:${e.actor ?? "-"}`);
    expect(story).toEqual([
      `issue_created:${A}`,
      `checkout:${A}`,
      `claim_stolen:${B}`,
      `status_changed:${B}`,
    ]);
  });

  it("shows A's checkpoint landing before the takeover, and B's after", () => {
    const docs = finalEvents.filter((e) => e.kind === "doc_updated");
    const stealSeq = finalEvents.find((e) => e.kind === "claim_stolen")!.seq;
    expect(docs.filter((e) => e.seq < stealSeq).map((e) => e.actor)).toEqual([A, A]);
    expect(docs.filter((e) => e.seq > stealSeq).map((e) => e.actor)).toEqual([B]);
  });

  it("never records a release: A died without one, which is the point", () => {
    expect(finalEvents.filter((e) => ["release", "claim_released_stale"].includes(e.kind))).toHaveLength(0);
  });
});
