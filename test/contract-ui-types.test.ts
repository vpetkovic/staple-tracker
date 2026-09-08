/**
 * The browser app's wire types, proven equal to core's at compile time.
 *
 * ## The gap this closes
 *
 * `src/ui/app/src/lib/types.ts` is a HAND-KEPT MIRROR of `src/core/types.ts`,
 * and it says so at the top: the app builds under a DOM tsconfig with
 * `moduleResolution: bundler`, and `src/core` is Node-only (`node:crypto`,
 * `node:sqlite`), so importing core into the browser build would drag Node types
 * into it.
 *
 * The reasoning is sound and the consequence was not: **nothing verified the
 * mirror.** `npm run typecheck` compiles the two sides as two separate programs
 * that never meet. `test/ui-agent-context.test.ts` compares HTTP payloads to MCP
 * payloads at runtime and passes happily with a stale UI type, because the UI
 * type never participates in a response. So a field added to core reached the
 * wire, reached the page, and the page's own type simply did not know about it —
 * with no failing test anywhere to say so. That is exactly what happened to
 * STA-75's `scope`: the only reason it was caught is that somebody went looking.
 *
 * ## Why a test file is the right place
 *
 * `tsconfig.json` excludes `src/ui/app` from the Node program, but `exclude`
 * only prunes the entry globs — a file *imported* by an included file is still
 * pulled in and checked. `test/**` is included, so this file is the one place in
 * the repository where both type worlds are legally in scope at once. Nothing is
 * imported at runtime beyond the types themselves, so this costs the app bundle
 * nothing and the browser tsconfig stays exactly as it was.
 *
 * ## Scope
 *
 * Deliberately NOT every type in the mirror. Pinning all ~40 would be a day's
 * work and would fail constantly on fields the page genuinely does not care
 * about. These are the types where a silent divergence has a real cost: the
 * claim contract, whose whole purpose is to stop a surface implying an
 * exclusivity it does not have, and the cloud report, which four surfaces are
 * now required to render from one definition. Extend it when a type joins that
 * category, not as a matter of routine.
 */
import { describe, expect, it } from "vitest";
import type { ClaimActivity, ClaimLease, ClaimScope } from "../src/core/types.js";
import type { CloudSurfaceReport } from "../src/core/cloud/surface.js";
import type {
  ClaimActivity as UiClaimActivity,
  ClaimLease as UiClaimLease,
  ClaimScope as UiClaimScope,
  CloudSurfaceReport as UiCloudSurfaceReport,
} from "../src/ui/app/src/lib/types.js";

/**
 * The same exact-equality check `src/mcp.ts` uses for its zod shapes.
 *
 * Bidirectional and modifier-sensitive: a field on one side and not the other
 * fails, a widened union fails, and an optional-vs-required difference fails.
 * Assignability alone would not — a UI type missing `scope` is still assignable
 * FROM a core type that has it, which is precisely how this drifted unnoticed.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

type _ClaimScopeMatches = Expect<Equals<ClaimScope, UiClaimScope>>;
type _ClaimLeaseMatches = Expect<Equals<ClaimLease, UiClaimLease>>;
type _ClaimActivityMatches = Expect<Equals<ClaimActivity, UiClaimActivity>>;
type _CloudReportMatches = Expect<Equals<CloudSurfaceReport, UiCloudSurfaceReport>>;

describe("the browser app's mirror of the wire vocabulary", () => {
  /**
   * The assertions above are types, and types are erased — so `vitest` would
   * report this file as passing even if `tsc` had never been run over it. This
   * `it` exists to make the file honest about what it does: the real check is
   * `npm run typecheck`, and the body here says so rather than pretending a
   * runtime expectation is doing the work.
   *
   * The four `type _…Matches` lines above fail the BUILD, not this test. If they
   * are ever deleted to "fix" a red typecheck, this test still passes and the
   * guarantee is gone — hence the comment, and hence the count below, which at
   * least fails if somebody removes them wholesale.
   */
  it("is checked by tsc, not by this assertion", () => {
    const proofs: Array<true> = [
      true satisfies _ClaimScopeMatches,
      true satisfies _ClaimLeaseMatches,
      true satisfies _ClaimActivityMatches,
      true satisfies _CloudReportMatches,
    ];
    expect(proofs).toHaveLength(4);
  });
});
