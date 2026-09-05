import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import type { ProjectStore } from "../src/core/project-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

/**
 * Projects in the store — the database half of docs/web-ui.md "Projects".
 *
 * The pure rules (name, kind, source) are pinned in `projects.test.ts` and are
 * not re-proved here. What is pinned here is what needs a database: that a slug
 * is unique and stable, that lookup answers to id and slug alike, that an issue
 * points at one project or none, that deleting a project lets its issues go and
 * touches nothing else, and that every write leaves an event.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let projects: ProjectStore;
beforeEach(() => {
  store = memStore();
  projects = store.projects();
});

function refused(fn: () => unknown, code: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function events(kind: string): Array<{ kind: string; issueId: string | null; actor: string | null; payload: Record<string, unknown> }> {
  return store.listEvents(0, 500).filter((event) => event.kind === kind);
}

describe("creating", () => {
  it("stores the four facts, derives a slug, and stamps both times", () => {
    const project = projects.create({ name: "Staple Tracker" }, "vp");
    expect(project).toMatchObject({
      slug: "staple-tracker",
      name: "Staple Tracker",
      kind: "unmanaged",
      sourceKind: null,
      source: null,
    });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.createdAt).toBe(project.updatedAt);
    expect(events("project_created")).toEqual([
      expect.objectContaining({
        actor: "vp",
        issueId: null,
        payload: { project: "staple-tracker", name: "Staple Tracker", kind: "unmanaged", sourceKind: null },
      }),
    ]);
  });

  it("keeps a managed project's source kind and source explicitly", () => {
    const github = projects.create(
      { name: "Tracker", kind: "managed", sourceKind: "github", source: "https://github.com/vpetkovic/staple-tracker" },
      "vp",
    );
    expect(github).toMatchObject({ kind: "managed", sourceKind: "github", source: "https://github.com/vpetkovic/staple-tracker" });
    const local = projects.create({ name: "Notes", kind: "managed", sourceKind: "local", source: "/Users/vp/notes" }, "vp");
    expect(local).toMatchObject({ kind: "managed", sourceKind: "local", source: "/Users/vp/notes" });
  });

  it("refuses with the pure rules' own sentence and writes nothing", () => {
    refused(() => projects.create({ name: "" }, "vp"), "validation");
    refused(() => projects.create({ name: "X", kind: "managed" }, "vp"), "validation");
    expect(projects.list()).toEqual([]);
    expect(events("project_created")).toEqual([]);
  });

  it("numbers a slug that is already taken rather than refusing the name", () => {
    expect(projects.create({ name: "Docs" }, "vp").slug).toBe("docs");
    expect(projects.create({ name: "docs" }, "vp").slug).toBe("docs-2");
    expect(projects.create({ name: "DOCS!" }, "vp").slug).toBe("docs-3");
    // A slug that merely shares the prefix is not in the way.
    expect(projects.create({ name: "docs-site" }, "vp").slug).toBe("docs-site");
    expect(projects.list().map((p) => p.slug)).toEqual(["docs", "docs-2", "docs-3", "docs-site"]);
  });
});

describe("reading", () => {
  it("lists by name, case-insensitively, and answers a lookup by id or by slug", () => {
    const b = projects.create({ name: "beta" }, "vp");
    const a = projects.create({ name: "Alpha" }, "vp");
    expect(projects.list().map((p) => p.name)).toEqual(["Alpha", "beta"]);
    expect(projects.get(a.id)).toEqual(a);
    expect(projects.get(b.slug)).toEqual(b);
    expect(projects.get(" beta ")).toEqual(b);
  });

  it("is not_found for anything else, naming the workspace", () => {
    const error = refused(() => projects.get("nope"), "not_found");
    expect(error.message).toContain("test");
    expect(error.detail).toEqual({ project: "nope" });
    refused(() => projects.get(""), "not_found");
  });
});

describe("updating", () => {
  it("patches what was sent, keeps the slug, and names what changed", () => {
    const created = projects.create({ name: "Docs" }, "vp");
    const renamed = projects.update(created.slug, { name: "Documentation" }, "vp");
    expect(renamed).toMatchObject({ id: created.id, slug: "docs", name: "Documentation", kind: "unmanaged" });
    expect(renamed.updatedAt >= created.updatedAt).toBe(true);
    expect(events("project_updated")).toEqual([
      expect.objectContaining({ actor: "vp", payload: { project: "docs", changed: ["name"] } }),
    ]);
  });

  it("re-validates the merged result, so changing the kind means changing the source too", () => {
    const created = projects.create({ name: "Docs" }, "vp");
    // To managed without a source: refused, and the row stands.
    refused(() => projects.update(created.id, { kind: "managed" }, "vp"), "validation");
    expect(projects.get(created.id)).toEqual(created);
    // To managed with a source: accepted.
    const managed = projects.update(created.id, { kind: "managed", sourceKind: "local", source: "/tmp/docs" }, "vp");
    expect(managed).toMatchObject({ kind: "managed", sourceKind: "local", source: "/tmp/docs" });
    // Back to unmanaged while the source is still there: refused rather than silently dropped…
    refused(() => projects.update(created.id, { kind: "unmanaged" }, "vp"), "validation");
    // …and accepted when the caller clears it in the same call.
    const unmanaged = projects.update(created.id, { kind: "unmanaged", sourceKind: null, source: null }, "vp");
    expect(unmanaged).toMatchObject({ kind: "unmanaged", sourceKind: null, source: null });
    expect(events("project_updated").map((e) => e.payload.changed)).toEqual([
      ["kind", "sourceKind", "source"],
      ["kind", "sourceKind", "source"],
    ]);
  });

  it("is a no-op, with no event, when nothing would change", () => {
    const created = projects.create({ name: "Docs" }, "vp");
    expect(projects.update(created.id, { name: "Docs" }, "vp")).toEqual(created);
    expect(projects.update(created.id, {}, "vp")).toEqual(created);
    expect(events("project_updated")).toEqual([]);
  });
});

describe("issues in projects", () => {
  it("starts every issue in no project, and files one at create time by id or by slug", () => {
    const docs = projects.create({ name: "Docs" }, "vp");
    expect(store.createIssue({ title: "Loose" }).projectId).toBeNull();
    expect(store.createIssue({ title: "By slug", project: "docs" }).projectId).toBe(docs.id);
    expect(store.createIssue({ title: "By id", project: docs.id }).projectId).toBe(docs.id);
    expect(store.createIssue({ title: "Explicit none", project: null }).projectId).toBeNull();
    // Reading it back answers the same thing the create did.
    expect(store.getIssue("TST-2").projectId).toBe(docs.id);
    expect(store.listIssues().map((issue) => issue.projectId)).toEqual([null, docs.id, docs.id, null]);
  });

  it("refuses an unknown project at create time before spending an issue number", () => {
    refused(() => store.createIssue({ title: "Lost", project: "nowhere" }), "not_found");
    expect(store.createIssue({ title: "Next" }).identifier).toBe("TST-1");
  });

  it("assigns and unassigns, recording both ends of the move on the issue", () => {
    const docs = projects.create({ name: "Docs" }, "vp");
    const site = projects.create({ name: "Site" }, "vp");
    const issue = store.createIssue({ title: "Write the guide" });

    expect(projects.assign(issue.identifier, "docs", "vp").projectId).toBe(docs.id);
    expect(projects.assign(issue.identifier, site.id, "vp").projectId).toBe(site.id);
    expect(projects.assign(issue.identifier, null, "vp").projectId).toBeNull();
    // Assigning what it already has is a no-op with no event.
    expect(projects.assign(issue.identifier, null, "vp").projectId).toBeNull();

    expect(events("issue_project_changed").map((e) => [e.issueId, e.payload])).toEqual([
      [issue.id, { identifier: "TST-1", project: "docs", previous: null }],
      [issue.id, { identifier: "TST-1", project: "site", previous: "docs" }],
      [issue.id, { identifier: "TST-1", project: null, previous: "site" }],
    ]);
    // The assignment touched nothing else on the issue.
    const after = store.getIssue(issue.identifier);
    expect({ ...after, projectId: null, updatedAt: issue.updatedAt }).toEqual(issue);
  });

  it("refuses an unknown issue and an unknown project in their owners' words", () => {
    projects.create({ name: "Docs" }, "vp");
    refused(() => projects.assign("TST-99", "docs", "vp"), "not_found");
    const issue = store.createIssue({ title: "Real" });
    const error = refused(() => projects.assign(issue.identifier, "nowhere", "vp"), "not_found");
    expect(error.detail).toEqual({ project: "nowhere" });
    expect(store.getIssue(issue.identifier).projectId).toBeNull();
  });

  it("counts the issues each project holds, and only the projects that hold any", () => {
    const docs = projects.create({ name: "Docs" }, "vp");
    projects.create({ name: "Empty" }, "vp");
    store.createIssue({ title: "A", project: "docs" });
    store.createIssue({ title: "B", project: "docs" });
    store.createIssue({ title: "C" });
    expect([...projects.issueCounts()]).toEqual([[docs.id, 2]]);
  });
});

describe("deleting", () => {
  it("lets every issue go in the same transaction and leaves the issues otherwise untouched", () => {
    const docs = projects.create({ name: "Docs" }, "vp");
    const a = store.createIssue({ title: "A", project: "docs", assignee: "kim" });
    const b = store.createIssue({ title: "B", project: "docs" });
    const loose = store.createIssue({ title: "Loose" });

    expect(projects.remove("docs", "vp")).toEqual({ project: docs, unassigned: 2 });

    refused(() => projects.get("docs"), "not_found");
    expect(projects.list()).toEqual([]);
    for (const issue of [a, b, loose]) {
      const now = store.getIssue(issue.identifier);
      expect(now.projectId).toBeNull();
      expect({ ...now, updatedAt: issue.updatedAt }).toEqual({ ...issue, projectId: null });
    }
    expect(store.listIssues()).toHaveLength(3);
    expect(events("project_deleted")).toEqual([
      expect.objectContaining({ actor: "vp", payload: { project: "docs", unassigned: 2 } }),
    ]);
  });

  it("is not_found for a project that is not there, and writes nothing", () => {
    refused(() => projects.remove("nope", "vp"), "not_found");
    expect(events("project_deleted")).toEqual([]);
  });

  it("deleting an issue leaves its project standing", () => {
    const docs = projects.create({ name: "Docs" }, "vp");
    const issue = store.createIssue({ title: "Gone soon", project: "docs" });
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(issue.id);
    expect(projects.get(docs.id)).toEqual(docs);
    expect([...projects.issueCounts()]).toEqual([]);
  });
});
