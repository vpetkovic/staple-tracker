/**
 * The branch a ticket is worked on, and the commit it was cut from.
 *
 * Two nullable `issues` columns (migration 024) that replicate as the issue fields `branch` and
 * `baseCommit`. `staple branch` and the `set_branch` tool set them. A ticket worked before the
 * field existed recorded its branch as a comment instead (`Branch pointer: branch feat/x, base
 * 3f2a1bc.`, docs/working-a-ticket.md, or `working on branch feat/x (off main 3f2a1bc)`); while
 * the field is empty that comment is the answer, read apart by {@link branchPointer}. Reading
 * never writes: the comment fills the answer, not the column, so a sync never sees a write
 * nobody made.
 *
 * The pull requests opened for the branch are not stored here. They are links in the
 * integrations link store, found for this branch by `integrations discover`
 * (`integrations/pr-discovery.ts`).
 */
import { insertEvent } from "./event-log.js";
import type { WorkspaceStore } from "./store.js";
import { type IssueComment, StapleError } from "./types.js";

/** The event a branch write records. */
export const BRANCH_SET_EVENT = "branch_set";

export interface TicketBranch {
  name: string;
  /** The commit the branch was cut from, lower-case hex; null when nobody recorded one. */
  base: string | null;
  /** `field` once set by a command; `comment` while it is read from a branch-pointer comment. */
  source: "field" | "comment";
  /** Who recorded it and when: the last `branch_set` event, or the comment's author and time. */
  setBy: string | null;
  setAt: string | null;
}

const POINTER_LINE = /^\s*(?:branch pointer\s*:|working on branch\s)/i;
const BRANCH_NAME = /\bbranch\s+`?([^\s,;()`]+)`?/i;
const BRANCH_BASE = /\b(?:base|off)\s+(.+)$/i;

/** The base as written: up to the first `)`, `,`, `;` or sentence end, without backticks. */
function baseOf(rest: string): string | null {
  const raw = BRANCH_BASE.exec(rest)?.[1];
  if (raw === undefined) return null;
  const cut = raw.split(/[),;]|\.(?:\s|$)/, 1)[0]!.replace(/`/g, "").trim();
  return cut === "" ? null : cut;
}

/** The newest comment that records the branch a ticket is worked on, read apart. `base` is as written. */
export function branchPointer(comments: readonly IssueComment[]): { name: string; base: string | null; author: string; at: string } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    const line = comment.body.split("\n", 1)[0]!;
    if (!POINTER_LINE.test(line)) continue;
    const pointer = line.replace(/^\s*branch pointer\s*:\s*/i, "");
    // "Branch pointer: branch feat/x, ..." names it after "branch"; "Branch pointer: feat/x ..." first.
    const named = BRANCH_NAME.exec(pointer) ?? /^`?([^\s,;()`]+)`?/.exec(pointer);
    const name = named?.[1]?.replace(/\.+$/, "");
    if (!name || /^(?:none|n\/a|tbd)$/i.test(name)) continue;
    const base = baseOf(pointer.slice(named!.index + named![0].length));
    return { name, base, author: comment.author, at: comment.createdAt };
  }
  return null;
}

/** The commit in a written base ("main 3f2a1bc" names 3f2a1bc); null when it names none. */
function commitIn(base: string | null): string | null {
  return /\b([0-9a-f]{7,64})\b/i.exec(base ?? "")?.[1]?.toLowerCase() ?? null;
}

/** A git branch name as `git check-ref-format --branch` would take it, kept to what a URL and a shell carry safely. */
export function checkBranchName(name: string): string {
  const value = name.trim();
  if (
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9._\/+#-]+$/.test(value) ||
    /^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock$|@\{/.test(value)
  ) {
    throw new StapleError("validation", `"${name}" is not a branch name git accepts. Use the name as git prints it, such as feat/sta-42.`);
  }
  return value;
}

/** A commit as hex, 7 to 64 characters (an abbreviated or full SHA-1 or SHA-256). */
export function checkCommit(commit: string): string {
  const value = commit.trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(value)) throw new StapleError("validation", `"${commit}" is not a commit. Pass its hash, such as the output of git rev-parse --short HEAD.`);
  return value;
}

interface BranchRow {
  id: string;
  branch: string | null;
  base_commit: string | null;
}

/** Every given ticket's branch: the field, else its newest branch-pointer comment. Three queries for the lot. */
export function ticketBranches(store: WorkspaceStore, issueIds: readonly string[]): Map<string, TicketBranch> {
  const result = new Map<string, TicketBranch>();
  if (issueIds.length === 0) return result;
  const ids = [...new Set(issueIds)];
  const marks = ids.map(() => "?").join(", ");
  const rows = store.db.prepare(`SELECT id, branch, base_commit FROM issues WHERE id IN (${marks})`).all(...ids) as unknown as BranchRow[];
  const set = rows.filter((row) => row.branch !== null);
  if (set.length > 0) {
    const events = store.db
      .prepare(
        `SELECT issue_id, actor, created_at FROM events WHERE kind = '${BRANCH_SET_EVENT}' AND issue_id IN (${set.map(() => "?").join(", ")}) ORDER BY seq`,
      )
      .all(...set.map((row) => row.id)) as Array<{ issue_id: string; actor: string | null; created_at: string }>;
    const last = new Map(events.map((event) => [event.issue_id, event]));
    for (const row of set) {
      const event = last.get(row.id);
      result.set(row.id, { name: row.branch!, base: row.base_commit, source: "field", setBy: event?.actor ?? null, setAt: event?.created_at ?? null });
    }
  }
  const unset = rows.filter((row) => row.branch === null).map((row) => row.id);
  if (unset.length > 0) {
    const comments = store.db
      .prepare(
        `SELECT issue_id, author, body, created_at FROM comments
          WHERE deleted_at IS NULL AND issue_id IN (${unset.map(() => "?").join(", ")})
            AND (ltrim(lower(body)) LIKE 'branch pointer%' OR ltrim(lower(body)) LIKE 'working on branch%')
          ORDER BY created_at, rowid`,
      )
      .all(...unset) as Array<{ issue_id: string; author: string; body: string; created_at: string }>;
    const byIssue = new Map<string, IssueComment[]>();
    for (const row of comments) {
      const list = byIssue.get(row.issue_id) ?? [];
      list.push({ author: row.author, body: row.body, createdAt: row.created_at } as IssueComment);
      byIssue.set(row.issue_id, list);
    }
    for (const [issueId, list] of byIssue) {
      const pointer = branchPointer(list);
      if (!pointer) continue;
      let name: string;
      try {
        name = checkBranchName(pointer.name);
      } catch {
        continue; // A comment that names no usable branch fills nothing.
      }
      result.set(issueId, { name, base: commitIn(pointer.base), source: "comment", setBy: pointer.author, setAt: pointer.at });
    }
  }
  return result;
}

/** One ticket's branch, or null when neither the field nor a branch-pointer comment names one. */
export function ticketBranch(store: WorkspaceStore, ref: string): TicketBranch | null {
  const { id } = store.getIssue(ref);
  return ticketBranches(store, [id]).get(id) ?? null;
}

/**
 * Record the branch a ticket is worked on, or clear it (`branch: null`). `base` set to a commit
 * records it, `null` clears it, and left out it is kept while the branch stays the same and
 * cleared when the branch changes (an old base belongs to the old branch). Repeating the same
 * values writes nothing and answers `changed: false`. Never touches status or claim.
 */
export function setTicketBranch(
  store: WorkspaceStore,
  ref: string,
  input: { branch: string | null; base?: string | null },
  actor: string | null,
): { branch: TicketBranch | null; changed: boolean } {
  const branch = input.branch === null ? null : checkBranchName(input.branch);
  if (branch === null && input.base) throw new StapleError("validation", "A base commit needs a branch. Pass the branch with it, or clear both.");
  const requested = input.base === undefined || input.base === null ? input.base : checkCommit(input.base);
  return store.journaled(() => {
    const issue = store.getIssue(ref);
    const row = store.db.prepare("SELECT branch, base_commit FROM issues WHERE id = ?").get(issue.id) as unknown as Omit<BranchRow, "id">;
    const base = branch === null ? null : requested !== undefined ? requested : branch === row.branch ? row.base_commit : null;
    if (branch === row.branch && base === row.base_commit) return { branch: ticketBranch(store, issue.id), changed: false };
    const now = store.journal.mutationAt();
    store.db.prepare("UPDATE issues SET branch = ?, base_commit = ?, updated_at = ? WHERE id = ?").run(branch, base, now, issue.id);
    store.journal.record({ entity: "issue", entityId: issue.id, verb: "update", payload: { branch, baseCommit: base, updatedAt: now }, actor });
    insertEvent(store.db, {
      kind: BRANCH_SET_EVENT,
      issueId: issue.id,
      actor,
      payload: { from: { branch: row.branch, base: row.base_commit }, to: { branch, base } },
    });
    return { branch: ticketBranch(store, issue.id), changed: true };
  });
}
