/**
 * A fake sync service implementing the members wire contract (the epic's design document,
 * "Wire contract"), statefully, plus `/v1/capabilities` and an empty `GET /devices`.
 * Shared by the CLI-level tests (`cloud-members.test.ts`) and the UI route tests, which
 * serve it over HTTP (`ui-cloud-members.test.ts`).
 */
import { createHash } from "node:crypto";
import { normalizeJoinCode } from "../../src/core/cloud/join-preview.js";

export const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
export const OWNER_TOKEN = "stpl_owner_token";
export const OWNER_DEVICE = "aaaaaaaa-0000-4000-8000-000000000001";
export const OWNER_MEMBER = "mem_owner";

export interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  device: string | null;
  body: unknown;
}

export interface FakeMember {
  memberId: string;
  name: string;
  isOwner: boolean;
  removedAt: number | null;
  removedBy: string | null;
}

export interface FakeDevice {
  deviceId: string;
  memberId: string;
  token: string;
  label: string | null;
  revoked: boolean;
}

export interface FakeRequest {
  requestId: string;
  code: string;
  sha: string;
  deviceId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired" | "collected";
  member: { memberId: string; name: string } | null;
}

/** The members routes of the wire contract, statefully, plus capabilities. */
export class MembersServer {
  constructor(readonly repoId: string = REPO_ID) {}
  readonly calls: Recorded[] = [];
  readonly members: FakeMember[] = [
    { memberId: OWNER_MEMBER, name: "vp", isOwner: true, removedAt: null, removedBy: null },
  ];
  readonly devices: FakeDevice[] = [
    { deviceId: OWNER_DEVICE, memberId: OWNER_MEMBER, token: OWNER_TOKEN, label: "studio", revoked: false },
  ];
  readonly requests: FakeRequest[] = [];
  membersCapability = true;
  now = 1_800_000_000_000;
  private seq = 0;
  /** Fail the next N reads of a join request with this code, for the transient tests. */
  failReads: { code: string; times: number } | null = null;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({
      method,
      path: url.pathname,
      authorization: headers.get("authorization"),
      device: headers.get("staple-device"),
      body,
    });
    try {
      // A join that never settles would poll for ever and exhaust the heap; a test whose
      // subject regressed that way fails here with a sentence instead (a non-retryable code).
      if (this.calls.length > 300) throw new Refusal(400, "validation", "test fake: polled for ever, the join never settled");
      return this.json(200, this.route(method, url.pathname, headers, body as Record<string, unknown>));
    } catch (error) {
      if (error instanceof Refusal) {
        return this.json(error.status, { code: error.code, message: error.message, retryable: false, ...error.extra });
      }
      throw error;
    }
  }) as unknown as typeof fetch;

  /** What someone at another terminal does: approve a request out of band. */
  approve(code: string, as: { name: string } | { memberId: string }): void {
    const request = this.requests.find((r) => r.code === code)!;
    let member: FakeMember;
    if ("name" in as) {
      member = { memberId: `mem_${++this.seq}`, name: as.name, isOwner: false, removedAt: null, removedBy: null };
      this.members.push(member);
    } else {
      member = this.members.find((m) => m.memberId === as.memberId)!;
    }
    request.status = "approved";
    request.member = { memberId: member.memberId, name: member.name };
    request.expiresAt = this.now + 600_000;
  }

  setStatus(code: string, status: FakeRequest["status"]): void {
    this.requests.find((r) => r.code === code)!.status = status;
  }

  /** The names of the routes called, `METHOD /tail`, in order. */
  routes(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path.replace(`/v1/repos/${this.repoId}`, "")}`);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private memberAuth(headers: Headers): FakeDevice {
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const device = this.devices.find((d) => d.token === token);
    if (!device) throw new Refusal(401, "auth", "unknown credential");
    if (device.revoked) {
      const member = this.members.find((m) => m.memberId === device.memberId)!;
      if (member.removedAt !== null) {
        throw new Refusal(403, "revoked", `removed from this workspace by ${member.removedBy}`, {
          removedBy: member.removedBy!,
        });
      }
      throw new Refusal(403, "revoked", "this device was revoked; re-connect required");
    }
    return device;
  }

  private route(method: string, path: string, headers: Headers, body: Record<string, unknown>): unknown {
    if (path === "/v1/capabilities") {
      return {
        protocol: { min: 1, max: 4 },
        maxBatchSize: 25,
        maxOpBytes: 524288,
        maxPullLimit: 500,
        defaultPullLimit: 200,
        maxSnapshotPageSize: 500,
        ...(this.membersCapability ? { members: true } : {}),
      };
    }
    const tail = path.replace(`/v1/repos/${this.repoId}`, "");
    if (tail === "/join-requests" && method === "POST") {
      const code = `K${String(this.requests.length + 1).padStart(3, "0")}-7Q2M`;
      const request: FakeRequest = {
        requestId: `jr_${++this.seq}`,
        code,
        sha: String(body.requestSecretSha256),
        deviceId: String(body.deviceId),
        label: String(body.label),
        createdAt: this.now,
        expiresAt: this.now + 600_000,
        status: "pending",
        member: null,
      };
      this.requests.push(request);
      return { requestId: request.requestId, code, expiresAt: request.expiresAt, protocol: 4 };
    }
    const one = /^\/join-requests\/([^/]+)$/.exec(tail);
    if (one && method === "GET") {
      const request = this.requests.find((r) => r.requestId === decodeURIComponent(one[1]!));
      const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const digest = createHash("sha256").update(bearer, "utf8").digest("hex");
      if (!request || request.sha !== digest) throw new Refusal(401, "auth", "unknown join request");
      if (this.failReads && this.failReads.code === request.code && this.failReads.times > 0) {
        this.failReads.times -= 1;
        throw new Refusal(503, "unavailable", "transient");
      }
      if (request.status === "approved") {
        const token = `stpl_joined_${request.deviceId}`;
        this.devices.push({
          deviceId: request.deviceId,
          memberId: request.member!.memberId,
          token,
          label: request.label,
          revoked: false,
        });
        request.status = "collected";
        return {
          status: "approved",
          token,
          deviceId: request.deviceId,
          member: request.member,
          protocol: 4,
          expiresAt: request.expiresAt,
        };
      }
      return { status: request.status, expiresAt: request.expiresAt };
    }
    const device = this.memberAuth(headers);
    const self = this.members.find((m) => m.memberId === device.memberId)!;
    if (tail === "/join-requests" && method === "GET") {
      return this.requests
        .filter((r) => r.status === "pending")
        .map(({ requestId, code, label, createdAt, expiresAt }) => ({ requestId, code, label, createdAt, expiresAt }));
    }
    const decide = /^\/join-requests\/([^/]+)\/(approve|deny)$/.exec(tail);
    if (decide && method === "POST") {
      const code = normalizeJoinCode(decodeURIComponent(decide[1]!));
      const request = this.requests.find((r) => r.code === code && r.status === "pending");
      if (!request) throw new Refusal(404, "not_found", "no such pending request");
      if (decide[2] === "deny") {
        request.status = "denied";
        return { requestId: request.requestId };
      }
      if (body.newMember !== undefined) {
        if (!self.isOwner) throw new Refusal(403, "forbidden", "only the owner may admit a new member");
        this.approve(code, { name: String((body.newMember as { name: string }).name) });
      } else {
        const memberId = String(body.memberId);
        if (!self.isOwner && memberId !== self.memberId) {
          throw new Refusal(403, "forbidden", "a member may only add devices to themselves");
        }
        this.approve(code, { memberId });
      }
      return { requestId: request.requestId, member: request.member };
    }
    if (tail === "/members" && method === "GET") {
      return {
        protocol: 4,
        self: { memberId: self.memberId, deviceId: device.deviceId },
        members: this.members.map((m) => ({
          memberId: m.memberId,
          name: m.name,
          isOwner: m.isOwner,
          removed: m.removedAt !== null,
          devices: this.devices
            .filter((d) => d.memberId === m.memberId)
            .map((d) => ({ deviceId: d.deviceId, label: d.label, lastSeenAt: this.now - 1000, revoked: d.revoked })),
        })),
      };
    }
    const memberRoute = /^\/members\/([^/]+)$/.exec(tail);
    if (memberRoute) {
      const target = this.members.find((m) => m.memberId === decodeURIComponent(memberRoute[1]!));
      if (!target) throw new Refusal(404, "not_found", "no such member");
      if (method === "PATCH") {
        if (!self.isOwner && target.memberId !== self.memberId) throw new Refusal(403, "forbidden", "not yours to rename");
        target.name = String(body.name);
        return { memberId: target.memberId, name: target.name };
      }
      if (method === "DELETE") {
        if (!self.isOwner || target.memberId === self.memberId) throw new Refusal(403, "forbidden", "owner only, not self");
        target.removedAt = this.now;
        target.removedBy = self.name;
        for (const d of this.devices) if (d.memberId === target.memberId) d.revoked = true;
        return { memberId: target.memberId, removed: true };
      }
    }
    if (tail === "/devices" && method === "GET") {
      return { protocol: 4, devices: [] };
    }
    throw new Refusal(404, "not_found", "no such route");
  }
}

export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

