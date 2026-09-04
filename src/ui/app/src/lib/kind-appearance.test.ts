/**
 * R5a (STA-181) — the built-in marks against the generated catalog.
 *
 * Core validates that a `lucide` value is SHAPED like a key; only the browser
 * holds the catalog that says whether it exists. So the one claim that must be
 * proven here, and cannot be proven in `test/kind-appearance.test.ts`, is that
 * every built-in mark names a CANONICAL key — the catalog's own, not an alias —
 * so the persisted value and the rendered icon can never drift. The mirror's
 * parity with core is held on the Node side, which can import both.
 */
import { describe, expect, it } from "vitest";
import { resolveIcon } from "./icon-catalog";
import { BUILTIN_KIND_APPEARANCE, GENERIC_KIND_FALLBACK, fallbackKindAppearance } from "./kind-appearance";

describe("the built-in marks", () => {
  it("each name a canonical Lucide key the catalog resolves to itself", () => {
    for (const [id, mark] of Object.entries(BUILTIN_KIND_APPEARANCE)) {
      expect(mark.source, id).toBe("lucide");
      expect(resolveIcon(mark.value)?.key, `${id} -> ${mark.value}`).toBe(mark.value);
    }
  });

  it("fall back to the generic mark for a kind nobody has given one", () => {
    expect(fallbackKindAppearance({ id: "epic", label: "Epic" })).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    expect(fallbackKindAppearance({ id: "research", label: "Research" })).toEqual({
      source: "none",
      value: "",
      label: "Research",
      fallback: GENERIC_KIND_FALLBACK,
    });
  });
});
