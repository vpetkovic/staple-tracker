/**
 * The connection and credential lifecycle — one test per acceptance criterion on
 * STA-71, plus the boundaries the contract is emphatic about.
 *
 * The server is a fake `fetch`. That is deliberate rather than a shortcut: these
 * tests are about what the CLIENT does — what it sends, in what order, what it
 * writes to disk, and what it refuses — and a real Worker would make every one
 * of them slower and none of them stronger. The Worker's own behaviour is tested
 * in `worker/`, against `workerd`, with the real migrations.
 *
 * The one thing a fake buys that a real server could not: it can assert the
 * ORDER of requests, and that there were none at all before a given moment.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StapleError } from "../src/core/types.js";
import { parseEndpoint } from "../src/core/cloud/endpoint.js";
import {
  CredentialStoreUnavailable,
  credentialFilePath,
  fileCredentialStore,
  keychainCredentialStore,
  redactToken,
  secretToolCredentialStore,
  selectCredentialStore,
  type ExecFn,
} from "../src/core/cloud/credential-store.js";
import {
  connectionPath,
  deleteConnection,
  readConnection,
  setConsent,
  writeConnection,
} from "../src/core/cloud/connection.js";
import { buildConnectPreview, renderConnectPreview } from "../src/core/cloud/preview.js";
import {
  performConnect,
  performDisconnect,
  performPurge,
  performRevoke,
  retentionDisclosure,
} from "../src/core/cloud/connect.js";
import { describeState, localCloudStatus, refreshCloudStatus } from "../src/core/cloud/status.js";

const REPO_ID = "0e77fa01-1111-2222-3333-444444444444";
const ENDPOINT = "https://staple-sync-dev.example.workers.dev";
const MINTED = "stpl_a_real_looking_credential_value";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cloud-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------- the fake server

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fake `fetch` that records every request and answers from a route table.
 *
 * Records the Authorization header too, because a couple of these tests are
 * about which credential was presented — the enrollment secret on `connect`, the
 * minted device token on everything after it.
 */
function fakeServer(routes: Record<string, () => { status: number; body: unknown }>) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) {
      return new Response(JSON.stringify({ code: "not_found", message: "unknown route", retryable: false }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const { status, body } = route();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CAPABILITIES = {
  protocol: { min: 1, max: 1 },
  maxBatchSize: 25,
  maxOpBytes: 524288,
  maxPullLimit: 500,
  defaultPullLimit: 200,
  maxSnapshotPageSize: 500,
};

function happyServer() {
  return fakeServer({
    "GET /v1/capabilities": () => ({ status: 200, body: CAPABILITIES }),
    [`POST /v1/repos/${REPO_ID}/connect`]: () => ({
      status: 200,
      body: {
        protocol: 1,
        repoId: REPO_ID,
        deviceId: "device-from-server",
        epoch: 1,
        token: MINTED,
        capabilities: CAPABILITIES,
      },
    }),
  });
}

/**
 * Write a record straight to disk, bypassing `writeConnection`.
 *
 * Only for the damaged-file cases: `writeConnection` would refuse to serialize a
 * record that is not a valid one, which is exactly what these tests need on
 * disk. The directory has to be made by hand for the same reason.
 */
function writeRawRecord(body: string): void {
  mkdirSync(join(home, "cloud"), { recursive: true, mode: 0o700 });
  writeFileSync(connectionPath(home, REPO_ID), body, { mode: 0o600 });
}

function previewFor(): ReturnType<typeof buildConnectPreview> {
  return buildConnectPreview({
    home,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    label: "test machine",
    credential: { forceFile: true },
  });
}

async function connect(server = happyServer()) {
  const outcome = await performConnect(previewFor(), {
    home,
    enrollmentSecret: "enrollment-secret",
    credential: { forceFile: true },
    fetchImpl: server.impl,
  });
  return { outcome, server };
}

// ---------------------------------------------------------------- criterion 1

describe("connect shows before it asks, and nothing precedes consent", () => {
  it("building the preview issues no request at all", () => {
    const server = happyServer();
    // The preview is built with no fetch in scope. If it wanted one it could not
    // get to it: preview.ts does not import client.ts.
    const preview = previewFor();
    expect(server.calls).toHaveLength(0);
    expect(preview.repositoryId).toBe(REPO_ID);
    expect(preview.endpoint.origin).toBe(ENDPOINT);
  });

  it("the preview names the service, the repository and where the credential goes", () => {
    const rendered = renderConnectPreview(previewFor());
    expect(rendered).toContain(ENDPOINT);
    expect(rendered).toContain(REPO_ID);
    expect(rendered).toContain("test machine");
    expect(rendered).toContain("0600 file");
    // The disclosure the trust-boundaries section requires: plaintext on the server.
    expect(rendered).toContain("PLAINTEXT");
    expect(rendered).toContain("Nothing has been sent yet");
  });

  it("the FIRST request after consent is the unauthenticated read, and the mutation is second", async () => {
    const { server } = await connect();
    expect(server.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1/capabilities",
      `POST /v1/repos/${REPO_ID}/connect`,
    ]);
    // And capabilities carried no credential — it is the one unscoped route.
    expect(server.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("presents the ENROLLMENT credential on connect, in the Authorization header only", async () => {
    const { server } = await connect();
    const post = server.calls[1]!;
    expect(post.headers.authorization).toBe("Bearer enrollment-secret");
    // Never in the URL. The Worker's invocation log is `<Method> <URL>`.
    expect(post.url).not.toContain("enrollment-secret");
    expect(post.body).toEqual({ deviceId: expect.any(String), label: "test machine" });
  });

  it("sends Content-Length, which the Worker requires before it will parse a body", async () => {
    const { server } = await connect();
    expect(server.calls[1]!.headers["content-length"]).toMatch(/^\d+$/);
  });
});

// ---------------------------------------------------------------- criterion 2

describe("before a successful connection, no cloud state exists at all", () => {
  it("a fresh home has no connection record, no credential and no device id", () => {
    expect(existsSync(join(home, "cloud"))).toBe(false);
    expect(localCloudStatus(home, REPO_ID).state).toBe("disconnected");
  });

  it("building a preview does not mint a device id — the human may still say no", () => {
    const preview = previewFor();
    expect(preview.deviceId).toBeNull();
    expect(existsSync(join(home, "cloud", "device-id"))).toBe(false);
  });

  it("a failed connect leaves no credential and no record", async () => {
    const server = fakeServer({
      "GET /v1/capabilities": () => ({ status: 200, body: CAPABILITIES }),
      [`POST /v1/repos/${REPO_ID}/connect`]: () => ({
        status: 403,
        body: { code: "forbidden", message: "not a member of this repository", retryable: false },
      }),
    });

    await expect(
      performConnect(previewFor(), {
        home,
        enrollmentSecret: "wrong",
        credential: { forceFile: true },
        fetchImpl: server.impl,
      }),
    ).rejects.toThrow(/not a member/);

    expect(existsSync(connectionPath(home, REPO_ID))).toBe(false);
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(false);
    expect(localCloudStatus(home, REPO_ID).state).toBe("disconnected");
  });

  it("an unknown repository fails CLOSED as forbidden and is never auto-created", async () => {
    // The Worker's decision, asserted from the client's side: `forbidden`, not
    // `not_found`, because whether a repository id is registered is not
    // something an unauthenticated caller should be able to enumerate.
    const server = fakeServer({
      "GET /v1/capabilities": () => ({ status: 200, body: CAPABILITIES }),
      [`POST /v1/repos/${REPO_ID}/connect`]: () => ({
        status: 403,
        body: { code: "forbidden", message: "not a member of this repository", retryable: false },
      }),
    });
    const error = await performConnect(previewFor(), {
      home,
      enrollmentSecret: "x",
      credential: { forceFile: true },
      fetchImpl: server.impl,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).detail?.cloudCode).toBe("forbidden");
    expect((error as StapleError).detail?.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------- criterion 3

describe("credentials: repository-scoped, machine-local, redacted, protected", () => {
  it("stores the credential 0600 in a 0700 directory", async () => {
    await connect();
    const path = credentialFilePath(home, REPO_ID);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "cloud")).mode & 0o777).toBe(0o700);
    }
  });

  it("keys the credential by REPOSITORY, so one repository's token is not another's", () => {
    const store = fileCredentialStore(home);
    store.write(REPO_ID, "token-a");
    store.write("99999999-1111-2222-3333-444444444444", "token-b");
    expect(store.read(REPO_ID)).toBe("token-a");
    expect(store.read("99999999-1111-2222-3333-444444444444")).toBe("token-b");
  });

  it("never writes the token into the connection record", async () => {
    const { outcome } = await connect();
    const raw = readFileSync(connectionPath(home, REPO_ID), "utf8");
    expect(raw).not.toContain(MINTED);
    expect(Object.values(outcome.connection).join(" ")).not.toContain(MINTED);
  });

  it("never puts the token in an error, even when the server rejects it", async () => {
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: REPO_ID,
      endpoint: ENDPOINT,
      deviceId: "d1",
      label: null,
      credentialMechanism: "file",
      connectedAt: new Date().toISOString(),
      auto: false,
      backup: false,
      protocol: 1,
    });
    fileCredentialStore(home).write(REPO_ID, MINTED);

    const server = fakeServer({
      [`GET /v1/repos/${REPO_ID}/devices`]: () => ({
        status: 401,
        body: { code: "auth", message: "invalid credential", retryable: false },
      }),
    });
    const error = await performRevoke(home, REPO_ID, "other", {
      fetchImpl: server.impl,
      platform: process.platform,
    }).catch((e: unknown) => e);
    // Whatever it says, it does not say the secret.
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(MINTED);
  });

  it("redactToken discloses nothing — not a length, not a prefix", () => {
    expect(redactToken(MINTED)).toBe("<redacted>");
    expect(redactToken("short")).toBe("<redacted>");
    expect(redactToken(null)).toBe("<redacted>");
  });

  it("reports a credential file that has been widened rather than silently fixing it", async () => {
    if (process.platform === "win32") return;
    await connect();
    const { chmodSync } = await import("node:fs");
    chmodSync(credentialFilePath(home, REPO_ID), 0o644);
    const status = localCloudStatus(home, REPO_ID);
    expect(status.warnings.join(" ")).toMatch(/readable by users other than you/);
    // Still 0644 — reported, not repaired. The evidence survives.
    expect(statSync(credentialFilePath(home, REPO_ID)).mode & 0o777).toBe(0o644);
  });

  describe("the OS store, and the fallback when it will not answer", () => {
    it("prefers the keychain on darwin when the probe round-trips", () => {
      const stored = new Map<string, string>();
      const exec: ExecFn = (file, args) => {
        expect(file).toBe("security");
        if (args[0] === "add-generic-password") {
          stored.set(args[args.indexOf("-a") + 1]!, args[args.indexOf("-w") + 1]!);
          return "";
        }
        if (args[0] === "find-generic-password") {
          const value = stored.get(args[args.indexOf("-a") + 1]!);
          if (value === undefined) {
            const error = new Error("could not be found") as Error & { stderr: string };
            error.stderr = "The specified item could not be found in the keychain.";
            throw error;
          }
          return `${value}\n`;
        }
        if (args[0] === "delete-generic-password") {
          stored.delete(args[args.indexOf("-a") + 1]!);
          return "";
        }
        throw new Error(`unexpected ${args[0]}`);
      };

      const selection = selectCredentialStore(home, { platform: "darwin", exec });
      expect(selection.store.mechanism).toBe("keychain");
      expect(selection.fallbackReason).toBeNull();
      // The probe cleaned up after itself rather than leaving a sentinel behind.
      expect(stored.size).toBe(0);
    });

    it("falls back to the 0600 file when the keychain is locked, and SAYS SO", () => {
      const exec: ExecFn = () => {
        const error = new Error("locked") as Error & { stderr: string };
        error.stderr = "SecKeychainAddGenericPassword: User interaction is not allowed.";
        throw error;
      };
      const selection = selectCredentialStore(home, { platform: "darwin", exec });
      expect(selection.store.mechanism).toBe("file");
      expect(selection.fallbackReason).toMatch(/keychain/);
    });

    it("falls back when the binary is absent", () => {
      const exec: ExecFn = () => {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      };
      expect(selectCredentialStore(home, { platform: "linux", exec }).store.mechanism).toBe("file");
    });

    it("uses the file store on win32, where there is no OS store worth claiming", () => {
      const selection = selectCredentialStore(home, { platform: "win32" });
      expect(selection.store.mechanism).toBe("file");
      expect(selection.fallbackReason).toMatch(/no OS credential store on win32/);
    });

    it("hands secret-tool the secret on STDIN, never in argv", () => {
      let sawInput: string | undefined;
      let sawArgs: string[] = [];
      const exec: ExecFn = (_file, args, input) => {
        if (args[0] === "store") {
          sawArgs = args;
          sawInput = input;
        }
        return "";
      };
      secretToolCredentialStore(exec).write(REPO_ID, MINTED);
      expect(sawInput).toBe(MINTED);
      expect(sawArgs.join(" ")).not.toContain(MINTED);
    });

    it("treats a keychain that cannot be asked as unavailable, never as 'no credential'", () => {
      const exec: ExecFn = () => {
        const error = new Error("locked") as Error & { stderr: string };
        error.stderr = "User interaction is not allowed.";
        throw error;
      };
      // NOT null. Null would mean "you were never connected", and the natural
      // next move on that answer is to connect again, over the top of a
      // credential that was there all along.
      expect(() => keychainCredentialStore(exec).read(REPO_ID)).toThrow(CredentialStoreUnavailable);
    });
  });
});

// ---------------------------------------------------------------- criterion 4

describe("a successful connection leaves automatic sync disabled", () => {
  it("auto and backup are both false straight after connect", async () => {
    const { outcome } = await connect();
    expect(outcome.connection.auto).toBe(false);
    expect(outcome.connection.backup).toBe(false);
    expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
  });

  it("the preview promises it, in the JSON a script reads as well as the prose", () => {
    expect(previewFor().autoAfterConnect).toBe(false);
    expect(renderConnectPreview(previewFor())).toContain("AUTOMATIC SYNC STAYS OFF");
  });

  it("a RE-connect does not inherit a previous automatic-sync consent", async () => {
    await connect();
    setConsent(home, REPO_ID, { auto: true });
    expect(localCloudStatus(home, REPO_ID).state).toBe("automatic");

    // Re-connecting happens because something went wrong with the credential.
    // Resuming background traffic at that moment would be exactly backwards.
    await connect();
    expect(readConnection(home, REPO_ID)!.auto).toBe(false);
    expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
  });

  it("auto on/off is per-device state and does not disconnect", async () => {
    await connect();
    expect(setConsent(home, REPO_ID, { auto: true }).auto).toBe(true);
    expect(setConsent(home, REPO_ID, { auto: false }).auto).toBe(false);
    // Still connected. Turning automatic sync off is not disconnecting.
    expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(true);
  });

  it("consent cannot be granted for a repository that is not connected", () => {
    expect(() => setConsent(home, REPO_ID, { auto: true })).toThrow(/not connected/);
  });

  it("a damaged consent flag reads as NOT consented", () => {
    writeRawRecord(
      JSON.stringify({
        schemaVersion: 1,
        repositoryId: REPO_ID,
        endpoint: ENDPOINT,
        deviceId: "d1",
        credentialMechanism: "file",
        connectedAt: new Date().toISOString(),
        auto: "yes please", // not a boolean
        protocol: 1,
      }),
    );
    // The safe reading of a value that cannot be understood is that permission
    // was never given. It is the only reading that cannot start sending data.
    expect(readConnection(home, REPO_ID)!.auto).toBe(false);
  });
});

// ---------------------------------------------------------------- criterion 5

describe("disconnect is local, and preserves everything local", () => {
  it("removes the credential and the record, and makes no network call", async () => {
    await connect();
    const server = fakeServer({});

    const outcome = performDisconnect(home, REPO_ID);
    expect(outcome.wasConnected).toBe(true);
    expect(outcome.credentialRemoved).toBe(true);
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(false);
    expect(existsSync(connectionPath(home, REPO_ID))).toBe(false);
    // `performDisconnect` is synchronous and takes no fetch — there is no
    // parameter through which it could have made one.
    expect(server.calls).toHaveLength(0);
  });

  it("stops later cloud traffic: every remote operation now refuses locally", async () => {
    await connect();
    performDisconnect(home, REPO_ID);
    const server = fakeServer({ [`GET /v1/repos/${REPO_ID}/devices`]: () => ({ status: 200, body: { devices: [] } }) });

    await expect(performRevoke(home, REPO_ID, "x", { fetchImpl: server.impl })).rejects.toThrow(
      /not connected/,
    );
    // Refused before anything was sent — which is what "stops later cloud
    // traffic" has to mean to be worth anything.
    expect(server.calls).toHaveLength(0);
  });

  it("is idempotent — disconnecting twice is not an error", async () => {
    await connect();
    expect(performDisconnect(home, REPO_ID).wasConnected).toBe(true);
    expect(performDisconnect(home, REPO_ID).wasConnected).toBe(false);
  });

  it("leaves other repositories on this machine connected", async () => {
    await connect();
    const other = "77777777-1111-2222-3333-444444444444";
    writeConnection(home, {
      schemaVersion: 1,
      repositoryId: other,
      endpoint: ENDPOINT,
      deviceId: "d1",
      label: null,
      credentialMechanism: "file",
      connectedAt: new Date().toISOString(),
      auto: false,
      backup: false,
      protocol: 1,
    });
    fileCredentialStore(home).write(other, "other-token");

    performDisconnect(home, REPO_ID);
    expect(localCloudStatus(home, other).state).toBe("manual");
    expect(fileCredentialStore(home).read(other)).toBe("other-token");
  });

  it("preserves the local database INCLUDING pending outbox operations", async () => {
    // The criterion says "preserves local state plus pending operations", and
    // the pending ones are the part worth testing: they are unsent work, and a
    // disconnect that dropped them would lose data that exists nowhere else.
    const { initWorkspace } = await import("../src/core/workspace.js");
    const previous = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    const ws = initWorkspace({ global: true, slug: "disc" });
    try {
      ws.store.createIssue({ title: "local work", assignee: "tester" });
      ws.store.db
        .prepare(
          `INSERT INTO sync_outbox (op_id, client_seq, entity, entity_id, verb, payload, created_at)
           VALUES ('op-1', 1, 'issue', 'i-1', 'update', '{}', '2026-09-05T00:00:00.000Z')`,
        )
        .run();

      await connect();
      performDisconnect(home, REPO_ID);

      const pending = ws.store.db
        .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL")
        .get() as { n: number };
      expect(pending.n).toBe(1);
      expect(ws.store.listIssues({}).map((i) => i.title)).toContain("local work");
    } finally {
      ws.store.db.close();
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  });

  it("goes through with the disconnect even when the credential store will not release", async () => {
    await connect();
    // A keychain that refuses must not be able to keep a machine connected.
    writeConnection(home, { ...readConnection(home, REPO_ID)!, credentialMechanism: "keychain" });
    const exec: ExecFn = () => {
      const error = new Error("locked") as Error & { stderr: string };
      error.stderr = "User interaction is not allowed.";
      throw error;
    };
    const outcome = performDisconnect(home, REPO_ID, { platform: "darwin", exec });
    expect(outcome.credentialRemoved).toBe(false);
    expect(outcome.recordRemoved).toBe(true);
    expect(localCloudStatus(home, REPO_ID).state).toBe("disconnected");
  });
});

// ---------------------------------------------------------------- criterion 6

describe("device revocation", () => {
  beforeEach(async () => {
    await connect();
  });

  it("targets exactly one device, by id, in the path", async () => {
    const server = fakeServer({
      [`DELETE /v1/repos/${REPO_ID}/devices/laptop-2`]: () => ({
        status: 200,
        body: { protocol: 1, deviceId: "laptop-2", revoked: true },
      }),
    });
    const outcome = await performRevoke(home, REPO_ID, "laptop-2", { fetchImpl: server.impl });
    expect(outcome).toEqual({ deviceId: "laptop-2", revoked: true, self: false });
    expect(server.calls).toHaveLength(1);
    expect(new URL(server.calls[0]!.url).pathname).toBe(`/v1/repos/${REPO_ID}/devices/laptop-2`);
    expect(server.calls[0]!.method).toBe("DELETE");
  });

  it("presents the DEVICE token, not the enrollment secret, and names itself in Staple-Device", async () => {
    const server = fakeServer({
      [`DELETE /v1/repos/${REPO_ID}/devices/laptop-2`]: () => ({
        status: 200,
        body: { deviceId: "laptop-2", revoked: true },
      }),
    });
    await performRevoke(home, REPO_ID, "laptop-2", { fetchImpl: server.impl });
    expect(server.calls[0]!.headers.authorization).toBe(`Bearer ${MINTED}`);
    expect(server.calls[0]!.headers["staple-device"]).toBe("device-from-server");
  });

  it("does not disturb this device's own credential or connection", async () => {
    const server = fakeServer({
      [`DELETE /v1/repos/${REPO_ID}/devices/laptop-2`]: () => ({
        status: 200,
        body: { deviceId: "laptop-2", revoked: true },
      }),
    });
    await performRevoke(home, REPO_ID, "laptop-2", { fetchImpl: server.impl });
    expect(localCloudStatus(home, REPO_ID).state).toBe("manual");
    expect(fileCredentialStore(home).read(REPO_ID)).toBe(MINTED);
  });

  it("revoking THIS device is allowed, reported, and does not delete the local credential", async () => {
    const server = fakeServer({
      [`DELETE /v1/repos/${REPO_ID}/devices/device-from-server`]: () => ({
        status: 200,
        body: { deviceId: "device-from-server", revoked: true },
      }),
    });
    const outcome = await performRevoke(home, REPO_ID, "device-from-server", { fetchImpl: server.impl });
    expect(outcome.self).toBe(true);
    // Revoke is not disconnect. Conflating them is the mistake this contract
    // spends a whole section keeping apart.
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(true);
  });

  it("a revoked device learns it on its very next request, as `revoked` not `auth`", async () => {
    const server = fakeServer({
      [`GET /v1/repos/${REPO_ID}/devices`]: () => ({
        status: 403,
        body: { code: "revoked", message: "this device was revoked; re-connect required", retryable: false },
      }),
    });
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.impl });
    expect(status.state).toBe("revoked");
    expect(describeState(status)).toMatch(/re-connect/);
  });
});

// ---------------------------------------------------------------- criterion 7

describe("purge is a different decision from disconnect", () => {
  it("the retention disclosure says what is stored, for how long, and who can read it", () => {
    const disclosure = retentionDisclosure(ENDPOINT, REPO_ID);
    expect(disclosure).toContain("What is stored there");
    expect(disclosure).toContain("PLAINTEXT");
    expect(disclosure).toContain("How long");
    expect(disclosure).toContain("indefinitely");
    expect(disclosure).toContain("Who can read it");
    expect(disclosure).toContain("Cloudflare account");
    expect(disclosure).toContain("does NOT touch your local database");
    expect(disclosure).toContain("not reversible");
  });

  it("names the repository id, which is what has to be typed back", () => {
    expect(retentionDisclosure(ENDPOINT, REPO_ID)).toContain(REPO_ID);
  });

  it("targets DELETE on the repository itself, not on a device", async () => {
    await connect();
    const server = fakeServer({ [`DELETE /v1/repos/${REPO_ID}`]: () => ({ status: 200, body: { purged: true } }) });
    const outcome = await performPurge(home, REPO_ID, { fetchImpl: server.impl });
    expect(outcome).toEqual({ purged: true, unsupported: false });
    expect(server.calls[0]!.method).toBe("DELETE");
    expect(new URL(server.calls[0]!.url).pathname).toBe(`/v1/repos/${REPO_ID}`);
  });

  it("reports UNSUPPORTED rather than success when the endpoint has no purge route", async () => {
    // This is the deployed Worker's actual behaviour today: purge belongs to the
    // restore lane and the router answers `not_found`. Saying "purged" here
    // would tell somebody their data was destroyed when it was not.
    await connect();
    const server = fakeServer({});
    const outcome = await performPurge(home, REPO_ID, { fetchImpl: server.impl });
    expect(outcome).toEqual({ purged: false, unsupported: true });
    // And the credential is still here, so they can try again or check.
    expect(existsSync(credentialFilePath(home, REPO_ID))).toBe(true);
  });

  it("refuses without a connection rather than inventing an endpoint", async () => {
    const server = fakeServer({});
    await expect(performPurge(home, REPO_ID, { fetchImpl: server.impl })).rejects.toThrow(/not connected/);
    expect(server.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- criterion 8

describe("status distinguishes all six states, in prose and in JSON", () => {
  it("disconnected, with no endpoint and no credential", () => {
    const status = localCloudStatus(home, REPO_ID);
    expect(status.state).toBe("disconnected");
    expect(status.endpoint).toBeNull();
    expect(status.credentialPresent).toBe(false);
    expect(describeState(status)).toMatch(/not connected/);
  });

  it("manual, immediately after connecting", async () => {
    await connect();
    const status = localCloudStatus(home, REPO_ID);
    expect(status.state).toBe("manual");
    expect(describeState(status)).toMatch(/nothing synchronizes until/);
    // And it did not ask anyone to find that out.
    expect(status.checked).toBe(false);
  });

  it("automatic, once this device has separately consented", async () => {
    await connect();
    setConsent(home, REPO_ID, { auto: true });
    const status = localCloudStatus(home, REPO_ID);
    expect(status.state).toBe("automatic");
    expect(describeState(status)).toMatch(/on its own/);
  });

  it("offline, when the endpoint cannot be reached — and that is not an error", async () => {
    await connect();
    const impl = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: impl });
    expect(status.state).toBe("offline");
    expect(status.checked).toBe(true);
    expect(describeState(status)).toMatch(/local work is unaffected/);
  });

  it("revoked, when the server says so", async () => {
    await connect();
    const server = fakeServer({
      [`GET /v1/repos/${REPO_ID}/devices`]: () => ({
        status: 403,
        body: { code: "revoked", message: "revoked", retryable: false },
      }),
    });
    expect((await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.impl })).state).toBe("revoked");
  });

  it("auth_failed, when the credential is rejected", async () => {
    await connect();
    const server = fakeServer({
      [`GET /v1/repos/${REPO_ID}/devices`]: () => ({
        status: 401,
        body: { code: "auth", message: "invalid credential", retryable: false },
      }),
    });
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.impl });
    expect(status.state).toBe("auth_failed");
    expect(describeState(status)).toMatch(/re-connect/);
  });

  it("auth_failed locally, when the record names a credential that is gone", async () => {
    await connect();
    rmSync(credentialFilePath(home, REPO_ID));
    const status = localCloudStatus(home, REPO_ID);
    expect(status.state).toBe("auth_failed");
    expect(status.credentialPresent).toBe(false);
  });

  it("a missing credential is not sent as an empty bearer just to find out", async () => {
    await connect();
    rmSync(credentialFilePath(home, REPO_ID));
    const server = fakeServer({});
    const status = await refreshCloudStatus(home, REPO_ID, { fetchImpl: server.impl });
    expect(status.state).toBe("auth_failed");
    expect(server.calls).toHaveLength(0);
  });

  it("every state has its own sentence, and no two share one", () => {
    const states = ["disconnected", "manual", "automatic", "offline", "revoked", "auth_failed"] as const;
    const sentences = states.map((state) =>
      describeState({ ...localCloudStatus(home, REPO_ID), state }),
    );
    expect(new Set(sentences).size).toBe(states.length);
  });
});

// ------------------------------------------------------------ endpoint refusal

describe("the endpoint is refused at connect time, not discovered later", () => {
  it("refuses plaintext http for a real host", () => {
    expect(() => parseEndpoint("http://sync.example.com")).toThrow(/must be https/);
  });

  it("allows plaintext loopback, which is how `wrangler dev --local` is reached", () => {
    expect(parseEndpoint("http://127.0.0.1:8787").loopback).toBe(true);
    expect(parseEndpoint("http://localhost:8787").origin).toBe("http://localhost:8787");
  });

  it("refuses userinfo rather than stripping it, because the paste probably held a secret", () => {
    expect(() => parseEndpoint("https://user:secret@sync.example.com")).toThrow(/username or password/);
  });

  it("refuses a query string, so a credential can never arrive in one by habit", () => {
    expect(() => parseEndpoint("https://sync.example.com/?token=abc")).toThrow(/bare origin/);
  });

  it("normalizes a trailing path away rather than carrying a component with no effect", () => {
    expect(parseEndpoint("https://sync.example.com/v1/").origin).toBe("https://sync.example.com");
  });
});

// ------------------------------------------------- the connection record itself

describe("the connection record", () => {
  it("refuses an unreadable record rather than reporting 'never connected'", () => {
    writeRawRecord("{ truncated");
    expect(() => readConnection(home, REPO_ID)).toThrow(/not valid JSON/);
  });

  it("refuses a record written by a newer build rather than rewriting it", () => {
    writeRawRecord(JSON.stringify({ schemaVersion: 99, repositoryId: REPO_ID }));
    expect(() => readConnection(home, REPO_ID)).toThrow(/newer staple/);
  });

  it("is absent, not false, when there is no connection", async () => {
    await connect();
    deleteConnection(home, REPO_ID);
    expect(existsSync(connectionPath(home, REPO_ID))).toBe(false);
    expect(readConnection(home, REPO_ID)).toBeNull();
  });
});
