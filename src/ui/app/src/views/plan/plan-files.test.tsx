/**
 * The Plan files tray: groups in working order, a row per plan file with what it is to the
 * tracker and the actions its state offers (Import and Ignore for a new one, Import again for a
 * changed one, Unignore for an ignored one, none for an imported one), Select all leaving done
 * plans and the ones that cannot be imported out, and the entry under the Import form.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanFileData } from "@/lib/plan-types";
import { ImportForm } from "./ImportIdea";
import { FILE_GROUPS, importable, pathsText, PlanFileRow, selectAllOf, textPaths } from "./PlanFiles";

const file = (path: string, patch: Partial<PlanFileData> = {}): PlanFileData => ({
  path,
  kind: "file",
  main: path,
  files: [path],
  format: "markdown",
  title: path.split("/").pop()!,
  status: null,
  done: false,
  hash: `sha256:${"a".repeat(64)}`,
  bytes: 10,
  problem: null,
  state: "new",
  idea: null,
  changedSinceImport: false,
  alsoImportedAs: [],
  ...patch,
});

const row = (data: PlanFileData) =>
  renderToStaticMarkup(<ul><PlanFileRow file={data} picked={false} busy={false} onPick={() => {}} onImport={() => {}} onIgnore={() => {}} onOpenIdea={() => {}} /></ul>);

describe("the Plan files tray", () => {
  it("groups new, changed since import, imported and ignored, in that order", () => {
    expect(FILE_GROUPS.map((group) => [group.state, group.label])).toEqual([
      ["new", "New"],
      ["changed", "Changed since import"],
      ["imported", "Imported"],
      ["ignored", "Ignored"],
    ]);
  });

  it("offers Import and Ignore on a new file, Import again on a changed one, Unignore on an ignored one and nothing on an imported one", () => {
    const fresh = row(file("plans/a.md"));
    expect(fresh).toContain("data-plan-file-pick");
    expect(fresh).toContain(">Import</button>");
    expect(fresh).toContain("data-plan-file-ignore");
    const idea = { id: "i1", number: "I-STA-3", identifier: null, title: "A" };
    const changed = row(file("plans/a.md", { state: "changed", idea, changedSinceImport: true }));
    expect(changed).toContain(">Import again</button>");
    expect(changed).toContain("changed since imported as ");
    expect(changed).toContain(">I-STA-3</button>");
    const imported = row(file("plans/a.md", { state: "imported", idea: { ...idea, identifier: "STA-40" } }));
    expect(imported).not.toContain("data-plan-file-import");
    expect(imported).not.toContain("data-plan-file-pick");
    expect(imported).toContain(">STA-40</button>");
    const ignored = row(file("plans/a.md", { state: "ignored" }));
    expect(ignored).toContain("data-plan-file-unignore");
    expect(ignored).not.toContain("data-plan-file-import");
  });

  it("says an ignored file changed since its import, names a second import of the same file, and gives every row its own id", () => {
    const idea = { id: "i1", number: "I-STA-3", identifier: null, title: "A" };
    expect(row(file("plans/a.md", { state: "ignored", idea, changedSinceImport: true }))).toContain("changed since imported as ");
    const twice = row(file("plans/a.md", { state: "imported", idea, alsoImportedAs: [{ id: "i2", number: "I-STA-4", identifier: null, title: "A" }] }));
    expect(twice).toContain("also as");
    expect(twice).toContain(">I-STA-4</button>");
    const both = renderToStaticMarkup(
      <ul>
        <PlanFileRow file={file("plans/dup1.md")} picked={false} busy={false} onPick={() => {}} onImport={() => {}} onIgnore={() => {}} onOpenIdea={() => {}} />
        <PlanFileRow file={file("plans/dup2.md")} picked={false} busy={false} onPick={() => {}} onImport={() => {}} onIgnore={() => {}} onOpenIdea={() => {}} />
      </ul>,
    );
    const ids = [...both.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("shows a folder's files, a done status and why a file cannot be imported", () => {
    const folder = row(file("plans/sso", { kind: "folder", files: ["plans/sso/sso.md", "plans/sso/assets/a.jsx"], done: true, status: "Implemented" }));
    expect(folder).toContain("folder · 2 files");
    expect(folder).toContain("done (Implemented)");
    const broken = row(file("plans/big.md", { problem: "plans/big.md is over 32 MiB" }));
    expect(broken).toContain("Cannot import: plans/big.md is over 32 MiB");
    expect(broken).toMatch(/data-plan-file-import[^>]*disabled|disabled[^>]*data-plan-file-import/);
  });

  it("selects every importable file but the done ones, and nothing imported, ignored or broken", () => {
    const files = [
      file("a.md"),
      file("b.md", { done: true }),
      file("c.md", { state: "changed" }),
      file("d.md", { state: "imported" }),
      file("e.md", { state: "ignored" }),
      file("f.md", { problem: "empty" }),
    ];
    expect(selectAllOf(files)).toEqual(["a.md", "c.md"]);
    expect(files.filter(importable).map((entry) => entry.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("edits the paths one per line, dropping blank lines", () => {
    expect(pathsText(["*.md", "plans/**"])).toBe("*.md\nplans/**");
    expect(textPaths(" *.md \n\nplans/**\n  ")).toEqual(["*.md", "plans/**"]);
  });

  it("is offered under the Import form when the view gives it a way to open", () => {
    const withTray = renderToStaticMarkup(<ImportForm onImport={async () => true} onViewIdeas={() => {}} onDone={() => {}} onPlanFiles={() => {}} />);
    expect(withTray).toContain("data-plan-files-open");
    expect(withTray).toContain("Plan files in this workspace…");
    expect(renderToStaticMarkup(<ImportForm onImport={async () => true} onViewIdeas={() => {}} onDone={() => {}} />)).not.toContain("data-plan-files-open");
  });
});
