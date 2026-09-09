/**
 * ONE committed artifact pinning the hub registry wire, read by BOTH suites.
 *
 * ## Why this file exists at all
 *
 * The client half of this wire lives in `src/core/cloud/hub-registry-ops.ts` and runs
 * under Node on vitest 3. The server half lives in `worker/src/` and runs inside
 * workerd on vitest 4, with `lib: ["es2022"]` and no Node types. Neither suite can
 * import the other's module: the client module's transitive graph reaches
 * `node:crypto` (through `StapleError`), which the Worker's tsconfig cannot resolve,
 * and the Worker's modules name `D1Database`, which the root tsconfig cannot.
 *
 * The usual answer is for each side to write its own literals. That is the mistake
 * this epic has now made four times, most exactly as *"a fixture answering with both
 * field names while the real service sent one"* — two independent sets of literals
 * agree with their own author and with nothing else, and both suites go green while
 * the wire is broken.
 *
 * So there is exactly one set of literals, here, and it has NO IMPORTS — which is
 * what makes it the one file both tsconfigs can compile. `worker/test/registry.test.ts`
 * pushes {@link FIXTURE_OPS} through the real routes and asserts the real fold
 * produces {@link FIXTURE_FOLDED_STATE}; `test/cloud-hub-registry-wire.test.ts`
 * asserts the client EMITS {@link FIXTURE_OPS} for {@link FIXTURE_REGISTRY} and
 * reconstructs {@link FIXTURE_REGISTRY} from {@link FIXTURE_FOLDED_STATE}. Change one
 * side's shape and one of the two fails against this file.
 *
 * What it still does not prove is that the deployed Worker behaves like Miniflare.
 * Only `scripts/hub-registry-live.ts` does that, against the real service.
 *
 * ## The contents are deliberately awkward
 *
 * A slug that looks like an absolute path, a slug with a slash and a percent sign in
 * it, unicode, and a workspace with no `repositoryId`. The path-like slugs are the
 * interesting ones: they must survive untouched, because a slug is a NAME the person
 * chose and publishing it is the point — while the hub's real `workspaces.path`
 * column must appear nowhere. A serializer that "protected" the user by scrubbing
 * anything path-shaped would corrupt these, and one that leaked the path column would
 * be caught by the other assertion. Both are pinned.
 */

/** A registry as `exportRegistry` produces it, with two entries and two edges. */
export const FIXTURE_REGISTRY = {
  format: 1,
  hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  capturedAt: "2026-09-09T12:00:00.000Z",
  workspaces: [
    {
      repositoryId: "11111111-1111-4111-8111-111111111111",
      slug: "staple-tracker",
      prefix: "STA",
      kind: "repo",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      // A slug that LOOKS like an absolute path. It is a name, it was chosen by a
      // human, and it travels verbatim. See the header.
      repositoryId: "22222222-2222-4222-8222-222222222222",
      slug: "/Users/someone/projects/qde",
      prefix: "QDE",
      kind: "global",
      addedAt: "2026-02-02T00:00:00.000Z",
    },
    {
      // No identity. NOT publishable, and reported rather than invented — an id
      // minted here would not be the one the repository records later.
      repositoryId: null,
      slug: "no-identity-yet",
      prefix: "NIY",
      kind: "repo",
      addedAt: "2026-03-03T00:00:00.000Z",
    },
  ],
  crossLinks: [
    {
      blockerWs: "staple-tracker",
      blockerIdentifier: "STA-283",
      blockedWs: "/Users/someone/projects/qde",
      blockedIdentifier: "QDE-42",
      type: "blocks",
    },
    {
      // Slash and percent in a component, to pin that the entity id encoding is
      // injective rather than merely usually-unambiguous.
      blockerWs: "a/b",
      blockerIdentifier: "A%2FB-1",
      blockedWs: "wörk—space",
      blockedIdentifier: "WS-7",
      type: "blocks",
    },
  ],
} as const;

/**
 * Exactly the operations the client must emit for {@link FIXTURE_REGISTRY} against a
 * service that holds nothing yet.
 *
 * Order matters and is asserted: registrations in registry order, then cross-links in
 * registry order. Not because the fold cares — it is order-independent by
 * construction — but because a stable order makes a diff of this file readable and
 * makes an accidental reordering visible rather than absorbed.
 *
 * The entry with `repositoryId: null` is ABSENT, and that absence is the assertion.
 */
export const FIXTURE_OPS = [
  {
    entity: "registration",
    entityId: "11111111-1111-4111-8111-111111111111",
    verb: "create",
    payload: {
      format: 1,
      slug: "staple-tracker",
      prefix: "STA",
      kind: "repo",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    entity: "registration",
    entityId: "22222222-2222-4222-8222-222222222222",
    verb: "create",
    payload: {
      format: 1,
      slug: "/Users/someone/projects/qde",
      prefix: "QDE",
      kind: "global",
      addedAt: "2026-02-02T00:00:00.000Z",
    },
  },
  {
    entity: "crossLink",
    // `encodeURIComponent` per component, joined with `/`. The blocked workspace's
    // slashes are escaped, which is what makes the join injective.
    entityId: "staple-tracker/STA-283/%2FUsers%2Fsomeone%2Fprojects%2Fqde/QDE-42",
    verb: "create",
    payload: {
      format: 1,
      blockerWs: "staple-tracker",
      blockerIdentifier: "STA-283",
      blockedWs: "/Users/someone/projects/qde",
      blockedIdentifier: "QDE-42",
      type: "blocks",
    },
  },
  {
    entity: "crossLink",
    entityId: "a%2Fb/A%252FB-1/w%C3%B6rk%E2%80%94space/WS-7",
    verb: "create",
    payload: {
      format: 1,
      blockerWs: "a/b",
      blockerIdentifier: "A%2FB-1",
      blockedWs: "wörk—space",
      blockedIdentifier: "WS-7",
      type: "blocks",
    },
  },
] as const;

/**
 * The folded state `GET /snapshot` must return after {@link FIXTURE_OPS} is pushed,
 * in the Worker's own entity-key order (`entity + " " + entityId`, ascending).
 *
 * Every entity is `version: 1`, `deletedAt: null`, `verb: "create"`, and its state is
 * byte-identical to the payload that was pushed — which is `fold.ts`'s stated
 * behaviour (*"every verb merges its payload's keys over the state"*) with nothing
 * else layered on. `fieldWrites` is empty for all of them because a `create` records
 * no provenance, per STA-263, and asserting that here is what stops a later change
 * from making these entities claim their defaults were chosen.
 */
export const FIXTURE_FOLDED_STATE = [
  {
    entity: "crossLink",
    entityId: "a%2Fb/A%252FB-1/w%C3%B6rk%E2%80%94space/WS-7",
    state: {
      format: 1,
      blockerWs: "a/b",
      blockerIdentifier: "A%2FB-1",
      blockedWs: "wörk—space",
      blockedIdentifier: "WS-7",
      type: "blocks",
    },
  },
  {
    entity: "crossLink",
    entityId: "staple-tracker/STA-283/%2FUsers%2Fsomeone%2Fprojects%2Fqde/QDE-42",
    state: {
      format: 1,
      blockerWs: "staple-tracker",
      blockerIdentifier: "STA-283",
      blockedWs: "/Users/someone/projects/qde",
      blockedIdentifier: "QDE-42",
      type: "blocks",
    },
  },
  {
    entity: "registration",
    entityId: "11111111-1111-4111-8111-111111111111",
    state: {
      format: 1,
      slug: "staple-tracker",
      prefix: "STA",
      kind: "repo",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  },
  {
    entity: "registration",
    entityId: "22222222-2222-4222-8222-222222222222",
    state: {
      format: 1,
      slug: "/Users/someone/projects/qde",
      prefix: "QDE",
      kind: "global",
      addedAt: "2026-02-02T00:00:00.000Z",
    },
  },
] as const;

/**
 * What {@link FIXTURE_REGISTRY} becomes after a publish and a read back.
 *
 * Two differences from {@link FIXTURE_REGISTRY}, and both are the design rather than
 * loss:
 *
 *  - The `repositoryId: null` workspace is gone. It was never publishable, and the
 *    publishing machine was told so by name instead of having something invented for
 *    it.
 *  - `capturedAt` is whatever the READING machine supplied. The service's fold has no
 *    single capture time — it is a fold of a log several machines may have written —
 *    so the honest available fact is when it was read. The round-trip assertions
 *    substitute their own value for this field before comparing.
 *
 * Order is the Worker's entity-key order, because that is the order a snapshot page
 * arrives in and `registryFromSnapshot` preserves it rather than re-sorting into
 * something the sender would recognise.
 */
export const FIXTURE_ROUND_TRIPPED = {
  format: 1,
  hubId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  capturedAt: "2026-09-09T13:00:00.000Z",
  workspaces: [
    {
      repositoryId: "11111111-1111-4111-8111-111111111111",
      slug: "staple-tracker",
      prefix: "STA",
      kind: "repo",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      repositoryId: "22222222-2222-4222-8222-222222222222",
      slug: "/Users/someone/projects/qde",
      prefix: "QDE",
      kind: "global",
      addedAt: "2026-02-02T00:00:00.000Z",
    },
  ],
  crossLinks: [
    {
      blockerWs: "a/b",
      blockerIdentifier: "A%2FB-1",
      blockedWs: "wörk—space",
      blockedIdentifier: "WS-7",
      type: "blocks",
    },
    {
      blockerWs: "staple-tracker",
      blockerIdentifier: "STA-283",
      blockedWs: "/Users/someone/projects/qde",
      blockedIdentifier: "QDE-42",
      type: "blocks",
    },
  ],
} as const;

/**
 * A hub id for the tests. Not a real one, and shaped like a UUID because
 * `hub.hubId()` mints a `randomUUID()`.
 */
export const FIXTURE_HUB_ID = FIXTURE_REGISTRY.hubId;
