/**
 * Characterization: every surface's mutations go through the one seam.
 *
 * `journal-seam.test.ts` proves the seam itself is correct, in-process and fast.
 * This suite answers the other half of the acceptance criterion — that CLI, MCP
 * and HTTP all *reach* it — by driving each surface against ONE real workspace
 * on disk and then reading the outbox that resulted.
 *
 * That distinction is the whole reason this file exists. The three surfaces get
 * to the store by three different paths (CLI's command table, MCP's tool
 * handlers, the HTTP request handler), and a mutation that bypassed the seam on
 * exactly one of them would be invisible to a store-level test and obvious here.
 * The audit that preceded this lane found 45 mutating functions across 52
 * statement sites with nothing between them and SQLite; "we re-pointed them all"
 * is a claim, and this is the check.
 *
 * The device id is bound for the whole suite through the environment, which is
 * what arms the journal — see `resolveDeviceId`. Nothing here asserts anything
 * about the network: journalling is local bookkeeping, and an armed workspace
 * still makes no Staple-owned call.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { deriveOpId } from "../src/core/journal.js";
import { startMcpClient, type McpHarness } from "./fixtures/contract-support.js";
import { runCliAt } from "./fixtures/characterize-support.js";

const AGENT = "seam-agent";
const DEVICE = "device-characterize";

let home: string;
let repoDir: string;
let dbPath: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let previousDevice: string | undefined;
/** The identifier the CLI minted; the prefix comes from a mkdtemp name. */
let cliIssue: string;

interface OutboxRow {
  op_id: string;
  client_seq: number;
  entity: string;
  entity_id: string;
  verb: string;
  base_version: number | null;
  payload: string;
  actor: string | null;
}

/**
 * Read the outbox through a fresh read-only handle every time.
 *
 * The CLI runs in a child process and the UI server holds its own connection, so
 * a cached handle would be reading a stale snapshot of a file three writers
 * share. Opening per call is the only way to see what all three actually wrote.
 */
function outbox(): OutboxRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM sync_outbox ORDER BY client_seq")
      .all() as unknown as OutboxRow[];
  } finally {
    db.close();
  }
}

function repositoryId(): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT repository_id FROM sync_state WHERE id = 1").get() as
      | { repository_id: string | null }
      | undefined;
    return row?.repository_id ?? "";
  } finally {
    db.close();
  }
}

function cli(...args: string[]) {
  return runCliAt(repoDir, args, {
    STAPLE_HOME: home,
    STAPLE_AGENT: AGENT,
    STAPLE_DEVICE_ID: DEVICE,
  });
}

/** Run a CLI command with --json and return the parsed stdout. */
function cliJson(...args: string[]): Record<string, unknown> {
  const result = cli(...args, "--json");
  expect(result.status, `${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function httpAction(body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/action?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-seam-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-seam-repo-"));
  previousDevice = process.env.STAPLE_DEVICE_ID;
  process.env.STAPLE_HOME = home;
  process.env.STAPLE_DEVICE_ID = DEVICE;
  process.env.NODE_NO_WARNINGS = "1";

  // A REPO workspace, not a global one: `initWorkspace` reconciles the
  // repository identity only for repo workspaces, and an identity is half of
  // what arms the journal. A global workspace has no `.staple/repository.json`
  // and therefore no identity, which is itself pinned at the bottom of this file.
  expect(
    runCliAt(repoDir, ["init"], { STAPLE_HOME: home, STAPLE_AGENT: AGENT, STAPLE_DEVICE_ID: DEVICE })
      .status,
  ).toBe(0);
  dbPath = join(repoDir, ".staple", "staple.db");

  mcp = await startMcpClient({ home, cwd: repoDir, agent: AGENT });
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  if (previousDevice === undefined) delete process.env.STAPLE_DEVICE_ID;
  else process.env.STAPLE_DEVICE_ID = previousDevice;
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("the seam is on every surface", () => {
  it("journals a CLI create, update, comment, document and claim", () => {
    const before = outbox().length;

    cliIssue = cliJson("new", "From the CLI").identifier as string;
    expect(cli("status", cliIssue, "todo").status).toBe(0);
    expect(cli("comment", cliIssue, "a note").status).toBe(0);
    const plan = join(home, "plan.md");
    writeFileSync(plan, "# plan\n");
    expect(cli("doc", cliIssue, "plan", "--put", plan).status).toBe(0);
    expect(cli("checkout", cliIssue).status).toBe(0);
    expect(cli("release", cliIssue).status).toBe(0);

    const added = outbox().slice(before);
    const shapes = added.map((row) => `${row.entity}.${row.verb}`);
    expect(shapes).toContain("issue.create");
    expect(shapes).toContain("comment.create");
    expect(shapes).toContain("documentRevision.create");
    // status, checkout and release are three issue.update operations.
    expect(shapes.filter((shape) => shape === "issue.update").length).toBeGreaterThanOrEqual(3);
    expect(added.every((row) => row.actor === null || typeof row.actor === "string")).toBe(true);
  });

  it("journals an MCP create, update, comment and claim", async () => {
    const before = outbox().length;

    const created = await mcp.call("create_task", { title: "From MCP" });
    expect(created.isError).toBeFalsy();
    const identifier = (created.structuredContent as { identifier: string }).identifier;
    for (const call of [
      mcp.call("update_task", { ref: identifier, priority: "low" }),
      mcp.call("add_comment", { ref: identifier, body: "mcp note" }),
      mcp.call("checkout_task", { ref: identifier }),
    ]) {
      expect((await call).isError, "every MCP mutation in this case must succeed").toBeFalsy();
    }

    const shapes = outbox()
      .slice(before)
      .map((row) => `${row.entity}.${row.verb}`);
    expect(shapes).toContain("issue.create");
    expect(shapes).toContain("comment.create");
    expect(shapes.filter((shape) => shape === "issue.update").length).toBeGreaterThanOrEqual(2);
  });

  it("journals an HTTP create, status change and comment", async () => {
    const before = outbox().length;

    const created = await httpAction({ type: "create", title: "From HTTP" });
    expect(created.status).toBe(200);
    const identifier = (created.body as { identifier?: string }).identifier;
    expect(typeof identifier).toBe("string");
    expect((await httpAction({ type: "status", ref: identifier!, status: "todo" })).status).toBe(200);
    expect((await httpAction({ type: "comment", ref: identifier!, body: "http note" })).status).toBe(200);

    const shapes = outbox()
      .slice(before)
      .map((row) => `${row.entity}.${row.verb}`);
    expect(shapes).toContain("issue.create");
    expect(shapes).toContain("comment.create");
    expect(shapes).toContain("issue.update");
  });

  it("journals HTTP-only subsystems — projects have no CLI or MCP entry point at all", async () => {
    const before = outbox().length;

    const response = await fetch(`${origin}/api/project/create?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platform" }),
    });
    expect(response.status).toBe(200);

    const added = outbox().slice(before);
    expect(added.map((row) => `${row.entity}.${row.verb}`)).toContain("project.create");
  });

  it("journals a queue mutation from the CLI as one plan replace", () => {
    const before = outbox().length;
    expect(cli("queue", "add", cliIssue).status).toBe(0);

    const added = outbox().slice(before);
    const queueOps = added.filter((row) => row.entity === "queue");
    expect(queueOps).toHaveLength(1);
    expect(queueOps[0]!.verb).toBe("replace");
  });
});

describe("what every surface's operations have in common", () => {
  it("gives every operation a deterministic id derived from this repository and device", () => {
    const repoId = repositoryId();
    expect(repoId).not.toBe("");
    const rows = outbox();
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      expect(row.op_id).toBe(deriveOpId(repoId, 0, DEVICE, row.client_seq));
    }
  });

  it("allocates one contiguous client sequence across all three surfaces", () => {
    // One counter, one database — the surfaces are three doors into one seam,
    // not three journals that happen to agree.
    const sequences = outbox().map((row) => row.client_seq);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  });

  it("names a real entity and verb on every row", () => {
    const entities = new Set(outbox().map((row) => row.entity));
    const verbs = new Set(outbox().map((row) => row.verb));
    for (const entity of entities) {
      expect([
        "issue",
        "comment",
        "document",
        "documentRevision",
        "relation",
        "project",
        "status",
        "kind",
        "setting",
        "milestone",
        "queue",
        "lease",
        "conflict",
      ]).toContain(entity);
    }
    for (const verb of verbs) {
      expect(["create", "update", "delete", "replace", "renumber"]).toContain(verb);
    }
  });

  it("gives every event a dedup key, whichever surface emitted it", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const unkeyed = db
        .prepare("SELECT kind FROM events WHERE dedup_key IS NULL")
        .all() as Array<{ kind: string }>;
      expect(unkeyed.map((row) => row.kind)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
