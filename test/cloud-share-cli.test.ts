/**
 * The CLI half of sharing by link, through the real `staple` binary in an isolated home:
 * `cloud share`, the refusal of `cloud auto off` in a shared workspace, the shared line on
 * `cloud status`, `ls` and `inbox`, and `cloud join '<link>'` asking before it creates
 * anything. No request leaves the machine in any of these: the member list is a fixture
 * written exactly as the client writes it, and `join` stops at its consent question.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { MEMBERS_CACHE_VERSION, writeMembersCache } from "../src/core/cloud/members-cache.js";
import { CONTRACT_AGENT, runCliAsync } from "./fixtures/contract-support.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const ENDPOINT = "https://sync.members.example";
const WS = "ai-inbox";
let home: string;
let joinerHome: string;
let elsewhere: string;

const cli = (...args: string[]) => runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-share-cli-"));
  joinerHome = mkdtempSync(join(tmpdir(), "staple-share-cli-joiner-"));
  elsewhere = mkdtempSync(join(tmpdir(), "staple-share-cli-cwd-"));
  // The owner's workspace holds the shared repository's id.
  mkdirSync(join(home, "workspaces", WS), { recursive: true });
  writeFileSync(join(home, "workspaces", WS, "repository.json"), `${JSON.stringify({ repositoryId: REPO_ID, format: 1 })}\n`);
  expect((await cli("init", "--global", WS)).status).toBe(0);
  expect((await cli("new", "Fix webhook retry", "--ws", WS)).status).toBe(0);
  credentialStoreFor(home, "file").write(REPO_ID, "stpl_owner");
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId: "owner-device",
    label: "studio",
    credentialMechanism: "file",
    connectedAt: "2026-11-06T00:00:00.000Z",
    auto: true,
    autoReason: "shared-workspace",
    backup: false,
    registry: false,
    protocol: 4,
  });
  writeMembersCache(home, {
    version: MEMBERS_CACHE_VERSION,
    repositoryId: REPO_ID,
    fetchedAt: "2026-11-06T00:00:00.000Z",
    self: { memberId: "m-vp", deviceId: "owner-device" },
    members: [
      { memberId: "m-vp", name: "VP", isOwner: true, removed: false, devices: [] },
      { memberId: "m-marko", name: "marko", isOwner: false, removed: false, devices: [] },
    ],
  });
}, 60_000);

afterAll(() => {
  for (const dir of [home, joinerHome, elsewhere]) rmSync(dir, { recursive: true, force: true });
});

describe("cloud share", () => {
  it("prints the link, the command and a message, and says auto sync becomes mandatory", async () => {
    const text = await cli("cloud", "share", "--as", "ana", "--ws", WS);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toMatch(new RegExp(`link\\s+${ENDPOINT}/join/${REPO_ID}\\?n=ai-inbox&p=[A-Z]+&by=VP&as=ana`));
    expect(text.stdout).toContain(`command   staple cloud join '${ENDPOINT}/join/${REPO_ID}?n=ai-inbox`);
    expect(text.stdout).toContain("automatic sync is ON for every device, yours included");
    expect(text.stdout).toContain("Hi ana, VP invited you");

    const json = JSON.parse((await cli("cloud", "share", "--ws", WS, "--json")).stdout);
    expect(json).toMatchObject({ name: "ai-inbox", invitedAs: null, autoSyncMandatory: true });
    expect(json.command).toBe(`staple cloud join '${json.link}'`);
  });
});

describe("a shared workspace keeps syncing", () => {
  it("refuses cloud auto off, saying why and how to stop", async () => {
    const refused = await cli("cloud", "auto", "off", "--ws", WS);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("shared with marko");
    expect(refused.stderr).toContain("staple cloud disconnect");
    const on = await cli("cloud", "auto", "on", "--ws", WS);
    expect(on.status, on.stderr).toBe(0);
  });

  it("says it is shared on cloud status, ls and inbox, and in status JSON", async () => {
    const line = "shared with marko · syncing automatically";
    const status = await cli("cloud", "status", "--ws", WS);
    expect(status.stdout.split("\n")[1]).toBe(line);
    expect(status.stdout).toContain("on (shared workspace: stays on)");
    const json = JSON.parse((await cli("cloud", "status", "--ws", WS, "--json")).stdout);
    expect(json.shared ?? json.report?.shared).toEqual({
      members: [
        { name: "VP", memberId: "m-vp", self: true },
        { name: "marko", memberId: "m-marko", self: false },
      ],
      autoSync: "locked-on",
    });
    expect((await cli("ls", "--ws", WS)).stdout.split("\n")[0]).toBe(line);
    expect((await cli("inbox", "--ws", WS)).stdout.split("\n")[0]).toBe(line);
    // JSON listings keep their shape.
    expect(Array.isArray(JSON.parse((await cli("ls", "--ws", WS, "--json")).stdout))).toBe(true);
  });
});

describe("cloud join '<link>'", () => {
  it("shows the workspace it would create and creates nothing before consent", async () => {
    const link = JSON.parse((await cli("cloud", "share", "--as", "marko", "--ws", WS, "--json")).stdout).link as string;
    const joined = await runCliAsync(["cloud", "join", link], { STAPLE_HOME: joinerHome, STAPLE_AGENT: CONTRACT_AGENT, PWD: elsewhere });
    expect(joined.status).toBe(2);
    expect(joined.stdout).toContain(`Workspace on this machine: ai-inbox  (new, created in your staple home when you agree`);
    expect(joined.stdout).toContain("invited as     marko");
    expect(joined.stdout).toContain("automatic sync on (shared workspace)");
    expect(joined.stderr).toContain("Nothing was sent");
    expect(existsSync(join(joinerHome, "workspaces", "ai-inbox.db"))).toBe(false);
    expect(existsSync(join(joinerHome, "cloud"))).toBe(false);
  });

  it("refuses what is not a link, and a link with --endpoint", async () => {
    const notLink = await cli("cloud", "join", "https://sync.members.example");
    expect(notLink.status).toBe(2);
    expect(notLink.stderr).toContain("not a share link");
    const link = `${ENDPOINT}/join/${REPO_ID}?n=ai-inbox`;
    const both = await cli("cloud", "join", link, "--endpoint", ENDPOINT);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("does not take --endpoint");
  });
});
