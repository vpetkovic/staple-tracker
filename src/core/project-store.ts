/**
 * Projects in the store — the database half of docs/web-ui.md "Projects".
 *
 * Owns the one table migration 009 added (`projects`) and the one column it put
 * on `issues` (`project_id`), and nothing else: an issue's title, status, parent,
 * claim and gate stay exactly what `WorkspaceStore` gives any issue. Every rule
 * with a shape to it — the name, the kind, the source — is a pure function in
 * `projects.ts` and is pinned there. What lives here is the SQL, the events, and
 * the two invariants only a database can keep: a slug is unique, and an issue
 * never points at a project that no longer exists.
 *
 * A project is looked up by ID or by SLUG; every method takes either. The slug
 * is derived from the name once, at create time, and a rename leaves it alone —
 * it is the handle a person types and a bookmark holds, and both should survive
 * a title edit.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
import { newId } from "./ids.js";
import { normalizeProjectInput, slugifyProjectName, type ProjectInput } from "./projects.js";
import type { WorkspaceStore } from "./store.js";
import {
  StapleError,
  nowIso,
  type Issue,
  type Project,
  type ProjectKind,
  type ProjectSourceKind,
} from "./types.js";

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  source_kind: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id, slug, name, kind, source_kind, source, created_at, updated_at";

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as ProjectKind,
    sourceKind: row.source_kind as ProjectSourceKind | null,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What `remove` reports: the project that went, and how many issues it let go of. */
export interface ProjectRemoval {
  project: Project;
  unassigned: number;
}

export class ProjectStore {
  constructor(private readonly store: WorkspaceStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  // ---------- reads ----------

  /** Every project, by name (case-insensitive), then by creation. */
  list(): Project[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM projects ORDER BY name COLLATE NOCASE, created_at`)
        .all() as unknown as ProjectRow[]
    ).map(rowToProject);
  }

  private rowFor(ref: string): ProjectRow | undefined {
    const key = ref.trim();
    if (!key) return undefined;
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ? OR slug = ?`).get(key, key) as
      | ProjectRow
      | undefined;
  }

  private requireRow(ref: string): ProjectRow {
    const row = this.rowFor(ref);
    if (!row) {
      throw new StapleError("not_found", `No project matches "${ref}" in workspace ${this.store.slug}`, {
        project: ref,
      });
    }
    return row;
  }

  /** By id or by slug. `not_found` otherwise. */
  get(ref: string): Project {
    return rowToProject(this.requireRow(ref));
  }

  /** `Issue.projectId` -> how many issues point at it, for every project that has any. */
  issueCounts(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT project_id, COUNT(*) AS n FROM issues WHERE project_id IS NOT NULL GROUP BY project_id")
      .all() as Array<{ project_id: string; n: number }>;
    return new Map(rows.map((row) => [row.project_id, row.n]));
  }

  // ---------- writes ----------

  /**
   * The slug the name asks for, or the first numbered variant that is free:
   * `docs`, `docs-2`, `docs-3`. Decided inside the caller's transaction, so two
   * concurrent creates cannot both be told `docs` is free.
   */
  private freeSlug(name: string): string {
    const base = slugifyProjectName(name);
    const taken = new Set(
      (
        this.db.prepare("SELECT slug FROM projects WHERE slug = ? OR slug LIKE ?").all(base, `${base}-%`) as Array<{
          slug: string;
        }>
      ).map((row) => row.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  create(input: ProjectInput, actor: string | null): Project {
    const fields = normalizeProjectInput(input);
    return tx(this.db, () => {
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO projects (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
        )
        .get(
          newId(),
          this.freeSlug(fields.name),
          fields.name,
          fields.kind,
          fields.sourceKind,
          fields.source,
          now,
          now,
        ) as unknown as ProjectRow;
      const project = rowToProject(row);
      this.emit("project_created", actor, {
        project: project.slug,
        name: project.name,
        kind: project.kind,
        sourceKind: project.sourceKind,
      });
      return project;
    });
  }

  /**
   * Patch semantics: an absent field keeps its value, a present one replaces it,
   * and the merged result must satisfy every rule a create must — so switching a
   * managed project to `unmanaged` has to clear its source in the same call, and
   * switching to `managed` has to supply one.
   */
  update(ref: string, patch: ProjectInput, actor: string | null): Project {
    return tx(this.db, () => {
      const current = rowToProject(this.requireRow(ref));
      const fields = normalizeProjectInput({
        name: patch.name === undefined ? current.name : patch.name,
        kind: patch.kind === undefined ? current.kind : patch.kind,
        sourceKind: patch.sourceKind === undefined ? current.sourceKind : patch.sourceKind,
        source: patch.source === undefined ? current.source : patch.source,
      });
      const changed = (["name", "kind", "sourceKind", "source"] as const).filter(
        (key) => fields[key] !== current[key],
      );
      if (changed.length === 0) return current;
      const now = nowIso();
      const row = this.db
        .prepare(
          `UPDATE projects SET name = ?, kind = ?, source_kind = ?, source = ?, updated_at = ?
            WHERE id = ? RETURNING ${COLUMNS}`,
        )
        .get(fields.name, fields.kind, fields.sourceKind, fields.source, now, current.id) as unknown as ProjectRow;
      const project = rowToProject(row);
      this.emit("project_updated", actor, { project: project.slug, changed });
      return project;
    });
  }

  /**
   * Delete the project and let its issues go: every `project_id` that pointed at
   * it becomes null in the same transaction. The issues themselves are untouched
   * otherwise — a project is a label on work, not the work.
   */
  remove(ref: string, actor: string | null): ProjectRemoval {
    return tx(this.db, () => {
      const project = rowToProject(this.requireRow(ref));
      const now = nowIso();
      const unassigned = this.db
        .prepare("UPDATE issues SET project_id = NULL, updated_at = ? WHERE project_id = ?")
        .run(now, project.id).changes;
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      this.emit("project_deleted", actor, { project: project.slug, unassigned: Number(unassigned) });
      return { project, unassigned: Number(unassigned) };
    });
  }

  /**
   * Put an issue in a project, or take it out (`project: null`). The one write
   * to `issues.project_id` after creation; the event names both ends of the move.
   */
  assign(issueRef: string, project: string | null, actor: string | null): Issue {
    return tx(this.db, () => {
      const issue = this.store.getIssue(issueRef);
      const target = project === null || project.trim() === "" ? null : rowToProject(this.requireRow(project));
      const nextId = target?.id ?? null;
      if (nextId === issue.projectId) return issue;
      const previous = issue.projectId ? (this.rowFor(issue.projectId)?.slug ?? null) : null;
      const now = nowIso();
      this.db.prepare("UPDATE issues SET project_id = ?, updated_at = ? WHERE id = ?").run(nextId, now, issue.id);
      this.emit(
        "issue_project_changed",
        actor,
        { identifier: issue.identifier, project: target?.slug ?? null, previous },
        issue.id,
      );
      return this.store.getIssue(issue.identifier);
    });
  }

  // ---------- events ----------

  private emit(kind: string, actor: string | null, payload: Record<string, unknown>, issueId: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(kind, issueId, actor, JSON.stringify(payload), nowIso());
  }
}
