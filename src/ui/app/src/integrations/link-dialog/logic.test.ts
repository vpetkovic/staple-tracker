import { describe, expect, it } from "vitest";
import type { Issue } from "@/lib/types";
import type { MappingTarget, SearchHit } from "../model";
import {
  createLatest,
  failureLine,
  freshnessLine,
  groupResults,
  keepSelection,
  linkTag,
  moveSelection,
  outsideScopeTarget,
  queryKind,
  scopeLabel,
  scopeFromMapping,
  scopeNote,
  searchKinds,
} from "./logic";

const repo: MappingTarget = {
  key: "github.com/42", providerId: "github", host: "github.com", scopeId: "host", kind: "repository",
  containerId: "42", name: "vpetkovic/staple-tracker", url: null, connectionId: "gh",
};
const team: MappingTarget = {
  key: "linear.app/org/team", providerId: "linear", host: "linear.app", scopeId: "org", kind: "team",
  containerId: "team", name: "Engineering", url: null, connectionId: "lin",
};

function hit(id: string, over: { kind?: "issue" | "pull_request"; key?: string; title?: string; fetchedAt?: string; associations?: Issue[]; containerId?: string } = {}): SearchHit {
  const kind = over.kind ?? "issue";
  return {
    item: {
      ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: over.containerId ?? "42", id, kind },
      key: over.key ?? `vpetkovic/staple-tracker#${id}`,
      url: `https://github.com/vpetkovic/staple-tracker/issues/${id}`,
      title: over.title ?? `Item ${id}`,
      body: null,
      status: { id: "open", name: "open" },
      fetchedAt: over.fetchedAt ?? "2026-11-24T10:00:00Z",
    },
    associations: over.associations ?? [],
  };
}
const issue = (id: string, identifier: string) => ({ id, identifier, title: `Task ${identifier}` }) as Issue;

describe("what the field sends", () => {
  it("resolves a pasted https link and searches anything else", () => {
    expect(queryKind("https://github.com/o/r/issues/1")).toBe("preview");
    expect(queryKind("  HTTPS://github.com/o/r/pull/2 ")).toBe("preview");
    expect(queryKind("http://github.com/o/r/issues/1")).toBe("search");
    expect(queryKind("integration")).toBe("search");
    expect(queryKind("")).toBe("search");
  });

  it("asks for both kinds under All and drops pull requests for a Linear source", () => {
    expect(searchKinds("all", null, [repo, team])).toEqual(["issue", "pull_request"]);
    expect(searchKinds("pull_request", null, [repo])).toEqual(["pull_request"]);
    expect(searchKinds("all", team.key, [repo, team])).toEqual(["issue"]);
    expect(searchKinds("all", repo.key, [repo, team])).toEqual(["issue", "pull_request"]);
  });
});

describe("out-of-order answers", () => {
  it("ignores an answer for an older input", () => {
    const latest = createLatest();
    const first = latest.next();
    const second = latest.next();
    expect(latest.isLatest(first)).toBe(false);
    expect(latest.isLatest(second)).toBe(true);
  });
});

describe("merging and grouping", () => {
  it("merges the two kinds' answers into one list", () => {
    const issues = { cached: [], remote: [{ ...hit("1"), targetKey: repo.key }] };
    const pulls = { cached: [], remote: [{ ...hit("2", { kind: "pull_request" }), targetKey: repo.key }] };
    const groups = groupResults([issues, pulls], [repo]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hits.map((h) => h.item.key)).toEqual(["vpetkovic/staple-tracker#1", "vpetkovic/staple-tracker#2"]);
  });

  it("shows a saved copy and a live read of the same item once, the live one winning", () => {
    const saved = hit("1", { title: "Old title" });
    const live = { ...hit("1", { title: "New title" }), targetKey: repo.key };
    const groups = groupResults([{ cached: [saved], remote: [live] }], [repo]);
    expect(groups.flatMap((g) => g.hits).map((h) => ("title" in h.item ? h.item.title : null))).toEqual(["New title"]);
  });

  it("groups live hits under their target's name and saved-only hits under their repository or team key", () => {
    const linearSaved: SearchHit = {
      item: { ref: { providerId: "linear", host: "linear.app", scopeId: "org", containerId: "t2", id: "x", kind: "issue" }, key: "OPS-4", url: "https://linear.app/o/issue/OPS-4" },
      associations: [],
    };
    const groups = groupResults(
      [{ cached: [hit("9", { key: "other/repo#9", containerId: "77" }), linearSaved], remote: [{ ...hit("1", { key: "old-owner/old-name#1" }), targetKey: repo.key }, { ...hit("3", { key: "old-owner/old-name#3" }), targetKey: repo.key }] }],
      [repo],
    );
    expect(groups.map((g) => [g.label, g.providerId, g.hits.length])).toEqual([
      ["vpetkovic/staple-tracker", "github", 2],
      ["other/repo", "github", 1],
      ["OPS", "linear", 1],
    ]);
    expect(groups[0]!.hits.map((h) => h.item.key)).toEqual(["old-owner/old-name#1", "old-owner/old-name#3"]);
  });
  it("puts a saved-only hit from a mapped repository under that repository's heading, after the live ones", () => {
    const groups = groupResults([{ cached: [hit("7")], remote: [{ ...hit("1"), targetKey: repo.key }] }], [repo]);
    expect(groups.map((g) => [g.label, g.hits.map((h) => h.item.key)])).toEqual([
      ["vpetkovic/staple-tracker", ["vpetkovic/staple-tracker#1", "vpetkovic/staple-tracker#7"]],
    ]);
  });
});

describe("the tag at the end of a row", () => {
  it("says Linked here for the target task", () => {
    expect(linkTag([issue("t", "INT-2")], "t", true)).toEqual({ kind: "here" });
  });
  it("names one other task, or counts several", () => {
    expect(linkTag([issue("o", "INT-3")], "t", false)).toEqual({ kind: "elsewhere", label: "Linked to INT-3" });
    expect(linkTag([issue("o", "INT-3"), issue("p", "INT-4")], "t", false)).toEqual({ kind: "elsewhere", label: "Linked to 2 tasks" });
    expect(linkTag([issue("o", "INT-3"), issue("t", "INT-2")], "t", false)).toEqual({ kind: "elsewhere", label: "Linked to INT-3" });
  });
  it("is empty when linked nowhere", () => {
    expect(linkTag([], "t", false)).toBeNull();
    expect(linkTag([], null, false)).toBeNull();
  });
});

describe("the scope control's label", () => {
  it("names the workspace and counts its sources", () => {
    expect(scopeLabel({ mode: "workspace", targets: [repo, team] }, "staple")).toBe("staple · 2 sources");
    expect(scopeLabel({ mode: "workspace", targets: [repo] }, "staple")).toBe("staple · 1 source");
  });
  it("says Everything mapped when the workspace has none of its own", () => {
    expect(scopeLabel({ mode: "configured", targets: [repo, team] }, "staple")).toBe("Everything mapped · 2 sources");
    expect(scopeLabel({ mode: "configured", targets: [repo] }, "staple")).toBe("Everything mapped · 1 source");
  });
  it("says All workspaces across every workspace", () => {
    expect(scopeLabel({ mode: "all", targets: [repo, team] }, "")).toBe("All workspaces · 2 sources");
    expect(scopeLabel({ mode: "all", targets: [repo] }, "")).toBe("All workspaces · 1 source");
  });
  it("says Nothing to search when nothing is mapped", () => {
    expect(scopeLabel({ mode: "none", targets: [] }, "staple")).toBe("Nothing to search");
  });
  it("explains the configured scope and nothing else", () => {
    expect(scopeNote({ mode: "configured" }, "staple")).toBe("staple has no sources of its own, so it searches everything mapped.");
    expect(scopeNote({ mode: "workspace" }, "staple")).toBeNull();
    expect(scopeNote({ mode: "all" }, "")).toBeNull();
  });
});

describe("a failed source", () => {
  it("reads in the words Settings uses", () => {
    expect(failureLine({ connectionId: "gh", targetKeys: [repo.key], state: "unauthenticated", message: "x" }, [repo, team]))
      .toBe("GitHub sign-in needed on this computer. Showing saved copies for vpetkovic/staple-tracker.");
    expect(failureLine({ connectionId: "lin", targetKeys: [team.key], state: "rate_limited", message: "x" }, [repo, team]))
      .toBe("Linear rate limited on this computer. Showing saved copies for Engineering.");
  });
});

describe("selection", () => {
  const keys = ["a", "b", "c"];
  it("moves and wraps at both ends", () => {
    expect(moveSelection(keys, "a", 1)).toBe("b");
    expect(moveSelection(keys, "c", 1)).toBe("a");
    expect(moveSelection(keys, "a", -1)).toBe("c");
    expect(moveSelection([], null, 1)).toBeNull();
  });
  it("keeps the same item across a new list when it is still there, else selects the first", () => {
    expect(keepSelection(["x", "b", "y"], "b")).toBe("b");
    expect(keepSelection(["x", "y"], "b")).toBe("x");
    expect(keepSelection([], "b")).toBeNull();
  });
});

describe("freshness in the preview", () => {
  const now = Date.parse("2026-11-24T10:00:30Z");
  it("says Read just now inside a minute, the saved age after, and amber once stale", () => {
    expect(freshnessLine(hit("1").item, now)).toEqual({ text: "Read just now", stale: false });
    expect(freshnessLine(hit("1", { fetchedAt: "2026-11-24T07:00:00Z" }).item, now)).toEqual({ text: "Saved copy from 3 hr ago", stale: false });
    expect(freshnessLine(hit("1", { fetchedAt: "2026-11-20T07:00:00Z" }).item, now)).toEqual({ text: "Saved copy from 4 d ago", stale: true });
  });
  it("says it was linked by URL when there is no saved copy", () => {
    const { item } = hit("1");
    expect(freshnessLine({ ref: item.ref, key: item.key, url: item.url }, now)).toEqual({ text: "Linked by URL, not read yet", stale: false });
  });
});

describe("an outside-scope refusal", () => {
  it("carries the target to offer mapping", () => {
    const error = Object.assign(new Error("outside"), { code: "validation", detail: { reason: "outside_scope", target: repo } });
    expect(outsideScopeTarget(error)).toEqual(repo);
    expect(outsideScopeTarget(Object.assign(new Error("x"), { detail: { reason: "outside_scope" } }))).toBeNull();
    expect(outsideScopeTarget(Object.assign(new Error("x"), { detail: { reason: "duplicate", target: repo } }))).toBeNull();
    expect(outsideScopeTarget(new Error("plain"))).toBeNull();
  });
});

describe("the scope before the first answer", () => {
  const mapping = { workspaces: [{ workspace: "staple", targets: [repo] }, { workspace: "empty", targets: [] }, { workspace: "ops", targets: [team] }], targets: [repo, team] };
  it("follows the mapping the way the server's scope rule does", () => {
    expect(scopeFromMapping(mapping, "staple", false)).toEqual({ mode: "workspace", workspaces: ["staple"], targets: [repo] });
    expect(scopeFromMapping(mapping, "empty", false)).toEqual({ mode: "configured", workspaces: ["staple", "ops"], targets: [repo, team] });
    expect(scopeFromMapping(mapping, "staple", true)).toEqual({ mode: "all", workspaces: ["staple", "ops"], targets: [repo, team] });
    expect(scopeFromMapping({ workspaces: [{ workspace: "empty", targets: [] }], targets: [] }, "empty", false)).toEqual({ mode: "none", workspaces: [], targets: [] });
  });
});
