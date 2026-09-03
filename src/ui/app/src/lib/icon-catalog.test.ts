/**
 * THE CATALOG CONTRACT — R5b (STA-182).
 *
 * What the picker (STA-184) and the persisted kind appearance (STA-181) rely on:
 *
 *   - the manifest is generated from the PINNED `lucide-react` — its version string is
 *     the installed one, and every key carries a label, search terms, and a category;
 *   - aliases are collapsed, not duplicated: an alias is never a key, always maps to a
 *     key, and `resolveIcon` treats alias, canonical, and sloppy input the same way;
 *   - search is ranked and deterministic — exact key first, then whole-word, prefix,
 *     alias-word, substring — and an empty query is the catalog itself;
 *   - and EVERY key resolves to a bundled icon: the previews module is rendered here,
 *     key by key, to static markup. Typecheck proves the names exist; this proves they
 *     draw.
 *
 * Rendered with `react-dom/server`, the pattern the row tests use; no DOM needed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ICON_ALIASES,
  ICON_CATEGORIES,
  LUCIDE_VERSION,
  iconCatalog,
  iconLabel,
  isIconKey,
  loadIconComponent,
  loadIconComponents,
  normalizeIconKey,
  resolveIcon,
  searchIcons,
} from "./icon-catalog";
import { ICON_COMPONENTS } from "./icon-previews.generated";

const installedLucideVersion = (
  createRequire(import.meta.url)("lucide-react/package.json") as { version: string }
).version;

describe("icon catalog manifest", () => {
  it("is generated from the pinned lucide-react version", () => {
    expect(LUCIDE_VERSION).toBe(installedLucideVersion);
  });

  it("carries a label, search terms, and a category for every key", () => {
    const entries = iconCatalog();
    expect(entries.length).toBeGreaterThan(1000);
    for (const entry of entries) {
      expect(entry.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.terms.length).toBeGreaterThan(0);
      expect([...entry.terms]).toEqual([...new Set(entry.terms)].sort());
      expect(ICON_CATEGORIES).toContain(entry.category);
    }
  });

  it("keeps keys unique and sorted", () => {
    const keys = iconCatalog().map((entry) => entry.key);
    expect(keys).toEqual([...new Set(keys)].sort());
  });

  it("collapses aliases deterministically: never a key, always onto exactly one key", () => {
    expect(Object.keys(ICON_ALIASES).length).toBeGreaterThan(0);
    for (const [alias, canonical] of Object.entries(ICON_ALIASES)) {
      expect(isIconKey(alias)).toBe(false);
      expect(isIconKey(canonical)).toBe(true);
      expect(resolveIcon(canonical)?.aliases).toContain(alias);
    }
    const recorded = iconCatalog().flatMap((entry) => entry.aliases);
    expect(recorded).toEqual([...new Set(recorded)]);
    expect(recorded).toHaveLength(Object.keys(ICON_ALIASES).length);
    expect(ICON_ALIASES["alert-triangle"]).toBe("triangle-alert");
    expect(ICON_ALIASES["home"]).toBe("house");
  });

  it("labels are the title-cased words of the key", () => {
    expect(iconLabel("a-arrow-down")).toBe("A Arrow Down");
    expect(resolveIcon("grid-2x2")?.label).toBe("Grid 2x2");
  });

  it("folds alias words into the canonical entry's search terms", () => {
    expect(resolveIcon("house")?.terms).toContain("home");
  });
});

describe("resolveIcon", () => {
  it("answers canonical keys, aliases, and loosely typed names with the same entry", () => {
    const canonical = resolveIcon("triangle-alert");
    expect(canonical?.key).toBe("triangle-alert");
    expect(canonical?.label).toBe("Triangle Alert");
    expect(resolveIcon("alert-triangle")).toBe(canonical);
    expect(resolveIcon("  Triangle Alert ")).toBe(canonical);
    expect(resolveIcon("triangle_alert")).toBe(canonical);
  });

  it("is undefined for anything the bundle cannot draw", () => {
    expect(resolveIcon("not-an-icon")).toBeUndefined();
    expect(resolveIcon("")).toBeUndefined();
    expect(normalizeIconKey(" Alert  Triangle ")).toBe("alert-triangle");
  });
});

describe("searchIcons", () => {
  it("lists the whole catalog for an empty query", () => {
    expect(searchIcons("")).toEqual([...iconCatalog()]);
    expect(searchIcons("   ")).toHaveLength(iconCatalog().length);
  });

  it("puts the exact key first, then whole-word hits ordered plainest first", () => {
    const keys = searchIcons("bug").map((entry) => entry.key);
    expect(keys[0]).toBe("bug");
    expect(keys.slice(1, 3)).toEqual(["bug-off", "bug-play"]);
    expect(searchIcons("check").map((entry) => entry.key)[0]).toBe("check");
  });

  it("matches an alias as an exact hit on the canonical icon", () => {
    expect(searchIcons("alert triangle")[0]?.key).toBe("triangle-alert");
    expect(searchIcons("home")[0]?.key).toBe("house");
  });

  it("ranks prefixes and substrings after whole words, and is deterministic", () => {
    const first = searchIcons("tri");
    expect(first[0]?.key).toBe("triangle");
    expect(first.every((entry) => entry.key.includes("tri") || entry.terms.some((term) => term.includes("tri")))).toBe(true);
    expect(searchIcons("tri")).toEqual(first);
  });

  it("filters by category and honours a limit", () => {
    const arrows = searchIcons("", { category: "arrows" });
    expect(arrows.length).toBeGreaterThan(0);
    expect(arrows.every((entry) => entry.category === "arrows")).toBe(true);
    expect(searchIcons("arrow", { limit: 5 })).toHaveLength(5);
    expect(searchIcons("bug", { category: "weather" })).toEqual([]);
  });

  it("returns nothing for a query no icon carries", () => {
    expect(searchIcons("zzzz-not-there")).toEqual([]);
  });
});

describe("every key resolves to a bundled icon", () => {
  it("renders each catalog key through its lucide-react component", () => {
    for (const entry of iconCatalog()) {
      const Component = ICON_COMPONENTS[entry.key];
      expect(Component, entry.key).toBeDefined();
      const markup = renderToStaticMarkup(createElement(Component, { size: 16 }));
      expect(markup, entry.key).toContain("<svg");
      expect(markup, entry.key).toContain(`lucide-${entry.key}`);
    }
  });

  it("has no component the catalog does not name", () => {
    expect(Object.keys(ICON_COMPONENTS).sort()).toEqual(iconCatalog().map((entry) => entry.key));
  });

  it("loads a component lazily by canonical key or alias", async () => {
    const components = await loadIconComponents();
    expect(components).toBe(ICON_COMPONENTS);
    expect(await loadIconComponent("alert-triangle")).toBe(ICON_COMPONENTS["triangle-alert"]);
    expect(await loadIconComponent("nope")).toBeUndefined();
  });
});
