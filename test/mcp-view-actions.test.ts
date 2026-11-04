/**
 * A person's click in a view, over MCP: `approve_gate_from_view` and `request_changes_from_view`.
 *
 * The ticket card's Approve and Request changes and the queue's Approve call these two app-only
 * tools. They declare `_meta.ui.visibility: ["app"]` (a host offers them to the view, never to
 * the model), take no actor, and record the decision under the machine's `humanName`, else the
 * gate's owner: never the server's STAPLE_AGENT, even when the caller passes a name. The
 * comment is the person's and says which view it came from, and the gate event carries `via`.
 * An agent's approve_task and request_changes are unchanged: recorded under the agent, no `via`.
 *
 * Served by the packaged `staple mcp`, the same server the views' tests drive.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { updateConfig } from "../src/config/file.js";
import { initWorkspace, resolveWorkspace } from "../src/core/workspace.js";
import { testPackageDir } from "./fixtures/package-payload.js";

const AGENT = "view-agent";

let home: string;
let staple: string;
let dbPath: string;
let client: Client;

/** Gated epics, one per case, each with one open child; `ungated` is a plain task. */
const gates = {
  ownerFallback: "",
  configured: "",
  sendBack: "",
  agentApprove: "",
  agentSendBack: "",
  actorIgnored: "",
  regated: "",
  pulled: "",
  ungated: "",
};

function text(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function withStore<T>(fn: (store: ReturnType<typeof resolveWorkspace>["store"]) => T): T {
  const { store } = resolveWorkspace({ db: dbPath });
  try {
    return fn(store);
  } finally {
    store.db.close();
  }
}

function setHumanName(name: string): void {
  updateConfig(staple, { humanName: name });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-view-actions-"));
  staple = join(home, ".staple");
  process.env.STAPLE_HOME = staple;
  const ws = initWorkspace({ global: true, slug: "decisions" });
  dbPath = ws.dbPath;
  for (const key of ["ownerFallback", "configured", "sendBack", "agentApprove", "agentSendBack", "actorIgnored", "regated", "pulled"] as const) {
    const epic = ws.store.createIssue({ title: `Gate ${key}`, kind: "epic" });
    ws.store.createIssue({ title: `${key}: first step`, parent: epic.identifier, status: "todo" });
    ws.store.gateIssue(epic.identifier, { owner: "reviewer" }, "pat");
    gates[key] = epic.identifier;
  }
  gates.ungated = ws.store.createIssue({ title: "No gate here" }).identifier;
  ws.store.db.close();

  const { STAPLE_DB: _db, STAPLE_WS: _ws, ...inherited } = process.env as Record<string, string>;
  client = new Client({ name: "view-actions-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(testPackageDir(), "staple.mjs"), "mcp"],
      cwd: home,
      env: { ...inherited, STAPLE_HOME: staple, STAPLE_DB: dbPath, STAPLE_AGENT: AGENT, NODE_NO_WARNINGS: "1" },
      stderr: "pipe",
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("the app-only tools in tools/list", () => {
  it("declare visibility [app], take no actor and show no view; the agent's gate tools stay model-visible", async () => {
    const { tools } = await client.listTools();
    for (const name of ["approve_gate_from_view", "request_changes_from_view"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool._meta, name).toEqual({ ui: { visibility: ["app"] } });
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).not.toContain("actor");
      expect(tool.inputSchema.properties?.view, name).toMatchObject({ enum: ["ticket_card", "queue"] });
    }
    for (const name of ["approve_task", "request_changes"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool._meta, name).toBeUndefined();
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).toContain("actor");
    }
  });
});

describe("a person's decision from a view", () => {
  it("falls back to the gate's owner while humanName is unset, never STAPLE_AGENT", async () => {
    setHumanName("");
    const result = await call("approve_gate_from_view", { ref: gates.ownerFallback, view: "ticket_card" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      identifier: gates.ownerFallback,
      gate: { state: "approved", owner: "reviewer", resolvedBy: "reviewer" },
      decision: { by: "reviewer", source: "gate_owner", via: "ticket_card" },
    });
    withStore((store) => {
      expect(store.listComments(gates.ownerFallback).at(-1)).toMatchObject({
        author: "reviewer",
        authorType: "user",
        body: "Approved by reviewer from the ticket card.",
      });
      const id = store.getIssue(gates.ownerFallback).id;
      const approved = store.listEvents(0, 1000).filter((event) => event.issueId === id && event.kind === "gate_approved");
      expect(approved).toHaveLength(1);
      expect(approved[0]).toMatchObject({ actor: "reviewer", payload: { via: "ticket_card", owner: "reviewer" } });
      expect(store.listEvents(0, 1000).filter((event) => event.issueId === id).map((event) => event.actor)).not.toContain(AGENT);
    });
  });

  it("records the configured humanName, from the queue", async () => {
    setHumanName("Mira Lane");
    const result = await call("approve_gate_from_view", { ref: gates.configured, view: "queue" });
    expect(result.structuredContent).toMatchObject({
      gate: { state: "approved", resolvedBy: "Mira Lane" },
      decision: { by: "Mira Lane", source: "config", via: "queue" },
    });
    withStore((store) => {
      expect(store.listComments(gates.configured).at(-1)).toMatchObject({ author: "Mira Lane", authorType: "user", body: "Approved by Mira Lane from the queue." });
      expect(store.gateDecision(gates.configured)).toMatchObject({ state: "approved", by: "Mira Lane", via: "queue" });
    });
  });

  it("ignores a name the caller passes: the tools have no actor", async () => {
    setHumanName("Mira Lane");
    const result = await call("approve_gate_from_view", { ref: gates.actorIgnored, view: "ticket_card", actor: "someone-else" });
    expect(result.structuredContent).toMatchObject({ gate: { resolvedBy: "Mira Lane" }, decision: { by: "Mira Lane" } });
  });

  it("sends back with the person's note, says where it came from, and needs the note", async () => {
    setHumanName("Mira Lane");
    const empty = await call("request_changes_from_view", { ref: gates.sendBack, view: "ticket_card", comment: "   " });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toMatch(/^ERROR\(validation\): Request changes needs a note/);
    const result = await call("request_changes_from_view", { ref: gates.sendBack, view: "ticket_card", comment: "Name the expiry rule." });
    expect(result.structuredContent).toMatchObject({
      gate: { state: "changes_requested", resolvedBy: "Mira Lane" },
      decision: { by: "Mira Lane", source: "config", via: "ticket_card" },
    });
    withStore((store) => {
      expect(store.listComments(gates.sendBack).at(-1)).toMatchObject({
        author: "Mira Lane",
        authorType: "user",
        body: "Name the expiry rule.\n\nSent back by Mira Lane from the ticket card.",
      });
    });
    // The card and its text say who and where.
    const card = await call("show_ticket", { ref: gates.sendBack });
    expect(card.structuredContent).toMatchObject({
      ticket: { decision: { state: "changes_requested", by: "Mira Lane", via: "ticket_card" } },
    });
    expect(text(card)).toContain("Gate changes requested by Mira Lane from the ticket card (owner reviewer).");
  });

  it("refuses an issue with no gate, and an unknown view", async () => {
    const ungated = await call("approve_gate_from_view", { ref: gates.ungated, view: "ticket_card" });
    expect(ungated.isError).toBe(true);
    expect(text(ungated)).toMatch(/^ERROR\(conflict\): .* has no gate to decide\./);
    const unknownView = await call("approve_gate_from_view", { ref: gates.configured, view: "sidebar" });
    expect(unknownView.isError).toBe(true);
  });
});

describe("what the card says about a decision", () => {
  it("drops the decision once the gate is requested again", async () => {
    setHumanName("Mira Lane");
    await call("request_changes_from_view", { ref: gates.regated, view: "ticket_card", comment: "Split it." });
    expect(((await call("show_ticket", { ref: gates.regated })).structuredContent as { ticket: { decision: unknown } }).ticket.decision).toMatchObject({
      state: "changes_requested",
      via: "ticket_card",
    });
    const regate = await call("gate_task", { ref: gates.regated, owner: "reviewer" });
    expect(regate.isError).toBeFalsy();
    const card = await call("show_ticket", { ref: gates.regated });
    expect(card.structuredContent).toMatchObject({ ticket: { gate: { state: "pending" }, decision: null } });
    expect(text(card)).not.toContain("from the ticket card");
  });

  it("never credits a view for a decision whose event is not here (pulled from another device)", async () => {
    setHumanName("Mira Lane");
    await call("approve_gate_from_view", { ref: gates.pulled, view: "ticket_card" });
    // A later decision arrives by sync: the gate columns move, and no event comes with them.
    withStore((store) => {
      store.db
        .prepare("UPDATE issues SET gate_resolved_by = ?, gate_resolved_at = ? WHERE identifier = ?")
        .run("remote-agent", "2099-01-01T00:00:00.000Z", gates.pulled);
    });
    const card = await call("show_ticket", { ref: gates.pulled });
    expect(card.structuredContent).toMatchObject({
      ticket: { gate: { resolvedBy: "remote-agent" }, decision: { state: "approved", by: "remote-agent", via: null } },
    });
    expect(text(card)).toContain("Gate approved by remote-agent (owner reviewer).");
  });

  it("refuses a view decision while config.json is unreadable, rather than guessing the gate's owner", async () => {
    const configFile = join(staple, "config.json");
    const kept = readFileSync(configFile, "utf8");
    writeFileSync(configFile, "{ not json");
    try {
      const result = await call("approve_gate_from_view", { ref: gates.ungated, view: "ticket_card" });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^ERROR\(validation\): .*config\.json is not valid JSON/);
    } finally {
      writeFileSync(configFile, kept);
    }
  });
});

describe("an agent's decision", () => {
  it("approve_task still records the agent, with no view and an agent's comment", async () => {
    setHumanName("Mira Lane");
    const result = await call("approve_task", { ref: gates.agentApprove, comment: "Looks complete." });
    expect(result.structuredContent).toMatchObject({ gate: { state: "approved", resolvedBy: AGENT } });
    withStore((store) => {
      expect(store.listComments(gates.agentApprove).at(-1)).toMatchObject({ author: AGENT, authorType: "agent", body: "Looks complete." });
      expect(store.gateDecision(gates.agentApprove)).toMatchObject({ state: "approved", by: AGENT, via: null });
    });
    const card = await call("show_ticket", { ref: gates.agentApprove });
    expect(card.structuredContent).toMatchObject({ ticket: { decision: { by: AGENT, via: null } } });
    expect(text(card)).toContain(`Gate approved by ${AGENT} (owner reviewer).`);
  });

  it("request_changes still records the agent", async () => {
    const result = await call("request_changes", { ref: gates.agentSendBack, comment: "Add the tests." });
    expect(result.structuredContent).toMatchObject({ gate: { state: "changes_requested", resolvedBy: AGENT } });
    withStore((store) => {
      expect(store.listComments(gates.agentSendBack).at(-1)).toMatchObject({ author: AGENT, authorType: "agent", body: "Add the tests." });
      expect(store.gateDecision(gates.agentSendBack)?.via).toBeNull();
    });
  });
});
