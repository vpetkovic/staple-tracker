/**
 * Execution attempts on the service (`docs/execution-telemetry.md`, "Where it lives and what
 * synchronizes"): the protocol-3 vocabulary, and the apply rule the fold shares with every
 * other reader of the log — a stored orphan end never overwrites a real end, and a dropped
 * one leaves no `fieldWrites` for a hydrating device to inherit.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { REPO, call, envelope, expectError, jsonOf, pushOps, seedRepo } from "./helpers.js";

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

const ATTEMPT = "0b6f2c1e-6d0a-4f7e-9d38-2f3b8a1c9e44";

function attemptOp(clientSeq: number, verb: string, payload: Record<string, unknown>): Record<string, unknown> {
  return envelope({
    protocol: 3,
    clientSeq,
    entity: "attempt",
    entityId: ATTEMPT,
    verb,
    baseVersion: verb === "create" ? null : clientSeq - 1,
    payload,
    createdAt: `2026-09-24T15:00:0${clientSeq}.000Z`,
  });
}

const created = {
  issueId: "issue-1",
  agent: "opus-s1",
  state: "running",
  outcome: null,
  endReason: null,
  endDetection: null,
  endedBy: null,
  endedAt: null,
  endedAtSource: null,
  openedBy: "checkout",
  startedAt: "2026-09-24T14:09:31.710Z",
  claim: { scope: "local", fencingToken: null },
};

const orphanEnd = {
  state: "ended",
  outcome: "interrupted",
  endReason: "claim_moved",
  endDetection: "inferred",
  endedBy: null,
  endedAt: "2026-09-24T14:50:00.000Z",
  endedAtSource: "last_activity",
};

const realEnd = {
  state: "ended",
  outcome: "interrupted",
  endReason: "claim_stolen",
  endDetection: "inferred",
  endedBy: "sonnet-s2",
  endedAt: "2026-09-24T14:50:00.000Z",
  endedAtSource: "last_activity",
};

async function snapshotAttempt(protocol = 3): Promise<{ state: Record<string, unknown>; fieldWrites: Record<string, { opId: string }> }> {
  const body = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token, protocol }));
  return body.entities.find((entity: { entity: string }) => entity.entity === "attempt");
}

describe("the attempt vocabulary is protocol 3", () => {
  it("refuses an attempt pushed at protocol 2, naming the version that admits it", async () => {
    const body = await expectError(
      await pushOps([{ ...attemptOp(1, "create", created), protocol: 2 }], { token, protocol: 2 }),
      "protocol_unsupported",
      426,
    );
    expect(body.requiredProtocol).toBe(3);
    expect(body.max).toBe(3);
  });

  it("refuses a protocol-1 device a page or a fold that holds one, and serves a protocol-3 device", async () => {
    await pushOps([attemptOp(1, "create", created)], { token, protocol: 3 });
    const page = await expectError(await call(`/v1/repos/${REPO}/ops`, { token, protocol: 1 }), "protocol_unsupported", 426);
    expect(page).toMatchObject({ requiredProtocol: 3, entity: "attempt" });
    await expectError(await call(`/v1/repos/${REPO}/snapshot`, { token, protocol: 1 }), "protocol_unsupported", 426);
    expect((await call(`/v1/repos/${REPO}/ops`, { token, protocol: 3 })).status).toBe(200);
  });

  it("admits create and update on an attempt, create alone on a transition", async () => {
    await expectError(await pushOps([attemptOp(1, "delete", {})], { token, protocol: 3 }), "validation", 400);
    await expectError(
      await pushOps(
        [envelope({ protocol: 3, entity: "attemptTransition", entityId: "t-1", verb: "update", baseVersion: 0, payload: { kind: "attempt_paused" } })],
        { token, protocol: 3 },
      ),
      "validation",
      400,
    );
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ops`).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });
});

describe("the fold: a stored orphan end never overwrites a real end", () => {
  it("keeps the real end when the orphan end arrives after it, and gives the orphan's keys no provenance", async () => {
    await pushOps([attemptOp(1, "create", created), attemptOp(2, "update", realEnd), attemptOp(3, "update", orphanEnd)], { token, protocol: 3 });
    const folded = await snapshotAttempt();
    expect(folded.state).toMatchObject(realEnd);
    for (const field of Object.keys(realEnd)) expect(folded.fieldWrites[field]?.opId, field).toBe("op-2");
  });

  it("lets the real end overwrite an orphan end that arrived first", async () => {
    await pushOps([attemptOp(1, "create", created), attemptOp(2, "update", orphanEnd), attemptOp(3, "update", realEnd)], { token, protocol: 3 });
    const folded = await snapshotAttempt();
    expect(folded.state).toMatchObject(realEnd);
    for (const field of Object.keys(realEnd)) expect(folded.fieldWrites[field]?.opId, field).toBe("op-3");
  });

  it("applies the ordinary rules otherwise: an orphan end over a running attempt lands", async () => {
    await pushOps([attemptOp(1, "create", created), attemptOp(2, "update", orphanEnd)], { token, protocol: 3 });
    expect((await snapshotAttempt()).state).toMatchObject(orphanEnd);
  });

  it("a backup is the same fold, and records the lowest protocol that can replay it", async () => {
    await env.DB.prepare(`UPDATE repos SET backup_enabled = 1 WHERE repo_id = ?1`).bind(REPO).run();
    await pushOps([attemptOp(1, "create", created), attemptOp(2, "update", realEnd), attemptOp(3, "update", orphanEnd)], { token, protocol: 3 });
    const made = await jsonOf<{ backup: { backupId: string } }>(
      await call(`/v1/repos/${REPO}/backups`, { method: "POST", token, protocol: 3, body: {} }),
    );
    const row = await env.DB.prepare(`SELECT state, protocol FROM backups WHERE backup_id = ?1`)
      .bind(made.backup.backupId)
      .first<{ state: string; protocol: number }>();
    // A Worker rolled back to protocol 2 cannot restore it, and says so.
    expect(row!.protocol).toBe(3);
    const entity = (JSON.parse(row!.state) as { entities: Array<{ entity: string; state: Record<string, unknown> }> }).entities.find(
      (candidate) => candidate.entity === "attempt",
    );
    expect(entity!.state).toMatchObject(realEnd);
  });
});
