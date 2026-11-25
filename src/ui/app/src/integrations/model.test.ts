import { describe, expect, it } from "vitest";
import { uniqueHits, type SearchHit } from "./model";
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
});
