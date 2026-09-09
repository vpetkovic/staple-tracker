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
import type { HubCloudReport } from "../src/core/cloud/hub-surface.js";
import type { ConnectPreview } from "../src/core/cloud/preview.js";
import type { RemoteDevice } from "../src/core/cloud/client.js";
import type {
  ClaimActivity as UiClaimActivity,
  ClaimLease as UiClaimLease,
  ClaimScope as UiClaimScope,
  CloudSurfaceReport as UiCloudSurfaceReport,
  ConnectPreview as UiConnectPreview,
  HubCloudReport as UiHubCloudReport,
  RemoteDevice as UiRemoteDevice,
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
/**
 * S13 (STA-258): the two types the cloud SECTION renders, now that the page can
 * mutate cloud state and not merely read it.
 *
 * `ConnectPreview` earns its place by the file's own rule — "the types where a
 * silent divergence has a real cost" — more clearly than anything already here.
 * The preview IS the consent mechanism: *"showing the endpoint and repository
 * identity before any remote call is the consent mechanism, not a courtesy."* A
 * field dropped from the mirror is not a stale type, it is a disclosure that
 * stopped being made — `credentialFallbackReason` is the sentence explaining that
 * the secret is about to land in a file because the keychain would not open, and
 * a consent screen that silently stopped saying so is the failure this whole lane
 * is built to prevent.
 *
 * `RemoteDevice` because revoke acts on a row of it, and a mirror that had drifted
 * on `self` would put the "this is the machine you are using" warning on the wrong
 * row.
 */
type _ConnectPreviewMatches = Expect<Equals<ConnectPreview, UiConnectPreview>>;
type _RemoteDeviceMatches = Expect<Equals<RemoteDevice, UiRemoteDevice>>;

/**
 * S16 (STA-275): the hub-wide list, which the settings section renders as a
 * table of every registered workspace.
 *
 * It earns its place by the file's own rule twice over, and the second reason is
 * the load-bearing one.
 *
 * `state` here is a deliberate SUBSET of `CloudSurfaceReport["state"]` —
 * `offline` and `revoked` are absent because the route that produces this makes
 * no authenticated round trip and therefore cannot establish them. A mirror that
 * drifted wider would let the page write a branch for a state the server can
 * never send, and the natural next step from an unreachable branch is somebody
 * "fixing" it by making the route probe.
 *
 * `credentialPresent` is `boolean | null` here against `boolean` on the
 * single-workspace report, and the null means NOT ASKED. A mirror that narrowed
 * it to `boolean` would make `null` read as falsy, and the page would render
 * "no credential" for every workspace on a surface that deliberately never
 * looked — which is the difference between "your credential is gone" and "we did
 * not check".
 */
type _HubCloudReportMatches = Expect<Equals<HubCloudReport, UiHubCloudReport>>;

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
      true satisfies _ConnectPreviewMatches,
      true satisfies _RemoteDeviceMatches,
      true satisfies _HubCloudReportMatches,
    ];
    // GOLDEN, moved by S13 (STA-258): 4 -> 6. The two additions are the connect
    // preview and the device row; see the comment above them.
    // GOLDEN, moved by S16 (STA-275): 6 -> 7. The addition is the hub-wide
    // workspace list; see the comment above it.
    expect(proofs).toHaveLength(7);
  });
});
