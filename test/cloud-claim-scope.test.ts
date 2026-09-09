/**
 * `claim.scope` on the EVERYDAY read surfaces — `ls`, `show` and `inbox`.
 *
 * `docs/sync.md`, "Claims: a local checkout is not a global lease":
 *
 *   *"the claim payload grows a scope, and **every surface reports it**"* —
 *   `local` for "this database only, no global exclusivity is claimed", `lease`
 *   for "a server lease is held; the claim is globally exclusive". *"An agent
 *   that reads `local` and behaves as though it read `lease` is the failure this
 *   field exists to prevent."*
 *
 * ## Why this file exists as its own suite
 *
 * STA-74 built `scope` on the LEASE surfaces — `cloud lease status`, and the
 * acquire and release outcomes — and deliberately stopped short of pushing it
 * through `claimActivity` into `ls`, `show` and `inbox`, because that meant
 * editing `store.ts` and moving goldens while three lanes ran concurrently. It
 * flagged the gap rather than hiding it, which left the contract stronger than
 * the build: an agent could read `cloud lease status` and learn the truth, or
 * read `show` — which is what an agent actually calls before starting work — and
 * learn nothing at all.
 *
 * The everyday surfaces are the ones that matter for this field. Nobody runs
 * `cloud lease status` before picking up a ticket; they run `inbox`, or the MCP
 * tool behind it. A scope that is only visible on the surface a careful reader
 * consults is a scope that does not prevent the failure it exists to prevent.
 *
 * ## What the assertions are shaped around
 *
 * Every case pins the NEGATIVE as hard as the positive. `local` is the safe
 * answer and the default, so a bug that returns `local` everywhere would pass a
 * suite that only checked the happy path — and a bug that returns `lease` too
 * eagerly is the one with a real cost. Hence: a lease held by another device, a
 * connection with no lease, and a mirror row on a disconnected machine all get
 * their own test, and all three must say `local`.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { recordLocalLease } from "../src/core/cloud/lease-store.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { runCli, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

const AGENT = "scope-agent";
const DEVICE = "device-here";
const EXPIRES = "2026-09-05T02:00:00.000Z";

let home: string;
let repoDir: string;
let dbPath: string;
let repositoryId: string;
let issueId: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli([...args, "--db", dbPath], { STAPLE_HOME: home, STAPLE_AGENT: AGENT });
}

interface Claim {
  heldBy: string;
  scope: "local" | "lease";
  lease: { fencingToken: number; serverExpiresAt: string } | null;
}

/** The claim as `ls --json` reports it. */
function claimFromLs(): Claim {
  const result = cli("ls", "--json");
  expect(result.status, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as Array<{ id: string; claim: Claim | null }>;
  const row = rows.find((r) => r.id === issueId);
  expect(row, "the held issue is missing from ls").toBeDefined();
  expect(row!.claim, "ls reported no claim on a held issue").not.toBeNull();
  return row!.claim!;
}

/** The claim as `show --json` reports it. */
function claimFromShow(): Claim {
  const result = cli("show", "SCO-1", "--json");
  expect(result.status, result.stderr).toBe(0);
  const body = JSON.parse(result.stdout) as { claim: Claim | null };
  expect(body.claim).not.toBeNull();
  return body.claim!;
}

async function claimFromMcpGetTask(): Promise<Claim> {
  const result = await mcp.call("get_task", { ref: "SCO-1" });
  const body = result.structuredContent as { claim: Claim | null };
  expect(body.claim).not.toBeNull();
  return body.claim!;
}

async function claimFromMcpListTasks(): Promise<Claim> {
  const result = await mcp.call("list_tasks", {});
  // `list_tasks` summaries carry `identifier` rather than the uuid — the summary
  // shape is deliberately the human-facing subset.
  const body = result.structuredContent as {
    items: Array<{ identifier: string; claim: Claim | null }>;
  };
  const row = body.items.find((r) => r.identifier === "SCO-1");
  expect(row?.claim, "list_tasks reported no claim on a held issue").toBeTruthy();
  return row!.claim!;
}

async function claimFromHttpIssue(): Promise<Claim> {
  const res = await fetch(`${origin}/api/issue?ref=SCO-1`, {
    headers: { "x-staple-token": token },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { claim: Claim | null };
  expect(body.claim).not.toBeNull();
  return body.claim!;
}

/** Every everyday read surface, so a scope that reaches only some of them fails. */
async function everySurface(): Promise<Claim[]> {
  return [
    claimFromLs(),
    claimFromShow(),
    await claimFromMcpGetTask(),
    await claimFromMcpListTasks(),
    await claimFromHttpIssue(),
  ];
}

function connect(): void {
  const dir = join(home, "cloud");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
  writeFileSync(
    join(dir, `${repositoryId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      repositoryId,
      endpoint: "https://staple-sync-dev.example.workers.dev",
      deviceId: DEVICE,
      label: "laptop",
      credentialMechanism: "file",
      connectedAt: "2026-09-05T00:00:00.000Z",
      protocol: 1,
      auto: false,
      backup: false,
    }),
    { mode: 0o600 },
  );
}

const disconnect = () => rmSync(join(home, "cloud"), { recursive: true, force: true });

/** Plant a mirror row for `issueId`, held by whichever device is named. */
function plantLease(deviceId: string, fencingToken = 7): void {
  const db = openDb(dbPath);
  try {
    recordLocalLease(db, {
      entityId: issueId,
      fencingToken,
      holder: AGENT,
      deviceId,
      serverExpiresAt: EXPIRES,
      acquiredAt: "2026-09-05T01:00:00.000Z",
      renewedAt: null,
    });
  } finally {
    db.close();
  }
}

function clearLeases(): void {
  const db = openDb(dbPath);
  try {
    db.prepare("DELETE FROM sync_leases").run();
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-scope-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-scope-repo-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ dir: repoDir, slug: "scope" });
  const issue = ws.store.createIssue({ title: "A task somebody is working on" });
  issueId = issue.id;
  repositoryId = readStoredRepositoryId(ws.store.db)!;
  ws.store.db.close();
  dbPath = join(repoDir, ".staple", "staple.db");

  // Held, because `claimActivity` is null for anything nobody holds.
  expect(cli("checkout", "SCO-1", "--agent", AGENT).status).toBe(0);

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

beforeEach(() => {
  disconnect();
  clearLeases();
});

// ---------------------------------------------------------------- local-only

describe("an unconnected workspace says local, everywhere", () => {
  it("reports scope local and no lease on ls, show, MCP and HTTP", async () => {
    for (const claim of await everySurface()) {
      expect(claim.heldBy).toBe(AGENT);
      expect(claim.scope).toBe("local");
      expect(claim.lease).toBeNull();
    }
  });

  /**
   * The failure mode this whole field exists to prevent, from its most dangerous
   * angle: a mirror row left behind by a connection that has since been removed.
   * *"a mirror row on a disconnected machine is a memory of one, which is worth
   * less than nothing if it is allowed to read as a fact."*
   */
  it("a leftover lease row on a DISCONNECTED machine is still only local", async () => {
    plantLease(DEVICE);
    for (const claim of await everySurface()) {
      expect(claim.scope).toBe("local");
      expect(claim.lease).toBeNull();
    }
  });

  it("inbox reports scope too, so an agent picking up work sees it", async () => {
    const result = await mcp.call("inbox", {});
    const body = result.structuredContent as {
      ready: Array<{ id: string; claim?: Claim | null }>;
      blocked: Array<{ id: string; claim?: Claim | null }>;
    };
    const rows = [...body.ready, ...body.blocked].filter((r) => r.claim);
    // The held issue is the only claim in this workspace, wherever inbox files it.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.claim!.scope).toBe("local");
      expect(row.claim!.lease).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- the upgrade

describe("a connected workspace holding the lease says lease, everywhere", () => {
  it("reports scope lease with the fencing token and the SERVER's expiry", async () => {
    connect();
    plantLease(DEVICE, 7);
    for (const claim of await everySurface()) {
      expect(claim.scope).toBe("lease");
      expect(claim.lease).toEqual({ fencingToken: 7, serverExpiresAt: EXPIRES });
    }
  });

  /**
   * A connection is permission to become exclusive, not exclusivity itself.
   * *"a connection without a lease is a repository that could be exclusive and
   * is not."*
   */
  it("connected with no lease row is local — connecting is not claiming", async () => {
    connect();
    for (const claim of await everySurface()) {
      expect(claim.scope).toBe("local");
      expect(claim.lease).toBeNull();
    }
  });

  /**
   * The other device's lease. This is the case that would let an agent conclude
   * it holds global exclusivity while a different machine actually does — the
   * exact inversion the field exists to prevent, and the one a naive
   * "is there a lease row?" check would get wrong.
   */
  it("a lease held by ANOTHER device reads as local here, not as ours", async () => {
    connect();
    plantLease("device-there", 9);
    for (const claim of await everySurface()) {
      expect(claim.scope).toBe("local");
      expect(claim.lease).toBeNull();
    }
  });

  /** Disconnecting must downgrade the answer immediately, not at the next sync. */
  it("disconnecting downgrades a lease back to local with no sync in between", async () => {
    connect();
    plantLease(DEVICE);
    expect(claimFromShow().scope).toBe("lease");

    disconnect();
    for (const claim of await everySurface()) {
      expect(claim.scope).toBe("local");
      expect(claim.lease).toBeNull();
    }
  });
});

// -------------------------------------------------------------- batch parity

describe("the batched and single-issue paths cannot disagree", () => {
  /**
   * `ls` uses `claimActivityFor` (one resolver for a whole page) and `show` uses
   * `claimActivityOfRow` (one for a single issue). They are different code paths
   * over the same question, which is exactly where a scope that is right on the
   * detail surface and wrong on the list would come from — and the list is the
   * surface an agent scans.
   */
  it("ls and show agree on scope in every arrangement", async () => {
    for (const arrange of [
      () => {},
      () => connect(),
      () => {
        connect();
        plantLease(DEVICE);
      },
      () => {
        connect();
        plantLease("device-there");
      },
      () => plantLease(DEVICE),
    ]) {
      disconnect();
      clearLeases();
      arrange();
      /**
       * Scope and lease only. `heldSeconds` and `idleSeconds` are read against
       * the clock at response time and these are two separate CLI invocations,
       * so a whole-object equality here would be asserting that two processes
       * started in the same millisecond — a flake, not a contract.
       */
      const fromLs = claimFromLs();
      const fromShow = claimFromShow();
      expect({ scope: fromLs.scope, lease: fromLs.lease }).toEqual({
        scope: fromShow.scope,
        lease: fromShow.lease,
      });
    }
  });
});
