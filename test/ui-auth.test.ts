import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let home: string;
let dbPath: string;
let ref: string;
let ui: UiHandle;
let origin: string;
let token: string;

/** POST /api/action with explicit control over the token and Origin headers. */
function action(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

/** Comment count straight from the store, so "did the write land" never asks the API. */
async function commentCount(): Promise<number> {
  const res = await fetch(`${origin}/api/issue?ref=${encodeURIComponent(ref)}`, {
    headers: { "x-staple-token": token },
  });
  const body = (await res.json()) as { comments: unknown[] };
  return body.comments.length;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uiauth-"));
  // Mirrors test/cli-json.test.ts: a throwaway STAPLE_HOME, and NODE_NO_WARNINGS to
  // silence node:sqlite's ExperimentalWarning, which is runtime noise, not output.
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uiauth" });
  dbPath = ws.dbPath;
  ref = ws.store.createIssue({ title: "Guarded task" }).identifier;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui.close();
  rmSync(home, { recursive: true, force: true });
});

describe("token gate on /api/*", () => {
  it("serves the page itself without a token, since the page bootstraps from its own URL", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("rejects /api/issues without a token, in the standard error envelope", async () => {
    const res = await fetch(`${origin}/api/issues`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unauthorized");
    expect(body.retryable).toBe(false);
    expect(typeof body.message).toBe("string");
    // The page's api() surfaces body.error, so the envelope keeps that field too.
    expect(typeof body.error).toBe("string");
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": "not-the-token" } });
    expect(res.status).toBe(401);
  });

  it("accepts the X-Staple-Token header", async () => {
    const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": token } });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("accepts ?token= for curl convenience", async () => {
    const res = await fetch(`${origin}/api/issues?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  it("accepts Authorization: Bearer", async () => {
    const res = await fetch(`${origin}/api/issues`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("gates every read endpoint, not just /api/issues", async () => {
    for (const path of ["/api/bootstrap", "/api/poll", "/api/inbox", "/api/graph", "/api/events"]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(401);
      expect((await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } })).status, path).toBe(200);
    }
  });

  it("gates unknown /api paths too, answering 401 before 404", async () => {
    expect((await fetch(`${origin}/api/nope`)).status).toBe(401);
    expect((await fetch(`${origin}/api/nope`, { headers: { "x-staple-token": token } })).status).toBe(404);
  });
});

describe("Origin check on /api/action", () => {
  /**
   * THE WRITE RULE (server.ts `writeAllowed`): the server's own loopback Origin, no Origin,
   * or the token in the X-Staple-Token HEADER. A cross-site page cannot set that header
   * without a CORS preflight, which is never granted (below), so the realistic attacker is a
   * foreign Origin WITHOUT the header, and the token in a form's query string or a Bearer
   * does not stand in for it: a query string rides a plain cross-site form POST.
   */
  it("rejects a cross-site Origin without the header, even with a valid token in the query or a Bearer, and the write does not land", async () => {
    const before = await commentCount();
    for (const res of [
      await fetch(`${origin}/api/action?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ ref, type: "comment", body: "from evil.example", actor: "attacker" }),
      }),
      await action({ ref, type: "comment", body: "from evil.example", actor: "attacker" }, { authorization: `Bearer ${token}`, origin: "http://evil.example" }),
    ]) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("forbidden");
      expect(body.detail).toEqual({ reason: "cross_origin" });
      expect(body.retryable).toBe(false);
    }
    expect(await commentCount()).toBe(before);
  });

  it("accepts a foreign Origin that carries the token in X-Staple-Token: the app's page through a forwarder (a phone on the tailnet)", async () => {
    const before = await commentCount();
    const res = await action(
      { ref, type: "comment", body: "from the phone", actor: "vp" },
      { "x-staple-token": token, origin: "http://100.90.235.4:4440" },
    );
    expect(res.status).toBe(200);
    expect(await commentCount()).toBe(before + 1);
  });

  it("refuses a foreign Origin whose header is wrong, even when the query token opens the read gate", async () => {
    const before = await commentCount();
    for (const wrong of [token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), token.slice(1), `${token}x`, "", "short"]) {
      const res = await fetch(`${origin}/api/action?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example", "x-staple-token": wrong },
        body: JSON.stringify({ ref, type: "comment", body: "wrong header" }),
      });
      // A wrong header is presented first and fails the read gate (401); an empty one falls
      // through to the query token and then fails the write rule (403). Neither writes.
      expect([401, 403], JSON.stringify(wrong)).toContain(res.status);
    }
    expect(await commentCount()).toBe(before);
  });

  it("compares the header in constant time, through the one compare the read gate uses", () => {
    const source = readFileSync(join(REPO_ROOT, "src/ui/server.ts"), "utf8");
    const rule = /function writeAllowed[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
    expect(rule).toContain("tokenMatches(header)");
    expect(rule).not.toMatch(/===\s*token|token\s*===/);
    const compare = /function tokenMatches[\s\S]*?\n  \}/.exec(source)?.[0] ?? "";
    expect(compare).toContain("timingSafeEqual(bytes, tokenBytes)");
    expect(compare).toContain("bytes.length === tokenBytes.length");
  });

  it("grants no CORS preflight: an OPTIONS is refused, with no Access-Control-Allow-* header", async () => {
    const preflight = {
      origin: "http://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-staple-token, content-type",
    };
    for (const url of [`${origin}/api/action`, `${origin}/api/action?token=${encodeURIComponent(token)}`, `${origin}/api/run/stop`, `${origin}/`]) {
      const res = await fetch(url, { method: "OPTIONS", headers: preflight });
      expect(res.status, url).toBeGreaterThanOrEqual(400);
      for (const name of res.headers.keys()) expect(name, url).not.toMatch(/^access-control-/);
    }
    // And nowhere else either: the server never writes a CORS header.
    expect(readFileSync(join(REPO_ROOT, "src/ui/server.ts"), "utf8")).not.toMatch(/["'`]access-control-/i);
  });

  it("accepts the server's own Origin, and the write lands", async () => {
    const before = await commentCount();
    const res = await action(
      { ref, type: "comment", body: "from the served page", actor: "ui" },
      { "x-staple-token": token, origin },
    );
    expect(res.status).toBe(200);
    expect(await commentCount()).toBe(before + 1);
  });

  it("allows an absent Origin, which is how curl and the CLI call it", async () => {
    const before = await commentCount();
    const res = await action({ ref, type: "comment", body: "from curl" }, { "x-staple-token": token });
    expect(res.status).toBe(200);
    expect(await commentCount()).toBe(before + 1);
  });

  it("still requires the token before it ever looks at Origin", async () => {
    const res = await action({ ref, type: "comment", body: "no token" }, { origin });
    expect(res.status).toBe(401);
  });
});

describe("method enforcement", () => {
  it("answers 405 for GET on the write endpoint", async () => {
    const res = await fetch(`${origin}/api/action`, { headers: { "x-staple-token": token } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(((await res.json()) as Record<string, unknown>).code).toBe("method_not_allowed");
  });

  it("answers 405 for POST on a read endpoint", async () => {
    const res = await fetch(`${origin}/api/issues`, {
      method: "POST",
      headers: { "x-staple-token": token, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("answers 405 for DELETE on a read endpoint", async () => {
    const res = await fetch(`${origin}/api/poll`, { method: "DELETE", headers: { "x-staple-token": token } });
    expect(res.status).toBe(405);
  });
});

describe("the token itself", () => {
  it("is long and URL-safe, so it survives being pasted into a query string", () => {
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
