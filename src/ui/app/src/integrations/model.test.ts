import { describe, expect, it } from "vitest";
import type { ExternalLink } from "../../../../core/integrations/link-store";
import { groupLinks, uniqueHits, type SearchHit } from "./model";
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

describe("link groups", () => {
  it("groups a ClickUp workspace's tasks under ClickUp, never under one task's id", () => {
    const link = (id: string, key: string) =>
      ({ id, resource: { ref: { providerId: "clickup", host: "app.clickup.com", scopeId: "9012345", containerId: "9012345", id, kind: "issue" }, key } }) as unknown as ExternalLink;
    expect(groupLinks([link("86b", "86b"), link("86a", "DEV-7")]).map((g) => [g.label, g.links.length])).toEqual([["ClickUp", 2]]);
  });
});
