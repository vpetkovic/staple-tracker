/**
 * R5e (STA-185) — the kind glyph in the TERMINAL.
 *
 * The epic's criterion is that rows, groups, forms, graph nodes, the CLI and MCP resolve
 * ONE appearance. The browser half is proved in
 * `src/ui/app/src/components/task-list/kind-glyph.test.tsx`; this is the terminal half,
 * and the thing it has to pin is that the CLI draws the `fallback` field of that same
 * resolved record — never the `value`, which for a Lucide key or an SVG document is not
 * text a pipe can render at all.
 *
 * Run through the real binary, like `cli-settings.test.ts`, because the value of this
 * surface is the printed shape. The characterisation suite
 * (`characterize-cli-human-output.test.ts`) pins the DEFAULT workspace's bytes; this file
 * pins the CONFIGURED ones — a custom kind and an operator-chosen fallback — which is
 * where a hard-coded table would show.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";

let home: string;
let dbPath: string;

function staple(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/cli.ts", ...args, "--db", dbPath],
    {
      env: { ...process.env, STAPLE_HOME: home, STAPLE_AGENT: "glyph-test", NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
    },
  );
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

const rowFor = (out: string, title: string) => out.split("\n").find((l) => l.includes(title))!;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-cli-glyph-"));
  process.env.STAPLE_HOME = home;
  const ws = initWorkspace({ global: true, slug: "glyphs" });
  dbPath = ws.dbPath;

  // One issue per seeded kind, plus a kind the vocabulary did not ship with.
  ws.store.addKind({ id: "research", label: "Research" });
  ws.store.createIssue({ title: "The epic", kind: "epic" });
  const task = ws.store.createIssue({ title: "The task", kind: "task", parent: "GLY-1" });
  ws.store.createIssue({ title: "The bug", kind: "bug" });
  ws.store.createIssue({ title: "The chore", kind: "chore" });
  ws.store.createIssue({ title: "The spike", kind: "spike" });
  ws.store.createIssue({ title: "The study", kind: "research" });

  // Two customised kinds: an emoji (whose `value` a terminal must NOT print, because it
  // is double-width and would shift the column) and a Lucide key on the new kind.
  ws.store.setSetting("kinds.appearance", {
    bug: { source: "emoji", value: "🐞", label: "Defect", fallback: "!" },
    research: { source: "lucide", value: "flask-conical", label: "Research", fallback: "⚗" },
  });
  expect(task.identifier).toBe("GLY-2");
  ws.store.db.close();
});

afterAll(() => {
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("ls, tree and show lead each row with the kind's terminal fallback", () => {
  it("draws the seeded fallback for every seeded kind", () => {
    const out = staple("ls").stdout;
    expect(rowFor(out, "The epic")).toMatch(/^◆ /);
    expect(rowFor(out, "The task")).toMatch(/^◇ /);
    expect(rowFor(out, "The chore")).toMatch(/^↻ /);
    expect(rowFor(out, "The spike")).toMatch(/^↯ /);
  });

  it("draws a CONFIGURED fallback, not the built-in one and not the icon value", () => {
    const out = staple("ls").stdout;
    // The operator set `!` for bug; the seeded fallback is `✱` and the value is an emoji.
    expect(rowFor(out, "The bug")).toMatch(/^! /);
    expect(out).not.toContain("🐞");
    // A kind the vocabulary did not ship with, with its own chosen fallback.
    expect(rowFor(out, "The study")).toMatch(/^⚗ /);
    expect(out).not.toContain("flask-conical");
  });

  it("indents the glyph WITH the row in `tree`, so the hierarchy still reads", () => {
    expect(staple("tree", "GLY-1").stdout).toBe(
      ["◆ ◌  GLY-1     backlog     The epic · epic", "  ◇ ◌  GLY-2     backlog     The task", ""].join("\n"),
    );
  });

  it("leads `show`'s header and its child rows with the same mark the list used", () => {
    const lines = staple("show", "GLY-1").stdout.split("\n");
    expect(lines[0]).toBe("◆ GLY-1 · The epic");
    expect(lines.find((l) => l.includes("GLY-2"))).toBe("  ◇ ◌  GLY-2     backlog     The task");
  });

  it("leaves the non-list surfaces bare, which is why `line()` was not changed", () => {
    // `status` renders `line()` directly. If the glyph had gone into `line()` this row
    // would lead with `◇` too — and so would `new`, `done`, `checkout` and `board`.
    expect(staple("status", "GLY-4", "todo").stdout).toBe("○  GLY-4     todo        The chore · chore\n");
  });
});

describe("the canonical appearance is what `--json` carries", () => {
  it("`kinds ls --json` serves the whole resolved record for every kind", () => {
    const rows = JSON.parse(staple("kinds", "ls", "--json").stdout) as Array<{
      id: string;
      appearance: { source: string; value: string; label: string; fallback: string };
    }>;
    expect(rows.find((r) => r.id === "epic")!.appearance).toEqual({
      source: "lucide",
      value: "layers",
      label: "Epic",
      fallback: "◆",
    });
    expect(rows.find((r) => r.id === "bug")!.appearance).toEqual({
      source: "emoji",
      value: "🐞",
      label: "Defect",
      fallback: "!",
    });
  });

  it("`show --json` carries the issue's own kind appearance beside the string `kind`", () => {
    const body = JSON.parse(staple("show", "GLY-3", "--json").stdout) as {
      issue: { kind: string };
      kindAppearance: { source: string; value: string; label: string; fallback: string };
    };
    // `kind` is still the string id it has always been — additive, not a shape change.
    expect(body.issue.kind).toBe("bug");
    expect(body.kindAppearance).toEqual({ source: "emoji", value: "🐞", label: "Defect", fallback: "!" });
  });

  it("`ls --json` rows do NOT repeat it: appearance is a property of the kind", () => {
    const rows = JSON.parse(staple("ls", "--json").stdout) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty("kindAppearance");
  });
});
