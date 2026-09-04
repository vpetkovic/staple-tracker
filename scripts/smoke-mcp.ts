/**
 * MCP stdio smoke test.
 *
 * Phase 1 — a server pinned to a workspace via STAPLE_DB: list tools -> create
 * -> checkout -> comment -> done -> events, i.e. a real agent workflow.
 * Phase 2 — a server started in a directory with NO workspace at or above it
 * and no STAPLE_DB (STA-7): it must still connect and answer tools/list, report
 * a missing workspace in-protocol, and recover via the init tool + ws targeting.
 * Phase 3 — a server with NO STAPLE_AGENT (STA-8): reads work, writes without an
 * `actor` are refused with a validation envelope instead of being attributed to a
 * placeholder, and per-call identity (plus the legacy aliases) works.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../src/core/workspace.js";

// Absolute, because phase 2 runs a server whose cwd is somewhere else entirely.
const repoRoot = process.cwd();
const tsxCli = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const mcpEntry = join(repoRoot, "src/mcp.ts");

const home = mkdtempSync(join(tmpdir(), "staple-smoke-"));
process.env.STAPLE_HOME = home;
const ws = initWorkspace({ global: true, slug: "smoke" });
const dbPath = ws.dbPath;
ws.store.db.close();

// Phase 2 must inherit no workspace pinning from the outer shell.
const { STAPLE_DB: _outerDb, STAPLE_WS: _outerWs, ...cleanEnv } = process.env;

function startServer(options: { env: NodeJS.ProcessEnv; cwd: string }) {
  const child = spawn(process.execPath, [tsxCli, mcpEntry], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const pending = new Map<number, (msg: any) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on("data", () => {});

  let nextId = 1;
  function rpc(method: string, params: unknown): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function handshake(): Promise<void> {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  return { child, rpc, handshake, kill: () => child.kill() };
}

function toolText(result: any): string {
  return result.content[0].text as string;
}

/** Structured error envelope: JSON on the line after the prose ERROR(...) line. */
function toolError(result: any): any {
  const lines = toolText(result).split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "").error;
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${label}`);
  console.log(`  ok — ${label}`);
}

const pinned = startServer({
  env: { ...cleanEnv, STAPLE_DB: dbPath, STAPLE_AGENT: "smoke-agent", STAPLE_HOME: home },
  cwd: repoRoot,
});
const rpc = pinned.rpc;

const emptyDir = mkdtempSync(join(tmpdir(), "staple-smoke-empty-"));
let cold: ReturnType<typeof startServer> | undefined;
let anon: ReturnType<typeof startServer> | undefined;

try {
  await pinned.handshake();

  const tools = await rpc("tools/list", {});
  assert(tools.tools.length >= 20, `tools/list exposes ${tools.tools.length} tools`);

  const byName = new Map<string, any>(tools.tools.map((t: any) => [t.name, t]));
  assert(
    tools.tools.every((t: any) => t.annotations?.title),
    `all ${tools.tools.length} tools carry an annotations title`,
  );
  const readOnly = tools.tools.filter((t: any) => t.annotations?.readOnlyHint === true).map((t: any) => t.name);
  assert(
    readOnly.length === 12 &&
      [
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
        // R6d (STA-179): so is reading a registered setting.
        "get_setting",
      ].every((n) => readOnly.includes(n)),
    `exactly the 12 read-only tools flagged readOnlyHint (${readOnly.join(", ")})`,
  );
  assert(byName.get("checkout_task").annotations.idempotentHint === true, "checkout_task flagged idempotent");
  assert(
    byName.get("update_task").annotations.destructiveHint === false,
    "update_task is not flagged destructive",
  );
  /**
   * C1: the claim tools CAN revoke another agent's claim (steal_if_idle_seconds /
   * if_idle_seconds), which is not an additive update, so both must own the
   * destructive flag. checkout_task stays idempotent alongside it — repeating the
   * same steal is absorbed by the crash-recovery re-claim branch.
   */
  assert(
    byName.get("checkout_task").annotations.destructiveHint === true &&
      byName.get("release_task").annotations.destructiveHint === true,
    "claim tools are flagged destructive (they can revoke another agent's claim)",
  );
  assert(
    byName.get("checkout_task").inputSchema.properties.steal_if_idle_seconds !== undefined &&
      byName.get("release_task").inputSchema.properties.if_idle_seconds !== undefined,
    "claim tools expose the explicit stale-takeover parameters",
  );

  const created = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke: implement feature", assignee: "smoke-agent", priority: "high" },
    })),
  );
  assert(created.identifier === "SMO-1", `create_task minted ${created.identifier}`);
  assert(
    created.replayed === false && created.createdBy === "smoke-agent",
    "fresh create is replayed:false and attributed to STAPLE_AGENT",
  );

  const keyed = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke: idempotent create", idempotency_key: "smoke-key", actor: "actor-x" },
    })),
  );
  assert(
    keyed.createdBy === "actor-x" && keyed.replayed === false,
    "per-call actor overrides STAPLE_AGENT on create_task",
  );
  const keyedReplay = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke: idempotent create (retried)", idempotency_key: "smoke-key" },
    })),
  );
  assert(
    keyedReplay.replayed === true && keyedReplay.identifier === keyed.identifier,
    "idempotent create replay is visible as replayed:true",
  );

  const claimedResult = await rpc("tools/call", { name: "checkout_task", arguments: { ref: "SMO-1" } });
  const claimed = JSON.parse(toolText(claimedResult));
  assert(claimed.status === "in_progress" && claimed.checkoutAgent === "smoke-agent", "checkout claims atomically");

  assert(
    claimedResult.structuredContent?.identifier === "SMO-1" &&
      claimedResult.structuredContent.status === "in_progress",
    "checkout_task emits structuredContent (validated against its outputSchema)",
  );
  assert(
    JSON.stringify(claimedResult.structuredContent) === JSON.stringify(claimed),
    "structuredContent matches the text block payload",
  );
  assert(!toolText(claimedResult).includes("\n  "), "text block is compact, not pretty-printed");

  const conflict = await rpc("tools/call", {
    name: "checkout_task",
    arguments: { ref: "SMO-1", agent: "other-agent" },
  });
  assert(conflict.isError && toolText(conflict).includes("Pick a different task"), "second claim conflicts with guidance");

  const conflictError = toolError(conflict);
  assert(conflictError.code === "conflict", "checkout conflict carries code conflict");
  assert(conflictError.retryable === false, "checkout conflict is not retryable");
  assert(
    conflictError.detail.currentStatus === "in_progress" &&
      conflictError.detail.heldBy === "smoke-agent" &&
      Array.isArray(conflictError.detail.blockers),
    "checkout conflict detail exposes currentStatus/heldBy/blockers",
  );

  await rpc("tools/call", {
    name: "put_document",
    arguments: { ref: "SMO-1", key: "plan", body: "# plan\n- step 1" },
  });
  const staleDoc = await rpc("tools/call", {
    name: "put_document",
    arguments: { ref: "SMO-1", key: "plan", body: "# stale", base_revision: 0 },
  });
  assert(staleDoc.isError && toolText(staleDoc).includes("revision_conflict"), "stale document write rejected");

  const staleError = toolError(staleDoc);
  assert(
    staleError.code === "revision_conflict" && staleError.detail.currentRevision === 1,
    "stale write detail exposes currentRevision",
  );
  assert(staleError.retryable === true, "revision_conflict is retryable (re-read and merge)");

  const dup = await rpc("tools/call", {
    name: "create_task",
    arguments: { title: "Smoke: implement feature" },
  });
  const dupError = toolError(dup);
  assert(
    dupError.code === "duplicate" && dupError.detail.identifier === "SMO-1" && dupError.retryable === false,
    "duplicate detail exposes the colliding identifier",
  );

  const missing = await rpc("tools/call", { name: "get_task", arguments: { ref: "SMO-999" } });
  const missingError = toolError(missing);
  assert(
    missingError.code === "not_found" && missingError.retryable === false && !("detail" in missingError),
    "not_found envelope omits detail and is not retryable",
  );

  const commentResult = await rpc("tools/call", {
    name: "add_comment",
    arguments: { ref: "SMO-1", body: "done with step 1", idempotency_key: "c-1", actor: "commenter" },
  });
  const comment = JSON.parse(toolText(commentResult));
  assert(
    comment.author === "commenter" && comment.replayed === false && comment.idempotencyKey === "c-1",
    "add_comment honours actor and reports a fresh write",
  );
  assert(
    commentResult.structuredContent?.id === comment.id,
    "add_comment emits structuredContent (validated against its new outputSchema)",
  );
  const commentRetry = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "add_comment",
      arguments: { ref: "SMO-1", body: "a retry with a different body", idempotency_key: "c-1" },
    })),
  );
  assert(
    commentRetry.replayed === true &&
      commentRetry.id === comment.id &&
      commentRetry.body === comment.body,
    "same idempotency_key replays the original comment instead of double-posting",
  );
  const updated = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_task",
      arguments: { ref: "SMO-1", status: "done", comment: "shipping" },
    })),
  );
  assert(updated.status === "done" && updated.completedAt, "update_task done stamps completedAt");

  const eventsResult = await rpc("tools/call", { name: "events_since", arguments: { since: 0 } });
  const events = JSON.parse(toolText(eventsResult));
  const kinds = events.map((e: any) => e.kind);
  assert(kinds.includes("checkout") && kinds.includes("status_changed"), `event log carries ${kinds.length} events`);

  assert(
    Array.isArray(eventsResult.structuredContent?.items) &&
      eventsResult.structuredContent.items.length === events.length,
    "array payloads wrap as structuredContent.items (text block stays a bare array)",
  );

  const inboxResult = await rpc("tools/call", { name: "inbox", arguments: { assignee: "smoke-agent" } });
  const inbox = JSON.parse(toolText(inboxResult));
  assert(inbox.ready.length === 0, "inbox empty for this agent after completion");
  assert(
    Array.isArray(inboxResult.structuredContent?.ready) &&
      Array.isArray(inboxResult.structuredContent.blocked),
    "inbox structuredContent satisfies its outputSchema",
  );

  assert(
    inbox.hasMore === false && inbox.nextCursor === null,
    "inbox reports the end of the list (hasMore false, nextCursor null)",
  );

  // ── pagination + get_task parity (STA-10) ─────────────────────────────────
  for (const n of [1, 2, 3]) {
    await rpc("tools/call", {
      name: "create_task",
      arguments: { title: `Smoke: page filler ${n}` },
    });
  }

  const unpaged = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "list_tasks",
      arguments: { include_resolved: true, limit: 200 },
    })),
  );
  assert(
    Array.isArray(unpaged.items) && unpaged.hasMore === false && unpaged.nextCursor === null,
    `list_tasks returns {items, nextCursor, hasMore} (${unpaged.items.length} items)`,
  );

  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const args: Record<string, unknown> = { include_resolved: true, limit: 2 };
    if (cursor) args.cursor = cursor;
    const result = await rpc("tools/call", { name: "list_tasks", arguments: args });
    const page = JSON.parse(toolText(result));
    assert(
      JSON.stringify(result.structuredContent) === JSON.stringify(page),
      `page ${pages + 1}: structuredContent matches the text block (validated against outputSchema)`,
    );
    walked.push(...page.items.map((i: any) => i.identifier));
    pages += 1;
    if (!page.hasMore) {
      assert(page.nextCursor === null, "the last page has hasMore false and nextCursor null");
      break;
    }
    assert(typeof page.nextCursor === "string" && page.items.length === 2, "a full page carries a cursor");
    cursor = page.nextCursor;
    if (pages > 20) throw new Error("SMOKE FAIL: pagination did not terminate");
  }
  assert(
    walked.length === unpaged.items.length &&
      new Set(walked).size === walked.length &&
      JSON.stringify(walked) === JSON.stringify(unpaged.items.map((i: any) => i.identifier)),
    `paging ${pages} pages of 2 reproduces the unpaged list exactly, no dupes or gaps`,
  );

  const firstCursor = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "list_tasks",
      arguments: { include_resolved: true, limit: 2 },
    })),
  ).nextCursor;
  const wrongScope = await rpc("tools/call", {
    name: "list_tasks",
    arguments: { include_resolved: true, limit: 2, cursor: firstCursor, assignee: "somebody-else" },
  });
  assert(
    wrongScope.isError && toolError(wrongScope).code === "validation",
    "a cursor replayed against different filters is refused, not silently mis-paged",
  );
  const garbage = await rpc("tools/call", {
    name: "list_tasks",
    arguments: { cursor: "definitely-not-a-cursor" },
  });
  assert(
    garbage.isError && toolError(garbage).code === "validation",
    "a forged cursor is refused with a validation envelope",
  );

  const firstComments = JSON.parse(
    toolText(await rpc("tools/call", { name: "list_comments", arguments: { ref: "SMO-1", limit: 1 } })),
  );
  assert(
    firstComments.items.length === 1 && firstComments.hasMore === true,
    "list_comments paginates with the same {items, nextCursor, hasMore} shape",
  );
  const restComments = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "list_comments",
      arguments: { ref: "SMO-1", limit: 1, cursor: firstComments.nextCursor },
    })),
  );
  assert(
    restComments.items.length === 1 &&
      restComments.hasMore === false &&
      restComments.items[0].id !== firstComments.items[0].id,
    "the second comment page continues where the first stopped",
  );

  const contextResult = await rpc("tools/call", { name: "get_task", arguments: { ref: "SMO-1" } });
  const context = JSON.parse(toolText(contextResult));
  assert(
    Array.isArray(context.crossBlockers),
    "get_task carries crossBlockers (the field the web UI has always had)",
  );
  assert(
    context.documents.length === 1 && context.documents[0].body === undefined,
    "get_task returns document metadata only by default",
  );
  const withDocs = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "get_task",
      arguments: { ref: "SMO-1", include_documents: true },
    })),
  );
  assert(
    withDocs.documents[0].body.startsWith("# plan") && withDocs.documents[0].key === "plan",
    "include_documents inlines the current document body",
  );

  const hubPaged = JSON.parse(
    toolText(await rpc("tools/call", { name: "hub_overview", arguments: { events_limit: 5 } })),
  );
  assert(
    Array.isArray(hubPaged.hubEvents.items) &&
      hubPaged.hubEvents.hasMore === false &&
      hubPaged.hubEvents.nextCursor === null,
    "hub_overview nests its event log as a page",
  );

  // ── the workspace vocabulary (STA-140) ────────────────────────────────────
  const seededStatuses = JSON.parse(
    toolText(await rpc("tools/call", { name: "list_statuses", arguments: {} })),
  ).statuses;
  assert(
    seededStatuses.map((s: any) => s.id).join(",") ===
      "backlog,todo,in_progress,in_review,awaiting_approval,done,blocked,cancelled",
    "list_statuses returns the seeded eight in seed order",
  );
  assert(
    seededStatuses.find((s: any) => s.id === "awaiting_approval")?.category === "gated",
    "the seeded approval-gate status is in the gated category, which is where its behaviour lives",
  );
  assert(
    seededStatuses.every((s: any) => typeof s.category === "string" && s.isBuiltin === true),
    "every seeded status carries a category and is flagged built-in",
  );
  const seededKinds = JSON.parse(
    toolText(await rpc("tools/call", { name: "list_kinds", arguments: {} })),
  ).kinds;
  assert(
    seededKinds.map((k: any) => k.id).join(",") === "epic,task,bug,chore,spike",
    "list_kinds returns the seeded kind vocabulary",
  );

  // ── registered workspace settings (R6d, STA-179) ──────────────────────────
  const policyBefore = JSON.parse(
    toolText(await rpc("tools/call", { name: "get_setting", arguments: { key: "queue.policy" } })),
  );
  assert(
    policyBefore.value === "advisory" && policyBefore.source === "default" && policyBefore.scope === "workspace",
    "get_setting answers queue.policy = advisory from the default until something is stored",
  );
  const policyAfter = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "set_setting",
      arguments: { key: "queue.policy", value: "strict", actor: "smoke-agent" },
    })),
  );
  assert(
    policyAfter.value === "strict" && policyAfter.source === "workspace",
    "set_setting answers the new value with source workspace",
  );
  const policyRefused = await rpc("tools/call", {
    name: "set_setting",
    arguments: { key: "queue.policy", value: "lenient", actor: "smoke-agent" },
  });
  assert(
    policyRefused.isError === true && toolText(policyRefused).includes("must be one of advisory, strict"),
    "set_setting refuses a value outside the queue contract, naming the two it takes",
  );
  await rpc("tools/call", { name: "set_setting", arguments: { key: "queue.policy", value: "advisory", actor: "smoke-agent" } });

  // ── issue kinds on the wire (STA-124) ─────────────────────────────────────
  const aBug = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke defect", kind: "bug", actor: "smoke-agent" },
    })),
  );
  assert(aBug.kind === "bug", "create_task accepts a kind and returns it");
  const plain = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke plain work", actor: "smoke-agent" },
    })),
  );
  assert(plain.kind === "task", "create_task defaults the kind to task");

  const promoted = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_task",
      arguments: { ref: plain.identifier, kind: "epic", actor: "smoke-agent" },
    })),
  );
  assert(promoted.kind === "epic", "update_task re-declares the kind");

  const bugs = JSON.parse(
    toolText(await rpc("tools/call", { name: "list_tasks", arguments: { kind: ["bug"] } })),
  ).items;
  assert(
    bugs.length === 1 && bugs[0].identifier === aBug.identifier && bugs[0].kind === "bug",
    "list_tasks filters by kind and returns it on the summary row",
  );

  const fetchedKind = JSON.parse(
    toolText(await rpc("tools/call", { name: "get_task", arguments: { ref: aBug.identifier } })),
  ).issue.kind;
  assert(fetchedKind === "bug", "get_task returns the kind");

  // ── a parent closes itself when its last child lands (STA-153) ────────────
  const epic = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke epic", kind: "epic", actor: "smoke-agent" },
    })),
  );
  const onlyChild = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke epic child", parent: epic.identifier, actor: "smoke-agent" },
    })),
  );
  await rpc("tools/call", {
    name: "update_task",
    arguments: { ref: onlyChild.identifier, status: "done", actor: "smoke-agent" },
  });
  const closedEpic = JSON.parse(
    toolText(await rpc("tools/call", { name: "get_task", arguments: { ref: epic.identifier } })),
  ).issue;
  assert(
    closedEpic.status === "done" && closedEpic.completedAt,
    "the last child landing closes the epic on the wire, with completedAt",
  );
  const epicEvents = JSON.parse(
    toolText(await rpc("tools/call", { name: "events_since", arguments: { since: 0 } })),
  ).filter((e: any) => e.payload?.identifier === epic.identifier);
  assert(
    epicEvents.some((e: any) => e.kind === "children_complete"),
    "children_complete still wakes the epic's owner for the summary",
  );
  assert(
    epicEvents.some((e: any) => e.kind === "status_changed" && e.payload.derived === "children_resolved"),
    "the automatic close is marked derived on the event log",
  );

  // A kind the code has never heard of, added at runtime — the whole point of
  // the schema being z.string() rather than z.enum.
  await rpc("tools/call", {
    name: "update_kinds",
    arguments: { ops: [{ op: "add", id: "milestone", label: "Milestone" }] },
  });
  const ga = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke GA", kind: "milestone", actor: "smoke-agent" },
    })),
  );
  assert(ga.kind === "milestone", "a configured custom kind survives create_task's output schema");

  const added = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_statuses",
      arguments: {
        ops: [{ op: "add", id: "needs_qa", category: "review", after: "in_review" }],
      },
    })),
  ).statuses;
  assert(
    added.map((s: any) => s.id).indexOf("needs_qa") === 4,
    "update_statuses places an added status exactly after the one named by `after`",
  );

  // The added status is a first-class one immediately: update_task takes it.
  const parked = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_task",
      arguments: { ref: "SMO-2", status: "needs_qa" },
    })),
  );
  assert(
    parked.status === "needs_qa",
    "a status added at runtime is accepted by update_task like any other",
  );

  // Guard 1: a status rows still carry cannot vanish out from under them.
  const refusedRemove = await rpc("tools/call", {
    name: "update_statuses",
    arguments: { ops: [{ op: "remove", id: "needs_qa" }] },
  });
  assert(
    refusedRemove.isError && toolError(refusedRemove).code === "conflict",
    "removing a status issues still carry is refused without migrateTo",
  );

  // Guard 2: the LAST status of a category staple writes into is never removable,
  // whether or not anything currently carries it.
  const refusedLast = await rpc("tools/call", {
    name: "update_statuses",
    arguments: { ops: [{ op: "remove", id: "backlog", migrateTo: "todo" }] },
  });
  assert(
    refusedLast.isError && toolError(refusedLast).code === "validation",
    "removing the only status of a required category is refused outright",
  );

  const migratedRemove = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_statuses",
      arguments: { ops: [{ op: "remove", id: "needs_qa", migrateTo: "todo" }] },
    })),
  ).statuses;
  assert(
    !migratedRemove.some((s: any) => s.id === "needs_qa"),
    "remove --migrate-to drops the status and the list comes back without it",
  );
  assert(
    JSON.parse(toolText(await rpc("tools/call", { name: "get_task", arguments: { ref: "SMO-2" } })))
      .issue.status === "todo",
    "every issue that carried the removed status was migrated onto the target",
  );

  const renamedKinds = JSON.parse(
    toolText(await rpc("tools/call", {
      name: "update_kinds",
      arguments: { ops: [{ op: "rename", id: "spike", label: "Spike / Research" }] },
    })),
  ).kinds;
  assert(
    renamedKinds.find((k: any) => k.id === "spike").label === "Spike / Research",
    "update_kinds renames in place, keeping the id",
  );

  // STAPLE_DB pins this server, so ws targeting must not escape it (existing
  // resolveWorkspace precedence) — and must not open a second handle either.
  const pinnedWs = await rpc("tools/call", { name: "inbox", arguments: { ws: "smoke" } });
  assert(!pinnedWs.isError, "ws-targeted call on a STAPLE_DB-pinned server still resolves");

  // ── Phase 2: cold start where no workspace exists (STA-7) ──────────────────
  console.log("  -- phase 2: cold start in a workspace-less directory --");
  cold = startServer({
    env: { ...cleanEnv, STAPLE_AGENT: "cold-agent", STAPLE_HOME: home },
    cwd: emptyDir,
  });
  await cold.handshake();

  const coldTools = await cold.rpc("tools/list", {});
  assert(
    coldTools.tools.length === tools.tools.length && coldTools.tools.length >= 20,
    `server connects and lists ${coldTools.tools.length} tools with no workspace anywhere above cwd`,
  );

  const coldByName = new Map<string, any>(coldTools.tools.map((t: any) => [t.name, t]));
  const initTool = coldByName.get("init");
  assert(initTool !== undefined, "init tool is exposed");
  assert(
    initTool.annotations.readOnlyHint === false && initTool.annotations.idempotentHint === true,
    "init is annotated not-read-only and idempotent",
  );

  const wsTargetable = coldTools.tools
    .filter((t: any) => t.inputSchema?.properties?.ws)
    .map((t: any) => t.name);
  // STA-140 added list_statuses / list_kinds / update_statuses / update_kinds,
  // STA-143 added gate_task / approve_task / request_changes, STA-172 the eight
  // milestone tools, and STA-179 get_setting / set_setting. All seventeen act on
  // ONE workspace, so all seventeen take `ws` like every other workspace tool.
  assert(wsTargetable.length === 30, `30 workspace tools accept ws targeting (${wsTargetable.length} found)`);
  assert(
    !coldByName.get("cross_link").inputSchema.properties?.ws &&
      !coldByName.get("hub_overview").inputSchema.properties?.ws,
    "hub-wide tools (cross_link, hub_overview) deliberately take no ws",
  );
  assert(
    /defaults to the workspace discovered/i.test(coldByName.get("inbox").inputSchema.properties.ws.description),
    "ws documents its cwd-discovered default",
  );

  const coldInbox = await cold.rpc("tools/call", { name: "inbox", arguments: {} });
  assert(coldInbox.isError, "workspace tool fails in-protocol instead of killing the server");
  const coldError = toolError(coldInbox);
  assert(
    coldError.code === "not_found" && coldError.retryable === false,
    "missing workspace returns the standard not_found envelope, not retryable",
  );
  assert(
    coldError.message.includes('"init"') && coldError.message.includes('"ws"'),
    "not_found message names the init tool and the ws input",
  );

  const overview = await cold.rpc("tools/call", { name: "hub_overview", arguments: {} });
  assert(!overview.isError, "hub_overview still works with no workspace resolved");

  const initResult = await cold.rpc("tools/call", {
    name: "init",
    arguments: { global: true, slug: "cold" },
  });
  assert(!initResult.isError, "init succeeds from a workspace-less cwd");
  const initPayload = JSON.parse(toolText(initResult));
  assert(
    initPayload.slug === "cold" && initPayload.created === true && initPayload.dbPath.startsWith(home),
    `init created a global workspace under STAPLE_HOME (${initPayload.slug}/${initPayload.prefix})`,
  );
  assert(
    initResult.structuredContent?.prefix === initPayload.prefix,
    "init emits structuredContent (validated against its outputSchema)",
  );

  const targeted = await cold.rpc("tools/call", {
    name: "create_task",
    arguments: { title: "Cold start task", ws: "cold" },
  });
  assert(!targeted.isError, "ws-targeted create_task works right after init");
  const targetedIssue = JSON.parse(toolText(targeted));
  assert(
    targetedIssue.identifier.startsWith(`${initPayload.prefix}-`),
    `ws routed the write into the new workspace (${targetedIssue.identifier})`,
  );

  const stillCold = await cold.rpc("tools/call", { name: "inbox", arguments: {} });
  assert(
    stillCold.isError && toolError(stillCold).code === "not_found",
    "the ws-targeted store does not leak into cwd-default calls",
  );

  const coldInboxTargeted = await cold.rpc("tools/call", { name: "inbox", arguments: { ws: "cold" } });
  assert(
    JSON.parse(toolText(coldInboxTargeted)).ready.length === 1,
    "ws-targeted inbox sees the task written through the cached store",
  );

  const reInit = await cold.rpc("tools/call", {
    name: "init",
    arguments: { global: true, slug: "cold" },
  });
  const reInitPayload = JSON.parse(toolText(reInit));
  assert(
    reInitPayload.created === false && reInitPayload.prefix === initPayload.prefix,
    "init is idempotent: re-running keeps the prefix and reports created:false",
  );

  const afterReInit = await cold.rpc("tools/call", { name: "inbox", arguments: { ws: "cold" } });
  assert(
    JSON.parse(toolText(afterReInit)).ready.length === 1,
    "workspace data survives the cache reset init performs",
  );

  // ── Phase 3: a server with NO identity configured (STA-8) ─────────────────
  console.log("  -- phase 3: no STAPLE_AGENT, identity must come per call --");
  anon = startServer({
    env: { ...cleanEnv, STAPLE_DB: dbPath, STAPLE_HOME: home, STAPLE_AGENT: "" },
    cwd: repoRoot,
  });
  await anon.handshake();

  const anonTools = await anon.rpc("tools/list", {});
  assert(
    anonTools.tools.length === tools.tools.length,
    `server starts and lists ${anonTools.tools.length} tools with no STAPLE_AGENT`,
  );
  const anonByName = new Map<string, any>(anonTools.tools.map((t: any) => [t.name, t]));
  const actorTools = anonTools.tools
    .filter((t: any) => t.inputSchema?.properties?.actor)
    .map((t: any) => t.name)
    .sort();
  assert(
    actorTools.join(",") ===
      [
        // Sorted, so the three gate verbs (STA-143) land where the alphabet puts
        // them rather than where they were registered. All three are writes and
        // all three are attributable — a gate with no requester is exactly the
        // kind of unattributable decision this assertion exists to prevent.
        "add_comment",
        // STA-172: every milestone write is attributed — membership events carry
        // the actor, and a plan nobody signed is not a plan.
        "add_milestone_member",
        "approve_task",
        "checkout_task",
        "create_milestone",
        "create_task",
        "gate_task",
        "move_milestone_member",
        "put_document",
        "release_task",
        "remove_milestone_member",
        "reorder_milestone_members",
        "request_changes",
        "set_blocked_by",
        // STA-179: a setting write is attributed like one too.
        "set_setting",
        // STA-140: a vocabulary edit is a write and is attributed like one.
        "update_kinds",
        "update_milestone",
        "update_statuses",
        "update_task",
      ].join(","),
    `every write tool accepts actor (${actorTools.join(", ")})`,
  );
  assert(
    !anonByName.get("inbox").inputSchema.properties?.actor &&
      !anonByName.get("get_task").inputSchema.properties?.actor,
    "read tools take no actor",
  );

  const anonRead = await anon.rpc("tools/call", { name: "inbox", arguments: {} });
  assert(!anonRead.isError, "read tools work with no identity configured");

  const anonWrite = await anon.rpc("tools/call", {
    name: "update_task",
    arguments: { ref: "SMO-1", priority: "low" },
  });
  assert(anonWrite.isError, "a write with no actor and no STAPLE_AGENT is refused");
  const anonError = toolError(anonWrite);
  assert(
    anonError.code === "validation" && anonError.retryable === false,
    "missing identity is a validation envelope, not retryable",
  );
  assert(
    anonError.message.includes("actor") && anonError.message.includes("STAPLE_AGENT"),
    "the refusal names both remedies (actor input, STAPLE_AGENT env)",
  );

  const anonAttributed = JSON.parse(
    toolText(await anon.rpc("tools/call", {
      name: "create_task",
      arguments: { title: "Smoke: identity supplied per call", actor: "per-call-agent" },
    })),
  );
  assert(
    anonAttributed.createdBy === "per-call-agent",
    "the same write succeeds and is attributed once actor is supplied",
  );

  const aliasClaim = JSON.parse(
    toolText(await anon.rpc("tools/call", {
      name: "checkout_task",
      arguments: { ref: anonAttributed.identifier, agent: "legacy-alias-agent" },
    })),
  );
  assert(
    aliasClaim.checkoutAgent === "legacy-alias-agent",
    "the legacy agent alias still satisfies identity on checkout_task",
  );
  const precedence = JSON.parse(
    toolText(await anon.rpc("tools/call", {
      name: "add_comment",
      arguments: { ref: anonAttributed.identifier, body: "who wrote this?", actor: "wins", author: "loses" },
    })),
  );
  assert(precedence.author === "wins", "actor wins over the legacy alias when both are sent");

  console.log("MCP SMOKE: PASS");
} finally {
  pinned.kill();
  cold?.kill();
  anon?.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
}
