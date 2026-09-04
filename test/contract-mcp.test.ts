/**
 * H10 — MCP contract goldens.
 *
 * Pins, for a real staple MCP server over stdio:
 *  - the exact tool inventory (names, annotations, which tools declare an
 *    outputSchema), so adding or removing a tool is a deliberate diff;
 *  - the full JSON shape of structuredContent for a successful call to EVERY
 *    one of the 20 tools, plus the invariant that the text block parses to the
 *    same payload;
 *  - the error envelope for every StapleError class the surface can produce,
 *    checked against the ONE canonical table in fixtures/error-contract.ts.
 *
 * Determinism: one scratch STAPLE_HOME per run, workspaces created through the
 * `init` TOOL (never initWorkspace()), a server cwd that contains no workspace
 * so resolution must go through `ws`, and a fresh hub so the minted prefixes
 * (CON, then CONA) and issue numbers (CON-1..CON-4) are fixed.
 *
 * Cost: two server spawns (one with STAPLE_AGENT, one without for the
 * missing-actor projection) and ONE scripted pass whose results every test then
 * asserts against — no test depends on another test having run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTRACT_AGENT,
  CURSOR,
  ISO,
  ISO_RE,
  PATH,
  SECONDS,
  UUID,
  UUID_RE,
  asStructured,
  claimGolden,
  timingGolden,
  commentGolden,
  decodeCursorForAssertion,
  issueGolden,
  mcpEnvelope,
  mcpErrorProse,
  normalize,
  startMcpClient,
  toolPayload,
  type McpHarness,
  type ToolCallResult,
} from "./fixtures/contract-support.js";
import { ERROR_CONTRACT, tripleOf } from "./fixtures/error-contract.js";

const WS = "contract";
const OTHER_AGENT = "other-agent";

let home: string;
let emptyDir: string;
let harness: McpHarness;
let anon: McpHarness;
let tempRoots: string[];
const rec = new Map<string, ToolCallResult>();
/** The cursor list_tasks handed back on page 1 — replayed verbatim, never parsed. */
let page1Cursor: string;

function norm(value: unknown): unknown {
  return normalize(value, tempRoots);
}

function got(label: string): ToolCallResult {
  const result = rec.get(label);
  if (!result) throw new Error(`no recorded call "${label}"`);
  return result;
}

/**
 * The two assertions every tool owes its callers: structuredContent matches the
 * golden exactly, and the text block carries the same payload (arrays wrap to
 * {items}, mirroring mcp.ts structured()).
 */
function assertGolden(label: string, expected: Record<string, unknown>): void {
  const result = got(label);
  expect(result.isError, `${label} unexpectedly failed: ${JSON.stringify(result.content)}`).toBeFalsy();
  expect(norm(result.structuredContent), `${label} structuredContent`).toEqual(expected);
  expect(norm(asStructured(toolPayload(result))), `${label} text block`).toEqual(expected);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-mcp-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-contract-mcp-cwd-"));
  tempRoots = [home, emptyDir];

  harness = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  anon = await startMcpClient({ home, cwd: emptyDir });

  const call = async (label: string, name: string, args: Record<string, unknown>) => {
    rec.set(label, await harness.call(name, args));
  };

  // --- workspaces (via the init TOOL, per the ticket) ---
  await call("init", "init", { global: true, slug: "contract" });
  await call("init_two", "init", { global: true, slug: "contract-two" });

  // --- fixture tree: CON-1 root, CON-2 idempotent, CON-3 blocker, CON-4 child ---
  await call("create", "create_task", {
    title: "Contract root task",
    description: "Root of the contract fixture tree",
    priority: "high",
    labels: ["contract", "golden"],
    acceptance_criteria: ["shape is pinned"],
    ws: WS,
  });
  await call("create_idem", "create_task", {
    title: "Contract idempotent",
    idempotency_key: "idem-1",
    ws: WS,
  });
  await call("create_replay", "create_task", {
    title: "Contract idempotent",
    idempotency_key: "idem-1",
    ws: WS,
  });
  await call("create_blocker", "create_task", { title: "Contract blocker", ws: WS });
  await call("create_child", "create_task", { title: "Contract child", parent: "CON-1", ws: WS });
  await call("create_remote", "create_task", { title: "Remote dependency", ws: "contract-two" });

  await call("set_blocked_by", "set_blocked_by", { ref: "CON-4", blockers: ["CON-3"], ws: WS });
  await call("cross_link", "cross_link", {
    blocker_identifier: "CONA-1",
    blocked_identifier: "CON-1",
  });

  await call("checkout", "checkout_task", { ref: "CON-1", ws: WS });
  await call("add_comment", "add_comment", {
    ref: "CON-1",
    body: "contract comment",
    idempotency_key: "c-1",
    ws: WS,
  });
  await call("add_comment_replay", "add_comment", {
    ref: "CON-1",
    body: "contract comment",
    idempotency_key: "c-1",
    ws: WS,
  });
  await call("list_comments", "list_comments", { ref: "CON-1", ws: WS });
  await call("put_document", "put_document", {
    ref: "CON-1",
    key: "plan",
    body: "# plan v1\n",
    title: "Plan",
    ws: WS,
  });
  await call("get_document", "get_document", { ref: "CON-1", key: "plan", ws: WS });

  // Read views, captured while CON-1 is held so the claim fields are non-null.
  await call("get_task", "get_task", { ref: "CON-1", include_documents: true, ws: WS });
  await call("list_tasks", "list_tasks", { ws: WS, limit: 2 });
  page1Cursor = (toolPayload(got("list_tasks")) as { nextCursor: string }).nextCursor;
  await call("list_tasks_p2", "list_tasks", { ws: WS, limit: 2, cursor: page1Cursor });
  await call("inbox", "inbox", { ws: WS, limit: 2 });
  await call("events_since", "events_since", { since: 0, limit: 4, ws: WS });
  await call("hub_overview", "hub_overview", { ref: "CON-1", events_limit: 5 });

  // Conflicts must be observed while CON-1 is still held.
  await call("err_conflict_held", "checkout_task", { ref: "CON-1", actor: OTHER_AGENT, ws: WS });
  await call("err_conflict_blocked", "checkout_task", { ref: "CON-4", actor: OTHER_AGENT, ws: WS });

  await call("update_task", "update_task", {
    ref: "CON-1",
    priority: "low",
    comment: "via update",
    ws: WS,
  });
  await call("release_task", "release_task", { ref: "CON-1", ws: WS });

  await call("err_revision", "put_document", {
    ref: "CON-1",
    key: "plan",
    body: "x",
    base_revision: 99,
    ws: WS,
  });
  await call("err_duplicate", "create_task", { title: "Contract root task", ws: WS });
  await call("err_not_found", "get_task", { ref: "CON-999", ws: WS });
  await call("err_cursor", "list_tasks", { ws: WS, limit: 2, cursor: page1Cursor, q: "different" });

  // A server with no STAPLE_AGENT: an unattributable write is refused (H8).
  rec.set(
    "err_missing_actor",
    await anon.call("create_task", { title: "No actor here", ws: WS }),
  );

  /**
   * The vocabulary tools (STA-140) run LAST, and that placement is the point:
   * `update_statuses` changes the order every list above is sorted by, so
   * capturing it earlier would make the other goldens depend on when it ran.
   */
  await call("list_statuses", "list_statuses", { ws: WS });
  await call("list_kinds", "list_kinds", { ws: WS });
  await call("update_statuses", "update_statuses", {
    // `needs_qa`, not `awaiting_approval`: the gated row is SEEDED since the
    // approval-gates merge, so adding it would capture a duplicate-id refusal
    // instead of an add. A `review` status is also one `update_task` may write,
    // which the gated category deliberately is not.
    ops: [{ op: "add", id: "needs_qa", category: "review", after: "in_review" }],
    ws: WS,
  });
  await call("update_kinds", "update_kinds", {
    ops: [
      { op: "add", id: "milestone" },
      { op: "rename", id: "milestone", label: "Milestone" },
    ],
    ws: WS,
  });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await anon?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- inventory

describe("tool inventory", () => {
  /**
   * ONE golden for the whole surface. Adding, removing, renaming, or
   * re-annotating a tool changes this object, which is exactly the review
   * moment this ticket is buying. Read-only tools deliberately omit
   * destructiveHint (the MCP spec only defines it when readOnlyHint is false).
   */
  it("exposes exactly these 31 tools with these annotations and output schemas", async () => {
    const tools = await harness.listTools();
    const inventory = tools.map((t) => ({
      name: t.name,
      annotations: t.annotations,
      hasOutputSchema: Boolean(t.outputSchema),
    }));
    expect(inventory).toEqual([
      {
        name: "inbox",
        annotations: { title: "Inbox: ready work", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "list_tasks",
        annotations: { title: "List tasks", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "get_task",
        annotations: { title: "Get task context", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "create_task",
        annotations: {
          title: "Create task",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "update_task",
        annotations: {
          title: "Update task",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      /**
       * C1 moved BOTH claim tools to destructiveHint: true. With
       * steal_if_idle_seconds / if_idle_seconds they can revoke a claim that is
       * not the caller's, and MCP's destructiveHint is "may perform destructive
       * updates" vs "only additive updates". Annotations are static per tool, so
       * each must describe its worst case — here, a takeover. Clients that gate
       * destructive tools behind confirmation will now confirm a steal, which is
       * the intended posture for a human-initiated action.
       *
       * checkout_task keeps idempotentHint: true, and it is still true: repeating
       * the identical steal finds the caller already holding the issue and
       * returns via the crash-recovery re-claim branch — no second event, no
       * additional effect. Destructive-but-idempotent is an ordinary pairing.
       */
      {
        name: "checkout_task",
        annotations: {
          title: "Claim task",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "release_task",
        annotations: {
          title: "Release task",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      /**
       * The three gate verbs (STA-143), in registration order, sitting between
       * the claim tools and the comment tools because that is where they sit in
       * a ticket's life.
       *
       * The hints are not uniform, and the split is the interesting part.
       * `gate_task` and `request_changes` are DESTRUCTIVE: both revoke the
       * parent's claim, and gating additionally takes a whole subtree out of
       * circulation — nothing about that is an additive update. `approve_task`
       * is NOT: approving only ever widens what may be worked on.
       *
       * All three are idempotentHint: false. A second gate is refused while one
       * is pending, and a second whole-gate approve is refused once it is
       * resolved — refused, not absorbed, so a repeat is not a no-op.
       */
      {
        name: "gate_task",
        annotations: {
          title: "Gate task for approval",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "approve_task",
        annotations: {
          title: "Approve gate",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "request_changes",
        annotations: {
          // STA-154: the human-facing title says what the tool does to the ticket.
          // The TOOL NAME is unchanged — renaming a shipped verb to fix a label
          // would break every agent that calls it.
          title: "Send back with note",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "add_comment",
        annotations: {
          title: "Add comment",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "list_comments",
        annotations: { title: "List comments", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "set_blocked_by",
        annotations: {
          title: "Replace blockers",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      {
        name: "put_document",
        annotations: {
          title: "Write document",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      {
        name: "get_document",
        annotations: { title: "Read document", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: false,
      },
      {
        name: "events_since",
        annotations: { title: "Events since cursor", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: false,
      },
      // ------ the vocabulary surface (STA-140) ------
      {
        name: "list_statuses",
        annotations: { title: "List statuses", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "list_kinds",
        annotations: { title: "List kinds", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        // destructiveHint: removing a status rewrites the status of every issue
        // that carried it. idempotentHint: false — replaying an `add` is a
        // duplicate error, and replaying a `remove` is a not_found.
        name: "update_statuses",
        annotations: {
          title: "Update statuses",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "update_kinds",
        annotations: {
          title: "Update kinds",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "cross_link",
        annotations: {
          title: "Cross-workspace link",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      {
        name: "hub_overview",
        annotations: { title: "Hub overview", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: false,
      },
      {
        name: "init",
        annotations: {
          title: "Initialize workspace",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      // ------ milestones (STA-172) ------
      {
        name: "list_milestones",
        annotations: { title: "List milestones", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        name: "get_milestone",
        annotations: { title: "Get milestone", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        hasOutputSchema: true,
      },
      {
        // No output schema: a preview and a commit are two shapes on purpose,
        // and the SDK validates structuredContent against one.
        name: "create_milestone",
        annotations: {
          title: "Create milestone",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: false,
      },
      {
        // idempotentHint: setting the same dates twice is the same state.
        name: "update_milestone",
        annotations: {
          title: "Update milestone dates",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        // Never destructive: membership touches nothing about the member, and a
        // member is only ever removed by a human naming it.
        name: "add_milestone_member",
        annotations: {
          title: "Add milestone member",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "remove_milestone_member",
        annotations: {
          title: "Remove milestone member",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "move_milestone_member",
        annotations: {
          title: "Move milestone member",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
      {
        name: "reorder_milestone_members",
        annotations: {
          title: "Reorder milestone members",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        hasOutputSchema: true,
      },
    ]);
  });

  it("marks exactly the eleven read tools readOnlyHint: true", async () => {
    const tools = await harness.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly).toEqual([
      "inbox",
      "list_tasks",
      "get_task",
      "list_comments",
      "get_document",
      "events_since",
      // STA-140: reading the workspace vocabulary is as read-only as reading a task.
      "list_statuses",
      "list_kinds",
      "hub_overview",
      // STA-172: reading a plan is as read-only as reading a task.
      "list_milestones",
      "get_milestone",
    ]);
  });

  it("never marks a read tool destructive and never omits openWorldHint", async () => {
    const tools = await harness.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      if (tool.annotations?.readOnlyHint === true) {
        expect(tool.annotations?.destructiveHint, tool.name).toBeUndefined();
      }
    }
  });
});

// ----------------------------------------------------------- success shapes

describe("tool response shapes (31/31)", () => {
  it("init", () => {
    // Both fixtures are global workspaces, which get no AGENTS.md — the guide
    // belongs beside a repo's .staple. test/agents-guide.test.ts covers the repo case.
    assertGolden("init", {
      slug: "contract",
      prefix: "CON",
      dbPath: PATH,
      created: true,
      guidePath: null,
      guideWritten: false,
    });
    // A second workspace proves the prefix collision suffix is part of the contract.
    assertGolden("init_two", {
      slug: "contract-two",
      prefix: "CONA",
      dbPath: PATH,
      created: true,
      guidePath: null,
      guideWritten: false,
    });
  });

  it("create_task", () => {
    assertGolden(
      "create",
      issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        description: "Root of the contract fixture tree",
        priority: "high",
        labels: ["contract", "golden"],
        acceptanceCriteria: ["shape is pinned"],
        replayed: false,
      }),
    );
    // Same key, second call: the ORIGINAL row, flagged replayed (H8).
    assertGolden(
      "create_replay",
      issueGolden({
        identifier: "CON-2",
        title: "Contract idempotent",
        idempotencyKey: "idem-1",
        replayed: true,
      }),
    );
  });

  it("checkout_task", () => {
    assertGolden(
      "checkout",
      issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        description: "Root of the contract fixture tree",
        status: "in_progress",
        statusVersion: 1,
        priority: "high",
        assignee: CONTRACT_AGENT,
        labels: ["contract", "golden"],
        acceptanceCriteria: ["shape is pinned"],
        checkoutAgent: CONTRACT_AGENT,
        checkoutAt: ISO,
        startedAt: ISO,
      }),
    );
  });

  it("update_task", () => {
    assertGolden(
      "update_task",
      issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        description: "Root of the contract fixture tree",
        status: "in_progress",
        statusVersion: 1,
        priority: "low",
        assignee: CONTRACT_AGENT,
        labels: ["contract", "golden"],
        acceptanceCriteria: ["shape is pinned"],
        checkoutAgent: CONTRACT_AGENT,
        checkoutAt: ISO,
        startedAt: ISO,
      }),
    );
  });

  it("release_task", () => {
    assertGolden(
      "release_task",
      issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        description: "Root of the contract fixture tree",
        // Release keeps the assignee and clears the claim, and bumps statusVersion.
        status: "todo",
        statusVersion: 2,
        priority: "low",
        assignee: CONTRACT_AGENT,
        labels: ["contract", "golden"],
        acceptanceCriteria: ["shape is pinned"],
        startedAt: ISO,
      }),
    );
  });

  it("set_blocked_by", () => {
    assertGolden(
      "set_blocked_by",
      issueGolden({
        identifier: "CON-4",
        title: "Contract child",
        parentId: UUID,
        depth: 1,
      }),
    );
  });

  it("add_comment", () => {
    assertGolden("add_comment", commentGolden({ body: "contract comment", idempotencyKey: "c-1", replayed: false }));
    assertGolden(
      "add_comment_replay",
      commentGolden({ body: "contract comment", idempotencyKey: "c-1", replayed: true }),
    );
  });

  it("list_comments", () => {
    assertGolden("list_comments", {
      items: [commentGolden({ body: "contract comment", idempotencyKey: "c-1" })],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("put_document", () => {
    assertGolden("put_document", { key: "plan", revision: 1 });
  });

  it("get_document", () => {
    assertGolden("get_document", {
      key: "plan",
      revision: 1,
      body: "# plan v1\n",
      title: "Plan",
      author: CONTRACT_AGENT,
      createdAt: ISO,
    });
  });

  it("get_task", () => {
    assertGolden("get_task", {
      issue: issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        description: "Root of the contract fixture tree",
        status: "in_progress",
        statusVersion: 1,
        priority: "high",
        assignee: CONTRACT_AGENT,
        labels: ["contract", "golden"],
        acceptanceCriteria: ["shape is pinned"],
        checkoutAgent: CONTRACT_AGENT,
        checkoutAt: ISO,
        startedAt: ISO,
      }),
      ancestors: [],
      children: [issueGolden({ identifier: "CON-4", title: "Contract child", parentId: UUID, depth: 1 })],
      blockedBy: [],
      blocks: [],
      comments: [commentGolden({ body: "contract comment", idempotencyKey: "c-1" })],
      documents: [
        { issueId: UUID, key: "plan", currentRevision: 1, title: "Plan", updatedAt: ISO, body: "# plan v1\n" },
      ],
      // H9: the hub merge the web UI does, surfaced to agents.
      crossBlockers: [
        { identifier: "CONA-1", workspace: "contract-two", status: "backlog", resolved: false, unresolvable: false },
      ],
      // C1: liveness of the claim, so a caller can tell a working agent from a
      // dead one. CON-1 is held by the contract agent.
      claim: claimGolden(),
      /**
       * STA-143: the gate pair, siblings of the issue exactly like `claim`.
       * Both null here — CON-1 has never been gated and has nothing gated above
       * it — and both PRESENT rather than omitted, so a caller never has to tell
       * "no gate" from "field missing".
       */
      gate: null,
      queuedBy: null,
      /**
       * STA-81/STA-90: estimate vs actual, derived at read time. CON-1 has no
       * estimate but IS in_progress with an open interval, so `ownActiveSeconds`
       * is a reading (tokenized, like the claim durations beside it) and
       * `countedThrough` names the instant it was counted through — the ISO
       * token, never `now`.
       *
       * `activeSeconds` stays NULL even so, and that is the whole of STA-90 on
       * one line: CON-1 has a child, so its headline is the aggregation of its
       * children, and CON-4 has never run. A parent gets no stopwatch of its own
       * however busy it looks.
       *
       * `childrenEstimatedSeconds` is null rather than 0: no child recorded an
       * estimate, and "none recorded" is not "estimated at nothing".
       */
      timing: timingGolden({
        ownActiveSeconds: SECONDS,
        childCount: 1,
        childStatusCounts: {
          backlog: 1,
          todo: 0,
          in_progress: 0,
          in_review: 0,
          awaiting_approval: 0,
          done: 0,
          blocked: 0,
          cancelled: 0,
        },
        // STA-192: one unestimated descendant, so the plan is `none` over 1.
        subtreePlan: {
          estimatedSeconds: null,
          source: "none",
          descendantsEstimatedSeconds: null,
          contributingCount: 0,
          totalCount: 1,
        },
      }),
      // Keyed by IDENTIFIER, not uuid — which is why this line is readable.
      childrenTiming: { "CON-4": timingGolden() },
    });
  });

  it("list_tasks", () => {
    assertGolden("list_tasks", {
      items: [
        {
          identifier: "CON-1",
          title: "Contract root task",
          status: "in_progress",
          // STA-124: the summary carries the kind too — "is this an epic"
          // is a picking question, and picking is what this shape is for.
          kind: "task",
          priority: "high",
          assignee: CONTRACT_AGENT,
          parentId: null,
          /**
           * STA-81: the SCALAR estimate rides on this trimmed summary, and the
           * `timing` object deliberately does not. This shape exists to make
           * choosing a task cheap, and seven per-status counts per row is bulk
           * nobody picking work reads — get_task is where the analysis lives.
           */
          estimatedSeconds: null,
          // C1: the only held row on this page carries its liveness.
          claim: claimGolden(),
          gate: null,
          queuedBy: null,
        },
        {
          identifier: "CON-2",
          title: "Contract idempotent",
          status: "backlog",
          kind: "task",
          priority: "medium",
          assignee: null,
          parentId: null,
          estimatedSeconds: null,
          claim: null,
          gate: null,
          queuedBy: null,
        },
      ],
      nextCursor: CURSOR,
      hasMore: true,
    });
    // The cursor is honoured: page 2 continues, and ends the list.
    assertGolden("list_tasks_p2", {
      items: [
        {
          identifier: "CON-3",
          title: "Contract blocker",
          status: "backlog",
          kind: "task",
          priority: "medium",
          assignee: null,
          parentId: null,
          estimatedSeconds: null,
          claim: null,
          gate: null,
          queuedBy: null,
        },
        {
          identifier: "CON-4",
          title: "Contract child",
          status: "backlog",
          kind: "task",
          priority: "medium",
          assignee: null,
          parentId: UUID,
          estimatedSeconds: null,
          claim: null,
          gate: null,
          queuedBy: null,
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("inbox", () => {
    assertGolden("inbox", {
      ready: [
        issueGolden({
          identifier: "CON-1",
          title: "Contract root task",
          description: "Root of the contract fixture tree",
          status: "in_progress",
          statusVersion: 1,
          priority: "high",
          assignee: CONTRACT_AGENT,
          labels: ["contract", "golden"],
          acceptanceCriteria: ["shape is pinned"],
          checkoutAgent: CONTRACT_AGENT,
          checkoutAt: ISO,
          startedAt: ISO,
          unresolvedBlockers: [],
          claim: claimGolden(),
          // STA-143: additive, and present-as-null rather than omitted.
          gate: null,
          queuedBy: null,
        }),
        issueGolden({
          identifier: "CON-2",
          title: "Contract idempotent",
          idempotencyKey: "idem-1",
          unresolvedBlockers: [],
          claim: null,
          gate: null,
          queuedBy: null,
        }),
      ],
      // ready+queued+blocked partition ONE page, so a page can be all-ready (H9).
      queued: [],
      blocked: [],
      nextCursor: CURSOR,
      hasMore: true,
    });
  });

  it("events_since", () => {
    // KNOWN: events_since is the one list tool that returns a BARE ARRAY, so its
    // structuredContent is {items} with no nextCursor/hasMore — it does not follow
    // the {items, nextCursor, hasMore} page contract the other lists adopted in H9.
    // Pinned as-is; fixing it is a source change and belongs to its own ticket.
    assertGolden("events_since", {
      items: [
        {
          seq: 1,
          kind: "issue_created",
          issueId: UUID,
          actor: CONTRACT_AGENT,
          payload: { identifier: "CON-1", title: "Contract root task", status: "backlog" },
          dedupKey: null,
          createdAt: ISO,
        },
        {
          seq: 2,
          kind: "issue_created",
          issueId: UUID,
          actor: CONTRACT_AGENT,
          payload: { identifier: "CON-2", title: "Contract idempotent", status: "backlog" },
          dedupKey: null,
          createdAt: ISO,
        },
        {
          seq: 3,
          kind: "issue_created",
          issueId: UUID,
          actor: CONTRACT_AGENT,
          payload: { identifier: "CON-3", title: "Contract blocker", status: "backlog" },
          dedupKey: null,
          createdAt: ISO,
        },
        {
          seq: 4,
          kind: "issue_created",
          issueId: UUID,
          actor: CONTRACT_AGENT,
          payload: { identifier: "CON-4", title: "Contract child", status: "backlog" },
          dedupKey: null,
          createdAt: ISO,
        },
      ],
    });
  });

  it("cross_link", () => {
    assertGolden("cross_link", {
      blockerWs: "contract-two",
      blockerIdentifier: "CONA-1",
      blockedWs: "contract",
      blockedIdentifier: "CON-1",
      type: "blocks",
    });
  });

  it("hub_overview", () => {
    assertGolden("hub_overview", {
      workspaces: [
        {
          slug: "contract",
          prefix: "CON",
          path: PATH,
          kind: "global",
          addedAt: ISO,
          lastSeenAt: ISO,
          available: true,
        },
        {
          slug: "contract-two",
          prefix: "CONA",
          path: PATH,
          kind: "global",
          addedAt: ISO,
          lastSeenAt: ISO,
          available: true,
        },
      ],
      crossLinks: [
        {
          blockerWs: "contract-two",
          blockerIdentifier: "CONA-1",
          blockedWs: "contract",
          blockedIdentifier: "CON-1",
          type: "blocks",
        },
      ],
      crossBlockers: [
        { identifier: "CONA-1", workspace: "contract-two", status: "backlog", resolved: false, unresolvable: false },
      ],
      hubEvents: { items: [], nextCursor: null, hasMore: false },
    });
  });

  /**
   * STA-140. Two things are pinned here beyond the field names: the SEED itself
   * — a workspace `init` created answers with exactly these eight statuses, in
   * this order, with these categories — and the `sortOrder` spacing of ten that
   * makes `after` an insert rather than a rewrite of the column.
   *
   * `awaiting_approval` is the eighth, at 50, in category `gated` and
   * `isBuiltin: true`: STA-143's approval gate is not a status a caller adds, it
   * is one staple ships. Its POSITION between `in_review` and `done` is the life
   * of a ticket, and its CATEGORY is where all of its behaviour comes from.
   */
  it("list_statuses", () => {
    assertGolden("list_statuses", {
      statuses: [
        { id: "backlog", label: "Backlog", category: "unstarted", sortOrder: 10, isBuiltin: true },
        { id: "todo", label: "Todo", category: "ready", sortOrder: 20, isBuiltin: true },
        { id: "in_progress", label: "In Progress", category: "active", sortOrder: 30, isBuiltin: true },
        { id: "in_review", label: "In Review", category: "review", sortOrder: 40, isBuiltin: true },
        {
          id: "awaiting_approval",
          label: "Awaiting Approval",
          category: "gated",
          sortOrder: 50,
          isBuiltin: true,
        },
        { id: "done", label: "Done", category: "done", sortOrder: 60, isBuiltin: true },
        { id: "blocked", label: "Blocked", category: "blocked", sortOrder: 70, isBuiltin: true },
        { id: "cancelled", label: "Cancelled", category: "cancelled", sortOrder: 80, isBuiltin: true },
      ],
    });
  });

  it("list_kinds", () => {
    // Each row carries its resolved appearance (R5a, STA-181): the built-in
    // Lucide key and terminal fallback, labelled with the configured label.
    const mark = (value: string, label: string, fallback: string) => ({ source: "lucide", value, label, fallback });
    assertGolden("list_kinds", {
      kinds: [
        { id: "epic", label: "Epic", sortOrder: 10, isBuiltin: true, appearance: mark("layers", "Epic", "◆") },
        { id: "task", label: "Task", sortOrder: 20, isBuiltin: true, appearance: mark("square-check", "Task", "◇") },
        { id: "bug", label: "Bug", sortOrder: 30, isBuiltin: true, appearance: mark("bug", "Bug", "✱") },
        { id: "chore", label: "Chore", sortOrder: 40, isBuiltin: true, appearance: mark("wrench", "Chore", "↻") },
        { id: "spike", label: "Spike", sortOrder: 50, isBuiltin: true, appearance: mark("zap", "Spike", "↯") },
      ],
    });
  });

  /**
   * The write tools answer with the FULL new list, not an ack — a reorder or an
   * insert is only verifiable against the whole thing, and a caller that had to
   * make a second `list_statuses` call to see what it did would race anyone else
   * writing. `needs_qa` lands at 45: strictly between `in_review` (40) and
   * `awaiting_approval` (50), which is `after` doing arithmetic instead of a
   * rewrite of the column.
   */
  it("update_statuses", () => {
    assertGolden("update_statuses", {
      statuses: [
        { id: "backlog", label: "Backlog", category: "unstarted", sortOrder: 10, isBuiltin: true },
        { id: "todo", label: "Todo", category: "ready", sortOrder: 20, isBuiltin: true },
        { id: "in_progress", label: "In Progress", category: "active", sortOrder: 30, isBuiltin: true },
        { id: "in_review", label: "In Review", category: "review", sortOrder: 40, isBuiltin: true },
        {
          id: "needs_qa",
          // No --label was passed: the id is title-cased into one.
          label: "Needs Qa",
          category: "review",
          sortOrder: 45,
          isBuiltin: false,
        },
        {
          id: "awaiting_approval",
          label: "Awaiting Approval",
          category: "gated",
          sortOrder: 50,
          isBuiltin: true,
        },
        { id: "done", label: "Done", category: "done", sortOrder: 60, isBuiltin: true },
        { id: "blocked", label: "Blocked", category: "blocked", sortOrder: 70, isBuiltin: true },
        { id: "cancelled", label: "Cancelled", category: "cancelled", sortOrder: 80, isBuiltin: true },
      ],
    });
  });

  it("update_kinds", () => {
    // Two ops, one call, applied IN ORDER: the rename sees the row the add made.
    assertGolden("update_kinds", {
      kinds: [
        { id: "epic", label: "Epic", sortOrder: 10, isBuiltin: true },
        { id: "task", label: "Task", sortOrder: 20, isBuiltin: true },
        { id: "bug", label: "Bug", sortOrder: 30, isBuiltin: true },
        { id: "chore", label: "Chore", sortOrder: 40, isBuiltin: true },
        { id: "spike", label: "Spike", sortOrder: 50, isBuiltin: true },
        { id: "milestone", label: "Milestone", sortOrder: 60, isBuiltin: false },
      ],
    });
  });

  it("covers every registered tool exactly once", async () => {
    const tools = (await harness.listTools()).map((t) => t.name);
    const covered = new Set([
      "init",
      "create_task",
      "update_task",
      "checkout_task",
      "release_task",
      "set_blocked_by",
      "add_comment",
      "list_comments",
      "put_document",
      "get_document",
      "get_task",
      "list_tasks",
      "inbox",
      "events_since",
      "cross_link",
      "hub_overview",
      "gate_task",
      "approve_task",
      "request_changes",
      "list_statuses",
      "list_kinds",
      "update_statuses",
      "update_kinds",
      // STA-172: the eight milestone tools are pinned in contract-milestones.test.ts,
      // against the CLI and HTTP projections of the same shape.
      "list_milestones",
      "get_milestone",
      "create_milestone",
      "update_milestone",
      "add_milestone_member",
      "remove_milestone_member",
      "move_milestone_member",
      "reorder_milestone_members",
    ]);
    expect([...covered].sort()).toEqual([...tools].sort());
  });
});

// ------------------------------------------------------- volatile formats

describe("volatile fields keep their documented format", () => {
  it("ids are uuids and timestamps are ISO-8601 with millis and Z", () => {
    const issue = got("create").structuredContent as Record<string, unknown>;
    expect(issue.id).toMatch(UUID_RE);
    expect(issue.createdAt).toMatch(ISO_RE);
    expect(issue.updatedAt).toMatch(ISO_RE);
    const comment = got("add_comment").structuredContent as Record<string, unknown>;
    expect(comment.id).toMatch(UUID_RE);
    expect(comment.issueId).toMatch(UUID_RE);
    expect(comment.createdAt).toMatch(ISO_RE);
  });

  it("cursors are base64url and decode to a tagged payload", () => {
    expect(page1Cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursorForAssertion(page1Cursor)).toMatchObject({ k: "o" });
  });

  it("init reports an absolute dbPath under STAPLE_HOME", () => {
    const summary = got("init").structuredContent as Record<string, unknown>;
    expect(summary.dbPath).toBe(join(home, "workspaces", "contract.db"));
  });
});

// ---------------------------------------------------------- error envelopes

describe("error envelopes (MCP projection)", () => {
  const cases: Array<{ label: string; recorded: string; expected: ReturnType<typeof ERROR_CONTRACT.notFound> }> = [
    { label: "checkout conflict", recorded: "err_conflict_held", expected: ERROR_CONTRACT.checkoutConflict(CONTRACT_AGENT) },
    {
      label: "checkout refused by blockers",
      recorded: "err_conflict_blocked",
      expected: ERROR_CONTRACT.checkoutBlocked("backlog", ["CON-3"]),
    },
    { label: "revision_conflict", recorded: "err_revision", expected: ERROR_CONTRACT.revisionConflict(1) },
    { label: "duplicate", recorded: "err_duplicate", expected: ERROR_CONTRACT.duplicate("CON-1") },
    { label: "not_found", recorded: "err_not_found", expected: ERROR_CONTRACT.notFound() },
    { label: "validation (missing actor)", recorded: "err_missing_actor", expected: ERROR_CONTRACT.missingActor() },
    { label: "validation (cursor scope)", recorded: "err_cursor", expected: ERROR_CONTRACT.cursorScopeMismatch() },
  ];

  it.each(cases)("$label projects the canonical triple with isError", ({ recorded, expected }) => {
    const result = got(recorded);
    expect(result.isError).toBe(true);
    // An error result carries no structuredContent — the envelope rides the text block.
    expect(result.structuredContent).toBeUndefined();
    const envelope = mcpEnvelope(result);
    expect(tripleOf(envelope)).toEqual(expected);
    expect(typeof envelope.message).toBe("string");
    expect((envelope.message as string).length).toBeGreaterThan(0);
  });

  it.each(cases)("$label leads with a greppable ERROR(code) prose line", ({ recorded, expected }) => {
    expect(mcpErrorProse(got(recorded)).startsWith(`ERROR(${expected.code}): `)).toBe(true);
  });

  it("checkout conflict names the holder so the caller can pick another task", () => {
    const envelope = mcpEnvelope(got("err_conflict_held"));
    expect(envelope.message).toContain(CONTRACT_AGENT);
    expect(envelope.retryable).toBe(false);
  });

  it("revision_conflict is the ONLY retryable code on this surface", () => {
    const retryable = cases.filter((c) => mcpEnvelope(got(c.recorded)).retryable === true);
    expect(retryable.map((c) => c.recorded)).toEqual(["err_revision"]);
  });

  it("a missing workspace points the caller at the init tool, in protocol", async () => {
    // Fresh alias, so the lazy resolver actually tries and fails (H7).
    const result = await harness.call("list_tasks", { ws: "no-such-workspace" });
    expect(result.isError).toBe(true);
    const envelope = mcpEnvelope(result);
    expect(tripleOf(envelope)).toEqual(ERROR_CONTRACT.notFound());
    expect(envelope.message).toContain('"init"');
    expect(envelope.message).toContain("hub_overview");
  });
});
