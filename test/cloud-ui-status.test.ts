/**
 * `GET /api/cloud/status` — the UI's read-only, network-free view of the
 * connection.
 *
 * `docs/sync.md`, on what a surface may do before a repository is connected:
 * *"render 'not connected' and a static hint naming `staple cloud connect`.
 * Static text. No probe, no reachability check, no 'we noticed you might want to
 * connect'. The UI does not prompt."*
 *
 * This route exists so the page does not have to guess, and it deliberately has
 * no `refresh` parameter. The page polls; a refreshing status endpoint would
 * turn one open browser tab into a heartbeat to Cloudflare every few seconds —
 * telemetry arrived at by accident, and *"no telemetry, no update check, no
 * discovery request, ever."* The network spy below is what holds that.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { installNetworkSpy, describeViolations } from "./fixtures/network-spy.js";

const ENDPOINT = "https://staple-sync-dev.example.workers.dev";

let home: string;
let repoDir: string;
let repositoryId: string;
let ui: UiHandle;
let origin: string;
let token: string;

function get(path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-cloud-ui-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-cloud-ui-repo-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  // Repo-local, so `reconcileRepositoryIdentity` mints the manifest and records
  // the id in `sync_state` — which is where this route reads it from.
  const ws = initWorkspace({ dir: repoDir, slug: "cloudui" });
  repositoryId = readStoredRepositoryId(ws.store.db)!;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: join(repoDir, ".staple", "staple.db") });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function forgeConnection(patch: Record<string, unknown> = {}): void {
  const dir = join(home, "cloud");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${repositoryId}.token`), "stpl_fake\n", { mode: 0o600 });
  writeFileSync(
    join(dir, `${repositoryId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      repositoryId,
      endpoint: ENDPOINT,
      deviceId: "11111111-2222-3333-4444-555555555555",
      label: "ui test device",
      credentialMechanism: "file",
      connectedAt: "2026-09-05T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
      ...patch,
    }),
    { mode: 0o600 },
  );
}

describe("GET /api/cloud/status", () => {
  it("reports disconnected, with a STATIC hint and nothing that looks like a prompt", async () => {
    const response = await get("/api/cloud/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe("disconnected");
    expect(body.endpoint).toBeNull();
    expect(body.credentialPresent).toBe(false);
    // The hint is a command name, not an invitation and not a link to click.
    expect(body.hint).toBe("staple cloud connect");
  });

  it("never carries a credential in the body", async () => {
    forgeConnection();
    const text = await (await get("/api/cloud/status")).text();
    expect(text).not.toContain("stpl_");
  });

  it("reports manual once connected, and says it was not checked against the endpoint", async () => {
    forgeConnection();
    const body = (await (await get("/api/cloud/status")).json()) as Record<string, unknown>;
    expect(body.state).toBe("manual");
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.deviceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.auto).toBe(false);
    expect(body.hint).toBeNull();
  });

  it("reports automatic when THIS device has separately consented", async () => {
    forgeConnection({ auto: true });
    const body = (await (await get("/api/cloud/status")).json()) as Record<string, unknown>;
    expect(body.state).toBe("automatic");
    expect(body.auto).toBe(true);
  });

  it("makes no outbound call, in any state, with real spies watching", async () => {
    forgeConnection();
    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      // The request itself is loopback, which the spy exempts — so what is being
      // asserted is that SERVING it reached for nothing else.
      const body = (await (await get("/api/cloud/status")).json()) as Record<string, unknown>;
      expect(body.state).toBe("manual");
      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });

  it("accepts GET only — it is not in the write family and must never be", async () => {
    const response = await fetch(`${origin}/api/cloud/status`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(405);
  });

  it("requires the token, like every other route on this server", async () => {
    const response = await fetch(`${origin}/api/cloud/status`);
    expect(response.status).toBe(401);
  });
});
