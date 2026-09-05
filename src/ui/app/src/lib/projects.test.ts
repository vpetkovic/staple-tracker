import { describe, expect, it } from "vitest";
import { projectsForWorkspace } from "./projects";
import type { ProjectRow } from "./types";

const row = (workspace: string, slug: string): ProjectRow => ({
  workspace,
  project: {
    id: `${workspace}/${slug}`,
    slug,
    name: slug,
    kind: "unmanaged",
    sourceKind: null,
    source: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  },
});

const ROWS = [row("staple", "docs"), row("pinecone", "docs"), row("staple", "site")];

describe("projectsForWorkspace", () => {
  it("answers every row for the empty workspace, which is hub mode with nothing chosen", () => {
    expect(projectsForWorkspace(ROWS, "").map((r) => r.project.id)).toEqual(["staple/docs", "pinecone/docs", "staple/site"]);
  });

  it("keeps only one workspace's rows otherwise, in served order", () => {
    expect(projectsForWorkspace(ROWS, "staple").map((r) => r.project.id)).toEqual(["staple/docs", "staple/site"]);
    expect(projectsForWorkspace(ROWS, "pinecone").map((r) => r.project.id)).toEqual(["pinecone/docs"]);
    expect(projectsForWorkspace(ROWS, "nowhere")).toEqual([]);
  });
});
