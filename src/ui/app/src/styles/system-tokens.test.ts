/**
 * The shared visual system is ONE sheet, loaded after the Geist layer, and every name the
 * shell and the views are told to use is defined in it. A source read: the build turns these
 * into utilities (`text-body`, `h-topbar`, `bg-surface-raised`, `focus-ring`), and a name that
 * vanished from the sheet would silently render as nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const sheet = read("./system-tokens.css");
const app = read("./app.css");

describe("the system token sheet", () => {
  it("is imported after the Geist layer, so it can add names without being overruled", () => {
    const geist = app.indexOf('@import "./geist-tokens.css"');
    const system = app.indexOf('@import "./system-tokens.css"');
    expect(geist).toBeGreaterThan(-1);
    expect(system).toBeGreaterThan(geist);
  });

  it("defines the seven-step type scale, each with its line height", () => {
    for (const [step, size, leading] of [
      ["caption", 11, 14],
      ["label", 12, 16],
      ["body", 13, 20],
      ["reading", 14, 22],
      ["title", 15, 22],
      ["heading", 18, 26],
      ["display", 24, 30],
    ] as const) {
      expect(sheet).toContain(`--text-${step}: ${size}px;`);
      expect(sheet).toContain(`--text-${step}--line-height: ${leading}px;`);
    }
  });

  it("names the shell geometry, the readable widths, the surfaces and the focus ring", () => {
    for (const name of [
      "--spacing-rail:",
      "--spacing-topbar:",
      "--spacing-toolbar:",
      "--spacing-gutter:",
      "--spacing-page:",
      "--spacing-control-md:",
      "--container-readable:",
      "--container-wide:",
      "--container-page:",
      "--color-surface-canvas:",
      "--color-surface-raised:",
      "--color-surface-sunken:",
      "--color-surface-overlay:",
      "--color-scrim:",
      "--color-text-secondary:",
      "--focus-ring-color: var(--ring);",
      "@utility focus-ring {",
      "@utility focus-ring-inset {",
    ]) {
      expect(sheet, name).toContain(name);
    }
  });

  it("gives dark mode its own sunken surface, scrim and secondary text", () => {
    const dark = sheet.slice(sheet.indexOf(".dark {"));
    for (const name of ["--surface-sunken:", "--scrim:", "--text-secondary:"]) expect(dark, name).toContain(name);
  });

  it("widens the rail and the page padding on wide screens instead of leaving them idle", () => {
    expect(sheet).toMatch(/@media \(min-width: 1680px\)[\s\S]*?--shell-rail-width: 264px;[\s\S]*?--page-pad-x: 32px;/);
  });
});
