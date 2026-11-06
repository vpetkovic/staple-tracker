/**
 * Sharing a workspace by link, end to end across two machines (two staple homes), against
 * the members fake: the owner shares, the joiner joins from the link alone (no clone), the
 * owner approves by the name the link carried, and from then on automatic sync is on and
 * locked on BOTH machines, the owner's included. Plus the local rules on their own:
 * which workspace a link joins, what sharing refuses, and the shared line.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { readConnection, setConsent, writeConnection } from "../src/core/cloud/connection.js";
import { buildJoinPreview, renderJoinPreview } from "../src/core/cloud/join-preview.js";
import { performJoin } from "../src/core/cloud/join.js";
import { approveRequest, approveTargetFor, refreshMembersCache } from "../src/core/cloud/members.js";
import { MEMBERS_CACHE_VERSION, readMembersCache, writeMembersCache, type MembersCache } from "../src/core/cloud/members-cache.js";
import { autoSyncLocked, createShareOffer, resolveJoinTarget, sharedLine, sharedStatus } from "../src/core/cloud/share.js";
import { parseShareLink } from "../src/core/cloud/share-link.js";
import { localCloudStatus } from "../src/core/cloud/status.js";
import { cloudSurfaceReport, describeReport } from "../src/core/cloud/surface.js";
import { Hub } from "../src/core/hub.js";
import { readWorkspaceManifest } from "../src/core/repo-identity.js";
import { StapleError } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { openWorkspace } from "../src/core/open.js";
import { MembersServer, OWNER_DEVICE, OWNER_TOKEN, REPO_ID } from "./fixtures/fake-members-server.js";

const ENDPOINT = "https://sync.members.example";
const previousHome = process.env.STAPLE_HOME;
const dirs: string[] = [];

function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-share-${label}-`));
  dirs.push(dir);
  return dir;
}

function useHome(home: string): void {
  process.env.STAPLE_HOME = home;
}

/** A home-resident workspace called `slug` in `home`, holding repository `repositoryId`. */
function workspaceIn(home: string, slug: string, repositoryId: string): string {
  useHome(home);
  const identity = join(home, "workspaces", slug);
  mkdirSync(identity, { recursive: true });
  writeFileSync(join(identity, "repository.json"), `${JSON.stringify({ repositoryId, format: 1 }, null, 2)}\n`);
  const opened = initWorkspace({ global: true, slug });
  opened.store.db.close();
  return opened.dbPath;
}

function connectOwner(home: string): void {
  credentialStoreFor(home, "file").write(REPO_ID, OWNER_TOKEN);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId: OWNER_DEVICE,
    label: "studio",
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto: false,
    backup: false,
    registry: false,
    protocol: 4,
  });
}

beforeEach(() => {
  delete process.env.STAPLE_HOME;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

describe("two machines: share, join from the link, approve by its name", () => {
  it("joins the owner's workspace by name, and locks automatic sync on for both", async () => {
    const server = new MembersServer();
    const fetchImpl = server.fetch;
    const ownerHome = tmp("owner");
    const joinerHome = tmp("joiner");

    // The owner: a workspace named ai-inbox, connected, with its member list (just them).
    const ownerDb = workspaceIn(ownerHome, "ai-inbox", REPO_ID);
    connectOwner(ownerHome);
    await refreshMembersCache(ownerHome, REPO_ID, { fetchImpl });
    expect(readConnection(ownerHome, REPO_ID)!.auto).toBe(false);
    expect(autoSyncLocked(ownerHome, REPO_ID)).toBe(false);

    const offer = createShareOffer({ home: ownerHome, dbPath: ownerDb, invitedAs: "marko" });
    expect(offer).toMatchObject({ name: "ai-inbox", invitedAs: "marko", autoSyncMandatory: true });
    expect(offer.command).toBe(`staple cloud join '${offer.link}'`);
    expect(offer.message).toContain(offer.link);
    expect(offer.message).toContain("Read it to me");
    const link = parseShareLink(offer.link);
    expect(link).toMatchObject({ endpoint: ENDPOINT, repositoryId: REPO_ID, name: "ai-inbox", sharedBy: "vp", invitedAs: "marko" });
    expect(server.calls.filter((call) => call.path.includes("join"))).toHaveLength(0);

    // The joiner: nothing on this machine but the link.
    useHome(joinerHome);
    const before = resolveJoinTarget({ home: joinerHome, cwd: tmp("elsewhere"), link, create: false });
    expect(before).toMatchObject({ name: "ai-inbox", created: true, fromCheckout: false });
    expect(existsSync(before.dbPath)).toBe(false);
    expect(existsSync(join(joinerHome, "workspaces"))).toBe(false);

    const preview = buildJoinPreview({ home: joinerHome, link, label: "marko-laptop", credential: { forceFile: true } });
    expect(preview).toMatchObject({ endpointSource: "link", autoSync: "on (shared workspace)", repositoryId: REPO_ID });
    const rendered = renderJoinPreview(preview);
    expect(rendered).toContain(`workspace      ai-inbox (${offer.prefix}), shared by vp`);
    expect(rendered).toContain("invited as     marko");
    expect(rendered).toContain("automatic sync on (shared workspace)");

    // Consent given: the workspace is created, adopting the link's repository id.
    const target = resolveJoinTarget({ home: joinerHome, cwd: tmp("elsewhere"), link, create: true });
    expect(target).toMatchObject({ name: "ai-inbox", created: true, fromCheckout: false });
    expect(readWorkspaceManifest(target.dbPath, joinerHome)!.repositoryId).toBe(REPO_ID);
    const hub = Hub.open();
    expect(hub.findByRepositoryId(REPO_ID)!.slug).toBe("ai-inbox");
    hub.close();

    let code = "";
    let approved = false;
    const outcome = await performJoin(preview, {
      home: joinerHome,
      credential: { forceFile: true },
      fetchImpl,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => {
        if (approved) return;
        approved = true;
        // The owner, at the other machine: no --as, so the link's name is the default.
        const chosen = await approveTargetFor(ownerHome, REPO_ID, code, {}, { fetchImpl });
        expect(chosen).toEqual({ as: { asNewMember: "marko" }, fromLink: true });
        await approveRequest(ownerHome, REPO_ID, code, chosen.as, { fetchImpl });
      },
    });
    expect(outcome.status).toBe("joined");
    const create = server.calls.find((call) => call.method === "POST" && call.path.endsWith("/join-requests"))!;
    expect((create.body as { invitedAs?: string }).invitedAs).toBe("marko");

    // The joiner: automatic sync on, with why; a shared workspace on its member list.
    expect(readConnection(joinerHome, REPO_ID)).toMatchObject({ auto: true, autoReason: "shared-workspace" });
    const joinerStatus = localCloudStatus(joinerHome, REPO_ID);
    expect(joinerStatus.shared).toEqual({
      members: [
        { name: "vp", memberId: "mem_owner", self: false },
        { name: "marko", memberId: expect.any(String), self: true },
      ],
      autoSync: "locked-on",
    });

    // The owner: the approval's refresh saw two members, so its automatic sync went on too.
    expect(readConnection(ownerHome, REPO_ID)).toMatchObject({ auto: true, autoReason: "shared-workspace" });
    expect(autoSyncLocked(ownerHome, REPO_ID)).toBe(true);
    const ownerReport = (() => {
      useHome(ownerHome);
      const opened = openWorkspace(ownerDb);
      try {
        return cloudSurfaceReport(localCloudStatus(ownerHome, REPO_ID), opened.store.db);
      } finally {
        opened.store.db.close();
      }
    })();
    expect(ownerReport.shared?.members.map((m) => m.name)).toEqual(["vp", "marko"]);
    expect(describeReport(ownerReport).split("\n")[1]).toBe("shared with marko · syncing automatically");

    // And nobody can switch it off while it is shared, the owner included.
    for (const home of [ownerHome, joinerHome]) {
      let refusal: unknown;
      try {
        setConsent(home, REPO_ID, { auto: false });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(StapleError);
      expect(refusal).toMatchObject({ code: "forbidden", detail: { autoSync: "locked-on" } });
      expect((refusal as Error).message).toContain("staple cloud disconnect");
      expect(readConnection(home, REPO_ID)!.auto).toBe(true);
    }
  });
});

describe("a completed join turns automatic sync on by itself", () => {
  it("even when the member list cannot be fetched afterwards", async () => {
    const server = new MembersServer();
    const home = tmp("joiner");
    useHome(home);
    // Every member-list read fails: whatever turns auto on, it is not the refresh.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.endsWith("/members")) {
        return new Response(JSON.stringify({ code: "unavailable", message: "down", retryable: true }), { status: 503 });
      }
      return server.fetch(input as string, init);
    }) as typeof fetch;
    const link = { endpoint: ENDPOINT, repositoryId: REPO_ID, name: "ai-inbox", prefix: null, sharedBy: "vp", invitedAs: null };
    const preview = buildJoinPreview({ home, link, label: "marko-laptop", credential: { forceFile: true } });
    let code = "";
    const outcome = await performJoin(preview, {
      home,
      credential: { forceFile: true },
      fetchImpl,
      now: () => server.now,
      onCode: (ticket) => (code = ticket.code),
      sleep: async () => server.approve(code, { name: "marko" }),
    });
    expect(outcome).toMatchObject({ status: "joined", members: null });
    expect(readConnection(home, REPO_ID)).toMatchObject({ auto: true, autoReason: "shared-workspace" });
  });
});

describe("which workspace a link joins", () => {
  const link = (over: Partial<ReturnType<typeof parseShareLink>> = {}) => ({
    endpoint: ENDPOINT,
    repositoryId: REPO_ID,
    name: "ai-inbox",
    prefix: "AII",
    sharedBy: "vp",
    invitedAs: null,
    ...over,
  });

  it("uses a checkout of the same repository, and nothing else for a checkout of another", () => {
    const home = tmp("home");
    useHome(home);
    const clone = join(tmp("clone"), "ai-inbox-supabase");
    mkdirSync(join(clone, ".staple"), { recursive: true });
    writeFileSync(join(clone, ".staple", "repository.json"), `${JSON.stringify({ repositoryId: REPO_ID, format: 1 })}\n`);
    const inside = join(clone, "src", "deep");
    mkdirSync(inside, { recursive: true });
    const found = resolveJoinTarget({ home, cwd: inside, link: link(), create: false });
    expect(found).toMatchObject({ fromCheckout: true, created: true, dbPath: join(clone, ".staple", "staple.db") });
    expect(existsSync(found.dbPath)).toBe(false);
    const made = resolveJoinTarget({ home, cwd: inside, link: link(), create: true });
    expect(made).toMatchObject({ fromCheckout: true, created: true });
    expect(existsSync(made.dbPath)).toBe(true);

    // Another repository vendored INSIDE this repository's checkout: the nearest checkout
    // decides, so the outer one is not reached past it.
    const other = join(clone, "vendor", "other-repo");
    mkdirSync(join(other, ".staple"), { recursive: true });
    writeFileSync(
      join(other, ".staple", "repository.json"),
      `${JSON.stringify({ repositoryId: "99999999-9999-4999-8999-999999999999", format: 1 })}\n`,
    );
    // Not this repository's checkout, so not a reason to look further up: the home is used.
    expect(resolveJoinTarget({ home, cwd: other, link: link(), create: false })).toMatchObject({ fromCheckout: false, created: false });
  });

  it("reuses the workspace this machine already has for the repository", () => {
    const home = tmp("home");
    const db = workspaceIn(home, "inbox-local", REPO_ID);
    expect(resolveJoinTarget({ home, cwd: tmp("x"), link: link(), create: false })).toEqual({
      dbPath: db,
      name: "inbox-local",
      created: false,
      fromCheckout: false,
    });
  });

  it("suffixes the name only when a different workspace already has it", () => {
    const home = tmp("home");
    workspaceIn(home, "ai-inbox", "88888888-8888-4888-8888-888888888888");
    const target = resolveJoinTarget({ home, cwd: tmp("x"), link: link(), create: true });
    expect(target).toMatchObject({ name: "ai-inbox-2", created: true });
    expect(readWorkspaceManifest(target.dbPath, home)!.repositoryId).toBe(REPO_ID);
  });

  it("refuses a home that is not the staple home in effect", () => {
    const home = tmp("home");
    useHome(tmp("other-home"));
    expect(() => resolveJoinTarget({ home, cwd: home, link: link(), create: false })).toThrow(/not the staple home/);
  });
});

describe("what sharing needs", () => {
  it("refuses an unconnected workspace, a workspace with no member list, and a removed device", () => {
    const home = tmp("home");
    const db = workspaceIn(home, "solo", REPO_ID);
    expect(() => createShareOffer({ home, dbPath: db })).toThrow(/staple cloud connect/);
    connectOwner(home);
    expect(() => createShareOffer({ home, dbPath: db })).toThrow(/member list/);
    writeMembersCache(home, {
      version: MEMBERS_CACHE_VERSION,
      repositoryId: REPO_ID,
      fetchedAt: "2026-11-06T00:00:00.000Z",
      self: { memberId: "m-vp", deviceId: OWNER_DEVICE },
      members: [{ memberId: "m-vp", name: "VP", isOwner: true, removed: false, devices: [] }],
    });
    const offer = createShareOffer({ home, dbPath: db });
    expect(parseShareLink(offer.link)).toMatchObject({ sharedBy: "VP", invitedAs: null, name: "solo" });
    expect(() => createShareOffer({ home, dbPath: db, invitedAs: "<b>" })).toThrow(/can't go in a share link/);
    writeConnection(home, { ...readConnection(home, REPO_ID)!, removed: { by: "olga", at: "2026-11-06T00:00:00.000Z" } });
    expect(() => createShareOffer({ home, dbPath: db })).toThrow(/removed/);
  });
});

describe("the shared line", () => {
  it("names the other members, and is null for a solo workspace", () => {
    const cache = (names: string[], removed: string[] = []): MembersCache => ({
      version: MEMBERS_CACHE_VERSION,
      repositoryId: REPO_ID,
      fetchedAt: "x",
      self: { memberId: "m-0", deviceId: "d" },
      members: [...names, ...removed].map((name, i) => ({
        memberId: `m-${i}`,
        name,
        isOwner: i === 0,
        removed: removed.includes(name),
        devices: [],
      })),
    });
    expect(sharedLine(sharedStatus(cache(["VP"])), true)).toBeNull();
    // A removed member does not make a workspace shared.
    expect(sharedLine(sharedStatus(cache(["VP"], ["olga"])), true)).toBeNull();
    expect(sharedLine(sharedStatus(cache(["VP", "marko", "ana"])), true)).toBe("shared with marko, ana · syncing automatically");
    expect(sharedLine(sharedStatus(null), true)).toBeNull();
  });

  it("is absent from a solo workspace's status, which reads exactly as before", () => {
    const home = tmp("home");
    workspaceIn(home, "solo", REPO_ID);
    connectOwner(home);
    expect(localCloudStatus(home, REPO_ID).shared).toBeNull();
    expect(readMembersCache(home, REPO_ID)).toBeNull();
    void readFileSync;
  });
});
