import { describe, expect, it } from "vitest";
import { freshness, uniqueHits, type SearchHit } from "./model";
const hit: SearchHit = {
  item: {
    ref: {
      providerId: "github",
      host: "github.com",
      scopeId: "host",
      containerId: "42",
      id: "1",
      kind: "issue",
    },
    key: "old/repo#1",
    url: "https://github.com/old/repo/issues/1",
  },
  associations: [],
};
describe("provider search presentation", () => {
  it("combines cached and live records by scoped immutable identity, retaining other hosts and kinds", () => {
    const live = { ...hit, item: { ...hit.item, key: "renamed/repo#1" } };
    const pr = {
      ...hit,
      item: { ...hit.item, ref: { ...hit.item.ref, kind: "pull_request" as const } },
    };
    const enterprise = {
      ...hit,
      item: { ...hit.item, ref: { ...hit.item.ref, host: "git.example" } },
    };
    expect(uniqueHits([hit, enterprise], [live, pr]).map((h) => h.item.key)).toEqual([
      "renamed/repo#1",
      "old/repo#1",
      "old/repo#1",
    ]);
  });
  it("distinguishes references, recently cached context and old context without claiming live freshness", () => {
    expect(freshness(hit.item)).toContain("not fetched");
    const dated = {
      ...hit.item,
      title: "Source",
      body: null,
      status: null,
      fetchedAt: "2026-11-23T00:00:00Z",
    };
    expect(freshness(dated, Date.parse("2026-11-23T01:00:00Z"))).toContain("Cached context");
    expect(freshness(dated, Date.parse("2026-11-25T01:00:00Z"))).toContain("Stale cache");
  });
});
