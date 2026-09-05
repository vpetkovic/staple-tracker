/**
 * The project dialog's state -> what `/api/project/create` and `/update` take. Pure and
 * DOM-free, like `createIssueForm.ts` and `settings/form/*`, and tested next door.
 *
 * ── A DISCRIMINATED UNION ON KIND ─────────────────────────────────────────────────────
 *
 * An unmanaged draft has a name and nothing else; a managed one also has a source kind
 * and a source. Modelling that as one flat record with optional fields would let a
 * draft say "unmanaged, source /tmp/x", which the store refuses — and the form would
 * have to remember to blank the fields it hid. The union cannot express the bad state,
 * and `withKind` is the one place a switch between the two shapes happens.
 *
 * ── WHAT IS VALIDATED, AND WHY THE STORE STILL DECIDES ────────────────────────────────
 *
 * `validateProjectDraft` mirrors `src/core/projects.ts` closely enough to stop a submit
 * the store would refuse — a blank name, a GitHub URL that is not one, an empty path —
 * and says so beside the field before the round trip. The store refuses independently
 * and its sentence is the one a refusal renders; nothing here paraphrases it.
 *
 * ── SECTIONS ──────────────────────────────────────────────────────────────────────────
 *
 * The dialog is the foundation for a project's settings, and the next ones ("initiate a
 * tracker here", "repoint it") are sections that do not exist yet. `projectFormSections`
 * is the list the dialog renders, so a new section is an entry here and a component,
 * not a rearrangement of the form.
 */
import type { ProjectFieldsInput } from "@/lib/api";
import type { Project, ProjectKind, ProjectRow, ProjectSourceKind } from "@/lib/types";

export type ProjectDraft =
  | { kind: "unmanaged"; name: string }
  | { kind: "managed"; name: string; sourceKind: ProjectSourceKind; source: string };

/** Create, or edit one row — and in hub mode, which workspace a create lands in. */
export type ProjectFormMode = { mode: "create"; workspace: string } | { mode: "edit"; row: ProjectRow };

export const KIND_LABELS: Record<ProjectKind, string> = {
  unmanaged: "Unmanaged",
  managed: "Managed",
};

export const KIND_HINTS: Record<ProjectKind, string> = {
  unmanaged: "A name to file work under. No repository.",
  managed: "Points at a repository: a GitHub link or a folder on this machine.",
};

export const SOURCE_KIND_LABELS: Record<ProjectSourceKind, string> = {
  github: "GitHub",
  local: "Local folder",
};

export const SOURCE_PLACEHOLDERS: Record<ProjectSourceKind, string> = {
  github: "https://github.com/owner/repo",
  local: "/path/to/the/folder",
};

/** Mirrors `GITHUB_REPO_URL` in src/core/projects.ts. */
export const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

export const PROJECT_NAME_MAX = 120;

export function emptyProjectDraft(): ProjectDraft {
  return { kind: "unmanaged", name: "" };
}

/** The draft an edit starts from: the row as it is served. */
export function draftFromProject(project: Project): ProjectDraft {
  if (project.kind === "managed" && project.sourceKind) {
    return { kind: "managed", name: project.name, sourceKind: project.sourceKind, source: project.source ?? "" };
  }
  return { kind: "unmanaged", name: project.name };
}

/**
 * Switch the shape, keeping the name. To managed: GitHub by default, source empty — the
 * two fields appear and the user fills them. To unmanaged: the source is dropped, which
 * is exactly the clearing the store requires in the same call.
 */
export function withKind(draft: ProjectDraft, kind: ProjectKind): ProjectDraft {
  if (kind === draft.kind) return draft;
  if (kind === "managed") return { kind, name: draft.name, sourceKind: "github", source: "" };
  return { kind, name: draft.name };
}

export function withName(draft: ProjectDraft, name: string): ProjectDraft {
  return { ...draft, name };
}

/** Only meaningful on a managed draft; an unmanaged one is returned untouched. */
export function withSourceKind(draft: ProjectDraft, sourceKind: ProjectSourceKind): ProjectDraft {
  if (draft.kind !== "managed") return draft;
  return { ...draft, sourceKind };
}

export function withSource(draft: ProjectDraft, source: string): ProjectDraft {
  if (draft.kind !== "managed") return draft;
  return { ...draft, source };
}

export interface ProjectDraftErrors {
  name?: string;
  source?: string;
}

/** The field-level sentences a form can say before the round trip. Empty means submittable. */
export function validateProjectDraft(draft: ProjectDraft): ProjectDraftErrors {
  const errors: ProjectDraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "A project needs a name.";
  else if (name.length > PROJECT_NAME_MAX) errors.name = `At most ${PROJECT_NAME_MAX} characters.`;
  if (draft.kind === "managed") {
    const source = draft.source.trim();
    if (!source) {
      errors.source =
        draft.sourceKind === "github" ? "Paste the repository URL." : "Enter the folder's path.";
    } else if (draft.sourceKind === "github" && !GITHUB_REPO_URL.test(source)) {
      errors.source = "Must look like https://github.com/owner/repo.";
    }
  }
  return errors;
}

export function isProjectDraftValid(draft: ProjectDraft): boolean {
  return Object.keys(validateProjectDraft(draft)).length === 0;
}

/**
 * What the route takes. Every field is sent, including the explicit nulls an unmanaged
 * project needs on update — absent would mean "keep", and keeping a source across a
 * switch to unmanaged is the one thing the store refuses.
 */
export function projectDraftPayload(draft: ProjectDraft): ProjectFieldsInput {
  if (draft.kind === "managed") {
    return { name: draft.name.trim(), kind: "managed", sourceKind: draft.sourceKind, source: draft.source.trim() };
  }
  return { name: draft.name.trim(), kind: "unmanaged", sourceKind: null, source: null };
}

/** Would saving change anything? Compared on the payload, so whitespace alone is not a change. */
export function isProjectDraftDirty(draft: ProjectDraft, baseline: ProjectDraft): boolean {
  return JSON.stringify(projectDraftPayload(draft)) !== JSON.stringify(projectDraftPayload(baseline));
}

/** A section of the dialog. `source` shows only for a managed draft. */
export interface ProjectFormSection {
  id: "general" | "source";
  title: string;
}

export function projectFormSections(draft: ProjectDraft): ProjectFormSection[] {
  const sections: ProjectFormSection[] = [{ id: "general", title: "General" }];
  if (draft.kind === "managed") sections.push({ id: "source", title: "Source" });
  return sections;
}

/** What the dialog is titled and what its primary button says, per mode. */
export function projectFormCopy(mode: ProjectFormMode): { title: string; submit: string; description: string } {
  if (mode.mode === "create") {
    return {
      title: "New project",
      submit: "Create project",
      description: "A project files work under a name. Make it managed to point it at a repository.",
    };
  }
  return {
    title: mode.row.project.name,
    submit: "Save changes",
    description: `Project settings for ${mode.row.project.slug} in ${mode.row.workspace}.`,
  };
}
