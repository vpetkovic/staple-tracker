/**
 * Anything but derivation that moves a parent's status or its claim takes the status out of
 * derivation's hands, whichever door it comes through (migration 017).
 *
 * Ownership is the column `derived_status`, and the schema clears it; this walks each surface a
 * person or an agent has — the CLI, MCP, the web UI's status action and its gate route, a
 * checkout — and shows both halves: the column is cleared, and a child moving afterwards does
 * not overwrite what that door set.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { WorkspaceStore } from "../src/core/store.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { removeDir, runCliAtAsync, tempDir } from "./fixtures/characterize-support.js";
import { startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let root: string;
let repo: string;
let home: string;
let dbPath: string;
let ui: UiHandle;
let origin: string;
let mcp: McpHarness;
let store: WorkspaceStore;
const saved = process.env.STAPLE_HOME;

beforeAll(async () => {
  root = tempDir("derived-doors");
  home = join(root, "home");
  repo = join(root, "repo");
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir: repo, slug: "doors" });
  dbPath = ws.dbPath;
  ws.store.db.close();
  const db = openDb(dbPath);
  store = new WorkspaceStore(db, "doors", (db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string }).value);
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  mcp = await startMcpClient({ home, cwd: repo, agent: "mcp-agent" });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  store?.db.close();
  if (saved === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = saved;
  removeDir(root);
});

/** An epic whose child started, so derivation put it in progress and owns it. */
function derivedEpic(title: string): { epic: string; child: string } {
  const epic = store.createIssue({ title, kind: "epic" });
  const child = store.createIssue({ title: `${title} child`, parent: epic.id });
  store.updateIssue(child.id, { assignee: "worker" }, "worker");
  store.updateIssue(child.id, { status: "in_progress" }, "worker");
  expect(owned(epic.id)).toEqual({ status: "in_progress", derived_status: "in_progress" });
  return { epic: epic.identifier, child: child.identifier };
}

const owned = (ref: string): unknown =>
  store.db.prepare("SELECT status, derived_status FROM issues WHERE id = ? OR identifier = ?").get(ref, ref);

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });
  expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
}

const DOORS: Array<{ door: string; act: (epic: string) => Promise<unknown>; lands: string }> = [
  {
    door: "the CLI's status",
    act: (epic) => runCliAtAsync(repo, ["status", epic, "in_review", "--db", dbPath, "--json"], { STAPLE_HOME: home, STAPLE_AGENT: "cli-agent" }),
    lands: "in_review",
  },
  { door: "MCP's update_task", act: (epic) => mcp.call("update_task", { ref: epic, status: "in_review" }), lands: "in_review" },
  { door: "the web UI's status action", act: (epic) => post("/api/action", { ref: epic, type: "status", status: "in_review" }), lands: "in_review" },
  { door: "the web UI's gate", act: (epic) => post("/api/gate/request", { ref: epic, owner: "VP" }), lands: "awaiting_approval" },
  {
    door: "the CLI's checkout of an epic derivation put back in backlog",
    act: async (epic) => {
      const child = store.db.prepare("SELECT identifier FROM issues WHERE parent_id = (SELECT id FROM issues WHERE identifier = ?)").get(epic) as { identifier: string };
      store.updateIssue(child.identifier, { status: "todo" }, "worker");
      expect(owned(epic)).toEqual({ status: "backlog", derived_status: "backlog" });
      return runCliAtAsync(repo, ["checkout", epic, "--db", dbPath, "--json"], { STAPLE_HOME: home, STAPLE_AGENT: "cli-agent" });
    },
    lands: "in_progress",
  },
];

describe("a manual move from any door takes the parent out of derivation's hands", () => {
  for (const { door, act, lands } of DOORS) {
    it(door, async () => {
      const { epic, child } = derivedEpic(`through ${door}`);
      await act(epic);
      expect(owned(epic)).toEqual({ status: lands, derived_status: null });
      // The child moves on; the parent keeps what the door set.
      store.updateIssue(child, { status: "done" }, "worker");
      expect((owned(epic) as { status: string }).status).toBe(lands);
    }, 60_000);
  }

  it("while derivation's own move keeps it", () => {
    const { epic, child } = derivedEpic("left to derivation");
    store.updateIssue(child, { status: "done" }, "worker");
    expect(owned(epic)).toEqual({ status: "done", derived_status: "done" });
  });
});
