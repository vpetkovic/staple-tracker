/**
 * The UI server's budget capture and binding routes (the web Settings' "Usage & budget"):
 * `GET /api/budget/bindings`, `POST /api/budget/capture`, `POST /api/budget/bindings/bind`
 * and `POST /api/budget/bindings/unbind`.
 *
 * The claim is PARITY with `staple budget capture|bind|unbind|bindings`: the same store
 * method, the same validation, the same config.json. So every operation here is run twice,
 * once through the real CLI (a child process, on its own staple home) and once through the
 * real server (in this process, on another), and the two homes' `telemetry` and the two
 * answers are compared, success and refusal alike. The CLI runs asynchronously so the
 * server in this process keeps answering while it does.
 */
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SurfaceAutoSync } from "../src/core/cloud/auto-triggers.js";
import { readConfig } from "../src/config/file.js";
import { budgetConfig } from "../src/core/telemetry/budget-config.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { REPO_ROOT, removeDir, runCliAtAsync, tempDir } from "./fixtures/characterize-support.js";

let root: string;
let httpHome: string;
let cliHome: string;
let claudeDir: string;
let codexDir: string;
let ui: UiHandle;
let origin: string;
const saved: Record<string, string | undefined> = {};

async function call(path: string, init: { method?: string; body?: unknown; origin?: string; token?: string | null } = {}): Promise<{ status: number; body: Record<string, any> }> {
  const token = init.token === undefined ? ui.token : init.token;
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-staple-token": token }),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** `staple budget …--json` on the CLI's own home, without blocking this process's server. */
async function cli(args: string[]): Promise<{ status: number | null; json: Record<string, any> }> {
  const result = await runCliAtAsync(REPO_ROOT, ["budget", ...args, "--json"], { STAPLE_HOME: cliHome, HOME: root, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir });
  // A --json refusal is the error envelope, on stderr; a success is the view, on stdout.
  const text = result.status === 0 ? result.stdout : result.stderr;
  return { status: result.status, json: JSON.parse(text.slice(text.indexOf("{"))) as Record<string, any> };
}

const telemetryOf = (home: string) => readConfig(home).config.telemetry;

beforeAll(async () => {
  root = tempDir("budget-bindings-http");
  httpHome = join(root, "http-home");
  cliHome = join(root, "cli-home");
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  for (const dir of [httpHome, cliHome, claudeDir, codexDir]) mkdirSync(dir, { recursive: true });
  for (const key of ["STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[key] = process.env[key];
  process.env.STAPLE_HOME = httpHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  const ws = initWorkspace({ dir: join(root, "repo"), slug: "bindhttp" });
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

/** One step, run through both surfaces: the CLI argv and the equivalent HTTP request. */
interface Step {
  name: string;
  argv: string[];
  path: string;
  body: Record<string, unknown>;
}

const STEPS = (): Step[] => [
  { name: "capture on", argv: ["capture", "on"], path: "/api/budget/capture", body: { enabled: true } },
  {
    name: "bind the default Claude folder",
    argv: ["bind", "--source", "claude-statusline", "--account", "claude-max"],
    path: "/api/budget/bindings/bind",
    body: { source: "claude-statusline", account: "claude-max" },
  },
  {
    name: "bind a named Codex home",
    argv: ["bind", "--source", "codex-rollout", "--account", "codex-plus", "--codex-home", join(root, "codex-work")],
    path: "/api/budget/bindings/bind",
    body: { source: "codex-rollout", account: "codex-plus", codexHome: join(root, "codex-work") },
  },
  {
    name: "re-bind the same home to another account, with a provider",
    argv: ["bind", "--source", "claude-statusline", "--account", "claude-team", "--provider", "anthropic-eu"],
    path: "/api/budget/bindings/bind",
    body: { source: "claude-statusline", account: "claude-team", provider: "anthropic-eu" },
  },
  {
    name: "bind the default Codex home",
    argv: ["bind", "--source", "codex-rollout", "--account", "codex-pro"],
    path: "/api/budget/bindings/bind",
    body: { source: "codex-rollout", account: "codex-pro" },
  },
  {
    name: "unbind the named Codex home",
    argv: ["unbind", "--source", "codex-rollout", "--codex-home", join(root, "codex-work")],
    path: "/api/budget/bindings/unbind",
    body: { source: "codex-rollout", codexHome: join(root, "codex-work") },
  },
  { name: "capture off", argv: ["capture", "off"], path: "/api/budget/capture", body: { enabled: false } },
];

const REFUSALS = (): Step[] => [
  {
    name: "an account that is not a label",
    argv: ["bind", "--source", "claude-statusline", "--account", "Not A Label"],
    path: "/api/budget/bindings/bind",
    body: { source: "claude-statusline", account: "Not A Label" },
  },
  {
    name: "an unknown source",
    argv: ["bind", "--source", "claude", "--account", "claude-max"],
    path: "/api/budget/bindings/bind",
    body: { source: "claude", account: "claude-max" },
  },
  {
    name: "a provider that is not a slug",
    argv: ["bind", "--source", "codex-rollout", "--account", "codex-plus", "--provider", "OpenAI"],
    path: "/api/budget/bindings/bind",
    body: { source: "codex-rollout", account: "codex-plus", provider: "OpenAI" },
  },
  {
    name: "no account",
    argv: ["bind", "--source", "codex-rollout"],
    path: "/api/budget/bindings/bind",
    body: { source: "codex-rollout" },
  },
  {
    name: "a relative Codex home",
    argv: ["bind", "--source", "codex-rollout", "--account", "codex-plus", "--codex-home", "relative/codex"],
    path: "/api/budget/bindings/bind",
    body: { source: "codex-rollout", account: "codex-plus", codexHome: "relative/codex" },
  },
  {
    name: "an empty Claude folder",
    argv: ["bind", "--source", "claude-statusline", "--account", "claude-max", "--config-dir", ""],
    path: "/api/budget/bindings/bind",
    body: { source: "claude-statusline", account: "claude-max", configDir: "" },
  },
  {
    name: "unbinding a relative home",
    argv: ["unbind", "--source", "codex-rollout", "--codex-home", "codex"],
    path: "/api/budget/bindings/unbind",
    body: { source: "codex-rollout", codexHome: "codex" },
  },
  {
    name: "unbinding a home that has no binding",
    argv: ["unbind", "--source", "codex-rollout", "--codex-home", join(root, "nowhere")],
    path: "/api/budget/bindings/unbind",
    body: { source: "codex-rollout", codexHome: join(root, "nowhere") },
  },
];

describe("parity with staple budget capture|bind|unbind", () => {
  it("every write leaves the same config.json telemetry and answers the same view as the CLI", async () => {
    for (const step of STEPS()) {
      const viaCli = await cli(step.argv);
      const viaHttp = await call(step.path, { body: step.body });
      expect(viaCli.status, step.name).toBe(0);
      expect(viaHttp.status, `${step.name}: ${JSON.stringify(viaHttp.body)}`).toBe(200);
      expect(telemetryOf(httpHome), step.name).toEqual(telemetryOf(cliHome));
      if (step.argv[0] === "capture") expect(viaHttp.body.budgetCapture, step.name).toBe(viaCli.json.budgetCapture);
      else expect(viaHttp.body, step.name).toEqual(viaCli.json);
    }
    // The walk really wrote something, so the equality above is not two empty files.
    expect(budgetConfig(httpHome).bindings.map((binding) => binding.accountRef)).toEqual(["claude-team", "codex-pro"]);
    const listed = await call("/api/budget/bindings");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual((await cli(["bindings"])).json);
  });

  it("refuses what the CLI refuses, with the CLI's code and sentence, and writes nothing", async () => {
    const before = readFileSync(join(httpHome, "config.json"), "utf8");
    for (const step of REFUSALS()) {
      const viaCli = await cli(step.argv);
      const viaHttp = await call(step.path, { body: step.body });
      expect(viaCli.status, step.name).not.toBe(0);
      expect(viaHttp.status, step.name).toBe(viaCli.json.code === "not_found" ? 404 : 409);
      expect({ code: viaHttp.body.code, message: viaHttp.body.message, detail: viaHttp.body.detail }, step.name).toEqual({
        code: viaCli.json.code,
        message: viaCli.json.message,
        detail: viaCli.json.detail,
      });
      // Every refusal names its reason, so a surface other than the CLI can word it.
      expect(viaHttp.body.detail?.reason, step.name).toEqual(expect.any(String));
    }
    expect(readFileSync(join(httpHome, "config.json"), "utf8")).toBe(before);
  });

  it("an edit onto a home another binding holds is refused (conflict) by both, and removes nothing", async () => {
    const setup = [
      { argv: ["bind", "--source", "claude-statusline", "--account", "work-claude", "--config-dir", join(root, "A")], body: { source: "claude-statusline", account: "work-claude", configDir: join(root, "A") } },
      { argv: ["bind", "--source", "codex-rollout", "--account", "codex-plus", "--codex-home", join(root, "B")], body: { source: "codex-rollout", account: "codex-plus", codexHome: join(root, "B") } },
    ];
    for (const step of setup) {
      expect((await cli(step.argv)).status).toBe(0);
      expect((await call("/api/budget/bindings/bind", { body: step.body })).status).toBe(200);
    }
    const before = { http: readFileSync(join(httpHome, "config.json"), "utf8"), cli: readFileSync(join(cliHome, "config.json"), "utf8") };
    // Edit A (a Claude link) into a Codex link on B's home.
    const viaCli = await cli(["bind", "--source", "codex-rollout", "--account", "work-claude", "--codex-home", join(root, "B"), "--replace-source", "claude-statusline", "--replace-dir", join(root, "A")]);
    const viaHttp = await call("/api/budget/bindings/bind", {
      body: { source: "codex-rollout", account: "work-claude", codexHome: join(root, "B"), replacing: { source: "claude-statusline", configDir: join(root, "A") } },
    });
    expect(viaCli.status).not.toBe(0);
    expect(viaHttp.status).toBe(409);
    expect(viaHttp.body).toMatchObject({ code: "conflict", detail: { reason: "home_taken" } });
    expect({ code: viaHttp.body.code, message: viaHttp.body.message }).toEqual({ code: viaCli.json.code, message: viaCli.json.message });
    expect(readFileSync(join(httpHome, "config.json"), "utf8")).toBe(before.http);
    expect(readFileSync(join(cliHome, "config.json"), "utf8")).toBe(before.cli);
    // The same edit onto a free home works on both, in place.
    await cli(["bind", "--source", "codex-rollout", "--account", "work-claude", "--codex-home", join(root, "C"), "--replace-source", "claude-statusline", "--replace-dir", join(root, "A")]);
    await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "work-claude", codexHome: join(root, "C"), replacing: { source: "claude-statusline", configDir: join(root, "A") } } });
    expect(telemetryOf(httpHome)).toEqual(telemetryOf(cliHome));
    for (const home of [httpHome, cliHome]) {
      const bindings = budgetConfig(home).bindings;
      expect(bindings.some((binding) => binding.source === "codex_rollout" && binding.home === join(root, "B") && binding.accountRef === "codex-plus")).toBe(true);
      expect(bindings.some((binding) => binding.source === "codex_rollout" && binding.home === join(root, "C") && binding.accountRef === "work-claude")).toBe(true);
    }
  });

  it("a body that is not a JSON object is a 400 validation, never a 500", async () => {
    for (const path of ["/api/budget/capture", "/api/budget/bindings/bind", "/api/budget/bindings/unbind", "/api/budget/collection/plan"]) {
      for (const raw of ["null", "{not json", "[1]", "7"]) {
        const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "x-staple-token": ui.token, "content-type": "application/json" }, body: raw });
        const body = (await res.json()) as Record<string, any>;
        expect(res.status, `${path} ${raw}`).toBe(400);
        expect(body).toMatchObject({ code: "validation", detail: { reason: "invalid_body" } });
      }
    }
  });

  it("an empty replacing names replacing", async () => {
    const empty = await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "codex-plus", replacing: {} } });
    expect(empty.status).toBe(409);
    expect(empty.body.message).toMatch(/^replacing\.source must be claude-statusline or codex-rollout/);
  });

  it("refuses a body field of the wrong type", async () => {
    expect((await call("/api/budget/capture", { body: { enabled: "yes" } })).body.code).toBe("validation");
    expect((await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "codex-plus", codexHome: 7 } })).body.code).toBe("validation");
    expect((await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "codex-plus", replacing: "x" } })).body.code).toBe("validation");
  });
});

describe("editing a binding (replacing)", () => {
  it("swaps the old home for the new binding in one write, in the same place in the list", async () => {
    await call("/api/budget/bindings/bind", { body: { source: "claude-statusline", account: "first", configDir: join(root, "c1") } });
    await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "second", codexHome: join(root, "x1") } });
    await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "third", codexHome: join(root, "x2") } });
    const edited = await call("/api/budget/bindings/bind", {
      body: { source: "codex-rollout", account: "second-renamed", codexHome: join(root, "x1-moved"), replacing: { source: "codex-rollout", codexHome: join(root, "x1") } },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const accounts = budgetConfig(httpHome).bindings.map((binding) => binding.accountRef);
    expect(accounts.slice(-3)).toEqual(["first", "second-renamed", "third"]);
    expect(budgetConfig(httpHome).bindings.some((binding) => binding.source === "codex_rollout" && binding.home === join(root, "x1"))).toBe(false);
  });

  it("across sources: a Codex link edited into a Claude one", async () => {
    const edited = await call("/api/budget/bindings/bind", {
      body: { source: "claude-statusline", account: "third", configDir: join(root, "c3"), replacing: { source: "codex-rollout", codexHome: join(root, "x2") } },
    });
    expect(edited.status).toBe(200);
    const bindings = budgetConfig(httpHome).bindings;
    expect(bindings.at(-1)).toEqual({ source: "claude_code_statusline", configDir: join(root, "c3"), provider: "anthropic", accountRef: "third" });
    expect(bindings.some((binding) => binding.source === "codex_rollout" && binding.home === join(root, "x2"))).toBe(false);
  });

  it("refuses, writing nothing, when the binding being edited is gone", async () => {
    const before = readFileSync(join(httpHome, "config.json"), "utf8");
    const gone = await call("/api/budget/bindings/bind", {
      body: { source: "codex-rollout", account: "late", codexHome: join(root, "x9"), replacing: { source: "codex-rollout", codexHome: join(root, "x-deleted") } },
    });
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("not_found");
    expect(readFileSync(join(httpHome, "config.json"), "utf8")).toBe(before);
  });
});

describe("the route guards", () => {
  it("the writes are POST-only, the read GET-only, and a token is required", async () => {
    for (const path of ["/api/budget/capture", "/api/budget/bindings/bind", "/api/budget/bindings/unbind"]) {
      expect((await call(path, { method: "GET" })).status, path).toBe(405);
    }
    expect((await call("/api/budget/bindings", { body: {} })).status).toBe(405);
    expect((await call("/api/budget/bindings", { token: null })).status).toBe(401);
    expect((await call("/api/budget/capture", { body: { enabled: true }, token: "wrong" })).status).toBe(401);
  });

  it("a write from another origin (a phone on the tailnet) is refused as cross_origin and changes nothing", async () => {
    const before = readFileSync(join(httpHome, "config.json"), "utf8");
    for (const [path, body] of [
      ["/api/budget/capture", { enabled: true }],
      ["/api/budget/bindings/bind", { source: "codex-rollout", account: "phone" }],
      ["/api/budget/bindings/unbind", { source: "claude-statusline", configDir: join(root, "c1") }],
    ] as const) {
      const refused = await call(path, { body, origin: "http://100.90.235.4:4440" });
      expect(refused.status, path).toBe(403);
      expect(refused.body).toMatchObject({ code: "forbidden", detail: { reason: "cross_origin" } });
    }
    expect(readFileSync(join(httpHome, "config.json"), "utf8")).toBe(before);
    // The read works from there.
    expect((await call("/api/budget/bindings", { origin: "http://100.90.235.4:4440" })).status).toBe(200);
  });

  it("never arms the post-write sync trigger, which every ordinary write does", async () => {
    const spy = vi.spyOn(SurfaceAutoSync.prototype, "postWrite");
    try {
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      const svg = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="#f00"/></svg>';
      expect((await call("/api/glyph/sanitize", { body: { svg, label: "Dot" } })).status).toBe(200);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect((await call("/api/budget/capture", { body: { enabled: true } })).status).toBe(200);
      expect((await call("/api/budget/bindings/bind", { body: { source: "codex-rollout", account: "sync-check" } })).status).toBe(200);
      expect((await call("/api/budget/bindings/unbind", { body: { source: "codex-rollout" } })).status).toBe(200);
      await settle();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
