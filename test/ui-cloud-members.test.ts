/**
 * The local server's members and join routes (`src/ui/cloud-members-routes.ts`), end to end
 * through the real UI server, against the fake members service served over HTTP.
 *
 * What these pin: the join preview sends nothing; the start route carries only the consent
 * ticket; the request secret never reaches the page; the members routes call the same core
 * functions the CLI does and refresh the cache; every route is POST-only and Origin-checked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { initWorkspace } from "../src/core/workspace.js";
import { readStoredRepositoryId, writeRepositoryEndpoint } from "../src/core/repo-identity.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { deleteConnection, readConnection, writeConnection } from "../src/core/cloud/connection.js";
import { readMembersCache, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { openWorkspace } from "../src/core/open.js";
import { MEMBER_POST_ROUTES } from "../src/ui/cloud-members-routes.js";
import { MembersServer, OWNER_DEVICE, OWNER_MEMBER, OWNER_TOKEN } from "./fixtures/fake-members-server.js";

let home: string;
let scratch: string;
let ownerId: string;
let joinerId: string;
let ui: UiHandle;
let origin: string;
let token: string;
let http: Server;
let endpoint: string;
/** One fake service per repository, swapped per test. */
let fakes: Map<string, MembersServer>;
/** Hold a join request's read this long before the fake answers, to open a race window. */
let readDelayMs = 0;

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  const repoId = decodeURIComponent(url.pathname.split("/v1/repos/")[1]?.split("/")[0] ?? "");
  const fake = fakes.get(repoId) ?? [...fakes.values()][0]!;
  if (readDelayMs > 0 && req.method === "GET" && /\/join-requests\/[^/]+$/.test(url.pathname)) {
    await new Promise((resolve) => setTimeout(resolve, readDelayMs));
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key] = value;
  const response = await fake.fetch(`${endpoint}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: raw.length > 0 ? raw : undefined,
  });
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
}

function post(path: string, body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": token, "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uimem-home-"));
  scratch = mkdtempSync(join(tmpdir(), "staple-uimem-work-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const owner = initWorkspace({ dir: join(scratch, "owner"), slug: "owner" });
  ownerId = readStoredRepositoryId(owner.store.db)!;
  owner.store.db.close();
  const joiner = initWorkspace({ dir: join(scratch, "joiner"), slug: "joiner" });
  joinerId = readStoredRepositoryId(joiner.store.db)!;
  joiner.store.db.close();

  http = createServer((req, res) => void serve(req, res));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  // The joiner's repository publishes where to join (`staple cloud share-endpoint`).
  writeRepositoryEndpoint(join(scratch, "joiner", ".staple"), endpoint);

  ui = startUiServer({ port: 0, hub: false, db: join(scratch, "owner", ".staple", "staple.db") });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  http?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  readDelayMs = 0;
  fakes = new Map([
    [ownerId, new MembersServer(ownerId)],
    [joinerId, new MembersServer(joinerId)],
  ]);
  deleteConnection(home, joinerId);
  // The owner workspace is connected as the owner's device.
  credentialStoreFor(home, "file").write(ownerId, OWNER_TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: ownerId,
    endpoint,
    deviceId: OWNER_DEVICE,
    label: "studio",
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 4,
  });
});

describe("joining from the page", () => {
  it("offers to join when the committed manifest names an endpoint and nothing is connected", async () => {
    const offer = await body(await fetch(`${origin}/api/cloud/workspace/join/offer?ws=joiner`, { headers: { "x-staple-token": token } }));
    expect(offer).toMatchObject({ slug: "joiner", endpoint, connected: false, removedBy: null });
    expect(fakes.get(joinerId)!.calls).toHaveLength(0);
  });

  it("previews with no request, starts on the ticket alone, polls, and joins", async () => {
    const service = fakes.get(joinerId)!;
    const previewed = await body<{
      preview: { endpoint: string; repositoryId: string; label: string; endpointSource: string };
      consent: { id: string; digest: string };
    }>(await post("/api/cloud/workspace/join/preview", { slug: "joiner", label: "marko-laptop", credentialFile: true }));
    expect(previewed.preview).toMatchObject({ endpoint, repositoryId: joinerId, label: "marko-laptop", endpointSource: "manifest" });
    // The preview is the consent mechanism: nothing has been sent, to either service.
    for (const fake of fakes.values()) expect(fake.calls).toHaveLength(0);

    const started = await body<{ joinId: string; code: string; expiresAt: number }>(
      await post("/api/cloud/workspace/join/start", { slug: "joiner", consent: previewed.consent.id, digest: previewed.consent.digest }),
    );
    expect(started.code).toBe("K001-7Q2M");
    // The page holds an id, never the request secret.
    expect(JSON.stringify(started)).not.toMatch(/[0-9a-f]{64}/);
    // `/v1/capabilities` names no repository, so this harness serves it from the first fake.
    expect(service.routes()).toEqual(["POST /join-requests"]);
    expect(fakes.get(ownerId)!.routes()).toEqual(["GET /v1/capabilities"]);

    expect(await body(await post("/api/cloud/workspace/join/poll", { joinId: started.joinId }))).toMatchObject({ status: "pending" });
    service.approve(started.code, { name: "marko" });
    const joined = await body(await post("/api/cloud/workspace/join/poll", { joinId: started.joinId }));
    // A join makes a shared workspace, so automatic sync is on.
    expect(joined).toMatchObject({ status: "joined", member: { name: "marko" }, auto: true, membersCached: true });

    const record = readConnection(home, joinerId)!;
    expect(record).toMatchObject({ auto: true, autoReason: "shared-workspace", backup: false, label: "marko-laptop" });
    expect(readMembersCache(home, joinerId)!.members.map((m) => m.name)).toEqual(["vp", "marko"]);
    // Finished joins are forgotten: a second poll is told so.
    expect((await post("/api/cloud/workspace/join/poll", { joinId: started.joinId })).status).toBe(404);
  });

  it("a start without the preview's ticket is refused and sends nothing", async () => {
    const response = await post("/api/cloud/workspace/join/start", { slug: "joiner", consent: "made-up", digest: "x" });
    expect(response.status).toBe(404);
    expect(fakes.get(joinerId)!.calls).toHaveLength(0);
  });

  it("reports denied and expired as statuses, and cancel is local", async () => {
    const service = fakes.get(joinerId)!;
    const start = async () => {
      const previewed = await body<{ consent: { id: string; digest: string } }>(
        await post("/api/cloud/workspace/join/preview", { slug: "joiner", credentialFile: true }),
      );
      return body<{ joinId: string; code: string }>(
        await post("/api/cloud/workspace/join/start", { slug: "joiner", consent: previewed.consent.id, digest: previewed.consent.digest }),
      );
    };
    const denied = await start();
    service.setStatus(denied.code, "denied");
    expect(await body(await post("/api/cloud/workspace/join/poll", { joinId: denied.joinId }))).toMatchObject({ status: "denied" });

    const expired = await start();
    service.setStatus(expired.code, "expired");
    expect(await body(await post("/api/cloud/workspace/join/poll", { joinId: expired.joinId }))).toMatchObject({ status: "expired" });

    const cancelled = await start();
    const before = service.calls.length;
    expect(await body(await post("/api/cloud/workspace/join/cancel", { joinId: cancelled.joinId }))).toMatchObject({
      cancelled: true,
      code: cancelled.code,
    });
    expect(service.calls.length).toBe(before);
    expect(readConnection(home, joinerId)).toBeNull();
  });
});

describe("members and requests from the page", () => {
  async function pending(service: MembersServer): Promise<string> {
    const response = await service.fetch(`${endpoint}/v1/repos/${ownerId}/join-requests`, {
      method: "POST",
      body: JSON.stringify({ deviceId: "bbbbbbbb-0000-4000-8000-000000000002", label: "thinkpad", requestSecretSha256: "00" }),
    });
    return ((await response.json()) as { code: string }).code;
  }

  it("opening Members fetches the list and the pending requests, and writes the cache", async () => {
    const service = fakes.get(ownerId)!;
    const code = await pending(service);
    const opened = await body<{ members: { self: { memberId: string }; members: unknown[] }; requests: Array<{ code: string; label: string }> }>(
      await post("/api/cloud/workspace/members", { slug: "owner" }),
    );
    expect(opened.members.self.memberId).toBe(OWNER_MEMBER);
    expect(opened.requests).toEqual([expect.objectContaining({ code, label: "thinkpad" })]);
    expect(readMembersCache(home, ownerId)).not.toBeNull();
  });

  it("approves as a new member, denies, renames and removes with the name typed back", async () => {
    const service = fakes.get(ownerId)!;
    const first = await pending(service);
    const approved = await body<{ approved: { member: { name: string } }; members: { members: Array<{ name: string }> } }>(
      await post("/api/cloud/workspace/join-requests/approve", { slug: "owner", code: first, newMember: "marko" }),
    );
    expect(approved.approved.member.name).toBe("marko");
    expect(approved.members.members.map((m) => m.name)).toEqual(["vp", "marko"]);

    const second = await pending(service);
    await body(await post("/api/cloud/workspace/join-requests/deny", { slug: "owner", code: second }));
    expect(service.requests.find((r) => r.code === second)!.status).toBe("denied");

    const marko = service.members.find((m) => m.name === "marko")!;
    await body(await post("/api/cloud/workspace/members/rename", { slug: "owner", memberId: marko.memberId, name: "Marko" }));
    expect(marko.name).toBe("Marko");

    const unconfirmed = await post("/api/cloud/workspace/members/remove", { slug: "owner", memberId: marko.memberId, confirm: "nope" });
    expect(unconfirmed.status).toBe(409);
    expect(service.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    const removed = await body<{ removed: { name: string } }>(
      await post("/api/cloud/workspace/members/remove", { slug: "owner", memberId: marko.memberId, confirm: "Marko" }),
    );
    expect(removed.removed.name).toBe("Marko");
  });

  it("every route is POST-only and refused cross-origin without the token", async () => {
    for (const route of MEMBER_POST_ROUTES) {
      const get = await fetch(`${origin}${route}`, { headers: { "x-staple-token": token } });
      expect(get.status, route).toBe(405);
      const foreign = await fetch(`${origin}${route}`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ slug: "owner" }),
      });
      expect([401, 403], route).toContain(foreign.status);
    }
    expect(fakes.get(ownerId)!.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ audit findings

async function previewAndStart(): Promise<{ joinId: string; code: string }> {
  const previewed = await body<{ consent: { id: string; digest: string } }>(
    await post("/api/cloud/workspace/join/preview", { slug: "joiner", credentialFile: true }),
  );
  return body<{ joinId: string; code: string }>(
    await post("/api/cloud/workspace/join/start", { slug: "joiner", consent: previewed.consent.id, digest: previewed.consent.digest }),
  );
}

describe("cancel tells the truth about a join whose credential is being collected", () => {
  it("a cancel during the collecting read waits for it and answers joined", async () => {
    const service = fakes.get(joinerId)!;
    const started = await previewAndStart();
    service.approve(started.code, { name: "marko" });
    readDelayMs = 400;
    const polling = post("/api/cloud/workspace/join/poll", { joinId: started.joinId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancel = await body<Record<string, unknown>>(await post("/api/cloud/workspace/join/cancel", { joinId: started.joinId }));
    const polled = await body<Record<string, unknown>>(await polling);
    expect(polled).toMatchObject({ status: "joined" });
    expect(cancel).toMatchObject({ cancelled: false, status: "joined", member: { name: "marko" } });
    expect(readConnection(home, joinerId)).not.toBeNull();
  });

  it("a cancel during a read that comes back pending cancels, and nothing completes afterwards", async () => {
    const service = fakes.get(joinerId)!;
    const started = await previewAndStart();
    readDelayMs = 400;
    const polling = post("/api/cloud/workspace/join/poll", { joinId: started.joinId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancel = await body<Record<string, unknown>>(await post("/api/cloud/workspace/join/cancel", { joinId: started.joinId }));
    expect(cancel).toMatchObject({ cancelled: true, code: started.code });
    // The poll that was out says so too, rather than "pending" for a join that no longer exists.
    expect(await body(await polling)).toMatchObject({ status: "cancelled", code: started.code });
    readDelayMs = 0;
    service.approve(started.code, { name: "marko" });
    expect((await post("/api/cloud/workspace/join/poll", { joinId: started.joinId })).status).toBe(404);
    expect(readConnection(home, joinerId)).toBeNull();
  });

  it("a cancel before any read cancels locally and sends nothing", async () => {
    const service = fakes.get(joinerId)!;
    const started = await previewAndStart();
    const before = service.calls.length;
    expect(await body(await post("/api/cloud/workspace/join/cancel", { joinId: started.joinId }))).toMatchObject({ cancelled: true });
    expect(service.calls.length).toBe(before);
  });
});

describe("the toast's background list asks nobody unless this device agreed to background traffic", () => {
  const cache = () =>
    writeMembersCache(home, {
      version: 1,
      repositoryId: ownerId,
      fetchedAt: "2026-11-06T00:00:00.000Z",
      self: { memberId: OWNER_MEMBER, deviceId: OWNER_DEVICE },
      members: [{ memberId: OWNER_MEMBER, name: "vp", isOwner: true, removed: false, devices: [] }],
    });
  const auto = (on: boolean) => writeConnection(home, { ...readConnection(home, ownerId)!, auto: on });

  it("refuses with automatic sync off, without a request", async () => {
    cache();
    auto(false);
    const refused = await post("/api/cloud/workspace/join-requests", { slug: "owner", background: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail?: { reason?: string } }).detail?.reason).toBe("auto_sync_off");
    expect(fakes.get(ownerId)!.calls).toHaveLength(0);
  });

  it("refuses with no member list on this machine, without a request", async () => {
    rmSync(join(home, "cloud", "members"), { recursive: true, force: true });
    auto(true);
    const refused = await post("/api/cloud/workspace/join-requests", { slug: "owner", background: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail?: { reason?: string } }).detail?.reason).toBe("no_members");
    expect(fakes.get(ownerId)!.calls).toHaveLength(0);
  });

  it("lists with both, and a person's own request is never gated", async () => {
    cache();
    auto(true);
    expect(await body(await post("/api/cloud/workspace/join-requests", { slug: "owner", background: true }))).toMatchObject({ requests: [] });
    auto(false);
    expect(await body(await post("/api/cloud/workspace/join-requests", { slug: "owner" }))).toMatchObject({ requests: [] });
  });
});

describe("a member change refreshes the page", () => {
  it("the change fingerprint moves when the member list is written", async () => {
    const read = async () => ((await (await fetch(`${origin}/api/poll`, { headers: { "x-staple-token": token } })).json()) as { fingerprint: string }).fingerprint;
    rmSync(join(home, "cloud", "members"), { recursive: true, force: true });
    const before = await read();
    writeMembersCache(home, {
      version: 1,
      repositoryId: ownerId,
      fetchedAt: "2026-11-06T00:00:01.000Z",
      self: { memberId: OWNER_MEMBER, deviceId: OWNER_DEVICE },
      members: [{ memberId: OWNER_MEMBER, name: "vp", isOwner: true, removed: false, devices: [] }],
    });
    expect(await read()).not.toBe(before);
  });
});

describe("renaming from the page moves the member's tickets", () => {
  it("rewrites this workspace's assignees from the old name to the new one", async () => {
    const service = fakes.get(ownerId)!;
    service.members.push({ memberId: "mem_m", name: "marko", isOwner: false, removedAt: null, removedBy: null });
    const opened = openWorkspace(join(scratch, "owner", ".staple", "staple.db"));
    const ticket = opened.store.createIssue({ title: "marko's work", assignee: "marko", createdBy: "vp" });
    opened.store.db.close();

    const renamed = await body<{ renamed: { reassigned: string[] } }>(
      await post("/api/cloud/workspace/members/rename", { slug: "owner", memberId: "mem_m", name: "Mark" }),
    );
    expect(renamed.renamed.reassigned).toEqual([ticket.identifier]);
    const after = openWorkspace(join(scratch, "owner", ".staple", "staple.db"));
    expect(after.store.getIssue(ticket.identifier).assignee).toBe("Mark");
    after.store.db.close();
  });
});
