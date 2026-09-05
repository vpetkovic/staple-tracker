/**
 * The rules a project must satisfy — pure, and pinned in `test/projects.test.ts`
 * without a database. `project-store.ts` is the SQL around these.
 *
 * ── What is validated, and what deliberately is not ───────────────────────────────
 *
 * A name (required), a kind, and for a managed project a source of a declared
 * shape: a GitHub repository URL has to look like one, and a local path has to be
 * a non-empty string. Nothing here touches the network or the filesystem — no
 * probe that the repository exists, no check that the folder is there. The
 * modal that edits a project is a form, and a form should refuse what it can
 * see is wrong and accept what only the world can judge.
 */
import {
  PROJECT_KINDS,
  PROJECT_SOURCE_KINDS,
  StapleError,
  type ProjectKind,
  type ProjectSourceKind,
} from "./types.js";

/** What a caller may say about a project. Every field optional but the name. */
export interface ProjectInput {
  name?: string | null;
  kind?: ProjectKind | null;
  sourceKind?: ProjectSourceKind | null;
  source?: string | null;
}

/** The same four facts, normalized: trimmed, defaulted, and consistent with the kind. */
export interface ProjectFields {
  name: string;
  kind: ProjectKind;
  sourceKind: ProjectSourceKind | null;
  source: string | null;
}

export const PROJECT_NAME_MAX = 120;
export const PROJECT_SLUG_MAX = 48;

/**
 * `https://github.com/owner/repo`, with or without a trailing slash or `.git`.
 * Owner and repository names are what GitHub allows: letters, digits, `-`, `_`, `.`.
 */
export const GITHUB_REPO_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

const isProjectKind = (value: unknown): value is ProjectKind =>
  typeof value === "string" && (PROJECT_KINDS as readonly string[]).includes(value);

const isSourceKind = (value: unknown): value is ProjectSourceKind =>
  typeof value === "string" && (PROJECT_SOURCE_KINDS as readonly string[]).includes(value);

/**
 * `My Project (v2)` -> `my-project-v2`. Lower-case, runs of anything that is not a
 * letter or digit collapse to one hyphen, no leading or trailing hyphen, capped.
 * A name with no usable characters slugs to `project`; the store then numbers it.
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "project";
}

/**
 * Validate and normalize. Throws `StapleError("validation")` naming the field.
 *
 * The rules, in the order they are checked:
 *   - the name is required and at most `PROJECT_NAME_MAX` characters after trimming;
 *   - `kind` defaults to `unmanaged` and must be one of `PROJECT_KINDS`;
 *   - an UNMANAGED project carries no source: a source kind or a source value on it
 *     is refused rather than silently dropped, because a caller who sent one meant
 *     something the store would otherwise lose;
 *   - a MANAGED project needs a source kind from `PROJECT_SOURCE_KINDS` and a
 *     non-empty source; a `github` source must match `GITHUB_REPO_URL`.
 */
export function normalizeProjectInput(input: ProjectInput): ProjectFields {
  const name = (input.name ?? "").trim();
  if (!name) throw new StapleError("validation", "Project name is required", { field: "name" });
  if (name.length > PROJECT_NAME_MAX) {
    throw new StapleError("validation", `Project name is at most ${PROJECT_NAME_MAX} characters`, {
      field: "name",
    });
  }

  const kind = input.kind ?? "unmanaged";
  if (!isProjectKind(kind)) {
    throw new StapleError("validation", `Project kind must be one of ${PROJECT_KINDS.join(", ")}`, {
      field: "kind",
      kind,
    });
  }

  const sourceKind = input.sourceKind ?? null;
  const source = (input.source ?? "").trim() || null;

  if (kind === "unmanaged") {
    if (sourceKind !== null || source !== null) {
      throw new StapleError("validation", "An unmanaged project has no source; make it managed to give it one", {
        field: "source",
      });
    }
    return { name, kind, sourceKind: null, source: null };
  }

  if (!isSourceKind(sourceKind)) {
    throw new StapleError(
      "validation",
      `A managed project needs a source kind: ${PROJECT_SOURCE_KINDS.join(" or ")}`,
      { field: "sourceKind", sourceKind },
    );
  }
  if (source === null) {
    throw new StapleError(
      "validation",
      sourceKind === "github" ? "A GitHub project needs its repository URL" : "A local project needs its folder path",
      { field: "source", sourceKind },
    );
  }
  if (sourceKind === "github" && !GITHUB_REPO_URL.test(source)) {
    throw new StapleError(
      "validation",
      "A GitHub source must be a repository URL like https://github.com/owner/repo",
      { field: "source", sourceKind, source },
    );
  }
  return { name, kind, sourceKind, source };
}
