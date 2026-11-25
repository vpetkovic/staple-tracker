import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { ProbeCache, HEALTH_POLL_INTERVAL_SECONDS } from "../src/core/integrations/health.js";
import type { ConnectionHealthSnapshot, ExternalItem, IntegrationAdapter } from "../src/core/integrations/contracts.js";
import type { GhRunner } from "../src/core/integrations/gh-process.js";
import { StapleError } from "../src/core/types.js";

const item: ExternalItem = { ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: "1", kind: "issue" },
  key: "team/repo#1", url: "https://github.com/team/repo/issues/1", title: "Remote", body: null, status: null, fetchedAt: "2026-11-23T12:00:00Z" };
const AUTH_STATUS = "github.com\n  ✓ Logged in to github.com account vpetkovic (keyring)\n  - Active account: true\n  - Token: gho_****\n";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

function setup(options: { liveReadsAvailable?: boolean; gh?: GhRunner } = {}) {
  const home = mkdtempSync(join(tmpdir(), "staple-integration-health-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "health-tests" });
  let clock = 1_000_000;
  const adapter: IntegrationAdapter = { scope: { providerId: "github", host: "github.com", scopeId: "host" }, label: "GitHub", connection: { id: "work", mode: "cli" },
    validate: vi.fn(async () => ({ state: "ready" as const, identity: { login: "vpetkovic" } })), listContainers: vi.fn(async () => ({ items: [], nextCursor: null })), readContainer: vi.fn(async (id: string) => ({ id, name: "team/repo", url: "https://github.com/team/repo" })),
    searchIssues: vi.fn(async () => ({ items: [item], nextCursor: null })), resolve: vi.fn(async () => item), readIssue: vi.fn(async () => item) };
  const gh = options.gh ?? vi.fn<GhRunner>(async () => AUTH_STATUS);
  const caches = { health: new ProbeCache<ConnectionHealthSnapshot>(() => clock), detection: new ProbeCache<Array<{ host: string; login: string }>>(() => clock) };
  const service = new IntegrationOperations(ws.store, { home, factories: new Map([["github:cli", () => adapter]]), gh, caches, liveReadsAvailable: options.liveReadsAvailable });
  return { service, adapter, gh, advance: (ms: number) => { clock += ms; } };
}
type Connections = { connections: Array<{ id: string; health: ConnectionHealthSnapshot | null }>; detected: unknown[]; pollIntervalSeconds: number };
type Health = { health: ConnectionHealthSnapshot[]; pollIntervalSeconds: number };

describe("integration connection status", () => {
  it("reports a signed-in gh account even before Staple has a connection for it", async () => {
    const { service } = setup();
    const before = await service.execute({ action: "connections" }) as Connections;
    expect(before.connections).toEqual([]);
    expect(before.detected).toEqual([{ providerId: "github", host: "github.com", login: "vpetkovic", configuredConnectionId: null }]);
    const saved = await service.execute({ action: "configure", host: "github.com", account: "VPetkovic" }) as { id: string };
    const after = await service.execute({ action: "connections" }) as Connections;
    expect(after.detected).toEqual([{ providerId: "github", host: "github.com", login: "vpetkovic", configuredConnectionId: saved.id }]);
  });

  it("treats a missing gh as nothing detected rather than an error", async () => {
    const { service } = setup({ gh: vi.fn<GhRunner>(async () => { throw new StapleError("unavailable", "Install", { reason: "missing_cli" }); }) });
    expect((await service.execute({ action: "connections" }) as Connections).detected).toEqual([]);
  });

  it("carries last known health on connections without probing, and probes at most once per interval", async () => {
    const { service, adapter, gh, advance } = setup();
    const { id } = await service.execute({ action: "configure", host: "github.com", account: "vpetkovic" }) as { id: string };
    const listed = await service.execute({ action: "connections" }) as Connections;
    expect(listed.connections[0]).toMatchObject({ id, health: null });
    expect(listed.pollIntervalSeconds).toBe(HEALTH_POLL_INTERVAL_SECONDS);
    expect(adapter.validate).not.toHaveBeenCalled();

    const first = await service.execute({ action: "health" }) as Health;
    expect(first.health).toEqual([{ connectionId: id, state: "ready", message: null, action: null, identity: { login: "vpetkovic" }, checkedAt: expect.any(String), retryAfterSeconds: null }]);
    await service.execute({ action: "health", connectionId: id });
    expect(adapter.validate).toHaveBeenCalledTimes(1);
    expect((await service.execute({ action: "connections" }) as Connections).connections[0]!.health?.state).toBe("ready");

    await Promise.all([service.execute({ action: "health", force: true }), service.execute({ action: "health", force: true })]);
    expect(adapter.validate).toHaveBeenCalledTimes(1);
    advance(6_000);
    await Promise.all([service.execute({ action: "health", force: true }), service.execute({ action: "health", force: true })]);
    expect(adapter.validate).toHaveBeenCalledTimes(2);
    advance(HEALTH_POLL_INTERVAL_SECONDS * 1000);
    await service.execute({ action: "health" });
    expect(adapter.validate).toHaveBeenCalledTimes(3);
    await service.execute({ action: "connections" });
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("turns probe failures into states with a next action instead of errors", async () => {
    const { service, adapter } = setup();
    const { id } = await service.execute({ action: "configure", host: "github.com", account: "vpetkovic" }) as { id: string };
    vi.mocked(adapter.validate).mockResolvedValue({ state: "account_mismatch", message: "GitHub CLI is signed in as octo, but this connection expects vpetkovic", identity: { login: "octo" } });
    const [health] = (await service.execute({ action: "health", connectionId: id }) as Health).health;
    expect(health).toMatchObject({ state: "account_mismatch", identity: { login: "octo" }, action: "Run gh auth switch --hostname github.com --user vpetkovic, or reconnect Staple as octo." });
    expect((await service.execute({ action: "health", connectionId: "removed-elsewhere" }) as Health).health[0]).toMatchObject({ connectionId: "removed-elsewhere", state: "not_found" });
  });

  it("records a live read that fails on the connection, and forgets it after a read succeeds", async () => {
    const { service, adapter } = setup();
    const { id } = await service.execute({ action: "configure", host: "github.com", account: "vpetkovic" }) as { id: string };
    await service.execute({ action: "map", connectionId: id, containerId: "42", actor: "ada" });
    vi.mocked(adapter.searchIssues).mockRejectedValueOnce(new StapleError("rate_limited", "GitHub rate limit reached; try again later", { retryAfterSeconds: 30 }));
    // One source failing is data, not an error; its connection's status follows it.
    expect(await service.execute({ action: "search", text: "x" })).toMatchObject({ failures: [{ connectionId: id, state: "rate_limited" }] });
    expect((await service.execute({ action: "connections" }) as Connections).connections[0]!.health).toMatchObject({ state: "rate_limited", retryAfterSeconds: 30 });
    vi.mocked(adapter.resolve).mockRejectedValueOnce(new StapleError("not_found", "Unknown issue"));
    await expect(service.execute({ action: "preview", url: item.url, connectionId: id })).rejects.toMatchObject({ code: "not_found" });
    expect((await service.execute({ action: "connections" }) as Connections).connections[0]!.health?.state).toBe("rate_limited");
    await service.execute({ action: "search", text: "x" });
    expect((await service.execute({ action: "connections" }) as Connections).connections[0]!.health).toBeNull();
    expect(adapter.validate).not.toHaveBeenCalled();
  });

  it("reports a cached-only session as unavailable without running gh", async () => {
    const { service, gh } = setup({ liveReadsAvailable: false });
    await service.execute({ action: "configure", host: "github.com", account: "vpetkovic" });
    expect((await service.execute({ action: "connections" }) as Connections).detected).toEqual([]);
    expect((await service.execute({ action: "health" }) as Health).health[0]).toMatchObject({ state: "unavailable" });
    expect(gh).not.toHaveBeenCalled();
  });
});
