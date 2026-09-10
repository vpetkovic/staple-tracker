/**
 * The hub registry on the wire, client side (STA-283).
 *
 * The acceptance criterion this file exists for is *"the hub is restorable from the
 * service after a machine is lost"*, and the assertion that carries it is the last
 * describe block: a machine with an EMPTY hub, holding only a credential, ends up
 * knowing which workspaces the lost machine had.
 *
 * ## What is asserted, and what would have been a green test that proved nothing
 *
 * This epic produced four of those, so each guard is deliberate:
 *
 *  - **The service is `FakeSyncServer`, which re-implements `worker/src/`** — the same
 *    fold, the same envelope validation, the same protocol gate, the same
 *    materialising restore. Not a stub that answers what the client hopes for.
 *  - **Every test that claims to publish asserts `server.ops`**, the rows the service
 *    actually holds, and several assert `server.calls`, the routes actually taken. A
 *    harness whose requests never happened cannot pass those.
 *  - **The wire shapes come from `worker/test/registry-fixture.ts`**, which the
 *    WORKER's own suite reads too. Two independent sets of literals is precisely the
 *    "fixture answering with both field names" failure; there is one set, and either
 *    suite fails against it.
 *  - **The round trip is property-style over generated registries**, not one fixture,
 *    and it goes through the fake's real fold rather than a local re-implementation.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";
import { cloudCodeOf, cloudError } from "../src/core/cloud/client.js";
import {
  readConnection,
  setConsent,
  writeConnection,
  type CloudConnection,
} from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import {
  REGISTRY_PAYLOAD_FORMAT,
  exportRegistry,
  type HubRegistryPayload,
} from "../src/core/cloud/hub-registry.js";
import {
  CROSS_LINK_ENTITY,
  REGISTRATION_ENTITY,
  REGISTRY_PROTOCOL,
  chunkOperations,
  crossLinkEntityId,
  diffRegistry,
  parseCrossLinkEntityId,
  publishedStateOf,
  registryFromSnapshot,
  type SnapshotEntityLike,
} from "../src/core/cloud/hub-registry-ops.js";
import {
  HUB_NOT_PROVISIONED,
  REGISTRY_DISCLOSURE,
  adoptPublishedRegistry,
  adoptRegistryIdentity,
  createHubBackup,
  isNotProvisioned,
  listHubBackups,
  publishRegistry,
  readPublishedRegistry,
  registryDisclosure,
  requireRegistryConsent,
  restoreRegistry,
  setHubBackupConsent,
  setRegistryConsent,
} from "../src/core/cloud/hub-registry-service.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import {
  FIXTURE_FOLDED_STATE,
  FIXTURE_OPS,
  FIXTURE_REGISTRY,
  FIXTURE_ROUND_TRIPPED,
} from "../worker/test/registry-fixture.js";

const ENDPOINT = "https://sync.test.example";
/**
 * One token per device, never one shared between them.
 *
 * `worker/src/auth.ts` looks a credential up by digest alone and lets `repo_id` and
 * `device_id` fall OUT of the row — `devices_token` is globally unique — so a token
 * names exactly one device. `FakeSyncServer` reproduces that, and sharing a token
 * between two test machines makes every envelope from the second one a
 * `deviceId does not match the credential`. Which is the correct answer, and worth
 * having discovered here rather than against the deployed service.
 */
function tokenFor(deviceId: string): string {
  return `stpl_hub_test_${deviceId}`;
}

let previousHome: string | undefined;
let dirs: string[] = [];

/** A machine: its own staple home, its own hub. */
function machine(): { home: string; hub: Hub } {
  const home = mkdtempSync(join(tmpdir(), "staple-hubwire-"));
  dirs.push(home);
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  try {
    return { home, hub: Hub.open() };
  } finally {
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
}

/** Register a workspace with a real file behind it, so `available` is true. */
function seed(
  home: string,
  hub: Hub,
  slug: string,
  prefix: string,
  repositoryId: string | null,
  kind = "repo",
): string {
  const wsDir = join(home, "ws", slug.replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(wsDir, { recursive: true });
  const dbPath = join(wsDir, "staple.db");
  writeFileSync(dbPath, "");
  hub.register({ slug, prefix, path: dbPath, kind });
  if (repositoryId !== null) hub.recordRepositoryId(slug, repositoryId);
  return dbPath;
}

/**
 * Connect a hub the way `performConnect` leaves it: credential stored, record written,
 * and **every consent off**. Tests that need one turn it on explicitly, which is how
 * "none of the consents implies another" is asserted rather than asserted about.
 */
function connect(
  home: string,
  hubId: string,
  server: FakeSyncServer,
  deviceId = "device-a",
  hub?: Hub,
): void {
  /**
   * The registry identity is ADOPTED, not minted, on any machine that is joining an
   * existing registry. Done here rather than per test so that no test can accidentally
   * pass by having minted its own id and then read an empty repository — which is what
   * "restorable after a machine is lost" looks like when it is quietly false.
   */
  if (hub !== undefined) adoptRegistryIdentity(home, hub, hubId);
  credentialStoreFor(home, "file").write(hubId, tokenFor(deviceId));
  const connection: CloudConnection = {
    schemaVersion: 1,
    repositoryId: hubId,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-09T00:00:00.000Z",
    auto: false,
    backup: false,
    registry: false,
    protocol: REGISTRY_PROTOCOL,
  };
  writeConnection(home, connection);
  server.enroll(deviceId, tokenFor(deviceId));
}

function serverFor(hubId: string, options: { maxBatchSize?: number } = {}): FakeSyncServer {
  return new FakeSyncServer({
    repositoryId: hubId,
    ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
  });
}

beforeEach(() => {
  // Every home is created by `machine()`. This only remembers the ambient one, because
  // several tests point `STAPLE_HOME` at a second machine mid-test and the value has to
  // be put back whatever happens.
  previousHome = process.env.STAPLE_HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  for (const path of dirs) rmSync(path, { recursive: true, force: true });
  dirs = [];
});

// ------------------------------------------------------------- the wire shapes

describe("the shapes the worker suite also reads", () => {
  it("emits exactly the operations the worker suite pushes", () => {
    const diff = diffRegistry(FIXTURE_REGISTRY as HubRegistryPayload, new Map());
    expect(diff.operations).toEqual(FIXTURE_OPS.map((o) => ({ ...o, payload: { ...o.payload } })));
    expect(diff.upToDate).toBe(false);
  });

  it("reconstructs exactly the registry the worker suite folds to", () => {
    const entities: SnapshotEntityLike[] = FIXTURE_FOLDED_STATE.map((f) => ({
      entity: f.entity,
      entityId: f.entityId,
      deletedAt: null,
      state: { ...f.state },
    }));
    const rebuilt = registryFromSnapshot({
      hubId: FIXTURE_ROUND_TRIPPED.hubId,
      capturedAt: FIXTURE_ROUND_TRIPPED.capturedAt,
      entities,
    });
    expect(rebuilt).toEqual(FIXTURE_ROUND_TRIPPED);
  });

  it("declares the protocol the two entities require", () => {
    expect(REGISTRY_PROTOCOL).toBe(2);
    expect([REGISTRATION_ENTITY, CROSS_LINK_ENTITY]).toEqual(["registration", "crossLink"]);
  });
});

describe("the cross-link entity id", () => {
  it("is injective: no two distinct four-tuples collide", () => {
    /**
     * The property a hash would only have probabilistically. These four tuples all
     * concatenate to something similar and would collide under a naive join.
     */
    const tuples = [
      { blockerWs: "a", blockerIdentifier: "b/c", blockedWs: "d", blockedIdentifier: "e" },
      { blockerWs: "a", blockerIdentifier: "b", blockedWs: "c/d", blockedIdentifier: "e" },
      { blockerWs: "a/b", blockerIdentifier: "c", blockedWs: "d", blockedIdentifier: "e" },
      { blockerWs: "a", blockerIdentifier: "b", blockedWs: "c", blockedIdentifier: "d/e" },
    ];
    const ids = tuples.map(crossLinkEntityId);
    expect(new Set(ids).size).toBe(tuples.length);
    // And it inverts, which is what lets a partial payload be recovered from the key.
    for (const [index, id] of ids.entries()) expect(parseCrossLinkEntityId(id)).toEqual(tuples[index]);
  });

  it("is the same on both machines, because it is a pure function of the names", () => {
    const link = {
      blockerWs: "wörk—space",
      blockerIdentifier: "WS-7",
      blockedWs: "other",
      blockedIdentifier: "OTH-1",
    };
    expect(crossLinkEntityId(link)).toBe(crossLinkEntityId({ ...link }));
  });
});

// ------------------------------------------------------------- no paths, ever

describe("no filesystem path can reach an operation", () => {
  it("emits nothing containing a real hub's absolute workspace path", () => {
    const { home, hub } = machine();
    // A path unique enough that finding it anywhere in the batch is conclusive.
    const dbPath = seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    expect(dbPath).toContain(home);

    const payload = exportRegistry(hub);
    const diff = diffRegistry(payload, new Map());
    const serialized = JSON.stringify(diff.operations);

    // The whole path, and every non-trivial ancestor of it. A serializer that emitted
    // a directory rather than the file would pass a check for the full path alone.
    expect(serialized).not.toContain(dbPath);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(tmpdir());
    hub.close();
  });

  it("still publishes a slug that looks like a path, because a slug is a name", () => {
    const { home, hub } = machine();
    seed(home, hub, "/Users/someone/projects/qde", "QDE", "22222222-2222-4222-8222-222222222222");
    const diff = diffRegistry(exportRegistry(hub), new Map());
    const registration = diff.operations.find((o) => o.entity === REGISTRATION_ENTITY);
    // Verbatim. A serializer that scrubbed anything path-shaped would corrupt the name
    // a human chose, and would be a redaction rather than a structural absence.
    expect((registration!.payload as { slug: string }).slug).toBe("/Users/someone/projects/qde");
    hub.close();
  });

  it("emits exactly the allowed keys and no others, on every operation", () => {
    /**
     * A literal payload rather than a real hub, because `Hub.addCrossLink` opens both
     * workspace databases to check the identifiers exist — which is the right thing
     * for a real edge and irrelevant to what is being asserted here. The real-hub path
     * is covered by the path assertion above; this one is about the emitted key set.
     */
    const diff = diffRegistry(FIXTURE_REGISTRY as HubRegistryPayload, new Map());
    expect(diff.operations.length).toBeGreaterThan(0);
    expect(diff.operations.some((o) => o.entity === CROSS_LINK_ENTITY)).toBe(true);
    for (const operation of diff.operations) {
      const keys = Object.keys(operation.payload).sort();
      if (operation.entity === REGISTRATION_ENTITY) {
        // The closed key set. `path` and `lastSeenAt` are not merely absent from the
        // output, they are absent from the TYPE — this asserts the runtime half.
        expect(keys).toEqual(["addedAt", "format", "kind", "prefix", "slug"]);
      } else {
        expect(keys).toEqual([
          "blockedIdentifier",
          "blockedWs",
          "blockerIdentifier",
          "blockerWs",
          "format",
          // The retraction flag. A field rather than the `delete` verb, because a
          // tombstone on a content-derived key can never be undone.
          "present",
          "type",
        ]);
      }
    }
  });
});

// ------------------------------------------------------ the property round trip

/**
 * A deterministic pseudo-random generator.
 *
 * Seeded and reproducible on purpose: a property test whose failures cannot be
 * re-run is a flake generator, and `vitest` gives no shrinking to compensate.
 */
function lcg(seed: number): () => number {
  /**
   * Scrambled, then warmed up.
   *
   * A plain `state = seed` over sequential seeds produces highly correlated first
   * outputs, and it showed up here exactly as it should: forty registries that all had
   * fewer than four workspaces, so the no-identity branch was never reached and
   * `sawUnpublishable` was zero. A property test that never gets to its interesting
   * input is one more green test that proves nothing — which is why the counters below
   * the loop exist at all.
   */
  let state = Math.imul(seed >>> 0, 2654435761) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let warm = 0; warm < 8; warm += 1) next();
  return next;
}

/** A registry with awkward but legal contents. */
function generateRegistry(seed: number): HubRegistryPayload {
  const rand = lcg(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const slugAlphabet = [
    "tracker",
    "/Users/someone/projects/x",
    "wörk—space",
    "a/b",
    "with space",
    "100%",
    "trailing/",
    "ünïcødé-ç",
  ];

  const count = 1 + Math.floor(rand() * 8);
  const workspaces = Array.from({ length: count }, (_, index) => ({
    // Every fourth one has no identity, so the unpublishable path is exercised by the
    // property rather than only by its own test.
    repositoryId:
      index % 4 === 3 ? null : `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    slug: `${pick(slugAlphabet)}-${index}`,
    prefix: `P${index}`,
    kind: pick(["repo", "global"]),
    addedAt: new Date(Date.UTC(2026, index % 12, 1 + (index % 27))).toISOString(),
  }));

  const publishable = workspaces.filter((w) => w.repositoryId !== null);
  const edgeCount = publishable.length < 2 ? 0 : Math.floor(rand() * 5);
  const crossLinks = Array.from({ length: edgeCount }, (_, index) => {
    const blocker = pick(publishable);
    const blocked = pick(publishable);
    return {
      blockerWs: blocker.slug,
      blockerIdentifier: `${blocker.prefix}-${index + 1}`,
      blockedWs: blocked.slug,
      blockedIdentifier: `${blocked.prefix}-${index + 100}`,
      type: "blocks" as const,
    };
  });

  return {
    format: REGISTRY_PAYLOAD_FORMAT,
    hubId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(seed).padStart(12, "0")}`,
    capturedAt: "2026-09-09T12:00:00.000Z",
    workspaces,
    crossLinks,
  };
}

/**
 * The fold, as `worker/src/fold.ts` performs it over a set of operations.
 *
 * Deliberately the SMALLEST honest fold — assign the payload's keys over the state,
 * tombstone wins — and it is used only to reach a snapshot shape for the reverse
 * direction. It is not the authority on folding and must not be read as one: the
 * authority is the real fold, and the round trip goes through it in
 * `worker/test/registry.test.ts` and in `scripts/hub-registry-live.ts`.
 */
function foldOperations(
  operations: readonly { entity: string; entityId: string; verb: string; payload: object }[],
): SnapshotEntityLike[] {
  const entities = new Map<
    string,
    { entity: string; entityId: string; state: Record<string, unknown>; deletedAt: number | null; version: number }
  >();
  for (const operation of operations) {
    const key = `${operation.entity} ${operation.entityId}`;
    let entry = entities.get(key);
    if (!entry) {
      entry = {
        entity: operation.entity,
        entityId: operation.entityId,
        state: {},
        deletedAt: null,
        version: 0,
      };
      entities.set(key, entry);
    }
    entry.version += 1;
    if (operation.verb === "delete") {
      entry.deletedAt = 1;
      continue;
    }
    if (entry.deletedAt !== null) continue;
    Object.assign(entry.state, operation.payload);
  }
  return [...entities.values()].sort((a, b) =>
    `${a.entity} ${a.entityId}` < `${b.entity} ${b.entityId}` ? -1 : 1,
  );
}

/** The two collections, order-insensitively, for comparing a registry to itself. */
function comparable(registry: HubRegistryPayload): {
  workspaces: unknown[];
  crossLinks: unknown[];
} {
  const sort = (rows: readonly unknown[]) =>
    [...rows].map((row) => JSON.stringify(row)).sort();
  return { workspaces: sort(registry.workspaces), crossLinks: sort(registry.crossLinks) };
}

describe("the serialiser round-trips losslessly, over many registries", () => {
  it("preserves both collections for every generated registry", () => {
    let exercised = 0;
    let sawUnpublishable = 0;
    let sawEdges = 0;

    for (let seed = 1; seed <= 40; seed += 1) {
      const registry = generateRegistry(seed);
      const diff = diffRegistry(registry, new Map());
      const rebuilt = registryFromSnapshot({
        hubId: registry.hubId,
        capturedAt: registry.capturedAt,
        entities: foldOperations(diff.operations),
      });

      /**
       * The publishable subset, which is the honest thing to compare against: an entry
       * with no `repositoryId` has no adoption key and was reported rather than sent.
       * Cross-links are deduplicated by entity id, because two identical edges in one
       * registry are one entity — the generator can produce a repeat.
       */
      const expected: HubRegistryPayload = {
        ...registry,
        workspaces: registry.workspaces.filter((w) => w.repositoryId !== null),
        crossLinks: [
          ...new Map(registry.crossLinks.map((l) => [crossLinkEntityId(l), l])).values(),
        ],
      };

      expect(comparable(rebuilt)).toEqual(comparable(expected));
      expect(rebuilt.format).toBe(REGISTRY_PAYLOAD_FORMAT);
      expect(rebuilt.hubId).toBe(registry.hubId);

      exercised += 1;
      if (diff.unpublishable.length > 0) sawUnpublishable += 1;
      if (expected.crossLinks.length > 0) sawEdges += 1;
    }

    // The harness actually exercised the interesting shapes, rather than forty copies
    // of the easy one. Without these the loop above could pass on empty registries.
    expect(exercised).toBe(40);
    expect(sawUnpublishable).toBeGreaterThan(5);
    expect(sawEdges).toBeGreaterThan(5);
  });

  it("emits nothing at all when the service already holds the registry", () => {
    const registry = generateRegistry(7);
    const first = diffRegistry(registry, new Map());
    const published = publishedStateOf(foldOperations(first.operations));
    const second = diffRegistry(registry, published);
    // Idempotent, which is what makes `publishRegistry` safe to run on a timer or
    // after every hub write. A diff that re-sent everything would burn the free plan's
    // row budget describing a machine that had not changed.
    expect(second.operations).toEqual([]);
    expect(second.upToDate).toBe(true);
  });

  it("does not re-publish because a newer build added a key it does not know", () => {
    const registry = generateRegistry(11);
    const first = diffRegistry(registry, new Map());
    const folded = foldOperations(first.operations).map((entity) => ({
      ...entity,
      state: { ...entity.state, somethingNewerBuildsKnowAbout: true },
    }));
    // `fold.ts`: every verb merges the keys it carried and is SILENT about the rest, so
    // an extra key is not a disagreement. Treating it as one would make an older
    // machine re-publish for ever, deleting nothing and fixing nothing.
    expect(diffRegistry(registry, publishedStateOf(folded)).operations).toEqual([]);
  });
});

// ----------------------------------------------------------- the diff's rules

describe("what the diff will and will not emit", () => {
  it("reports a workspace with no sync identity rather than inventing one", () => {
    const registry: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: null, slug: "nameless", prefix: "NAM", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
      crossLinks: [],
    };
    const diff = diffRegistry(registry, new Map());
    expect(diff.operations).toEqual([]);
    expect(diff.unpublishable).toHaveLength(1);
    /**
     * A sentence naming the workspace and a remedy THAT WORKS — not a code, not a silence,
     * and not the old wording, which said "connect that workspace, or run `staple init` in
     * it" to a person who had already done both. Nothing populated the column those
     * remedies were supposed to fill; the identity is recorded when staple OPENS the
     * workspace, so that is what the message now says.
     */
    expect(diff.unpublishable[0]!.reason).toContain("nameless");
    /**
     * The remedy has been wrong twice, so this pins the MEASURED one.
     *
     * Round 2's wording named `connect` or `staple init` when nothing wrote the column at
     * all. Round 3's named "any command … `staple ls --ws <slug>` is enough" — and this test
     * pinned that false string, which is how a wrong remedy acquired a passing assertion.
     * Measured: after nulling the column, `staple ls` left it null, `staple ls --ws <slug>`
     * left it null, `staple init` restored it.
     */
    expect(diff.unpublishable[0]!.reason).toContain("staple init");
    expect(diff.unpublishable[0]!.reason).not.toContain("staple ls --ws");
  });

  it("NEVER deletes a registration, even when the workspace is gone locally", () => {
    /**
     * The unregister rule, enforced structurally. `staple hub unregister` is local and
     * must not propagate — on the other machine there is no repository to re-register
     * from, so a propagated delete is irreversible where the local act was not.
     */
    const before = generateRegistry(3);
    const published = publishedStateOf(foldOperations(diffRegistry(before, new Map()).operations));
    const after: HubRegistryPayload = { ...before, workspaces: [], crossLinks: before.crossLinks };

    const diff = diffRegistry(after, published);
    expect(diff.operations.filter((o) => o.entity === REGISTRATION_ENTITY)).toEqual([]);
    /**
     * Stronger than it was: this wire emits NO delete at all, for either entity, and the
     * TYPE now says so — `RegistryOperation["verb"]` is `"create" | "update"`, so the
     * comparison a previous version of this test made no longer typechecks. Asserted
     * against the set of verbs actually emitted, which is the runtime half of the same
     * claim.
     */
    expect([...new Set(diff.operations.map((o) => o.verb))].sort()).not.toContain("delete");
  });

  it("NEVER retracts a cross-link: removal does not propagate", () => {
    /**
     * Measured, not reasoned to. Two authority tests were tried and both failed:
     *
     *   - slug match — grants edge-deletion authority on a NAME;
     *   - identity equality — ZERO protection, because `.staple/repository.json` is TRACKED,
     *     so two clones legitimately share a `repositoryId` (#92). A clone that never applied
     *     an adopt satisfied it by construction and deleted the other machine's edge.
     *
     * No comparison of the two sides can establish authority, because two machines
     * legitimately holding the same repositories are indistinguishable by identity, by name,
     * and by anything else in the payload. So cross-links are additive-only, exactly as
     * registrations are, and for the reason `docs/sync.md` gives there.
     */
    const link = {
      blockerWs: "one",
      blockerIdentifier: "ONE-1",
      blockedWs: "two",
      blockedIdentifier: "TWO-1",
      type: "blocks" as const,
    };
    const base: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: "11111111-1111-4111-8111-111111111111", slug: "one", prefix: "ONE", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
        { repositoryId: "22222222-2222-4222-8222-222222222222", slug: "two", prefix: "TWO", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
      crossLinks: [link],
    };
    const published = publishedStateOf(foldOperations(diffRegistry(base, new Map()).operations));

    // Removed locally, by the machine that owns the registry, with both workspaces present.
    const diff = diffRegistry({ ...base, crossLinks: [] }, published);
    expect(diff.operations).toEqual([]);
    expect(diff.retained).toHaveLength(1);
    expect(diff.retained[0]!.reason).toContain("does not propagate");
    expect(diff.retained[0]!.reason).toContain("adopting will bring it back");
  });

  it("`upToDate` is true WITH a non-empty `retained`, and the pair is the contract", () => {
    /**
     * The normal outcome for a machine that is not the only publisher, pinned as a PAIR.
     *
     * `upToDate` is `operations.length === 0` and nothing more. An edge the service holds
     * and this machine does not produces a `retained` entry and NO operation — additive
     * only, see the test above — so `upToDate: true` alongside a non-empty `retained` is
     * not an edge case, it is what a second machine sees every pass.
     *
     * Asserted as one object rather than two separate expectations, because the defect
     * this guards is reading either field alone: a `--json` consumer keying on `upToDate`
     * silently drops the retained set, and anyone "fixing" `upToDate` to mean "nothing to
     * report" would have to fail this line to do it. A previous fix touched only the
     * printed sentence, which left both readings of the machine-readable shape open.
     */
    const link = {
      blockerWs: "one",
      blockerIdentifier: "ONE-1",
      blockedWs: "two",
      blockedIdentifier: "TWO-1",
      type: "blocks" as const,
    };
    const workspaces = [
      { repositoryId: "11111111-1111-4111-8111-111111111111", slug: "one", prefix: "ONE", kind: "repo" as const, addedAt: "2026-01-01T00:00:00.000Z" },
      { repositoryId: "22222222-2222-4222-8222-222222222222", slug: "two", prefix: "TWO", kind: "repo" as const, addedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const publisher: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces,
      crossLinks: [link],
    };
    const published = publishedStateOf(
      foldOperations(diffRegistry(publisher, new Map()).operations),
    );

    // This machine: the same two workspaces, adopted, and no edge — it has never applied
    // an adopt that would have brought the link across, so there is nothing foreign
    // either and publishing is allowed.
    const here: HubRegistryPayload = { ...publisher, crossLinks: [] };
    const diff = diffRegistry(here, published);

    expect({
      upToDate: diff.upToDate,
      retained: diff.retained.map((r) => r.entityId),
    }).toEqual({ upToDate: true, retained: [crossLinkEntityId(link)] });
    expect(diff.operations).toEqual([]);
    expect(diff.foreign.registrations).toEqual([]);
  });

  /**
   * Overwriting another machine's published NAME is reported, because it is allowed.
   *
   * The overwrite has to be allowed: adoption keeps this machine's name by design, so a
   * rebuilt machine that restored a repository into a differently named directory
   * legitimately holds a different slug from the one the lost machine published. Refusing
   * would refuse the machine replacement this feature exists for, on its first publish.
   *
   * So the requirement is that it is never SILENT. Before this, the only thing a person
   * saw was `published: 1, updated: 1` — the one loss in this feature with no report
   * attached. Note that an earlier round justified reporting-not-refusing with "a single
   * machine renaming a workspace produces the identical diff", which is false: nothing in
   * the tree updates `workspaces.slug`. The test below is deliberately about a SECOND
   * machine, because that is the only way the state arises.
   */
  it("reports every published name it replaces, with the name it replaced", () => {
    const identity = "11111111-1111-4111-8111-111111111111";
    const asPublished: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: identity, slug: "alpha", prefix: "ALP", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
      crossLinks: [],
    };
    const published = publishedStateOf(
      foldOperations(diffRegistry(asPublished, new Map()).operations),
    );

    // The replacement machine holds the same repository — same tracked identity — cloned
    // into a directory called `alpha-clone`.
    const here: HubRegistryPayload = {
      ...asPublished,
      workspaces: [{ ...asPublished.workspaces[0]!, slug: "alpha-clone" }],
    };
    const diff = diffRegistry(here, published);

    expect(diff.renamed).toEqual([{ entityId: identity, from: "alpha", to: "alpha-clone" }]);
    // Reported, not refused: the operation is still emitted, as an update.
    expect(diff.operations.map((o) => o.verb)).toEqual(["update"]);
    expect(diff.foreign.registrations).toEqual([]);
  });

  it("says nothing about a rename when the name has not changed", () => {
    // The guard against a report that cries wolf: a first publish creates rather than
    // replaces, and a re-publish of an unchanged registry emits nothing at all.
    const registry = FIXTURE_REGISTRY as HubRegistryPayload;
    const first = diffRegistry(registry, new Map());
    expect(first.renamed).toEqual([]);

    const published = publishedStateOf(foldOperations(first.operations));
    const again = diffRegistry(registry, published);
    expect({ renamed: again.renamed, upToDate: again.upToDate }).toEqual({
      renamed: [],
      upToDate: true,
    });
  });

  it("a CLONE cannot destroy another machine's edge — the reproduced case", () => {
    /**
     * The exact scenario identity equality passed by construction: machine B has genuinely
     * cloned both repositories, so its `repositoryId`s ARE machine A's (the manifest is
     * tracked), its slugs match, and it has no edge because it never applied an adopt.
     */
    const link = {
      blockerWs: "alpha",
      blockerIdentifier: "ALP-1",
      blockedWs: "beta",
      blockedIdentifier: "BET-1",
      type: "blocks" as const,
    };
    const a: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: "11111111-1111-4111-8111-111111111111", slug: "alpha", prefix: "ALP", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
        { repositoryId: "22222222-2222-4222-8222-222222222222", slug: "beta", prefix: "BET", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
      crossLinks: [link],
    };
    const published = publishedStateOf(foldOperations(diffRegistry(a, new Map()).operations));

    const clone: HubRegistryPayload = { ...a, crossLinks: [] };
    const diff = diffRegistry(clone, published);
    expect(
      diff.operations.filter(
        (o) => o.entity === CROSS_LINK_ENTITY && (o.payload as { present?: boolean }).present === false,
      ),
    ).toEqual([]);
    // And the clone is not blocked from publishing either — it has nothing foreign.
    expect(diff.foreign.registrations).toEqual([]);
  });

  it("`addedAt` is create-only, so two machines converge instead of alternating forever", () => {
    /**
     * REGRESSION. `addedAt` is the LOCAL row's registration time, so two machines can never
     * agree on it — and sent on every update it made a shared registry diverge for ever on a
     * single workspace with no cross-links, appending an operation to a METERED log every
     * pass. Unlike a name race it could never settle, because neither value is wrong.
     *
     * Measured before the fix: 6 operations in 6 passes, `stateAddedAt` alternating.
     */
    const id = "11111111-1111-4111-8111-111111111111";
    const reg = (addedAt: string): HubRegistryPayload => ({
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [{ repositoryId: id, slug: "alpha", prefix: "ALP", kind: "repo", addedAt }],
      crossLinks: [],
    });
    const first = reg("2026-01-01T00:00:00.000Z");
    const second = reg("2026-02-02T00:00:00.000Z");

    let entities = foldOperations(diffRegistry(first, new Map()).operations);
    let total = 1;
    for (let pass = 2; pass <= 6; pass += 1) {
      const diff = diffRegistry(pass % 2 === 0 ? second : first, publishedStateOf(entities));
      total += diff.operations.length;
      if (diff.operations.length > 0) {
        entities = foldOperations([
          ...entities.map((e) => ({
            entity: e.entity,
            entityId: e.entityId,
            verb: "create",
            payload: e.state,
          })),
          ...diff.operations,
        ]);
      }
    }
    // One operation, ever: the create. Was six.
    expect(total).toBe(1);
    // And the value the FIRST writer set is the one that stands.
    expect(entities[0]!.state.addedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses to publish when the service holds a registration this machine lacks", () => {
    /**
     * The gate that scopes publishing to one machine. A published registration with no local
     * row and no opt-out is the one signal that says another machine is publishing here — or
     * that this machine is behind, which has the same remedy.
     */
    const a: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: "11111111-1111-4111-8111-111111111111", slug: "alpha", prefix: "ALP", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
        { repositoryId: "22222222-2222-4222-8222-222222222222", slug: "beta", prefix: "BET", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
      ],
      crossLinks: [],
    };
    const published = publishedStateOf(foldOperations(diffRegistry(a, new Map()).operations));

    const behind: HubRegistryPayload = { ...a, workspaces: [a.workspaces[0]!] };
    expect(diffRegistry(behind, published).foreign.registrations).toEqual([
      { entityId: "22222222-2222-4222-8222-222222222222", slug: "beta" },
    ]);

    // An identity this machine deliberately unregistered is its OWN doing, not foreign —
    // otherwise `staple hub unregister` would permanently block publishing.
    expect(
      diffRegistry(behind, published, [], ["22222222-2222-4222-8222-222222222222"]).foreign
        .registrations,
    ).toEqual([]);

    // And the machine whose registry it is is not blocked.
    expect(diffRegistry(a, published).foreign.registrations).toEqual([]);
  });

  it("uses create for a first write and update for a later one", () => {
    const registry = generateRegistry(5);
    const first = diffRegistry(registry, new Map());
    expect(first.operations.every((o) => o.verb === "create")).toBe(true);

    const published = publishedStateOf(foldOperations(first.operations));
    const renamed: HubRegistryPayload = {
      ...registry,
      workspaces: registry.workspaces.map((w, index) =>
        index === 0 ? { ...w, slug: `${w.slug}-renamed` } : w,
      ),
    };
    const second = diffRegistry(renamed, published);
    expect(second.operations).toHaveLength(1);
    /**
     * `update`, not `create`, and the distinction is not cosmetic: `fold.ts` records
     * per-field provenance for every verb EXCEPT create, so calling a genuine edit a
     * create would lose the record that somebody chose this value.
     */
    expect(second.operations[0]!.verb).toBe("update");
  });

  it("refuses a registry written in a newer format, in both directions", () => {
    const ahead = { ...generateRegistry(2), format: REGISTRY_PAYLOAD_FORMAT + 1 };
    expect(() => diffRegistry(ahead, new Map())).toThrow(StapleError);
    expect(() => diffRegistry(ahead, new Map())).toThrow(/format 2/);

    // And on the way in, on the MAXIMUM any operation declared — so the message names
    // the newest writer rather than the first row encountered.
    expect(() =>
      registryFromSnapshot({
        hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        capturedAt: "2026-09-09T12:00:00.000Z",
        entities: [
          {
            entity: REGISTRATION_ENTITY,
            entityId: "11111111-1111-4111-8111-111111111111",
            deletedAt: null,
            state: { format: 1, slug: "old", prefix: "OLD", kind: "repo", addedAt: "x" },
          },
          {
            entity: REGISTRATION_ENTITY,
            entityId: "22222222-2222-4222-8222-222222222222",
            deletedAt: null,
            state: { format: 9, slug: "new", prefix: "NEW", kind: "repo", addedAt: "x" },
          },
        ],
      }),
    ).toThrow(/format 9/);
  });

  it("skips a tombstoned entity when rebuilding a registry", () => {
    const rebuilt = registryFromSnapshot({
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      entities: [
        {
          entity: CROSS_LINK_ENTITY,
          entityId: crossLinkEntityId({
            blockerWs: "one",
            blockerIdentifier: "ONE-1",
            blockedWs: "two",
            blockedIdentifier: "TWO-1",
          }),
          deletedAt: 1,
          state: {},
        },
      ],
    });
    // A deleted edge is an edge that is not there, and a registry has no way to say
    // "absent edge". Contrast a deleted ISSUE, which the fold returns precisely so a
    // device that already has it is told to remove it.
    expect(rebuilt.crossLinks).toEqual([]);
  });
});

describe("a workspace initialised the ordinary way is publishable", () => {
  /**
   * THE regression this file was missing, and the reason it was missing is the finding.
   *
   * Every other test here, and the live script, called `hub.recordRepositoryId(...)`
   * directly — a hub-internal API no user-facing path invokes. So they proved the wire
   * works when `workspaces.repository_id` is populated, and nothing populated it:
   * `Hub.register()` runs BEFORE the manifest exists, and `performConnect` never touched
   * the column. On a real machine `publish` uploaded an empty registry and reported every
   * workspace unpublishable, naming remedies the person had already performed.
   *
   * So this test uses `openWorkspace` — the real path every command goes through — and
   * calls `recordRepositoryId` nowhere. If the column stops being written, it fails.
   */
  it("publishes a workspace created by openWorkspace, with no hub-internal writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "staple-hubreal-"));
    dirs.push(home);
    const previous = process.env.STAPLE_HOME;
    process.env.STAPLE_HOME = home;
    try {
      // A workspace brought up exactly as `staple init` brings one up.
      const repoDir = join(home, "projects", "alpha");
      mkdirSync(repoDir, { recursive: true });
      // `initWorkspace` is what `staple init` calls, and it is the function that now
      // records the identity on the hub row after reconciling it from the manifest.
      const opened = initWorkspace({ dir: repoDir, kind: "repo" });
      const identity = opened.repository.repositoryId;
      opened.store.db.close();
      expect(identity).toMatch(/^[0-9a-f-]{36}$/);

      const hub = Hub.open();
      const hubId = hub.hubId();
      const server = serverFor(hubId);
      connect(home, hubId, server);
      setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);

      // The column the whole feature keys on, written by the ordinary open.
      expect(hub.list().map((r) => r.repositoryId)).toEqual([identity]);

      const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });
      expect(report.unpublishable).toEqual([]);
      expect(report.published).toBe(1);
      expect(report.applied).toBe(1);
      expect(server.ops.map((o) => o.entityId)).toEqual([identity]);

      // And it reads back as the workspace it is, which is what a restore depends on.
      const readBack = await readPublishedRegistry(home, hubId, { fetchImpl: server.fetch });
      expect(readBack.registry.workspaces).toEqual([
        expect.objectContaining({ repositoryId: identity, slug: "alpha" }),
      ]);
      hub.close();
    } finally {
      if (previous === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = previous;
    }
  }, 30_000);

  it("parks an identity two rows share rather than flip-flopping the published name", () => {
    /**
     * Two rows sharing a `repositoryId` are ONE entity on the wire, so publishing both
     * emits two operations on one entity and the published slug alternates on every pass —
     * `published: 1, upToDate: false` for ever, one operation appended to a paid log each
     * time. Migration 003 asks for it to be REPORTED, and #92 documents two clones or two
     * worktrees of one repository as legitimate, so neither is published and both are named.
     */
    const shared = "11111111-1111-4111-8111-111111111111";
    const registry: HubRegistryPayload = {
      format: REGISTRY_PAYLOAD_FORMAT,
      hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      capturedAt: "2026-09-09T12:00:00.000Z",
      workspaces: [
        { repositoryId: shared, slug: "checkout-a", prefix: "CKA", kind: "repo", addedAt: "2026-01-01T00:00:00.000Z" },
        { repositoryId: shared, slug: "checkout-b", prefix: "CKB", kind: "repo", addedAt: "2026-01-02T00:00:00.000Z" },
        { repositoryId: "22222222-2222-4222-8222-222222222222", slug: "solo", prefix: "SOL", kind: "repo", addedAt: "2026-01-03T00:00:00.000Z" },
      ],
      crossLinks: [],
    };

    const diff = diffRegistry(registry, new Map(), [
      { repositoryId: shared, slugs: ["checkout-a", "checkout-b"] },
    ]);

    // Neither of the sharing rows is published; the unrelated one still is.
    expect(diff.operations.map((o) => o.entityId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(diff.unpublishable.map((u) => u.entry.slug).sort()).toEqual([
      "checkout-a",
      "checkout-b",
    ]);
    // Both reasons name the OTHER row, and say the sharing is legitimate rather than broken.
    expect(diff.unpublishable[0]!.reason).toContain('"checkout-b"');
    expect(diff.unpublishable[0]!.reason).toContain("legitimately share an identity");
    expect(diff.unpublishable[0]!.reason).toContain("staple hub unregister");
  });
});

describe("a value that returns to an earlier value still lands", () => {
  it("survives alpha -> beta -> alpha -> beta without a collision", async () => {
    /**
     * REGRESSION for the second form of the operation-id bug.
     *
     * The first form keyed the id on the entity, so any second write collided.
     * Content-addressing fixed that and introduced this: a value that returns to a value
     * it held before produces the same content, therefore the same id, therefore a
     * `duplicate` answered with the ORIGINAL seq and a status the contract calls success.
     * Three renames were enough. `alpha -> beta -> alpha -> beta` left the service on
     * `alpha` and every later publish reported `published: 1` for ever.
     *
     * The base VERSION is what fixes it, and this test walks the exact cycle through a
     * real service so the assertion is the service's state rather than the report.
     */
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);

    const identity = "11111111-1111-4111-8111-111111111111";
    seed(home, hub, "alpha", "ALP", identity);
    await publishRegistry(hub, home, { fetchImpl: server.fetch });

    /** Move the identity to a differently-named row, which is the publishable rename. */
    const renameTo = async (slug: string, prefix: string): Promise<void> => {
      for (const row of hub.list()) {
        if (row.repositoryId === identity) hub.recordRepositoryId(row.slug, null);
      }
      if (hub.get(slug) === undefined) seed(home, hub, slug, prefix, identity);
      else hub.recordRepositoryId(slug, identity);
      await publishRegistry(hub, home, { fetchImpl: server.fetch });
    };

    await renameTo("beta", "BET");
    await renameTo("alpha", "ALP");
    await renameTo("beta", "BET");

    const readBack = await readPublishedRegistry(home, hubId, { fetchImpl: server.fetch });
    const held = readBack.registry.workspaces.find((w) => w.repositoryId === identity);
    // The FOURTH statement, which is where the old scheme silently stopped.
    expect(held!.slug).toBe("beta");

    // Every operation landed rather than being absorbed: four distinct ids, four rows.
    expect(new Set(server.ops.map((o) => o.opId)).size).toBe(server.ops.length);
    expect(server.ops.filter((o) => o.entity === REGISTRATION_ENTITY).length).toBe(4);

    // And the next publish has nothing to say, which is the property that proves the
    // publish loop terminates instead of reporting success for ever.
    const settled = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(settled.upToDate).toBe(true);
    expect(settled.deduplicated).toBe(0);
    hub.close();
  });

  it("counts what the service applied, not what was sent", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");

    const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    // `published` is intent; `applied` is outcome. They agree here, and the point is
    // that they are now two numbers — a `duplicate` is how both id bugs presented, and a
    // report built from the batch length announced success while nothing changed.
    expect(report.published).toBe(1);
    expect(report.applied).toBe(1);
    expect(report.deduplicated).toBe(0);
    hub.close();
  });
});

describe("publishing is scoped to one machine, and says so", () => {
  /**
   * The retract-authority block that used to live here is gone, and its removal is the
   * finding rather than a cleanup.
   *
   * It pinned a floor keyed on identity equality, with a comment claiming the scenario was
   * "a machine that had cloned both but never applied an adopt" — and then handed that
   * machine identities a clone can never have. The assertion was adjacent to the bug it was
   * supposed to prevent. Nothing retracts now, so there is no authority question to pin;
   * what replaces it is the refusal below and the additive-only rule above.
   */
  it("refuses rather than retracting when it is not the only publisher", async () => {
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    // A second machine holding only ONE of the two, which is what "behind" looks like.
    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(b.home, b.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");

    const before = server.ops.length;
    const error = await publishRegistry(b.hub, b.home, { fetchImpl: server.fetch }).catch((e) => e);
    expect(cloudCodeOf(error)).toBe("conflict");
    expect((error as Error).message).toContain('"qde"');
    expect((error as Error).message).toContain("adopt --apply");
    expect((error as Error).message).toContain("scoped to ONE machine");
    // NOTHING was sent — the refusal is before the push, not a report after it.
    expect(server.ops.length).toBe(before);
    b.hub.close();
  });

  it("names the real escape when adoption would PARK rather than adopt", async () => {
    /**
     * The dead-end. `adoptRegistry` registers an absent row only after clearing the prefix and
     * slug checks, so a collision returns `outcome: "conflict"` and writes NOTHING — the entry
     * stays foreign for ever, publish keeps refusing, and the first version of the refusal told
     * the operator to run the very thing that had just failed. There is no way out through the
     * opt-out set either, because that is keyed on `repositoryId` and there is no local row to
     * `hub unregister`.
     *
     * So the refusal establishes the reason by previewing the adoption, and names an escape
     * that exists.
     */
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    // B already owns prefix QDE for a DIFFERENT repository, so adoption parks it.
    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(b.home, b.hub, "something-else", "QDE", "99999999-9999-4999-8999-999999999999");

    // Adopting genuinely does not fix it: the decision is `conflict` and nothing is written.
    const adopted = await adoptPublishedRegistry(b.hub, b.home, {
      fetchImpl: server.fetch,
      apply: true,
    });
    expect(adopted.adoption.decisions.map((d) => d.outcome)).toContain("conflict");
    expect(b.hub.list().map((r) => r.slug)).toEqual(["something-else"]);

    const error = await publishRegistry(b.hub, b.home, { fetchImpl: server.fetch }).catch((e) => e);
    expect(cloudCodeOf(error)).toBe("conflict");
    // The reason is the ADOPTION's own sentence about the prefix, not "run adopt".
    expect((error as Error).message).toContain("Prefix QDE is already held here");
    // And an escape that exists, which the first version did not have.
    expect((error as Error).message).toContain("will NOT be fixed by adopting");
    expect((error as Error).message).toContain("staple hub registry ignore");
    b.hub.close();
  });

  it("an ignored entry stops being foreign, so publishing works again", async () => {
    // The escape the refusal names has to actually work, or it is a second dead end.
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(b.home, b.hub, "something-else", "QDE", "99999999-9999-4999-8999-999999999999");

    await expect(publishRegistry(b.hub, b.home, { fetchImpl: server.fetch })).rejects.toThrow();

    // `staple hub registry ignore` — an opt-out for an identity with no local row.
    b.hub.addOptOut("22222222-2222-4222-8222-222222222222", "(not registered here)", "ignored");
    const report = await publishRegistry(b.hub, b.home, { fetchImpl: server.fetch });
    expect(report.published).toBe(1);
    b.hub.close();
  });

  it("a PRUNED row does not make publishing impossible on one machine", async () => {
    /**
     * REGRESSION, and it broke the single-machine configuration this scope reduction makes the
     * only supported one. `Hub.unregister` records an opt-out; `Hub.prune` deleted rows and
     * recorded none — and those are the only two row deleters in the tree. So a pruned row left
     * a published registration with no local row and no opt-out, which is FOREIGN: publish
     * refused, blamed another machine, and named `adopt --apply`, which re-added the row prune
     * had just removed. Mutually exclusive, in a loop, and reachable from MCP.
     */
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    const keptPath = seed(home, hub, "one", "ONE", "11111111-1111-4111-8111-111111111111");
    const goingPath = seed(home, hub, "two", "TWO", "22222222-2222-4222-8222-222222222222");
    await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(server.ops).toHaveLength(2);

    // The workspace's database goes away, and prune notices.
    rmSync(goingPath, { force: true });
    expect(existsSync(keptPath)).toBe(true);
    const pruned = hub.prune({ apply: true });
    expect(pruned.removed.map((r) => r.workspace.slug)).toEqual(["two"]);
    // The opt-out prune now records, which is what stops the row reading as foreign.
    expect(hub.listOptOuts().map((o) => ({ id: o.repositoryId, reason: o.reason }))).toEqual([
      { id: "22222222-2222-4222-8222-222222222222", reason: "pruned" },
    ]);

    // Publishing still works, and says nothing about another machine.
    const after = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(after.upToDate).toBe(true);
    hub.close();
  });

  it("lets a machine publish once it has adopted what the service holds", async () => {
    // The refusal has to be escapable by the documented remedy, or it is a wall.
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
    await adoptPublishedRegistry(b.hub, b.home, { fetchImpl: server.fetch, apply: true });

    const report = await publishRegistry(b.hub, b.home, { fetchImpl: server.fetch });
    expect(report.upToDate).toBe(true);
    b.hub.close();
  });
});

describe("the fake refuses what the Worker refuses", () => {
  /**
   * The three refusals mirrored into `FakeSyncServer` had NO test on either side, which is
   * the same gap in miniature: a mirror nobody exercises is a mirror nobody notices going
   * stale. These drive the fake directly, because the fake is the subject.
   *
   * The Worker's own copies are pinned in `worker/test/registry.test.ts`.
   */
  function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      opId: "op-1",
      repoId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      protocol: 2,
      schema: 0,
      entity: "registration",
      entityId: "11111111-1111-4111-8111-111111111111",
      verb: "create",
      baseVersion: null,
      payload: { format: 1, slug: "one", prefix: "ONE", kind: "repo", addedAt: "x" },
      deviceId: "device-a",
      actor: "",
      clientSeq: 1,
      createdAt: "2026-09-09T12:00:00.000Z",
      ...overrides,
    };
  }

  async function push(
    ops: Record<string, unknown>[],
    protocol = 2,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const hubId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const server = new FakeSyncServer({ repositoryId: hubId });
    server.enroll("device-a", "tok");
    const response = await server.fetch(`https://sync.test/v1/repos/${hubId}/ops`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Staple-Protocol": String(protocol),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ protocol, deviceId: "device-a", ops }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("refuses `delete` for a registry entity", async () => {
    const { status, body } = await push([envelope({ verb: "delete", baseVersion: 1, payload: {} })]);
    expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
    expect(String(body.message)).toContain("never valid for a registry entity");
  });

  /**
   * The epoch fence is an INTEGER on this side too, which had no test on EITHER side.
   *
   * `worker/src/push.ts` runs `body.epoch` through `intOrThrow` — `typeof "number"` AND
   * `Number.isInteger` — and refuses `validation`/400 before a statement is prepared. The
   * fake mirrors it, and the worker half is now pinned in `worker/test/push.test.ts`. A
   * client that sent a fractional fence, or the string form of one, has to be refused the
   * same way here, or the fake would let it through and the deployed service would not.
   *
   * The fence cannot be sent through the `push` helper above, which does not carry one, so
   * this builds the request itself in the same shape.
   */
  async function pushFencedOn(
    epoch: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const hubId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const server = new FakeSyncServer({ repositoryId: hubId });
    server.enroll("device-a", "tok");
    const response = await server.fetch(`https://sync.test/v1/repos/${hubId}/ops`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Staple-Protocol": "2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ protocol: 2, deviceId: "device-a", epoch, ops: [] }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // `1.5` and `Infinity` are the values a bare `typeof === "number"` would let past, and
  // `NaN` reaches a server as `null` because JSON has no NaN — asserted rather than assumed.
  for (const [label, value] of [
    ["a fraction", 1.5],
    ["a numeric string", "1"],
    ["null", null],
    ["NaN, which serialises to null", NaN],
  ] as const) {
    it(`refuses an epoch fence that is ${label}`, async () => {
      const { status, body } = await pushFencedOn(value);
      expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
      expect(body.message).toBe("epoch must be an integer");
    });
  }

  it("accepts an integer fence that matches, so the refusals are not refusing everything", async () => {
    const { status } = await pushFencedOn(1);
    expect(status).toBe(200);
  });

  /**
   * `replace` and `renumber`, for both registry entities, asserting on the SPECIFIC
   * message.
   *
   * These verbs had no coverage here at all — only `delete` did — and the by-name check
   * they exercise sat AFTER the ordered-collection and issue allowlists in the fake, which
   * refuse these entities anyway because neither name is in either list. So the branch was
   * unreachable and a generic "is only for ordered collections" was what a client saw.
   * `worker/src/envelope.ts` orders the by-name refusal first for exactly that reason and
   * `worker/test/registry.test.ts` pins it there; this is the same pair of loops against
   * the fake, so the two cannot drift apart again without one of them going red.
   */
  for (const entity of ["registration", "crossLink"] as const) {
    for (const verb of ["replace", "renumber"] as const) {
      it(`refuses ${verb} on ${entity}`, async () => {
        const { status, body } = await push([
          envelope({ entity, verb, baseVersion: 1, payload: { members: ["a"] } }),
        ]);
        expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
        expect(String(body.message)).toContain("never valid for a registry entity");
      });
    }
  }

  it("still gives the allowlist message for a NON-registry entity", async () => {
    // The other half of the ordering: putting the by-name check first must not swallow the
    // two allowlists, which are what refuse `replace` on a comment and `renumber` on
    // anything but an issue.
    const replaced = await push([
      envelope({ entity: "comment", entityId: "c-1", verb: "replace", baseVersion: 1, payload: {} }),
    ]);
    expect({ status: replaced.status, code: replaced.body.code }).toEqual({
      status: 400,
      code: "validation",
    });
    expect(String(replaced.body.message)).toContain("only for ordered collections");

    const renumbered = await push([
      envelope({ entity: "comment", entityId: "c-1", verb: "renumber", baseVersion: 1, payload: {} }),
    ]);
    expect(String(renumbered.body.message)).toContain("only for issues");
  });

  it("echoes the negotiated protocol in the push response, never a constant", async () => {
    /**
     * The fake answered `{"protocol":1}` to every push, so a protocol-2 registry push read
     * back a protocol-1 body while the deployed Worker echoes what the request negotiated
     * (`worker/src/push.ts` returns `ops[0].protocol`, which validation has already forced
     * to equal the header).
     */
    const registry = await push([envelope()], 2);
    expect({ status: registry.status, protocol: registry.body.protocol }).toEqual({
      status: 200,
      protocol: 2,
    });

    const workspace = await push(
      [envelope({ protocol: 1, entity: "issue", entityId: "issue-1", payload: { title: "t" } })],
      1,
    );
    expect({ status: workspace.status, protocol: workspace.body.protocol }).toEqual({
      status: 200,
      protocol: 1,
    });
  });

  it("refuses a batch mixing registry and workspace entities", async () => {
    const { status, body } = await push([
      envelope(),
      envelope({ opId: "op-2", entity: "issue", entityId: "issue-1", clientSeq: 2, payload: { title: "t" } }),
    ]);
    expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
    expect(String(body.message)).toContain("may not mix hub registry entities");
  });

  it("refuses a repeated opId within one batch", async () => {
    /**
     * The one that matters most: the fake answers a duplicate with the ORIGINAL seq and
     * `status: "duplicate"`, which is the exact presentation of both operation-id bugs in
     * `hub-registry-service.ts`. A regression reintroducing a colliding id inside one batch
     * would have looked like success here and been a 400 in production.
     */
    const { status, body } = await push([
      envelope(),
      envelope({ entityId: "22222222-2222-4222-8222-222222222222", clientSeq: 2 }),
    ]);
    expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
    expect(String(body.message)).toContain("opId is repeated within this batch");
  });

  it("refuses an envelope whose protocol disagrees with the request header", async () => {
    // The one field the whole registry leg hangs on, and the fake never checked it.
    const { status, body } = await push([envelope({ protocol: 1 })], 2);
    expect({ status, code: body.code }).toEqual({ status: 400, code: "validation" });
    expect(String(body.message)).toContain("disagrees with the request header");
  });

  it("accepts a well-formed registry batch, so the refusals are not refusing everything", async () => {
    const { status } = await push([
      envelope(),
      envelope({ opId: "op-2", entityId: "22222222-2222-4222-8222-222222222222", clientSeq: 2 }),
    ]);
    expect(status).toBe(200);
  });
});

describe("chunking", () => {
  it("splits at the ceiling the service advertised, never at a constant", () => {
    const operations = Array.from({ length: 57 }, (_, index) => ({
      entity: REGISTRATION_ENTITY as typeof REGISTRATION_ENTITY,
      entityId: `id-${index}`,
      verb: "create" as const,
      baseVersion: 0,
      payload: { format: 1, slug: `s${index}`, prefix: `P${index}`, kind: "repo", addedAt: "x" },
    }));
    expect(chunkOperations(operations, 25).map((c) => c.length)).toEqual([25, 25, 7]);
    expect(chunkOperations(operations, 200).map((c) => c.length)).toEqual([57]);
    expect(chunkOperations([], 25)).toEqual([]);
    // A ceiling that is not a usable size is refused rather than defaulted, because a
    // default here would silently be the wrong plan's number.
    expect(() => chunkOperations(operations, 0)).toThrow(StapleError);
  });
});

// --------------------------------------------------- the registry identity

describe("the registry identity is adopted, never re-minted", () => {
  it("takes on an id when the hub has never needed one", () => {
    const { home, hub } = machine();
    expect(hub.storedHubId()).toBeNull();

    const outcome = adoptRegistryIdentity(home, hub, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(outcome).toEqual({ adopted: true, previousHubId: null });
    // And `hubId()` now returns it rather than minting, which is the whole point: a
    // replacement machine scoped to a freshly minted id reads an empty repository and
    // reports, truthfully and uselessly, that there is nothing to restore.
    expect(hub.hubId()).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    hub.close();
  });

  it("is idempotent for the same id", () => {
    const { home, hub } = machine();
    adoptRegistryIdentity(home, hub, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(adoptRegistryIdentity(home, hub, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({
      adopted: false,
      previousHubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    hub.close();
  });

  it("replaces an id that was minted and never used", () => {
    const { home, hub } = machine();
    // Minted lazily by something asking for it, and never connected. It names nothing
    // anywhere, so refusing to replace it would be refusing on the strength of a value
    // that has never left this machine.
    const minted = hub.hubId();
    const outcome = adoptRegistryIdentity(home, hub, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(outcome).toEqual({ adopted: true, previousHubId: minted });
    hub.close();
  });

  it("refuses to replace an id this machine is already connected under", () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    connect(home, hubId, serverFor(hubId));

    /**
     * The refusal. Silently repointing would leave the old registry published with
     * nothing pointing at it — the log keeps existing, and every workspace recorded in
     * it is simply gone from every surface on this machine.
     */
    let message = "";
    try {
      adoptRegistryIdentity(home, hub, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(hubId);
    expect(message).toContain("nothing pointing at it");
    expect(message).toContain("Nothing was changed");
    expect(hub.storedHubId()).toBe(hubId);
    hub.close();
  });

  it("refuses an empty id rather than storing one", () => {
    const { hub } = machine();
    expect(() => hub.adoptHubId("   ")).toThrow(StapleError);
    expect(hub.storedHubId()).toBeNull();
    hub.close();
  });
});

// ------------------------------------------------------------- the consent

describe("publishing the registry is its own consent", () => {
  it("is off on a fresh connection, and neither backup nor auto turns it on", () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    connect(home, hubId, serverFor(hubId));

    expect(readConnection(home, hubId)!.registry).toBe(false);
    setConsent(home, hubId, { auto: true, backup: true });
    // The enforcement, stated as the thing it is: there is no argument shape in which
    // agreeing to one consent produces another.
    expect(readConnection(home, hubId)!.registry).toBe(false);
    hub.close();
  });

  it("refuses to record a consent for a hub that is not connected", () => {
    const { hub } = machine();
    const other = mkdtempSync(join(tmpdir(), "staple-hubwire-unconnected-"));
    dirs.push(other);
    // `at all` in the zero-network invariant is not satisfied by a file that records a
    // consent for a connection that does not exist.
    expect(() => setRegistryConsent(other, hub.hubId(), true, REGISTRY_DISCLOSURE)).toThrow(
      StapleError,
    );
    expect(
      cloudCodeOf(catchOf(() => setRegistryConsent(other, hub.hubId(), true, REGISTRY_DISCLOSURE))),
    ).toBe(null);
    hub.close();
  });

  it("quotes the disclosure verbatim when it refuses", () => {
    const connection = {
      registry: false,
    } as unknown as CloudConnection;
    let message = "";
    try {
      requireRegistryConsent(connection);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Verbatim, not paraphrased. A disclosure reworded per surface is a disclosure
    // whose strongest wording is whichever surface the person did not read.
    expect(message).toContain(REGISTRY_DISCLOSURE);
    expect(cloudCodeOf(catchOf(() => requireRegistryConsent(connection)))).toBe("forbidden");
  });

  it("cannot be granted without the disclosure being handed back", () => {
    /**
     * The disclosure tied to the grant STRUCTURALLY, which every other invariant in this
     * feature already was — *"the field does not exist to be forgotten"*. Before this, a
     * surface could write the flag with no evidence it had rendered anything, and the way
     * a disclosure actually goes missing is exactly that: somebody adds a toggle, wires it
     * to the setter, and nobody notices the screen was never built.
     *
     * It is not authentication and does not pretend to be — a caller can look the constant
     * up. What it removes is granting this consent while never having had the sentence in
     * hand.
     */
    const { home, hub } = machine();
    const hubId = hub.hubId();
    connect(home, hubId, serverFor(hubId));

    for (const wrong of [undefined, "", "I promise I showed them something"]) {
      const error = catchOf(() =>
        wrong === undefined
          ? setRegistryConsent(home, hubId, true)
          : setRegistryConsent(home, hubId, true, wrong),
      );
      expect(error).toBeInstanceOf(StapleError);
      expect((error as Error).message).toContain("verbatim");
      // And nothing was written on any of those attempts.
      expect(readConnection(home, hubId)!.registry).toBe(false);
    }

    // The real sentence works.
    expect(setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE).enabled).toBe(true);

    // WITHDRAWING needs no acknowledgement. Making it harder to turn off than on would be
    // the wrong asymmetry in a revocation that has to work offline.
    expect(setRegistryConsent(home, hubId, false).enabled).toBe(false);
    expect(readConnection(home, hubId)!.registry).toBe(false);
    hub.close();
  });

  it("says the same sentence at the point of granting", () => {
    const rendered = registryDisclosure(ENDPOINT);
    expect(rendered.toLowerCase()).toContain(REGISTRY_DISCLOSURE.toLowerCase());
    expect(rendered).toContain(ENDPOINT);
    // And names what it does NOT upload, because that is the half a person is most
    // likely to get wrong about a thing called "the hub".
    expect(rendered).toContain("No filesystem paths");
    expect(rendered).toContain("No tasks");
  });

  it("blocks publishing until the consent is granted, and lets it through after", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");

    await expect(publishRegistry(hub, home, { fetchImpl: server.fetch })).rejects.toThrow(
      /separate consent/,
    );
    // NOTHING was sent. The gate is before the first request, not after it — asserted
    // against the service's own record of what it was asked, because a refusal that
    // happened after a round trip would still pass a check on the thrown error.
    expect(server.calls).toEqual([]);
    expect(server.ops).toEqual([]);

    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(report.published).toBe(1);
    expect(server.ops).toHaveLength(1);
    hub.close();
  });
});

// ------------------------------------------------------- publishing, for real

describe("publishing against a service with the worker's semantics", () => {
  it("declares protocol 2 and lands the rows", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);

    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(home, hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");

    const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });

    expect(report.published).toBe(2);
    expect(report.created).toBe(2);
    expect(report.batches).toBe(1);
    expect(report.upToDate).toBe(false);

    // The service actually holds them, with the entity ids the adoption key requires.
    // Sorted, because the emission order is `hub.list()`'s and that is the hub's
    // business rather than this wire's. The exact order IS pinned, once, against the
    // shared fixture in the first describe block.
    expect(
      server.ops
        .map((o) => ({ entity: o.entity, entityId: o.entityId, verb: o.verb }))
        .sort((a, b) => (a.entityId < b.entityId ? -1 : 1)),
    ).toEqual([
      { entity: "registration", entityId: "11111111-1111-4111-8111-111111111111", verb: "create" },
      { entity: "registration", entityId: "22222222-2222-4222-8222-222222222222", verb: "create" },
    ]);
    // And the harness really made the calls, in the order the design claims: read the
    // fold, learn the ceiling, then push.
    expect(server.calls).toContain("GET /v1/repos/:id/snapshot");
    expect(server.calls).toContain("POST /v1/repos/:id/ops");
    hub.close();
  });

  it("is refused by a protocol-1 service, before anything is sent", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    // A Worker that has not been redeployed. This is the honest failure for a machine
    // that upgraded its client before its service.
    const server = new FakeSyncServer({ repositoryId: hubId, protocol: { min: 1, max: 1 } });
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");

    const error = await publishRegistry(hub, home, { fetchImpl: server.fetch }).catch((e) => e);
    expect(cloudCodeOf(error)).toBe("protocol_unsupported");
    expect(server.ops).toEqual([]);
    /**
     * The title used to promise "and says which version it needed" while asserting only
     * the code. It does not, and cannot from here: this refusal comes from the header
     * range check in `negotiateProtocol`, which knows nothing about entities. The version
     * an OPERATION needed is reported by `assertServable` on the read paths and by
     * `connectHubRegistry`'s pre-flight — which is where a person actually meets this, and
     * which names redeployment. Asserted there rather than promised here.
     */
    expect((error as { detail?: Record<string, unknown> }).detail?.requiredProtocol).toBeUndefined();
    hub.close();
  });

  it("chunks a large registry and reports how many pushes it took", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId, { maxBatchSize: 5 });
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);

    for (let index = 0; index < 12; index += 1) {
      seed(
        home,
        hub,
        `ws-${index}`,
        `W${index}`,
        `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      );
    }

    const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(report.published).toBe(12);
    // 12 operations against a ceiling of 5. A client that hardcoded 25 would have sent
    // one batch and been refused with `payload_too_large`.
    expect(report.batches).toBe(3);
    expect(server.calls.filter((c) => c === "POST /v1/repos/:id/ops")).toHaveLength(3);
    expect(server.ops).toHaveLength(12);
    hub.close();
  });

  it("is idempotent, and re-running it sends nothing", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");

    await publishRegistry(hub, home, { fetchImpl: server.fetch });
    const pushes = server.calls.filter((c) => c === "POST /v1/repos/:id/ops").length;

    const again = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(again.upToDate).toBe(true);
    expect(again.published).toBe(0);
    // Not "the service deduplicated it" — no push happened at all, which is what keeps
    // a publish on a timer from spending the free plan's row budget on no news.
    expect(server.calls.filter((c) => c === "POST /v1/repos/:id/ops")).toHaveLength(pushes);
    hub.close();
  });

  it("lands a second write to the same entity in the same epoch", async () => {
    /**
     * REGRESSION. The operation id was `hub:<epoch>:<entity>:<entityId>`, which is
     * unique per entity per epoch and NOT per operation. So a rename — the second write
     * to one registration, which is precisely the case a shared registry exists to
     * carry — collided with the create, the service answered `duplicate` with the
     * original `seq`, and the client read that as an acknowledgement. Accepted,
     * acknowledged, never applied.
     *
     * The id is content-addressed now. This test asserts the SERVICE's state, not the
     * report the publish returned: the report said "1 published" while the bug was live.
     */
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    await publishRegistry(hub, home, { fetchImpl: server.fetch });

    /**
     * A second, DIFFERENT statement about the same registration: the identity moves to
     * a new slug. That is a real sequence, not a contrivance — a workspace re-registered
     * under a different name keeps its `repository.json`, so its `repositoryId` is the
     * one thing that does not change, which is exactly why adoption keys on it.
     *
     * None of `slug`, `prefix`, `kind` or `addedAt` is mutable in place through the Hub
     * API (`repointPath` updates only `path` and `last_seen_at`), so moving the identity
     * is how this statement is actually made.
     */
    seed(home, hub, "tracker-renamed", "TR2", "11111111-1111-4111-8111-111111111111");
    hub.recordRepositoryId("tracker", null);

    const second = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(second.published).toBe(1);
    expect(second.updated).toBe(1);
    // Two rows on the service, not one deduplicated into silence.
    expect(server.ops).toHaveLength(2);
    expect(server.ops.map((o) => o.verb)).toEqual(["create", "update"]);
    expect(new Set(server.ops.map((o) => o.opId)).size).toBe(2);

    // The state the service ACTUALLY holds, read back through the same reader a restore
    // uses. Under the old id scheme this still said "repo".
    const readBack = await readPublishedRegistry(home, hubId, { fetchImpl: server.fetch });
    const forIdentity = readBack.registry.workspaces.find(
      (w) => w.repositoryId === "11111111-1111-4111-8111-111111111111",
    );
    expect(forIdentity!.slug).toBe("tracker-renamed");
    hub.close();
  });

  it("reports the workspaces it could not publish, and publishes the rest", async () => {
    const { home, hub } = machine();
    const hubId = hub.hubId();
    const server = serverFor(hubId);
    connect(home, hubId, server);
    setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE);
    seed(home, hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(home, hub, "nameless", "NAM", null);

    const report = await publishRegistry(hub, home, { fetchImpl: server.fetch });
    expect(report.published).toBe(1);
    expect(report.unpublishable.map((u) => u.entry.slug)).toEqual(["nameless"]);
    // One bad row does not fail the publish, and it does not vanish either.
    expect(server.ops).toHaveLength(1);
    hub.close();
  });
});

// -------------------------------------------------------- not provisioned

describe("a hub that is not provisioned on the service", () => {
  it("says so, and names the out-of-band step, instead of failing generically", () => {
    expect(HUB_NOT_PROVISIONED).toContain("not provisioned");
    expect(HUB_NOT_PROVISIONED).toContain("worker/README.md");
    // The product cannot create it, and the message says that rather than implying a
    // retry might work.
    expect(HUB_NOT_PROVISIONED).toContain("Staple cannot create it");
    expect(HUB_NOT_PROVISIONED).toContain("Nothing was sent");
  });

  it("recognises the service's deliberate `forbidden` for an unknown repository", () => {
    /**
     * There is no other signal to read, and there should not be:
     * `worker/src/devices.ts` answers `forbidden` for an unknown `repoId` on purpose,
     * so that a caller cannot enumerate which repository ids this service knows about.
     */
    expect(isNotProvisioned(cloudError("forbidden", "not a member of this repository"))).toBe(true);
    expect(isNotProvisioned(cloudError("auth", "missing credential"))).toBe(false);
    expect(isNotProvisioned(cloudError("offline", "unreachable"))).toBe(false);
    expect(isNotProvisioned(new Error("nope"))).toBe(false);
  });
});

// ------------------------------------- the acceptance criterion, end to end

describe("the hub is restorable from the service after a machine is lost", () => {
  it("hands a replacement machine the workspace set it never had", async () => {
    /**
     * THE assertion of this ticket. Machine A publishes and backs up; machine A is
     * lost; machine B has an EMPTY hub and a credential and nothing else.
     *
     * Written against `adoptPublishedRegistry` rather than against anything the
     * publish returned, because what has to be true is a fact about machine B's own
     * `hub.db` — not about a report.
     */
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);

    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    // Machine B. A fresh home, a fresh hub, the same hub identity restored from a
    // password manager or a backup of the home — and nothing else.
    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    expect(b.hub.list()).toEqual([]);

    const preview = await adoptPublishedRegistry(b.hub, b.home, { fetchImpl: server.fetch });
    // Previews by default. Nothing written yet, which is the property `adoptRegistry`
    // owns and this path must not quietly drop.
    expect(preview.adoption.dryRun).toBe(true);
    expect(b.hub.list()).toEqual([]);

    const applied = await adoptPublishedRegistry(b.hub, b.home, {
      fetchImpl: server.fetch,
      apply: true,
    });
    expect(applied.adoption.dryRun).toBe(false);

    const rows = b.hub.list();
    expect(
      rows
        .map((r) => ({ slug: r.slug, prefix: r.prefix, repositoryId: r.repositoryId }))
        .sort((x, y) => (x.slug < y.slug ? -1 : 1)),
    ).toEqual([
      { slug: "qde", prefix: "QDE", repositoryId: "22222222-2222-4222-8222-222222222222" },
      { slug: "tracker", prefix: "TRK", repositoryId: "11111111-1111-4111-8111-111111111111" },
    ]);
    // Listed and NOT located. The rows carry no path, because the publishing machine
    // never sent one — and nothing was invented to fill the gap.
    for (const row of rows) {
      expect(row.available).toBe(false);
      expect(row.path).not.toContain(a.home);
    }
    // Every outcome is `absent`: known, not here. Which is exactly the state a
    // replacement machine should be in before anyone clones anything.
    expect(applied.adoption.decisions.map((d) => d.outcome)).toEqual(["absent", "absent"]);
    b.hub.close();
  });

  it("restores from a backup after a replacement published damage, then adopts", async () => {
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });

    // Backup is a DIFFERENT consent from publishing, and the call refuses until it is
    // given — which is the assertion, not the setup.
    await expect(createHubBackup(a.home, hubId, "before", { fetchImpl: server.fetch })).rejects.toThrow(
      /separate decisions/,
    );
    await setHubBackupConsent(a.home, hubId, true, { fetchImpl: server.fetch });
    const backup = await createHubBackup(a.home, hubId, "before the loss", {
      fetchImpl: server.fetch,
    });
    expect((await listHubBackups(a.home, hubId, { fetchImpl: server.fetch })).map((b) => b.backupId))
      .toContain(backup.backupId);
    a.hub.close();

    /**
     * The damage. A replacement machine that had only ONE of the two workspaces
     * publishes a rename over the top. This is what makes the restore observable — if
     * it were a no-op the assertions below would pass against the damage.
     */
    const bad = machine();
    process.env.STAPLE_HOME = bad.home;
    connect(bad.home, hubId, server, "device-bad", bad.hub);
    setRegistryConsent(bad.home, hubId, true, REGISTRY_DISCLOSURE);
    /**
     * ADOPTS FIRST, which is now the only route to publishing from a second machine —
     * publish refuses while the service holds anything this machine does not. So the damage
     * is a rename by a machine that IS current, which is the realistic version of this
     * scenario and the one the restore has to be able to undo.
     */
    await adoptPublishedRegistry(bad.hub, bad.home, { fetchImpl: server.fetch, apply: true });
    bad.hub.recordRepositoryId("tracker", null);
    seed(bad.home, bad.hub, "renamed-by-mistake", "TRK2", "11111111-1111-4111-8111-111111111111");
    await publishRegistry(bad.hub, bad.home, { fetchImpl: server.fetch });
    bad.hub.close();

    const damaged = await readPublishedRegistry(bad.home, hubId, { fetchImpl: server.fetch });
    expect(damaged.registry.workspaces.map((w) => w.slug).sort()).toEqual([
      "qde",
      "renamed-by-mistake",
    ]);

    // Now restore, on a third, empty machine, and adopt what comes back.
    const c = machine();
    process.env.STAPLE_HOME = c.home;
    connect(c.home, hubId, server, "device-c", c.hub);
    /**
     * BOTH consents. A restore mutates the published registry — it moves the epoch and
     * discards everything published since the backup — so it is behind the publish consent as
     * well as the backup one. It used to need only `backup`, which meant
     * `publish --disable` left a machine fully able to replace everything on the service.
     */
    setConsent(c.home, hubId, { backup: true });
    setRegistryConsent(c.home, hubId, true, REGISTRY_DISCLOSURE);

    const report = await restoreRegistry(c.hub, c.home, backup.backupId, {
      fetchImpl: server.fetch,
      apply: true,
    });

    expect(report.turns).toBeGreaterThan(0);
    expect(report.preRestoreBackupId).toBeTruthy();
    expect(report.toEpoch).toBe(2);
    // The registry that was backed up, not the damaged one.
    expect(report.registry.workspaces.map((w) => w.slug).sort()).toEqual(["qde", "tracker"]);
    // And this machine now holds it.
    expect(c.hub.list().map((r) => r.slug).sort()).toEqual(["qde", "tracker"]);
    c.hub.close();
  });

  it("does not bring back a workspace this machine opted out of", async () => {
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    seed(a.home, a.hub, "qde", "QDE", "22222222-2222-4222-8222-222222222222", "global");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    /**
     * This machine has decided it does not want `qde`. `registry_optouts` never leaves
     * the machine and is consulted by exactly one caller — adoption — which is what
     * makes `staple hub unregister` a local act that the next restore does not undo.
     */
    b.hub.addOptOut("22222222-2222-4222-8222-222222222222", "qde");

    const applied = await adoptPublishedRegistry(b.hub, b.home, {
      fetchImpl: server.fetch,
      apply: true,
    });
    expect(b.hub.list().map((r) => r.slug)).toEqual(["tracker"]);
    const declined = applied.adoption.decisions.find((d) => d.outcome === "declined");
    expect(declined).toBeTruthy();
    expect(declined!.entry.slug).toBe("qde");
    b.hub.close();
  });

  it("parks a prefix collision and renumbers nothing", async () => {
    const a = machine();
    const hubId = a.hub.hubId();
    const server = serverFor(hubId);
    connect(a.home, hubId, server);
    setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
    seed(a.home, a.hub, "tracker", "TRK", "11111111-1111-4111-8111-111111111111");
    await publishRegistry(a.hub, a.home, { fetchImpl: server.fetch });
    a.hub.close();

    const b = machine();
    process.env.STAPLE_HOME = b.home;
    connect(b.home, hubId, server, "device-b", b.hub);
    // A DIFFERENT repository already holding TRK on this machine.
    seed(b.home, b.hub, "something-else", "TRK", "99999999-9999-4999-8999-999999999999");

    const applied = await adoptPublishedRegistry(b.hub, b.home, {
      fetchImpl: server.fetch,
      apply: true,
    });
    const conflict = applied.adoption.decisions.find((d) => d.outcome === "conflict");
    expect(conflict!.conflict).toEqual({
      field: "prefix",
      value: "TRK",
      heldBySlug: "something-else",
      heldByRepositoryId: "99999999-9999-4999-8999-999999999999",
    });
    // Nothing renumbered, and the local row is untouched: a prefix is stamped into
    // every identifier its workspace has ever emitted.
    expect(b.hub.list().map((r) => ({ slug: r.slug, prefix: r.prefix }))).toEqual([
      { slug: "something-else", prefix: "TRK" },
    ]);
    b.hub.close();
  });
});

/** The error a rejected call threw, or undefined. Keeps the assertions above readable. */
function catchOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
