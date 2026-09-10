/**
 * This machine's own cross-link changes, recorded in hub migration 004 (STA-287).
 *
 * The record is what gives a publish the authority to retract a link, and what stops an
 * adopt from bringing back a link this machine removed. So every assertion here is about
 * WHICH act writes a row, because a row written by the wrong act is the bug. If an adopted
 * link recorded a change, the next publish would put back a link another machine removed.
 * If `hub unlink` recorded nothing, a removal would never leave the machine.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { crossLinkEntityId } from "../src/core/cloud/cross-link-key.js";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

const ONE = "11111111-1111-4111-8111-111111111111";
const TWO = "22222222-2222-4222-8222-222222222222";
const KEY = crossLinkEntityId({
  blockerRepositoryId: ONE,
  blockerIdentifier: "ONE-1",
  blockedRepositoryId: TWO,
  blockedIdentifier: "TWO-1",
});

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = tempDir("xlink-changes");
  previousHome = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  removeDir(home);
});

/** Two rows with identities and no databases, so linking checks nothing on disk. */
function twoRows(): Hub {
  const hub = Hub.open();
  hub.registerAbsent({ slug: "one", prefix: "ONE", kind: "repo", repositoryId: ONE });
  hub.registerAbsent({ slug: "two", prefix: "TWO", kind: "repo", repositoryId: TWO });
  return hub;
}

const acts = (hub: Hub) => hub.listCrossLinkChanges().map((c) => ({ key: c.key, present: c.present, published: c.published }));

describe("which acts are recorded", () => {
  it("records a removal keyed on the two repositories, not the slugs", () => {
    const hub = twoRows();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    expect(acts(hub)).toEqual([{ key: KEY, present: false, published: false }]);
    const [change] = hub.listCrossLinkChanges();
    expect(change).toMatchObject({ blockerRepositoryId: ONE, blockedRepositoryId: TWO, blockerIdentifier: "ONE-1" });
    hub.close();
  });

  it("linking again replaces the removal with a (re)link that no publish has shared", () => {
    const hub = twoRows();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    hub.settleCrossLinkChanges(hub.listCrossLinkChanges());
    expect(acts(hub)).toEqual([{ key: KEY, present: false, published: true }]);
    hub.addCrossLink("ONE-1", "TWO-1");
    expect(acts(hub)).toEqual([{ key: KEY, present: true, published: false }]);
    hub.close();
  });

  it("records NOTHING for a link that arrives from, or leaves because of, the registry", () => {
    const hub = twoRows();
    hub.adoptCrossLink("ONE-1", "TWO-1");
    expect(hub.listCrossLinks()).toHaveLength(1);
    expect(acts(hub)).toEqual([]);
    hub.dropRetractedCrossLink("ONE-1", "TWO-1");
    expect(hub.listCrossLinks()).toEqual([]);
    expect(acts(hub)).toEqual([]);
    hub.close();
  });

  it("records nothing for a link with an end that has no identity, which was never publishable", () => {
    const hub = Hub.open();
    hub.registerAbsent({ slug: "one", prefix: "ONE", kind: "repo", repositoryId: ONE });
    hub.registerAbsent({ slug: "nameless", prefix: "NAM", kind: "repo", repositoryId: null });
    hub.addCrossLink("ONE-1", "NAM-1");
    hub.removeCrossLink("ONE-1", "NAM-1");
    expect(acts(hub)).toEqual([]);
    hub.close();
  });
});

describe("settling after a publish", () => {
  it("marks a removal published and keeps it, and forgets a (re)link", () => {
    const hub = twoRows();
    hub.registerAbsent({ slug: "three", prefix: "THR", kind: "repo", repositoryId: "33333333-3333-4333-8333-333333333333" });
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.addCrossLink("ONE-2", "THR-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    hub.settleCrossLinkChanges(hub.listCrossLinkChanges());
    // The removal stays, as this machine's refusal to take the link back on adopt.
    expect(acts(hub)).toEqual([{ key: KEY, present: false, published: true }]);
    hub.close();
  });

  it("does not settle an act made AFTER the publish read it", () => {
    const hub = twoRows();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    const seenByPublish = hub.listCrossLinkChanges();
    // While the publish is in flight, the person links it again.
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.settleCrossLinkChanges(seenByPublish);
    // The newer re-link is still owed to the next publish.
    expect(acts(hub)).toEqual([{ key: KEY, present: true, published: false }]);
    hub.close();
  });
});

describe("the sent stamp", () => {
  it("records the epoch and version an act is sent against, and a NEW act clears it", () => {
    /**
     * The stamp answers "did this act land?" on the next publish. A new act is a new
     * decision that no publish has sent, so it must start unstamped. Otherwise it would
     * inherit the old act's stamp, be judged already sent, and be dropped.
     */
    const hub = twoRows();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    const [removal] = hub.listCrossLinkChanges();
    hub.markCrossLinkChangesSent([{ change: removal!, epoch: 3, version: 7 }]);
    expect(hub.listCrossLinkChanges()[0]).toMatchObject({ present: false, sentEpoch: 3, sentVersion: 7 });

    hub.addCrossLink("ONE-1", "TWO-1");
    expect(hub.listCrossLinkChanges()[0]).toMatchObject({ present: true, sentEpoch: null, sentVersion: null });
    hub.close();
  });

  it("does not stamp an act made after the publish read the row", () => {
    const hub = twoRows();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.removeCrossLink("ONE-1", "TWO-1");
    const seenByPublish = hub.listCrossLinkChanges();
    hub.addCrossLink("ONE-1", "TWO-1");
    hub.markCrossLinkChangesSent([{ change: seenByPublish[0]!, epoch: 1, version: 1 }]);
    expect(hub.listCrossLinkChanges()[0]).toMatchObject({ present: true, sentVersion: null });
    hub.close();
  });
});

describe("`staple hub unlink` records the removal", () => {
  it("through the real CLI, between two repo-local workspaces", () => {
    const root = tempDir("xlink-cli");
    try {
      const env = { STAPLE_HOME: home, STAPLE_AGENT: "xlink" };
      for (const name of ["upstream", "downstream"]) {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        const init = runCliAt(dir, ["init", "--yes"], env);
        expect(init.status, init.stderr).toBe(0);
        expect(runCliAt(dir, ["new", `${name} work`], env).status).toBe(0);
      }
      const linked = runCliAt(root, ["link", "UPS-1", "DOW-1"], env);
      expect(linked.status, linked.stderr).toBe(0);
      const unlinked = runCliAt(root, ["hub", "unlink", "UPS-1", "DOW-1"], env);
      expect(unlinked.status, unlinked.stderr).toBe(0);

      const hub = Hub.open();
      const identities = new Map(hub.list().map((r) => [r.slug, r.repositoryId]));
      const changes = hub.listCrossLinkChanges();
      hub.close();
      expect(changes.map((c) => ({ present: c.present, published: c.published }))).toEqual([
        { present: false, published: false },
      ]);
      expect(changes[0]).toMatchObject({
        blockerRepositoryId: identities.get("upstream"),
        blockerIdentifier: "UPS-1",
        blockedRepositoryId: identities.get("downstream"),
        blockedIdentifier: "DOW-1",
      });
    } finally {
      removeDir(root);
    }
  }, 90_000);
});
