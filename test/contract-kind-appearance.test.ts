/**
 * R5a (STA-181) — kind appearance, read through all three doors at once.
 *
 * The per-surface suites pin each projection's shape. This one closes the loop
 * the other way: against ONE workspace, in one run, it reads the kind list
 * through the CLI (`kinds ls --json`), MCP (`list_kinds`) and HTTP
 * (`/api/settings`), and asserts the rows — appearance included — are
 * byte-for-byte the same object on every surface, before and after a glyph is
 * stored through the HTTP settings route.
 *
 * That is the failure a single-surface test cannot see: three call sites each
 * choose which store method to serve, so one that kept calling `getKinds()`
 * would still pass its own suite and silently serve rows with no appearance.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import type { KindWithAppearance } from "../src/core/kind-appearance.js";
import { CONTRACT_AGENT, runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "contract";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

function cliKinds(): KindWithAppearance[] {
  const result = cli("kinds", "ls", "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as KindWithAppearance[];
}

async function mcpKinds(): Promise<KindWithAppearance[]> {
  const result = await mcp.call("list_kinds", { ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return (toolPayload(result) as { kinds: KindWithAppearance[] }).kinds;
}

async function httpSettings(init?: RequestInit): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${origin}/api/settings`, {
    ...init,
    headers: { "content-type": "application/json", "x-staple-token": token, origin, ...(init?.headers as Record<string, string> | undefined) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function httpKinds(): Promise<KindWithAppearance[]> {
  const { status, body } = await httpSettings();
  expect(status).toBe(200);
  return body.kinds as KindWithAppearance[];
}

const setAppearance = (value: unknown) =>
  httpSettings({
    method: "POST",
    body: JSON.stringify({ actor: "ui", target: "settings", ops: [{ op: "set", key: "kinds.appearance", value }] }),
  });

/** The three reads, which must agree with each other exactly. */
async function everySurface(): Promise<KindWithAppearance[]> {
  const fromCli = cliKinds();
  const fromMcp = await mcpKinds();
  const fromHttp = await httpKinds();
  expect(fromMcp).toEqual(fromCli);
  expect(fromHttp).toEqual(fromCli);
  return fromCli;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-kind-appearance-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-kind-appearance-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  // One kind with a built-in mark that is not seeded, one with none at all.
  expect(cli("kinds", "add", "milestone", "--ws", WS).status).toBe(0);
  expect(cli("kinds", "add", "research", "--ws", WS).status).toBe(0);

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

describe("the same typed appearance on CLI, MCP and HTTP", () => {
  it("serves every kind with its resolved record before anything is stored", async () => {
    const kinds = await everySurface();
    expect(kinds.map((k) => k.id)).toEqual(["epic", "task", "bug", "chore", "spike", "milestone", "research"]);
    const byId = Object.fromEntries(kinds.map((k) => [k.id, k.appearance]));
    expect(byId.epic).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    expect(byId.milestone).toEqual({ source: "lucide", value: "milestone", label: "Milestone", fallback: "⚑" });
    expect(byId.research).toEqual({ source: "none", value: "", label: "Research", fallback: "•" });
    for (const kind of kinds) {
      expect(Object.keys(kind.appearance).sort()).toEqual(["fallback", "label", "source", "value"]);
      expect(kind.appearance.fallback.length).toBeGreaterThan(0);
    }
  });

  it("a glyph stored through HTTP is read back identically on every surface", async () => {
    const { status, body } = await setAppearance({
      research: { source: "lucide", value: "flask-conical", fallback: "⚗" },
      epic: { source: "emoji", value: "🚀", fallback: "E", label: "Initiative" },
    });
    expect(status, JSON.stringify(body)).toBe(200);
    // The write answers the same envelope the read does.
    expect(body.values["kinds.appearance"].source).toBe("workspace");

    const kinds = await everySurface();
    const byId = Object.fromEntries(kinds.map((k) => [k.id, k.appearance]));
    expect(byId.research).toEqual({ source: "lucide", value: "flask-conical", label: "Research", fallback: "⚗" });
    expect(byId.epic).toEqual({ source: "emoji", value: "🚀", label: "Initiative", fallback: "E" });
    // Untouched kinds keep their built-in marks.
    expect(byId.bug).toEqual({ source: "lucide", value: "bug", label: "Bug", fallback: "✱" });
  });

  it("the CLI's human list prints the terminal fallback for every kind", () => {
    const result = cli("kinds", "ls", "--ws", WS);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.find((line) => line.includes(" research "))).toMatch(/^⚗ research/);
    expect(lines.find((line) => line.includes(" epic "))).toMatch(/^E epic/);
    expect(lines.find((line) => line.includes(" bug "))).toMatch(/^✱ bug/);
  });

  it("refuses a colour, an unconfigured kind and custom SVG at the write boundary, leaving the value alone", async () => {
    const before = await httpKinds();
    for (const [value, sentence] of [
      [{ epic: { source: "lucide", value: "layers", fallback: "◆", color: "#f00" } }, /without "color"/],
      [{ nope: { source: "lucide", value: "layers", fallback: "◆" } }, /Unknown kind "nope"/],
      [{ epic: { source: "svg", value: "<svg/>", fallback: "s" } }, /sanitiser/],
    ] as const) {
      const { status, body } = await setAppearance(value);
      expect(status).not.toBe(200);
      expect(body.error ?? JSON.stringify(body)).toMatch(sentence);
    }
    expect(await everySurface()).toEqual(before);
  });

  it("removing a kind drops its entry, and the rest survive on every surface", async () => {
    expect(cli("kinds", "rm", "research", "--ws", WS).status).toBe(0);
    const { body } = await httpSettings();
    expect(Object.keys(body.values["kinds.appearance"].value)).toEqual(["epic"]);
    const kinds = await everySurface();
    expect(kinds.map((k) => k.id)).not.toContain("research");
    expect(kinds.find((k) => k.id === "epic")!.appearance.label).toBe("Initiative");
  });
});
