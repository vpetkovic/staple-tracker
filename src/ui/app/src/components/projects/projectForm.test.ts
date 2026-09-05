import { describe, expect, it } from "vitest";
import type { Project, ProjectRow } from "@/lib/types";
import {
  draftFromProject,
  emptyProjectDraft,
  isProjectDraftDirty,
  isProjectDraftValid,
  projectDraftPayload,
  projectFormCopy,
  projectFormSections,
  validateProjectDraft,
  withKind,
  withName,
  withSource,
  withSourceKind,
  type ProjectDraft,
} from "./projectForm";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p-1",
  slug: "docs",
  name: "Docs",
  kind: "unmanaged",
  sourceKind: null,
  source: null,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  ...over,
});

const managed: ProjectDraft = {
  kind: "managed",
  name: "Tracker",
  sourceKind: "github",
  source: "https://github.com/vpetkovic/staple-tracker",
};

describe("the draft", () => {
  it("starts unmanaged and empty, and reads an edit from the served row", () => {
    expect(emptyProjectDraft()).toEqual({ kind: "unmanaged", name: "" });
    expect(draftFromProject(project())).toEqual({ kind: "unmanaged", name: "Docs" });
    expect(
      draftFromProject(project({ kind: "managed", sourceKind: "local", source: "/Users/vp/docs" })),
    ).toEqual({ kind: "managed", name: "Docs", sourceKind: "local", source: "/Users/vp/docs" });
  });

  it("switches shape with the kind, keeping the name and dropping or seeding the source", () => {
    const toManaged = withKind({ kind: "unmanaged", name: "Docs" }, "managed");
    expect(toManaged).toEqual({ kind: "managed", name: "Docs", sourceKind: "github", source: "" });
    expect(withKind(managed, "unmanaged")).toEqual({ kind: "unmanaged", name: "Tracker" });
    // Same kind is the same draft — no accidental reset of a half-typed source.
    expect(withKind(managed, "managed")).toBe(managed);
  });

  it("edits the source only on a managed draft", () => {
    const plain: ProjectDraft = { kind: "unmanaged", name: "Docs" };
    expect(withSource(plain, "/x")).toBe(plain);
    expect(withSourceKind(plain, "local")).toBe(plain);
    expect(withSourceKind(managed, "local")).toMatchObject({ sourceKind: "local", source: managed.source });
    expect(withSource(managed, "/x")).toMatchObject({ source: "/x" });
    expect(withName(plain, "Guides")).toEqual({ kind: "unmanaged", name: "Guides" });
  });
});

describe("validation", () => {
  it("requires a name", () => {
    expect(validateProjectDraft({ kind: "unmanaged", name: "  " })).toEqual({ name: "A project needs a name." });
    expect(validateProjectDraft({ kind: "unmanaged", name: "x".repeat(121) }).name).toContain("120");
    expect(isProjectDraftValid({ kind: "unmanaged", name: "Docs" })).toBe(true);
  });

  it("requires a source on a managed draft, in the words of its kind", () => {
    expect(validateProjectDraft({ ...managed, source: "" })).toEqual({ source: "Paste the repository URL." });
    expect(validateProjectDraft({ ...managed, sourceKind: "local", source: " " })).toEqual({
      source: "Enter the folder's path.",
    });
  });

  it("checks the GitHub URL shape and accepts any local path", () => {
    expect(validateProjectDraft({ ...managed, source: "github.com/a/b" })).toEqual({
      source: "Must look like https://github.com/owner/repo.",
    });
    expect(validateProjectDraft({ ...managed, source: "https://github.com/a/b.git" })).toEqual({});
    expect(validateProjectDraft({ ...managed, sourceKind: "local", source: "not a real path" })).toEqual({});
  });

  it("reports both fields at once", () => {
    expect(Object.keys(validateProjectDraft({ ...managed, name: "", source: "" })).sort()).toEqual(["name", "source"]);
  });
});

describe("the payload", () => {
  it("sends every field, with explicit nulls for an unmanaged project", () => {
    expect(projectDraftPayload({ kind: "unmanaged", name: " Docs " })).toEqual({
      name: "Docs",
      kind: "unmanaged",
      sourceKind: null,
      source: null,
    });
    expect(projectDraftPayload({ ...managed, source: ` ${managed.source} ` })).toEqual({
      name: "Tracker",
      kind: "managed",
      sourceKind: "github",
      source: managed.source,
    });
  });

  it("is dirty exactly when the payload would change", () => {
    const base = draftFromProject(project());
    expect(isProjectDraftDirty(base, base)).toBe(false);
    expect(isProjectDraftDirty(withName(base, " Docs "), base)).toBe(false);
    expect(isProjectDraftDirty(withName(base, "Guides"), base)).toBe(true);
    expect(isProjectDraftDirty(withKind(base, "managed"), base)).toBe(true);
  });
});

describe("the dialog's shape", () => {
  it("shows the Source section only for a managed draft", () => {
    expect(projectFormSections({ kind: "unmanaged", name: "" }).map((s) => s.id)).toEqual(["general"]);
    expect(projectFormSections(managed).map((s) => s.id)).toEqual(["general", "source"]);
  });

  it("titles itself by mode", () => {
    expect(projectFormCopy({ mode: "create", workspace: "staple" })).toMatchObject({
      title: "New project",
      submit: "Create project",
    });
    const row: ProjectRow = { workspace: "staple", project: project() };
    expect(projectFormCopy({ mode: "edit", row })).toMatchObject({ title: "Docs", submit: "Save changes" });
    expect(projectFormCopy({ mode: "edit", row }).description).toContain("docs in staple");
  });
});
