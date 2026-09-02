/**
 * GET /api/agent-context — the route behind the "what the agent sees" pane.
 *
 * The pane's entire claim is that it shows the EXACT payload an agent receives from MCP
 * `get_task`. A claim like that decays the moment the two surfaces are maintained
 * separately, so the load-bearing test here is not a golden: it is an equality. A real
 * MCP server is spawned over stdio, get_task is called, the HTTP route is called, and
 * the two payloads are compared deeply — for both values of include_documents.
 *
 * If someone later adds a field to one surface and not the other, this fails, which is
 * the only way the pane can keep being honest.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

const WS = "agentview";
const AGENT = "opus-detail";

let home: string;
let emptyDir: string;
let ui: UiHandle;
let mcp: McpHarness;
let origin: string;
let token: string;
let ref: string;

const PLAN_BODY = "# Plan\n\n" + "a line of the plan\n".repeat(60);

function get(path: string) {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

async function http(documents: boolean): Promise<Record<string, unknown>> {
  const res = await get(`/api/agent-context?ref=${encodeURIComponent(ref)}${documents ? "&documents=1" : ""}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function viaMcp(documents: boolean): Promise<Record<string, unknown>> {
  const result = await mcp.call("get_task", {
    ref,
    ws: WS,
    ...(documents ? { include_documents: true } : {}),
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-agentview-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-agentview-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ global: true, slug: WS });
  const parent = ws.store.createIssue({ title: "Parent epic" });
  const issue = ws.store.createIssue({
    title: "The agent's task",
    description: "Something for an agent to pick up.",
    parent: parent.identifier,
    acceptanceCriteria: ["it works", "it is tested"],
  });
  ref = issue.identifier;
  const blocker = ws.store.createIssue({ title: "A blocker" });
  ws.store.setBlockedBy(ref, [blocker.identifier], AGENT);
  ws.store.createIssue({ title: "A subtask", parent: ref });
  ws.store.addComment(ref, "One comment, so the payload has a thread.", AGENT, "agent");
  ws.store.putDocument(ref, "plan", PLAN_BODY, { author: AGENT, changeSummary: "first" });

  const dbPath = ws.dbPath;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the pane cannot drift from the tool", () => {
  it("returns exactly what MCP get_task returns, metadata only", async () => {
    expect(await http(false)).toEqual(await viaMcp(false));
  });

  it("returns exactly what MCP get_task returns with include_documents", async () => {
    expect(await http(true)).toEqual(await viaMcp(true));
  });

  it("carries every key get_task declares, and no more", async () => {
    expect(Object.keys(await http(false)).sort()).toEqual([
      "ancestors",
      "blockedBy",
      "blocks",
      "children",
      // STA-81: estimate vs actual for the direct children, keyed by identifier.
      "childrenTiming",
      // C1: claim liveness. get_task grew it, so this pane grew it in lockstep —
      // which is the drift this whole suite exists to catch.
      "claim",
      "comments",
      "crossBlockers",
      "documents",
      "issue",
      // STA-81, and the same lockstep story as `claim`: both surfaces spread the
      // SAME store.detailTiming() call, which is why the deep-equality tests
      // above went on passing while this inventory needed a deliberate edit.
      "timing",
    ]);
  });

  it("omits the `workspace` key /api/issue adds — get_task has no such field", async () => {
    const agentPayload = await http(false);
    expect(agentPayload).not.toHaveProperty("workspace");
    const detail = (await (await get(`/api/issue?ref=${encodeURIComponent(ref)}`)).json()) as Record<string, unknown>;
    expect(detail).toHaveProperty("workspace");
  });
});

describe("include_documents", () => {
  it("returns document metadata without bodies by default, matching get_task's default", async () => {
    const documents = (await http(false)).documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ key: "plan", currentRevision: 1 });
    expect(documents[0]).not.toHaveProperty("body");
  });

  it("inlines the current body when asked", async () => {
    const documents = (await http(true)).documents as Array<Record<string, unknown>>;
    expect(documents[0]!.body).toBe(PLAN_BODY);
  });

  it("makes the payload materially larger, which is the number the pane exists to show", async () => {
    const lean = JSON.stringify(await http(false)).length;
    const full = JSON.stringify(await http(true)).length;
    expect(full).toBeGreaterThan(lean + PLAN_BODY.length - 100);
  });

  it("treats any value other than 1 as off, so a typo cannot silently inflate the number", async () => {
    const res = await get(`/api/agent-context?ref=${encodeURIComponent(ref)}&documents=true`);
    const documents = ((await res.json()) as Record<string, unknown>).documents as Array<Record<string, unknown>>;
    expect(documents[0]).not.toHaveProperty("body");
  });
});

describe("the gate", () => {
  it("requires the token like every other read", async () => {
    const res = await fetch(`${origin}/api/agent-context?ref=${encodeURIComponent(ref)}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("unauthorized");
  });

  it("is a GET only", async () => {
    const res = await fetch(`${origin}/api/agent-context?ref=${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("404s on a ref that resolves to nothing, in the standard envelope", async () => {
    const res = await get("/api/agent-context?ref=NOPE-999");
    expect(res.status).toBe(404);
    const envelope = (await res.json()) as Record<string, unknown>;
    expect(envelope.code).toBe("not_found");
    expect(envelope.retryable).toBe(false);
    expect(envelope.error).toBe(envelope.message);
  });
});
