import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE, REPO, call, envelope, jsonOf, pushOps, seedRepo } from "./helpers.js";

/**
 * Redaction is total: no token, in whole or in part, appears in logs, error messages
 * or responses.
 *
 * Workers Logs documents NO redaction mechanism of its own, so this is a property of
 * the code and not of the platform — which means it has to be a test rather than a
 * claim. These spy on the real `console` and drive real authenticated requests.
 */

let token: string;
let captured: string[];

beforeEach(async () => {
  token = await seedRepo();
  captured = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      for (const arg of args) {
        captured.push(typeof arg === "string" ? arg : safeStringify(arg));
      }
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function assertNoSecret(): void {
  const all = captured.join("\n");
  expect(all).not.toContain(token);
  // Not even a prefix. "The first few characters" is a real disclosure, and the
  // contract says redaction is total — in whole OR IN PART.
  expect(all).not.toContain(token.slice(0, 16));
  expect(all).not.toContain(token.slice(5, 21));
  expect(all).not.toMatch(/stpl_/);
}

describe("secret redaction in logs", () => {
  it("logs a successful push without the credential", async () => {
    const response = await pushOps([envelope({ clientSeq: 1 })], { token });
    expect(response.status).toBe(200);

    expect(captured.length).toBeGreaterThan(0);
    assertNoSecret();
  });

  it("logs a pull without the credential", async () => {
    await pushOps([envelope({ clientSeq: 1 })], { token });
    captured = [];
    await call(`/v1/repos/${REPO}/ops`, { token });
    assertNoSecret();
  });

  it("logs a connect without the credential it just minted", async () => {
    const response = await call(`/v1/repos/${REPO}/connect`, {
      method: "POST",
      token: `enroll_${REPO}`,
      body: { deviceId: "device-new" },
      device: null,
    });
    const minted = (await jsonOf(response)).token as string;

    const all = captured.join("\n");
    // Neither the enrollment credential that was presented...
    expect(all).not.toContain(`enroll_${REPO}`);
    // ...nor the token that was just handed out.
    expect(all).not.toContain(minted);
    expect(all).not.toContain(minted.slice(0, 16));
  });

  it("logs a rejected credential without echoing what was presented", async () => {
    await call(`/v1/repos/${REPO}/ops`, { token: "stpl_a_wrong_but_plausible_secret" });
    expect(captured.join("\n")).not.toContain("stpl_a_wrong_but_plausible_secret");
  });

  it("logs a token fingerprint that is not derived from the plaintext", async () => {
    await pushOps([envelope({ clientSeq: 1 })], { token });

    const withFp = captured.find((line) => line.includes("token_fp"));
    expect(withFp).toBeDefined();
    const fp = JSON.parse(withFp!).token_fp as string;

    // Four bytes of the SHA-256 we already computed for the lookup: enough to follow
    // one device through a log, and a preimage-resistant dead end for a reader.
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(token).not.toContain(fp);
  });

  it("never logs the request URL, so a credential in a query string could not leak", async () => {
    // Nothing in this service accepts a credential in a query parameter. This asserts
    // the logs would not carry one even if someone later added one by mistake.
    await call(`/v1/repos/${REPO}/ops?limit=5&access_token=stpl_leaked_in_a_url`, { token });
    const all = captured.join("\n");
    expect(all).not.toContain("stpl_leaked_in_a_url");
    expect(all).not.toContain("access_token");
  });

  it("logs only allowlisted keys", async () => {
    await pushOps([envelope({ clientSeq: 1 })], { token });

    const allowed = new Set([
      "event",
      "status",
      "duration_ms",
      "repo_id",
      "device_id",
      "token_fp",
      "op_count",
      "applied_count",
      "duplicate_count",
      "seq_from",
      "seq_to",
      "epoch",
      "entity_count",
      "protocol",
      "code",
      "route",
      "method",
    ]);

    for (const line of captured) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        expect(allowed.has(key), `unexpected log key: ${key}`).toBe(true);
      }
    }
  });

  it("does not log an operation payload", async () => {
    // Comment bodies and document revisions are the highest-value content in the
    // database. They are stored, deliberately and disclosed as such — but they have no
    // business in a log line.
    const secretish = "a-comment-body-nobody-should-see-in-a-log";
    await pushOps(
      [envelope({ clientSeq: 1, entity: "comment", payload: { body: secretish } })],
      { token },
    );
    expect(captured.join("\n")).not.toContain(secretish);
  });

  it("does not echo the failing statement or the error object on an unexpected throw", async () => {
    // Break D1 underneath the route so the Worker takes its unexpected-error path.
    const brokenEnv = {
      ...env,
      DB: {
        prepare() {
          throw new Error(`D1_ERROR: near "SELECT": token_sha256 = X'${"ab".repeat(32)}'`);
        },
      },
    };

    const response = await (
      await import("../src/index.js")
    ).default.fetch(
      new Request(`https://sync.test/v1/repos/${REPO}/ops`, {
        headers: { Authorization: `Bearer ${token}`, "Staple-Protocol": "1" },
      }),
      brokenEnv as any,
    );

    expect(response.status).toBe(503);
    const body = await jsonOf(response);
    // A stable typed error, not the internal failure.
    expect(body.code).toBe("unavailable");
    expect(JSON.stringify(body)).not.toContain("D1_ERROR");
    expect(JSON.stringify(body)).not.toContain("token_sha256");

    const all = captured.join("\n");
    expect(all).not.toContain("D1_ERROR");
    expect(all).not.toContain("token_sha256");
    // Only the error's class name is logged.
    expect(all).toContain("Error");
  });
});

describe("secret redaction in responses", () => {
  it("never returns the credential on a normal response", async () => {
    const response = await pushOps([envelope({ clientSeq: 1 })], { token });
    expect(await response.text()).not.toContain(token);
  });

  it("never returns the credential in an error body", async () => {
    const response = await call(`/v1/repos/${REPO}/ops`, {
      token,
      headers: { "Staple-Protocol": "77" },
    });
    expect(await response.text()).not.toContain(token);
  });

  it("returns the minted token exactly once, at connect, and never again", async () => {
    const minted = (
      await jsonOf(
        await call(`/v1/repos/${REPO}/connect`, {
          method: "POST",
          token: `enroll_${REPO}`,
          body: { deviceId: "device-new" },
          device: null,
        }),
      )
    ).token as string;

    const devices = await call(`/v1/repos/${REPO}/devices`, { token });
    expect(await devices.text()).not.toContain(minted);
  });

  it("does not reflect a rejected envelope's field values back to the caller", async () => {
    // A rejected envelope is attacker-controlled input, and a reflected value is one
    // console.log away from being stored.
    const marker = "reflect-me-please-0xdeadbeef";
    const response = await pushOps([envelope({ clientSeq: 1, entity: marker })], { token });
    expect(await response.text()).not.toContain(marker);
  });
});

describe("the log allowlist has no bypass", () => {
  it("routes every console call through src/log.ts", async () => {
    // The static half of this guarantee is `npm run lint:logs`, which fails if any
    // file under src/ other than log.ts calls console.*. This is the dynamic half:
    // whatever was logged during a full request round trip, it came from the
    // allowlisting helper, so every captured line is a JSON object and not free text.
    await pushOps([envelope({ clientSeq: 1, deviceId: DEVICE })], { token });
    await call(`/v1/repos/${REPO}/ops`, { token });
    await call(`/v1/repos/${REPO}/ops`, { token: "stpl_bad" });

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
