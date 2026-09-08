/**
 * One cloud state, four surfaces, one contract.
 *
 * *"CLI MCP HTTP and UI derive status and error data from one typed contract."*
 * The risk is not that a surface is missing — all four existed before STA-75.
 * It is that they each held their own copy of the mapping: `src/mcp.ts` built a
 * nine-field object literal, `/api/cloud/status` built the same nine plus a
 * `hint`, and each wrote its own sentence for "this workspace has no sync
 * identity". Nothing was broken; the shape simply guaranteed that eventually
 * something would be, one surface at a time.
 *
 * So the assertions here are mostly EQUALITY BETWEEN SURFACES rather than
 * equality against a golden. A golden per surface would have passed just as
 * happily before this ticket, with three subtly different goldens.
 *
 * ## Division of labour with the other two files
 *
 * - `test/cloud-surface-contract.test.ts` owns the SEMANTICS — is `mode` right,
 *   does `offline` carry a remedy, does a disconnected repository report zeroes.
 *   It reaches states no surface can produce locally, by handing the builder a
 *   synthesized `CloudStatus`.
 * - This file owns AGREEMENT — given one workspace, do the surfaces say the same
 *   thing. It deliberately does not re-assert semantics: a parity suite that also
 *   owned meaning would pass with all four surfaces agreeing on a wrong answer,
 *   which is the classic failure of "do these match?" tests.
 * - `test/network-silence.test.ts` owns SILENCE.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { asStructured, runCli, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

const AGENT = "cloud-surface-agent";
const ENDPOINT = "https://staple-sync-dev.example.workers.dev";
const DEVICE = "device-here";

let home: string;
let repoDir: string;
let dbPath: string;
let repositoryId: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli([...args, "--db", dbPath], { STAPLE_HOME: home, STAPLE_AGENT: AGENT });
}

/** `staple cloud status --json` — the CLI's projection of the report. */
function cliReport(): Record<string, unknown> {
  const result = cli("cloud", "status", "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function mcpReport(): Promise<Record<string, unknown>> {
  const result = await mcp.call("cloud_status", {});
  // `structuredContent`, not the text block: the text block is a rendering for a
  // model to read, and this file is about the machine-readable contract.
  return asStructured(result.structuredContent);
}

async function httpReport(): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin}/api/cloud/status`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Forge a connection record and a credential.
 *
 * Written directly rather than by connecting for real, for the reason
 * `network-silence.test.ts` gives about the same fixture: connecting for real
 * would need a server, and every question here is about what the surfaces say
 * when there is nobody being talked to.
 */
function connect(over: { auto?: boolean; backup?: boolean; credential?: boolean } = {}): void {
  const dir = join(home, "cloud");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dir, `${repositoryId}.token`);
  if (over.credential === false) rmSync(tokenPath, { force: true });
  else writeFileSync(tokenPath, "stpl_fake\n", { mode: 0o600 });
  writeFileSync(
    join(dir, `${repositoryId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      repositoryId,
      endpoint: ENDPOINT,
      deviceId: DEVICE,
      label: "laptop",
      credentialMechanism: "file",
      connectedAt: "2026-09-05T00:00:00.000Z",
      protocol: 1,
      auto: over.auto === true,
      backup: over.backup === true,
    }),
    { mode: 0o600 },
  );
}

function disconnect(): void {
  rmSync(join(home, "cloud"), { recursive: true, force: true });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-cloudsurf-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-cloudsurf-repo-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  // Repo-local, so a repository.json is minted and `sync_state.repository_id`
  // recorded — the two places the three surfaces read identity from.
  const ws = initWorkspace({ dir: repoDir, slug: "cloudsurf" });
  ws.store.createIssue({ title: "A held task" });
  repositoryId = readStoredRepositoryId(ws.store.db)!;
  ws.store.db.close();
  dbPath = join(repoDir, ".staple", "staple.db");

  // The MCP server discovers the workspace by walking up from its cwd.
  mcp = await startMcpClient({ home, cwd: repoDir, agent: AGENT });
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- parity

/**
 * The states a machine can reach without a server.
 *
 * `offline` and `revoked` are absent for an honest reason rather than an
 * oversight: both are answers a SERVER gives, reachable only through
 * `refreshCloudStatus`, and manufacturing them here would mean either a real
 * network call — which this repository's whole invariant forbids in a test that
 * is not explicitly about the wire — or a fake server, which would be testing
 * the transport instead of the surfaces. Their semantics, including that each
 * carries an actionable remedy, are pinned in
 * `test/cloud-surface-contract.test.ts` against the same builder all three
 * surfaces call. The "identical, key for key" test below is what carries that
 * coverage across the surface boundary: three renderings that agree on every
 * reachable state, and that are the same function, cannot disagree on an
 * unreachable one.
 */
const STATES: Array<[name: string, arrange: () => void, expected: string, mode: string]> = [
  ["disconnected", () => disconnect(), "disconnected", "disconnected"],
  ["manual", () => connect(), "manual", "manual"],
  ["automatic", () => connect({ auto: true }), "automatic", "automatic"],
  ["auth_failed", () => connect({ credential: false }), "auth_failed", "manual"],
];

describe("every surface reports the same state", () => {
  for (const [name, arrange, expected, mode] of STATES) {
    it(`${name}: CLI, MCP and HTTP agree, key for key`, async () => {
      arrange();
      const [fromCli, fromMcp, fromHttp] = [cliReport(), await mcpReport(), await httpReport()];

      expect(fromCli.state).toBe(expected);
      expect(fromCli.mode).toBe(mode);

      /**
       * Whole-object equality, not a field spot-check. A spot-check is what
       * allowed three surfaces to drift in the first place: each one was
       * individually correct about the fields its own suite happened to name.
       */
      expect(fromMcp).toEqual(fromCli);
      expect(fromHttp).toEqual(fromCli);
    });
  }

  it("the three surfaces expose the same key set, so none can grow a private field", async () => {
    connect();
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    const fromCli = keys(cliReport());
    expect(keys(await mcpReport())).toEqual(fromCli);
    expect(keys(await httpReport())).toEqual(fromCli);
    // The `hint` that `/api/cloud/status` used to add for itself is now on the
    // contract, so the HTTP payload is no longer a superset of the other two.
    expect(fromCli).toContain("hint");
  });
});

// ------------------------------------------------------------- the counters

describe("the numbers the criteria name reach every surface", () => {
  it("pending, cursor, epoch, device and mode are reported identically", async () => {
    connect();
    const { openDb } = await import("../src/core/db.js");
    const db = openDb(dbPath);
    try {
      db.prepare(
        `UPDATE sync_state SET cursor = 'cur-11', epoch = 5,
                last_sync_at = '2026-09-05T03:00:00.000Z' WHERE id = 1`,
      ).run();
    } finally {
      db.close();
    }

    for (const report of [cliReport(), await mcpReport(), await httpReport()]) {
      expect(report.cursor).toBe("cur-11");
      expect(report.epoch).toBe(5);
      expect(report.lastSyncAt).toBe("2026-09-05T03:00:00.000Z");
      expect(report.pending).toBe(0);
      expect(report.deviceId).toBe(DEVICE);
      expect(report.mode).toBe("manual");
    }
  });

  /**
   * A conflict is local data, so it is visible in EVERY cloud state — including
   * disconnected. A repository that synced and was then disconnected still holds
   * its unsettled decisions, and hiding them behind a connection check would
   * make a pending human decision invisible for as long as the credential was
   * gone.
   */
  it("open conflicts are counted on every surface, disconnected included", async () => {
    disconnect();
    const { openDb } = await import("../src/core/db.js");
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO sync_conflicts
           (id, entity, entity_id, field, base_value, local_value, remote_value,
            local_op_id, remote_op_id, local_device_id, remote_device_id,
            local_at, remote_at, detected_at)
         VALUES ('surf-1','issue','i1','title','"b"','"l"','"r"','op-l','op-r',
                 'device-here','device-there','2026-09-05T00:00:00.000Z',
                 '2026-09-05T00:00:01.000Z','2026-09-05T00:00:02.000Z')`,
      ).run();
    } finally {
      db.close();
    }

    for (const report of [cliReport(), await mcpReport(), await httpReport()]) {
      expect(report.state).toBe("disconnected");
      expect(report.conflicts).toEqual({ open: 1, resolved: 0 });
    }

    const db2 = openDb(dbPath);
    try {
      db2.prepare("DELETE FROM sync_conflicts WHERE id = 'surf-1'").run();
    } finally {
      db2.close();
    }
  });
});

// ------------------------------------------------------- the human rendering

describe("the CLI's human output is the same report, rendered", () => {
  it("names mode, device, pending, cursor and epoch", () => {
    connect();
    const result = cli("cloud", "status");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("manual");
    expect(result.stdout).toContain(DEVICE);
    expect(result.stdout).toMatch(/pending\s+0/);
  });

  it("a disconnected repository gets the static hint and no probe", () => {
    disconnect();
    const result = cli("cloud", "status");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("not connected");
    expect(result.stdout).toContain("staple cloud connect");
    // `checked` false is the assertion that nothing was asked of anybody.
    expect(result.stdout).toContain("local files only");
  });

  it("an actionable failure prints its remedy, not just its name", () => {
    connect({ credential: false });
    const result = cli("cloud", "status");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("NOT FOUND");
    expect(result.stdout).toContain("Re-connect with `staple cloud connect`");
  });
});
