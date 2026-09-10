/**
 * A repository holds ONE vocabulary (STA-290).
 *
 * Before migration 0005 the Worker could not tell a hub repository from a workspace one,
 * so a `registration` pushed at a workspace's `repoId` was accepted. From then on every
 * protocol-1 client of that workspace got a non-retryable 426 on `GET /ops` and
 * `GET /snapshot`, permanently, and a restore carried the row into the new epoch.
 *
 * Every test here drives the real router. The race tests call the Worker's own `fetch`
 * with a wrapped `DB` whose `batch()` waits at a gate, which is the only way to make an
 * interleaving happen on purpose rather than hope for it: both requests have
 * authenticated, both have passed every check that runs before the batch, and only then
 * are their batches let go.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  DEVICE,
  ORIGIN,
  REPO,
  bumpEpoch,
  call,
  envelope,
  jsonOf,
  pushOps,
  seedRepo,
  sha256Hex,
} from "./helpers.js";
import { VOCABULARY_REFUSALS } from "./vocabulary-fixture.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

/** One registry operation at protocol 2, the shape `hub-registry-ops.ts` emits. */
function registration(index: number, repoId = REPO): Record<string, unknown> {
  return {
    opId: `reg-${index}`,
    repoId,
    protocol: 2,
    schema: 12,
    entity: "registration",
    entityId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    verb: "create",
    baseVersion: null,
    payload: {
      format: 1,
      slug: `ws-${index}`,
      prefix: `W${index}`,
      kind: "repo",
      addedAt: "2026-09-10T00:00:00.000Z",
    },
    deviceId: DEVICE,
    actor: "opus-vocab",
    clientSeq: index,
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

/** One workspace operation. `envelope()` is an `issue` update; a create is the first one. */
function issue(index: number): Record<string, unknown> {
  return envelope({
    opId: `issue-${index}`,
    clientSeq: index,
    entityId: `issue-${index}`,
    verb: "create",
    baseVersion: null,
    payload: { title: `work ${index}` },
  });
}

async function repoRow(repoId = REPO): Promise<{
  vocabulary: string | null;
  last_seq: number;
  epoch: number;
}> {
  const row = await env.DB.prepare(
    `SELECT vocabulary, last_seq, epoch FROM repos WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .first<{ vocabulary: string | null; last_seq: number; epoch: number }>();
  return row!;
}

async function opsIn(repoId = REPO): Promise<{ entity: string; epoch: number }[]> {
  const rows = await env.DB.prepare(
    `SELECT entity, epoch FROM ops WHERE repo_id = ?1 ORDER BY seq`,
  )
    .bind(repoId)
    .all<{ entity: string; epoch: number }>();
  return rows.results;
}

/** Status and body together, compared against the shared fixture. */
async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

/**
 * Provision a repository with its vocabulary set explicitly, the way worker/README.md's
 * "Provisioning a repository" and "Provisioning a HUB" now describe.
 */
async function provision(
  repoId: string,
  vocabulary: "hub" | "workspace",
  deviceId = DEVICE,
): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at, vocabulary)
     VALUES (?1, 1, 0, 0, ?2, ?3, ?4)`,
  )
    .bind(repoId, await sha256Hex(`enroll_${repoId}`), now, vocabulary)
    .run();
  const deviceToken = `stpl_test_${repoId}_${deviceId}`;
  await env.DB.prepare(
    `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at, last_seen_at, revoked_at)
     VALUES (?1, ?2, ?3, 'test', ?4, ?4, NULL)`,
  )
    .bind(repoId, deviceId, await sha256Hex(deviceToken), now)
    .run();
  return deviceToken;
}

// ---------------------------------------------------------------- the gate

interface Gate {
  env: Env;
  /** Resolves when this request's `batch()` has been called and is being held. */
  arrived: Promise<void>;
  release: () => void;
  batches: () => number;
}

/**
 * An `env` whose `DB.batch()` parks until released. Everything else is the real binding,
 * so prepared statements, reads and the rate limiter are exactly what the router uses.
 */
function gate(): Gate {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let batches = 0;
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          arrive();
          await released;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB: db } as Env, arrived, release, batches: () => batches };
}

/** A push through the Worker's own `fetch`, against a chosen `env`. */
function pushThrough(
  target: Env,
  ops: Record<string, unknown>[],
  protocol: number,
  bearer = token,
): Promise<Response> {
  const body = JSON.stringify({ protocol, deviceId: DEVICE, ops });
  return worker.fetch(
    new Request(`${ORIGIN}/v1/repos/${REPO}/ops`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Staple-Protocol": String(protocol),
        "Staple-Device": DEVICE,
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
      body,
    }),
    target,
  );
}

// --------------------------------------------------------------- migration

describe("migration 0005", () => {
  it("adds a nullable vocabulary the database itself constrains to 'hub' or 'workspace'", async () => {
    const columns = await env.DB.prepare(`PRAGMA table_info(repos)`).all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const column = columns.results.find((c) => c.name === "vocabulary");
    expect(column).toMatchObject({ notnull: 0, dflt_value: null });

    // Provisioning is a hand-written INSERT, so a typo is the likely failure. The CHECK
    // makes it a refused statement instead of a repository no vocabulary ever matches.
    await expect(
      env.DB.prepare(`UPDATE repos SET vocabulary = 'Hub' WHERE repo_id = ?1`).bind(REPO).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect((await repoRow()).vocabulary).toBeNull();
  });

  it("backfills from the log: registry-only is hub, workspace-only is workspace, both is workspace, none is NULL", async () => {
    const repos = {
      hub: "aaaaaaaa-0000-4000-8000-000000000001",
      workspace: "aaaaaaaa-0000-4000-8000-000000000002",
      // Pre-0005 contamination. The registry rows are the contamination, and the
      // recovery recipe in worker/README.md removes them, so the repository is a
      // workspace. A hub answer would refuse the workspace's own devices.
      mixed: "aaaaaaaa-0000-4000-8000-000000000003",
      // The mix spread across epochs, as a restore leaves it: every epoch counts.
      mixedAcrossEpochs: "aaaaaaaa-0000-4000-8000-000000000004",
      empty: "aaaaaaaa-0000-4000-8000-000000000005",
    };
    const rows: [string, number, number, string][] = [
      [repos.hub, 1, 1, "registration"],
      [repos.hub, 1, 2, "crossLink"],
      [repos.workspace, 1, 1, "issue"],
      [repos.workspace, 1, 2, "comment"],
      [repos.mixed, 1, 1, "issue"],
      [repos.mixed, 1, 2, "registration"],
      [repos.mixedAcrossEpochs, 1, 1, "issue"],
      [repos.mixedAcrossEpochs, 2, 2, "registration"],
    ];
    for (const repoId of Object.values(repos)) await seedRepo(repoId, DEVICE, `t_${repoId}`);
    for (const [repoId, epoch, seq, entity] of rows) {
      await env.DB.prepare(
        `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb,
                          base_version, payload, actor, client_seq, schema_version, created_at, server_ts)
         VALUES (?1, ?2, ?3, ?4, 'd', ?5, 'e', 'create', NULL, '{}', 'a', ?2, 12, 'now', 0)`,
      )
        .bind(repoId, seq, epoch, `op-${seq}`, entity)
        .run();
    }

    // The REAL migration text, minus the ALTER that already ran in setup. This is the
    // statement `wrangler d1 migrations apply` executes against the deployed database.
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0005_"));
    expect(migration, "migrations/0005_*.sql").toBeDefined();
    const backfill = migration!.queries.filter((q) => !/ALTER\s+TABLE/i.test(q));
    expect(backfill.length).toBeGreaterThan(0);
    for (const statement of backfill) await env.DB.prepare(statement).run();

    const result: Record<string, string | null> = {};
    for (const [name, repoId] of Object.entries(repos)) {
      result[name] = (await repoRow(repoId)).vocabulary;
    }
    expect(result).toEqual({
      hub: "hub",
      workspace: "workspace",
      mixed: "workspace",
      mixedAcrossEpochs: "workspace",
      empty: null,
    });
  });
});

// ------------------------------------------------------------- first push

describe("the first push claims the repository's vocabulary", () => {
  it("claims 'workspace' for a workspace batch", async () => {
    expect((await repoRow()).vocabulary).toBeNull();
    expect((await pushOps([issue(1)], { token })).status).toBe(200);
    expect(await repoRow()).toMatchObject({ vocabulary: "workspace", last_seq: 1 });
  });

  it("claims 'hub' for a registry batch", async () => {
    expect((await pushOps([registration(1)], { token, protocol: 2 })).status).toBe(200);
    expect(await repoRow()).toMatchObject({ vocabulary: "hub", last_seq: 1 });
  });

  it("claims nothing for an empty batch or a refused one", async () => {
    expect((await pushOps([], { token, protocol: 2 })).status).toBe(200);
    // Refused whole at validation: a registry op with a verb it may never take.
    const refused = await pushOps([{ ...registration(1), verb: "delete", baseVersion: 1 }], {
      token,
      protocol: 2,
    });
    expect(refused.status).toBe(400);
    expect((await repoRow()).vocabulary).toBeNull();
    // So the workspace that owns it can still claim it.
    expect((await pushOps([issue(1)], { token })).status).toBe(200);
    expect((await repoRow()).vocabulary).toBe("workspace");
  });

  it("still deduplicates a replayed batch in its own vocabulary", async () => {
    const batch = [registration(1), registration(2)];
    expect((await pushOps(batch, { token, protocol: 2 })).status).toBe(200);
    const replay = await jsonOf(await pushOps(batch, { token, protocol: 2 }));
    expect(replay.results.map((r: { status: string }) => r.status)).toEqual([
      "duplicate",
      "duplicate",
    ]);
  });
});

// ----------------------------------------------------------------- refusal

describe("the other vocabulary is refused at ingest", () => {
  it("refuses registry operations into a workspace repository and writes nothing", async () => {
    await pushOps([issue(1), issue(2)], { token });
    const before = await repoRow();

    const refused = await pushOps([registration(3)], { token, protocol: 2 });
    expect(await answer(refused)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);

    expect(await repoRow()).toEqual(before);
    expect((await opsIn()).map((r) => r.entity)).toEqual(["issue", "issue"]);

    // The point of the whole ticket: the workspace's protocol-1 clients are not bricked.
    // Before 0005 both of these answered a permanent 426 after that push.
    expect((await call(`/v1/repos/${REPO}/ops`, { token, protocol: 1 })).status).toBe(200);
    expect((await call(`/v1/repos/${REPO}/snapshot`, { token, protocol: 1 })).status).toBe(200);
  });

  it("refuses workspace operations into a hub repository and writes nothing", async () => {
    await pushOps([registration(1)], { token, protocol: 2 });
    const before = await repoRow();

    // At protocol 2 AND at protocol 1 — the vocabulary is about the entities, not the
    // header, and a protocol-1 workspace client is the likely one to be misdirected.
    for (const protocol of [1, 2]) {
      const refused = await pushOps([{ ...issue(5), protocol }], { token, protocol });
      expect(await answer(refused)).toEqual(VOCABULARY_REFUSALS.workspaceIntoHub);
    }

    expect(await repoRow()).toEqual(before);
    expect((await opsIn()).map((r) => r.entity)).toEqual(["registration"]);
  });

  it("honours a vocabulary set at provisioning, before any operation exists", async () => {
    const hubId = "bbbbbbbb-0000-4000-8000-000000000001";
    const hubToken = await provision(hubId, "hub");
    const refused = await pushOps([{ ...issue(1), repoId: hubId }], {
      token: hubToken,
      repoId: hubId,
    });
    expect(await answer(refused)).toEqual(VOCABULARY_REFUSALS.workspaceIntoHub);
    expect(await opsIn(hubId)).toEqual([]);

    const workspaceId = "bbbbbbbb-0000-4000-8000-000000000002";
    const workspaceToken = await provision(workspaceId, "workspace");
    const alsoRefused = await pushOps([registration(1, workspaceId)], {
      token: workspaceToken,
      repoId: workspaceId,
      protocol: 2,
    });
    expect(await answer(alsoRefused)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
    expect(await opsIn(workspaceId)).toEqual([]);
  });

  it("refuses before any batch when authentication already read the vocabulary", async () => {
    await pushOps([issue(1)], { token });
    const held = gate();
    held.release();
    const refused = await pushThrough(held.env, [registration(2)], 2);
    expect(await answer(refused)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
    // No batch at all: the refusal costs the authentication query and nothing else.
    expect(held.batches()).toBe(0);
  });
});

// -------------------------------------------------------------------- race

describe("two concurrent first pushes of different vocabularies", () => {
  /**
   * Both requests authenticate against an UNCLAIMED repository and both pass every check
   * that runs before the batch — `arrived` resolving is the proof, because it fires
   * inside `batch()`. From there only the in-batch guard stands between them.
   */
  async function race(order: "hub-first" | "workspace-first" | "together") {
    const hub = gate();
    const workspace = gate();
    const hubPush = pushThrough(hub.env, [registration(1), registration(2)], 2);
    const workspacePush = pushThrough(workspace.env, [issue(1), issue(2), issue(3)], 1);
    await Promise.all([hub.arrived, workspace.arrived]);
    expect((await repoRow()).vocabulary).toBeNull();

    let hubResponse: Response;
    let workspaceResponse: Response;
    if (order === "hub-first") {
      hub.release();
      hubResponse = await hubPush;
      workspace.release();
      workspaceResponse = await workspacePush;
    } else if (order === "workspace-first") {
      workspace.release();
      workspaceResponse = await workspacePush;
      hub.release();
      hubResponse = await hubPush;
    } else {
      hub.release();
      workspace.release();
      [hubResponse, workspaceResponse] = await Promise.all([hubPush, workspacePush]);
    }
    return {
      hub: await answer(hubResponse),
      workspace: await answer(workspaceResponse),
      batches: hub.batches() + workspace.batches(),
    };
  }

  /** Exactly one winner, and the loser left no trace: no row, no slot, no claim. */
  async function expectOneWinner(outcome: Awaited<ReturnType<typeof race>>): Promise<void> {
    expect(outcome.batches).toBe(2);
    const hubWon = outcome.hub.status === 200;
    const workspaceWon = outcome.workspace.status === 200;
    expect([hubWon, workspaceWon].filter(Boolean)).toHaveLength(1);

    const row = await repoRow();
    const entities = (await opsIn()).map((r) => r.entity);
    if (hubWon) {
      expect(outcome.workspace).toEqual(VOCABULARY_REFUSALS.workspaceIntoHub);
      expect(row).toMatchObject({ vocabulary: "hub", last_seq: 2 });
      expect(entities).toEqual(["registration", "registration"]);
    } else {
      expect(outcome.hub).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
      expect(row).toMatchObject({ vocabulary: "workspace", last_seq: 3 });
      expect(entities).toEqual(["issue", "issue", "issue"]);
    }
  }

  it("the hub batch lands first: the workspace batch is refused and writes nothing", async () => {
    const outcome = await race("hub-first");
    expect(outcome.hub.status).toBe(200);
    await expectOneWinner(outcome);
  });

  it("the workspace batch lands first: the hub batch is refused and writes nothing", async () => {
    const outcome = await race("workspace-first");
    expect(outcome.workspace.status).toBe(200);
    await expectOneWinner(outcome);
  });

  it("released together, D1 serializes them and exactly one wins", async () => {
    await expectOneWinner(await race("together"));
  });
});

// ------------------------------------------------------------ epoch fence

describe("an epoch that moves between authentication and the batch", () => {
  /**
   * The inserts are conditioned on the reservation having happened — same epoch, same
   * vocabulary — so an epoch that moved writes nothing and is reported as what it is.
   * Before, the inserts ran unreserved and only a primary-key collision stopped them,
   * which does not happen when the window they compute falls on unused slots.
   */
  async function pushAcrossAnEpochMove(): Promise<Response> {
    const held = gate();
    const pending = pushThrough(held.env, [issue(7), issue(8)], 1);
    await held.arrived;
    await bumpEpoch();
    held.release();
    return pending;
  }

  it("is epoch_changed on an unclaimed repository, and claims nothing", async () => {
    const response = await pushAcrossAnEpochMove();
    const body = await jsonOf(response);
    expect({ status: response.status, code: body.code, currentEpoch: body.currentEpoch }).toEqual({
      status: 409,
      code: "epoch_changed",
      currentEpoch: 2,
    });
    expect(await opsIn()).toEqual([]);
    expect(await repoRow()).toMatchObject({ vocabulary: null, last_seq: 0, epoch: 2 });
  });

  it("is epoch_changed even where the computed window falls on unused slots", async () => {
    await pushOps([issue(1)], { token });
    // Slots 2..4 reserved and unused, exactly as deduplication leaves them.
    await env.DB.prepare(`UPDATE repos SET last_seq = 4 WHERE repo_id = ?1`).bind(REPO).run();

    const response = await pushAcrossAnEpochMove();
    expect((await jsonOf(response)).code).toBe("epoch_changed");
    // Nothing landed in the new epoch at seqs 3 and 4 below the watermark.
    expect(await opsIn()).toEqual([{ entity: "issue", epoch: 1 }]);
    expect(await repoRow()).toMatchObject({ last_seq: 4, epoch: 2 });
  });
});

// ---------------------------------------------------------------- restore

describe("a restore keeps the rule", () => {
  async function enableBackup(protocol = 2): Promise<void> {
    const response = await call(`/v1/repos/${REPO}/backup`, {
      method: "PUT",
      token,
      protocol,
      body: { enabled: true },
    });
    expect(response.status).toBe(200);
  }

  async function backup(protocol = 2): Promise<string> {
    const created = await jsonOf(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, protocol, body: {} }),
    );
    return created.backup.backupId as string;
  }

  function beginRestore(backupId: string, protocol = 2): Promise<Response> {
    return call(`/v1/repos/${REPO}/backups/${backupId}/restore`, {
      method: "POST",
      token,
      protocol,
      body: { confirm: REPO },
    });
  }

  /** Nothing a refused begin could have touched moved. */
  async function expectUntouched(backupsBefore: number, epoch = 1): Promise<void> {
    const restores = await env.DB.prepare(`SELECT COUNT(*) AS n FROM restores`).first<{
      n: number;
    }>();
    const backups = await env.DB.prepare(`SELECT COUNT(*) AS n FROM backups`).first<{
      n: number;
    }>();
    expect({ restores: restores!.n, backups: backups!.n }).toEqual({
      restores: 0,
      backups: backupsBefore,
    });
    expect((await repoRow()).epoch).toBe(epoch);
    expect((await opsIn()).filter((r) => r.epoch > epoch)).toEqual([]);
  }

  it("refuses a hub backup into a workspace repository, before the undo is captured", async () => {
    await pushOps([registration(1)], { token, protocol: 2 });
    await enableBackup();
    const hubBackup = await backup();
    // The operator ran the recovery recipe and reclassified the repository: the registry
    // rows were the contamination, and the workspace is what it really holds.
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(REPO).run();
    await env.DB.prepare(`UPDATE repos SET vocabulary = 'workspace' WHERE repo_id = ?1`)
      .bind(REPO)
      .run();

    expect(await answer(await beginRestore(hubBackup))).toEqual(
      VOCABULARY_REFUSALS.hubIntoWorkspace,
    );
    await expectUntouched(1);
  });

  it("refuses a backup holding both vocabularies, whatever the repository holds", async () => {
    // Pre-0005 contamination, which no route can produce any more: written directly.
    for (const [seq, entity] of [
      [1, "issue"],
      [2, "registration"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb,
                          base_version, payload, actor, client_seq, schema_version, created_at, server_ts)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?3, 'create', NULL, '{"title":"x"}', 'a', ?2, 12, 'now', 0)`,
      )
        .bind(REPO, seq, `op-${seq}`, DEVICE, entity)
        .run();
    }
    await env.DB.prepare(
      `UPDATE repos SET last_seq = 2, vocabulary = 'workspace' WHERE repo_id = ?1`,
    )
      .bind(REPO)
      .run();
    await enableBackup();
    const mixed = await backup();

    expect(await answer(await beginRestore(mixed))).toEqual(VOCABULARY_REFUSALS.mixedBackup);
    await expectUntouched(1);
  });

  it("claims an unclaimed repository for the backup's vocabulary at begin", async () => {
    await pushOps([registration(1), registration(2)], { token, protocol: 2 });
    await enableBackup();
    const hubBackup = await backup();
    // Every row gone and the claim cleared — the one way a repository with a non-empty
    // backup can be unclaimed after 0005.
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(REPO).run();
    await env.DB.prepare(`UPDATE repos SET vocabulary = NULL WHERE repo_id = ?1`)
      .bind(REPO)
      .run();

    const begun = await beginRestore(hubBackup);
    expect(begun.status).toBe(200);
    const restoreId = (await jsonOf(begun)).restoreId as string;
    expect((await repoRow()).vocabulary).toBe("hub");

    // The restore is staging hub entities into the next epoch. A workspace push that
    // arrives now must not claim the repository out from under it.
    expect(await answer(await pushOps([issue(9)], { token }))).toEqual(
      VOCABULARY_REFUSALS.workspaceIntoHub,
    );

    let done = false;
    for (let turn = 0; turn < 10 && !done; turn += 1) {
      const response = await call(`/v1/repos/${REPO}/backups/${hubBackup}/restore`, {
        method: "POST",
        token,
        protocol: 2,
        body: { confirm: REPO, restoreId },
      });
      expect(response.status).toBe(200);
      done = (await jsonOf(response)).done === true;
    }
    expect(done).toBe(true);
    const page = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token, protocol: 2 }));
    expect(page.entities.map((e: { entity: string }) => e.entity)).toEqual([
      "registration",
      "registration",
    ]);
  });

  it("refuses when a push claims the other vocabulary between reading the repository and claiming it", async () => {
    await pushOps([registration(1)], { token, protocol: 2 });
    await enableBackup();
    const hubBackup = await backup();
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(REPO).run();
    await env.DB.prepare(`UPDATE repos SET vocabulary = NULL WHERE repo_id = ?1`)
      .bind(REPO)
      .run();

    /**
     * The interleaving, made to happen: the restore has read the repository as unclaimed,
     * and a workspace push's claim lands before the restore's own claim statement runs.
     * The claim is guarded, matches nothing, and the restore must say so rather than
     * stage hub entities into a repository that is now a workspace.
     */
    const interleaved = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("UPDATE repos SET vocabulary = ?2")) return statement;
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  await target
                    .prepare(`UPDATE repos SET vocabulary = 'workspace' WHERE repo_id = ?1`)
                    .bind(REPO)
                    .run();
                  return statement.bind(...values).run();
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const body = JSON.stringify({ confirm: REPO });
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/repos/${REPO}/backups/${hubBackup}/restore`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Staple-Protocol": "2",
          "Staple-Device": DEVICE,
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(body).length),
        },
        body,
      }),
      { ...env, DB: interleaved } as Env,
    );
    expect(await answer(response)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
    await expectUntouched(1);
    expect((await repoRow()).vocabulary).toBe("workspace");
  });

  it("refuses a stage turn of a restore that began before the rule existed", async () => {
    await pushOps([registration(1)], { token, protocol: 2 });
    await enableBackup();
    const hubBackup = await backup();
    await env.DB.prepare(`DELETE FROM ops WHERE repo_id = ?1`).bind(REPO).run();
    await env.DB.prepare(`UPDATE repos SET vocabulary = NULL WHERE repo_id = ?1`)
      .bind(REPO)
      .run();
    const begun = await jsonOf(await beginRestore(hubBackup));
    // What a pre-0005 begin leaves: a staging restore of hub entities into a repository
    // that is, in fact, a workspace. Nothing at begin ever looked.
    await env.DB.prepare(`UPDATE repos SET vocabulary = 'workspace' WHERE repo_id = ?1`)
      .bind(REPO)
      .run();

    const turn = await call(`/v1/repos/${REPO}/backups/${hubBackup}/restore`, {
      method: "POST",
      token,
      protocol: 2,
      body: { confirm: REPO, restoreId: begun.restoreId },
    });
    expect(await answer(turn)).toEqual(VOCABULARY_REFUSALS.hubIntoWorkspace);
    // Not one entity reached the epoch being built.
    expect((await opsIn()).filter((r) => r.epoch === 2)).toEqual([]);
  });

  it("restores a workspace backup into its own workspace repository as before", async () => {
    await pushOps([issue(1)], { token });
    await enableBackup(1);
    const own = await backup(1);
    const begun = await beginRestore(own, 1);
    expect(begun.status).toBe(200);
    expect((await repoRow()).vocabulary).toBe("workspace");
  });
});
