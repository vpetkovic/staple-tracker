/**
 * THE REGISTRY DISCLOSURE REACHES EVERY SURFACE, IN ONE WORDING — S22 (STA-283).
 *
 * ## The sentence
 *
 * *"a machine that publishes its registry tells the service the names, prefixes
 * and identities of every workspace on it, and that they sit together."*
 *
 * It is the whole price of the invariant the registry gave up. `hub-scope.ts`
 * says cross-repository topology *"is not this repository's business"*, and
 * publishing is precisely the act of making it the service's business. So the
 * sentence has to appear wherever the consent is granted, in the same words —
 * a disclosure reworded per surface is a disclosure whose strongest wording is
 * whichever surface a person did not read.
 *
 * ## What changed, and what this file is now for
 *
 * It briefly checked two declarations against each other: `REGISTRY_DISCLOSURE`
 * lived in `hub-registry-service.ts`, which reaches `client.ts`, and
 * `hub-surface.ts` could not import it — `hubCloudReport` is called by a route
 * the settings page POLLS, and putting the transport into a polled read's import
 * graph is the setup `hub-preview.ts` was split out of `hub-connect.ts` to
 * prevent. So the sentence was declared twice and pinned equal here.
 *
 * `opus-hubwire` then moved it into `hub-registry.ts`, the leaf, which
 * `hub-surface.ts` already imported for the backup strings. One declaration in a
 * leaf beats two that cannot drift, so that half of this file is gone.
 *
 * What remains is the part that was never about duplication: the sentence has to
 * survive the trip to each surface intact. The CLI renders it through
 * `registryDisclosure()`, which capitalises the sentence-initial letter inside a
 * block; the browser gets it on `hubCloudReport`, because it cannot import
 * `src/core` at all. Those are two different transformations of one string, and
 * this pins both to it.
 */
import { describe, expect, it } from "vitest";
import { REGISTRY_DISCLOSURE } from "../src/core/cloud/hub-registry.js";
import { registryDisclosure } from "../src/core/cloud/hub-registry-service.js";
import { hubCloudReport } from "../src/core/cloud/hub-surface.js";

describe("the registry disclosure has one wording", () => {
  it("is the sentence the CLI prints, capitalised and nothing else", () => {
    const rendered = registryDisclosure("https://sync.example.com");
    /**
     * Compared on the tail rather than the whole string, because the rendered
     * block upper-cases the first letter — which is the ONE difference allowed,
     * and is pinned to exactly that by checking the remainder verbatim.
     */
    expect(rendered).toContain(REGISTRY_DISCLOSURE.slice(1));
    expect(rendered).toContain(
      `${REGISTRY_DISCLOSURE.charAt(0).toUpperCase()}${REGISTRY_DISCLOSURE.slice(1)}`,
    );
  });

  it("reaches the browser on the report, which is the only way it can", () => {
    /**
     * No workspaces and no hub: `hubCloudReport` still answers, and the
     * disclosure is on it. That matters because the panel renders the sentence
     * BEFORE the consent is granted and on a machine that may never have
     * connected anything — if it appeared only once connected, the one moment it
     * is needed is the moment it would be missing.
     */
    const report = hubCloudReport("/nonexistent-home-for-this-test", {
      workspaces: [],
      crossLinks: 0,
    });
    expect(report.self.registry.disclosure).toBe(REGISTRY_DISCLOSURE);
    expect(report.self.registry.connected).toBe(false);
    expect(report.self.registry.consent).toBe(false);
  });

  it("names what it discloses, rather than gesturing at it", () => {
    // The three things a person is actually giving up, checked as words rather
    // than as a length: this is the sentence most likely to be softened.
    for (const word of ["names", "prefixes", "identities", "sit together"]) {
      expect(REGISTRY_DISCLOSURE).toContain(word);
    }
  });
});
