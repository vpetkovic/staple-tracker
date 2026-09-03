import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_MODULE_PATH,
  CATEGORY_KEYWORDS,
  PREVIEWS_MODULE_PATH,
  buildCatalog,
  catalogModuleSource,
  previewsModuleSource,
  readInstalledLucide,
} from "../scripts/gen-lucide-catalog.js";

/**
 * The checked-in glyph catalog must be what the generator would write TODAY.
 *
 * `src/ui/app/src/lib/icon-catalog.generated.ts` and `icon-previews.generated.ts`
 * are derived from the installed `lucide-react`, never hand-edited. Bumping the
 * package, or touching the category table in the generator, changes what should be
 * on disk — and a stale manifest is exactly the kind of drift nobody notices until a
 * persisted kind icon stops resolving. So this test regenerates in memory and diffs
 * against the file, the same discipline `migrations-schema-equivalence.test.ts`
 * applies to the DDL snapshots.
 */

const regenerationHint =
  "\n\nThe generated Lucide glyph catalog has drifted from the installed lucide-react " +
  "package or the generator. Regenerate it:\n\n" +
  "    npx tsx scripts/gen-lucide-catalog.ts\n";

describe("lucide catalog freshness", () => {
  const catalog = buildCatalog();

  it("is generated from the installed lucide-react version", () => {
    expect(catalog.version).toBe(readInstalledLucide().version);
    expect(catalog.icons.length).toBeGreaterThan(1000);
  });

  it("collapses every alias onto exactly one canonical key", () => {
    const keys = new Set(catalog.icons.map((icon) => icon.key));
    const seen = new Set<string>();
    for (const icon of catalog.icons) {
      for (const alias of icon.aliases) {
        expect(keys.has(alias), alias).toBe(false);
        expect(seen.has(alias), `${alias} recorded twice`).toBe(false);
        seen.add(alias);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("is reproducible: two runs are identical", () => {
    expect(buildCatalog()).toEqual(catalog);
  });

  it("keeps the category table in kebab words, so a rule can only ever match a whole segment", () => {
    for (const [category, keywords] of CATEGORY_KEYWORDS) {
      expect(category).toMatch(/^[a-z]+$/);
      for (const keyword of keywords) expect(keyword, category).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("matches the checked-in manifest module", () => {
    expect(readFileSync(CATALOG_MODULE_PATH, "utf8"), regenerationHint).toBe(catalogModuleSource(catalog));
  });

  it("matches the checked-in previews module", () => {
    expect(readFileSync(PREVIEWS_MODULE_PATH, "utf8"), regenerationHint).toBe(previewsModuleSource(catalog));
  });
});
