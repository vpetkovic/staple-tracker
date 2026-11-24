import { beforeEach, describe, expect, it } from "vitest";
import { REPO, call, envelope, expectError, pushOps, seedRepo } from "./helpers.js";
let token: string;
beforeEach(async () => { token = await seedRepo(); });

describe("external links require protocol 5", () => {
  it("admits resource/link/stack operations and refuses an older reader without dropping entities", async () => {
    const ops = ["externalResource", "externalLink", "externalStack"].map((entity, i) => envelope({
      clientSeq: i + 1, protocol: 5, entity, entityId: `external-${i}`, verb: "create", baseVersion: null, payload: { marker: entity },
    }));
    const refused = await expectError(await pushOps([{ ...ops[0]!, protocol: 4 }], { token, protocol: 4 }), "protocol_unsupported", 426);
    expect(refused.requiredProtocol).toBe(5);
    expect((await pushOps(ops, { token, protocol: 5 })).status).toBe(200);
    const old = await expectError(await call(`/v1/repos/${REPO}/ops`, { token, protocol: 4 }), "protocol_unsupported", 426);
    expect(old.requiredProtocol).toBe(5);
    const page = await call(`/v1/repos/${REPO}/ops`, { token, protocol: 5 });
    expect(page.status).toBe(200);
    expect(JSON.stringify(await page.json())).toContain("externalStack");
  });

  it("retains permanent identities and allows association deletion", async () => {
    for (const entity of ["externalResource", "externalStack"]) {
      await expectError(await pushOps([envelope({ protocol: 5, entity, entityId: "source", verb: "delete", baseVersion: 1, payload: {} })], { token, protocol: 5 }), "validation", 400);
    }
    expect((await pushOps([envelope({ protocol: 5, entity: "externalLink", entityId: "association", verb: "delete", baseVersion: 1, payload: {} })], { token, protocol: 5 })).status).toBe(200);
  });
});
