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
import { insertEvent } from "./event-log.js";
import type { Journal } from "./journal.js";
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

  /** The connection's one journal seam. Shared with every other store. */
  private get journal(): Journal {
    return this.store.journal;
  }

  /** One logical mutation: one transaction, one journal scope. Re-entrant. */
  private journaled<T>(fn: () => T): T {
    return this.store.journaled(fn);
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
    return this.journaled(() => {
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
      /**
       * `source` is carried, and redacting it is NOT this seam's job.
       *
       * It is the one column in the schema that can hold an absolute filesystem
       * path — and so the device's directory layout and, on macOS and Linux, the
       * account name — but only when `sourceKind` is `local`; a `github` source
       * is a public URL and is useful to replicate. That makes it a per-row,
       * column-level redaction decided from a sibling column, which belongs in
       * the transport where the privacy contract is enforced and testable, not
       * scattered across every site that happens to write a project.
       */
      this.journal.record({
        entity: "project",
        entityId: project.id,
        verb: "create",
        payload: {
          slug: project.slug,
          name: project.name,
          kind: project.kind,
          sourceKind: project.sourceKind,
          source: project.source,
        },
        actor,
      });
      return project;
    });
  }

  /**
   * Patch semantics: an absent field keeps its value, a present one replaces it,
   * and the merged result must satisfy every rule a create must — so switching a
   * managed project to `unmanaged` has to clear its source in the same call, and
   * switching to `managed` has to supply one.
   *
   * `name` and `kind` have no null state (the columns are NOT NULL), so a null
   * there means "unchanged" exactly as absent does — it must not read as "reset
   * to the default kind", which would refuse a managed project that kept its
   * source. `sourceKind` and `source` ARE nullable, and null there is the clear.
   */
  update(ref: string, patch: ProjectInput, actor: string | null): Project {
    return this.journaled(() => {
      const current = rowToProject(this.requireRow(ref));
      const fields = normalizeProjectInput({
        name: patch.name ?? current.name,
        kind: patch.kind ?? current.kind,
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
      // Only the fields that actually moved: `changed` is already exactly that
      // set, and the no-op case returned above without reaching here.
      this.journal.record({
        entity: "project",
        entityId: project.id,
        verb: "update",
        payload: Object.fromEntries(changed.map((key) => [key, fields[key]])),
        actor,
      });
      return project;
    });
  }

  /**
   * Delete the project and let its issues go: every `project_id` that pointed at
   * it becomes null in the same transaction. The issues themselves are untouched
   * otherwise — a project is a label on work, not the work.
   *
   * Every unfiled issue gets its own `issue_project_changed` (project -> null),
   * exactly the event `assign` would have written, so the issue's own activity
   * explains the transition; the one `project_deleted` says why it happened.
   */
  remove(ref: string, actor: string | null): ProjectRemoval {
    return this.journaled(() => {
      const project = rowToProject(this.requireRow(ref));
      const now = nowIso();
      const filed = this.db
        .prepare("SELECT id, identifier FROM issues WHERE project_id = ? ORDER BY identifier")
        .all(project.id) as Array<{ id: string; identifier: string }>;
      this.db.prepare("UPDATE issues SET project_id = NULL, updated_at = ? WHERE project_id = ?").run(now, project.id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
      for (const issue of filed) {
        this.emit(
          "issue_project_changed",
          actor,
          { identifier: issue.identifier, project: null, previous: project.slug },
          issue.id,
        );
      }
      this.emit("project_deleted", actor, { project: project.slug, unassigned: filed.length });
      /**
       * The delete, plus one `issue.update` per unfiled issue. The cascade is
       * real state on other rows — `project_id` became null — and a receiver
       * that applied only the delete would keep every one of those issues
       * pointing at a project it no longer has.
       */
      this.journal.record({
        entity: "project",
        entityId: project.id,
        verb: "delete",
        payload: {},
        actor,
      });
      for (const issue of filed) {
        this.journal.record({
          entity: "issue",
          entityId: issue.id,
          verb: "update",
          payload: { projectId: null },
          actor,
        });
      }
      return { project, unassigned: filed.length };
    });
  }

  /**
   * Put an issue in a project, or take it out (`project: null`). The one write
   * to `issues.project_id` after creation; the event names both ends of the move.
   */
  assign(issueRef: string, project: string | null, actor: string | null): Issue {
    return this.journaled(() => {
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
      // The ISSUE changed, not the project: `assign` writes `issues.project_id`
      // and nothing in `projects`. Declared after the no-op guard above, so
      // re-filing an issue where it already is journals nothing.
      this.journal.record({
        entity: "issue",
        entityId: issue.id,
        verb: "update",
        payload: { projectId: nextId },
        actor,
      });
      return this.store.getIssue(issue.identifier);
    });
  }

  // ---------- events ----------

  /**
   * One of the four emitters, now delegating to the single writer. It used to
   * hardcode `NULL` for the dedup key; `insertEvent` derives one from the
   * enclosing mutation instead.
   */
  private emit(kind: string, actor: string | null, payload: Record<string, unknown>, issueId: string | null = null): void {
    insertEvent(this.db, { kind, issueId, actor, payload });
  }
}
