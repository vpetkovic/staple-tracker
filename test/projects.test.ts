import { describe, expect, it } from "vitest";
import {
  GITHUB_REPO_URL,
  PROJECT_NAME_MAX,
  normalizeProjectInput,
  slugifyProjectName,
} from "../src/core/projects.js";
import { StapleError } from "../src/core/types.js";

/**
 * The pure project rules — what a name, a kind and a source must look like —
 * pinned without a database. `store-projects.test.ts` pins what needs one.
 */

function refused(fn: () => unknown, field: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe("validation");
    expect((error as StapleError).detail?.field).toBe(field);
    return error as StapleError;
  }
  throw new Error(`expected a validation error on ${field}`);
}

describe("slugifyProjectName", () => {
  it("lower-cases, collapses runs of punctuation and whitespace, and trims the hyphens", () => {
    expect(slugifyProjectName("My Project (v2)")).toBe("my-project-v2");
    expect(slugifyProjectName("  docs  ")).toBe("docs");
    expect(slugifyProjectName("Staple Tracker!!")).toBe("staple-tracker");
    expect(slugifyProjectName("a__b--c")).toBe("a-b-c");
  });

  it("falls back to `project` when nothing usable is left, and caps the length", () => {
    expect(slugifyProjectName("???")).toBe("project");
    expect(slugifyProjectName("")).toBe("project");
    const long = slugifyProjectName("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("normalizeProjectInput", () => {
  it("defaults to an unmanaged project with the trimmed name and no source", () => {
    expect(normalizeProjectInput({ name: "  Docs  " })).toEqual({
      name: "Docs",
      kind: "unmanaged",
      sourceKind: null,
      source: null,
    });
  });

  it("requires a name, and bounds it", () => {
    refused(() => normalizeProjectInput({}), "name");
    refused(() => normalizeProjectInput({ name: "   " }), "name");
    refused(() => normalizeProjectInput({ name: null }), "name");
    refused(() => normalizeProjectInput({ name: "x".repeat(PROJECT_NAME_MAX + 1) }), "name");
    expect(normalizeProjectInput({ name: "x".repeat(PROJECT_NAME_MAX) }).name).toHaveLength(PROJECT_NAME_MAX);
  });

  it("refuses a kind outside the vocabulary", () => {
    refused(() => normalizeProjectInput({ name: "Docs", kind: "hosted" as never }), "kind");
  });

  it("refuses a source on an unmanaged project rather than dropping it", () => {
    refused(() => normalizeProjectInput({ name: "Docs", source: "/tmp/docs" }), "source");
    refused(() => normalizeProjectInput({ name: "Docs", kind: "unmanaged", sourceKind: "local" }), "source");
  });

  it("requires a source kind and a source on a managed project", () => {
    refused(() => normalizeProjectInput({ name: "Docs", kind: "managed" }), "sourceKind");
    refused(() => normalizeProjectInput({ name: "Docs", kind: "managed", sourceKind: "svn" as never }), "sourceKind");
    refused(() => normalizeProjectInput({ name: "Docs", kind: "managed", sourceKind: "github" }), "source");
    refused(() => normalizeProjectInput({ name: "Docs", kind: "managed", sourceKind: "local", source: "  " }), "source");
  });

  it("accepts a GitHub repository URL in its usual spellings and refuses anything else", () => {
    for (const url of [
      "https://github.com/vpetkovic/staple-tracker",
      "https://github.com/vpetkovic/staple-tracker/",
      "https://github.com/vpetkovic/staple-tracker.git",
      "https://github.com/some-org/repo.name_v2",
    ]) {
      expect(GITHUB_REPO_URL.test(url), url).toBe(true);
      expect(normalizeProjectInput({ name: "T", kind: "managed", sourceKind: "github", source: ` ${url} ` })).toEqual({
        name: "T",
        kind: "managed",
        sourceKind: "github",
        source: url,
      });
    }
    for (const url of [
      "github.com/vpetkovic/staple-tracker",
      "http://github.com/vpetkovic/staple-tracker",
      "https://github.com/vpetkovic",
      "https://gitlab.com/vpetkovic/staple-tracker",
      "https://github.com/vpetkovic/staple-tracker/issues",
      "not a url",
    ]) {
      const error = refused(
        () => normalizeProjectInput({ name: "T", kind: "managed", sourceKind: "github", source: url }),
        "source",
      );
      expect(error.message).toContain("https://github.com/owner/repo");
    }
  });

  it("accepts any non-empty local path without looking at the filesystem", () => {
    expect(
      normalizeProjectInput({ name: "T", kind: "managed", sourceKind: "local", source: " /definitely/not/here " }),
    ).toEqual({ name: "T", kind: "managed", sourceKind: "local", source: "/definitely/not/here" });
  });
});
