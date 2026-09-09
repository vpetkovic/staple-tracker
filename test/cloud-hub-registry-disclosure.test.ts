/**
 * ONE DISCLOSURE, DECLARED TWICE, PINNED EQUAL — S22 (STA-283).
 *
 * ## The sentence
 *
 * *"a machine that publishes its registry tells the service the names, prefixes
 * and identities of every workspace on it, and that they sit together."*
 *
 * It is the whole price of the invariant the registry gave up. `hub-scope.ts`
 * says cross-repository topology *"is not this repository's business"*, and
 * publishing is precisely the act of making it the service's business. So the
 * sentence has to appear wherever the consent is granted, in the same words,
 * because a disclosure reworded per surface is a disclosure whose strongest
 * wording is whichever surface a person did not read.
 *
 * ## Why it is declared twice, and why that is not the usual mistake
 *
 * `REGISTRY_DISCLOSURE` lives in `hub-registry-service.ts`, which reaches
 * `client.ts`. `hubCloudReport` carries the sentence to the browser — the
 * browser cannot import `src/core` at all, so the report is the only way it can
 * travel — and `hubCloudReport` is called by a route the settings page POLLS.
 *
 * Importing the service module into `hub-surface.ts` to avoid a second
 * declaration would therefore put the TRANSPORT into a polled read's import
 * graph. That is the exact setup `hub-preview.ts` was split out of
 * `hub-connect.ts` to prevent, and the reason given there applies verbatim: the
 * way to keep a consent mechanism from quietly acquiring a network call is not
 * to remember not to add one, it is to build it somewhere a network call cannot
 * be written.
 *
 * So the choice was: one declaration and a transport-reaching import in a polled
 * path, or two declarations and a test. This file is that test. Two copies that
 * CANNOT drift are not the failure "one copy or it drifts" is warning about —
 * that warning is about copies with nothing holding them together, which is
 * exactly what this removes.
 *
 * If this fails, the two have diverged and **the one in the service module is
 * the original**: it is what `requireRegistryConsent` quotes in its refusal and
 * what `registryDisclosure()` renders for the CLI.
 */
import { describe, expect, it } from "vitest";
import { REGISTRY_DISCLOSURE, registryDisclosure } from "../src/core/cloud/hub-registry-service.js";
import { HUB_REGISTRY_DISCLOSURE, hubCloudReport } from "../src/core/cloud/hub-surface.js";

describe("the registry disclosure has one wording", () => {
  it("is identical in the surface report and in the service that enforces it", () => {
    expect(HUB_REGISTRY_DISCLOSURE).toBe(REGISTRY_DISCLOSURE);
  });

  it("is the sentence the CLI prints, so terminal and browser disclose the same thing", () => {
    // `registryDisclosure` renders it capitalised inside a block; the substring
    // check is against the sentence itself, which is what must match.
    expect(registryDisclosure("https://sync.example.com")).toContain(
      REGISTRY_DISCLOSURE.slice(1),
    );
  });

  it("reaches the browser on the report, which is the only way it can", () => {
    /**
     * No workspaces and no hub file: `hubCloudReport` still answers, and the
     * disclosure is on it. That matters because the panel renders the sentence
     * BEFORE the consent is granted and on a machine that may never have
     * connected anything — if it were only present once connected, the one
     * moment it is needed is the moment it would be missing.
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
