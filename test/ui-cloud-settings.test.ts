/**
 * The cloud MUTATION routes — S13 (STA-258), and the property they exist to keep.
 *
 * ## The claim
 *
 * **A client of this server cannot connect to a service without having been
 * handed, in a prior response, the description of what it would be connecting
 * to.**
 *
 * On the command line that is an import graph: `preview.ts` cannot reach
 * `client.ts`, and every function in `connect.ts` takes an already-shown preview
 * as its first argument. A naive `POST /api/cloud/connect { endpoint, token }`
 * would have rebuilt that missing argument on the server out of whatever the
 * request said, ending the property at the last surface — the one a script, a
 * page in another tab, or a UI whose confirm dialog somebody later decided was
 * one click too many, all reach.
 *
 * So it is a two-step exchange, and this file's central test is a NEGATIVE one:
 * the connect route has no endpoint field, and every spelling of "just connect me
 * to this" is refused before a socket is opened.
 *
 * ## The endpoint is a real loopback server
 *
 * `parseEndpoint` waives the HTTPS requirement for loopback, and
 * `test/fixtures/network-spy.ts` classifies `127.0.0.0/8` as not egress — so a
 * fake Worker on 127.0.0.1 lets these tests drive the real client over a real
 * socket AND still assert zero outbound calls where zero is the point. It also
 * records every request it receives, which is how "nothing was sent" is checked
 * as an observation rather than as a belief.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { readConnection } from "../src/core/cloud/connection.js";
import { describeViolations, installNetworkSpy } from "./fixtures/network-spy.js";

const ENROLLMENT = "enrollment-secret";
const MINTED_TOKEN = "stpl_minted_device_token";
const CAPABILITIES = {
  protocol: { min: 1, max: 1 },
  maxBatchSize: 500,
  maxOpBytes: 65_536,
  maxPullLimit: 1000,
  defaultPullLimit: 200,
  maxSnapshotPageSize: 500,
};

let home: string;
let repoDir: string;
let repositoryId: string;
let ui: UiHandle;
let origin: string;
let token: string;

/** The fake Worker: what it was asked, in order. Cleared per test. */
let seen: Array<{ method: string; path: string }> = [];
let service: Server;
let endpoint: string;
/** Devices the fake service reports. Mutated by revoke, like the real one. */
let remoteDevices: Array<{
  deviceId: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  self: boolean;
}> = [];

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

async function serviceHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  seen.push({ method: req.method ?? "", path: url.pathname });
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/v1/capabilities") return send(200, CAPABILITIES);
  if (url.pathname.endsWith("/connect")) {
    // Drain the body so the socket closes cleanly.
    for await (const _ of req) void _;
    return send(200, {
      protocol: 1,
      repositoryId,
      deviceId: "device-from-service",
      epoch: 1,
      token: MINTED_TOKEN,
      capabilities: CAPABILITIES,
    });
  }
  if (url.pathname.endsWith("/devices") && req.method === "GET") {
    return send(200, { devices: remoteDevices });
  }
  if (req.method === "DELETE" && url.pathname.includes("/devices/")) {
    const target = decodeURIComponent(url.pathname.split("/devices/")[1] ?? "");
    for (const device of remoteDevices) {
      if (device.deviceId === target) device.revokedAt = Date.now();
    }
    return send(200, { deviceId: target, revoked: true });
  }
  send(404, { code: "not_found", message: "no such route" });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-cloudset-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "staple-cloudset-repo-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ dir: repoDir, slug: "cloudset" });
  repositoryId = readStoredRepositoryId(ws.store.db)!;
  ws.store.db.close();

  service = createServer((req, res) => void serviceHandler(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  ui = startUiServer({ port: 0, hub: false, db: join(repoDir, ".staple", "staple.db") });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  service?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  remoteDevices = [];
});

/** Preview, then connect. The only way to arrive at a connection through this API. */
async function connectForReal(): Promise<void> {
  const previewed = (await (
    await post("/api/cloud/connect/preview", { endpoint, credentialFile: true })
  ).json()) as {
    consent: { id: string; digest: string };
  };
  const response = await post("/api/cloud/connect", {
    consent: previewed.consent.id,
    digest: previewed.consent.digest,
    token: ENROLLMENT,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function disconnectQuietly(): Promise<void> {
  await post("/api/cloud/disconnect", { confirm: true });
}

// --------------------------------------------------- the property

describe("connect cannot happen without the preview having been returned first", () => {
  beforeEach(async () => {
    await disconnectQuietly();
  });

  /**
   * THE CENTRAL TEST. Every way somebody would naturally try to express "connect
   * me to this endpoint" in one request, refused — and refused BEFORE a socket is
   * opened, which the fake service's empty request log is what proves.
   *
   * If this file ever fails because somebody added an `endpoint` parameter to
   * `/api/cloud/connect` to make a client simpler, that is the review moment, and
   * the thing being given up is the guarantee named at the top of this file.
   */
  it("refuses every one-shot spelling of 'connect to this endpoint', with nothing sent", async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["nothing at all", { token: ENROLLMENT }],
      ["an endpoint, the obvious shape", { endpoint, token: ENROLLMENT }],
      ["an endpoint and a repository id", { endpoint, repositoryId, token: ENROLLMENT }],
      ["a made-up consent id", { consent: "made-up", digest: "whatever", token: ENROLLMENT }],
      ["an endpoint dressed as a consent", { consent: endpoint, digest: endpoint, token: ENROLLMENT }],
    ];

    for (const [name, body] of attempts) {
      const response = await post("/api/cloud/connect", body);
      expect(response.status, `${name} was accepted`).toBeGreaterThanOrEqual(400);
      const envelope = (await response.json()) as { message: string };
      expect(envelope.message, name).toMatch(/consent|preview/i);
    }

    // Nothing reached the service, and nothing was written locally.
    expect(seen).toEqual([]);
    expect(readConnection(home, repositoryId)).toBeNull();
  });

  it("the preview names what a connect would bind, and is the only place an endpoint may be given", async () => {
    const response = await post("/api/cloud/connect/preview", { endpoint, label: "test laptop", credentialFile: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preview: Record<string, unknown> & { endpoint: { origin: string } };
      consent: { id: string; digest: string; expiresAt: string };
    };

    // The three things consent is given TO.
    expect(body.preview.endpoint.origin).toBe(endpoint);
    expect(body.preview.repositoryId).toBe(repositoryId);
    expect(body.preview.label).toBe("test laptop");
    // And the promise the field exists to carry rather than to imply.
    expect(body.preview.autoAfterConnect).toBe(false);

    expect(body.consent.id).toBeTruthy();
    expect(Date.parse(body.consent.expiresAt)).toBeGreaterThan(Date.now());

    // Building a preview does not talk to the endpoint it names. `preview.ts`
    // cannot import `client.ts`; this observes the consequence.
    expect(seen).toEqual([]);
    expect(readConnection(home, repositoryId)).toBeNull();
  });

  it("a consent is single use: the second connect with the same ticket is refused", async () => {
    const previewed = (await (await post("/api/cloud/connect/preview", { endpoint, credentialFile: true })).json()) as {
      consent: { id: string; digest: string };
    };
    const first = await post("/api/cloud/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });
    expect(first.status).toBe(200);

    const second = await post("/api/cloud/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });
    expect(second.status).toBe(404);
    expect(((await second.json()) as { message: string }).message).toMatch(/already used/);
  });

  it("a confirmation that does not match the preview it names is refused before anything is sent", async () => {
    await disconnectQuietly();
    const previewed = (await (await post("/api/cloud/connect/preview", { endpoint, credentialFile: true })).json()) as {
      consent: { id: string };
    };
    seen = [];
    const response = await post("/api/cloud/connect", {
      consent: previewed.consent.id,
      digest: "a".repeat(64),
      token: ENROLLMENT,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(/Nothing was sent/);
    expect(seen).toEqual([]);
  });
});

// --------------------------------------------------- connect, and what it leaves

describe("POST /api/cloud/connect", () => {
  beforeEach(async () => {
    await disconnectQuietly();
  });

  it("connects, and leaves BOTH later consents off", async () => {
    await connectForReal();

    /**
     * *"A successful connection leaves sync manual. Manual is the default and
     * stays the default."* Read off the record on disk, not off the response,
     * because the record is what every later command consults.
     */
    const connection = readConnection(home, repositoryId)!;
    expect(connection.auto).toBe(false);
    expect(connection.backup).toBe(false);
    expect(connection.endpoint).toBe(endpoint);

    const report = (await (await get("/api/cloud/status")).json()) as Record<string, unknown>;
    expect(report.state).toBe("manual");
    expect(report.auto).toBe(false);
    expect(report.backup).toBe(false);
  });

  it("calls capabilities and then connect, in that order, and nothing before consent", async () => {
    await connectForReal();
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/capabilities",
      `POST /v1/repos/${repositoryId}/connect`,
    ]);
  });

  it("never puts a credential on the wire back to the browser", async () => {
    await disconnectQuietly();
    const previewed = (await (await post("/api/cloud/connect/preview", { endpoint, credentialFile: true })).json()) as {
      consent: { id: string; digest: string };
    };
    const text = await (
      await post("/api/cloud/connect", {
        consent: previewed.consent.id,
        digest: previewed.consent.digest,
        token: ENROLLMENT,
      })
    ).text();
    expect(text).not.toContain(MINTED_TOKEN);
    expect(text).not.toContain(ENROLLMENT);
    // The credential really was stored — the response withholding it is not the
    // same thing as it never having existed.
    expect(readFileSync(join(home, "cloud", `${repositoryId}.token`), "utf8")).toContain(MINTED_TOKEN);
  });

  it("refuses without an enrollment credential, and says what one is", async () => {
    await disconnectQuietly();
    const previewed = (await (await post("/api/cloud/connect/preview", { endpoint, credentialFile: true })).json()) as {
      consent: { id: string; digest: string };
    };
    const response = await post("/api/cloud/connect", {
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: "",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(/enrollment credential/i);
  });
});

// --------------------------------------------------- the two later consents

describe("POST /api/cloud/consent — two decisions, never one", () => {
  beforeEach(async () => {
    await disconnectQuietly();
    await connectForReal();
    seen = [];
  });

  it("turns one on at a time, writes it to the staple home, and contacts nobody", async () => {
    const auto = (await (await post("/api/cloud/consent", { auto: true })).json()) as {
      report: { auto: boolean; backup: boolean; mode: string };
    };
    expect(auto.report.auto).toBe(true);
    // The OTHER consent did not move. This is the whole point of two flags.
    expect(auto.report.backup).toBe(false);
    expect(auto.report.mode).toBe("automatic");
    expect(readConnection(home, repositoryId)!.auto).toBe(true);

    const backup = (await (await post("/api/cloud/consent", { backup: true })).json()) as {
      report: { auto: boolean; backup: boolean };
    };
    expect(backup.report.backup).toBe(true);
    expect(backup.report.auto).toBe(true);

    // Changing a consent is a local file write. It says nothing to anybody.
    expect(seen).toEqual([]);
  });

  it("refuses a body that would spend both consents in one press", async () => {
    const response = await post("/api/cloud/consent", { auto: true, backup: true });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/exactly one/);
    expect(readConnection(home, repositoryId)!.auto).toBe(false);
    expect(readConnection(home, repositoryId)!.backup).toBe(false);
  });

  it("refuses a body that names neither", async () => {
    expect((await post("/api/cloud/consent", {})).status).toBe(400);
  });

  it("refuses on an unconnected repository rather than springing a consent into existence", async () => {
    await disconnectQuietly();
    const response = await post("/api/cloud/consent", { auto: true });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toMatch(/not connected/i);
    expect(existsSync(join(home, "cloud", `${repositoryId}.json`))).toBe(false);
  });
});

// --------------------------------------------------- disconnect

describe("POST /api/cloud/disconnect — local, and only local", () => {
  it("removes the credential and the record, preserves the database, and sends nothing", async () => {
    await disconnectQuietly();
    await connectForReal();
    seen = [];

    const body = (await (await post("/api/cloud/disconnect", { confirm: true })).json()) as {
      wasConnected: boolean;
      report: { state: string };
    };
    expect(body.wasConnected).toBe(true);
    expect(body.report.state).toBe("disconnected");

    /**
     * *"Disconnect is local … Remote state is untouched, other devices are
     * unaffected."* Not even a courtesy "please forget me": a person who has
     * decided to stop talking to a service must not need that service's
     * permission to stop.
     */
    expect(seen).toEqual([]);
    expect(existsSync(join(home, "cloud", `${repositoryId}.json`))).toBe(false);
    expect(existsSync(join(home, "cloud", `${repositoryId}.token`))).toBe(false);
    // The workspace is untouched — it still answers, and still has its issues.
    expect((await get("/api/issues")).status).toBe(200);
  });

  it("requires confirmation, and is idempotent once given", async () => {
    expect((await post("/api/cloud/disconnect", {})).status).toBe(400);
    const again = (await (await post("/api/cloud/disconnect", { confirm: true })).json()) as {
      wasConnected: boolean;
    };
    expect(again.wasConnected).toBe(false);
  });
});

// --------------------------------------------------- devices

describe("POST /api/cloud/devices — the one route that leaves the machine", () => {
  beforeEach(async () => {
    await disconnectQuietly();
    await connectForReal();
    seen = [];
    remoteDevices = [
      { deviceId: "device-from-service", label: "this one", createdAt: 1000, lastSeenAt: 2000, revokedAt: null, self: true },
      { deviceId: "other", label: "a second laptop", createdAt: 900, lastSeenAt: 1500, revokedAt: null, self: false },
    ];
  });

  it("asks the service, and only when asked", async () => {
    // Reading status does NOT list devices — that is the invariant a panel
    // breaks by pinging on open.
    await get("/api/cloud/status");
    expect(seen).toEqual([]);

    const body = (await (await post("/api/cloud/devices", {})).json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(2);
    expect(seen).toEqual([{ method: "GET", path: `/v1/repos/${repositoryId}/devices` }]);
  });

  it("revokes one, behind a confirmation, and reports whether it was this machine", async () => {
    expect((await post("/api/cloud/devices/revoke", { deviceId: "other" })).status).toBe(400);
    expect((await post("/api/cloud/devices/revoke", { confirm: true })).status).toBe(400);
    // Neither refusal reached the service.
    expect(seen).toEqual([]);

    const body = (await (await post("/api/cloud/devices/revoke", { deviceId: "other", confirm: true })).json()) as {
      deviceId: string;
      revoked: boolean;
      self: boolean;
    };
    expect(body).toMatchObject({ deviceId: "other", revoked: true, self: false });

    const after = (await (await post("/api/cloud/devices", {})).json()) as {
      devices: Array<{ deviceId: string; revokedAt: number | null }>;
    };
    expect(after.devices.find((d) => d.deviceId === "other")!.revokedAt).not.toBeNull();
  });

  it("revoking THIS device is allowed, reported as self, and does NOT delete the local credential", async () => {
    const body = (await (
      await post("/api/cloud/devices/revoke", { deviceId: "device-from-service", confirm: true })
    ).json()) as { self: boolean };
    /**
     * A stolen laptop is revoked from the laptop you still have. Deleting the
     * local credential here would conflate revoke with disconnect, which the
     * contract insists on keeping apart — and the credential is already useless.
     */
    expect(body.self).toBe(true);
    expect(existsSync(join(home, "cloud", `${repositoryId}.token`))).toBe(true);
  });

  it("refuses on an unconnected repository without opening a socket", async () => {
    await disconnectQuietly();
    seen = [];
    expect((await post("/api/cloud/devices", {})).status).toBe(404);
    expect((await post("/api/cloud/devices/revoke", { deviceId: "other", confirm: true })).status).toBe(404);
    expect(seen).toEqual([]);
  });
});

// --------------------------------------------------- the method and origin gates

/**
 * `GET /api/cloud/workspaces` — the hub-wide list. S16 (STA-275).
 *
 * Acceptance criteria 2 and 3: *"The settings surface lists every workspace with
 * its own connection state"* and *"A newly registered workspace appears without
 * reconnecting"*.
 */
describe("GET /api/cloud/workspaces — every workspace, its own state", () => {
  it("lists the registered workspaces, with the connected one's state on its own row", async () => {
    await connectForReal();
    try {
      const report = (await (await get("/api/cloud/workspaces")).json()) as {
        workspaces: Array<{ slug: string; state: string; endpoint: string | null; auto: boolean }>;
        counts: { total: number; connected: number };
        endpoints: string[];
      };

      const row = report.workspaces.find((entry) => entry.slug === "cloudset")!;
      expect(row.state).toBe("manual");
      expect(row.endpoint).toBe(endpoint);
      expect(row.auto).toBe(false);
      expect(report.counts.connected).toBeGreaterThanOrEqual(1);
      expect(report.endpoints).toContain(endpoint);
    } finally {
      await disconnectQuietly();
    }
  });

  it("reports the workspace as disconnected once it is, on the same route", async () => {
    const report = (await (await get("/api/cloud/workspaces")).json()) as {
      workspaces: Array<{ slug: string; state: string; endpoint: string | null }>;
    };
    const row = report.workspaces.find((entry) => entry.slug === "cloudset")!;
    expect(row.state).toBe("disconnected");
    expect(row.endpoint).toBeNull();
  });

  it("a workspace registered after the page loaded is in the next response", async () => {
    const before = (await (await get("/api/cloud/workspaces")).json()) as {
      workspaces: Array<{ slug: string }>;
    };
    expect(before.workspaces.map((entry) => entry.slug)).not.toContain("latecomer");

    const late = mkdtempSync(join(tmpdir(), "staple-cloudset-late-"));
    try {
      const ws = initWorkspace({ dir: late, slug: "latecomer" });
      ws.store.db.close();

      /**
       * No reconnect, no restart, no cache to invalidate. The route ENUMERATES
       * the hub every time it is called, and there is no stored set of member
       * workspaces that could have gone stale — which is the entire mechanism
       * behind the criterion.
       */
      const after = (await (await get("/api/cloud/workspaces")).json()) as {
        workspaces: Array<{ slug: string; state: string }>;
      };
      const row = after.workspaces.find((entry) => entry.slug === "latecomer")!;
      expect(row.state).toBe("disconnected");
    } finally {
      rmSync(late, { recursive: true, force: true });
    }
  });

  it("does not probe the credential, and says so with null rather than guessing", async () => {
    await connectForReal();
    try {
      const report = (await (await get("/api/cloud/workspaces")).json()) as {
        workspaces: Array<{ slug: string; credentialPresent: boolean | null }>;
      };
      /**
       * `null` means NOT ASKED. Establishing it is a keychain subprocess per
       * workspace and this response is rendered every time the settings dialog
       * opens; a route that probed would spawn N subprocesses to draw a list.
       * `false` would be a lie about a credential nothing looked at.
       */
      const row = report.workspaces.find((entry) => entry.slug === "cloudset")!;
      expect(row.credentialPresent).toBeNull();
    } finally {
      await disconnectQuietly();
    }
  });

  it("makes no request to the service, connected or not", async () => {
    await connectForReal();
    try {
      seen = [];
      await get("/api/cloud/workspaces");
      await get("/api/cloud/workspaces");
      /**
       * The local fake service records every request it receives. Two reads of
       * the list touched it zero times — and there is no `?refresh` on this route
       * that could change that, which is the point: a refresh across a hub is one
       * authenticated round trip PER WORKSPACE, fired by a page load.
       */
      expect(seen).toEqual([]);
    } finally {
      await disconnectQuietly();
    }
  });
});

describe("the gates these routes inherit", () => {
  it("every cloud mutation is POST-only, including the one that merely reads", async () => {
    for (const path of [
      "/api/cloud/connect/preview",
      "/api/cloud/connect",
      "/api/cloud/disconnect",
      "/api/cloud/consent",
      "/api/cloud/devices",
      "/api/cloud/devices/revoke",
    ]) {
      const response = await get(path);
      expect(response.status, `${path} answered a GET`).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    /**
     * `/api/cloud/devices` is in that list although it changes nothing, because
     * it LEAVES THE MACHINE. A GET would be outside the Origin check, and a
     * cross-origin page that could make this server call Cloudflare has made a
     * request the user never authorized, whether or not anything changed.
     */
    expect((await get("/api/cloud/status")).status).toBe(200);
  });

  it("refuses a cross-origin POST to every one of them", async () => {
    for (const path of [
      "/api/cloud/connect/preview",
      "/api/cloud/connect",
      "/api/cloud/disconnect",
      "/api/cloud/consent",
      "/api/cloud/devices",
      "/api/cloud/devices/revoke",
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "x-staple-token": token,
          "content-type": "application/json",
          origin: "http://evil.example",
        },
        body: "{}",
      });
      expect(response.status, `${path} accepted a cross-origin POST`).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it("there is no purge route, and that is deliberate", async () => {
    /**
     * `staple cloud purge` requires the repository id typed back, and STA-256
     * records that the server does not yet validate a confirmation on the wire.
     * A one-click irreversible remote deletion behind a browser session, whose
     * only guard is a dialog the page draws, is not something to add while that
     * is true.
     */
    for (const path of ["/api/cloud/purge", "/api/cloud/repo/purge"]) {
      // A POST to a path that is not in the write list is 405 (the method gate
      // defaults everything unnamed to GET); a GET to a path with no handler is
      // the route-miss 404. Neither is a purge, which is the assertion.
      expect((await post(path, { confirm: true, repositoryId })).status, `${path} accepts a POST`).toBe(405);
      expect((await get(path)).status, `${path} exists`).toBe(404);
    }
    expect(seen).toEqual([]);
  });
});

// --------------------------------------------------- not a workspace setting

describe("connecting writes nothing into the workspace", () => {
  /**
   * The acceptance criterion, checked where it actually matters — not in the
   * browser's imports but in the two stores.
   *
   * The workspace database SYNCHRONIZES. A credential written there would
   * replicate itself to every device; an `auto` flag written there would mean one
   * machine enabling background sync had silently enabled it for everyone, which
   * is exactly the consent this epic promises not to spend on somebody else's
   * behalf. So after a connect and both consents, `/api/settings` — which is the
   * whole of what the workspace knows about settings — must be byte-for-byte the
   * same as it was before.
   */
  it("leaves /api/settings and the settings registry untouched by a connect and two consents", async () => {
    await disconnectQuietly();
    const before = await (await get("/api/settings")).text();

    await connectForReal();
    await post("/api/cloud/consent", { auto: true });
    await post("/api/cloud/consent", { backup: true });

    const after = await (await get("/api/settings")).text();
    expect(after).toBe(before);

    // And nothing cloud-shaped is a registered key, in either scope.
    const envelope = JSON.parse(after) as {
      registry: { categories: Array<{ id: string }>; definitions: Array<{ key: string }> };
      values: Record<string, unknown>;
      unknownKeys: string[];
      global: { values: Record<string, unknown> };
    };
    expect(envelope.registry.categories.map((c) => c.id)).not.toContain("cloud");
    for (const key of [
      ...envelope.registry.definitions.map((d) => d.key),
      ...Object.keys(envelope.values),
      ...Object.keys(envelope.global.values),
      ...envelope.unknownKeys,
    ]) {
      expect(key, `${key} looks like a cloud setting`).not.toMatch(/^cloud[._]|sync[._]auto/);
    }

    // The consents really did change — the assertion above is not passing
    // because nothing happened.
    expect(readConnection(home, repositoryId)).toMatchObject({ auto: true, backup: true });
  });

  it("keeps the credential out of every response the page can read", async () => {
    await disconnectQuietly();
    await connectForReal();
    for (const route of ["/api/settings", "/api/cloud/status", "/api/issues", "/api/bootstrap"]) {
      expect(await (await get(route)).text(), route).not.toContain(MINTED_TOKEN);
    }
  });
});

// --------------------------------------------------- silence, at the routes

describe("the pre-consent half is silent under a spy", () => {
  it("previewing, refusing a connect, changing a consent and disconnecting attempt no egress", async () => {
    await disconnectQuietly();
    await connectForReal();

    const spy = installNetworkSpy();
    try {
      spy.selfCheck();
      await post("/api/cloud/connect/preview", { endpoint, credentialFile: true });
      await post("/api/cloud/connect", { endpoint, token: ENROLLMENT });
      await post("/api/cloud/consent", { auto: true });
      await post("/api/cloud/consent", { auto: false });
      await get("/api/cloud/status");
      await post("/api/cloud/disconnect", { confirm: true });
      /**
       * Loopback is not egress — `network-spy.ts` exempts `127.0.0.0/8` — which
       * is what makes it honest to drive a real server over a real socket here
       * and still assert zero. The fake service is on loopback too, so this
       * assertion would NOT catch a call to it; `seen` is what catches that, and
       * every test above uses it. What this catches is a route resolving a real
       * hostname, which is the failure mode with no other witness.
       */
      expect(spy.violations, describeViolations(spy.violations)).toHaveLength(0);
    } finally {
      spy.restore();
    }
  });
});
