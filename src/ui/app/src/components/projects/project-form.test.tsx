/**
 * The project form, rendered to a string — what the dialog puts in the DOM in each
 * mode. The draft's rules are pinned in projectForm.test.ts and not re-proved here;
 * what is pinned is that the form shows the sections the model names, labels its
 * fields, offers delete only on an edit, and starts an edit on the served values.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { Project, ProjectRow } from "@/lib/types";
import { ProjectForm } from "./ProjectDialog";

const noop = () => {};

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "workspace",
    workspaces: [{ slug: "staple", prefix: "STA" }],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
    ws: "",
    setWs: noop,
    issues: { data: [], error: undefined, loading: false, reload: noop },
    filters: emptyFilters(),
    setFilters: noop,
    filterContext: buildFilterContext([]),
    assignee: "",
    setAssignee: noop,
    groupBy: "none",
    setGroupBy: noop,
    sort: DEFAULT_SORT,
    setSort: noop,
    visibleOrder: [],
    publishVisibleOrder: noop,
    selection: null,
    open: noop,
    close: noop,
    version: 1,
    refresh: noop,
    ...over,
  };
}

const inSession = (node: ReactElement, over: Partial<StapleSession> = {}) =>
  renderToStaticMarkup(<SessionContext.Provider value={session(over)}>{node}</SessionContext.Provider>);

const project = (over: Partial<Project> = {}): Project => ({
  id: "p-docs",
  slug: "docs",
  name: "Docs",
  kind: "unmanaged",
  sourceKind: null,
  source: null,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  ...over,
});

describe("creating", () => {
  it("shows the General section, the name and the kind, and no delete", () => {
    const markup = inSession(<ProjectForm mode={{ mode: "create", workspace: "staple" }} onDone={noop} onCancel={noop} />);
    expect(markup).toContain('data-project-form="create"');
    expect(markup).toContain('data-project-section="general"');
    expect(markup).not.toContain('data-project-section="source"');
    expect(markup).toContain('for="project-name"');
    expect(markup).toContain('for="project-kind"');
    expect(markup).not.toContain("data-project-delete");
    // Live from the start: a blank name is refused beside the field on submit, not by
    // greying out the button that would have said so.
    expect(markup).toMatch(/data-project-submit[^>]*>Create project</);
    expect(markup).not.toMatch(/data-project-submit[^>]*disabled/);
  });

  it("asks which workspace only in hub mode with more than one", () => {
    const one = inSession(<ProjectForm mode={{ mode: "create", workspace: "staple" }} onDone={noop} onCancel={noop} />);
    expect(one).not.toContain("data-project-workspace");
    const hub = inSession(
      <ProjectForm mode={{ mode: "create", workspace: "staple" }} onDone={noop} onCancel={noop} />,
      {
        mode: "hub",
        workspaces: [
          { slug: "staple", prefix: "STA" },
          { slug: "pinecone", prefix: "PIN" },
        ],
      },
    );
    expect(hub).toContain("data-project-workspace");
  });
});

describe("editing", () => {
  const row: ProjectRow = { workspace: "staple", project: project() };

  it("starts on the served values and offers delete", () => {
    const markup = inSession(<ProjectForm mode={{ mode: "edit", row }} onDone={noop} onCancel={noop} />);
    expect(markup).toContain('data-project-form="edit"');
    expect(markup).toMatch(/data-project-name[^>]*value="Docs"/);
    expect(markup).toContain("data-project-delete");
    expect(markup).toContain(">Delete project<");
    // Nothing changed yet, so there is nothing to save.
    expect(markup).toMatch(/data-project-submit[^>]*disabled=""[^>]*>Save changes</);
  });

  it("shows the Source section for a managed project, labelled by its source kind", () => {
    const github: ProjectRow = {
      workspace: "staple",
      project: project({ kind: "managed", sourceKind: "github", source: "https://github.com/vpetkovic/staple-tracker" }),
    };
    const markup = inSession(<ProjectForm mode={{ mode: "edit", row: github }} onDone={noop} onCancel={noop} />);
    expect(markup).toContain('data-project-section="source"');
    expect(markup).toContain(">Repository URL</label>");
    expect(markup).toMatch(/data-project-source[^>]*value="https:\/\/github\.com\/vpetkovic\/staple-tracker"/);

    const local: ProjectRow = {
      workspace: "staple",
      project: project({ kind: "managed", sourceKind: "local", source: "/Users/vp/docs" }),
    };
    expect(inSession(<ProjectForm mode={{ mode: "edit", row: local }} onDone={noop} onCancel={noop} />)).toContain(
      ">Folder path</label>",
    );
  });
});
