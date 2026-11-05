/**
 * The brain POC's pure parts: the memory-file parser, the session-start block's budget and
 * ranking, and recall. Sync is `brain-sync.test.ts`; the Worker half is in `worker/test`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, renderHookOutput } from "../src/brain/context.js";
import { extractWhy, parseFrontmatter, planImport } from "../src/brain/import.js";
import { ftsQuery, recall } from "../src/brain/recall.js";
import { pathSlug, scopeRelation } from "../src/brain/scope.js";
import { estimateTokens, type BrainRecord } from "../src/brain/types.js";

const NOW = "2026-11-05T00:00:00.000Z";

function record(overrides: Partial<BrainRecord> & { id: string }): BrainRecord {
  return {
    kind: "feedback",
    name: overrides.id,
    description: null,
    body: "body",
    why: null,
    scope: "global",
    tags: [],
    source: null,
    createdAt: NOW,
    updatedAt: NOW,
    verifiedAt: NOW,
    supersededBy: null,
    provisional: false,
    ...overrides,
  };
}

describe("memory file import", () => {
  it("reads both frontmatter shapes and skips MEMORY.md", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-import-"));
    const dir = join(root, "-Users-me-repo", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- [a](a.md) — index\n");
    writeFileSync(
      join(dir, "a.md"),
      '---\nname: a\ndescription: "Quoted: with colon"\nmetadata: \n  node_type: memory\n  type: feedback\n  modified: 2026-09-10T11:01:25.988Z\n---\n\nRule.\n\n**Why:** because.\n\n**How to apply:** always. See [[b]].\n',
    );
    writeFileSync(join(dir, "b.md"), "---\nname: b\ndescription: plain\ntype: project\n---\nState of things.\n");
    writeFileSync(join(dir, "c.md"), "no frontmatter at all\n");

    const plan = planImport(root);
    expect(plan.memories.map((m) => [m.input.name, m.input.kind, m.input.scope])).toEqual([
      ["a", "feedback", "global"],
      ["b", "project", "project:-Users-me-repo"],
    ]);
    const a = plan.memories[0]!.input;
    expect(a.description).toBe("Quoted: with colon");
    expect(a.why).toBe("because.");
    expect(a.tags).toEqual(["from:-Users-me-repo", "b"]);
    expect(a.createdAt).toBe("2026-09-10T11:01:25.988Z");
    expect(plan.skipped.map((s) => s.reason)).toEqual(["no recognised type (missing)"]);
  });

  it("lets a top-level field win over a nested one", () => {
    expect(parseFrontmatter("---\ntype: user\nmetadata:\n  type: project\n---\nx").fields.type).toBe("user");
    expect(extractWhy("no why here")).toBeNull();
  });
});

describe("session-start block", () => {
  const keys = { slugs: [pathSlug("/work/repo")], repoName: "repo" };

  it("stays within the budget, leaves out superseded and foreign records, and says how many it cut", () => {
    const records = [
      ...Array.from({ length: 60 }, (_, i) => record({ id: `g${i}`, description: "x".repeat(150) })),
      record({ id: "mine", kind: "project", scope: `project:${pathSlug("/work/repo")}`, description: "local fact" }),
      record({ id: "moved", kind: "project", scope: "project:-old-place-repo", description: "same repo, old path" }),
      record({ id: "other", kind: "project", scope: "project:-elsewhere", description: "not ours" }),
      record({ id: "old", supersededBy: "g1", description: "superseded" }),
    ];
    const block = buildContext(records, keys, 800);
    expect(block.tokens).toBeLessThanOrEqual(800);
    expect(block.text).toContain("local fact");
    expect(block.text).toContain("same repo, old path");
    expect(block.text).not.toContain("not ours");
    expect(block.text).not.toContain("superseded");
    expect(block.eligible).toBe(62);
    expect(block.text).toMatch(/\(\d+ more not shown within the 800-token budget/);
    const hook = JSON.parse(renderHookOutput(block));
    expect(hook.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: block.text });
    expect(estimateTokens(block.text)).toBe(block.tokens);
  });

  it("matches a moved checkout by repository name only as a whole path segment", () => {
    expect(scopeRelation("project:-a-b-repo", keys)).toBe("project");
    expect(scopeRelation("project:-a-b-myrepo", keys)).toBeNull();
  });
});

describe("recall", () => {
  it("drops stop words and finds the record by its content words", () => {
    expect(ftsQuery("What is the deploy story?")).toBe('"deploy" OR "story"');
    expect(ftsQuery("is it the?")).toBeNull();
    const hits = recall(
      [
        record({ id: "a", body: "Running the nightly export rebuilds the search cache within ten minutes." }),
        record({ id: "b", body: "Use bun, never npm." }),
      ],
      "what happens when I run the nightly export?",
    );
    expect(hits.map((h) => h.record.id)).toEqual(["a"]);
  });
});
