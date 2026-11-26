/**
 * The one reading of a pull request every surface draws from: how a payload becomes an
 * entry, the order that puts trouble first, the tally and its words, the short keys and how
 * a parent's set is filed under the children it sits in.
 */
import { describe, expect, it } from "vitest";
import {
  byAttention,
  checksWords,
  childPullRequests,
  descendantEntries,
  entriesByChild,
  entryRef,
  entryTone,
  entryWords,
  isSubtreeSet,
  linkEntry,
  otherTickets,
  rowEntry,
  shortKeys,
  subtreeEntries,
  subtreeEntry,
  tallyOf,
  tallyWords,
  worstChecks,
  type PullRequestEntry,
} from "./pull-requests";
import { prLink, prTicket, rowPr, subtreePr } from "./pull-request-fixture";

const entry = (n: number, patch: Partial<PullRequestEntry> = {}): PullRequestEntry => ({
  id: `e${n}`,
  key: `acme/shop#${n}`,
  url: `https://github.com/acme/shop/pull/${n}`,
  title: `Change ${n}`,
  state: "open",
  checks: null,
  failing: [],
  own: false,
  tickets: [],
  ...patch,
});

describe("subtreeEntry", () => {
  it("reads the server's pull request: key, url, title, own, tickets and where it lives carried over", () => {
    const tickets = [prTicket("ACME-2", "id-ACME-2")];
    const e = subtreeEntry(subtreePr(7, { own: true, tickets, checks: "passing" }));
    expect(e).toEqual({
      id: "res-acme/shop-7",
      key: "acme/shop#7",
      url: "https://github.com/acme/shop/pull/7",
      title: "Change 7",
      state: "open",
      checks: "passing",
      failing: [],
      own: true,
      tickets,
      ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "acme/shop", id: "7", kind: "pull_request" },
      fetchedAt: "2026-11-24T11:00:00Z",
    });
  });

  it("reads any case of the four states and calls everything else unknown", () => {
    expect(subtreeEntry(subtreePr(1, { state: "MERGED" })).state).toBe("merged");
    expect(subtreeEntry(subtreePr(1, { state: "Draft" })).state).toBe("draft");
    expect(subtreeEntry(subtreePr(1, { state: null })).state).toBe("unknown");
    expect(subtreeEntry(subtreePr(1, { state: "queued" })).state).toBe("unknown");
  });

  it("drops the checks of a merged or closed pull request and keeps them while it can still change", () => {
    for (const state of ["merged", "closed"]) {
      const e = subtreeEntry(subtreePr(1, { state, checks: "failing", failing: ["unit"] }));
      expect(e.checks).toBeNull();
    }
    for (const state of ["open", "draft", null]) expect(subtreeEntry(subtreePr(1, { state, checks: "pending" })).checks).toBe("pending");
  });

  it("keeps the failing names only while the checks fail", () => {
    expect(subtreeEntry(subtreePr(1, { checks: "failing", failing: ["unit", "lint"] })).failing).toEqual(["unit", "lint"]);
    expect(subtreeEntry(subtreePr(1, { checks: "pending", failing: ["stale"] })).failing).toEqual([]);
    expect(subtreeEntry(subtreePr(1)).checks).toBeNull();
  });
});

describe("linkEntry", () => {
  it("reads a ticket's own GitHub pull request with the checks on its head", () => {
    const e = linkEntry(prLink(9, { state: "draft", checks: "failing", failing: ["e2e"] }));
    expect(e).toMatchObject({ id: "res-acme/shop-9", key: "acme/shop#9", state: "draft", checks: "failing", failing: ["e2e"], own: true, tickets: [] });
  });

  it("drops checks once merged, and reads another provider's state as unknown", () => {
    expect(linkEntry(prLink(9, { state: "merged", checks: "failing" })).checks).toBeNull();
    expect(linkEntry(prLink(9, { state: null })).state).toBe("unknown");
    expect(linkEntry(prLink(9, { provider: "linear", state: "open" })).state).toBe("unknown");
  });
});

describe("rowEntry", () => {
  it("keys a row's pull request by the repository in its URL and treats one without tickets as the row's own", () => {
    const e = rowEntry(rowPr(12, "open", { checks: "pending" }));
    expect(e).toMatchObject({ id: "https://github.com/acme/shop/pull/12", key: "acme/shop#12", state: "open", checks: "pending", own: true, tickets: [] });
  });

  it("keys a row's pull request by its number alone when the URL names no repository", () => {
    expect(rowEntry(rowPr(12, "open", { url: "https://example.test/12" })).key).toBe("#12");
  });

  it("is the row's own only when its tickets name the row", () => {
    expect(rowEntry(rowPr(1, "open", { tickets: ["ACME-1", "ACME-2"] }), "ACME-1").own).toBe(true);
    const child = rowEntry(rowPr(1, "open", { tickets: ["ACME-2"] }), "ACME-1");
    expect(child.own).toBe(false);
    expect(child.tickets).toEqual([{ id: "ACME-2", identifier: "ACME-2", title: "" }]);
  });

  it("drops the checks of a closed pull request", () => {
    expect(rowEntry(rowPr(1, "closed", { checks: "failing" })).checks).toBeNull();
  });
});

describe("entryTone", () => {
  it("draws a state never read in the neutral tone", () => {
    expect(entryTone({ state: "unknown" })).toBe("neutral");
    expect(entryTone({ state: "merged" })).toBe("merged");
  });
});

describe("byAttention", () => {
  it("puts failing checks first, then open, draft, unknown, merged, closed", () => {
    const given = [
      entry(1, { state: "closed" }),
      entry(2, { state: "merged" }),
      entry(3, { state: "unknown" }),
      entry(4, { state: "draft" }),
      entry(5, { state: "open" }),
      entry(6, { state: "draft", checks: "failing" }),
    ];
    expect(byAttention(given).map((e) => e.id)).toEqual(["e6", "e5", "e4", "e3", "e2", "e1"]);
  });

  it("keeps the given order among equals and leaves its input alone", () => {
    const given = [entry(1, { state: "merged" }), entry(2), entry(3, { state: "merged" }), entry(4), entry(5, { checks: "failing" }), entry(6, { checks: "failing" })];
    const before = given.map((e) => e.id);
    expect(byAttention(given).map((e) => e.id)).toEqual(["e5", "e6", "e2", "e4", "e1", "e3"]);
    expect(given.map((e) => e.id)).toEqual(before);
  });

  it("does not rank pending checks above an open pull request without them", () => {
    expect(byAttention([entry(1), entry(2, { checks: "pending" })]).map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("tallyOf", () => {
  it("counts each state, and counts failing open or draft pull requests again under failing", () => {
    const tally = tallyOf([
      entry(1, { checks: "failing" }),
      entry(2, { state: "draft", checks: "failing" }),
      entry(3),
      entry(4, { state: "merged" }),
      entry(5, { state: "closed" }),
      entry(6, { state: "unknown" }),
      entry(7, { state: "draft", checks: "pending" }),
    ]);
    expect(tally).toEqual({ total: 7, failing: 2, open: 2, draft: 2, merged: 1, closed: 1, unknown: 1 });
  });

  it("is all zeros for nothing", () => {
    expect(tallyOf([])).toEqual({ total: 0, failing: 0, open: 0, draft: 0, merged: 0, closed: 0, unknown: 0 });
  });
});

describe("tallyWords", () => {
  it("reads failing, open, draft, merged, closed, unknown, skipping what is not there", () => {
    const tally = { total: 10, failing: 1, open: 5, draft: 2, merged: 2, closed: 0, unknown: 1 };
    expect(tallyWords(tally)).toBe("10 pull requests: 1 with failing checks, 5 open, 2 draft, 2 merged, 1 state unknown");
    expect(tallyWords({ total: 3, failing: 0, open: 0, draft: 0, merged: 1, closed: 2, unknown: 0 })).toBe("3 pull requests: 1 merged, 2 closed");
  });

  it("says one pull request in the singular", () => {
    expect(tallyWords(tallyOf([entry(1)]))).toBe("1 pull request: 1 open");
    expect(tallyWords(tallyOf([]))).toBe("0 pull requests");
  });
});

describe("checksWords", () => {
  it("says pending, passing, and nothing when no checks were read", () => {
    expect(checksWords({ checks: "pending", failing: [] })).toBe("checks pending");
    expect(checksWords({ checks: "passing", failing: [] })).toBe("checks passing");
    expect(checksWords({ checks: null, failing: [] })).toBeNull();
  });

  it("names up to three failing checks and counts the rest", () => {
    expect(checksWords({ checks: "failing", failing: [] })).toBe("checks failing");
    expect(checksWords({ checks: "failing", failing: ["unit", "lint", "e2e"] })).toBe("checks failing: unit, lint, e2e");
    expect(checksWords({ checks: "failing", failing: ["unit", "lint", "e2e", "build", "docs"] })).toBe("checks failing: unit, lint, e2e and 2 more");
  });
});

describe("entryWords", () => {
  it("reads key, title, state and checks that need a look, and leaves passing unsaid", () => {
    expect(entryWords(entry(405, { title: "Validate card fields", checks: "failing", failing: ["unit"] }))).toBe("acme/shop#405, Validate card fields, open, checks failing: unit");
    expect(entryWords(entry(405, { checks: "passing" }))).toBe("acme/shop#405, Change 405, open");
    expect(entryWords(entry(405, { title: null, state: "unknown", checks: "pending" }))).toBe("acme/shop#405, state unknown, checks pending");
  });
});

describe("shortKeys", () => {
  const keyed = (keys: string[]) => keys.map((key, i) => entry(i, { id: `e${i}`, key }));
  const shown = (keys: string[]) => [...shortKeys(keyed(keys)).values()];

  it("leaves one repository unsaid", () => {
    expect(shown(["acme/shop#1", "acme/shop#2"])).toEqual(["#1", "#2"]);
  });

  it("leaves the repository most are in unsaid and names a stray by its repository", () => {
    expect(shown(["acme/shop#405", "acme/admin#88", "acme/shop#406"])).toEqual(["#405", "admin#88", "#406"]);
  });

  it("keeps the owner when two owners share a repository name", () => {
    expect(shown(["acme/shop#1", "acme/shop#2", "other/shop#3"])).toEqual(["#1", "#2", "other/shop#3"]);
    expect(shown(["acme/shop#1", "acme/shop#2", "other/shop#3", "acme/admin#4"])).toEqual(["#1", "#2", "other/shop#3", "admin#4"]);
  });

  it("reads a row's number-only keys as they are", () => {
    expect(shown(["#1", "#22"])).toEqual(["#1", "#22"]);
  });

  it("keys a row's pull request from another repository apart, as the detail's card does", () => {
    const refs = [rowPr(31), rowPr(30), rowPr(88, "open", { url: "https://github.com/acme/admin/pull/88" })];
    const entries = refs.map((ref) => rowEntry(ref, "ACME-P"));
    expect([...shortKeys(entries).values()]).toEqual(["#31", "#30", "admin#88"]);
  });

  it("is keyed by entry id", () => {
    const map = shortKeys([entry(1, { id: "a", key: "acme/shop#1" }), entry(2, { id: "b", key: "acme/admin#2" }), entry(3, { id: "c", key: "acme/shop#3" })]);
    expect(map.get("b")).toBe("admin#2");
  });
});

describe("otherTickets", () => {
  it("drops the ticket shown, by id or identifier", () => {
    const e = entry(1, { tickets: [prTicket("ACME-1"), prTicket("ACME-2")] });
    expect(otherTickets(e, "id-ACME-1").map((t) => t.identifier)).toEqual(["ACME-2"]);
    expect(otherTickets(e, "ACME-2").map((t) => t.identifier)).toEqual(["ACME-1"]);
    expect(otherTickets(e, "elsewhere")).toHaveLength(2);
  });
});

describe("descendantEntries and subtreeEntries", () => {
  it("keeps only what a descendant carries", () => {
    expect(descendantEntries([entry(1, { own: true }), entry(2), entry(3, { own: true }), entry(4)]).map((e) => e.id)).toEqual(["e2", "e4"]);
  });

  it("reads a parent's set and nothing for a leaf", () => {
    expect(subtreeEntries({})).toEqual([]);
    expect(subtreeEntries({ subtreePullRequests: [subtreePr(1), subtreePr(2, { own: true })] }).map((e) => [e.key, e.own])).toEqual([
      ["acme/shop#1", false],
      ["acme/shop#2", true],
    ]);
  });
});

describe("entriesByChild", () => {
  // PARENT ── A (leaf) ── B (sub-parent) ── B1 (grandchild)
  const A = prTicket("ACME-A", "id-ACME-A");
  const B = prTicket("ACME-B", "id-ACME-B");
  const B1 = prTicket("ACME-B1", "id-ACME-B");
  const PARENT = prTicket("ACME-P", null);

  it("files a pull request under the direct child it sits in, a grandchild's under its sub-parent", () => {
    const byChild = entriesByChild([entry(1, { tickets: [A] }), entry(2, { tickets: [B1] }), entry(3, { tickets: [B, B1] })]);
    expect([...byChild.keys()].sort()).toEqual(["id-ACME-A", "id-ACME-B"]);
    expect(byChild.get("id-ACME-A")!.map((e) => e.id)).toEqual(["e1"]);
    // e3 sits on B and on B1, both under B: filed once.
    expect(byChild.get("id-ACME-B")!.map((e) => e.id)).toEqual(["e2", "e3"]);
  });

  it("files a pull request shared by two children under both, and the parent's own under none", () => {
    const byChild = entriesByChild([entry(1, { tickets: [PARENT] }), entry(2, { tickets: [PARENT, A, B1] })]);
    expect(byChild.get("id-ACME-A")!.map((e) => e.id)).toEqual(["e2"]);
    expect(byChild.get("id-ACME-B")!.map((e) => e.id)).toEqual(["e2"]);
    expect(byChild.has("id-ACME-P")).toBe(false);
  });

  it("files under the tickets themselves when an older server sends no childId", () => {
    const byChild = entriesByChild([entry(1, { tickets: [prTicket("ACME-A"), prTicket("ACME-B")] })]);
    expect([...byChild.keys()]).toEqual(["id-ACME-A", "id-ACME-B"]);
  });
});

describe("entryRef", () => {
  it("turns an entry into a row's ref with its number, checks and tickets", () => {
    expect(entryRef(entry(405, { checks: "failing" }), ["ACME-1"])).toEqual({
      provider: "github",
      number: 405,
      url: "https://github.com/acme/shop/pull/405",
      state: "open",
      title: "Change 405",
      checks: "failing",
      tickets: ["ACME-1"],
    });
    const plain = entryRef(entry(3))!;
    expect("checks" in plain).toBe(false);
    expect("tickets" in plain).toBe(false);
  });

  it("is null for a key without a number", () => {
    expect(entryRef(entry(1, { key: "acme/shop" }))).toBeNull();
    expect(entryRef(entry(1, { key: "acme/shop#0" }))).toBeNull();
  });
});

describe("childPullRequests", () => {
  const A = prTicket("ACME-A", "id-ACME-A");
  const A2 = prTicket("ACME-A2", "id-ACME-A2");
  const B = prTicket("ACME-B", "id-ACME-B");
  const B1 = prTicket("ACME-B1", "id-ACME-B");
  const B2 = prTicket("ACME-B2", "id-ACME-B");
  const set = [
    entry(1, { state: "merged", tickets: [A] }),
    entry(2, { checks: "failing", tickets: [B1] }),
    entry(3, { tickets: [B, B2] }),
    entry(4, { state: "draft", tickets: [A, A2] }),
  ];
  /** As the "Tasks inside" rows read it: the child's entries, filed by `entriesByChild`. */
  const forChild = (entries: PullRequestEntry[], childId: string) => childPullRequests(entriesByChild(entries).get(childId), childId);

  it("gives a leaf child its pull requests as a leaf's, without tickets, in attention order", () => {
    const { pullRequests, externalLinks } = forChild(set, "id-ACME-A");
    expect(pullRequests!.map((pr) => [pr.number, pr.tickets])).toEqual([
      [4, undefined],
      [1, undefined],
    ]);
    expect(isSubtreeSet(pullRequests, "ACME-A")).toBe(false);
    expect(externalLinks).toEqual({ issues: { count: 0, items: [] }, pullRequests: { count: 2, items: expect.any(Array) } });
    expect(externalLinks!.pullRequests.items.map((item) => item.key)).toEqual(["acme/shop#4", "acme/shop#1"]);
  });

  it("gives a sub-parent its branch as a subtree set, naming only tickets inside it", () => {
    const { pullRequests } = forChild(set, "id-ACME-B");
    expect(pullRequests!.map((pr) => [pr.number, pr.tickets])).toEqual([
      [2, ["ACME-B1"]],
      [3, ["ACME-B", "ACME-B2"]],
    ]);
    expect(pullRequests![0]!.checks).toBe("failing");
    expect(isSubtreeSet(pullRequests, "ACME-B")).toBe(true);
  });

  it("reads a pull request two siblings share as each one's own", () => {
    const shared = [entry(9, { tickets: [A, prTicket("ACME-C", "id-ACME-C")] })];
    for (const [child, identifier] of [["id-ACME-A", "ACME-A"], ["id-ACME-C", "ACME-C"]] as const) {
      const { pullRequests } = forChild(shared, child);
      expect(pullRequests!.map((pr) => pr.number)).toEqual([9]);
      expect(pullRequests![0]!.tickets).toBeUndefined();
      expect(isSubtreeSet(pullRequests, identifier)).toBe(false);
    }
  });

  it("files by the tickets themselves without childId, so a direct child still reads as a leaf", () => {
    const old = [entry(5, { tickets: [prTicket("ACME-A"), prTicket("ACME-B")] })];
    expect(forChild(old, "id-ACME-A").pullRequests!.map((pr) => [pr.number, pr.tickets])).toEqual([[5, undefined]]);
  });

  it("is nothing for a child without any, and for no set", () => {
    expect(forChild(set, "id-ACME-Z")).toEqual({});
    expect(childPullRequests([], "id-ACME-A")).toEqual({});
    expect(childPullRequests(undefined, "id-ACME-A")).toEqual({});
  });
});

describe("isSubtreeSet", () => {
  it("is a subtree set only when a pull request names a ticket other than the row's", () => {
    expect(isSubtreeSet(undefined, "ACME-1")).toBe(false);
    expect(isSubtreeSet([rowPr(1), rowPr(2)], "ACME-1")).toBe(false);
    expect(isSubtreeSet([rowPr(1, "open", { tickets: ["ACME-1"] })], "ACME-1")).toBe(false);
    expect(isSubtreeSet([rowPr(1, "open", { tickets: ["ACME-1"] }), rowPr(2, "open", { tickets: ["ACME-2"] })], "ACME-1")).toBe(true);
  });
});

describe("worstChecks", () => {
  it("lets failing beat pending and says nothing for passing or unread", () => {
    expect(worstChecks([{ checks: "pending" }, { checks: "failing" }, { checks: "passing" }])).toBe("failing");
    expect(worstChecks([{ checks: "passing" }, { checks: "pending" }])).toBe("pending");
    expect(worstChecks([{ checks: "passing" }, { checks: null }])).toBeNull();
    expect(worstChecks([])).toBeNull();
  });
});
