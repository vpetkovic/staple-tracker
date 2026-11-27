/**
 * Plan files on every surface (design/plan.md, "Ideas from files"): the Plan view's tray (HTTP,
 * as the person) and `staple idea files` list the same plan files with the same states; the
 * person imports one or many and ignores one from either; an agent's import is refused; planning
 * off refuses both and keeps the marks.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openWorkspace } from "../src/core/open.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync } from "./fixtures/contract-support.js";

let home: string;
let root: string;
let dbPath: string;
let ui: UiHandle;
let origin: string;

interface FilesView {
  paths: string[];
  files: Array<{ path: string; state: string; kind: string; done: boolean; title: string; idea: { number: string | null } | null }>;
  counts: Record<string, number>;
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": ui.token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const cli = (...args: string[]) => runCliAsync([...args, "--db", dbPath], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
const gist = (view: FilesView) => view.files.map((file) => ({ path: file.path, state: file.state, idea: file.idea?.number ?? null }));

function put(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-files-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-files-repo-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  put("roadmap.md", "# Roadmap\n\nWhere we go.\n");
  put("README.md", "# Project\n");
  put("plans/passkeys.md", "# Passkeys\n\n**Status:** Draft\n");
  put("plans/done/billing.md", "# Billing\n");
  put("plans/sso/sso.md", "# Single sign-on\n");
  put("plans/sso/assets/flow.jsx", "export const Flow = () => null;\n");
  const created = initWorkspace({ dir: root, slug: "files" });
  dbPath = created.dbPath;
  const opened = openWorkspace(dbPath);
  opened.store.plan().enable("VP", { person: { via: "settings" } });
  opened.store.db.close();
  expect((await runCliAsync(["config", "set", "humanName", "VP"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("plan files on every surface", () => {
  it("lists the same plan files from the tray and the CLI, and imports none on its own", async () => {
    const page = await http("/api/plan-files");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const listed = await cli("idea", "files", "--json");
    expect(listed.status, listed.stderr).toBe(0);
    const fromPage = page.body as unknown as FilesView;
    expect(gist(fromPage)).toEqual([
      { path: "plans/done/billing.md", state: "new", idea: null },
      { path: "plans/passkeys.md", state: "new", idea: null },
      { path: "plans/sso", state: "new", idea: null },
      { path: "roadmap.md", state: "new", idea: null },
    ]);
    expect(fromPage.files.find((file) => file.path === "plans/sso")).toMatchObject({ kind: "folder" });
    expect(fromPage.files.find((file) => file.path === "plans/done/billing.md")).toMatchObject({ done: true });
    expect(gist(JSON.parse(listed.stdout) as FilesView)).toEqual(gist(fromPage));
    const words = await cli("idea", "files");
    expect(words.stdout).toContain("looking in: *.md, plans/**");
    expect(words.stdout).toMatch(/new\s+plans\/sso\s+Single sign-on\s+\[folder, 2 files\]/);
    expect(words.stdout).toContain("4 new, 0 changed since import, 0 imported, 0 ignored");
    expect(((await http("/api/plan")).body as { ideas: unknown[] }).ideas).toHaveLength(0);
  });

  it("imports several from the tray as the person, and an agent's import from the CLI is refused", async () => {
    const page = await http("/api/plan/files-import", { paths: ["roadmap.md", "plans/sso"] });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect((page.body.imported as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["roadmap.md", "plans/sso"]);
    expect(gist(page.body.files as FilesView).filter((file) => file.state === "imported").map((file) => file.path)).toEqual(["plans/sso", "roadmap.md"]);
    expect((page.body.plan as { ideas: unknown[] }).ideas).toHaveLength(2);

    const agent = await cli("idea", "files", "import", "plans/passkeys.md");
    expect(agent.status).not.toBe(0);
    expect(agent.stderr).toContain("is the person's");
    const person = await cli("idea", "files", "import", "plans/passkeys.md", "--person");
    expect(person.status, person.stderr).toBe(0);
    expect(person.stdout).toMatch(/^imported plans\/passkeys\.md as Passkeys \(idea I-[A-Z]+-3\)/);

    const again = await http("/api/plan/files-import", { paths: ["plans/passkeys.md"] });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("already imported");
    const outside = await http("/api/plan/files-import", { paths: ["README.md", "../etc/passwd"] });
    expect(outside.status).toBe(404);
  });

  it("ignores from the tray and lists it again from the CLI, and reads a changed file as changed", async () => {
    const ignored = await http("/api/plan/files-ignore", { path: "plans/done/billing.md" });
    expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
    put("roadmap.md", "# Roadmap\n\nWhere we go next.\n");
    const view = JSON.parse((await cli("idea", "files", "--json")).stdout) as FilesView;
    expect(Object.fromEntries(gist(view).map((file) => [file.path, file.state]))).toEqual({
      "plans/done/billing.md": "ignored",
      "plans/passkeys.md": "imported",
      "plans/sso": "imported",
      "roadmap.md": "changed",
    });
    const unignored = await cli("idea", "files", "unignore", "plans/done/billing.md", "--person");
    expect(unignored.status, unignored.stderr).toBe(0);
    expect(unignored.stdout).toMatch(/^new\s+plans\/done\/billing\.md/);
  });

  it("looks where the person says, set as an ordinary workspace setting", async () => {
    put("docs/specs/inbox.md", "# Inbox\n");
    const set = await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "plan.discoveryPaths", value: ["docs/**"] }] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(gist((await http("/api/plan-files")).body as unknown as FilesView)).toEqual([{ path: "docs/specs/inbox.md", state: "new", idea: null }]);
    const bad = await cli("settings", "set", "plan.discoveryPaths", '["/etc"]');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("absolute");
    expect((await http("/api/settings", { target: "settings", ops: [{ op: "reset", key: "plan.discoveryPaths" }] })).status).toBe(200);
    expect(((await http("/api/plan-files")).body as unknown as FilesView).paths).toEqual(["*.md", "plans/**"]);
  });

  it("is refused on both with planning off", async () => {
    expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: false }] })).status).toBe(200);
    expect((await http("/api/plan-files")).status).toBe(409);
    expect((await cli("idea", "files")).status).not.toBe(0);
    expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: true }] })).status).toBe(200);
    expect(((await http("/api/plan-files")).body as unknown as FilesView).counts).toEqual({ new: 1, changed: 1, imported: 2, ignored: 0 });
  });
});
