/**
 * STA-256: a remote purge carries its typed confirmation on the wire, and the service
 * refuses one that does not.
 *
 * `staple cloud purge` has always demanded the repository id typed back, but the client
 * then sent a bare `DELETE /v1/repos/{repoId}` and the Worker purged on the bearer
 * credential alone — so the confirmation existed only in this build's terminal, and any
 * holder of a device token could destroy the repository without it. The fake below used
 * to purge on a bare DELETE too, so every client test of purge proved a request the
 * product promised to refuse.
 *
 * Three layers, each against the rule and not against a stub that agrees with the client:
 *
 *   1. The fake refuses and accepts exactly what the Worker does. Both are held to
 *      `worker/test/purge-fixture.ts`; `worker/test/backups.test.ts` holds the Worker.
 *   2. The client sends what was typed, and maps the two refusals to a sentence that
 *      says nothing was purged.
 *   3. The real CLI, as a subprocess, over a real loopback socket, against that fake.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudCodeOf } from "../src/core/cloud/client.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { performPurge } from "../src/core/cloud/connect.js";
import { credentialFilePath, credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { StapleError } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { PURGE_REFUSALS } from "../worker/test/purge-fixture.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const OTHER_REPO_ID = "0e77fa01-9999-4222-8333-444455556666";
const ENDPOINT = "https://sync.test.example";
const DEVICE = "device-purger";
const TOKEN = "stpl_purger";

let home: string;
let server: FakeSyncServer;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-purge-home-"));
  server = new FakeSyncServer({ repositoryId: REPO_ID });
  server.enroll(DEVICE, TOKEN);
  server.enroll("device-bystander", "stpl_bystander");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** One request, shaped exactly as `src/core/cloud/client.ts` shapes it. */
function raw(method: string, path: string, body?: unknown, token = TOKEN, device = DEVICE) {
  const headers: Record<string, string> = {
    "Staple-Protocol": "1",
    Authorization: `Bearer ${token}`,
    "Staple-Device": device,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload, "utf8"));
  }
  return server.fetch(`${ENDPOINT}${path}`, { method, headers, body: payload });
}

/** Something in every part of the fake that a purge deletes. */
async function populate(): Promise<void> {
  const op = (clientSeq: number, entityId: string) => ({
    opId: `op-${clientSeq}`,
    repoId: REPO_ID,
    protocol: 1,
    schema: 10,
    entity: "issue",
    entityId,
    verb: "create",
    baseVersion: null,
    payload: { title: entityId },
    deviceId: DEVICE,
    actor: "opus-purger",
    clientSeq,
    createdAt: "2026-09-10T10:00:00.000Z",
  });
  const pushed = await raw("POST", `/v1/repos/${REPO_ID}/ops`, {
    protocol: 1,
    deviceId: DEVICE,
    ops: [op(1, "issue-1"), op(2, "issue-2")],
  });
  expect(pushed.status).toBe(200);
  expect((await raw("PUT", `/v1/repos/${REPO_ID}/backup`, { enabled: true })).status).toBe(200);
  expect((await raw("POST", `/v1/repos/${REPO_ID}/backups`, {})).status).toBe(200);
  const lease = await raw("POST", `/v1/repos/${REPO_ID}/leases`, {
    entityId: "issue-1",
    holder: "opus-purger",
    ttlSeconds: 300,
  });
  expect(lease.status).toBe(200);
}

/** Everything a purge would delete, as one comparable value. */
function holdings() {
  return {
    ops: server.ops.map((op) => op.opId),
    backups: server.backups.length,
    leases: [...server.leases.keys()],
    vocabulary: server.vocabulary,
  };
}

/** True while a credential still authenticates, which a purge ends. */
async function stillEnrolled(token = TOKEN, device = DEVICE): Promise<boolean> {
  return (await raw("GET", `/v1/repos/${REPO_ID}/devices`, undefined, token, device)).status === 200;
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

// ------------------------------------------------------------- 1. the fake is the Worker

describe("the fake refuses exactly what the Worker refuses", () => {
  it("refuses a bare DELETE — every earlier client's request — and deletes nothing", async () => {
    await populate();
    const before = holdings();

    expect(await answer(await raw("DELETE", `/v1/repos/${REPO_ID}`))).toEqual(PURGE_REFUSALS.missing);

    expect(holdings()).toEqual(before);
    expect(before.ops).toHaveLength(2);
    expect(await stillEnrolled()).toBe(true);
    expect(await stillEnrolled("stpl_bystander", "device-bystander")).toBe(true);
  });

  it("treats an empty body and a body without `confirm` as no confirmation", async () => {
    await populate();
    const before = holdings();

    expect(await answer(await raw("DELETE", `/v1/repos/${REPO_ID}`, ""))).toEqual(PURGE_REFUSALS.missing);
    expect(await answer(await raw("DELETE", `/v1/repos/${REPO_ID}`, {}))).toEqual(PURGE_REFUSALS.missing);
    expect(await answer(await raw("DELETE", `/v1/repos/${REPO_ID}`, { repositoryId: REPO_ID }))).toEqual(
      PURGE_REFUSALS.missing,
    );

    expect(holdings()).toEqual(before);
    expect(await stillEnrolled()).toBe(true);
  });

  it("refuses a wrong confirmation and deletes nothing", async () => {
    await populate();
    const before = holdings();

    for (const confirm of [OTHER_REPO_ID, ` ${REPO_ID}`, "", null, 1, [REPO_ID]]) {
      expect(await answer(await raw("DELETE", `/v1/repos/${REPO_ID}`, { confirm }))).toEqual(
        PURGE_REFUSALS.mismatch,
      );
    }

    expect(holdings()).toEqual(before);
    expect(await stillEnrolled()).toBe(true);
  });

  it("purges everything, leases included, with the right confirmation", async () => {
    await populate();

    const response = await raw("DELETE", `/v1/repos/${REPO_ID}`, { confirm: REPO_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ purged: true });

    expect(holdings()).toEqual({ ops: [], backups: 0, leases: [], vocabulary: null });
    expect(await stillEnrolled()).toBe(false);
    expect(await stillEnrolled("stpl_bystander", "device-bystander")).toBe(false);
  });
});

// ----------------------------------------------------------------- 2. the client

function connectHere(endpoint = ENDPOINT, repositoryId = REPO_ID): void {
  credentialStoreFor(home, "file").write(repositoryId, TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint,
    deviceId: DEVICE,
    label: DEVICE,
    credentialMechanism: "file",
    connectedAt: "2026-09-10T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
}

/** Records each request's body on its way to the fake. */
function recording(inner: typeof fetch) {
  const bodies: Array<{ method: string; body: unknown }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push({
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return inner(input, init);
  }) as typeof fetch;
  return { impl, bodies };
}

/**
 * A hop that drops a DELETE's body on the way through. RFC 9110 gives a DELETE body
 * no defined semantics, so an intermediary that strips one is conforming — and it is
 * the one way this build's purge can arrive without its confirmation.
 */
function strippingDeleteBodies(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "DELETE") return inner(input, init);
    const headers = { ...(init.headers as Record<string, string>) };
    delete headers["Content-Length"];
    delete headers["Content-Type"];
    return inner(input, { ...init, headers, body: undefined });
  }) as typeof fetch;
}

describe("the client sends what was typed, against the rule", () => {
  it("purges end to end when the typed confirmation is the repository id", async () => {
    connectHere();
    await populate();
    const wire = recording(server.fetch);

    const outcome = await performPurge(home, REPO_ID, REPO_ID, { fetchImpl: wire.impl });

    expect(outcome).toEqual({ purged: true, unsupported: false });
    expect(wire.bodies).toEqual([{ method: "DELETE", body: { confirm: REPO_ID } }]);
    expect(holdings()).toEqual({ ops: [], backups: 0, leases: [], vocabulary: null });
  });

  it("sends the TYPED value, so the service is what decides a wrong one", async () => {
    connectHere();
    await populate();
    const before = holdings();
    const wire = recording(server.fetch);

    const refused = await performPurge(home, REPO_ID, OTHER_REPO_ID, { fetchImpl: wire.impl }).catch(
      (error: unknown) => error,
    );

    expect(wire.bodies).toEqual([{ method: "DELETE", body: { confirm: OTHER_REPO_ID } }]);
    expect(refused).toBeInstanceOf(StapleError);
    const error = refused as StapleError;
    expect(error.code).toBe("validation");
    expect(cloudCodeOf(error)).toBe("validation");
    expect(error.message).toMatch(/^NOTHING WAS PURGED\. /);
    expect(error.message).toContain("does not name the repository this machine's credential belongs to");
    expect(error.message).toContain("Your remote data is untouched");
    expect(error.detail).toMatchObject({
      confirmation: "mismatch",
      retryable: false,
      serverMessage: PURGE_REFUSALS.mismatch.body.message,
    });

    expect(holdings()).toEqual(before);
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(true);
  });

  it("names a body dropped in transit, rather than blaming the person or the build", async () => {
    connectHere();
    await populate();
    const before = holdings();

    const refused = (await performPurge(home, REPO_ID, REPO_ID, {
      fetchImpl: strippingDeleteBodies(server.fetch),
    }).catch((error: unknown) => error)) as StapleError;

    expect(refused).toBeInstanceOf(StapleError);
    expect(refused.message).toMatch(/^NOTHING WAS PURGED\. /);
    expect(refused.message).toContain("dropping the body of DELETE requests");
    expect(refused.detail).toMatchObject({
      confirmation: "missing",
      serverMessage: PURGE_REFUSALS.missing.body.message,
    });
    expect(holdings()).toEqual(before);
  });

  it("leaves every other validation error alone", async () => {
    connectHere();
    // A validation that is not a purge refusal must not be dressed up as one.
    const refused = (await performPurge(home, REPO_ID, REPO_ID, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: "validation", message: "something else", retryable: false }), {
          status: 400,
        })) as typeof fetch,
    }).catch((error: unknown) => error)) as StapleError;
    expect(refused.message).toBe("something else");
  });
});

// ------------------------------------------------------------------- 3. the real CLI

const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");

/**
 * The fake, behind a real loopback socket, so the CLI subprocess reaches it through its
 * own unmodified transport. `http://127.0.0.1` is the one plaintext endpoint the client
 * accepts (`endpoint.ts`). `hop` sits in front and may rewrite a request, which is how
 * a body-dropping intermediary is put on the path.
 */
async function listen(hop: (inner: typeof fetch) => typeof fetch = (inner) => inner) {
  const upstream = hop(server.fetch);
  const bodies: unknown[] = [];
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      bodies.push(text.length > 0 ? JSON.parse(text) : undefined);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      void upstream(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: text.length > 0 ? text : undefined,
      }).then(async (response) => {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const { port } = http.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, bodies, close: () => new Promise((r) => http.close(r)) };
}

/** Async, because the loopback server lives on this process's event loop. */
function staple(cwd: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [TSX, CLI, ...args], {
    env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "purge-test", NODE_NO_WARNINGS: "1" },
    cwd,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

/** A real workspace, whose repository id the fake serves. */
function workspace(): { dir: string; repositoryId: string } {
  const dir = mkdtempSync(join(tmpdir(), "staple-purge-repo-"));
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  try {
    const ws = initWorkspace({ dir, slug: `purge${Math.random().toString(36).slice(2, 8)}` });
    ws.store.db.close();
  } finally {
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
  const repositoryId = (
    JSON.parse(readFileSync(join(dir, ".staple", "repository.json"), "utf8")) as { repositoryId: string }
  ).repositoryId;
  return { dir, repositoryId };
}

describe("`staple cloud purge`, end to end over a socket", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  async function scenario(hop?: (inner: typeof fetch) => typeof fetch) {
    const { dir, repositoryId } = workspace();
    dirs.push(dir);
    server = new FakeSyncServer({ repositoryId });
    server.enroll(DEVICE, TOKEN);
    const socket = await listen(hop);
    credentialStoreFor(home, "file").write(repositoryId, TOKEN);
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId,
      endpoint: socket.endpoint,
      deviceId: DEVICE,
      label: DEVICE,
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    // Something to lose, pushed the way the client pushes.
    const pushed = await server.fetch(`${socket.endpoint}/v1/repos/${repositoryId}/ops`, {
      method: "POST",
      headers: { "Staple-Protocol": "1", Authorization: `Bearer ${TOKEN}`, "Staple-Device": DEVICE },
      body: JSON.stringify({
        protocol: 1,
        deviceId: DEVICE,
        ops: [
          {
            opId: "op-1",
            repoId: repositoryId,
            protocol: 1,
            schema: 10,
            entity: "issue",
            entityId: "issue-1",
            verb: "create",
            baseVersion: null,
            payload: { title: "keep me" },
            deviceId: DEVICE,
            actor: "purge-test",
            clientSeq: 1,
            createdAt: "2026-09-10T10:00:00.000Z",
          },
        ],
      }),
    });
    expect(pushed.status).toBe(200);
    return { dir, repositoryId, socket };
  }

  it("sends the typed id and purges", async () => {
    const { dir, repositoryId, socket } = await scenario();
    try {
      const result = await staple(dir, "cloud", "purge", "--confirm", repositoryId);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Remote state for this repository has been destroyed");
      expect(socket.bodies).toEqual([{ confirm: repositoryId }]);
      expect(server.ops).toEqual([]);
    } finally {
      await socket.close();
    }
  }, 60_000);

  it("says NOTHING WAS PURGED, exits 2 and keeps the data when the confirmation does not arrive", async () => {
    const { dir, repositoryId, socket } = await scenario(strippingDeleteBodies);
    try {
      const human = await staple(dir, "cloud", "purge", "--confirm", repositoryId);
      expect(human.status).toBe(2);
      expect(human.stderr).toContain("error(validation): NOTHING WAS PURGED.");
      expect(human.stderr).toContain("Your remote data is untouched");
      expect(human.stdout).not.toContain("has been destroyed");

      const json = await staple(dir, "cloud", "purge", "--confirm", repositoryId, "--json");
      expect(json.status).toBe(2);
      const envelope = JSON.parse(json.stderr.trim().split("\n").at(-1)!) as {
        code: string;
        retryable: boolean;
        detail: Record<string, unknown>;
      };
      expect(envelope).toMatchObject({
        code: "validation",
        retryable: false,
        detail: { cloudCode: "validation", confirmation: "missing" },
      });

      expect(server.ops.map((op) => op.opId)).toEqual(["op-1"]);
      expect(existsSync(credentialFilePath(home, repositoryId))).toBe(true);
    } finally {
      await socket.close();
    }
  }, 60_000);
});
