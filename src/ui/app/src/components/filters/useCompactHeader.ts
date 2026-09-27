/**
 * Is the content header in its compact (phone) form — words dropped, controls as 44px icon
 * buttons, the search folded into an icon? Below the ONE phone/desk breakpoint
 * (`DESK_QUERY` in lib/use-media.ts), so the header and the shell change register together.
 *
 * A server render answers desk; a test that stubs `window.matchMedia` (the way
 * `view-responsive.test.tsx` does) gets the width it asked for from a static render.
 */
import { DESK_QUERY, useMediaQuery } from "@/lib/use-media";

export function useCompactHeader(): boolean {
  return !useMediaQuery(DESK_QUERY, true);
}
