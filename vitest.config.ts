/**
 * The one thing vitest needed to be able to render a component: the browser app's `@` alias.
 *
 * ADDED BY V5 (STA-97). Until now there was no config here at all, and every test under
 * `src/ui/app/` carried a comment explaining that it imports relatively *because* of that.
 * Those tests still work verbatim — a relative import does not care that an alias now
 * exists — so this is purely additive.
 *
 * WHY IT WAS NEEDED. §9.2 of the row spec requires a unit test that renders a row with a
 * mocked `pullRequests` array and asserts the PR badge appears; that is the only proof the
 * slot works before any git integration exists. Rendering a real row pulls in shared
 * components (`StaleClaimBadge` and friends) that import `@/lib/…` internally, so no amount
 * of discipline in V5's own files could have avoided the alias. One four-line config buys
 * component tests for every future ticket.
 *
 * DELIBERATELY NOT HERE: a jsdom environment, a setup file, and the React plugin. Vitest's
 * esbuild transform already handles `.tsx` with the automatic runtime, and the row tests
 * render to a string via `react-dom/server` rather than to a DOM. A string is enough to
 * assert what the spec asks about — which elements exist, which are absent, what the ARIA
 * names say — and it keeps the suite dependency-free and fast.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/ui/app/src", import.meta.url)) },
  },
  test: {
    /**
     * Vitest's default is 5000ms, which is wrong for this suite.
     *
     * Many tests here drive the real CLI by spawning it, and a single `it` can spawn
     * eight processes — `cli-settings`' "adds, renames, reorders and removes" does
     * exactly that. Each spawn pays Node and tsx startup, so the budget is roughly
     * 600ms per process. That is comfortable on a developer machine (the test above
     * runs in 1.4s) and marginal on a two-core CI runner executing 175 files in
     * parallel, where it times out while the code under test is perfectly healthy.
     *
     * This is not papering over slowness. The failure it was producing is a false
     * negative: the same test passes in isolation on the same commit, and adding
     * subprocess-heavy tests elsewhere in the suite — not changing the CLI — is what
     * pushed it over. A genuine hang still fails, just at 20s instead of 5s.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
