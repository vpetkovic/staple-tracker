/**
 * A device on an older build, pushing through the real wire.
 *
 * Some behaviours only exist between builds: a current device settles a later claim on an
 * identifier by renumbering its own issue (`src/core/cloud/claims.ts`), and a device on a
 * build from before that never does. The conflict that follows is real — it is what a
 * current device meets while any of its peers is not upgraded — so tests of resolving it
 * need a peer that pushes a plain `create` and nothing after it.
 *
 * This is that peer: its operations go through the fake service's own push route, with the
 * envelope every build sends, so the service validates them exactly as it would a real
 * device's. It never pulls, so it never settles anything.
 */
import { randomUUID } from "node:crypto";
import type { FakeSyncServer } from "./fake-sync-server.js";

export interface OlderBuildOp {
  readonly entity: string;
  readonly entityId: string;
  readonly verb: "create" | "update" | "replace";
  readonly payload: Record<string, unknown>;
  readonly baseVersion?: number | null;
  /** When the operation was written. Now, unless a test needs a time it can tell apart. */
  readonly createdAt?: string;
}

export class OlderBuildDevice {
  private clientSeq = 0;
  readonly token = `token-${randomUUID()}`;

  constructor(
    private readonly server: FakeSyncServer,
    private readonly repositoryId: string,
    readonly deviceId: string,
    /** The workspace schema its operations are stamped with. */
    private readonly schema: number,
  ) {
    server.enroll(deviceId, this.token);
  }

  async push(ops: readonly OlderBuildOp[]): Promise<Array<{ opId: string; status: string; seq: number }>> {
    const envelopes = ops.map((op) => {
      this.clientSeq += 1;
      return {
        opId: randomUUID().replace(/-/g, ""),
        repoId: this.repositoryId,
        protocol: 1,
        schema: this.schema,
        entity: op.entity,
        entityId: op.entityId,
        verb: op.verb,
        baseVersion: op.verb === "create" ? null : (op.baseVersion ?? 0),
        payload: op.payload,
        deviceId: this.deviceId,
        actor: "older-build",
        clientSeq: this.clientSeq,
        createdAt: op.createdAt ?? new Date().toISOString(),
      };
    });
    const response = await this.server.fetch(
      `https://sync.test.example/v1/repos/${encodeURIComponent(this.repositoryId)}/ops`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "staple-protocol": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ops: envelopes }),
      },
    );
    const body = (await response.json()) as { results?: Array<{ opId: string; status: string; seq: number }> };
    if (!response.ok || !body.results) throw new Error(`older-build push refused: ${JSON.stringify(body)}`);
    return body.results;
  }
}
