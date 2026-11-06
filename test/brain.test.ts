/**
 * The brain POC's pure parts: the memory-file parser, the session-start block's budget and
 * ranking, and recall. Sync is `brain-sync.test.ts`; the Worker half is in `worker/test`.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, renderHookOutput } from "../src/brain/context.js";
import { extractWhy, parseFrontmatter, planImport } from "../src/brain/import.js";
import { ftsQuery, recall } from "../src/brain/recall.js";
import { pathSlug, scopeRelation } from "../src/brain/scope.js";
import { estimateTokens, type BrainRecord } from "../src/brain/types.js";
import { buildTurn } from "../src/brain/turn.js";
import { citedIn } from "../src/brain/cite.js";
import { computeStats } from "../src/brain/stats.js";
import { agentOf, isExpired, normalizeConfig, syncsScope } from "../src/brain/config.js";
import { hookTarget, installHooks, removeHooks } from "../src/brain/hooks-install.js";
import { computeOverview } from "../src/brain/overview.js";

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

describe("per-prompt turn retrieval", () => {
  const records = [
    record({ id: "seed", kind: "project", name: "tests-need-seed", body: "Run the demo tests with DEMO_LEGACY_SEED=42 or they fail with a fixture checksum mismatch." }),
    record({ id: "tag", kind: "project", name: "release-tag-format", body: "Release tags are named rel-YYYYMMDD-shortsha; CI rejects anything else." }),
  ];

  it("injects a strong match once per session and nothing below the floor", () => {
    const first = buildTurn(records, "the demo tests fail with a fixture checksum mismatch, how do I run them?", { minScore: 0 });
    expect(first.ids).toEqual(["seed"]);
    expect(first.text).toContain("DEMO_LEGACY_SEED=42");
    const again = buildTurn(records, "the demo tests fail with a fixture checksum mismatch, how do I run them?", { minScore: 0, seen: new Set(first.ids) });
    expect(again.ids).toEqual([]);
    expect(again.skippedAsSeen).toBe(1);
    expect(again.text).toBe("");
    expect(buildTurn(records, "write a haiku about autumn").ids).toEqual([]);
  });
});

describe("citations", () => {
  const shown = [record({ id: "49aa9815-0000", name: "demo-repo-tests-need-legacy-seed" }), record({ id: "93294a45-0000", name: "tag" })];

  it("counts an explicit citation, a distinctive name or a short id, and not a common word", () => {
    expect(citedIn("Used the saved requirement. [brain:demo-repo-tests-need-legacy-seed]", shown)).toEqual(["49aa9815-0000"]);
    expect(citedIn("per demo-repo-tests-need-legacy-seed", shown)).toEqual(["49aa9815-0000"]);
    expect(citedIn("see 93294a45 for the format", shown)).toEqual(["93294a45-0000"]);
    expect(citedIn("I will tag the commit", shown)).toEqual([]);
  });
});

describe("stats", () => {
  it("counts usage, hit rates and latency from the log", () => {
    const records = [record({ id: "a", name: "a-rule" }), record({ id: "b", name: "b-rule", provisional: true })];
    const at = NOW;
    const stats = computeStats(records, [
      { at, event: "session_start", provider: "claude", session: "s1", promptHash: null, recordIds: ["a"], tokens: 1400, latencyMs: 60, detail: null },
      { at, event: "turn", provider: "claude", session: "s1", promptHash: "h", recordIds: [], tokens: 0, latencyMs: 70, detail: null },
      { at, event: "turn", provider: "claude", session: "s1", promptHash: "h2", recordIds: ["a"], tokens: 300, latencyMs: 80, detail: null },
      { at, event: "recall", provider: "codex", session: null, promptHash: "h3", recordIds: [], tokens: null, latencyMs: 20, detail: null },
      { at, event: "cite", provider: "claude", session: "s1", promptHash: null, recordIds: ["a"], tokens: null, latencyMs: 50, detail: null },
    ], Date.parse(NOW));
    expect(stats.usage.sessions).toBe(1);
    expect(stats.usage.avgTokens).toEqual({ sessionStart: 1400, turn: 300 });
    expect(stats.usage.turnInjectionRate).toBe(0.5);
    expect(stats.usage.recallHitRate).toBe(0);
    expect(stats.usage.mostUsed[0]).toMatchObject({ id: "a", uses: 2, cites: 1 });
    expect(stats.usage.neverUsed.map((r) => r.id)).toEqual(["b"]);
    expect(stats.health.provisional).toBe(1);
    expect(stats.usage.latency.turn).toEqual({ n: 2, p50: 80, p95: 80 });
  });
});

describe("brain policy", () => {
  it("normalizes a partial or malformed config to whole defaults", () => {
    const c = normalizeConfig({ writePolicy: "nonsense", budgets: { turnMs: 5 }, sync: { scopes: ["global", "bogus", "project:-x"] } });
    expect(c.writePolicy).toBe("auto");
    expect(c.budgets.turnMs).toBe(50);
    expect(c.sync.scopes).toEqual(["global", "project:-x"]);
    expect(c.agents.codex).toEqual({ enabled: true, write: true });
  });

  it("keeps a left-out scope local and expires an old provisional record", () => {
    const c = normalizeConfig({ sync: { enabled: true, scopes: ["global"] }, provisionalExpiryDays: 30 });
    expect(syncsScope(c, "global")).toBe(true);
    expect(syncsScope(c, "project:-x")).toBe(false);
    expect(syncsScope(normalizeConfig({ sync: { enabled: false } }), "global")).toBe(false);
    expect(isExpired(c, { provisional: true, createdAt: "2026-01-01T00:00:00.000Z" }, Date.parse(NOW))).toBe(true);
    expect(isExpired(c, { provisional: false, createdAt: "2026-01-01T00:00:00.000Z" }, Date.parse(NOW))).toBe(false);
    expect(agentOf("codex-mcp-client")).toBe("codex");
    expect(agentOf("some-ide")).toBe("mcp");
  });
});

describe("hook installs", () => {
  it("refuses the user's real config home and an unset one, and round-trips an isolated one", () => {
    const real = { CLAUDE_CONFIG_DIR: join(userInfo().homedir, ".claude") };
    expect(hookTarget("claude", real).refusal).toMatch(/real Claude Code home/);
    expect(() => installHooks("claude", "/x/brain.mjs", "/x/brain.db", real)).toThrow(/real Claude Code home/);
    expect(hookTarget("codex", {}).refusal).toMatch(/CODEX_HOME is not set/);

    const home = mkdtempSync(join(tmpdir(), "brain-hooks-"));
    const bundle = join(home, "brain.mjs");
    writeFileSync(bundle, "");
    writeFileSync(join(home, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] } }));
    const env = { CODEX_HOME: home };
    const installed = installHooks("codex", bundle, "/x/brain.db", env);
    expect(installed.events).toEqual({ SessionStart: true, UserPromptSubmit: true, Stop: true });
    // Installing twice does not duplicate; the user's own hooks stay.
    installHooks("codex", bundle, "/x/brain.db", env);
    const file = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
    expect(file.hooks.SessionStart).toHaveLength(1);
    expect(file.hooks.Stop.map((g: { hooks: Array<{ command: string }> }) => g.hooks[0]!.command.includes("brain.mjs"))).toEqual([false, true]);
    const removed = removeHooks("codex", env);
    expect(removed.events).toEqual({ SessionStart: false, UserPromptSubmit: false, Stop: false });
    expect(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command).toBe("other-tool");
  });
});

describe("overview", () => {
  it("reports the worst check, off when the brain is off, and leaves probes and config saves out", () => {
    const records = [record({ id: "a", name: "a-rule" })];
    const usage = [
      { at: NOW, event: "session_start" as const, provider: "claude", session: "s1", promptHash: null, recordIds: ["a"], tokens: 1400, latencyMs: 60, detail: { eligible: 3 } },
      { at: NOW, event: "turn" as const, provider: "probe", session: "p1", promptHash: "h", recordIds: ["a"], tokens: 300, latencyMs: 900, detail: null },
      { at: NOW, event: "remember" as const, provider: "web", session: null, promptHash: null, recordIds: [], tokens: null, latencyMs: null, detail: { config: true } },
    ];
    const hooks = [
      { agent: "claude" as const, label: "Claude Code", home: "/h", file: "/h/settings.json", refusal: null, events: { SessionStart: true, UserPromptSubmit: true, Stop: true } },
      { agent: "codex" as const, label: "Codex", home: "/c", file: "/c/hooks.json", refusal: null, events: { SessionStart: false, UserPromptSubmit: false, Stop: false } },
    ];
    const o = computeOverview(records, usage, normalizeConfig({}), hooks, { now: Date.parse(NOW) + 60_000 });
    expect(o.verdict).toBe("warn");
    expect(o.checks.find((c) => c.id === "hooks-codex")?.severity).toBe("warn");
    expect(o.checks.find((c) => c.id === "latency")).toBeUndefined();
    expect(o.agents.map((a) => a.agent)).toEqual(["claude"]);
    expect(o.budget.utilization).toBe(0.93);
    expect(computeOverview(records, usage, normalizeConfig({ enabled: false }), hooks).verdict).toBe("off");
  });
});
