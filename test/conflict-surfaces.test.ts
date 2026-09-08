/**
 * One conflict, three surfaces, one contract.
 *
 * *"Core CLI MCP and HTTP expose one typed conflict and resolution contract."*
 * The risk this pins is not that a surface is missing, it is that three surfaces
 * quietly grow three opinions — one that defaults `--take`, one that lets a
 * second resolution overwrite the first, one that reports the sides the other
 * way round. Every refusal below is asserted on the surface that could plausibly
 * soften it.
 *
 * The conflict itself is created through the core, not through a fake sync
 * service: `cloud-conflicts.test.ts` owns proving that two devices produce one,
 * and repeating that here would test the transport three more times instead of
 * testing the surfaces once.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { listConflicts, type ConflictRecord } from "../src/core/cloud/conflicts.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  REPO_ROOT,
  asStructured,
  mcpEnvelope,
  runCli,
  startMcpClient,
  type McpHarness,
} from "./fixtures/contract-support.js";

const WS = "conflictsurf";
const AGENT = "surface-agent";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let dbPath: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: AGENT });
}

/**
 * Plant one conflict directly in the table.
 *
 * A conflict is a durable record, not a transient of the sync run that produced
 * it — every surface reads it back from `sync_conflicts` and nothing else — so a
 * row is a complete and honest fixture here.
 */
function plant(entityId: string, field: string, local: unknown, remote: unknown, id: string): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO sync_conflicts
         (id, entity, entity_id, field, base_value, local_value, remote_value,
          local_op_id, remote_op_id, local_device_id, remote_device_id,
          local_at, remote_at, detected_at)
       VALUES (?, 'issue', ?, ?, ?, ?, ?, 'op-local', 'op-remote', 'device-here',
               'device-there', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z',
               '2026-09-05T00:00:02.000Z')`,
    ).run(
      id,
      entityId,
      field,
      JSON.stringify("The shared base"),
      JSON.stringify(local),
      JSON.stringify(remote),
    );
  } finally {
    db.close();
  }
}

function issueId(ref: string): string {
  const opened = resolveWorkspace({ ws: WS });
  try {
    return (
      opened.store.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(ref) as {
        id: string;
      }
    ).id;
  } finally {
    opened.store.db.close();
  }
}

function conflicts(): ConflictRecord[] {
  const opened = resolveWorkspace({ ws: WS });
  try {
    return listConflicts(opened.store.db, { includeResolved: true });
  } finally {
    opened.store.db.close();
  }
}

function get(path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-staple-token": token,
      origin,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-conflict-surface-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  expect(cli("new", "A task two devices both edited", "--ws", WS).status).toBe(0);
  expect(cli("new", "A task nobody argued about", "--ws", WS).status).toBe(0);
  dbPath = resolveWorkspace({ ws: WS }).dbPath;
  const opened = resolveWorkspace({ ws: WS });
  opened.store.db.close();

  ui = startUiServer({ port: 0, hub: false, ws: WS });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the CLI", () => {
  it("says so plainly when there is nothing contested", () => {
    const result = cli("cloud", "conflicts", "--ws", WS);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No open conflicts.");
  });

  it("shows both values with equal weight and names neither as current", () => {
    plant(issueId("CON-1"), "title", "Title from here", "Title from there", "cli-conflict");
    const result = cli("cloud", "conflicts", "--ws", WS);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Title from here");
    expect(result.stdout).toContain("Title from there");
    // The word that would imply a winner appears nowhere.
    expect(result.stdout.toLowerCase()).not.toContain("current");
    expect(result.stdout.toLowerCase()).not.toContain("winner");
  });

  it("refuses to resolve without a choice rather than defaulting to one", () => {
    const result = cli("cloud", "resolve", "cli-conflict", "--ws", WS, "--json");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Nothing chosen");
  });

  it("refuses --take and --value together, because they are two decisions", () => {
    const result = cli(
      "cloud",
      "resolve",
      "cli-conflict",
      "--take",
      "local",
      "--value",
      "a third",
      "--ws",
      WS,
      "--json",
    );
    expect(result.status).toBe(2);
  });

  it("refuses a --take that is not a side", () => {
    const result = cli("cloud", "resolve", "cli-conflict", "--take", "newest", "--ws", WS, "--json");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("newest");
  });

  it("resolves, writes the value, and keeps the record", () => {
    const result = cli("cloud", "resolve", "cli-conflict", "--take", "remote", "--ws", WS, "--json");
    expect(result.status).toBe(0);
    const outcome = JSON.parse(result.stdout) as { changed: boolean; conflict: ConflictRecord };
    expect(outcome.changed).toBe(true);
    expect(outcome.conflict.resolvedValue).toBe("Title from there");

    const record = conflicts().find((c) => c.id === "cli-conflict")!;
    expect(record.resolvedBy).toBe(AGENT);
    expect(record.localValue).toBe("Title from here");
    expect(record.remoteValue).toBe("Title from there");
    expect(record.resolvedChoice).toBe("remote");
  });

  it("is idempotent, and refuses to overturn what it already settled", () => {
    const again = cli("cloud", "resolve", "cli-conflict", "--take", "remote", "--ws", WS, "--json");
    expect(again.status).toBe(0);
    expect((JSON.parse(again.stdout) as { changed: boolean }).changed).toBe(false);

    const different = cli("cloud", "resolve", "cli-conflict", "--take", "local", "--ws", WS, "--json");
    expect(different.status).toBe(4);
    expect(different.stderr).toContain("already resolved");
  });

  it("hides settled conflicts by default and keeps them under --all", () => {
    expect(cli("cloud", "conflicts", "--ws", WS).stdout).toContain("No open conflicts.");
    expect(cli("cloud", "conflicts", "--all", "--ws", WS).stdout).toContain("cli-conflict");
  });
});

describe("the HTTP API", () => {
  it("serves the same records the core does", async () => {
    plant(issueId("CON-2"), "priority", "high", "low", "http-conflict");
    const response = await get(`/api/cloud/conflicts?ws=${WS}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conflicts: ConflictRecord[] };
    const found = body.conflicts.find((c) => c.id === "http-conflict")!;
    expect(found.localValue).toBe("high");
    expect(found.remoteValue).toBe("low");
    expect(found.field).toBe("priority");
    // Open only, by default — the same rule the CLI applies.
    expect(body.conflicts.some((c) => c.id === "cli-conflict")).toBe(false);
    const all = (await (await get(`/api/cloud/conflicts?ws=${WS}&all=1`)).json()) as {
      conflicts: ConflictRecord[];
    };
    expect(all.conflicts.some((c) => c.id === "cli-conflict")).toBe(true);
  });

  it("refuses a resolve with neither a side nor a value", async () => {
    const response = await post("/api/cloud/conflicts/resolve", { id: "http-conflict", ws: WS });
    expect(response.status).toBe(400);
  });

  it("refuses a resolve with both", async () => {
    const response = await post("/api/cloud/conflicts/resolve", {
      id: "http-conflict",
      take: "local",
      value: "urgent",
      ws: WS,
    });
    expect(response.status).toBe(400);
  });

  it("is a POST-only route, and a GET on it is not a read", async () => {
    const response = await get(`/api/cloud/conflicts/resolve?ws=${WS}`);
    expect(response.status).toBe(405);
  });

  it("rejects a cross-origin resolve, because it is a write", async () => {
    const response = await fetch(`${origin}/api/cloud/conflicts/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-staple-token": token,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ id: "http-conflict", take: "local", ws: WS }),
    });
    expect(response.status).toBe(403);
  });

  it("resolves and attributes it", async () => {
    const response = await post("/api/cloud/conflicts/resolve", {
      id: "http-conflict",
      take: "remote",
      actor: "someone-at-the-page",
      ws: WS,
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { conflict: ConflictRecord; changed: boolean };
    expect(outcome.changed).toBe(true);
    expect(outcome.conflict.resolvedBy).toBe("someone-at-the-page");
    expect(outcome.conflict.resolvedValue).toBe("low");
  });

  it("projects the core's refusal, with the core's wording", async () => {
    const response = await post("/api/cloud/conflicts/resolve", {
      id: "http-conflict",
      take: "local",
      ws: WS,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("conflict");
    expect(body.message).toContain("already resolved");
  });

  it("answers not_found for a conflict nobody has", async () => {
    const response = await post("/api/cloud/conflicts/resolve", {
      id: "never-existed",
      take: "local",
      ws: WS,
    });
    expect(response.status).toBe(404);
  });
});

describe("MCP", () => {
  let mcp: McpHarness;

  beforeAll(async () => {
    mcp = await startMcpClient({ home, cwd: REPO_ROOT, agent: AGENT });
  }, 40_000);

  afterAll(async () => {
    await mcp?.close();
  });

  it("lists the same records, wrapped as items", async () => {
    plant(issueId("CON-1"), "assignee", "someone", "somebody-else", "mcp-conflict");
    const result = await mcp.call("conflict_list", { ws: WS });
    expect(result.isError).toBeFalsy();
    const { items } = result.structuredContent as { items: ConflictRecord[] };
    const found = items.find((c) => c.id === "mcp-conflict")!;
    expect(found.localValue).toBe("someone");
    expect(found.remoteValue).toBe("somebody-else");
    expect(found.baseValue).toBe("The shared base");
    expect(found.remoteDeviceId).toBe("device-there");
    // The text block parses to the same payload every other tool promises.
    expect(asStructured(JSON.parse(result.content[0]!.text!))).toEqual(result.structuredContent);
  });

  it("gives an agent no way to avoid deciding", async () => {
    const neither = await mcp.call("conflict_resolve", { id: "mcp-conflict", ws: WS });
    expect(neither.isError).toBe(true);
    expect(mcpEnvelope(neither).code).toBe("validation");

    const both = await mcp.call("conflict_resolve", {
      id: "mcp-conflict",
      take: "local",
      value: "a third",
      ws: WS,
    });
    expect(both.isError).toBe(true);
    expect(mcpEnvelope(both).code).toBe("validation");
  });

  it("resolves, attributing the agent that decided", async () => {
    const result = await mcp.call("conflict_resolve", {
      id: "mcp-conflict",
      take: "remote",
      ws: WS,
    });
    expect(result.isError).toBeFalsy();
    const outcome = result.structuredContent as { conflict: ConflictRecord; changed: boolean };
    expect(outcome.changed).toBe(true);
    expect(outcome.conflict.resolvedBy).toBe(AGENT);
    expect(outcome.conflict.resolvedValue).toBe("somebody-else");
  });

  it("refuses a second, different decision with the core's own sentence", async () => {
    const result = await mcp.call("conflict_resolve", {
      id: "mcp-conflict",
      take: "local",
      ws: WS,
    });
    expect(result.isError).toBe(true);
    const envelope = mcpEnvelope(result);
    expect(envelope.code).toBe("conflict");
    expect(String(envelope.message)).toContain("already resolved");
  });

  it("has no tool that settles conflicts in bulk", async () => {
    const names = (await mcp.listTools()).map((t) => t.name);
    expect(names).toContain("conflict_list");
    expect(names).toContain("conflict_resolve");
    // A "resolve everything, prefer the newest" tool would be last-write-wins
    // wearing an agent's name. There is deliberately no such thing.
    expect(names.filter((n) => n.startsWith("conflict_"))).toEqual([
      "conflict_list",
      "conflict_resolve",
    ]);
  });
});
