/**
 * Brain records (the sync claim) against the deployed Worker code:
 * a record rides the protocol-1 `setting` entity, keyed `brain.<id>`, and needs nothing
 * from this service it does not already do. A new entity kind for it would be refused,
 * which is why the client does not use one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { REPO, call, envelope, expectError, jsonOf, pushOps, seedRepo } from "./helpers.js";

const RECORD = {
  kind: "feedback",
  name: "kettle-needs-descaling",
  description: "The office kettle needs descaling every Friday",
  body: "Descale the kettle on Fridays.",
  why: "Hard water clogs it within a week.",
  scope: "global",
  tags: ["from:-Users-x-staple"],
  source: "agent:claude_code/s1",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  verifiedAt: "2026-11-05T10:00:00.000Z",
  supersededBy: null,
  provisional: false,
  // A field this Worker has never heard of: it must come back untouched.
  futureField: { nested: [1, 2, 3] },
};
const KEY = "brain.6f1c2d4e-0000-4000-8000-000000000001";

let token: string;
beforeEach(async () => {
  token = await seedRepo();
});

describe("brain records over the existing sync vocabulary", () => {
  it("accepts a brain record as a protocol-1 setting and serves it back verbatim from the log and the snapshot", async () => {
    const pushed = await pushOps(
      [envelope({ clientSeq: 1, entity: "setting", entityId: KEY, verb: "create", baseVersion: null, payload: { value: RECORD } })],
      { token },
    );
    expect(pushed.status).toBe(200);
    expect((await jsonOf(pushed)).results[0].status).toBe("applied");

    const log = await jsonOf(await call(`/v1/repos/${REPO}/ops`, { token }));
    const op = log.ops.find((o: any) => o.entityId === KEY);
    expect(op.entity).toBe("setting");
    expect(op.payload).toEqual({ value: RECORD });

    const snapshot = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const entity = snapshot.entities.find((e: any) => e.entityId === KEY);
    expect(entity.entity).toBe("setting");
    expect(entity.state.value).toEqual(RECORD);
  });

  it("folds an update over the record and a delete into a tombstone", async () => {
    await pushOps(
      [
        envelope({ clientSeq: 1, entity: "setting", entityId: KEY, verb: "create", baseVersion: null, payload: { value: RECORD } }),
        envelope({ clientSeq: 2, entity: "setting", entityId: KEY, verb: "update", baseVersion: 1, payload: { value: { ...RECORD, body: "edited" } } }),
      ],
      { token },
    );
    let snapshot = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    expect(snapshot.entities.find((e: any) => e.entityId === KEY).state.value.body).toBe("edited");

    await pushOps([envelope({ clientSeq: 3, entity: "setting", entityId: KEY, verb: "delete", baseVersion: 2, payload: {} })], { token });
    snapshot = await jsonOf(await call(`/v1/repos/${REPO}/snapshot`, { token }));
    const gone = snapshot.entities.find((e: any) => e.entityId === KEY);
    expect(gone === undefined || gone.verb === "delete" || gone.deleted === true).toBe(true);
  });

  it("refuses a new entity kind for the same record: that path would need a protocol bump and a deploy", async () => {
    const response = await pushOps(
      [envelope({ clientSeq: 1, entity: "brainRecord", entityId: KEY, verb: "create", baseVersion: null, payload: RECORD })],
      { token },
    );
    await expectError(response, "validation", 400);
  });
});
