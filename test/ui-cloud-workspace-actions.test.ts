/**
 * THE PER-ROW CLOUD SURFACE — S17 (STA-278), S19 (STA-280), S21 (STA-282).
 *
 * ## The claim, and the reason this file exists at all
 *
 * **An action on one row acts on that row and on no other.**
 *
 * It reads like a truism and it was not true, which is the whole point. Every
 * `/api/cloud/*` mutation resolves its workspace through the server's
 * `handleFor(ws)`. In HUB mode that resolves a slug. In SINGLE-WORKSPACE mode —
 * `staple ui` in a repository, which is how the UI actually runs — `handleFor`
 * ignores its argument entirely and returns the one workspace the server was
 * started on:
 *
 *     let handle = stores.get("__single__");
 *     if (!handle) { … resolveWorkspace({ db: options.db, ws: options.ws }) … }
 *     return handle;
 *
 * So a settings page that had put per-row buttons on the existing routes would
 * have shipped a Disconnect button on `bravo` that disconnected `alpha`,
 * silently, on the ordinary configuration, with a 200 and a cheerful outcome
 * line. That is not a UI bug that testing would have caught by accident: in hub
 * mode, which is what a developer with two workspaces open is likely running, it
 * works perfectly.
 *
 * **Hence this file boots the server in `hub: false` mode, deliberately, and
 * every test here drives a workspace that is NOT the one the server was started
 * on.** If somebody ever "simplifies" these routes onto `handleFor`, the very
 * first test below fails, and it fails with alpha's connection record existing
 * where bravo's should be.
 *
 * ## Two real workspaces, one fake service
 *
 * The workspaces are real: `initWorkspace` writes real databases and registers
 * real hub rows, because the routes address the machine REGISTRY and a stubbed
 * registry would prove nothing about that. The service is a fake on loopback —
 * `parseEndpoint` waives HTTPS for loopback and `network-spy.ts` classifies
 * `127.0.0.0/8` as not egress — so the real client runs over a real socket and
 * the request log is an observation rather than a belief.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { Hub } from "../src/core/hub.js";
import { readConnection } from "../src/core/cloud/connection.js";
import { hubCloudReport } from "../src/core/cloud/hub-surface.js";

const ENROLLMENT = "enrollment-secret";
const CAPABILITIES = {
  protocol: { min: 1, max: 1 },
  maxBatchSize: 500,
  maxOpBytes: 65_536,
  maxPullLimit: 1000,
  defaultPullLimit: 200,
  maxSnapshotPageSize: 500,
};

let home: string;
let scratch: string;
/** The workspace the UI server was started on. Every test acts on another one. */
let alphaDir: string;
let alphaId: string;
let bravoDir: string;
let bravoId: string;
let ui: UiHandle;
let origin: string;
let token: string;
let service: Server;
let endpoint: string;
let seen: Array<{ method: string; path: string }> = [];

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

/**
 * The fake service, which reflects the repository id back out of the URL rather
 * than closing over one.
 *
 * Load-bearing: two workspaces mean two ids, and a service that always answered
 * with `alpha`'s would make the very confusion this file is about invisible —
 * `performConnect` compares the id it asked about with the one it was told, so a
 * hard-coded id would either mask a wrong-workspace connect or fail every
 * correct one.
 */
async function serviceHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  seen.push({ method: req.method ?? "", path: url.pathname });
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (url.pathname === "/v1/capabilities") return send(200, CAPABILITIES);

  const repositoryId = decodeURIComponent(url.pathname.split("/v1/repos/")[1]?.split("/")[0] ?? "");
  if (url.pathname.endsWith("/connect")) {
    for await (const _ of req) void _;
    return send(200, {
      protocol: 1,
      repositoryId,
      deviceId: `device-for-${repositoryId.slice(0, 8)}`,
      epoch: 1,
      token: "stpl_minted_device_token",
      capabilities: CAPABILITIES,
    });
  }
  /**
   * An EMPTY bootstrap. A first sync hydrates before it pulls, so a fake with no
   * snapshot route makes every first sync fail — which is what this file caught
   * the first time it ran, and worth keeping as a comment rather than as a
   * mystery.
   */
  if (url.pathname.endsWith("/snapshot")) {
    return send(200, {
      protocol: 1,
      epoch: 1,
      cutoffSeq: 0,
      tailCursor: "tail-0",
      entities: [],
      nextCursor: null,
      hasMore: false,
    });
  }
  if (url.pathname.endsWith("/ops") && req.method === "GET") {
    return send(200, {
      protocol: 1,
      epoch: 1,
      serverHighWatermark: 0,
      ops: [],
      nextCursor: "tail-0",
      hasMore: false,
    });
  }
  if (url.pathname.endsWith("/ops")) {
    for await (const _ of req) void _;
    return send(200, { protocol: 1, epoch: 1, serverHighWatermark: 0, results: [] });
  }
  send(404, { code: "not_found", message: "no such route" });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-wsact-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-wsact-work-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  alphaDir = join(scratch, "alpha");
  const alpha = initWorkspace({ dir: alphaDir, slug: "alpha" });
  alphaId = readStoredRepositoryId(alpha.store.db)!;
  alpha.store.db.close();

  bravoDir = join(scratch, "bravo");
  const bravo = initWorkspace({ dir: bravoDir, slug: "bravo" });
  bravoId = readStoredRepositoryId(bravo.store.db)!;
  bravo.store.db.close();

  service = createServer((req, res) => void serviceHandler(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  /**
   * `hub: false` — the mode in which `handleFor` ignores a slug. The whole file
   * is about the routes being correct HERE.
   */
  ui = startUiServer({ port: 0, hub: false, db: join(alphaDir, ".staple", "staple.db") });
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

beforeEach(async () => {
  seen = [];
  for (const slug of ["alpha", "bravo"]) {
    await post("/api/cloud/workspace/disconnect", { slug, confirm: true });
  }
});

/** Preview then connect, for one row. The only path to a connection through this API. */
async function connectRow(slug: string): Promise<Response> {
  const previewed = (await (
    await post("/api/cloud/workspace/connect/preview", { slug, endpoint, credentialFile: true })
  ).json()) as { consent: { id: string; digest: string } | null };
  expect(previewed.consent, `no ticket minted for ${slug}`).not.toBeNull();
  return post("/api/cloud/workspace/connect", {
    slug,
    consent: previewed.consent!.id,
    digest: previewed.consent!.digest,
    token: ENROLLMENT,
  });
}

// ------------------------------------------------------------- THE PROPERTY

describe("an action on one row does not act on another", () => {
  /**
   * THE CENTRAL TEST, and the one that would have caught the defect.
   *
   * The server is serving `alpha`. Every request below names `bravo`. If these
   * routes resolved through `handleFor`, `bravo`'s connection record would be
   * absent and `alpha`'s would exist — so the two assertions are not one fact
   * stated twice.
   */
  it("connects the workspace it was told to, not the one the server was started on", async () => {
    const response = await connectRow("bravo");
    expect(response.status, await response.clone().text()).toBe(200);

    const answer = (await response.json()) as {
      outcome: { slug: string; action: string; status: string };
    };
    expect(answer.outcome.slug).toBe("bravo");
    expect(answer.outcome.status).toBe("ok");

    expect(readConnection(home, bravoId)).not.toBeNull();
    expect(readConnection(home, alphaId)).toBeNull();
    // And the service was asked about bravo's repository, by id.
    expect(seen.some((call) => call.path.includes(bravoId))).toBe(true);
    expect(seen.some((call) => call.path.includes(alphaId))).toBe(false);
  });

  it("turns a consent on for one row and leaves the other alone", async () => {
    await connectRow("alpha");
    await connectRow("bravo");

    await post("/api/cloud/workspace/consent", { slug: "bravo", auto: true });

    expect(readConnection(home, bravoId)!.auto).toBe(true);
    expect(readConnection(home, alphaId)!.auto).toBe(false);
  });

  it("disconnects the row it was told to", async () => {
    await connectRow("alpha");
    await connectRow("bravo");

    const answer = (await (
      await post("/api/cloud/workspace/disconnect", { slug: "bravo", confirm: true })
    ).json()) as { outcome: { slug: string; status: string } };

    expect(answer.outcome.slug).toBe("bravo");
    expect(readConnection(home, bravoId)).toBeNull();
    expect(readConnection(home, alphaId)).not.toBeNull();
  });

  it("answers with the outcome carrying the slug the SERVER resolved", async () => {
    /**
     * The evidence, and the reason `slug` is on the outcome at all. The panel
     * keys its outcome map on this value rather than on the one it sent, so a
     * result can never be drawn against a row it is not about — but only if the
     * server really reports the row it acted on.
     */
    await connectRow("bravo");
    const answer = (await (
      await post("/api/cloud/workspace/consent", { slug: "bravo", backup: true })
    ).json()) as { outcome: { slug: string; action: string } };
    expect(answer.outcome.slug).toBe("bravo");
    expect(answer.outcome.action).toBe("backup");
  });
});

// ------------------------------------------------- consent stays structural

describe("the two-step connect survives being made per-row", () => {
  it("has no endpoint field on the connect route", async () => {
    /**
     * The guarantee S13 built, restated for the row. Every spelling of "just
     * connect me to this" is refused, and refused before a socket is opened —
     * the fake service's empty request log is what proves the second half.
     */
    for (const body of [
      { slug: "bravo", endpoint, token: ENROLLMENT },
      { slug: "bravo", endpoint, consent: "made-up", digest: "made-up", token: ENROLLMENT },
      { slug: "bravo", token: ENROLLMENT },
    ]) {
      const response = await post("/api/cloud/workspace/connect", body);
      expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    expect(seen).toEqual([]);
    expect(readConnection(home, bravoId)).toBeNull();
  });

  /**
   * A DELIBERATE BREAK, kept as a test. Mint a ticket by previewing `bravo` and
   * then post it against `alpha`.
   *
   * The digest comparison alone would already refuse this — the rebuild produces
   * a preview carrying alpha's repository id, whose digest differs — but it
   * would refuse with *"this machine's connection state changed while that
   * preview was on screen"*, which is true in a sense and the wrong sentence
   * entirely. So the route checks the ticket's repository against the addressed
   * row by NAME, and the refusal says so. Both facts are asserted: the right
   * words, and nothing sent.
   */
  it("refuses a ticket minted for a different row, by name, with nothing sent", async () => {
    const previewed = (await (
      await post("/api/cloud/workspace/connect/preview", {
        slug: "bravo",
        endpoint,
        credentialFile: true,
      })
    ).json()) as { consent: { id: string; digest: string } };
    seen = [];

    const response = await post("/api/cloud/workspace/connect", {
      slug: "alpha",
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });

    /**
     * 409, not 400: this is a thrown `StapleError("validation")` and this
     * server's catch-all answers `not_found` with 404 and every other staple
     * code with 409. The status is the house convention; the MESSAGE is the
     * thing this test is about.
     */
    expect(response.status).toBe(409);
    const body = (await response.json()) as { message: string; code: string };
    expect(body.code).toBe("validation");
    expect(body.message).toContain("issued for a different workspace");
    expect(body.message).toContain("Nothing was sent");
    expect(seen).toEqual([]);
    expect(readConnection(home, alphaId)).toBeNull();
    expect(readConnection(home, bravoId)).toBeNull();
  });

  it("spends a ticket once, so a second press cannot re-mint a credential", async () => {
    const previewed = (await (
      await post("/api/cloud/workspace/connect/preview", {
        slug: "bravo",
        endpoint,
        credentialFile: true,
      })
    ).json()) as { consent: { id: string; digest: string } };

    const first = await post("/api/cloud/workspace/connect", {
      slug: "bravo",
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });
    expect(first.status).toBe(200);

    const second = await post("/api/cloud/workspace/connect", {
      slug: "bravo",
      consent: previewed.consent.id,
      digest: previewed.consent.digest,
      token: ENROLLMENT,
    });
    expect(second.status).toBe(404);
    expect(((await second.json()) as { message: string }).message).toContain("already used");
  });

  it("previews an already-connected row as a skip, and mints no ticket for it", async () => {
    await connectRow("bravo");
    const answer = (await (
      await post("/api/cloud/workspace/connect/preview", { slug: "bravo", endpoint })
    ).json()) as { action: string; reason: string; preview: unknown; consent: unknown };

    expect(answer.action).toBe("skip");
    expect(answer.reason).toContain("Already connected");
    // A ticket for something that will not happen is a consent with no subject.
    expect(answer.preview).toBeNull();
    expect(answer.consent).toBeNull();
  });
});

// ------------------------------------------------------- addressing refusals

describe("a row is addressed by slug, and an unknown slug is an error", () => {
  it("refuses a request that names no workspace, rather than defaulting to one", async () => {
    /**
     * The single most important refusal on this path. A route that defaulted to
     * "the current workspace" when `slug` was absent would reintroduce the exact
     * defect this file exists for, one careless client call at a time.
     */
    for (const route of [
      "/api/cloud/workspace/consent",
      "/api/cloud/workspace/disconnect",
      "/api/cloud/workspace/sync",
      "/api/hub/unregister",
    ]) {
      const response = await post(route, {});
      expect(response.status, route).toBe(400);
      expect(((await response.json()) as { message: string }).message).toContain(
        "workspace slug is required",
      );
    }
  });

  it("refuses a slug that names nothing", async () => {
    const response = await post("/api/cloud/workspace/sync", { slug: "no-such-workspace" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toContain("no-such-workspace");
  });

  it("accepts POST only, on every one of the six", async () => {
    for (const route of [
      "/api/cloud/workspace/connect/preview",
      "/api/cloud/workspace/connect",
      "/api/cloud/workspace/consent",
      "/api/cloud/workspace/disconnect",
      "/api/cloud/workspace/sync",
      "/api/hub/unregister",
    ]) {
      const response = await get(route);
      expect(response.status, route).toBe(405);
    }
  });
});

// ------------------------------------------------------------------- sync

describe("sync reports a row rather than throwing", () => {
  it("skips a disconnected row instead of failing it", async () => {
    const answer = (await (await post("/api/cloud/workspace/sync", { slug: "bravo" })).json()) as {
      outcome: { slug: string; status: string; detail: string };
    };
    expect(answer.outcome.slug).toBe("bravo");
    expect(answer.outcome.status).toBe("skipped");
    expect(answer.outcome.detail).toContain("Not connected on this machine");
    // Not being connected is the default state of the whole product. It must not
    // arrive as a red error on a page listing seven workspaces.
    expect(seen).toEqual([]);
  });

  it("synchronizes the row it was told to, and answers with its outcome", async () => {
    await connectRow("bravo");
    seen = [];

    const answer = (await (await post("/api/cloud/workspace/sync", { slug: "bravo" })).json()) as {
      outcome: { slug: string; status: string; detail: string };
    };
    expect(answer.outcome.slug).toBe("bravo");
    expect(answer.outcome.status, answer.outcome.detail).toBe("ok");
    expect(seen.some((call) => call.path.includes(bravoId))).toBe(true);
    expect(seen.some((call) => call.path.includes(alphaId))).toBe(false);
  });
});

// --------------------------------------------------------------- removal

describe("a row can be taken off the list without the CLI (S21)", () => {
  /** A registered workspace whose files are gone — the shape of the debris. */
  async function registerAndDelete(slug: string): Promise<string> {
    const dir = join(scratch, slug);
    const ws = initWorkspace({ dir, slug });
    ws.store.db.close();
    rmSync(dir, { recursive: true, force: true });
    return dir;
  }

  it("previews by default and writes nothing", async () => {
    await registerAndDelete("scratch1");
    const before = hubCloudReport(home).workspaces.length;

    const answer = (await (await post("/api/hub/unregister", { slug: "scratch1" })).json()) as {
      preview: { slug: string; available: boolean; connected: boolean; crossLinks: unknown[] };
    };
    expect(answer.preview.slug).toBe("scratch1");
    expect(answer.preview.available).toBe(false);
    expect(answer.preview.connected).toBe(false);
    expect(answer.preview.crossLinks).toEqual([]);
    // Nothing written: the row is still registered.
    expect(hubCloudReport(home).workspaces.length).toBe(before);
  });

  it("removes the row and leaves every file alone", async () => {
    const dir = join(scratch, "scratch2");
    const ws = initWorkspace({ dir, slug: "scratch2" });
    ws.store.db.close();
    const dbPath = join(dir, ".staple", "staple.db");
    expect(existsSync(dbPath)).toBe(true);

    const answer = (await (
      await post("/api/hub/unregister", { slug: "scratch2", confirm: true })
    ).json()) as {
      outcome: { slug: string; action: string; status: string; detail: string };
      report: { workspaces: Array<{ slug: string }> };
    };

    expect(answer.outcome.slug).toBe("scratch2");
    expect(answer.outcome.action).toBe("remove");
    expect(answer.outcome.detail).toContain("this unregisters, it does not delete");
    // The refreshed list comes back in the same response, already without it.
    expect(answer.report.workspaces.map((row) => row.slug)).not.toContain("scratch2");
    // THE PROPERTY. `deleteHubRegistration` has no `fs` to reach this with.
    expect(existsSync(dbPath)).toBe(true);
  });

  /**
   * A DELIBERATE BREAK, kept as a test. Removing a CONNECTED workspace would
   * leave its credential in the staple home with nothing on this machine
   * pointing at it — the registry row is the only pointer. Refused, and the
   * refusal names the remedy the same page offers on the same row.
   */
  it("refuses to remove a workspace that is still connected", async () => {
    await connectRow("bravo");

    const preview = (await (await post("/api/hub/unregister", { slug: "bravo" })).json()) as {
      preview: { connected: boolean };
    };
    expect(preview.preview.connected).toBe(true);

    const response = await post("/api/hub/unregister", { slug: "bravo", confirm: true });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("still connected");
    expect(body.message).toContain("Disconnect it first");
    expect(hubCloudReport(home).workspaces.map((row) => row.slug)).toContain("bravo");

    // And after disconnecting, the same press works.
    await post("/api/cloud/workspace/disconnect", { slug: "bravo", confirm: true });
    const second = await post("/api/hub/unregister", { slug: "bravo", confirm: true });
    expect(second.status).toBe(200);

    // Put it back for the rest of the file: `staple init` in the same directory
    // re-registers, which is exactly the behaviour `hub.ts` documents.
    const restored = initWorkspace({ dir: bravoDir, slug: "bravo" });
    bravoId = readStoredRepositoryId(restored.store.db)!;
    restored.store.db.close();
  });
});

// -------------------------------------------------------------- the list

describe("the list is enumerated on every read", () => {
  it("shows a workspace registered after the server started", async () => {
    /**
     * *"A workspace registered after page load appears on refresh."* There is no
     * cache to invalidate, because there is no stored set of member workspaces —
     * `listHubWorkspaces()` walks the registry on every call. That is the whole
     * mechanism, and this is the check that it is real through the route.
     */
    const before = (await (await get("/api/cloud/workspaces")).json()) as {
      workspaces: Array<{ slug: string }>;
    };
    expect(before.workspaces.map((row) => row.slug)).not.toContain("late");

    const dir = join(scratch, "late");
    const ws = initWorkspace({ dir, slug: "late" });
    ws.store.db.close();

    const after = (await (await get("/api/cloud/workspaces")).json()) as {
      workspaces: Array<{ slug: string; recordsIdentityOnOpen: boolean; actionable: boolean }>;
      counts: { total: number; actionable: number };
    };
    const late = after.workspaces.find((row) => row.slug === "late");
    expect(late).toBeDefined();
    expect(late!.actionable).toBe(true);
    expect(after.counts.actionable).toBeLessThanOrEqual(after.counts.total);

    const hub = Hub.open();
    try {
      hub.unregister("late");
    } finally {
      hub.close();
    }
  });

  it("carries the two fields a control needs, on every row", async () => {
    const answer = (await (await get("/api/cloud/workspaces")).json()) as {
      workspaces: Array<{ slug: string; recordsIdentityOnOpen: boolean; actionable: boolean }>;
      counts: { actionable: number };
    };
    for (const row of answer.workspaces) {
      expect(typeof row.recordsIdentityOnOpen, row.slug).toBe("boolean");
      expect(typeof row.actionable, row.slug).toBe("boolean");
    }
    expect(typeof answer.counts.actionable).toBe("number");
  });

  /**
   * **A STATUS CODE CHANGED ON THIS ROUTE, AND THIS PINS IT.**
   *
   * `/api/cloud/workspace/disconnect` has routed through
   * `performHubDisconnect(home, { workspaces: [workspace] })` since it shipped.
   * On master an unparseable connection record threw out of the fan-out and out
   * of the route: HTTP 400 with the parse message.
   *
   * S18 gave `performHubDisconnect` the per-row `try`/`catch` its two siblings
   * already had — necessary, because without it one corrupt file aborted a
   * hub-wide run after deleting other credentials and reported none of them. The
   * per-row route inherits that: the same request now answers **200 with
   * `outcome.status: "failed"`**.
   *
   * That is the better answer — `HubWorkspaceOutcome.status` already carried
   * `"failed"`, the panel already renders "Did not work: " for it, and a 400
   * told a caller the REQUEST was malformed when the request was fine and a file
   * on disk was not. But it is a behaviour change on a shipped route, and
   * nothing tested it: every corrupt-record case drove the hub-wide fan-out. If
   * somebody later "simplifies" the catch away, the hub-wide tests fail loudly
   * and this one fails for the single-row case they would not have thought about.
   */
  it("answers 200 with a failed row when a connection record will not parse", async () => {
    await connectRow("bravo");
    const record = join(home, "cloud", `${bravoId}.json`);
    writeFileSync(record, "{ this is not json", { mode: 0o600 });

    try {
      const response = await post("/api/cloud/workspace/disconnect", {
        slug: "bravo",
        confirm: true,
      });
      expect(response.status, await response.clone().text()).toBe(200);

      const answer = (await response.json()) as {
        outcome: { slug: string; action: string; status: string; detail: string };
      };
      expect(answer.outcome.slug).toBe("bravo");
      expect(answer.outcome.action).toBe("disconnect");
      // NOT "skipped": reporting "nothing needed doing" about a credential still
      // sitting on disk is the one wrong answer available here.
      expect(answer.outcome.status).toBe("failed");
      // The row names the file, because deleting it by hand is the remedy.
      expect(answer.outcome.detail).toContain(record);
      // And it says the credential's fate could not be established rather than
      // asserting it survived.
      expect(answer.outcome.detail).toContain("could not be established");
    } finally {
      rmSync(record, { force: true });
      rmSync(join(home, "cloud", `${bravoId}.token`), { force: true });
    }
  });
});
