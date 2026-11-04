/**
 * Protocol 4 admits `attachment`, and only create and delete.
 *
 * The Worker stores the payload verbatim. What this file pins is the gate: a
 * protocol-3 client cannot push one, and an update is refused because a changed
 * file is a new attachment.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { REPO, call, envelope, expectError, pushOps, seedRepo } from "./helpers.js";

const payload = {
  issueId: "00000000-0000-4000-8000-000000000001",
  filename: "note.txt",
  mediaType: "text/plain",
  size: 4,
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  author: null,
  caption: null,
  byteSync: "local",
  createdAt: "2026-10-01T00:00:00.000Z",
};

let token: string;

beforeEach(async () => {
  token = await seedRepo();
});

describe("attachments are protocol 4", () => {
  it("refuses an attachment below 4, and admits create and delete only", async () => {
    const refused = await expectError(
      await pushOps(
        [envelope({ protocol: 3, entity: "attachment", entityId: "file-1", verb: "create", baseVersion: null, payload })],
        { token, protocol: 3 },
      ),
      "protocol_unsupported",
      426,
    );
    expect(refused.requiredProtocol).toBe(4);
    expect(refused.max).toBe(4);

    expect(
      (
        await pushOps(
          [envelope({ protocol: 4, entity: "attachment", entityId: "file-1", verb: "create", baseVersion: null, payload })],
          { token, protocol: 4 },
        )
      ).status,
    ).toBe(200);

    await expectError(
      await pushOps(
        [envelope({ protocol: 4, entity: "attachment", entityId: "file-1", verb: "update", baseVersion: 1, payload: { caption: "later" } })],
        { token, protocol: 4 },
      ),
      "validation",
      400,
    );

    const page = await expectError(await call(`/v1/repos/${REPO}/ops`, { token, protocol: 3 }), "protocol_unsupported", 426);
    expect(page).toMatchObject({ requiredProtocol: 4, entity: "attachment" });
  });
});
