/**
 * The UI server's `/api/budget/collection` routes: the same service methods as `staple
 * budget setup|unsetup|status|collect`, behind the server's token and Origin checks, with
 * `consent: true` in the body standing in for `--yes`.
 *
 * The watcher is always sent `watcher: false`: this server process reaches the real
 * `launchctl`, and nothing here may load an agent into the operator's session. The
 * watcher itself is covered through an injected launchctl in `budget-collection.test.ts`.
 */
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { budgetConfig } from "../src/core/telemetry/budget-config.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

let root: string;
let home: string;
let claudeDir: string;
let ui: UiHandle;
let origin: string;
const saved: Record<string, string | undefined> = {};

const SETTINGS = (): string => join(claudeDir, "settings.json");
const ORIGINAL = `{\n  "statusLine": { "type": "command", "command": "~/bin/line" },\n  "theme": "dark"\n}\n`;

async function call(path: string, init: { method?: string; body?: unknown; origin?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "x-staple-token": ui.token, "content-type": "application/json", ...(init.origin ? { origin: init.origin } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  root = tempDir("budget-collection-http");
  home = join(root, "staple-home");
  claudeDir = join(root, "claude");
  mkdirSync(home, { recursive: true });
  for (const key of ["STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[key] = process.env[key];
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = join(root, "codex");
  const ws = initWorkspace({ dir: join(root, "repo"), slug: "budgethttp" });
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: join(root, "repo", ".staple", "staple.db") });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(root);
});

beforeEach(() => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(SETTINGS(), ORIGINAL);
});

const SETUP = { claudeAccount: "claude-max", codexAccount: "codex-plus", watcher: false };

describe("/api/budget/collection", () => {
  it("GET is the status", async () => {
    const { status, body } = await call("/api/budget/collection");
    expect(status).toBe(200);
    expect(body.budgetCapture).toBe(false);
    expect(body.problems.map((problem: { code: string }) => problem.code)).toEqual(["capture_off", "no_binding"]);
  });

  it("plan previews and changes nothing", async () => {
    const { status, body } = await call("/api/budget/collection/plan", { body: { action: "setup", ...SETUP } });
    expect(status).toBe(200);
    expect(body.plan.changes).toBe(4);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(budgetConfig(home).budgetCapture).toBe(false);
  });

  it("setup without consent answers 400 with the plan and changes nothing", async () => {
    const { status, body } = await call("/api/budget/collection/setup", { body: SETUP });
    expect(status).toBe(400);
    expect(body.code).toBe("validation");
    expect(body.detail.reason).toBe("consent_required");
    expect(body.detail.plan.action).toBe("setup");
    // `consent: "yes"` is not `true`.
    expect((await call("/api/budget/collection/setup", { body: { ...SETUP, consent: "yes" } })).status).toBe(400);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: false, bindings: [] });
  });

  it("setup with consent applies, collect runs, unsetup restores the file byte for byte", async () => {
    const setup = await call("/api/budget/collection/setup", { body: { ...SETUP, consent: true } });
    expect(setup.status).toBe(200);
    expect(setup.body.applied.map((step: { part: string }) => step.part)).toEqual(["capture", "claude_binding", "statusline", "codex_binding"]);
    expect(readFileSync(SETTINGS(), "utf8")).toContain("staple-statusline-wrapper/v1");

    const collect = await call("/api/budget/collection/collect", { body: {} });
    expect(collect.status).toBe(200);
    expect(collect.body).toMatchObject({ ok: true, skippedReason: null });

    const unsetup = await call("/api/budget/collection/unsetup", { body: { consent: true } });
    expect(unsetup.status).toBe(200);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
    expect(budgetConfig(home)).toMatchObject({ budgetCapture: false, bindings: [] });
    expect(existsSync(join(home, "telemetry", "collection.json"))).toBe(false);
  });

  it("refuses a body field of the wrong type", async () => {
    const { status, body } = await call("/api/budget/collection/plan", { body: { action: "setup", claudeAccount: 7 } });
    expect(status).toBe(409);
    expect(body.code).toBe("validation");
  });

  it("the writes are POST-only and Origin-checked; the read is GET-only", async () => {
    expect((await call("/api/budget/collection/setup", { method: "GET" })).status).toBe(405);
    expect((await call("/api/budget/collection", { body: {} })).status).toBe(405);
    const cross = await call("/api/budget/collection/setup", { body: { ...SETUP, consent: true }, origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect(readFileSync(SETTINGS(), "utf8")).toBe(ORIGINAL);
  });

  it("needs the token", async () => {
    const res = await fetch(`${origin}/api/budget/collection`);
    expect(res.status).toBe(401);
  });
});
