/**
 * Plan files in the workspace (design/plan.md, "Ideas from files"): discovery finds plans in the
 * root's Markdown and under plans/ (in any case) and the person's own paths, leaves repository
 * documents, templates, assets and handoffs out, reads a done status, and takes a folder with
 * assets as one plan. The tray says what each is (new, imported, changed since import, ignored)
 * by path and content hash; the person imports one or many, or ignores one; nothing imports on
 * its own. The same on a device that received the marks by sync and on a freshly hydrated one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { discoverPlanFiles, doneStatus, planHashOf, planStatus, workspaceRootOf } from "../src/core/plan-discovery.js";
import { discoveryPathsProblem, ignoredFileKey, isIgnoredPlanFile } from "../src/core/plan-discovery-paths.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const PERSON = { person: { via: "plan_view" } } as const;
const REPO = "5eed0000-0000-4000-8000-000000000591";

let root: string;

function put(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

/** A repository laid out like the ones plans live in, noise included. */
function layout(): void {
  put("roadmap.md", "# Roadmap\n\nWhere we go.\n");
  put("README.md", "# The project\n");
  put("AGENTS.md", "# Agents\n");
  put("CLAUDE.md", "# Claude\n");
  put("CHANGELOG.md", "# Changes\n");
  put("CONTRIBUTING.md", "# Contributing\n");
  put("notes.html", "<title>Root HTML</title>");
  put("Plans/active/passkeys.md", "---\nstatus: active\n---\n# Passkeys\n\nSign in without a password.\n");
  put("Plans/active/_template.md", "# Template\n");
  put("Plans/_drafts/half.md", "# Half\n");
  put("Plans/done/old-auth.md", "# Old auth\n");
  put("Plans/research/chat.html", "<html><head><title>Chat export</title></head></html>");
  put("Plans/research/mock.jsx", "export const Mock = () => <div/>;\n");
  put("Plans/research/sso/sso.md", "# Single sign-on\n\n**Status:** Implemented\n");
  put("Plans/research/sso/notes.md", "# Notes\n");
  put("Plans/research/sso/assets/flow.jsx", "export const Flow = () => null;\n");
  put("Plans/research/sso/assets/screen.html", "<p>screen</p>");
  put("Plans/assets/shared.md", "# Shared asset\n");
  put("Plans/Handoffs/2026-11-01.md", "# Handoff\n");
  put("Plans/handoff-2026-11-02.md", "# Handoff\n");
  put("Plans/.hidden/secret.md", "# Hidden\n");
  put("Plans/node_modules/pkg/readme.md", "# Pkg\n");
  put("Plans/README.md", "# How plans work\n");
  put("Plans/diagram.png", "png");
  put("docs/superpowers/plans/2026-11-20-inbox.md", "# Inbox\n\n**Status:** Done\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "staple-plan-files-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("finding plan files", () => {
  it("looks at the root's Markdown and everything under plans/ in any case, and leaves repository documents, templates, assets and handoffs out", () => {
    layout();
    const found = discoverPlanFiles(root, ["*.md", "plans/**"]);
    expect(found.truncated).toBe(false);
    expect(found.plans.map((plan) => plan.path)).toEqual([
      "Plans/active/passkeys.md",
      "Plans/done/old-auth.md",
      "Plans/research/chat.html",
      "Plans/research/mock.jsx",
      "Plans/research/sso",
      "roadmap.md",
    ]);
    expect(found.plans.find((plan) => plan.path === "Plans/research/chat.html")).toMatchObject({ kind: "file", format: "html", title: "Chat export" });
    expect(found.plans.find((plan) => plan.path === "Plans/research/mock.jsx")).toMatchObject({ format: "jsx", title: "mock" });
  });

  it("reads the person's own paths: a glob, a folder and one file", () => {
    layout();
    expect(discoverPlanFiles(root, ["docs/superpowers/plans/**"]).plans.map((plan) => plan.path)).toEqual(["docs/superpowers/plans/2026-11-20-inbox.md"]);
    expect(discoverPlanFiles(root, ["DOCS/superpowers"]).plans.map((plan) => plan.path)).toEqual(["docs/superpowers/plans/2026-11-20-inbox.md"]);
    expect(discoverPlanFiles(root, ["./Plans/active/passkeys.md"]).plans.map((plan) => plan.path)).toEqual(["Plans/active/passkeys.md"]);
    expect(discoverPlanFiles(root, ["plans/*/*.md"]).plans.map((plan) => plan.path)).toEqual(["Plans/active/passkeys.md", "Plans/done/old-auth.md"]);
    expect(discoverPlanFiles(root, []).plans).toEqual([]);
  });

  it("reads a done, completed or implemented status from front matter, a Status line or a done folder", () => {
    layout();
    const plans = new Map(discoverPlanFiles(root, ["*.md", "plans/**", "docs/**"]).plans.map((plan) => [plan.path, plan]));
    expect(plans.get("Plans/active/passkeys.md")).toMatchObject({ status: "active", done: false });
    expect(plans.get("Plans/done/old-auth.md")).toMatchObject({ status: null, done: true });
    expect(plans.get("Plans/research/sso")).toMatchObject({ status: "Implemented", done: true });
    expect(plans.get("docs/superpowers/plans/2026-11-20-inbox.md")).toMatchObject({ status: "Done", done: true });
    expect(planStatus("---\ntitle: x\nstatus: \"completed\"\n---\n# X\n")).toBe("completed");
    expect(planStatus("# X\n\n> **Status**: ✅ Done (2026-10-01)\n")).toBe("✅ Done (2026-10-01)");
    expect(planStatus("# X\n\n| Field | Value |\n|---|---|\n| Status | Implemented |\n")).toBe("Implemented");
    expect(planStatus("# X\n\nNo status here.\n")).toBeNull();
    expect(["Done", "✅ Completed", "implemented in v2", "In progress (implemented phase 1)", "Draft", "not done"].map(doneStatus)).toEqual([true, true, true, false, false, false]);
  });

  it("takes a folder with assets as one plan, its main file first and every file in it attached", () => {
    layout();
    const sso = discoverPlanFiles(root, ["plans/**"]).plans.find((plan) => plan.path === "Plans/research/sso")!;
    expect(sso).toMatchObject({ kind: "folder", main: "Plans/research/sso/sso.md", title: "Single sign-on", problem: null });
    expect(sso.files).toEqual(["Plans/research/sso/sso.md", "Plans/research/sso/assets/flow.jsx", "Plans/research/sso/assets/screen.html", "Plans/research/sso/notes.md"]);
    // plans/ itself holds an assets folder: that does not make every plan one.
    expect(discoverPlanFiles(root, ["plans/**"]).plans.length).toBeGreaterThan(1);
  });

  it("titles a folder plan for the folder when its main file has no heading, and picks plan, index or readme as its main file", () => {
    put("plans/billing/README.md", "Notes without a heading.\n");
    put("plans/billing/zeta.md", "# Zeta\n");
    put("plans/billing/assets/a.html", "<p/>");
    const billing = discoverPlanFiles(root, ["plans/**"]).plans[0]!;
    expect(billing).toMatchObject({ path: "plans/billing", main: "plans/billing/README.md", title: "billing" });
  });

  it("lists plans that share an assets folder one by one, since no file there is the folder's own", () => {
    put("plans/active/one.md", "# One\n");
    put("plans/active/two.md", "# Two\n");
    put("plans/active/assets/shared.jsx", "export {};\n");
    put("plans/solo/only.md", "# Only\n");
    put("plans/solo/assets/a.html", "<p/>");
    expect(discoverPlanFiles(root, ["plans/**"]).plans.map((plan) => [plan.path, plan.kind])).toEqual([
      ["plans/active/one.md", "file"],
      ["plans/active/two.md", "file"],
      ["plans/solo", "folder"],
    ]);
  });

  it("reads a status written as a heading", () => {
    expect(planStatus("# X\n\n## Status\n\nDone, shipped in 2.1\n\n## Goal\n")).toBe("Done, shipped in 2.1");
    expect(planStatus("# X\n\n## Status\n\n## Goal\n")).toBeNull();
  });

  it("hashes what it reads the way an import checks it", () => {
    layout();
    const sso = discoverPlanFiles(root, ["plans/**"]).plans.find((plan) => plan.path === "Plans/research/sso")!;
    const contents = new Map(sso.files.map((file) => [file, new Uint8Array(readFileSync(join(root, file)))]));
    expect(planHashOf(sso, contents)).toBe(sso.hash);
    const one = discoverPlanFiles(root, ["*.md"]).plans[0]!;
    expect(planHashOf(one, new Map([[one.main, new Uint8Array(readFileSync(join(root, one.main)))]]))).toBe(one.hash);
  });

  it("hashes a file by its bytes and a folder by every file in it", () => {
    layout();
    const hashOf = (path: string) => discoverPlanFiles(root, ["*.md", "plans/**"]).plans.find((plan) => plan.path === path)!.hash;
    const file = hashOf("roadmap.md");
    const folder = hashOf("Plans/research/sso");
    expect(file).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashOf("roadmap.md")).toBe(file);
    put("Plans/research/sso/assets/flow.jsx", "export const Flow = () => 1;\n");
    expect(hashOf("Plans/research/sso")).not.toBe(folder);
    expect(hashOf("roadmap.md")).toBe(file);
  });

  it("stays bounded: a cap on plans, entries and depth says it was cut short, and links are never followed", () => {
    for (let n = 0; n < 5; n += 1) put(`plans/p${n}.md`, `# P${n}\n`);
    put("plans/a/b/c/d/deep.md", "# Deep\n");
    const outside = mkdtempSync(join(tmpdir(), "staple-plan-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# Secret\n");
      symlinkSync(outside, join(root, "plans", "linked"));
      symlinkSync(join(outside, "secret.md"), join(root, "plans", "secret.md"));
      const all = discoverPlanFiles(root, ["plans/**"]);
      expect(all.plans.map((plan) => plan.path)).not.toContain("plans/secret.md");
      expect(all.plans.some((plan) => plan.path.startsWith("plans/linked"))).toBe(false);
      const capped = discoverPlanFiles(root, ["plans/**"], { depth: 8, entries: 4000, plans: 2, folderFiles: 50 });
      expect(capped.truncated).toBe(true);
      expect(capped.plans).toHaveLength(2);
      expect(all).toMatchObject({ truncated: false, plans: { length: 6 } });
      expect(discoverPlanFiles(root, ["plans/**"], { depth: 2, entries: 4000, plans: 500, folderFiles: 50 }).truncated).toBe(true);
      expect(discoverPlanFiles(root, ["plans/**"], { depth: 8, entries: 3, plans: 500, folderFiles: 50 }).truncated).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("names a plan that cannot be imported as it stands, and a folder with too many files", () => {
    put("plans/empty.md", "  \n");
    put("plans/binary.md", "\u0000");
    writeFileSync(join(root, "plans", "binary.md"), Buffer.from([0xff, 0xfe, 0x00]));
    put("plans/big/big.md", "# Big\n");
    for (let n = 0; n < 4; n += 1) put(`plans/big/assets/${n}.html`, "<p/>");
    const plans = new Map(discoverPlanFiles(root, ["plans/**"], { depth: 8, entries: 4000, plans: 500, folderFiles: 3 }).plans.map((plan) => [plan.path, plan.problem]));
    expect(plans.get("plans/empty.md")).toContain("empty");
    expect(plans.get("plans/binary.md")).toContain("not UTF-8");
    expect(plans.get("plans/big")).toBe("holds more than 3 files");
  });

  it("finds the root of a repository workspace from its database, and none for a global one", () => {
    expect(workspaceRootOf("/repo/.staple/staple.db")).toBe("/repo");
    expect(workspaceRootOf("/repo/.tasks/tasks.db")).toBe("/repo");
    expect(workspaceRootOf("/home/me/.staple/workspaces/notes.db")).toBeNull();
  });

  it("validates the synchronized paths as repo-relative, and keys each ignore by its path", () => {
    expect(discoveryPathsProblem(["*.md", "plans/**", "docs/superpowers/plans/**"])).toBeNull();
    expect(discoveryPathsProblem("plans/**")).toContain("JSON list");
    expect(discoveryPathsProblem(["/etc"])).toContain("absolute");
    expect(discoveryPathsProblem(["C:/plans"])).toContain("absolute");
    expect(discoveryPathsProblem(["../other"])).toContain("leaves the workspace root");
    expect(discoveryPathsProblem(["plans\\x"])).toContain("backslash");
    expect(discoveryPathsProblem([""])).toContain("empty");
    expect(isIgnoredPlanFile({ path: "plans/a.md", hash: `sha256:${"a".repeat(64)}` })).toBe(true);
    expect(isIgnoredPlanFile({ path: "plans/a.md", hash: "abc" })).toBe(false);
    expect(isIgnoredPlanFile({ path: "../a.md", hash: `sha256:${"a".repeat(64)}` })).toBe(false);
    const hash = `sha256:${"a".repeat(64)}`;
    expect(ignoredFileKey({ path: "./plans/a.md/", hash })).toBe(ignoredFileKey({ path: "plans/a.md", hash }));
    expect(ignoredFileKey({ path: "plans/a.md", hash })).toMatch(/^plan\.ignoredFile:[0-9a-f]{32}$/);
    expect(ignoredFileKey({ path: "plans/b.md", hash })).not.toBe(ignoredFileKey({ path: "plans/a.md", hash }));
    // The same path with other content is another ignore: two checkouts never write one entity two ways.
    expect(ignoredFileKey({ path: "plans/a.md", hash: `sha256:${"b".repeat(64)}` })).not.toBe(ignoredFileKey({ path: "plans/a.md", hash }));
  });
});

describe("the Plan files tray", () => {
  let store: WorkspaceStore;
  let plan: PlanStore;
  beforeEach(() => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "test", "TST");
    plan = store.plan();
    plan.enable("vp", { person: { via: "settings" } });
    layout();
  });

  const ideaCount = () => (store.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE plan_maturity IS NOT NULL").get() as { n: number }).n;
  const states = () => Object.fromEntries(plan.discoverFiles(root).files.map((file) => [file.path, file.state]));

  it("lists every plan as new, and imports nothing on its own", () => {
    const before = ideaCount();
    const view = plan.discoverFiles(root);
    expect(view).toMatchObject({ paths: ["*.md", "plans/**"], truncated: false, unavailable: null, counts: { new: 6, imported: 0, changed: 0, ignored: 0 } });
    plan.discoverFiles(root);
    expect(ideaCount()).toBe(before);
    expect(plan.discoverFiles(null)).toMatchObject({ files: [], unavailable: expect.stringContaining("not inside a repository") });
  });

  it("imports one file as an idea, with its original under Files, and then reads it imported", () => {
    const { imported } = plan.importDiscovered(root, ["Plans/active/passkeys.md"], {}, "VP", PERSON);
    expect(imported).toEqual([{ path: "Plans/active/passkeys.md", idea: { id: expect.any(String), number: "I-TST-1", identifier: null, title: "Passkeys" } }]);
    const id = imported[0]!.idea.id;
    expect(store.listFiles(id)).toMatchObject([{ filename: "passkeys.md", caption: "The file this idea was imported from: Plans/active/passkeys.md" }]);
    expect(plan.detail(id).plan.sources).toEqual(["Plans/active/passkeys.md (attached)"]);
    expect(plan.ideaView(id).nextStep?.need).toBe("classify");
    expect(states()["Plans/active/passkeys.md"]).toBe("imported");
    expect(plan.discoverFiles(root).files.find((file) => file.path === "Plans/active/passkeys.md")!.idea).toEqual(imported[0]!.idea);
    expect(refused(() => plan.importDiscovered(root, ["Plans/active/passkeys.md"], {}, "VP", PERSON)).message).toContain("already imported, as I-TST-1");
  });

  it("imports several at once, a folder with assets as one idea with all its files, all or none", () => {
    const before = ideaCount();
    expect(refused(() => plan.importDiscovered(root, ["roadmap.md", "README.md"], {}, "VP", PERSON)).code).toBe("not_found");
    expect(refused(() => plan.importDiscovered(root, ["roadmap.md", "../secret.md"], {}, "VP", PERSON)).code).toBe("not_found");
    expect(ideaCount()).toBe(before);
    const { imported } = plan.importDiscovered(root, ["roadmap.md", "Plans/research/sso", "roadmap.md"], { maturity: "exploring" }, "VP", PERSON);
    expect(imported.map((entry) => [entry.path, entry.idea.title])).toEqual([["roadmap.md", "Roadmap"], ["Plans/research/sso", "Single sign-on"]]);
    expect(ideaCount()).toBe(before + 2);
    const sso = imported[1]!.idea.id;
    expect(store.listFiles(sso).map((file) => [file.filename, file.caption]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
      ["flow.jsx", "Imported with the plan: Plans/research/sso/assets/flow.jsx"],
      ["screen.html", "Imported with the plan: Plans/research/sso/assets/screen.html"],
      ["notes.md", "Imported with the plan: Plans/research/sso/notes.md"],
      ["sso.md", "The file this idea was imported from: Plans/research/sso/sso.md"],
    ]);
    expect(plan.ideaView(sso)).toMatchObject({ maturity: "exploring" });
    expect(states()).toMatchObject({ "roadmap.md": "imported", "Plans/research/sso": "imported", "Plans/active/passkeys.md": "new" });
  });

  it("reads a file changed since its import as changed, and its content at another path as imported", () => {
    plan.importDiscovered(root, ["roadmap.md", "Plans/active/passkeys.md"], {}, "VP", PERSON);
    put("roadmap.md", "# Roadmap\n\nWhere we go, now with more.\n");
    put("Plans/archive/passkeys-copy.md", "---\nstatus: active\n---\n# Passkeys\n\nSign in without a password.\n");
    expect(states()).toMatchObject({ "roadmap.md": "changed", "Plans/archive/passkeys-copy.md": "imported" });
    expect(plan.discoverFiles(root).counts).toMatchObject({ changed: 1, imported: 2 });
    // A changed file can be imported again, as a new idea; the latest import is the one it reads as.
    const again = plan.importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON).imported[0]!;
    expect(states()["roadmap.md"]).toBe("imported");
    expect(plan.discoverFiles(root).files.find((file) => file.path === "roadmap.md")!.idea?.id).toBe(again.idea.id);
  });

  it("ignores a file by path and content hash, stops ignoring it, and an import ends its ignore", () => {
    plan.ignoreDiscovered(root, "Plans/research/chat.html", true, "VP", PERSON);
    expect(store.ignoredPlanFiles()).toEqual([{ path: "Plans/research/chat.html", hash: expect.stringMatching(/^sha256:/) }]);
    // Not a registered setting, and not reported as an unknown one.
    expect(new WorkspaceStore(store.db, "test", "TST").unknownSettingKeys()).toEqual([]);
    expect(states()["Plans/research/chat.html"]).toBe("ignored");
    // Its content at another path is ignored too; a change at its path stays ignored.
    put("Plans/archive/chat.html", "<html><head><title>Chat export</title></head></html>");
    expect(states()["Plans/archive/chat.html"]).toBe("ignored");
    put("Plans/research/chat.html", "<html><head><title>Chat export, longer</title></head></html>");
    expect(states()["Plans/research/chat.html"]).toBe("ignored");
    // Ending the ignore ends it for its content elsewhere too: it was one ignore.
    plan.ignoreDiscovered(root, "Plans/research/chat.html", false, "VP", PERSON);
    expect(states()).toMatchObject({ "Plans/research/chat.html": "new", "Plans/archive/chat.html": "new" });
    plan.ignoreDiscovered(root, "Plans/archive/chat.html", true, "VP", PERSON);
    expect(states()).toMatchObject({ "Plans/research/chat.html": "new", "Plans/archive/chat.html": "ignored" });
    plan.importDiscovered(root, ["Plans/archive/chat.html"], {}, "VP", PERSON);
    expect(store.ignoredPlanFiles()).toEqual([]);
    expect(states()["Plans/archive/chat.html"]).toBe("imported");
    // An ignore whose file is gone is ended by its path.
    plan.ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
    rmSync(join(root, "roadmap.md"));
    plan.ignoreDiscovered(root, "roadmap.md", false, "VP", PERSON);
    expect(store.ignoredPlanFiles()).toEqual([]);
    expect(refused(() => plan.ignoreDiscovered(root, "README.md", true, "VP", PERSON)).code).toBe("not_found");
  });

  it("imports by a path in any case when only one listed file matches it", () => {
    const { imported } = plan.importDiscovered(root, ["plans/ACTIVE/Passkeys.MD"], {}, "VP", PERSON);
    expect(imported.map((entry) => entry.path)).toEqual(["Plans/active/passkeys.md"]);
    plan.ignoreDiscovered(root, "ROADMAP.md", true, "VP", PERSON);
    expect(states()["roadmap.md"]).toBe("ignored");
  });

  it("says an ignored file changed since its import, and an ignore of content imported elsewhere is spent", () => {
    plan.importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
    put("roadmap.md", "# Roadmap v2\n");
    plan.ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
    const roadmap = plan.discoverFiles(root).files.find((file) => file.path === "roadmap.md")!;
    expect(roadmap).toMatchObject({ state: "ignored", changedSinceImport: true, idea: { number: "I-TST-1" } });
    // An ignore whose content an idea came from (another device imported it) no longer holds.
    const mock = plan.discoverFiles(root).files.find((file) => file.path === "Plans/research/mock.jsx")!;
    store.setIgnoredPlanFile({ path: mock.path, hash: mock.hash }, true, "VP");
    expect(states()[mock.path]).toBe("ignored");
    store.setIgnoredPlanFile({ path: "elsewhere/mock.jsx", hash: mock.hash }, true, "VP");
    plan.importDiscovered(root, [mock.path], {}, "VP", PERSON);
    put("Plans/research/mock.jsx", "export const Mock = () => <p/>;\n");
    expect(states()[mock.path]).toBe("changed");
  });

  it("an unchanged import outranks an ignore, and an ignore outranks a change", () => {
    plan.importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
    store.setIgnoredPlanFile({ path: "roadmap.md", hash: `sha256:${"0".repeat(64)}` }, true, "VP");
    expect(states()["roadmap.md"]).toBe("imported");
    put("roadmap.md", "# Roadmap v2\n");
    expect(states()["roadmap.md"]).toBe("ignored");
  });

  it("is the person's: an agent's import or ignore is refused, writing nothing", () => {
    const before = ideaCount();
    expect(refused(() => plan.importDiscovered(root, ["roadmap.md"], {}, "agent")).message).toContain("is the person's");
    expect(refused(() => plan.ignoreDiscovered(root, "roadmap.md", true, "agent")).message).toContain("is the person's");
    expect(ideaCount()).toBe(before);
    expect(store.ignoredPlanFiles()).toEqual([]);
  });

  it("looks where the plan.discoveryPaths setting says", () => {
    store.setSetting("plan.discoveryPaths", ["docs/**"], "VP");
    expect(plan.discoverFiles(root).files.map((file) => file.path)).toEqual(["docs/superpowers/plans/2026-11-20-inbox.md"]);
    expect(refused(() => store.setSetting("plan.discoveryPaths", ["../x"], "VP")).code).toBe("validation");
  });

  it("is refused with planning off, and keeps its marks for when it is on again", () => {
    plan.importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
    plan.ignoreDiscovered(root, "Plans/research/mock.jsx", true, "VP", PERSON);
    store.setSetting("features.planning", false, "vp", PERSON.person);
    expect(refused(() => plan.discoverFiles(root)).code).toBe("validation");
    expect(refused(() => plan.importDiscovered(root, ["Plans/active/passkeys.md"], {}, "VP", PERSON)).code).toBe("validation");
    plan.enable("vp", PERSON);
    expect(states()).toMatchObject({ "roadmap.md": "imported", "Plans/research/mock.jsx": "ignored" });
  });

  it("refuses a raw write of where an idea was imported from", () => {
    const id = plan.importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON).imported[0]!.idea.id;
    expect(refused(() => plan.assertDocumentWrite(id, "import-source", "{}")).message).toContain("importing a plan file");
  });
});

describe("plan file marks over sync", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });
  const conflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT field FROM sync_conflicts WHERE resolved_at IS NULL").all();
  const tray = (machine: Machine) => {
    machine.use();
    return machine.store.plan().discoverFiles(root).files.map((file) => ({ path: file.path, state: file.state, idea: file.idea?.number ?? null }));
  };

  async function both(a: Machine, b: Machine, rounds = 2): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      for (const machine of [a, b]) {
        machine.use();
        await machine.sync();
      }
    }
  }

  async function pair(fold: "service" | "tail"): Promise<{ a: Machine; b: Machine }> {
    layout();
    const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    return { a, b };
  }

  for (const fold of ["service", "tail"] as const) {
    it(`reads the same imported, ignored and paths on the device that wrote them, one that received them and a fresh one (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().importDiscovered(root, ["roadmap.md", "Plans/research/sso"], {}, "VP", PERSON);
      a.store.plan().ignoreDiscovered(root, "Plans/research/mock.jsx", true, "VP", PERSON);
      a.store.setSetting("plan.discoveryPaths", ["*.md", "plans/**", "docs/**"], "VP");
      await both(a, b);
      const seen = tray(a);
      expect(seen.filter((file) => file.state !== "new")).toEqual([
        { path: "Plans/research/mock.jsx", state: "ignored", idea: null },
        { path: "Plans/research/sso", state: "imported", idea: expect.stringMatching(/^I-/) },
        { path: "roadmap.md", state: "imported", idea: expect.stringMatching(/^I-/) },
      ]);
      expect(seen.map((file) => file.path)).toContain("docs/superpowers/plans/2026-11-20-inbox.md");
      expect(tray(b)).toEqual(seen);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(tray(fresh)).toEqual(seen);
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });

    it(`two devices ignoring one path while their checkouts differ both land, with no conflict (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
      put("roadmap.md", "# Roadmap on another branch\n");
      b.use();
      b.store.plan().ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
      await both(a, b);
      expect(a.store.ignoredPlanFiles()).toHaveLength(2);
      expect(b.store.ignoredPlanFiles()).toEqual(a.store.ignoredPlanFiles());
      expect(tray(a).find((file) => file.path === "roadmap.md")!.state).toBe("ignored");
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });

    it(`an ignore on one device and an import of the same file on another read the same everywhere, and a later change reads changed (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().ignoreDiscovered(root, "Plans/active/passkeys.md", true, "VP", PERSON);
      b.use();
      b.store.plan().importDiscovered(root, ["Plans/active/passkeys.md"], {}, "VP", PERSON);
      await both(a, b);
      expect(tray(a).find((file) => file.path === "Plans/active/passkeys.md")!.state).toBe("imported");
      put("Plans/active/passkeys.md", "# Passkeys, revised\n");
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      for (const machine of [a, b, fresh]) expect(tray(machine).find((file) => file.path === "Plans/active/passkeys.md")!.state).toBe("changed");
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });

    it(`one file imported on two devices offline names the other idea, with no conflict (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
      b.use();
      b.store.plan().importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
      await both(a, b);
      for (const machine of [a, b]) {
        machine.use();
        const roadmap = machine.store.plan().discoverFiles(root).files.find((file) => file.path === "roadmap.md")!;
        expect(roadmap.state).toBe("imported");
        expect(roadmap.alsoImportedAs).toHaveLength(1);
        expect(roadmap.alsoImportedAs[0]!.id).not.toBe(roadmap.idea!.id);
      }
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });

    it(`two devices importing different files offline converge on both, with no conflict (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().importDiscovered(root, ["roadmap.md"], {}, "VP", PERSON);
      b.use();
      b.store.plan().importDiscovered(root, ["Plans/active/passkeys.md"], {}, "VP", PERSON);
      await both(a, b);
      const seen = tray(a);
      expect(seen.filter((file) => file.state === "imported").map((file) => file.path)).toEqual(["Plans/active/passkeys.md", "roadmap.md"]);
      expect(tray(b)).toEqual(seen);
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });

    it(`two devices ignoring different files offline both land, and an ignore ended on one ends on the other, with no conflict (${fold} fold)`, async () => {
      const { a, b } = await pair(fold);
      a.use();
      a.store.plan().ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
      b.use();
      b.store.plan().ignoreDiscovered(root, "Plans/research/mock.jsx", true, "VP", PERSON);
      await both(a, b);
      const ignored = (machine: Machine) => tray(machine).filter((file) => file.state === "ignored").map((file) => file.path);
      expect(ignored(a)).toEqual(["Plans/research/mock.jsx", "roadmap.md"]);
      expect(ignored(b)).toEqual(ignored(a));
      b.use();
      b.store.plan().ignoreDiscovered(root, "roadmap.md", false, "VP", PERSON);
      await both(a, b);
      expect(ignored(a)).toEqual(["Plans/research/mock.jsx"]);
      expect(ignored(b)).toEqual(ignored(a));
      // Ignored again after the end: the create lifts the tombstone everywhere.
      a.use();
      a.store.plan().ignoreDiscovered(root, "roadmap.md", true, "VP", PERSON);
      await both(a, b);
      expect(ignored(b)).toEqual(["Plans/research/mock.jsx", "roadmap.md"]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(ignored(fresh)).toEqual(ignored(a));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });
  }
});
