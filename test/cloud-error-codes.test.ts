/**
 * STA-251: every cloud sync failure surfaces with its TRUE code.
 *
 * The sync protocol has thirteen wire codes and one client-side one (`offline`), and three
 * of the fourteen are retryable (`docs/sync.md`, "Error taxonomy"). `StapleErrorCode` used to
 * have none of the sync-only members, so the client folded each into the nearest store code
 * — `auth`, `forbidden`, `revoked` and five others became `validation` (exit 2), while
 * `rate_limited`, `unavailable` and `offline` became a NON-retryable `conflict` (exit 4) — and
 * carried the truth only in `detail.cloudCode`.
 *
 * Every assertion here goes through the real client against `FakeSyncServer`, which answers
 * with the Worker's own error shape, and then through the real CLI in a child process, whose
 * requests reach the same fake over loopback HTTP. Nothing calls the mapper directly.
 *
 *   - "every wire code" walks the Worker's own list (`SYNC_WIRE_CODES`, pinned to
 *     `worker/src/errors.ts`'s type), injecting each exactly as the Worker would send it;
 *   - "on the surface that produces it" reaches each code the way it arises in use — a
 *     wrong credential, a revoked device, a lease race, a stale cursor — on the connect,
 *     sync, lease and backup surfaces the ticket names;
 *   - each asserts the StapleError code, the retry bit, the preserved `detail.cloudCode` and
 *     `detail.retryable`, and the CLI's exit code.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindJournal } from "../src/core/journal.js";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import { StapleError, errorEnvelope } from "../src/core/types.js";
import { deleteBackup, listBackups } from "../src/core/cloud/backup.js";
import { acquireRemoteLease, isVocabularyRefusal } from "../src/core/cloud/client.js";
import { fetchDevices, performConnect } from "../src/core/cloud/connect.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { parseEndpoint } from "../src/core/cloud/endpoint.js";
import { acquireClaim } from "../src/core/cloud/lease.js";
import { buildConnectPreview } from "../src/core/cloud/preview.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { CLI_EXIT_CODES, ERROR_CONTRACT, SYNC_WIRE_CODES } from "./fixtures/error-contract.js";
import { FakeSyncServer, type FakeServerOptions } from "./fixtures/fake-sync-server.js";
import { readCode, sourceFiles } from "./fixtures/source-scan.js";
import type { ErrorCode } from "../worker/src/errors.js";
import { SyncError, statusFor } from "../worker/src/errors.js";

const REPO_ROOT = process.cwd();
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(REPO_ROOT, "src", "cli.ts");
const DEVICE = "device-a";
const TOKEN = "token-a";

type SyncCode = ErrorCode | "offline";

let service: Server;
/** The loopback origin the CLI child and the in-process client both talk to. */
let endpoint: string;
/** A loopback origin nothing listens on: the real `offline` path, a refused connection. */
let deadEndpoint: string;
/** The fake the loopback service forwards to. Replaced per scenario. */
let current: FakeSyncServer | null = null;
const cleanup: string[] = [];

/**
 * Moves bytes between a socket and `current.fetch`, and nothing else: the status, the body
 * and EVERY header, so a `retry-after` reaches the client as the Worker sends it.
 */
async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }
  const answer = await current!.fetch(new URL(req.url ?? "/", endpoint).toString(), {
    method: req.method,
    headers,
    ...(body === "" ? {} : { body }),
  });
  const out: Record<string, string> = {};
  answer.headers.forEach((value, key) => {
    out[key] = value;
  });
  res.writeHead(answer.status, out);
  res.end(await answer.text());
}

beforeAll(async () => {
  service = createServer((req, res) => void forward(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  deadEndpoint = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  probe.close();
  await once(probe, "close");
});

afterAll(() => {
  service?.close();
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-errcodes-${label}-`));
  cleanup.push(dir);
  return dir;
}

interface Scenario {
  readonly home: string;
  readonly dir: string;
  readonly dbPath: string;
  readonly repositoryId: string;
  readonly server: FakeSyncServer;
}

/**
 * One machine with one workspace, connected to a fresh fake as `device-a`.
 *
 * Its own staple home, so no scenario sees another's connection record, credential or hub.
 * `token` overrides the credential written locally, for a device holding a wrong one;
 * `endpoint` points the connection somewhere else.
 */
function scenario(
  label: string,
  options: {
    server?: Omit<FakeServerOptions, "repositoryId">;
    token?: string;
    endpoint?: string;
    backup?: boolean;
    before?: (store: WorkspaceStore) => void;
  } = {},
): Scenario {
  const home = tmp(`home-${label}`);
  const dir = tmp(`ws-${label}`);
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ dir, slug: `err${label.replace(/[^a-z]/g, "")}` });
  options.before?.(ws.store);
  ws.store.db.close();
  const repositoryId = (
    JSON.parse(readFileSync(join(dir, ".staple", "repository.json"), "utf8")) as { repositoryId: string }
  ).repositoryId;

  const server = new FakeSyncServer({ repositoryId, ...options.server });
  server.enroll(DEVICE, TOKEN);
  current = server;

  credentialStoreFor(home, "file").write(repositoryId, options.token ?? TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId,
    endpoint: options.endpoint ?? endpoint,
    deviceId: DEVICE,
    label: DEVICE,
    credentialMechanism: "file",
    connectedAt: "2026-09-10T00:00:00.000Z",
    auto: false,
    backup: options.backup ?? false,
    protocol: 1,
  });
  return { home, dir, dbPath: join(dir, ".staple", "staple.db"), repositoryId, server };
}

/** `staple …` in the scenario's workspace. Async, so this process can keep serving the fake. */
function staple(s: Scenario, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: s.dir,
      env: { ...process.env, STAPLE_HOME: s.home, STAPLE_AGENT: "error-codes", NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Run `work` and return what it threw. Fails the test if it resolved. */
async function refusal(work: () => Promise<unknown>): Promise<StapleError> {
  let caught: unknown = null;
  try {
    await work();
  } catch (error) {
    caught = error;
  }
  expect(caught, "the call succeeded, and it was supposed to be refused").toBeInstanceOf(StapleError);
  return caught as StapleError;
}

/** The facts a caller branches on, from one in-process refusal. */
function inProcess(error: StapleError) {
  const envelope = errorEnvelope(error);
  return {
    code: envelope.code,
    retryable: envelope.retryable,
    cloudCode: envelope.detail?.cloudCode,
    detailRetryable: envelope.detail?.retryable,
  };
}

/** The same facts, from the CLI child: its exit code and its one `--json` stderr line. */
async function fromCli(s: Scenario, ...args: string[]) {
  const result = await staple(s, ...args, "--json");
  const lines = result.stderr.trim().split("\n");
  let envelope: { code?: string; retryable?: boolean; detail?: Record<string, unknown> };
  try {
    envelope = JSON.parse(lines[lines.length - 1]!);
  } catch {
    throw new Error(`staple ${args.join(" ")} exited ${result.status} without a JSON envelope:\n${result.stderr}`);
  }
  return {
    exit: result.status,
    code: envelope.code,
    retryable: envelope.retryable,
    cloudCode: envelope.detail?.cloudCode,
    detailRetryable: envelope.detail?.retryable,
  };
}

/** What both surfaces must say for `code`. */
function expected(code: SyncCode) {
  const triple = ERROR_CONTRACT.syncFailure(code);
  return { code: triple.code, retryable: triple.retryable, cloudCode: code, detailRetryable: triple.retryable };
}

function expectedCli(code: SyncCode) {
  return { exit: CLI_EXIT_CODES[code], ...expected(code) };
}

// ---------------------------------------------------------------------------------------

describe("every wire code the Worker can send keeps its identity", () => {
  /**
   * Injected on `GET /devices` exactly as `SyncError.toResponse` builds it: the Worker's
   * status for the code, `{ code, message, retryable }`, and the `retry-after` the Worker's
   * rate limiter attaches. The route is incidental — every response goes through the one
   * `request()` in `client.ts` — and `devices` has no retry loop or recovery of its own to
   * blur what the client made of the answer.
   */
  it.each(SYNC_WIRE_CODES.map((code) => [code]))("%s", async (code) => {
    const s = scenario(`wire${code}`);
    const inject = () => {
      s.server.failNext = {
        route: "GET /v1/repos/:id/devices",
        times: 1,
        status: statusFor(code),
        code,
        ...(code === "rate_limited" ? { headers: { "retry-after": "60" } } : {}),
      };
    };

    inject();
    const error = await refusal(() => fetchDevices(s.home, s.repositoryId));
    expect(inProcess(error)).toEqual(expected(code));
    if (code === "rate_limited") expect(error.detail?.retryAfter).toBe("60");

    inject();
    expect(await fromCli(s, "cloud", "devices")).toEqual(expectedCli(code));
  });

  it("offline: a refused connection is `offline`, retryable, exit 21", async () => {
    const s = scenario("offline", { endpoint: deadEndpoint });
    const error = await refusal(() => fetchDevices(s.home, s.repositoryId));
    expect(inProcess(error)).toEqual(expected("offline"));
    expect(await fromCli(s, "cloud", "devices")).toEqual(expectedCli("offline"));
    // And through the sync engine, which retries it within its bound and then says so.
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("offline"));
  });

  it("without --json, the prose names the true code and the exit code is the same", async () => {
    const s = scenario("prose");
    s.server.failNext = {
      route: "GET /v1/repos/:id/devices",
      times: 1,
      status: 429,
      code: "rate_limited",
      headers: { "retry-after": "60" },
    };
    const result = await staple(s, "cloud", "devices");
    expect(result.status).toBe(CLI_EXIT_CODES.rate_limited);
    expect(result.stderr).toContain("error(rate_limited):");
  });
});

describe("the fake answers in the Worker's exact shape, in the dimension under test", () => {
  /**
   * Every injected failure above is only as good as its resemblance to the service, so the
   * resemblance is asserted rather than assumed: the fake's answer is compared, status,
   * body and `retry-after`, with what `SyncError.toResponse()` from `worker/src/errors.ts`
   * builds for the same code.
   */
  it.each(SYNC_WIRE_CODES.map((code) => [code]))("%s", async (code) => {
    const server = new FakeSyncServer({ repositoryId: "shape" });
    server.enroll(DEVICE, TOKEN);
    const headers = code === "rate_limited" ? { "retry-after": "60" } : undefined;
    server.failNext = {
      route: "GET /v1/repos/:id/devices",
      times: 1,
      status: statusFor(code),
      code,
      ...(headers ? { headers } : {}),
    };
    const fake = await server.fetch(`${endpoint}/v1/repos/shape/devices`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const worker = new SyncError(code, "transient", {}, headers ?? {}).toResponse();
    expect({ status: fake.status, body: await fake.json(), retryAfter: fake.headers.get("retry-after") }).toEqual({
      status: worker.status,
      body: await worker.json(),
      retryAfter: worker.headers.get("retry-after"),
    });
  });

  /**
   * The Worker authenticates the credential before it checks the credential's scope
   * (`worker/src/index.ts`: `authenticate`, then `assertRepoScope`), so a bad credential
   * presented for a repository it does not name is `auth`, not `forbidden`.
   */
  it("checks the credential before its scope, as the service does", async () => {
    const s = scenario("authorder", { token: "a-token-nobody-issued", server: {} });
    current = new FakeSyncServer({ repositoryId: "a-different-repository" });
    expect(inProcess(await refusal(() => fetchDevices(s.home, s.repositoryId)))).toEqual(expected("auth"));
  });
});

describe("a code the client does not know is `unavailable`, never passed through", () => {
  /**
   * The rule every released client follows, and the reason a new wire code is a protocol
   * change rather than a Worker change (`worker/README.md`): an unknown code is treated as
   * transient. `offline` is on that list too when a SERVER sends it, because `offline` is
   * a client-side condition and no response can carry it (`client.ts`).
   */
  it.each([["brand_new_code"], ["offline"]])("a body saying %s", async (sent) => {
    const s = scenario(`unknown${sent}`);
    const inject = () => {
      s.server.failNext = { route: "GET /v1/repos/:id/devices", times: 1, status: 500, code: sent };
    };
    inject();
    const error = await refusal(() => fetchDevices(s.home, s.repositoryId));
    expect(inProcess(error)).toEqual(expected("unavailable"));
    inject();
    expect(await fromCli(s, "cloud", "devices")).toEqual(expectedCli("unavailable"));
  });
});

// ---------------------------------------------------------------------------------------

describe("connect: the enrollment refusal", () => {
  it("a wrong enrollment secret is `forbidden`, exit 12", async () => {
    const s = scenario("connect", { server: { enrollmentSecret: "the-right-secret" } });
    const preview = buildConnectPreview({
      home: s.home,
      repositoryId: s.repositoryId,
      endpoint,
      label: "second machine",
      credential: { forceFile: true },
    });
    const error = await refusal(() =>
      performConnect(preview, { home: s.home, enrollmentSecret: "a-wrong-secret", credential: { forceFile: true } }),
    );
    expect(inProcess(error)).toEqual(expected("forbidden"));
    expect(
      await fromCli(s, "cloud", "connect", "--endpoint", endpoint, "--token", "a-wrong-secret", "--yes", "--credential-file"),
    ).toEqual(expectedCli("forbidden"));
  });
});

describe("sync: the refusals a sync meets in use", () => {
  async function syncOnce(s: Scenario) {
    const opened = openWorkspace(s.dbPath);
    try {
      return await syncRepository(opened.store.db, s.repositoryId, { home: s.home, sleep: async () => undefined });
    } finally {
      opened.store.db.close();
    }
  }

  it("a credential the service does not know is `auth`, exit 11", async () => {
    const s = scenario("auth", { token: "a-token-nobody-issued" });
    expect(inProcess(await refusal(() => syncOnce(s)))).toEqual(expected("auth"));
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("auth"));
  });

  it("a revoked device is `revoked`, exit 13", async () => {
    const s = scenario("revoked");
    s.server.revoke(DEVICE);
    expect(inProcess(await refusal(() => syncOnce(s)))).toEqual(expected("revoked"));
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("revoked"));
  });

  it("the other vocabulary is `conflict`, exit 4, and still reads as the vocabulary refusal", async () => {
    const s = scenario("vocab", {
      server: { vocabulary: "hub" },
      before: (store) => void store.createIssue({ title: "workspace data", assignee: "a" }),
    });
    const error = await refusal(() => syncOnce(s));
    expect(inProcess(error)).toEqual(expected("conflict"));
    expect(isVocabularyRefusal(error)).toBe(true);
    expect(error.message).toContain("holds a hub's workspace registry");
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("conflict"));
  });

  it("a service that no longer speaks this protocol is `protocol_unsupported`, exit 18", async () => {
    const s = scenario("protocol", { server: { protocol: { min: 2, max: 2 } } });
    // Refused by the handshake, before a write: the client's own reading of capabilities.
    const error = await refusal(() => syncOnce(s));
    expect(inProcess(error)).toEqual(expected("protocol_unsupported"));
    expect(error.detail).toMatchObject({ min: 2, max: 2 });
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("protocol_unsupported"));
    // And the service's own 426, on a route with no handshake in front of it.
    expect(inProcess(await refusal(() => fetchDevices(s.home, s.repositoryId)))).toEqual(
      expected("protocol_unsupported"),
    );
  });

  it("an operation stamped with a newer schema is `schema_ahead`, exit 17", async () => {
    const s = scenario("schema");
    await syncOnce(s); // bootstrapped, so the next sync pulls rather than snapshots
    s.server.enroll("device-b", "token-b");
    const pushed = await s.server.fetch(`${endpoint}/v1/repos/${s.repositoryId}/ops`, {
      method: "POST",
      headers: { authorization: "Bearer token-b", "staple-protocol": "1" },
      body: JSON.stringify({
        protocol: 1,
        deviceId: "device-b",
        ops: [
          {
            protocol: 1,
            repoId: s.repositoryId,
            deviceId: "device-b",
            opId: "op-from-the-future",
            entity: "issue",
            entityId: "issue-from-the-future",
            verb: "create",
            baseVersion: null,
            payload: { title: "written by a newer staple" },
            actor: "b",
            clientSeq: 1,
            schema: 999,
            createdAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      }),
    });
    expect(pushed.status).toBe(200);

    const error = await refusal(() => syncOnce(s));
    expect(inProcess(error)).toEqual(expected("schema_ahead"));
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("schema_ahead"));
  });

  it("a cursor the service cannot read is `cursor_invalid`, exit 15", async () => {
    const s = scenario("cursor");
    await syncOnce(s);
    const opened = openWorkspace(s.dbPath);
    opened.store.db.prepare("UPDATE sync_state SET cursor = 'not a cursor' WHERE id = 1").run();
    opened.store.db.close();
    expect(inProcess(await refusal(() => syncOnce(s)))).toEqual(expected("cursor_invalid"));
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("cursor_invalid"));
  });

  it("a row larger than the service takes is `payload_too_large`, exit 16", async () => {
    const s = scenario("payload", {
      before: (store) => void store.createIssue({ title: "huge", description: "x".repeat(600 * 1024) }),
    });
    // Refused by the seed before anything is sent: the service would refuse the batch.
    expect(inProcess(await refusal(() => syncOnce(s)))).toEqual(expected("payload_too_large"));
    expect(await fromCli(s, "cloud", "sync")).toEqual(expectedCli("payload_too_large"));
  });

  it("a batch the service accepted without results is `unavailable`, and retryable", async () => {
    const s = scenario("noresults");
    await syncOnce(s);
    const opened = openWorkspace(s.dbPath);
    try {
      bindJournal(opened.store.db, DEVICE);
      opened.store.createIssue({ title: "queued", assignee: "a" });
      /**
       * A service that acknowledged nothing. A correct one never does — this is the guard
       * against a broken one — so the fake's answer is rewritten here rather than taught
       * to misbehave: everything else about the exchange is the fake's.
       */
      const silent: typeof fetch = async (input, init) => {
        const answer = await s.server.fetch(input as string, init);
        if ((init?.method ?? "GET") !== "POST" || !String(input).endsWith("/ops")) return answer;
        const body = (await answer.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, results: [] }), { status: answer.status });
      };
      const error = await refusal(() =>
        syncRepository(opened.store.db, s.repositoryId, {
          home: s.home,
          sleep: async () => undefined,
          fetchImpl: silent,
        }),
      );
      expect(inProcess(error)).toEqual(expected("unavailable"));
    } finally {
      opened.store.db.close();
    }
  });
});

describe("leases: the race and the refusal", () => {
  it("a lease somebody else holds is `conflict`, exit 4, and not the vocabulary refusal", async () => {
    let issueId = "";
    let ref = "";
    const s = scenario("lease", {
      before: (store) => {
        const issue = store.createIssue({ title: "contested" });
        issueId = issue.id;
        ref = issue.identifier;
      },
    });
    s.server.enroll("device-b", "token-b");
    await acquireRemoteLease(
      parseEndpoint(endpoint),
      { repositoryId: s.repositoryId, token: "token-b", deviceId: "device-b", entityId: issueId, holder: "b" },
      { fetchImpl: s.server.fetch },
    );

    const opened = openWorkspace(s.dbPath);
    let error: StapleError;
    try {
      error = await refusal(() => acquireClaim(opened.store, s.repositoryId, ref, "a", { home: s.home }));
    } finally {
      opened.store.db.close();
    }
    expect(inProcess(error)).toEqual(expected("conflict"));
    expect(isVocabularyRefusal(error)).toBe(false);
    expect(await fromCli(s, "cloud", "lease", "acquire", ref, "--agent", "a")).toEqual(expectedCli("conflict"));
  });

  it("a ttl outside the service's range is `validation`, exit 2", async () => {
    let ref = "";
    const s = scenario("ttl", { before: (store) => void (ref = store.createIssue({ title: "ttl" }).identifier) });
    const opened = openWorkspace(s.dbPath);
    let error: StapleError;
    try {
      error = await refusal(() =>
        acquireClaim(opened.store, s.repositoryId, ref, "a", { home: s.home, ttlSeconds: 7200 }),
      );
    } finally {
      opened.store.db.close();
    }
    expect(inProcess(error)).toEqual(expected("validation"));
    expect(await fromCli(s, "cloud", "lease", "acquire", ref, "--ttl", "2h")).toEqual(expectedCli("validation"));
  });
});

describe("hub registry: the not-provisioned refusal", () => {
  /**
   * The one surface that set an exit code for a sync failure by hand. It printed
   * `error(forbidden)` and exited 4 (`conflict`), while the same refusal under `--json` went
   * through `settle` and exited 2 (`validation`, what `forbidden` used to fold into). One
   * refusal, two exit codes, neither of them its own.
   */
  it("exits 12, `forbidden`, with and without --json", async () => {
    const s = scenario("hubreg");
    const hubId = "3f0c2b1e-9d7a-4c55-8e21-6b4f0a9d1c37";
    expect((await staple(s, "hub", "registry", "identity", hubId, "--yes")).status).toBe(0);
    const args = ["hub", "registry", "connect", "--endpoint", endpoint, "--token", "nope", "--yes", "--credential-file"];

    const prose = await staple(s, ...args);
    expect(prose.status).toBe(CLI_EXIT_CODES.forbidden);
    expect(prose.stderr).toContain("error(forbidden):");
    expect(prose.stderr).toContain("not provisioned");

    expect(await fromCli(s, ...args)).toEqual(expectedCli("forbidden"));
  });
});

describe("no sync failure is built with a code other than its own", () => {
  /**
   * The shape STA-251 removed, found by scanning for it: a StapleError constructed with a
   * store code and the sync code written beside it in `detail`. `cloudError` is the one
   * way to build a sync failure, and it writes `cloudCode` from the code it was given, so
   * a string literal after `cloudCode:` anywhere in the source is that shape coming back.
   */
  it("has no hand-written `cloudCode` literal anywhere in src/", () => {
    const offenders = sourceFiles(join(REPO_ROOT, "src")).filter((file) => /cloudCode:\s*["'`]/.test(readCode(file)));
    expect(offenders).toEqual([]);
  });
});

describe("backups: the consent and the missing backup", () => {
  it("backup consent given here and not on the service is `forbidden`, exit 12", async () => {
    const s = scenario("backupforbidden", { backup: true });
    expect(inProcess(await refusal(() => listBackups(s.home, s.repositoryId)))).toEqual(expected("forbidden"));
    expect(await fromCli(s, "cloud", "backup", "ls")).toEqual(expectedCli("forbidden"));
  });

  it("backup consent never given here is refused before a request, with the same code", async () => {
    const s = scenario("backuplocal", { backup: false });
    expect(inProcess(await refusal(() => listBackups(s.home, s.repositoryId)))).toEqual(expected("forbidden"));
    expect(await fromCli(s, "cloud", "backup", "ls")).toEqual(expectedCli("forbidden"));
    expect(s.server.calls).toEqual([]);
  });

  it("a backup the service does not have is `not_found`, exit 3", async () => {
    const s = scenario("backupmissing", { backup: true });
    s.server.backupEnabled = true;
    expect(inProcess(await refusal(() => deleteBackup(s.home, s.repositoryId, "bk_missing")))).toEqual(
      expected("not_found"),
    );
    expect(await fromCli(s, "cloud", "backup", "rm", "bk_missing", "--yes")).toEqual(expectedCli("not_found"));
  });
});
