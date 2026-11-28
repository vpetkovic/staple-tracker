import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { discoverLinear, LinearApiAdapter, type LinearApiConnection } from "../src/core/integrations/linear-api.js";
import { IntegrationOperations } from "../src/core/integrations/operations.js";
import { ProbeCache } from "../src/core/integrations/health.js";
import { errorEnvelope } from "../src/core/types.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111", ORG = "22222222-2222-4222-8222-222222222222";
const OTHER = "55555555-5555-4555-8555-555555555555";
const KEY = "lin_api_fixture_secret_value";
const ENV = "STAPLE_LINEAR_API_KEY";
const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME; else process.env.STAPLE_HOME = previous;
});

/** A Linear GraphQL fixture: the key decides who answers, as Linear does. */
function setup(options: { liveReadsAvailable?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "staple-linear-configure-")); dirs.push(home); process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "linear-configure-tests" });
  const state: { key: string | undefined; viewer: string; org: string } = { key: KEY, viewer: ACCOUNT, org: ORG };
  const api = vi.fn(async (_url: unknown, request: RequestInit | undefined) => {
    if ((request?.headers as Record<string, string>).authorization !== KEY) return new Response("Authentication required, not authenticated", { status: 401 });
    return Response.json({ data: { viewer: { id: state.viewer, name: state.viewer === ACCOUNT ? "Ada Lovelace" : "Grace Hopper" }, organization: { id: state.org, urlKey: "acme", name: "Acme" } } });
  });
  const deps = { fetch: api as unknown as typeof fetch, credential: () => state.key };
  // A clock that moves on, so every forced health check probes again.
  let clock = 0;
  const service = new IntegrationOperations(ws.store, { home, caches: { health: new ProbeCache(() => clock += 60_000), detection: new ProbeCache() },
    liveReadsAvailable: options.liveReadsAvailable,
    discoverLinear: credentialEnv => discoverLinear(credentialEnv, deps),
    factories: new Map([["linear:api", c => new LinearApiAdapter(c as LinearApiConnection, deps)]]) });
  const saved = () => readdirSync(join(home, "integrations", "machine")).filter(f => f.endsWith(".json")).map(f => readFileSync(join(home, "integrations", "machine", f), "utf8")).join("\n");
  return { home, ws, service, api, state, saved };
}
async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return errorEnvelope(error); }
  throw new Error("expected configure to be refused");
}

describe("configuring Linear from its API key", () => {
  it("stores the viewer and organization UUIDs the key answers for when only the variable is named", async () => {
    const { service, api, saved } = setup();
    const configured = await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV });
    expect(configured).toEqual({ id: "linear", providerId: "linear", mode: "api", host: "linear.app", account: ACCOUNT, scopeId: ORG, credentialEnv: ENV });
    expect(api).toHaveBeenCalledTimes(1);
    expect(await service.execute({ action: "connections" })).toMatchObject({ connections: [{ id: "linear", account: ACCOUNT, scopeId: ORG }] });
    // The saved binding works: health reads with it and is ready as the key's user.
    expect(await service.execute({ action: "health", connectionId: "linear", force: true }))
      .toMatchObject({ health: [{ state: "ready", identity: { login: "Ada Lovelace", organization: "Acme" } }] });
    expect(saved()).not.toContain(KEY);
  });

  it("refuses a missing or rejected key with the message and action health gives that connection", async () => {
    const { service, state, saved, api } = setup();
    await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV });
    const before = saved();
    for (const key of [undefined, "lin_api_revoked"]) {
      state.key = key;
      const { health: [probe] } = await service.execute({ action: "health", connectionId: "linear", force: true }) as { health: Array<{ state: string; message: string; action: string }> };
      expect(probe!.state).toBe("unauthenticated");
      const calls = api.mock.calls.length;
      const refused = await refusal(service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV }));
      expect(refused).toMatchObject({ code: "auth", message: probe!.message, detail: { state: "unauthenticated", action: probe!.action } });
      expect(refused.message).toContain(ENV);
      expect(api.mock.calls.length).toBe(key === undefined ? calls : calls + 1);
      // A refusal saves nothing and leaves the existing binding alone.
      expect(saved()).toBe(before);
    }
    state.key = undefined;
    await expect(service.execute({ action: "configure", providerId: "linear", connectionId: "fresh", credentialEnv: "STAPLE_LINEAR_OTHER_KEY" })).rejects.toMatchObject({ code: "auth" });
    expect(saved()).toBe(before);
  });

  it("still takes explicit UUIDs, verified against the key and saved as the key reports them", async () => {
    const { service, api } = setup();
    expect(await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", account: ACCOUNT.toUpperCase(), scopeId: ORG.toUpperCase(), credentialEnv: ENV }))
      .toEqual({ id: "linear", providerId: "linear", mode: "api", host: "linear.app", account: ACCOUNT, scopeId: ORG, credentialEnv: ENV });
    expect(await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", scopeId: ORG, credentialEnv: ENV })).toMatchObject({ account: ACCOUNT, scopeId: ORG });
    expect(await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", account: ACCOUNT, credentialEnv: ENV })).toMatchObject({ account: ACCOUNT, scopeId: ORG });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("refuses explicit UUIDs the key does not answer for, naming the health action, and saves nothing", async () => {
    const { service } = setup();
    const user = await refusal(service.execute({ action: "configure", providerId: "linear", account: OTHER, scopeId: ORG, credentialEnv: ENV }));
    expect(user).toMatchObject({ code: "auth", detail: { reason: "account_mismatch", state: "account_mismatch", login: "Ada Lovelace", action: expect.stringContaining("Ada Lovelace") } });
    expect(user.message).toBe(`The API key in ${ENV} belongs to Ada Lovelace, not the Linear user this connection expects.`);
    const organization = await refusal(service.execute({ action: "configure", providerId: "linear", account: ACCOUNT, scopeId: OTHER, credentialEnv: ENV }));
    expect(organization).toMatchObject({ code: "forbidden", message: `The API key in ${ENV} belongs to a different Linear organization.`, detail: { state: "forbidden", action: expect.any(String) } });
    await expect(service.execute({ action: "configure", providerId: "linear", account: "not-a-uuid", credentialEnv: ENV })).rejects.toMatchObject({ code: "validation" });
    await expect(service.execute({ action: "configure", providerId: "linear", scopeId: "acme", credentialEnv: ENV })).rejects.toMatchObject({ code: "validation" });
    await expect(service.execute({ action: "configure", providerId: "linear" })).rejects.toMatchObject({ code: "validation" });
    expect(await service.execute({ action: "connections" })).toMatchObject({ connections: [] });
  });

  it("keeps an edited connection's user and organization unless new ids are given, and reuses a binding instead of copying it", async () => {
    const { service, state, api } = setup();
    await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV });
    state.viewer = OTHER; state.org = OTHER;
    // The variable now holds someone else's key: an edit without ids is a check, not a rebind.
    const moved = await refusal(service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV }));
    expect(moved).toMatchObject({ code: "auth", detail: { state: "account_mismatch", login: "Grace Hopper" } });
    expect(await service.execute({ action: "connections" })).toMatchObject({ connections: [{ id: "linear", account: ACCOUNT, scopeId: ORG }] });
    // Naming the new user and organization rebinds it deliberately.
    expect(await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", account: OTHER, scopeId: OTHER, credentialEnv: ENV })).toMatchObject({ id: "linear", account: OTHER, scopeId: OTHER });
    // Without a connection id, the same user, organization and variable update the one binding.
    expect(await service.execute({ action: "configure", providerId: "linear", credentialEnv: ENV })).toMatchObject({ id: "linear", account: OTHER, scopeId: OTHER });
    expect(await service.execute({ action: "configure", providerId: "linear", credentialEnv: ENV })).toMatchObject({ id: "linear" });
    expect((await service.execute({ action: "connections" }) as { connections: unknown[] }).connections).toHaveLength(1);
    // An id the connection could never be saved under is refused before the key is read.
    const calls = api.mock.calls.length;
    await expect(service.execute({ action: "configure", providerId: "linear", connectionId: "bad id!", credentialEnv: ENV })).rejects.toMatchObject({ code: "validation" });
    expect(api.mock.calls.length).toBe(calls);
  });

  it("forgets a stale health result once configure has read the key successfully", async () => {
    const { service, state } = setup();
    await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV });
    state.key = undefined;
    expect(await service.execute({ action: "health", connectionId: "linear", force: true })).toMatchObject({ health: [{ state: "unauthenticated" }] });
    state.key = KEY;
    await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV });
    expect(await service.execute({ action: "health", connectionId: "linear" })).toMatchObject({ health: [{ state: "ready" }] });
  });

  it("needs a live session to read the key, even with both UUIDs given", async () => {
    const { service, api } = setup({ liveReadsAvailable: false });
    await expect(service.execute({ action: "configure", providerId: "linear", account: ACCOUNT, scopeId: ORG, credentialEnv: ENV })).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.execute({ action: "configure", providerId: "linear", credentialEnv: ENV })).rejects.toMatchObject({ code: "unavailable" });
    expect(api).not.toHaveBeenCalled();
  });

  it("never puts the key value in a result, an error, the saved file or the console", async () => {
    const { service, state, saved } = setup();
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    const outputs: unknown[] = [];
    outputs.push(await service.execute({ action: "configure", providerId: "linear", connectionId: "linear", credentialEnv: ENV }));
    outputs.push(await service.execute({ action: "connections" }));
    outputs.push(await service.execute({ action: "health", force: true }));
    state.viewer = OTHER;
    outputs.push(await refusal(service.execute({ action: "configure", providerId: "linear", account: ACCOUNT, credentialEnv: ENV })));
    state.key = "lin_api_other_secret";
    outputs.push(await refusal(service.execute({ action: "configure", providerId: "linear", credentialEnv: ENV })));
    const text = JSON.stringify(outputs) + saved() + JSON.stringify(logged.map(s => s.mock.calls));
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("lin_api_other_secret");
    expect(text).not.toContain("not authenticated");
  });
});
