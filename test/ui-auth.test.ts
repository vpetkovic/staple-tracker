import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

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
  it("rejects a cross-site Origin even with a valid token, and the write does not land", async () => {
    const before = await commentCount();
    const res = await action(
      { ref, type: "comment", body: "from evil.example", actor: "attacker" },
      { "x-staple-token": token, origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
    expect(body.retryable).toBe(false);
    expect(await commentCount()).toBe(before);
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
