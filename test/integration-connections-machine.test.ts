import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationConnections } from "../src/core/integrations/connections.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function home() { const d = mkdtempSync(join(tmpdir(), "staple-connections-")); dirs.push(d); return d; }
/** A connection file as #215–#226 wrote it: one directory per workspace identity. */
function legacy(root: string, workspaceHash: string, connection: Record<string, unknown>) {
  const dir = join(root, "integrations", workspaceHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${connection.id}.json`), JSON.stringify(connection) + "\n");
}
const A = "a".repeat(64), B = "b".repeat(64);
const gh = (id: string, account = "vpetkovic") => ({ id, providerId: "github", mode: "cli", host: "github.com", account });
const linear = (id: string) => ({ id, providerId: "linear", mode: "api", host: "linear.app", account: "11111111-1111-4111-8111-111111111111",
  scopeId: "22222222-2222-4222-8222-222222222222", credentialEnv: "STAPLE_LINEAR_API_KEY" });

describe("machine-wide integration connections", () => {
  it("is one list for the machine: a connection saved once is there for every workspace", () => {
    const root = home();
    const saved = new IntegrationConnections(root).save({ providerId: "github", mode: "cli", host: "github.com", account: "vpetkovic" });
    expect(new IntegrationConnections(root).list()).toEqual([saved]);
  });

  it("migrates every workspace's connections, collapsing duplicates and keeping old ids as aliases", () => {
    const root = home();
    legacy(root, A, gh("gh-in-a"));
    legacy(root, A, linear("linear-in-a"));
    legacy(root, B, gh("gh-in-b"));                 // the same account configured again in another workspace
    legacy(root, B, gh("other-account", "octo"));
    const connections = new IntegrationConnections(root);
    const listed = connections.list();
    expect(listed.map(c => c.id).sort()).toEqual(["gh-in-a", "linear-in-a", "other-account"]);
    expect(connections.resolve("gh-in-b")?.id).toBe("gh-in-a");
    expect(connections.resolve("gh-in-a")?.id).toBe("gh-in-a");
    expect(existsSync(join(root, "integrations", A))).toBe(false);
    expect(existsSync(join(root, "integrations", B))).toBe(false);
    // Running again, or from another process, changes nothing.
    expect(new IntegrationConnections(root).list()).toEqual(listed);
    expect(readdirSync(join(root, "integrations")).sort()).toEqual(["machine"]);
  });

  it("removes a connection by an alias, and the alias stops resolving", () => {
    const root = home();
    legacy(root, A, gh("gh-in-a"));
    legacy(root, B, gh("gh-in-b"));
    const connections = new IntegrationConnections(root);
    connections.remove("gh-in-b");
    expect(connections.list()).toEqual([]);
    expect(connections.resolve("gh-in-b")).toBeNull();
  });

  it("leaves an unreadable legacy file in place rather than losing it", () => {
    const root = home();
    const dir = join(root, "integrations", A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json");
    legacy(root, A, gh("gh-in-a"));
    expect(new IntegrationConnections(root).list().map(c => c.id)).toEqual(["gh-in-a"]);
    expect(existsSync(join(dir, "broken.json"))).toBe(true);
  });
});
