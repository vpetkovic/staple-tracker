/**
 * The hub registry on the wire (STA-283).
 *
 * The hub is a repository scoped by its own `hub.hubId()`, and its operation log is
 * two entity kinds. Everything else this service already had — the fold, the
 * snapshot, the backup, the restore — applies unchanged, and the point of this file
 * is to prove that rather than to assert it.
 *
 * Every test drives the real routes through `SELF.fetch`. The shapes come from
 * `registry-fixture.ts`, which the ROOT suite reads too — see that file's header for
 * why one shared artifact rather than two independent sets of literals.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE,
  OTHER_REPO,
  REPO,
  call,
  expectError,
  jsonOf,
  pushOps,
  seedRepo,
} from "./helpers.js";
import {
  FIXTURE_FOLDED_STATE,
  FIXTURE_OPS,
  FIXTURE_REGISTRY,
} from "./registry-fixture.js";

/**
 * The hub's repository. `REPO` is reused as the hub's id because at this layer a hub
 * IS a repository — there is no server-side flag distinguishing one, and there
 * deliberately is not: a flag would be a second thing to keep in step with the
 * entities the log actually contains.
 */
const HUB = REPO;

let token: string;

beforeEach(async () => {
  token = await seedRepo(HUB);
});

/** One fixture operation, as a full envelope at the given protocol. */
function op(
  index: number,
  overrides: Record<string, unknown> = {},
  protocol = 2,
): Record<string, unknown> {
  const fixture = FIXTURE_OPS[index]!;
  return {
    opId: `reg-op-${index + 1}`,
    repoId: HUB,
    protocol,
    schema: 12,
    entity: fixture.entity,
    entityId: fixture.entityId,
    verb: fixture.verb,
    baseVersion: fixture.verb === "create" ? null : 1,
    payload: fixture.payload,
    deviceId: DEVICE,
    actor: "opus-hubwire",
    clientSeq: index + 1,
    createdAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

function allOps(protocol = 2): Record<string, unknown>[] {
  return FIXTURE_OPS.map((_, index) => op(index, {}, protocol));
}

async function publishFixture(): Promise<void> {
  const response = await pushOps(allOps(), { token, protocol: 2, repoId: HUB });
  expect(response.status).toBe(200);
  const body = await jsonOf(response);
  expect(body.results.map((r: { status: string }) => r.status)).toEqual([
    "applied",
    "applied",
    "applied",
    "applied",
  ]);
}

describe("the registry entities on the wire", () => {
  it("accepts a registration and a cross-link at protocol 2", async () => {
    await publishFixture();

    // Asserted from the DATABASE, not from the response, because the response is the
    // route's own account of what it did. The rows are what a later fold reads.
    const rows = await env.DB.prepare(
      `SELECT entity, entity_id, verb, payload FROM ops WHERE repo_id = ?1 ORDER BY seq`,
    )
      .bind(HUB)
      .all<{ entity: string; entity_id: string; verb: string; payload: string }>();

    expect(
      rows.results.map((r) => ({
        entity: r.entity,
        entityId: r.entity_id,
        verb: r.verb,
        payload: JSON.parse(r.payload),
      })),
    ).toEqual(
      // `baseVersion` is an envelope field with no column of its own in this projection —
      // it is stored, and `push.ts` writes it to `base_version`. Compared where it
      // matters, which is the client's `opId` derivation, not here.
      FIXTURE_OPS.map((f) => ({
        entity: f.entity,
        entityId: f.entityId,
        verb: f.verb,
        payload: { ...f.payload },
      })),
    );
  });

  it("stores a path-like slug verbatim, because a slug is a name", async () => {
    await publishFixture();
    const row = await env.DB.prepare(
      `SELECT payload FROM ops WHERE repo_id = ?1 AND entity_id = ?2`,
    )
      .bind(HUB, "22222222-2222-4222-8222-222222222222")
      .first<{ payload: string }>();
    // The person called this workspace "/Users/someone/projects/qde". Publishing the
    // name is the whole feature; scrubbing anything path-shaped would corrupt it.
    expect(JSON.parse(row!.payload).slug).toBe("/Users/someone/projects/qde");
    // And there is no `path` key at all, on any registration. Not redacted — the
    // client's payload type has no such field to forget.
    const all = await env.DB.prepare(
      `SELECT payload FROM ops WHERE repo_id = ?1 AND entity = 'registration'`,
    )
      .bind(HUB)
      .all<{ payload: string }>();
    for (const r of all.results) {
      expect(Object.keys(JSON.parse(r.payload)).sort()).toEqual([
        "addedAt",
        "format",
        "kind",
        "prefix",
        "slug",
      ]);
    }
  });
});

describe("the protocol gate", () => {
  it("refuses a registry entity at protocol 1, naming the version that admits it", async () => {
    const body = await expectError(
      await pushOps([op(0, {}, 1)], { token, protocol: 1, repoId: HUB }),
      "protocol_unsupported",
      426,
    );
    expect(body.min).toBe(1);
    expect(body.max).toBe(2);
    expect(body.requiredProtocol).toBe(2);
  });

  it("writes nothing when one operation in a batch needs a newer protocol", async () => {
    // A batch is validated whole before any statement is prepared. The registry
    // operation is in the MIDDLE so this cannot pass by refusing at the first index.
    const issueOp = {
      opId: "plain-1",
      repoId: HUB,
      protocol: 1,
      schema: 12,
      entity: "issue",
      entityId: "issue-1",
      verb: "create",
      baseVersion: null,
      payload: { title: "ordinary work" },
      deviceId: DEVICE,
      actor: "opus-hubwire",
      clientSeq: 1,
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    await expectError(
      await pushOps([issueOp, op(0, { clientSeq: 2, protocol: 1 }, 1), { ...issueOp, opId: "plain-2", clientSeq: 3 }], {
        token,
        protocol: 1,
        repoId: HUB,
      }),
      "protocol_unsupported",
      426,
    );

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(HUB)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
    const repo = await env.DB.prepare(`SELECT last_seq FROM repos WHERE repo_id = ?1`)
      .bind(HUB)
      .first<{ last_seq: number }>();
    expect(repo!.last_seq).toBe(0);
  });

  it("refuses to PULL a log containing a registry entity at protocol 1", async () => {
    await publishFixture();
    const body = await expectError(
      await call(`/v1/repos/${HUB}/ops`, { token, protocol: 1 }),
      "protocol_unsupported",
      426,
    );
    expect(body.requiredProtocol).toBe(2);
    expect(body.max).toBe(2);
    // The entity NAME is disclosed, because otherwise the client cannot say which
    // feature the upgrade is for. It is a fixed word from this Worker's own closed
    // vocabulary, not user data.
    expect(body.entity).toBe("registration");
  });

  it("refuses to SNAPSHOT a repository containing a registry entity at protocol 1", async () => {
    await publishFixture();
    const body = await expectError(
      await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 1 }),
      "protocol_unsupported",
      426,
    );
    expect(body.requiredProtocol).toBe(2);
  });

  it("refuses the WHOLE snapshot, not the pages that happen to be admissible", async () => {
    await publishFixture();
    // A page size of 1 would serve the two cross-links first if the check were per
    // page — they sort before `registration` — leaving a device holding half a
    // hydration of a repository it cannot finish reading.
    await expectError(
      await call(`/v1/repos/${HUB}/snapshot?limit=1`, { token, protocol: 1 }),
      "protocol_unsupported",
      426,
    );
  });

  it("still serves an ordinary log at protocol 1", async () => {
    // The gate is about the ENTITIES present, not about the repository. A protocol-1
    // client reading a repository with no registry entity in it is untouched, which is
    // the whole reason `PROTOCOL_MIN` did not move.
    await pushOps(
      [
        {
          opId: "plain-1",
          repoId: HUB,
          protocol: 1,
          schema: 12,
          entity: "issue",
          entityId: "issue-1",
          verb: "create",
          baseVersion: null,
          payload: { title: "ordinary work" },
          deviceId: DEVICE,
          actor: "opus-hubwire",
          clientSeq: 1,
          createdAt: "2026-09-09T12:00:00.000Z",
        },
      ],
      { token, protocol: 1, repoId: HUB },
    );
    expect((await call(`/v1/repos/${HUB}/ops`, { token, protocol: 1 })).status).toBe(200);
    expect((await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 1 })).status).toBe(200);
  });

  it("reports the negotiated protocol on every pulled operation", async () => {
    await publishFixture();
    const page = await jsonOf(await call(`/v1/repos/${HUB}/ops`, { token, protocol: 2 }));
    expect(page.protocol).toBe(2);
    // Was a hardcoded 1 before this change, which was true only while 1 was the only
    // version there was.
    expect(page.ops.map((o: { protocol: number }) => o.protocol)).toEqual([2, 2, 2, 2]);
  });
});

describe("the verbs a registry entity may never take", () => {
  /**
   * Asserted against these entities BY NAME, not against the ordered-collection
   * allowlist. The allowlist refuses them today only because neither name is in it,
   * and adding a third ordered collection later would prompt no thought about the
   * registry. See the explicit assertion in `envelope.ts`.
   */
  for (const entity of ["registration", "crossLink"] as const) {
    for (const verb of ["replace", "renumber"] as const) {
      it(`refuses ${verb} on ${entity}`, async () => {
        const body = await expectError(
          await pushOps(
            [op(0, { entity, verb, baseVersion: 1, payload: { members: ["a"] } })],
            { token, protocol: 2, repoId: HUB },
          ),
          "validation",
          400,
        );
        expect(String(body.message)).toContain("ops[0].verb");
      });
    }
  }

  it("still admits replace for an ordered collection and renumber for an issue", async () => {
    // The negative tests above would also pass if the checks refused everything.
    const queue = op(0, {
      opId: "queue-1",
      entity: "queue",
      entityId: "default",
      verb: "replace",
      baseVersion: 1,
      payload: { members: ["issue-1"] },
    });
    expect((await pushOps([queue], { token, protocol: 2, repoId: HUB })).status).toBe(200);
  });
});

describe("the fold, the snapshot and the round trip", () => {
  it("folds the registry to exactly the state the client expects to read back", async () => {
    await publishFixture();
    const page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));

    expect(page.hasMore).toBe(false);
    expect(
      page.entities.map((e: { entity: string; entityId: string; state: unknown }) => ({
        entity: e.entity,
        entityId: e.entityId,
        state: e.state,
      })),
    ).toEqual(FIXTURE_FOLDED_STATE.map((f) => ({ ...f, state: { ...f.state } })));

    for (const entity of page.entities) {
      expect(entity.version).toBe(1);
      expect(entity.deletedAt).toBeNull();
      // `create`, because nothing was superseded — which is the only verb a restore
      // could materialise for these entities, since `replace` is refused for them at
      // ingest and therefore `superseded` can never be true.
      expect(entity.verb).toBe("create");
      // Empty, because a `create` records no per-field provenance (STA-263). A
      // registration's fields arrive together and none of them was "chosen" over
      // another value.
      expect(entity.fieldWrites).toEqual({});
    }
  });

  it("supersedes a registration's slug with an update, merging rather than replacing", async () => {
    await publishFixture();
    const renamed = op(0, {
      opId: "reg-op-rename",
      clientSeq: 9,
      verb: "update",
      baseVersion: 1,
      // ONLY the slug. `fold.ts` merges the keys an operation carried and is silent
      // about the rest, so `prefix`, `kind` and `addedAt` must survive.
      payload: { format: 1, slug: "staple-tracker-renamed" },
    });
    expect((await pushOps([renamed], { token, protocol: 2, repoId: HUB })).status).toBe(200);

    const page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));
    const entity = page.entities.find(
      (e: { entityId: string }) => e.entityId === "11111111-1111-4111-8111-111111111111",
    );
    expect(entity.state).toEqual({
      format: 1,
      slug: "staple-tracker-renamed",
      prefix: "STA",
      kind: "repo",
      addedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entity.version).toBe(2);
    // An update DOES record provenance, and only for the keys it carried.
    expect(Object.keys(entity.fieldWrites).sort()).toEqual(["format", "slug"]);
  });

  it("REFUSES to delete a cross-link, because a tombstone on a derived key is forever", async () => {
    /**
     * The fence, and the reason for it.
     *
     * A cross-link's entity id is derived from its four names, so removing an edge and
     * adding it back produces the SAME id. A tombstone is final in the fold — every later
     * operation on a deleted entity is discarded — so the re-add would be accepted,
     * acknowledged and dropped, for ever, while the push reported success. And a restore
     * carries the tombstone into the new epoch, because `materializedVerb` reproduces a
     * bare `delete`, so the epoch bump is not an escape either.
     *
     * Retraction is therefore a FIELD, and the verb is refused rather than merely unused.
     */
    await publishFixture();
    const removed = op(2, {
      opId: "reg-op-unlink",
      clientSeq: 10,
      verb: "delete",
      baseVersion: 1,
      payload: {},
    });
    const body = await expectError(
      await pushOps([removed], { token, protocol: 2, repoId: HUB }),
      "validation",
      400,
    );
    expect(String(body.message)).toContain("never valid for a registry entity");
    expect(String(body.message)).toContain("retraction is a field");

    // Nothing was written, and the edge is still there and still present.
    const page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));
    const entity = page.entities.find(
      (e: { entityId: string }) => e.entityId === FIXTURE_OPS[2]!.entityId,
    );
    expect(entity.deletedAt).toBeNull();
    expect(entity.state.present).toBe(true);
  });

  it("retracts a cross-link with a field, and lets it be re-added afterwards", async () => {
    /**
     * The whole point of the field: an edge can go away and come back. Under the `delete`
     * verb the third operation here was silently discarded.
     */
    await publishFixture();
    const retract = op(2, {
      opId: "reg-op-retract",
      clientSeq: 11,
      verb: "update",
      baseVersion: 1,
      payload: { ...FIXTURE_OPS[2]!.payload, present: false },
    });
    expect((await pushOps([retract], { token, protocol: 2, repoId: HUB })).status).toBe(200);

    let page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));
    let entity = page.entities.find(
      (e: { entityId: string }) => e.entityId === FIXTURE_OPS[2]!.entityId,
    );
    expect(entity.deletedAt).toBeNull();
    expect(entity.state.present).toBe(false);
    // Every other key survives, because the fold merges and is silent about the rest.
    expect(entity.state.blockerIdentifier).toBe("STA-283");

    const readd = op(2, {
      opId: "reg-op-readd",
      clientSeq: 12,
      verb: "update",
      baseVersion: 2,
      payload: { ...FIXTURE_OPS[2]!.payload, present: true },
    });
    expect((await pushOps([readd], { token, protocol: 2, repoId: HUB })).status).toBe(200);

    page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));
    entity = page.entities.find(
      (e: { entityId: string }) => e.entityId === FIXTURE_OPS[2]!.entityId,
    );
    expect(entity.state.present).toBe(true);
    expect(entity.version).toBe(3);
  });

  it("refuses a batch that mixes registry and workspace entities", async () => {
    /**
     * A hub's log holds only registry entities and a workspace's holds only the others.
     * A mixed batch is always a bug, and the specific accident it fences is a
     * `registration` landing in a WORKSPACE's log — after which every protocol-1 client
     * of that workspace is refused permanently, with no remedy short of a purge.
     */
    const issueOp = {
      opId: "mixed-issue",
      repoId: HUB,
      protocol: 2,
      schema: 12,
      entity: "issue",
      entityId: "issue-1",
      verb: "create",
      baseVersion: null,
      payload: { title: "ordinary work" },
      deviceId: DEVICE,
      actor: "opus-hubwire",
      clientSeq: 1,
      createdAt: "2026-09-09T12:00:00.000Z",
    };
    const body = await expectError(
      await pushOps([issueOp, op(0, { clientSeq: 2 })], { token, protocol: 2, repoId: HUB }),
      "validation",
      400,
    );
    expect(String(body.message)).toContain("may not mix hub registry entities");

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops WHERE repo_id = ?1`)
      .bind(HUB)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);

    // Either vocabulary alone is fine — the refusal is about MIXING.
    expect((await pushOps([issueOp], { token, protocol: 2, repoId: HUB })).status).toBe(200);
  });
});

describe("backup and restore of a hub", () => {
  async function enableBackup(repoId: string, repoToken: string): Promise<void> {
    const response = await call(`/v1/repos/${repoId}/backup`, {
      method: "PUT",
      token: repoToken,
      protocol: 2,
      body: { enabled: true },
    });
    expect(response.status).toBe(200);
  }

  it("stamps a hub backup protocol 2 and an ordinary workspace backup protocol 1", async () => {
    await publishFixture();
    await enableBackup(HUB, token);
    const hubBackup = await jsonOf(
      await call(`/v1/repos/${HUB}/backups`, {
        method: "POST",
        token,
        protocol: 2,
        body: { label: "hub" },
      }),
    );
    expect(hubBackup.backup.protocol ?? (await storedProtocol(HUB, hubBackup.backup.backupId))).toBe(
      2,
    );

    // A repository with nothing but ordinary work stamps 1. This is the assertion that
    // stops the protocol bump from marking every workspace backup as needing a Worker
    // that knows about the hub registry — which would make an older Worker refuse to
    // restore a backup containing nothing it does not understand.
    const otherToken = await seedRepo(OTHER_REPO, DEVICE, "stpl_other");
    await enableBackup(OTHER_REPO, otherToken);
    await pushOps(
      [
        {
          opId: "plain-1",
          repoId: OTHER_REPO,
          protocol: 1,
          schema: 12,
          entity: "issue",
          entityId: "issue-1",
          verb: "create",
          baseVersion: null,
          payload: { title: "ordinary work" },
          deviceId: DEVICE,
          actor: "opus-hubwire",
          clientSeq: 1,
          createdAt: "2026-09-09T12:00:00.000Z",
        },
      ],
      { token: otherToken, protocol: 1, repoId: OTHER_REPO },
    );
    const wsBackup = await jsonOf(
      await call(`/v1/repos/${OTHER_REPO}/backups`, {
        method: "POST",
        token: otherToken,
        protocol: 1,
        body: { label: "ws" },
      }),
    );
    expect(await storedProtocol(OTHER_REPO, wsBackup.backup.backupId)).toBe(1);
  });

  async function storedProtocol(repoId: string, backupId: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT protocol FROM backups WHERE repo_id = ?1 AND backup_id = ?2`,
    )
      .bind(repoId, backupId)
      .first<{ protocol: number }>();
    return row!.protocol;
  }

  it("restores a hub from a backup after everything after it was lost", async () => {
    await publishFixture();
    await enableBackup(HUB, token);
    const created = await jsonOf(
      await call(`/v1/repos/${HUB}/backups`, {
        method: "POST",
        token,
        protocol: 2,
        body: { label: "before the loss" },
      }),
    );
    const backupId = created.backup.backupId as string;

    /**
     * The machine is lost and a replacement publishes a WRONG registry — one
     * workspace renamed and one edge gone. This is what makes the restore
     * observable: if it were a no-op the assertions below would pass against the
     * damage.
     */
    await pushOps(
      [
        op(0, {
          opId: "damage-1",
          clientSeq: 20,
          verb: "update",
          baseVersion: 1,
          payload: { format: 1, slug: "wrong-name" },
        }),
        op(2, { opId: "damage-2", clientSeq: 21, verb: "delete", baseVersion: 1, payload: {} }),
      ],
      { token, protocol: 2, repoId: HUB },
    );

    /**
     * The resumable route, driven exactly as the client drives it: the server decides
     * which phase runs from durable state, and the caller's only job is to keep
     * calling until `done`. `confirm` echoes the repository id — a restore is
     * destructive and the route will not take one without it.
     */
    let turns = 0;
    let done = false;
    let restore: Record<string, unknown> = {};
    let body: Record<string, unknown> = { confirm: HUB };
    while (!done && turns < 20) {
      turns += 1;
      const response = await call(`/v1/repos/${HUB}/backups/${backupId}/restore`, {
        method: "POST",
        token,
        protocol: 2,
        body,
      });
      expect(response.status).toBe(200);
      restore = await jsonOf(response);
      done = restore.done === true;
      body = { confirm: HUB, restoreId: restore.restoreId };
    }
    expect(done).toBe(true);
    expect(restore.toEpoch).toBe(2);
    // The undo. An ordinary backup, restorable by the same route.
    expect(restore.preRestoreBackupId).toBeTruthy();

    // The restored epoch folds back to exactly the registry that was published.
    const page = await jsonOf(await call(`/v1/repos/${HUB}/snapshot`, { token, protocol: 2 }));
    expect(page.epoch).toBe(2);
    expect(
      page.entities
        .filter((e: { deletedAt: number | null }) => e.deletedAt === null)
        .map((e: { entity: string; entityId: string; state: unknown }) => ({
          entity: e.entity,
          entityId: e.entityId,
          state: e.state,
        })),
    ).toEqual(FIXTURE_FOLDED_STATE.map((f) => ({ ...f, state: { ...f.state } })));
  });

  it("refuses to restore a protocol-2 backup at protocol 1", async () => {
    await publishFixture();
    await enableBackup(HUB, token);
    const created = await jsonOf(
      await call(`/v1/repos/${HUB}/backups`, {
        method: "POST",
        token,
        protocol: 2,
        body: { label: "hub" },
      }),
    );
    /**
     * The refusal that matters, and the reason it is not enough for the server to
     * merely be ABLE to write the envelopes.
     *
     * Without this check the restore succeeds, the epoch moves, and the very next
     * `GET /snapshot` refuses at 426 — leaving the device on a timeline it cannot
     * hydrate, having already spent the pre-restore capture. Intact data plus a stuck
     * device looks exactly like corruption.
     */
    const body = await expectError(
      await call(`/v1/repos/${HUB}/backups/${created.backup.backupId}/restore`, {
        method: "POST",
        token,
        protocol: 1,
        body: { confirm: HUB },
      }),
      "protocol_unsupported",
      426,
    );
    expect(body.requiredProtocol).toBe(2);

    // Refused BEFORE anything happened: no epoch move, no staged rows, and no
    // pre-restore backup spent on a restore that was never going to work.
    const repo = await env.DB.prepare(`SELECT epoch FROM repos WHERE repo_id = ?1`)
      .bind(HUB)
      .first<{ epoch: number }>();
    expect(repo!.epoch).toBe(1);
    const restores = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM restores WHERE repo_id = ?1`,
    )
      .bind(HUB)
      .first<{ n: number }>();
    expect(restores!.n).toBe(0);
    const backups = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM backups WHERE repo_id = ?1`,
    )
      .bind(HUB)
      .first<{ n: number }>();
    expect(backups!.n).toBe(1);

    // The same restore at protocol 2 is fine, which is what makes the refusal a
    // protocol statement rather than a broken route.
    expect(
      (
        await call(`/v1/repos/${HUB}/backups/${created.backup.backupId}/restore`, {
          method: "POST",
          token,
          protocol: 2,
          body: { confirm: HUB },
        })
      ).status,
    ).toBe(200);
  });
});

describe("batch ceilings force the client to chunk", () => {
  it("refuses a registry batch larger than the advertised maximum", async () => {
    const advertised = (await jsonOf(await call("/v1/capabilities"))).maxBatchSize as number;
    expect(advertised).toBe(25);

    // A machine with 26 workspaces is an ordinary machine. It must not be the thing
    // that discovers this, which is why the client sizes its chunks from
    // `/v1/capabilities` rather than from a constant.
    const many = Array.from({ length: advertised + 1 }, (_, index) =>
      op(0, {
        opId: `bulk-${index}`,
        clientSeq: index + 1,
        entityId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
        payload: {
          format: 1,
          slug: `ws-${index}`,
          prefix: `W${index}`,
          kind: "repo",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const body = await expectError(
      await pushOps(many, { token, protocol: 2, repoId: HUB }),
      "payload_too_large",
      413,
    );
    expect(body.maxBatchSize).toBe(advertised);

    // And exactly the advertised number goes through.
    expect(
      (await pushOps(many.slice(0, advertised), { token, protocol: 2, repoId: HUB })).status,
    ).toBe(200);
  });
});

describe("the registry is scoped to its own repository", () => {
  it("refuses a registry operation whose repoId is not the credential's", async () => {
    // The hub's identity is a repository id like any other, so the cross-repository
    // refusal that already exists covers it. Asserted here because the hub is the
    // first repository whose id is not a workspace's, and "the hub is special" is
    // exactly the assumption that would put a hole in this.
    await expectError(
      await pushOps([op(0, { repoId: OTHER_REPO })], { token, protocol: 2, repoId: HUB }),
      "forbidden",
      403,
    );
  });

  it("does not leak the registry into another repository's snapshot", async () => {
    await publishFixture();
    const otherToken = await seedRepo(OTHER_REPO, DEVICE, "stpl_other");
    const page = await jsonOf(
      await call(`/v1/repos/${OTHER_REPO}/snapshot`, { token: otherToken, protocol: 2 }),
    );
    expect(page.entities).toEqual([]);
    // And a protocol-1 client reading that repository is not refused either, because
    // there is nothing in it that needs 2.
    expect(
      (await call(`/v1/repos/${OTHER_REPO}/snapshot`, { token: otherToken, protocol: 1 })).status,
    ).toBe(200);
  });
});

describe("the fixture is the shape the client emits", () => {
  it("names the two entities the client's module names", () => {
    // A cheap, load-bearing assertion: this suite and the root suite read the same
    // literals, so if the client renames an entity the root suite fails against this
    // file rather than both suites passing against their own copies.
    expect([...new Set(FIXTURE_OPS.map((o) => o.entity))].sort()).toEqual([
      "crossLink",
      "registration",
    ]);
    expect(FIXTURE_REGISTRY.format).toBe(1);
  });
});
