/**
 * A parent's subtree set of pull requests (core/subtree-pull-requests.ts): its own and every
 * descendant's, each listed once with the tickets it is recorded on, own first, read in two
 * queries however deep and wide the subtree is.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalItem } from "../src/core/integrations/contracts.js";
import { checksPhrase, subtreePullRequests, subtreePullRequestsFor } from "../src/core/subtree-pull-requests.js";
import { initWorkspace } from "../src/core/workspace.js";

const dirs: string[] = [];
const previous = process.env.STAPLE_HOME;
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  if (previous === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previous;
});

function pr(id: number, state = "open"): ExternalItem {
  return {
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: "2026-11-25T12:00:00.000Z",
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "staple-subtree-prs-"));
  dirs.push(home);
  process.env.STAPLE_HOME = home;
  const { store } = initWorkspace({ global: true, slug: "subtree-prs" });
  // Each ticket is made a second after the last, so "children by creation" is a real order and
  // not the tie two tickets made in one millisecond leave to their numbers.
  vi.useFakeTimers({ toFake: ["Date"] });
  let clock = Date.parse("2026-11-27T00:00:00.000Z");
  const createIssue = store.createIssue.bind(store);
  store.createIssue = (input, internal) => {
    vi.setSystemTime((clock += 1000));
    return createIssue(input, internal);
  };
  const links = store.externalLinks();
  const link = (ref: string, id: number, state?: string) => links.link(ref, pr(id, state), "ada");
  return { store, link };
}

const keysOf = (set: ReturnType<typeof subtreePullRequests>) => (set ?? []).map((p) => [p.key, p.own, p.tickets.map((t) => t.identifier)]);

describe("a parent's subtree pull requests", () => {
  it("lists the parent's own first, then every descendant's in tree order, each naming its ticket", () => {
    const { store, link } = setup();
    const epic = store.createIssue({ title: "Epic" });
    const a = store.createIssue({ title: "A", parent: epic.id });
    const b = store.createIssue({ title: "B", parent: epic.id });
    const a1 = store.createIssue({ title: "A1", parent: a.id });
    link(b.identifier, 30);
    link(a1.identifier, 20, "merged");
    link(epic.identifier, 10);
    link(a.identifier, 11, "draft");

    expect(keysOf(subtreePullRequests(store, epic.id))).toEqual([
      ["team/repo#10", true, [epic.identifier]],
      ["team/repo#11", false, [a.identifier]],
      ["team/repo#20", false, [a1.identifier]],
      ["team/repo#30", false, [b.identifier]],
    ]);
    // Each entry keeps the link's own facts, and names the ticket by id and title too.
    const nested = subtreePullRequests(store, epic.id)!.find((p) => p.key === "team/repo#20")!;
    expect(nested).toMatchObject({ number: 20, state: "merged", url: "https://github.com/team/repo/pull/20", tickets: [{ id: a1.id, identifier: a1.identifier, title: "A1", childId: a.id }] });
    // Each ticket names the parent's direct child it sits under: its own id for a child, null for the parent.
    const under = (key: string) => subtreePullRequests(store, epic.id)!.find((p) => p.key === key)!.tickets.map((t) => t.childId);
    expect([under("team/repo#10"), under("team/repo#11"), under("team/repo#30")]).toEqual([[null], [a.id], [b.id]]);
    // Asked from the middle parent, the same grandchild sits under that parent's own child.
    expect(subtreePullRequests(store, a.id)!.find((p) => p.key === "team/repo#20")!.tickets[0]!.childId).toBe(a1.id);
    // A middle parent has its own subtree set; a leaf has none.
    expect(keysOf(subtreePullRequests(store, a.id))).toEqual([["team/repo#11", true, [a.identifier]], ["team/repo#20", false, [a1.identifier]]]);
    expect(subtreePullRequests(store, b.id)).toBeNull();
    store.db.close();
  });

  it("lists a pull request linked on two tickets once, naming both, own first", () => {
    const { store, link } = setup();
    const epic = store.createIssue({ title: "Epic" });
    const a = store.createIssue({ title: "A", parent: epic.id });
    const b = store.createIssue({ title: "B", parent: epic.id });
    link(a.identifier, 40);
    link(b.identifier, 40);
    link(b.identifier, 41);
    link(epic.identifier, 41);

    expect(keysOf(subtreePullRequests(store, epic.id))).toEqual([
      ["team/repo#41", true, [epic.identifier, b.identifier]],
      ["team/repo#40", false, [a.identifier, b.identifier]],
    ]);
    store.db.close();
  });

  it("keeps finished children's pull requests, and a parent with none has an empty set", () => {
    const { store, link } = setup();
    const epic = store.createIssue({ title: "Epic" });
    const done = store.createIssue({ title: "Done", parent: epic.id });
    const cancelled = store.createIssue({ title: "Cancelled", parent: epic.id });
    link(done.identifier, 50, "merged");
    link(cancelled.identifier, 51, "closed");
    store.updateIssue(done.identifier, { status: "done" }, "ada");
    store.updateIssue(cancelled.identifier, { status: "cancelled" }, "ada");
    expect(keysOf(subtreePullRequests(store, epic.id))).toEqual([
      ["team/repo#50", false, [done.identifier]],
      ["team/repo#51", false, [cancelled.identifier]],
    ]);

    const quiet = store.createIssue({ title: "Quiet" });
    store.createIssue({ title: "Child", parent: quiet.id });
    expect(subtreePullRequests(store, quiet.id)).toEqual([]);
    store.db.close();
  });

  it("orders children made in the same millisecond by their number, not their random id", () => {
    const { store, link } = setup();
    const epic = store.createIssue({ title: "Epic" });
    // Burn numbers so the children are SUB-9 and SUB-10: a text sort of identifiers would swap them.
    for (let n = 0; n < 7; n++) store.createIssue({ title: `Filler ${n}` });
    // Made first but with the larger id: a tie-break on id would put it last.
    const first = store.createIssue({ title: "First", parent: epic.id }, { id: "ffffffff-0000-4000-8000-000000000000" });
    const second = store.createIssue({ title: "Second", parent: epic.id }, { id: "00000000-0000-4000-8000-000000000000" });
    const grandchild = store.createIssue({ title: "Grandchild", parent: second.id }, { id: "11111111-0000-4000-8000-000000000000" });
    expect([first.identifier, second.identifier]).toEqual(["SUB-9", "SUB-10"]);
    store.db.prepare("UPDATE issues SET created_at = ? WHERE id IN (?, ?, ?)").run("2026-11-27T12:00:00.000Z", first.id, second.id, grandchild.id);
    link(second.identifier, 61);
    link(grandchild.identifier, 62);
    link(first.identifier, 60);
    expect(keysOf(subtreePullRequests(store, epic.id))).toEqual([
      ["team/repo#60", false, [first.identifier]],
      ["team/repo#61", false, [second.identifier]],
      ["team/repo#62", false, [grandchild.identifier]],
    ]);
    store.db.close();
  });

  it("reads any number of parents in the same few queries as one, never one per child", () => {
    const { store, link } = setup();
    const small = store.createIssue({ title: "Small" });
    link(store.createIssue({ title: "Only child", parent: small.id }).identifier, 99);
    const prepare = vi.spyOn(store.db, "prepare");
    subtreePullRequestsFor(store, [small.id]);
    const one = prepare.mock.calls.length;
    prepare.mockClear();
    const roots = [store.createIssue({ title: "Epic 1" }), store.createIssue({ title: "Epic 2" })];
    for (const root of roots) {
      let parent = root;
      for (let depth = 0; depth < 4; depth++) {
        for (let n = 0; n < 5; n++) link(store.createIssue({ title: `Child ${root.title} ${depth}.${n}`, parent: parent.id }).identifier, 100 + depth * 10 + n);
        parent = store.createIssue({ title: `Level ${root.title} ${depth}`, parent: parent.id });
      }
    }
    prepare.mockClear();
    const sets = subtreePullRequestsFor(store, roots.map((r) => r.id));
    // The subtree walk and the pull request read: one each, plus the planning flag.
    expect(prepare.mock.calls.filter(([sql]) => /\b(?:issues|external_links)\b/.test(String(sql)))).toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(one);
    prepare.mockRestore();
    expect(sets.get(roots[0]!.id)).toHaveLength(20);
    expect(sets.get(roots[1]!.id)!.map((p) => p.key)).toEqual(sets.get(roots[0]!.id)!.map((p) => p.key));
    store.db.close();
  });

  it("says a pull request's checks only when they need attention", () => {
    const failing = (names: string[]) => ({ state: "failing" as const, failing: names, completedAt: null });
    expect(checksPhrase(failing(["test", "lint"]))).toBe("checks failing: test, lint");
    expect(checksPhrase(failing(["a", "b", "c", "d", "e"]))).toBe("checks failing: a, b, c and 2 more");
    expect(checksPhrase(failing([]))).toBe("checks failing");
    expect(checksPhrase({ state: "pending", failing: [], completedAt: null })).toBe("checks pending");
    expect(checksPhrase({ state: "passing", failing: [], completedAt: null })).toBeNull();
    expect(checksPhrase(null)).toBeNull();
  });
});
