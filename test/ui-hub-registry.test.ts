/**
 * THE HUB REGISTRY LEG, FROM THE PAGE — STA-289.
 *
 * Until this file the settings page could flip the hub's publish consent and do
 * nothing else with the registry: no identity, no connection, no publish, no hub
 * backups, no restore, no adopt. So the consent switch sat disabled on every machine
 * that had not connected the hub from a terminal. These routes are the rest of the
 * leg, and every assertion below is on an OBSERVABLE EFFECT — a connection record on
 * disk, an operation the service holds, a row in `hub.db`, a restore the service
 * performed or did not — never on a response envelope alone.
 *
 * ## Single-workspace mode, on purpose
 *
 * The server is started on `alpha` with `hub: false`, which is how `staple ui` runs in
 * a repository and the mode in which `handleFor` ignores its argument and answers with
 * `alpha` whatever it is asked. A hub-scoped write routed through it would land under
 * alpha's repository id, silently. So the connection this file makes is asserted to be
 * under the HUB's id, and alpha's id is asserted to have no connection at all.
 *
 * ## The service is the in-memory fake behind a real loopback socket
 *
 * `FakeSyncServer` re-implements the Worker's fold, envelope validation and restore.
 * The UI server calls the real `fetch`, so the fake is put behind a loopback HTTP
 * listener here. Enrolment (`/connect`) is the one route the fake does not model, so
 * the listener answers it — refusing an unprovisioned hub exactly as the Worker does,
 * with `forbidden`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { Hub } from "../src/core/hub.js";
import { readConnection, setConsent, writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { describeIdentityReplacement } from "../src/core/cloud/hub-registry.js";
import { REGISTRY_PROTOCOL } from "../src/core/cloud/hub-registry-ops.js";
import { HUB_NOT_PROVISIONED, publishRegistry } from "../src/core/cloud/hub-registry-service.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const ENROLLMENT = "hub-enrollment-secret";
const REPO_ROOT = new URL("..", import.meta.url).pathname;

let home: string;
let scratch: string;
let ui: UiHandle;
let origin: string;
let token: string;
let service: Server;
let endpoint: string;
/** The service, created when the hub is provisioned — its id is not known before. */
let fake: FakeSyncServer | null = null;
/** Hub ids the operator has created a `repos` row for. Everything else is `forbidden`. */
const provisioned = new Set<string>();

const IDS = new Map<string, string>();

/**
 * Snapshot reads the UI server made, and a hook that runs BEFORE one is answered.
 * The hook is how a test makes the service move between two reads of one request —
 * another machine publishing mid-apply — which no amount of sequencing from outside
 * the request can do.
 */
let snapshotReads = 0;
let beforeSnapshot: ((read: number) => Promise<void>) | null = null;

const CHARLIE = "5b2c7a10-1111-4111-8111-00000000ca11";
const DELTA = "6c3d8b21-2222-4222-8222-00000000de17";
let otherMachines = 0;

function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": token, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function postJson<T>(path: string, body: Record<string, unknown>, status = 200): Promise<T> {
  const response = await post(path, body);
  const text = await response.text();
  expect(response.status, `${path} answered ${response.status}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The loopback face of the fake. Every route but enrolment is forwarded verbatim to
 * `FakeSyncServer.fetch`, so the fold, the envelope validation and the restore are the
 * fake's — this only moves bytes.
 */
async function serviceHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", endpoint);
  const body = await readBody(req);
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const connect = /^\/v1\/repos\/([^/]+)\/connect$/.exec(url.pathname);
  if (connect && req.method === "POST") {
    const repoId = decodeURIComponent(connect[1]!);
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    // The Worker's answer for an unknown repository AND for a wrong secret, on purpose.
    if (!provisioned.has(repoId) || fake === null || bearer !== ENROLLMENT) {
      return send(403, { code: "forbidden", message: "not a member of this repository" });
    }
    const { deviceId } = JSON.parse(body) as { deviceId: string };
    const deviceToken = `stpl_ui_${deviceId}`;
    fake.enroll(deviceId, deviceToken);
    const capabilities = (await (await fake.fetch(`${endpoint}/v1/capabilities`)).json()) as unknown;
    return send(200, { protocol: 1, repositoryId: repoId, deviceId, epoch: fake.epoch, token: deviceToken, capabilities });
  }
  if (fake === null) {
    if (url.pathname === "/v1/capabilities") {
      const probe = new FakeSyncServer({ repositoryId: "none" });
      const answer = await probe.fetch(`${endpoint}/v1/capabilities`);
      return send(answer.status, await answer.json());
    }
    return send(403, { code: "forbidden", message: "not a member of this repository" });
  }
  if (req.method === "GET" && url.pathname.endsWith("/snapshot")) {
    snapshotReads += 1;
    if (beforeSnapshot !== null) await beforeSnapshot(snapshotReads);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }
  const answer = await fake.fetch(url.toString(), {
    method: req.method,
    headers,
    ...(body === "" ? {} : { body }),
  });
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(await answer.text());
}

/** The report the panel draws from. A GET, local, and the only read the page polls. */
async function currentReport(): Promise<Report> {
  const response = await fetch(`${origin}/api/cloud/workspaces`, { headers: { "x-staple-token": token } });
  expect(response.status).toBe(200);
  return (await response.json()) as Report;
}

function makeWorkspace(slug: string): void {
  const dir = join(scratch, slug);
  const opened = initWorkspace({ dir, slug });
  IDS.set(slug, readStoredRepositoryId(opened.store.db)!);
  opened.store.db.close();
}

function storedHubId(): string | null {
  const hub = Hub.open();
  try {
    return hub.storedHubId();
  } finally {
    hub.close();
  }
}

function hubRow(slug: string) {
  const hub = Hub.open();
  try {
    return hub.get(slug) ?? null;
  } finally {
    hub.close();
  }
}

/**
 * Another machine, publishing workspaces this one does not have. Done through the
 * service module in-process, with its own staple home, its own hub and its own device,
 * which is what a second machine is. Publishing is a union (STA-287), so it only has to
 * hold what it adds.
 */
async function publishFromOtherMachine(rows: Array<{ slug: string; prefix: string; id: string }>) {
  const hubId = storedHubId()!;
  otherMachines += 1;
  const deviceId = `device-other-${otherMachines}`;
  const deviceToken = `stpl_other_${otherMachines}`;
  const otherHome = mkdtempSync(join(tmpdir(), "staple-hubregui-other-"));
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = otherHome;
  try {
    const other = Hub.open();
    try {
      other.adoptHubId(hubId);
      for (const row of rows) {
        const dir = join(otherHome, "ws", row.slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "staple.db"), "");
        other.register({ slug: row.slug, prefix: row.prefix, path: join(dir, "staple.db"), kind: "repo" });
        other.recordRepositoryId(row.slug, row.id);
      }
      credentialStoreFor(otherHome, "file").write(hubId, deviceToken);
      writeConnection(otherHome, {
        schemaVersion: 1,
        repositoryId: hubId,
        endpoint,
        deviceId,
        label: "other",
        credentialMechanism: "file",
        connectedAt: "2026-09-10T00:00:00.000Z",
        auto: false,
        backup: false,
        registry: false,
        protocol: REGISTRY_PROTOCOL,
      });
      setConsent(otherHome, hubId, { registry: true });
      fake!.enroll(deviceId, deviceToken);
      const report = await publishRegistry(other, otherHome, { fetchImpl: fake!.fetch });
      expect(report.published).toBeGreaterThanOrEqual(1);
    } finally {
      other.close();
    }
  } finally {
    process.env.STAPLE_HOME = previous;
    rmSync(otherHome, { recursive: true, force: true });
  }
}

interface Report {
  self: {
    registry: {
      hubId: string | null;
      connected: boolean;
      endpoint: string | null;
      disclosure: string;
      consent: boolean;
      backup: boolean;
    };
  };
}

const REGISTRY_ROUTES = [
  "/api/hub/registry/identity/mint",
  "/api/hub/registry/identity",
  "/api/hub/registry/connect/preview",
  "/api/hub/registry/connect",
  "/api/hub/registry/disconnect",
  "/api/hub/registry/publish",
  "/api/hub/registry/backup/consent",
  "/api/hub/registry/backups",
  "/api/hub/registry/backup/create",
  "/api/hub/registry/restore",
  "/api/hub/registry/adopt",
];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-hubregui-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-hubregui-work-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  for (const slug of ["alpha", "bravo"]) makeWorkspace(slug);

  service = createServer((req, res) => void serviceHandler(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  ui = startUiServer({ port: 0, hub: false, db: join(scratch, "alpha", ".staple", "staple.db") });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  service?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("the gate: every registry route is POST-only, named, and Origin-checked", () => {
  it("answers GET with 405 on each route", async () => {
    for (const route of REGISTRY_ROUTES) {
      const response = await fetch(`${origin}${route}`, { headers: { "x-staple-token": token } });
      expect(response.status, `${route} accepted a GET`).toBe(405);
    }
  });

  it("refuses a cross-origin POST on each route before the handler runs", async () => {
    for (const route of REGISTRY_ROUTES) {
      const response = await post(route, {}, { origin: "https://evil.example" });
      expect(response.status, `${route} took a cross-origin POST`).toBe(403);
    }
    expect(storedHubId(), "a refused cross-origin mint still minted").toBeNull();
  });

  it("names each route individually in the method gate and in CLOUD_LIFECYCLE_WRITES", () => {
    const source = readFileSync(join(REPO_ROOT, "src/ui/server.ts"), "utf8");
    const lifecycle = source.slice(
      source.indexOf("const CLOUD_LIFECYCLE_WRITES"),
      source.indexOf("]);", source.indexOf("const CLOUD_LIFECYCLE_WRITES")),
    );
    const gate = source.slice(source.indexOf("const expected ="), source.indexOf("const allow ="));
    for (const route of REGISTRY_ROUTES) {
      expect(lifecycle, `${route} is not in CLOUD_LIFECYCLE_WRITES`).toContain(`"${route}"`);
      expect(gate, `${route} is not named in the method gate`).toContain(`url.pathname === "${route}"`);
    }
    // No family rule: a `/api/hub/registry/` prefix would pin every future read as a
    // write. Comments stripped, because several of them name the rule to reject it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/startsWith\("\/api\/hub/);
  });
});

describe("identity", () => {
  it("reports no identity, and refuses to connect without minting one", async () => {
    expect((await currentReport()).self.registry.hubId).toBeNull();

    const refused = await post("/api/hub/registry/connect/preview", {
      endpoint,
      credentialFile: true,
    });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { message: string }).message).toMatch(/no registry identity/i);
    // The refusal is the whole answer: a route that minted on its way to refusing
    // would hand this machine an id nobody chose.
    expect(storedHubId()).toBeNull();
  });

  it("mints one on request, reports it, and answers the same id when asked again", async () => {
    const minted = await postJson<{ hubId: string; minted: boolean; report: Report }>(
      "/api/hub/registry/identity/mint",
      {},
    );
    expect(minted.minted).toBe(true);
    expect(minted.hubId).toBe(storedHubId());
    expect(minted.report.self.registry.hubId).toBe(minted.hubId);

    const again = await postJson<{ hubId: string; minted: boolean }>("/api/hub/registry/identity/mint", {});
    expect(again).toMatchObject({ hubId: minted.hubId, minted: false });
  });

  it("refuses a workspace's sync identity as a hub id, and changes nothing", async () => {
    const before = storedHubId();
    const refused = await post("/api/hub/registry/identity", {
      hubId: IDS.get("bravo"),
      confirm: true,
      previousHubId: before,
    });
    expect(refused.status).toBe(409);
    expect(storedHubId()).toBe(before);
  });

  it("asks before replacing an identity, with the orphan notice from core", async () => {
    const original = storedHubId()!;
    const replacement = "7c1f3a2e-0000-4000-8000-00000000c0de";

    const asked = await postJson<{
      needsConfirm: boolean;
      adopted: boolean;
      previousHubId: string | null;
      notice: string | null;
    }>("/api/hub/registry/identity", { hubId: replacement });
    expect(asked.needsConfirm).toBe(true);
    expect(asked.adopted).toBe(false);
    expect(asked.previousHubId).toBe(original);
    expect(asked.notice).toBe(describeIdentityReplacement(original));
    expect(storedHubId(), "asking replaced the identity").toBe(original);

    const replaced = await postJson<{
      adopted: boolean;
      previousHubId: string | null;
      notice: string | null;
      report: Report;
    }>("/api/hub/registry/identity", { hubId: replacement, confirm: true, previousHubId: original });
    expect(replaced.adopted).toBe(true);
    expect(replaced.previousHubId).toBe(original);
    // Unconditional: this id was never connected or published, and the notice is
    // stated anyway, because "was it used" is the part this machine cannot know.
    expect(replaced.notice).toBe(describeIdentityReplacement(original));
    expect(storedHubId()).toBe(replacement);
    expect(replaced.report.self.registry.hubId).toBe(replacement);

    // Reversible, which is what keeps this a confirmation rather than a refusal.
    const back = await postJson<{ adopted: boolean; previousHubId: string | null }>(
      "/api/hub/registry/identity",
      { hubId: original, confirm: true, previousHubId: replacement },
    );
    expect(back).toMatchObject({ adopted: true, previousHubId: replacement });
    expect(storedHubId()).toBe(original);
  });

  /**
   * The yes is to the warning that was shown. A warning about identity X, confirmed
   * after another tab or the CLI replaced X with Y, would replace Y without anybody
   * having been told what replacing Y orphans.
   */
  it("refuses a confirmation whose warning named an identity that is no longer stored", async () => {
    const original = storedHubId()!;
    const wanted = "9d4e0000-0000-4000-8000-0000000000aa";
    const asked = await postJson<{ previousHubId: string }>("/api/hub/registry/identity", { hubId: wanted });
    expect(asked.previousHubId).toBe(original);

    const elsewhere = "5e1f0000-0000-4000-8000-00000000e15e";
    const hub = Hub.open();
    try {
      hub.adoptHubId(elsewhere, { force: true });
    } finally {
      hub.close();
    }
    const refused = await post("/api/hub/registry/identity", {
      hubId: wanted,
      confirm: true,
      previousHubId: asked.previousHubId,
    });
    expect(refused.status).toBe(409);
    const message = ((await refused.json()) as { message: string }).message;
    expect(message).toContain(elsewhere);
    expect(message).toContain(original);
    expect(storedHubId(), "a stale confirmation replaced the identity").toBe(elsewhere);

    // A confirmation that names nothing is not a confirmation of anything.
    const unnamed = await post("/api/hub/registry/identity", { hubId: wanted, confirm: true });
    expect(unnamed.status).toBe(400);
    expect(storedHubId()).toBe(elsewhere);

    const back = Hub.open();
    try {
      back.adoptHubId(original, { force: true });
    } finally {
      back.close();
    }
  });

  it("refuses a blank id as a validation error", async () => {
    const refused = await post("/api/hub/registry/identity", { hubId: "   ", confirm: true });
    expect(refused.status).toBe(400);
  });
});

describe("connect: preview, then confirm, redeeming only what the preview showed", () => {
  it("previews the HUB's repository, not the workspace the server was started on", async () => {
    const hubId = storedHubId()!;
    const previewed = await postJson<{
      preview: { repositoryId: string; endpoint: { origin: string }; credentialMechanism: string };
      consent: { id: string; digest: string };
    }>("/api/hub/registry/connect/preview", { endpoint, credentialFile: true });
    expect(previewed.preview.repositoryId).toBe(hubId);
    expect(previewed.preview.repositoryId).not.toBe(IDS.get("alpha"));
    expect(previewed.preview.endpoint.origin).toBe(endpoint);
    expect(previewed.preview.credentialMechanism).toBe("file");
    expect(previewed.consent.id).toBeTruthy();
    expect(readConnection(home, hubId)).toBeNull();
  });

  it("refuses a ticket minted for a WORKSPACE's preview, and connects nothing", async () => {
    const hubId = storedHubId()!;
    const workspaceTicket = await postJson<{ consent: { id: string; digest: string } }>(
      "/api/cloud/connect/preview",
      { endpoint, credentialFile: true },
    );
    const refused = await post("/api/hub/registry/connect", {
      consent: workspaceTicket.consent.id,
      digest: workspaceTicket.consent.digest,
      token: ENROLLMENT,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(((await refused.json()) as { message: string }).message).toMatch(/different/i);
    expect(readConnection(home, hubId)).toBeNull();
    expect(readConnection(home, IDS.get("alpha")!)).toBeNull();
  });

  it("refuses a blank enrollment secret before spending the ticket", async () => {
    const previewed = await postJson<{ consent: { id: string; digest: string } }>(
      "/api/hub/registry/connect/preview",
      { endpoint, credentialFile: true },
    );
    const blank = await post("/api/hub/registry/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: " ",
    });
    expect(blank.status).toBe(400);
    // The same ticket still works: it was not consumed by the refusal. It reaches the
    // service, which has not provisioned this hub yet, and says so in the product's words.
    const unprovisioned = await post("/api/hub/registry/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });
    expect(unprovisioned.status).toBe(409);
    const body = (await unprovisioned.json()) as { message: string; detail?: { cloudCode?: string } };
    expect(body.message).toBe(HUB_NOT_PROVISIONED);
    expect(body.detail?.cloudCode).toBe("forbidden");
    expect(readConnection(home, storedHubId()!)).toBeNull();
  });

  it("connects under the hub id, ignoring an endpoint and a repositoryId in the confirm", async () => {
    const hubId = storedHubId()!;
    provisioned.add(hubId);
    fake = new FakeSyncServer({ repositoryId: hubId });

    const previewed = await postJson<{ consent: { id: string; digest: string } }>(
      "/api/hub/registry/connect/preview",
      { endpoint, credentialFile: true, label: "hub-ui-test" },
    );
    const connected = await postJson<{
      connection: { repositoryId: string; endpoint: string; registry?: boolean };
      report: Report;
    }>("/api/hub/registry/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
      // Neither field exists on this route. Both are ignored, which is structural:
      // the ticket carries the service the preview named.
      endpoint: "https://evil.invalid",
      repositoryId: IDS.get("alpha"),
    });
    expect(connected.connection.repositoryId).toBe(hubId);
    expect(connected.connection.endpoint).toBe(endpoint);
    expect(readConnection(home, hubId)?.endpoint).toBe(endpoint);
    expect(readConnection(home, IDS.get("alpha")!)).toBeNull();
    // Connecting grants no other consent.
    expect(connected.report.self.registry).toMatchObject({
      hubId,
      connected: true,
      endpoint,
      consent: false,
      backup: false,
    });
  });
});

describe("publish, backups, adopt and restore against the service", () => {
  it("refuses to publish before the publish consent, from local state", async () => {
    const before = fake!.calls.length;
    const refused = await post("/api/hub/registry/publish", {});
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail?: { cloudCode?: string } }).detail?.cloudCode).toBe("forbidden");
    expect(fake!.calls.length, "a refused publish reached the service").toBe(before);
  });

  it("publishes once the consent is granted, and the service holds this machine's list", async () => {
    const report = await currentReport();
    await postJson("/api/hub/consent", { registry: true, disclosure: report.self.registry.disclosure });

    const published = await postJson<{
      publish: { hubId: string; published: number; applied: number; upToDate: boolean };
      report: Report;
    }>("/api/hub/registry/publish", {});
    expect(published.publish.hubId).toBe(storedHubId());
    expect(published.publish.published).toBeGreaterThanOrEqual(2);
    expect(published.publish.applied).toBe(published.publish.published);
    const registered = fake!.ops.filter((op) => op.entity === "registration").map((op) => op.entityId);
    expect(registered).toEqual(expect.arrayContaining([IDS.get("alpha"), IDS.get("bravo")]));
  });

  it("refuses backups before the backup consent, without asking the service", async () => {
    const before = fake!.calls.length;
    for (const [route, body] of [
      ["/api/hub/registry/backups", {}],
      ["/api/hub/registry/backup/create", {}],
    ] as const) {
      const refused = await post(route, body);
      expect(refused.status, route).toBe(409);
    }
    expect(fake!.calls.length).toBe(before);
  });

  it("turns backup on at the service and locally, takes one, and lists it", async () => {
    const consent = await postJson<{
      backup: { enabled: boolean; serverAcknowledged: boolean };
      report: Report;
    }>("/api/hub/registry/backup/consent", { enabled: true });
    expect(consent.backup).toMatchObject({ enabled: true, serverAcknowledged: true });
    expect(fake!.backupEnabled).toBe(true);
    expect(consent.report.self.registry.backup).toBe(true);

    const created = await postJson<{
      backup: { backupId: string; entityCount: number; epoch: number; kind: string };
      backups: Array<{ backupId: string }>;
    }>("/api/hub/registry/backup/create", { label: "before charlie" });
    expect(fake!.backups.map((b) => b.backupId)).toContain(created.backup.backupId);
    expect(created.backup.kind).toBe("manual");
    expect(created.backups.map((b) => b.backupId)).toContain(created.backup.backupId);

    const listed = await postJson<{
      backups: Array<{ backupId: string }>;
      restoreNotice: { headline: string; bullets: string[] };
    }>("/api/hub/registry/backups", {});
    expect(listed.backups.map((b) => b.backupId)).toContain(created.backup.backupId);
    expect(listed.restoreNotice.bullets.length).toBeGreaterThanOrEqual(3);
  });

  it("sees what another machine published", async () => {
    await publishFromOtherMachine([{ slug: "charlie", prefix: "CHA", id: CHARLIE }]);
    expect(fake!.ops.some((op) => op.entityId === CHARLIE)).toBe(true);
  });

  let adoptDigest = "";

  it("previews an adoption with one decision per incoming entry, and writes nothing", async () => {
    const previewed = await postJson<{
      adoption: {
        dryRun: boolean;
        decisions: Array<{ entry: { slug: string; repositoryId: string | null }; outcome: string; reason: string }>;
      };
      digest: string;
    }>("/api/hub/registry/adopt", {});
    expect(previewed.adoption.dryRun).toBe(true);
    const bySlug = Object.fromEntries(previewed.adoption.decisions.map((d) => [d.entry.slug, d.outcome]));
    expect(bySlug).toMatchObject({ alpha: "current", bravo: "current", charlie: "absent" });
    for (const decision of previewed.adoption.decisions) expect(decision.reason.length).toBeGreaterThan(0);
    expect(previewed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hubRow("charlie"), "a preview wrote a row").toBeNull();
    adoptDigest = previewed.digest;
  });

  it("refuses to apply without the preview's digest, or with a different one", async () => {
    const missing = await post("/api/hub/registry/adopt", { apply: true });
    expect(missing.status).toBe(400);
    const stale = await post("/api/hub/registry/adopt", { apply: true, digest: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(hubRow("charlie")).toBeNull();
  });

  it("applies exactly the previewed adoption", async () => {
    const applied = await postJson<{ adoption: { dryRun: boolean } }>("/api/hub/registry/adopt", {
      apply: true,
      digest: adoptDigest,
    });
    expect(applied.adoption.dryRun).toBe(false);
    const charlie = hubRow("charlie");
    expect(charlie?.repositoryId).toBe(CHARLIE);
  });

  /**
   * THE APPLY IS THE PREVIEW, even when the service moves during the request.
   *
   * An apply that read the service once to check the digest and again to write would
   * write whatever landed between the two — here a workspace another machine publishes
   * while the apply is in flight — without anybody having been shown it. One read, one
   * payload, both checked and applied.
   */
  it("applies what it previewed even when another machine publishes during the apply", async () => {
    const previewed = await postJson<{ digest: string }>("/api/hub/registry/adopt", {});
    snapshotReads = 0;
    beforeSnapshot = async (read) => {
      if (read === 2) await publishFromOtherMachine([{ slug: "delta", prefix: "DEL", id: DELTA }]);
    };
    let applied: { adoption: { decisions: Array<{ entry: { slug: string } }> } };
    try {
      applied = await postJson("/api/hub/registry/adopt", { apply: true, digest: previewed.digest });
    } finally {
      beforeSnapshot = null;
    }
    expect(applied.adoption.decisions.map((d) => d.entry.slug)).not.toContain("delta");
    expect(hubRow("delta"), "an unpreviewed workspace was written").toBeNull();
    // The service did move; the next preview shows it, and only then can it be applied.
    if (!fake!.ops.some((op) => op.entityId === DELTA)) {
      await publishFromOtherMachine([{ slug: "delta", prefix: "DEL", id: DELTA }]);
    }
    const next = await postJson<{ adoption: { decisions: Array<{ entry: { slug: string } }> } }>(
      "/api/hub/registry/adopt",
      {},
    );
    expect(next.adoption.decisions.map((d) => d.entry.slug)).toContain("delta");
  });

  /**
   * "Nothing to apply" must not be said about an apply that would still write.
   *
   * A `current` row whose identity also carries an opt-out — the contradiction a prune
   * before STA-283 left behind — is cleared by applying. The route names every identity
   * whose opt-out applying would retire, so the page can count it and say so.
   */
  it("names a stale opt-out that applying would clear, and applying clears it", async () => {
    const bravo = IDS.get("bravo")!;
    const hub = Hub.open();
    try {
      hub.addOptOut(bravo, "bravo", "pruned");
    } finally {
      hub.close();
    }
    const previewed = await postJson<{
      adoption: { decisions: Array<{ entry: { repositoryId: string | null }; outcome: string }> };
      digest: string;
      retiresOptOuts: string[];
    }>("/api/hub/registry/adopt", {});
    expect(previewed.retiresOptOuts).toEqual([bravo]);
    expect(previewed.adoption.decisions.find((d) => d.entry.repositoryId === bravo)?.outcome).toBe("current");

    await postJson("/api/hub/registry/adopt", { apply: true, digest: previewed.digest });
    const after = Hub.open();
    try {
      expect(after.listOptOuts().map((o) => o.repositoryId)).not.toContain(bravo);
    } finally {
      after.close();
    }
    const again = await postJson<{ retiresOptOuts: string[] }>("/api/hub/registry/adopt", {});
    expect(again.retiresOptOuts).toEqual([]);
  });

  it("refuses a restore without confirm, with the CLI's disclosure, and restores nothing", async () => {
    const backup = fake!.backups.find((b) => b.kind === "manual")!;
    const refused = await post("/api/hub/registry/restore", {
      backupId: backup.backupId,
      epoch: backup.epoch,
      entityCount: backup.entityCount,
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain(
      "every machine on this hub id is affected",
    );
    expect(fake!.restores).toHaveLength(0);
  });

  it("refuses a restore whose confirmation does not match the backup's enumeration", async () => {
    const backup = fake!.backups.find((b) => b.kind === "manual")!;
    for (const wrong of [
      { epoch: backup.epoch + 1, entityCount: backup.entityCount },
      { epoch: backup.epoch, entityCount: backup.entityCount + 1 },
    ]) {
      const refused = await post("/api/hub/registry/restore", {
        backupId: backup.backupId,
        ...wrong,
        confirm: true,
      });
      expect(refused.status, JSON.stringify(wrong)).toBe(409);
    }
    const unknown = await post("/api/hub/registry/restore", {
      backupId: "no-such-backup",
      epoch: backup.epoch,
      entityCount: backup.entityCount,
      confirm: true,
    });
    expect(unknown.status).toBe(404);
    expect(fake!.restores).toHaveLength(0);
  });

  it("restores over the confirmed enumeration, previews the adoption, and names the undo", async () => {
    const backup = fake!.backups.find((b) => b.kind === "manual")!;
    const epochBefore = fake!.epoch;
    const restored = await postJson<{
      restore: {
        backupId: string;
        fromEpoch: number | null;
        toEpoch: number | null;
        preRestoreBackupId: string | null;
        adoption: { dryRun: boolean; decisions: Array<{ entry: { slug: string } }> };
      };
      digest: string;
      backups: Array<{ backupId: string; kind: string }>;
    }>("/api/hub/registry/restore", {
      backupId: backup.backupId,
      epoch: backup.epoch,
      entityCount: backup.entityCount,
      confirm: true,
    });
    expect(fake!.restores).toHaveLength(1);
    expect(fake!.epoch).toBeGreaterThan(epochBefore);
    expect(restored.restore.backupId).toBe(backup.backupId);
    expect(restored.restore.toEpoch).toBeGreaterThan(restored.restore.fromEpoch!);
    expect(restored.restore.preRestoreBackupId).not.toBeNull();
    expect(restored.backups.map((b) => b.backupId)).toContain(restored.restore.preRestoreBackupId);
    // The service was rewound to before charlie was published.
    expect(restored.restore.adoption.decisions.map((d) => d.entry.slug).sort()).toEqual(["alpha", "bravo"]);
    expect(restored.restore.adoption.dryRun).toBe(true);
    // Adoption never deletes: the row adopted earlier is still here.
    expect(hubRow("charlie")).not.toBeNull();

    // The restore's adoption digest is the adopt route's own, so "apply this locally"
    // is one press through the ordinary adopt, not a second restore.
    const restoresBefore = fake!.restores.length;
    const applied = await postJson<{ adoption: { dryRun: boolean } }>("/api/hub/registry/adopt", {
      apply: true,
      digest: restored.digest,
    });
    expect(applied.adoption.dryRun).toBe(false);
    expect(fake!.restores.length).toBe(restoresBefore);
  });

  it("shows the same disclosure the CLI prints before a restore", async () => {
    const listed = await postJson<{ restoreNotice: { headline: string; bullets: string[] } }>(
      "/api/hub/registry/backups",
      {},
    );
    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "src/cli.ts"), "hub", "registry", "restore", "some-backup", "--json"],
      { env: { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1" }, encoding: "utf8" },
    );
    expect(cli.status).toBe(2);
    const refusal = JSON.parse(cli.stderr.trim().split("\n").pop()!) as { notice: string[] };
    expect(listed.restoreNotice.headline).toBe(refusal.notice[0]);
    // The three bullets that describe what happens ON THE SERVICE, verbatim.
    expect(listed.restoreNotice.bullets.slice(0, 3)).toEqual(
      refusal.notice.slice(1, 4).map((line) => line.replace(/^\s*- /, "")),
    );
  });
});

describe("disconnect", () => {
  it("asks first, then removes the hub's credential and record, and nothing else", async () => {
    const hubId = storedHubId()!;
    const asked = await post("/api/hub/registry/disconnect", {});
    expect(asked.status).toBe(400);
    expect(readConnection(home, hubId)).not.toBeNull();

    const calls = fake!.calls.length;
    const done = await postJson<{ wasConnected: boolean; report: Report }>("/api/hub/registry/disconnect", {
      confirm: true,
    });
    expect(done.wasConnected).toBe(true);
    expect(readConnection(home, hubId)).toBeNull();
    expect(existsSync(join(home, "cloud", `${hubId}.token`))).toBe(false);
    expect(done.report.self.registry).toMatchObject({ hubId, connected: false, consent: false });
    // Local, and only local.
    expect(fake!.calls.length).toBe(calls);
    // The identity survives a disconnect.
    expect(storedHubId()).toBe(hubId);
  });
});
