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
  assert(tools.tools.length >= 14, `tools/list exposes ${tools.tools.length} tools`);

  const byName = new Map<string, any>(tools.tools.map((t: any) => [t.name, t]));
  assert(
    tools.tools.every((t: any) => t.annotations?.title),
    `all ${tools.tools.length} tools carry an annotations title`,
  );
  const readOnly = tools.tools.filter((t: any) => t.annotations?.readOnlyHint === true).map((t: any) => t.name);
  assert(
    readOnly.length === 7 &&
      ["inbox", "list_tasks", "get_task", "list_comments", "get_document", "events_since", "hub_overview"].every(
        (n) => readOnly.includes(n),
      ),
    `exactly the 7 read-only tools flagged readOnlyHint (${readOnly.join(", ")})`,
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
    coldTools.tools.length === tools.tools.length && coldTools.tools.length >= 16,
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
  // 16 since STA-143 added gate_task, approve_task and request_changes — all
  // three act on ONE workspace's issue, so all three take `ws` like every other
  // workspace tool.
  assert(wsTargetable.length === 16, `16 workspace tools accept ws targeting (${wsTargetable.length} found)`);
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
        "approve_task",
        "checkout_task",
        "create_task",
        "gate_task",
        "put_document",
        "release_task",
        "request_changes",
        "set_blocked_by",
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
