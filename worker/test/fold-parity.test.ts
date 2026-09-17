/**
 * The Worker's half of `fold-parity-fixture.ts`: what a device sees of the fold checkpoint on a
 * log the free plan's limits bind on. `test/cloud-fold-parity.test.ts` holds the fake to the
 * same observations.
 */
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { REPO, call, jsonOf, seedRepo } from "./helpers.js";
import { FOLD_PARITY_OBSERVED, FOLD_PARITY_OPS, observeFoldParity } from "./fold-parity-fixture.js";

it("answers the fold's limits exactly as the fixture records", async () => {
  const token = await seedRepo();
  // Devices taking requests in turn: one may make 120 a minute, and the scenario makes more.
  const fleet = [{ device: "device-a", token }];
  for (let n = 1; n < 8; n += 1) fleet.push({ device: `device-parity-${n}`, token: await seedRepo(REPO, `device-parity-${n}`) });
  let turn = 0;
  await call(`/v1/repos/${REPO}/backup`, { method: "PUT", token, body: { enabled: true } });
  for (let start = 0; start < FOLD_PARITY_OPS.length; start += 50) {
    await env.DB.prepare(
      `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
                        payload, actor, client_seq, schema_version, created_at, server_ts)
       SELECT ?1, json_extract(value, '$.seq'), 1, json_extract(value, '$.opId'), 'device-a',
              json_extract(value, '$.entity'), json_extract(value, '$.entityId'), json_extract(value, '$.verb'),
              CASE WHEN json_extract(value, '$.verb') = 'create' THEN NULL ELSE 1 END,
              json_extract(value, '$.payload'), json_extract(value, '$.actor'), json_extract(value, '$.seq'), 10,
              json_extract(value, '$.createdAt'), json_extract(value, '$.serverTs')
         FROM json_each(?2)`,
    )
      .bind(REPO, JSON.stringify(FOLD_PARITY_OPS.slice(start, start + 50)))
      .run();
  }
  const head = FOLD_PARITY_OPS[FOLD_PARITY_OPS.length - 1]!.seq;
  await env.DB.prepare(`UPDATE repos SET last_seq = ?2 WHERE repo_id = ?1`).bind(REPO, head).run();

  const observed = await observeFoldParity({
    repoId: REPO,
    async send(method, path, body) {
      const member = fleet[turn++ % fleet.length]!;
      const response = await call(`/v1/repos/${REPO}${path}`, { method, token: member.token, device: member.device, ...(body === undefined ? {} : { body }) });
      return { status: response.status, body: await jsonOf(response) };
    },
    async clearFold() {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM fold_versions WHERE repo_id = ?1`).bind(REPO),
        env.DB.prepare(`DELETE FROM fold_marks WHERE repo_id = ?1`).bind(REPO),
      ]);
    },
    async stagedKeys(epoch) {
      const rows = await env.DB.prepare(`SELECT entity, entity_id FROM ops WHERE repo_id = ?1 AND epoch = ?2 ORDER BY seq`)
        .bind(REPO, epoch)
        .all<{ entity: string; entity_id: string }>();
      return rows.results.map((row) => `${row.entity} ${row.entity_id}`);
    },
  });
  expect(observed).toEqual(FOLD_PARITY_OBSERVED);
}, 120_000);
