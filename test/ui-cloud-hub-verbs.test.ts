/**
 * THE HUB-WIDE VERBS — S18 (STA-279), the last acceptance criterion:
 * *"Hub-wide connect, sync and disconnect are performed from there"*.
 *
 * ## The claim
 *
 * **A hub-wide verb acts on the whole machine registry, and on every row in it —
 * not on the one workspace the server happens to have been started on.**
 *
 * That is the same claim `test/ui-cloud-workspace-actions.test.ts` makes for the
 * per-row routes, inverted, and it has the same trap underneath it. Every
 * `/api/cloud/*` mutation resolves its workspace through the server's
 * `handleFor(ws)`. In HUB mode that resolves a slug. In SINGLE-WORKSPACE mode —
 * `staple ui` in a repository, which is how the UI actually runs — `handleFor`
 * ignores its argument entirely and returns the one workspace the server was
 * started on.
 *
 * So a hub-wide button built on `handleFor` would connect ONE workspace, report a
 * cheerful outcome, and leave the other three untouched — on the ordinary
 * configuration, with a 200. **Hence this file boots the server in `hub: false`
 * mode against `alpha` and asserts that every hub-wide verb reaches `bravo`,
 * `charlie` and `delta` too.** Every assertion below is on an OBSERVABLE EFFECT —
 * a connection record on disk, a request in the fake service's log, a credential
 * gone — and never on the shape of the response alone. Four green suites in this
 * epic proved nothing because the thing under test never actually ran; a hub-wide
 * route that answered `{ workspaces: [] }` with a 200 would pass any assertion
 * written against its envelope.
 *
 * ## The fan-out is the existing core function with its argument omitted
 *
 * `buildHubConnectPreview`, `syncAllWorkspaces` and `performHubDisconnect` each
 * take `workspaces?: readonly HubWorkspace[]`. The per-row routes pass a
 * single-element array; these routes pass nothing, so the enumeration is the
 * whole registry. Nothing new decides what "skippable" means — which is why the
 * skip sentences asserted below are `describeSkip`'s own words and not this
 * server's.
 *
 * ## Four workspaces, on purpose
 *
 *  - `alpha`   — the one the UI server was started on. Must not be privileged.
 *  - `bravo`   — an ordinary second workspace.
 *  - `charlie` — an ordinary third, so "acted on more than one" is not
 *                indistinguishable from "acted on a pair".
 *  - `delta`   — CONNECTED and then its database deleted, so `available` is
 *                false. Connect and sync must skip it; **disconnect must not**,
 *                because the credential lives in the staple home and refusing
 *                would leave a live secret behind for exactly the workspace
 *                somebody is most likely to be disconnecting.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId } from "../src/core/repo-identity.js";
import { Hub } from "../src/core/hub.js";
import { readConnection } from "../src/core/cloud/connection.js";
import { hubCloudReport, type HubCloudReport } from "../src/core/cloud/hub-surface.js";

/**
 * The BROWSER's own copy of "which rows would a hub-wide verb visit", loaded so
 * that it can be compared against what the server actually does.
 *
 * **Loaded through a variable, deliberately**, which is the pattern
 * `test/settings-verification.test.ts` established for exactly this: a static
 * import would pull `src/ui/app` into the NODE tsc program, where the browser's
 * `@/…` path alias does not exist and every file under it fails to resolve. A
 * dynamic import behind a non-literal specifier is invisible to that program and
 * resolves fine at runtime, where vitest supplies the alias.
 *
 * The functions are typed structurally here rather than imported as types, for
 * the same reason. That is a real cost — this side would not notice a renamed
 * field — and it is bounded by the fact that the module's own suite
 * (`cloud-section.test.tsx`) type-checks it properly against the mirrored report.
 */
const CLOUD_SETTINGS_MODULE = "../src/ui/app/src/settings/cloud-settings.js";
interface HubWideView {
  hubWideTargets: (
    report: HubCloudReport,
    action: "connect" | "sync" | "disconnect",
  ) => Array<{ slug: string }>;
  hubWideControls: (report: HubCloudReport) => Array<{
    action: string;
    count: number;
    label: string;
    disabledReason: string | null;
  }>;
}
let view: HubWideView;
/** The page's target list for one verb, as slugs, sorted. */
function pageTargets(report: HubCloudReport, action: "connect" | "sync" | "disconnect"): string[] {
  return view
    .hubWideTargets(report, action)
    .map((row) => row.slug)
    .sort();
}

const ENROLLMENT = "enrollment-secret";
const CAPABILITIES = {
  protocol: { min: 1, max: 1 },
  maxBatchSize: 500,
  maxOpBytes: 65_536,
  maxPullLimit: 1000,
  defaultPullLimit: 200,
  maxSnapshotPageSize: 500,
};

/** Every workspace this file registers, and the id each one recorded. */
const IDS = new Map<string, string>();
const DIRS = new Map<string, string>();

let home: string;
let scratch: string;
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

/** The same reflecting fake `ui-cloud-workspace-actions.test.ts` uses, and for the same reason. */
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

function makeWorkspace(slug: string): void {
  const dir = join(scratch, slug);
  const opened = initWorkspace({ dir, slug });
  IDS.set(slug, readStoredRepositoryId(opened.store.db)!);
  DIRS.set(slug, dir);
  opened.store.db.close();
}

function idOf(slug: string): string {
  const id = IDS.get(slug);
  if (id === undefined) throw new Error(`no id recorded for ${slug}`);
  return id;
}

beforeAll(async () => {
  view = (await import(CLOUD_SETTINGS_MODULE)) as unknown as HubWideView;
  home = mkdtempSync(join(tmpdir(), "staple-hubverbs-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-hubverbs-work-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  for (const slug of ["alpha", "bravo", "charlie", "delta"]) makeWorkspace(slug);

  service = createServer((req, res) => void serviceHandler(req, res));
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  endpoint = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  /**
   * `hub: false` — the mode in which `handleFor` ignores a slug and answers with
   * `alpha` whatever it is asked. The whole file is about the hub-wide routes
   * being correct HERE.
   */
  ui = startUiServer({ port: 0, hub: false, db: join(DIRS.get("alpha")!, ".staple", "staple.db") });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  /**
   * `delta` is connected FIRST and then has its database removed, in that order,
   * because a connect needs the manifest and the manifest sits beside the
   * database. Deleting only the `.db` file leaves `repository.json` readable, so
   * the row reports a real `repositoryId` with `available: false` — which is the
   * unmounted-volume shape, and the one where connect, sync and disconnect are
   * required to disagree with each other.
   */
  await connectRow("delta");
  unlinkSync(join(DIRS.get("delta")!, ".staple", "staple.db"));
}, 120_000);

afterAll(() => {
  ui?.close();
  service?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

/** Connect one row through the per-row two-step. The only path to a connection through this API. */
async function connectRow(slug: string): Promise<void> {
  const previewed = (await (
    await post("/api/cloud/workspace/connect/preview", { slug, endpoint, credentialFile: true })
  ).json()) as { consent: { id: string; digest: string } | null; reason?: string };
  expect(previewed.consent, `no ticket minted for ${slug}: ${previewed.reason}`).not.toBeNull();
  const response = await post("/api/cloud/workspace/connect", {
    slug,
    consent: previewed.consent!.id,
    digest: previewed.consent!.digest,
    token: ENROLLMENT,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

interface HubPreviewBody {
  preview: {
    endpoint: string;
    entries: Array<{ slug: string; action: string; reason: string; preview: unknown }>;
    willConnect: number;
    willSkip: number;
    autoAfterConnect: false;
  };
  consents: Array<{ slug: string; consent: { id: string; digest: string } }>;
  message?: string;
}

/** Preview the hub-wide connect and hand back every ticket it issued. */
async function previewHub(
  overrides: Record<string, unknown> = {},
): Promise<HubPreviewBody & { status: number }> {
  const response = await post("/api/hub/connect/preview", {
    endpoint,
    credentialFile: true,
    ...overrides,
  });
  const payload = (await response.json()) as HubPreviewBody;
  return { status: response.status, ...payload };
}

interface FanOut {
  action: string;
  at: string;
  ok: number;
  skipped: number;
  failed: number;
  workspaces: Array<{ slug: string; action: string; status: string; detail: string; at: string }>;
}

/** Preview then confirm. The only path to a hub-wide connection through this API. */
async function connectHub(
  extra: Record<string, unknown> = {},
): Promise<{ status: number; fanOut?: FanOut; report?: unknown; message?: string }> {
  const previewed = await previewHub();
  expect(previewed.status, JSON.stringify(previewed)).toBe(200);
  const response = await post("/api/hub/connect", {
    consents: previewed.consents.map((issued) => ({
      slug: issued.slug,
      consent: issued.consent.id,
      digest: issued.consent.digest,
    })),
    token: ENROLLMENT,
    ...extra,
  });
  const payload = (await response.json()) as {
    fanOut?: FanOut;
    report?: unknown;
    message?: string;
  };
  return { status: response.status, ...payload };
}

/** Disconnect everything, so each case starts from a state it chose. */
async function disconnectEverything(): Promise<void> {
  for (const slug of IDS.keys()) {
    await post("/api/cloud/workspace/disconnect", { slug, confirm: true });
  }
}

beforeEach(async () => {
  await disconnectEverything();
  seen = [];
});

// ------------------------------------------------------------- THE PROPERTY

describe("a hub-wide verb acts on the whole registry, not on the server's own workspace", () => {
  /**
   * THE CENTRAL TEST, and the one that fails if a hub-wide route is ever built on
   * `handleFor`.
   *
   * The server is serving `alpha`. `handleFor` would resolve every request to
   * `alpha` and nothing else, so the assertion is not "alpha connected" — it is
   * that BRAVO and CHARLIE connected too, that the service was asked about each
   * of their ids by name, and that the fan-out reported a row per workspace. A
   * `handleFor` implementation produces one connection, one request and one row.
   */
  it("connects every registered workspace, including the three the server was not started on", async () => {
    const answer = await connectHub();
    expect(answer.status, JSON.stringify(answer)).toBe(200);

    // The effect on disk, which is the part `handleFor` cannot fake.
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(readConnection(home, idOf(slug)), `${slug} was not connected`).not.toBeNull();
    }
    // And the service was asked about each id, by name. Three distinct connects.
    const connects = seen.filter((call) => call.path.endsWith("/connect"));
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(
        connects.some((call) => call.path.includes(idOf(slug))),
        `no connect request named ${slug}`,
      ).toBe(true);
    }
    expect(connects).toHaveLength(3);

    // One row per REGISTERED workspace, not one row per success.
    expect(answer.fanOut!.workspaces.map((row) => row.slug).sort()).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(answer.fanOut!.ok).toBe(3);
  });

  it("syncs every connected workspace, and one row is not enough", async () => {
    await connectRow("alpha");
    await connectRow("bravo");
    await connectRow("charlie");
    seen = [];

    const response = await post("/api/hub/sync", {});
    expect(response.status, await response.clone().text()).toBe(200);
    const answer = (await response.json()) as { fanOut: FanOut };

    const synced = answer.fanOut.workspaces.filter((row) => row.status === "ok");
    expect(synced.map((row) => row.slug).sort()).toEqual(["alpha", "bravo", "charlie"]);
    expect(answer.fanOut.ok).toBe(3);

    // EGRESSES, and to each repository separately. A `handleFor` implementation
    // would have talked about alpha three times or once.
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(
        seen.some((call) => call.path.includes(idOf(slug))),
        `sync never mentioned ${slug}`,
      ).toBe(true);
    }
  });

  it("disconnects every connected workspace, and removes every credential", async () => {
    await connectRow("alpha");
    await connectRow("bravo");
    await connectRow("charlie");
    seen = [];

    const response = await post("/api/hub/disconnect", { confirm: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const answer = (await response.json()) as { fanOut: FanOut };

    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(readConnection(home, idOf(slug)), `${slug} is still connected`).toBeNull();
    }
    expect(answer.fanOut.ok).toBe(3);
    // Local, and only local: not even a courtesy "please forget me".
    expect(seen).toEqual([]);
  });

  /**
   * The registry, not the store cache. Asserted at the source as well as by
   * effect, because the effect assertions above would also pass on a route that
   * looped over `handleFor(slug)` in hub mode — and this suite runs in
   * single-workspace mode precisely so that they would not. This is the belt for
   * that brace: the handlers must not name `handleFor` at all.
   */
  it("addresses the registry, and no hub-wide handler reaches handleFor", () => {
    const source = readFileSync(
      new URL("../src/ui/server.ts", import.meta.url).pathname,
      "utf8",
    );
    for (const route of [
      "/api/hub/connect/preview",
      "/api/hub/connect",
      "/api/hub/sync",
      "/api/hub/disconnect",
    ]) {
      const start = source.indexOf(`url.pathname === "${route}"`);
      expect(start, `${route} has no handler`).toBeGreaterThan(0);
      /**
       * The handler body, taken as the text up to the next route test. Crude, and
       * good enough for the one thing it must catch: `handleFor` appearing inside
       * a hub-wide handler is the defect, and it is a nine-character string.
       */
      const rest = source.slice(start + route.length);
      const end = rest.indexOf("url.pathname === ");
      const body = end === -1 ? rest : rest.slice(0, end);
      expect(body, `${route} resolves through handleFor`).not.toContain("handleFor");
      expect(body, `${route} reaches the store cache`).not.toContain("stores.get");
    }
  });
});

// ------------------------------------------- the page's counts and the server's refusals

/**
 * **THE ONE DUPLICATED RULE IN THIS FEATURE, PINNED.**
 *
 * `src/ui/server.ts` decides which rows a hub-wide sync or disconnect would visit,
 * and `src/ui/app/src/settings/cloud-settings.ts` decides the same thing again for
 * the button LABEL. It is stated twice because the browser cannot import
 * `src/core` — the whole reason `test/contract-ui-types.test.ts` exists — and the
 * duplication is bounded on purpose: the page's copy decides a number on a button,
 * the server's copy decides a refusal, so a divergence can only ever produce a
 * wrong label followed by an honest refusal, never a wrong action.
 *
 * "Only a wrong label" is still wrong, though, and a wrong label on a button whose
 * job is to state its own blast radius is exactly the failure this feature was
 * refused on. So the two are asserted to agree, against a REAL registry and real
 * connection records rather than against a fixture — which is the half
 * `cloud-section.test.tsx` cannot do, because it has no workspaces.
 */
describe("the page's counts and the server's behaviour are the same rule", () => {
  it("agrees on which rows a hub-wide sync and disconnect would visit", async () => {
    await connectRow("alpha");
    await connectRow("charlie");

    const report = hubCloudReport(home);
    // `delta` is registered, unavailable, and NOT connected in this case: it is in
    // neither set. `bravo` is available and not connected: sync's set excludes it.
    expect(pageTargets(report, "sync")).toEqual([
      "alpha",
      "charlie",
    ]);
    expect(pageTargets(report, "disconnect")).toEqual([
      "alpha",
      "charlie",
    ]);
    expect(pageTargets(report, "connect")).toEqual(["bravo"]);

    // And the server acts on exactly those. The rows with `status: "ok"` after a
    // real fan-out are the page's own target list, which is the agreement.
    const synced = (await (await post("/api/hub/sync", {})).json()) as { fanOut: FanOut };
    expect(
      synced.fanOut.workspaces
        .filter((row) => row.status === "ok")
        .map((row) => row.slug)
        .sort(),
    ).toEqual(pageTargets(report, "sync"));

    const off = (await (
      await post("/api/hub/disconnect", { confirm: true })
    ).json()) as { fanOut: FanOut };
    expect(
      off.fanOut.workspaces
        .filter((row) => row.status === "ok")
        .map((row) => row.slug)
        .sort(),
    ).toEqual(pageTargets(report, "disconnect"));
  });

  it("agrees on which rows a hub-wide connect would visit", async () => {
    const report = hubCloudReport(home);
    const previewed = await previewHub();
    expect(previewed.status).toBe(200);

    // The page's count, and the enumeration the server actually issued tickets
    // for. `delta` is unavailable and so appears in neither.
    expect(previewed.consents.map((issued) => issued.slug).sort()).toEqual(
      pageTargets(report, "connect"),
    );
    expect(previewed.preview.willConnect).toBe(pageTargets(report, "connect").length);

    // And the label the page would draw says that number, rather than "all".
    const control = view.hubWideControls(report).find((candidate) => candidate.action === "connect")!;
    expect(control.count).toBe(previewed.preview.willConnect);
    expect(control.label).toBe(`Connect ${previewed.preview.willConnect} workspaces`);
  });

  it("agrees that an empty set is a refusal on both sides", async () => {
    // Nothing is connected (beforeEach), so the page disables sync and disconnect
    // with a reason, and the server refuses them with one.
    const report = hubCloudReport(home);
    const controls = view.hubWideControls(report);
    for (const action of ["sync", "disconnect"] as const) {
      const control = controls.find((candidate) => candidate.action === action)!;
      expect(control.count, `the page thinks ${action} has work to do`).toBe(0);
      expect(control.disabledReason, `the page offers ${action} with no reason`).not.toBeNull();
    }
    expect((await post("/api/hub/sync", {})).status).toBe(409);
    expect((await post("/api/hub/disconnect", { confirm: true })).status).toBe(409);
  });
});

// ------------------------------------------------- the three verbs disagree, correctly

describe("the three verbs disagree about an unavailable workspace, on purpose", () => {
  it("connect skips a workspace whose disk is gone, in describeSkip's own words", async () => {
    const previewed = await previewHub();
    const delta = previewed.preview.entries.find((entry) => entry.slug === "delta")!;
    expect(delta.action).toBe("skip");
    expect(delta.preview).toBeNull();
    expect(delta.reason).toContain("not on this machine right now");
    // No ticket for a row nothing will happen to.
    expect(previewed.consents.some((issued) => issued.slug === "delta")).toBe(false);
  });

  it("sync skips it too, and says so as a row rather than as an error", async () => {
    await connectRow("alpha");
    // `delta` was connected in beforeAll and disconnected by beforeEach, so
    // reconnect it the only way an unavailable row can be: it cannot. Assert the
    // skip against the row that IS registered and unavailable.
    const answer = (await (await post("/api/hub/sync", {})).json()) as { fanOut: FanOut };
    const delta = answer.fanOut.workspaces.find((row) => row.slug === "delta")!;
    expect(delta.status).toBe("skipped");
    expect(answer.fanOut.failed).toBe(0);
  });

  /**
   * THE ASYMMETRY, and the reason `performHubDisconnect` is deliberately not
   * gated on `available` — restated here at the route.
   *
   * `delta` is connected and its database is gone. Its credential is in the
   * staple home, on THIS machine, and removing it is the whole point. Refusing
   * would leave a live secret behind for exactly the workspace somebody is most
   * likely to be disconnecting.
   */
  it("disconnect does NOT skip it: an unmounted volume is the reason to disconnect, not a bar", async () => {
    /**
     * Forge the connection record rather than connecting, because connecting
     * needs the database this case has deliberately removed. `readConnection`
     * reads the staple home, which is where the whole argument lives.
     */
    await connectRow("alpha");
    const deltaId = idOf("delta");
    const alphaRecord = readConnection(home, idOf("alpha"))!;
    writeFileSync(
      join(home, "cloud", `${deltaId}.json`),
      JSON.stringify({ ...alphaRecord, repositoryId: deltaId }),
      { mode: 0o600 },
    );
    writeFileSync(join(home, "cloud", `${deltaId}.token`), "stpl_fake\n", { mode: 0o600 });
    expect(readConnection(home, deltaId)).not.toBeNull();

    const answer = (await (
      await post("/api/hub/disconnect", { confirm: true })
    ).json()) as { fanOut: FanOut };

    const delta = answer.fanOut.workspaces.find((row) => row.slug === "delta")!;
    expect(delta.status, delta.detail).toBe("ok");
    expect(readConnection(home, deltaId)).toBeNull();
    expect(existsSync(join(home, "cloud", `${deltaId}.token`))).toBe(false);
  });
});

// --------------------------------------------- consent stays structural, across N rows

describe("the two-step connect survives being made hub-wide", () => {
  it("has no endpoint field, and no repositoryId field, on the connect route", async () => {
    /**
     * The guarantee S13 built, restated for the fan-out. Every one-shot spelling
     * of "just connect all of them to this" is refused, and refused before a
     * socket is opened — the fake service's empty log is what proves the second
     * half.
     */
    for (const body of [
      { endpoint, token: ENROLLMENT },
      { endpoint, repositoryId: idOf("bravo"), token: ENROLLMENT },
      { token: ENROLLMENT },
      { consents: [], token: ENROLLMENT },
      { consents: [{ slug: "bravo", consent: "made-up", digest: "made-up" }], token: ENROLLMENT },
    ]) {
      const response = await post("/api/hub/connect", body);
      expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    expect(seen).toEqual([]);
    for (const slug of IDS.keys()) expect(readConnection(home, idOf(slug))).toBeNull();
  });

  it("ignores an endpoint in the confirm body: the service is the one the preview named", async () => {
    /**
     * Not merely "an endpoint is not required" — an endpoint offered here must
     * have no effect whatever. The tickets name the loopback fake; the body names
     * a host that does not exist. If the field were read, this would attempt a
     * lookup of `hub-wide.invalid` and connect nothing.
     */
    const answer = await connectHub({ endpoint: "https://hub-wide.invalid" });
    expect(answer.status, JSON.stringify(answer)).toBe(200);
    expect(readConnection(home, idOf("bravo"))!.endpoint).toBe(endpoint);
    expect(seen.every((call) => call.path.startsWith("/v1/"))).toBe(true);
  });

  it("refuses a ticket issued for a different workspace, by name", async () => {
    const previewed = await previewHub();
    const bravo = previewed.consents.find((issued) => issued.slug === "bravo")!;
    seen = [];

    const response = await post("/api/hub/connect", {
      consents: [{ slug: "charlie", consent: bravo.consent.id, digest: bravo.consent.digest }],
      token: ENROLLMENT,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const refusal = (await response.json()) as { message: string };
    expect(refusal.message).toContain("charlie");
    expect(refusal.message).toContain("different workspace");
    expect(seen).toEqual([]);
    expect(readConnection(home, idOf("charlie"))).toBeNull();
  });

  it("is single use: the same tickets cannot be redeemed twice", async () => {
    const previewed = await previewHub();
    const body = {
      consents: previewed.consents.map((issued) => ({
        slug: issued.slug,
        consent: issued.consent.id,
        digest: issued.consent.digest,
      })),
      token: ENROLLMENT,
    };
    expect((await post("/api/hub/connect", body)).status).toBe(200);
    const second = await post("/api/hub/connect", body);
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  /**
   * **THE CONSENT IS OVER THE ENUMERATION**, which is the whole answer to the
   * recorded objection that a fan-out "spends one enrollment secret against N
   * services".
   *
   * Between the preview and the confirm, `bravo` is connected out of band. The
   * enumeration the human agreed to no longer describes what would happen — the
   * fan-out would now act on three rows where the screen showed four — so the
   * confirm is REFUSED rather than partially performed. Nothing is connected,
   * and the secret is not spent.
   */
  it("refuses when a workspace was connected between the preview and the confirm", async () => {
    const previewed = await previewHub();
    await connectRow("bravo");
    seen = [];

    const response = await post("/api/hub/connect", {
      consents: previewed.consents.map((issued) => ({
        slug: issued.slug,
        consent: issued.consent.id,
        digest: issued.consent.digest,
      })),
      token: ENROLLMENT,
    });
    expect(response.status, await response.clone().text()).toBe(409);
    const refusal = (await response.json()) as { message: string };
    expect(refusal.message).toContain("bravo");
    expect(seen).toEqual([]);
    expect(readConnection(home, idOf("alpha"))).toBeNull();
    expect(readConnection(home, idOf("charlie"))).toBeNull();
  });

  /**
   * The other direction: a workspace REGISTERED after the preview was shown is
   * not covered by it. Consent to "these three" is not consent to a fourth, and
   * a fan-out that silently included it would be connecting a repository nobody
   * had been shown.
   */
  it("refuses when a workspace was registered between the preview and the confirm", async () => {
    const previewed = await previewHub();
    makeWorkspace("echo");
    try {
      const response = await post("/api/hub/connect", {
        consents: previewed.consents.map((issued) => ({
          slug: issued.slug,
          consent: issued.consent.id,
          digest: issued.consent.digest,
        })),
        token: ENROLLMENT,
      });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(((await response.json()) as { message: string }).message).toContain("echo");
      expect(readConnection(home, idOf("echo"))).toBeNull();
    } finally {
      const hub = Hub.open();
      try {
        hub.unregister("echo", { withLinks: true });
      } finally {
        hub.close();
      }
      IDS.delete("echo");
      DIRS.delete("echo");
    }
  });

  /**
   * **THE `vanished` BRANCH**, which nothing reached until this test.
   *
   * The connected-race case above passes on `redeem`'s digest refusal, which
   * fires *before* the enumeration comparison — so it would still pass with the
   * comparison deleted, and only `appeared` was genuinely exercised. This is the
   * other half, and it is reachable for a specific reason: **availability is not
   * in the digest.** A workspace whose volume unmounts between the preview and
   * the confirm rebuilds to a byte-identical `ConnectPreview`, sails through
   * `redeem`, and is caught only by the set comparison — where it is actionable
   * no longer.
   *
   * The remedy in the message is "look again", not "we skipped it": consent to
   * connect four is not consent to connect three.
   */
  it("refuses when a consented workspace stopped being connectable", async () => {
    const previewed = await previewHub();
    expect(previewed.consents.map((issued) => issued.slug)).toContain("bravo");

    // The volume goes. `available` is `existsSync(path)` and nothing more, so
    // removing the database file is the whole of an unmounted disk.
    const bravoDb = join(DIRS.get("bravo")!, ".staple", "staple.db");
    const saved = readFileSync(bravoDb);
    unlinkSync(bravoDb);
    seen = [];

    try {
      const response = await post("/api/hub/connect", {
        consents: previewed.consents.map((issued) => ({
          slug: issued.slug,
          consent: issued.consent.id,
          digest: issued.consent.digest,
        })),
        token: ENROLLMENT,
      });
      expect(response.status, await response.clone().text()).toBe(409);
      const refusal = (await response.json()) as { message: string };
      expect(refusal.message).toContain("No longer connectable");
      expect(refusal.message).toContain("bravo");

      // Nothing was sent, and nothing was connected — not even the rows that
      // were still perfectly actionable. The gesture is one decision.
      expect(seen).toEqual([]);
      expect(readConnection(home, idOf("alpha"))).toBeNull();
      expect(readConnection(home, idOf("charlie"))).toBeNull();
    } finally {
      writeFileSync(bravoDb, saved);
    }
  });

  it("refuses a blank enrollment secret BEFORE it spends the tickets", async () => {
    /**
     * `performHubConnect` validates the secret itself, but it does so after the
     * tickets have been redeemed — and a fan-out burning N consents over an empty
     * password field is a worse failure than one burning a single consent. So the
     * route checks first, and the evidence is that the SAME tickets still work
     * afterwards.
     */
    const previewed = await previewHub();
    const consents = previewed.consents.map((issued) => ({
      slug: issued.slug,
      consent: issued.consent.id,
      digest: issued.consent.digest,
    }));

    const refused = await post("/api/hub/connect", { consents, token: "   " });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain("enrollment");
    expect(seen).toEqual([]);

    expect((await post("/api/hub/connect", { consents, token: ENROLLMENT })).status).toBe(200);
  });
});

// -------------------------------------------------- one bad row does not blank the rest

describe("a fan-out reports what it already did, even when a later row throws", () => {
  /**
   * **THE FAULT-ISOLATION TEST**, and the one that would have caught a real
   * defect: `performHubDisconnect` had no per-row `try`/`catch`, unlike
   * `performHubConnect` and `syncAllWorkspaces`.
   *
   * `performDisconnect` reaches `readConnection`, which THROWS rather than
   * returning null on a record that will not parse. So three connected
   * workspaces and one corrupt record meant: two credentials deleted, an
   * exception about a JSON file, `hubFanOutActed` never reached, and **no
   * outcome table at all** — a person had no way to learn that half the fan-out
   * had succeeded. The surface showed only the parse complaint.
   *
   * The assertions are on what is on DISK afterwards, not on the shape of the
   * answer, because the answer is exactly what was missing.
   */
  it("disconnects the readable rows and reports the unreadable one as a failed row", async () => {
    await connectRow("alpha");
    await connectRow("bravo");
    await connectRow("charlie");

    // A record that is present and will not parse — a crash mid-write, or a
    // downgrade after a newer staple wrote it.
    const charlieRecord = join(home, "cloud", `${idOf("charlie")}.json`);
    writeFileSync(charlieRecord, "{ this is not json", { mode: 0o600 });

    try {
      const response = await post("/api/hub/disconnect", { confirm: true });
      expect(response.status, await response.clone().text()).toBe(200);
      const answer = (await response.json()) as { fanOut: FanOut };

      // THE POINT: the other two really were disconnected, and the run said so.
      expect(readConnection(home, idOf("alpha"))).toBeNull();
      expect(readConnection(home, idOf("bravo"))).toBeNull();
      expect(answer.fanOut.ok).toBe(2);

      const charlie = answer.fanOut.workspaces.find((row) => row.slug === "charlie")!;
      expect(charlie.status).toBe("failed");
      // The row names the file, because "delete it by hand" is the remedy.
      expect(charlie.detail).toContain(charlieRecord);
      expect(answer.fanOut.failed).toBe(1);

      // Every registered workspace still gets a row, including the one that failed.
      expect(answer.fanOut.workspaces.map((row) => row.slug).sort()).toEqual([
        "alpha",
        "bravo",
        "charlie",
        "delta",
      ]);
    } finally {
      rmSync(charlieRecord, { force: true });
      rmSync(join(home, "cloud", `${idOf("charlie")}.token`), { force: true });
    }
  });

  /**
   * The confirmation counts what it can SEE, and a corrupt row is not in it.
   *
   * `hubCloudReport` reports an unreadable connection record as
   * `state: "disconnected"` with `skip: "problem"`, so `hubDisconnectTargets`
   * excludes it and the confirmation names two workspaces while the fan-out
   * visits four. That is the right behaviour — the surface must not claim to be
   * about a credential it cannot read — but it is only safe BECAUSE the row is
   * reported rather than thrown, which is what the test above pins.
   */
  it("does not name the unreadable row in the confirmation it cannot vouch for", async () => {
    await connectRow("alpha");
    await connectRow("bravo");
    const charlieRecord = join(home, "cloud", `${idOf("charlie")}.json`);
    await connectRow("charlie");
    writeFileSync(charlieRecord, "{ this is not json", { mode: 0o600 });

    try {
      const refusal = (await (await post("/api/hub/disconnect", {})).json()) as { message: string };
      expect(refusal.message).toContain("2");
      expect(refusal.message).toContain("alpha");
      expect(refusal.message).toContain("bravo");
      expect(refusal.message).not.toContain("charlie");
    } finally {
      rmSync(charlieRecord, { force: true });
      rmSync(join(home, "cloud", `${idOf("charlie")}.token`), { force: true });
    }
  });
});

// ------------------------------------------------------------ the empty fan-out

describe("an empty fan-out is refused with a reason, never answered 200 with zero rows", () => {
  it("refuses a hub-wide connect when every workspace is already connected", async () => {
    expect((await connectHub()).status).toBe(200);
    const previewed = await previewHub();
    expect(previewed.status).toBe(409);
    expect(previewed.message).toContain("alpha");
    // The per-row sentence, not a summary: the reason each row is out is stated.
    expect(previewed.message).toContain("Already connected");
  });

  it("refuses a hub-wide sync when nothing is connected", async () => {
    const response = await post("/api/hub/sync", {});
    expect(response.status).toBe(409);
    const refusal = (await response.json()) as { message: string };
    expect(refusal.message).toContain("nothing to synchronize");
    // And it did not reach for the service to find that out.
    expect(seen).toEqual([]);
  });

  it("refuses a hub-wide disconnect when nothing is connected", async () => {
    const response = await post("/api/hub/disconnect", { confirm: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain("nothing to disconnect");
  });
});

// ------------------------------------------------------------ confirmations

describe("hub-wide disconnect names the count it is about", () => {
  it("refuses without confirm, and says how many workspaces it would affect", async () => {
    await connectRow("alpha");
    await connectRow("bravo");

    const response = await post("/api/hub/disconnect", {});
    expect(response.status).toBe(400);
    const refusal = (await response.json()) as { message: string };
    expect(refusal.message).toContain("2");
    expect(refusal.message).toContain("alpha");
    expect(refusal.message).toContain("bravo");

    // Nothing happened, which is what a refusal means.
    expect(readConnection(home, idOf("alpha"))).not.toBeNull();
    expect(readConnection(home, idOf("bravo"))).not.toBeNull();
  });

  it("is not gated on service availability, and makes no request even to check", async () => {
    await connectRow("alpha");
    seen = [];
    service.close();
    try {
      const response = await post("/api/hub/disconnect", { confirm: true });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(readConnection(home, idOf("alpha"))).toBeNull();
      expect(seen).toEqual([]);
    } finally {
      service = createServer((req, res) => void serviceHandler(req, res));
      service.listen(Number(new URL(endpoint).port), "127.0.0.1");
      await once(service, "listening");
    }
  });
});

// ------------------------------------------------------------ the outcome table

describe("every hub-wide verb answers with a per-workspace table and a refreshed report", () => {
  it("reports one row per workspace with its own status and sentence", async () => {
    const answer = await connectHub();
    const rows = answer.fanOut!.workspaces;

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.slug).not.toBe("");
      expect(row.action).toBe("connect");
      expect(["ok", "skipped", "failed"]).toContain(row.status);
      // A sentence for every row, including the skipped one. A table of statuses
      // with no reasons is a table nobody can act on.
      expect(row.detail.length).toBeGreaterThan(10);
      expect(typeof row.at).toBe("string");
    }
    expect(answer.fanOut!.ok + answer.fanOut!.skipped + answer.fanOut!.failed).toBe(4);
  });

  it("carries the refreshed hub report, so acting and re-reading are one round trip", async () => {
    const answer = await connectHub();
    const report = answer.report as ReturnType<typeof hubCloudReport>;
    expect(report.counts.connected).toBe(3);
    expect(report.workspaces.map((row) => row.slug).sort()).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    // The same value the read route would give, so the page cannot end up
    // rendering a report shaped differently from the one it polls.
    expect(report.counts).toEqual(hubCloudReport(home).counts);
  });

  it("keeps a failed row as a row: 200, status failed, and the others still connected", async () => {
    /**
     * `syncAllWorkspaces` reports a failure as a ROW rather than by throwing,
     * because folding `offline`, `revoked` and `rate_limited` into one thrown
     * `conflict` is what makes a multi-row table unactionable. Re-throwing at the
     * route would discard exactly that. Here the service is down, so every
     * connected row fails — and the response is still a 200 carrying rows.
     */
    await connectRow("alpha");
    await connectRow("bravo");
    service.close();
    try {
      const response = await post("/api/hub/sync", {});
      expect(response.status, await response.clone().text()).toBe(200);
      const answer = (await response.json()) as { fanOut: FanOut };
      expect(answer.fanOut.failed).toBeGreaterThan(0);
      const failed = answer.fanOut.workspaces.filter((row) => row.status === "failed");
      expect(failed.map((row) => row.slug).sort()).toEqual(["alpha", "bravo"]);
      // The credentials are untouched: a failed sync is not a disconnect.
      expect(readConnection(home, idOf("alpha"))).not.toBeNull();
    } finally {
      service = createServer((req, res) => void serviceHandler(req, res));
      service.listen(Number(new URL(endpoint).port), "127.0.0.1");
      await once(service, "listening");
    }
  });

  it("never puts a credential on the wire back to the browser", async () => {
    const answer = await connectHub();
    const body = JSON.stringify(answer);
    expect(body).not.toContain(ENROLLMENT);
    expect(body).not.toContain("stpl_minted_device_token");
  });
});

// ------------------------------------------- the hub's own consent (S22/STA-283)

describe("the hub's publish consent is the hub's, not a workspace's", () => {
  /**
   * **THE WRONG-SUBJECT TEST**, and the reason this is a route rather than a
   * fourth key on the two consent routes that already exist.
   *
   * Adding `"registry"` to `/api/cloud/consent`'s `["auto", "backup"]` literal
   * was a two-character change that would have worked in hub mode. In
   * single-workspace mode — which is how `staple ui` runs — `handleFor` ignores
   * its argument and returns the workspace the server booted on, so the hub's
   * consent would have been written into `alpha`'s connection record. The server
   * here IS started on `alpha`, so that is exactly what this file can catch.
   */
  it("is not reachable through either per-workspace consent route", async () => {
    await connectRow("alpha");

    for (const [route, body] of [
      ["/api/cloud/consent", { registry: true }],
      ["/api/cloud/workspace/consent", { slug: "alpha", registry: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await post(route, body);
      expect(response.status, `${route} accepted a registry consent`).toBeGreaterThanOrEqual(400);
    }

    // And nothing was written under alpha's repository id, which is the effect
    // the widening would have had.
    const record = readConnection(home, idOf("alpha"))!;
    expect((record as unknown as Record<string, unknown>).registry).not.toBe(true);
  });

  it("refuses on a hub that has never been connected, rather than creating a record", async () => {
    /**
     * `setRegistryConsent` inherits `setConsent`'s refusal: the zero-network
     * invariant is *"before a repository is connected, no cloud setting,
     * credential or request may exist at all"*, and `at all` is not satisfied by
     * a file recording a consent for a connection that is not there. The hub in
     * this suite is never connected, so this is the state under test.
     */
    const response = await post("/api/hub/consent", { registry: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(seen, "asking about a consent reached the service").toEqual([]);
  });

  /**
   * Give the hub an identity, so the route gets past its own "no hub id yet"
   * refusal and reaches `setRegistryConsent`.
   *
   * `hubId()` MINTS, which is exactly what neither the polled report nor the
   * route may do — and is fine here, because a test standing in for a machine
   * whose hub has been used is the one caller that should. Idempotent after the
   * first call.
   */
  function ensureHubId(): string {
    const hub = Hub.open();
    try {
      return hub.hubId();
    } finally {
      hub.close();
    }
  }

  /**
   * **THE ACKNOWLEDGEMENT SURVIVES THE HTTP BOUNDARY.**
   *
   * `setRegistryConsent` refuses to ENABLE unless handed the disclosure
   * verbatim — evidence the caller had the sentence in hand, removing the case
   * where *"somebody adds a toggle, wires it to the setter, and nobody notices
   * the screen was never built"*.
   *
   * That check is worth nothing over HTTP if the ROUTE supplies the constant.
   * A server passing it on the client's behalf satisfies the check while
   * proving exactly nothing — the same failure `/api/cloud/connect` would have
   * if it accepted an `endpoint`. So the route forwards what the client sent,
   * and this pins both halves: an enable with no acknowledgement is refused,
   * and the server does not have the sentence in scope to supply one.
   *
   * The hub in this suite is never connected, so every enable here refuses. The
   * assertion is therefore on WHICH refusal: `validation` for a missing
   * acknowledgement, which `setRegistryConsent` raises before it looks at the
   * connection at all.
   */
  it("refuses to enable without the disclosure handed back, and supplies none itself", async () => {
    ensureHubId();
    const response = await post("/api/hub/consent", { registry: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const refusal = (await response.json()) as { message: string };
    expect(refusal.message).toContain("verbatim");

    /**
     * The source half, and the one no request can make: the route must not have
     * the constant available to satisfy the check with. If `REGISTRY_DISCLOSURE`
     * is ever imported into `src/ui/server.ts`, the acknowledgement stops
     * meaning "a surface displayed this" and starts meaning nothing.
     */
    const server = readFileSync(new URL("../src/ui/server.ts", import.meta.url).pathname, "utf8");
    const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("REGISTRY_DISCLOSURE");
    expect(code).not.toContain("names, prefixes and identities");
    // It forwards the client's value instead.
    expect(code).toContain("body.disclosure");
  });

  it("refuses an acknowledgement that is not the disclosure", async () => {
    ensureHubId();
    const response = await post("/api/hub/consent", {
      registry: true,
      disclosure: "I promise I showed something",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(((await response.json()) as { message: string }).message).toContain("verbatim");
  });

  it("needs no acknowledgement to WITHDRAW, because revocation must not be harder", async () => {
    ensureHubId();
    /**
     * Making it harder to turn off than on is the wrong asymmetry in a
     * revocation that has to work offline. This hub is unconnected, so the
     * refusal is `not_found` — about the connection, never about a missing
     * acknowledgement, which is the distinction being pinned.
     */
    const response = await post("/api/hub/consent", { registry: false });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(((await response.json()) as { message: string }).message).not.toContain("verbatim");
  });

  it("refuses a body that does not name the consent as a boolean", async () => {
    for (const body of [{}, { registry: "yes" }, { auto: true }, { registry: null }]) {
      const response = await post("/api/hub/consent", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("is POST-only and refuses a cross-origin POST", async () => {
    const get405 = await get("/api/hub/consent");
    expect(get405.status).toBe(405);
    expect(get405.headers.get("allow")).toBe("POST");

    const cross = await fetch(`${origin}/api/hub/consent`, {
      method: "POST",
      headers: {
        "x-staple-token": token,
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ registry: true }),
    });
    expect(cross.status).toBe(403);
  });

  it("carries the disclosure on the report, before anything is granted", async () => {
    /**
     * The sentence has to be on screen BEFORE the switch is flipped, on a
     * machine that has never connected anything — which is the state this suite
     * is in. If it only appeared once connected, the one moment it is needed is
     * the moment it would be missing.
     */
    const report = (await (await get("/api/cloud/workspaces")).json()) as {
      self: { registry: { connected: boolean; consent: boolean; disclosure: string } };
    };
    expect(report.self.registry.connected).toBe(false);
    expect(report.self.registry.consent).toBe(false);
    expect(report.self.registry.disclosure).toContain("names, prefixes and identities");
    expect(report.self.registry.disclosure).toContain("sit together");
  });
});

// ------------------------------------------------------------ the gates

describe("the gates these four routes inherit", () => {
  const ROUTES = [
    "/api/hub/connect/preview",
    "/api/hub/connect",
    "/api/hub/sync",
    "/api/hub/disconnect",
  ];

  it("is POST-only, named in the gate rather than matched by an /api/hub/ prefix", async () => {
    for (const path of ROUTES) {
      const response = await get(path);
      expect(response.status, `${path} answered a GET`).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    // The prefix is NOT writable as a family: a future `/api/hub/` read must not
    // inherit a write pin. `/api/cloud/workspaces` is the read that proves the
    // same rule one prefix over.
    expect((await get("/api/cloud/workspaces")).status).toBe(200);
  });

  it("refuses a cross-origin POST to every one of them", async () => {
    for (const path of ROUTES) {
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

  it("refuses an unauthenticated POST to every one of them", async () => {
    for (const path of ROUTES) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status, `${path} accepted an untokened POST`).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  it("there is still no hub-wide purge, and that is deliberate", async () => {
    /**
     * STA-256 records that the server does not yet validate a purge confirmation
     * on the wire. A one-click irreversible remote deletion of EVERY workspace,
     * behind a browser session, is not a thing to add while that is true — and it
     * is a far worse thing to add hub-wide than per workspace.
     */
    for (const path of ["/api/hub/purge", "/api/cloud/hub/purge"]) {
      expect((await post(path, { confirm: true })).status, `${path} accepts a POST`).toBe(405);
      expect((await get(path)).status, `${path} exists`).toBe(404);
    }
    expect(seen).toEqual([]);
  });
});

// ------------------------------------------------------------ the preview is silent

describe("the hub-wide preview reaches nothing", () => {
  it("enumerates every workspace and its destination without a single request", async () => {
    const previewed = await previewHub();
    expect(previewed.status).toBe(200);
    expect(seen).toEqual([]);

    // Every registered workspace is named, including the ones it will not touch.
    expect(previewed.preview.entries.map((entry) => entry.slug).sort()).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(previewed.preview.willConnect).toBe(3);
    expect(previewed.preview.willSkip).toBe(1);
    // A hub-wide connect is not a hub-wide automatic-sync consent, and there is
    // no argument on this path that could make it one.
    expect(previewed.preview.autoAfterConnect).toBe(false);
  });

  /**
   * THE PER-WORKSPACE DESTINATION, which is the answer to *"one enrollment
   * secret against N services"*. Every actionable row carries its own
   * `ConnectPreview` naming the endpoint, the repository id and the credential
   * store the secret is about to go into. A count would not be consent.
   */
  it("names the endpoint, repository and credential store for EACH actionable row", async () => {
    const previewed = await previewHub();
    const actionable = previewed.preview.entries.filter((entry) => entry.preview !== null);
    expect(actionable).toHaveLength(3);
    for (const entry of actionable) {
      const preview = entry.preview as {
        endpoint: { origin: string };
        repositoryId: string;
        credentialMechanism: string;
      };
      expect(preview.endpoint.origin).toBe(endpoint);
      expect(preview.repositoryId).toBe(idOf(entry.slug));
      expect(preview.credentialMechanism).toBe("file");
    }
  });

  it("mints exactly one ticket per actionable row, and none for a skipped one", async () => {
    const previewed = await previewHub();
    expect(previewed.consents.map((issued) => issued.slug).sort()).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    for (const issued of previewed.consents) {
      expect(issued.consent.id).toBeTruthy();
      expect(issued.consent.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("leaves automatic sync and backup OFF for every workspace it connects", async () => {
    expect((await connectHub()).status).toBe(200);
    for (const slug of ["alpha", "bravo", "charlie"]) {
      const record = readConnection(home, idOf(slug))!;
      expect(record.auto, `${slug} came back with automatic sync on`).toBe(false);
      expect(record.backup, `${slug} came back with backup on`).toBe(false);
    }
  });
});
