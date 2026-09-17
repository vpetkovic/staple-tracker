/**
 * The fake's half of `worker/test/fold-parity-fixture.ts`: the fold checkpoint as a device sees
 * it — "still folding" answers and their `foldedSeq`, snapshot pages and restore turns cut by
 * count and by UTF-8 bytes, and the order a restore stages in — must be exactly what the Worker
 * answered (`worker/test/fold-parity.test.ts`), configured with the free plan's limits.
 */
import { expect, it } from "vitest";
import { FOLD_PARITY_LIMITS, FOLD_PARITY_OBSERVED, FOLD_PARITY_OPS, observeFoldParity } from "../worker/test/fold-parity-fixture.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO = "f01d0000-0000-4000-8000-00000000fa11";
const ENDPOINT = "https://sync.test.example";

it("answers the fold's limits exactly as the Worker does", async () => {
  const server = new FakeSyncServer({ repositoryId: REPO, ...FOLD_PARITY_LIMITS });
  server.enroll("device-a", "stpl_parity");
  server.backupEnabled = true;
  for (const op of FOLD_PARITY_OPS) {
    server.ops.push({
      seq: op.seq,
      epoch: 1,
      opId: op.opId,
      deviceId: "device-a",
      entity: op.entity,
      entityId: op.entityId,
      verb: op.verb,
      baseVersion: op.verb === "create" ? null : 1,
      payload: JSON.parse(op.payload) as unknown,
      actor: op.actor,
      clientSeq: op.seq,
      schema: 10,
      createdAt: op.createdAt,
      serverTs: op.serverTs,
    });
  }
  server.lastSeq = FOLD_PARITY_OPS[FOLD_PARITY_OPS.length - 1]!.seq;

  const observed = await observeFoldParity({
    repoId: REPO,
    async send(method, path, body) {
      const headers: Record<string, string> = {
        "Staple-Protocol": "1",
        Authorization: "Bearer stpl_parity",
        "Staple-Device": "device-a",
      };
      let payload: string | undefined;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(payload, "utf8"));
      }
      const response = await server.fetch(`${ENDPOINT}/v1/repos/${REPO}${path}`, { method, headers, body: payload });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    async clearFold() {
      server.foldedTo.clear();
    },
    async stagedKeys(epoch) {
      return server.ops
        .filter((op) => op.epoch === epoch)
        .sort((a, b) => a.seq - b.seq)
        .map((op) => `${op.entity} ${op.entityId}`);
    },
  });
  expect(observed).toEqual(FOLD_PARITY_OBSERVED);
});
