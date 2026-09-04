/**
 * R6d (STA-179) — one registered setting, the same on every surface.
 *
 * The queue policy is defined once, in the registry, and reaches an agent
 * through four doors: `staple settings get` (CLI), `get_setting` (MCP),
 * `/api/settings` `values` (HTTP) and `settingValue()` over that envelope (the
 * UI's accessor). Each door reaches the store by its own path and formats its
 * own answer, which is exactly how the doors drift apart. This suite drives ONE
 * workspace through all four in one run and asserts that the `{value, source}`
 * pair — and the whole `SettingValueView` around it — is identical across them
 * before a write, after a write on each surface in turn, and that every write
 * lands in the event log with the actor that surface attributes it to.
 *
 * Follows test/contract-cross-surface.test.ts: same fixtures, same "asserted
 * identical, not merely each-valid" posture. Enforcement of the policy is not
 * here — R2c (STA-168) owns the resolver; this pins the value it will read.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  cliEnvelope,
  mcpEnvelope,
  runCli,
  startMcpClient,
  toolPayload,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES } from "./fixtures/error-contract.js";

const WS = "settingsx";
const KEY = "queue.policy";

/**
 * The UI's own accessor, loaded through a variable specifier ON PURPOSE. It lives in the
 * browser bundle (`src/ui/app`), which is a separate compilation with React and DOM libs,
 * so a static import would drag that module into the Node-side `tsc` program. Vitest
 * resolves it at runtime, which is all this suite needs: the real function, not a copy.
 */
const UI_SETTINGS_MODULE = "../src/ui/app/src/lib/settings.js";
type UiSettingsModule = {
  settingValueIn: (envelope: WorkspaceSettingsEnvelope, key: string) => SettingView | undefined;
};
let settingValueIn: UiSettingsModule["settingValueIn"];

interface SettingView {
  key: string;
  scope: string;
  value?: unknown;
  source: string;
  version: number;
}

/** Only the part of the served envelope this suite reads — the UI's accessor reads the same. */
interface WorkspaceSettingsEnvelope {
  values: Record<string, SettingView>;
  global: { values: Record<string, SettingView> };
  registry: { definitions: Array<{ key: string; scope: string; default: unknown; version: number }> };
}

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function httpEnvelope(init?: RequestInit): Promise<{ status: number; body: WorkspaceSettingsEnvelope }> {
  const response = await fetch(`${origin}/api/settings`, {
    ...init,
    headers: {
      "x-staple-token": token,
      "content-type": "application/json",
      origin,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return { status: response.status, body: (await response.json()) as WorkspaceSettingsEnvelope };
}

/** The setting as each surface answers it, read fresh — no caching between doors. */
async function readEverywhere(): Promise<Record<"cli" | "mcp" | "http" | "ui", SettingView>> {
  const fromCli = cli("settings", "get", KEY, "--ws", WS, "--json");
  expect(fromCli.status, fromCli.stderr).toBe(0);
  const fromMcp = toolPayload(await mcp.call("get_setting", { key: KEY, ws: WS })) as SettingView;
  const served = await httpEnvelope();
  expect(served.status).toBe(200);
  return {
    cli: JSON.parse(fromCli.stdout) as SettingView,
    mcp: fromMcp,
    http: served.body.values[KEY] as SettingView,
    // The UI never restates a definition: its accessor runs over the served envelope.
    ui: settingValueIn(served.body, KEY) as SettingView,
  };
}

function expectAllEqual(views: Record<string, SettingView>, expected: SettingView): void {
  for (const [surface, view] of Object.entries(views)) {
    expect(view, surface).toEqual(expected);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-settings-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-contract-settings-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);

  ({ settingValueIn } = (await import(UI_SETTINGS_MODULE)) as UiSettingsModule);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: false, ws: WS });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

const DEFAULT: SettingView = { key: KEY, scope: "workspace", value: "advisory", source: "default", version: 1 };
const STRICT: SettingView = { ...DEFAULT, value: "strict", source: "workspace" };
const ADVISORY_STORED: SettingView = { ...DEFAULT, value: "advisory", source: "workspace" };

describe("the queue policy is the same object on every surface", () => {
  it("before any write: advisory, from the default, on CLI, MCP, HTTP and the UI accessor", async () => {
    expectAllEqual(await readEverywhere(), DEFAULT);
  });

  it("a CLI write is answered with the new view and every surface reads it back", async () => {
    const written = cli("settings", "set", KEY, "strict", "--ws", WS, "--json");
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(written.stdout)).toEqual(STRICT);
    expectAllEqual(await readEverywhere(), STRICT);
  });

  it("an MCP write is answered with the new view and every surface reads it back", async () => {
    const written = toolPayload(await mcp.call("set_setting", { key: KEY, value: "advisory", ws: WS }));
    expect(written).toEqual(ADVISORY_STORED);
    expectAllEqual(await readEverywhere(), ADVISORY_STORED);
  });

  it("an HTTP write answers the same envelope a GET would, and every surface reads it back", async () => {
    const written = await httpEnvelope({
      method: "POST",
      body: JSON.stringify({ target: "settings", ops: [{ op: "set", key: KEY, value: "strict" }] }),
    });
    expect(written.status).toBe(200);
    expect(written.body.values[KEY]).toEqual(STRICT);
    expectAllEqual(await readEverywhere(), STRICT);
  });

  it("the human CLI line carries the same value and source as the JSON", () => {
    const shown = cli("settings", "get", KEY, "--ws", WS);
    expect(shown.status).toBe(0);
    expect(shown.stdout.trim()).toBe("queue.policy = strict  (workspace)");
    const listed = cli("settings", "--ws", WS);
    expect(listed.stdout.trim().split("\n")).toEqual(["kinds.default = task  (default)", "queue.policy = strict  (workspace)"]);
  });
});

describe("every write is recorded with actor, previous value and new value", () => {
  it("in surface order: the CLI's agent, the MCP server's agent, the UI's default actor", () => {
    const events = cli("events", "--ws", WS, "--json");
    expect(events.status).toBe(0);
    const changes = events.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; actor: string; payload: Record<string, unknown> })
      .filter((event) => event.kind === "setting_changed")
      .map((event) => [event.actor, event.payload]);
    expect(changes).toEqual([
      [CONTRACT_AGENT, { action: "set", key: KEY, from: "advisory", to: "strict" }],
      [CONTRACT_AGENT, { action: "set", key: KEY, from: "strict", to: "advisory" }],
      ["ui", { action: "set", key: KEY, from: "advisory", to: "strict" }],
    ]);
  });
});

describe("a value outside the contract is refused the same way everywhere", () => {
  const MESSAGE = `workspace ${WS}: "queue.policy" must be one of advisory, strict, got "lenient"`;

  it("CLI: exit 2 with the validation envelope", () => {
    const refused = cli("settings", "set", KEY, "lenient", "--ws", WS, "--json");
    expect(refused.status).toBe(CLI_EXIT_CODES.validation);
    expect(cliEnvelope(refused)).toMatchObject({ code: "validation", message: MESSAGE, retryable: false });
  });

  it("MCP: the same envelope", async () => {
    const refused = await mcp.call("set_setting", { key: KEY, value: "lenient", ws: WS });
    expect(refused.isError).toBe(true);
    expect(mcpEnvelope(refused)).toMatchObject({ code: "validation", message: MESSAGE, retryable: false });
  });

  it("HTTP: the same envelope, and the stored value is untouched", async () => {
    const refused = await httpEnvelope({
      method: "POST",
      body: JSON.stringify({ target: "settings", ops: [{ op: "set", key: KEY, value: "lenient" }] }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "validation", message: MESSAGE, retryable: false });
    expectAllEqual(await readEverywhere(), STRICT);
  });
});
