/**
 * The picker's one call to the server — R5d (STA-184).
 *
 * `POST /api/glyph/sanitize` is core's `sanitizeSvg` over HTTP, and it exists because
 * the store accepts an `svg` appearance ONLY as that function's canonical output while
 * the function itself is Node-only code the browser cannot import. This adapter turns
 * the route into the shape `GlyphPicker` wants: the canonical document, or the
 * sanitiser's own refusal sentence through `describeRefusal`, never a paraphrase.
 *
 * It is a separate module from the component so a test can render the picker with its
 * own `sanitize` and never touch fetch — the same reason `applyTo` is a prop everywhere
 * else in this directory.
 */
import { sanitizeGlyphSvg } from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type { SanitizeSvg } from "./GlyphPicker";

export const sanitizeThroughServer: SanitizeSvg = async (input) => {
  try {
    const { svg } = await sanitizeGlyphSvg(input);
    return { ok: true, svg };
  } catch (error) {
    return { ok: false, problem: describeRefusal(error).message };
  }
};
