/**
 * `staple budget` and the MCP tool `record_budget_sample`, driven as a user and an agent
 * drive them: real child processes against a scratch staple home.
 *
 *   - `--tee` passes the status-line input through byte for byte, first, whatever
 *     ingestion then decides, so staple can sit in front of an existing status line.
 *   - The refusals keep the existing envelope and exit codes (validation = 2).
 *   - CLI `--json` and MCP answer the same shape, because both call `ingestBudget`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { mcpEnvelope, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { statusline } from "./fixtures/budget-support.js";

let home: string;
let claudeDir: string;

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return bareEnv({ STAPLE_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: join(home, "codex"), ...extra });
}

/** Run the CLI with raw bytes on stdin, and keep stdout as bytes. */
function budget(args: string[], stdin?: Buffer): { status: number; stdout: Buffer; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", ...args], {
    cwd: REPO_ROOT,
    env: childEnv(),
    input: stdin ?? Buffer.alloc(0),
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr.toString("utf8") };
}

beforeEach(() => {
  home = tempDir("budget-cli");
  claudeDir = join(home, "claude");
  mkdirSync(claudeDir);
});

afterEach(() => removeDir(home));

describe("staple budget ingest --tee", () => {
  // Not ASCII-only, CRLF and no trailing newline: every way a decode/re-encode or a
  // console.log would change the bytes.
  const bytes = Buffer.from(`${statusline({ session_name: "naïve ✓ — 状態" }).replace("{", "{\r\n")}`, "utf8");

  it("writes the input back to stdout byte for byte and nothing else, and stores the reading", () => {
    expect(budget(["capture", "on"]).status).toBe(0);
    expect(budget(["bind", "--source", "claude-statusline", "--account", "personal-max"]).status).toBe(0);
    const result = budget(["ingest", "--source", "claude-statusline", "--tee", "--json"], bytes);
    expect(result.status).toBe(0);
    expect(result.stdout.equals(bytes)).toBe(true);
    expect(result.stderr).toBe("");
    // Stored: the next identical render is unchanged.
    const again = budget(["ingest", "--source", "claude-statusline", "--json"], bytes);
    expect(JSON.parse(again.stdout.toString("utf8"))).toMatchObject({ storedCount: 0, skipped: { unchanged: 2 } });
  }, 60_000);

  it("passes the input through even when the flags themselves are wrong", () => {
    const result = budget(["ingest", "--source", "claude-statusline", "--tee", "--bogus"], bytes);
    expect(result.stdout.equals(bytes)).toBe(true);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--bogus");
  }, 30_000);

  it("echoes for every spelling of --tee, including a malformed --tee=", () => {
    for (const spelling of ["--tee=true", "--tee="]) {
      const result = budget(["ingest", "--source", "claude-statusline", spelling], bytes);
      expect(result.stdout.equals(bytes), spelling).toBe(true);
      expect(result.status, spelling).toBe(2);
    }
  }, 60_000);

  it("refuses --tee with a source that takes no stdin without waiting for stdin to close", async () => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", "ingest", "--source", "codex-rollout", "x.jsonl", "--tee"], {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stdin is left open: a pre-read would block here until the timeout.
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    expect(status).toBe(2);
    expect(stderr).toContain("--tee passes a status line through");
  }, 30_000);

  it("still passes the input through when ingestion is refused, and reports the refusal on stderr with exit 2", () => {
    // Capture never enabled: refused, but the status line must keep working.
    const result = budget(["ingest", "--source", "claude-statusline", "--tee", "--json"], bytes);
    expect(result.stdout.equals(bytes)).toBe(true);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    expect(envelope).toMatchObject({ code: "validation", detail: { reason: "capture_disabled" }, retryable: false });
  }, 30_000);
});

describe("staple budget refusals and configuration", () => {
  it("refuses a status line with no binding and no --account: validation, exit 2, naming the binding", () => {
    budget(["capture", "on"]);
    const result = budget(["ingest", "--source", "claude-statusline", "--json"], Buffer.from(statusline()));
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ code: "validation", detail: { reason: "no_binding_configured", source: "claude_code_statusline" } });
    expect(result.stdout.length).toBe(0);
  }, 30_000);

  it("keeps capture off until asked, and round-trips bindings through config.json", () => {
    expect(JSON.parse(budget(["capture", "--json"]).stdout.toString())).toEqual({ budgetCapture: false });
    budget(["bind", "--source", "codex-rollout", "--account", "codex-plus", "--codex-home", join(home, "codex")]);
    const listed = JSON.parse(budget(["bindings", "--json"]).stdout.toString());
    expect(listed).toEqual({
      budgetCapture: false,
      bindings: [{ source: "codex_rollout", home: join(home, "codex"), provider: "openai", accountRef: "codex-plus" }],
      unknownBindings: 0,
      invalidBindings: [],
    });
    expect(budget(["bind", "--source", "codex-rollout", "--account", "Not A Label"]).status).toBe(2);
    expect(JSON.parse(budget(["unbind", "--source", "codex-rollout", "--codex-home", join(home, "codex"), "--json"]).stdout.toString()).bindings).toEqual([]);
  }, 60_000);
});

describe("a hand-broken binding", () => {
  function run(command: string, args: string[]) {
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, command, ...args], { cwd: REPO_ROOT, env: childEnv(), timeout: 30_000 });
    return { status: result.status ?? -1, stdout: result.stdout.toString("utf8") };
  }

  it("is kept and ignored, so config, config set and doctor still work, and re-binding the home replaces it", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        telemetry: { budgetCapture: true, bindings: [{ source: "claude_code_statusline", configDir: claudeDir, provider: "anthropic", accountRef: "Personal-Max" }] },
      }),
    );
    expect(run("config", []).status).toBe(0);
    expect(run("config", ["set", "port", "4501"]).status).toBe(0);
    const doctor = JSON.parse(run("doctor", ["--json"]).stdout) as { checks: Array<{ id: string; status: string; detail: string }> };
    const config = doctor.checks.find((c) => c.id === "config")!;
    expect(config.status).toBe("warn");
    expect(config.detail).toContain("Personal-Max");
    // Not matched: the reading is refused, never stored under the bad label.
    const refused = budget(["ingest", "--source", "claude-statusline", "--json"], Buffer.from(statusline()));
    const envelope = JSON.parse(refused.stderr.trim()) as { message: string };
    // The refusal points at the broken entry, the way doctor does.
    expect(envelope).toMatchObject({ detail: { reason: "no_binding_configured", invalidBinding: { index: 0 } } });
    expect(envelope.message).toContain("telemetry.bindings[0]");
    expect(envelope.message).toContain("Personal-Max");
    expect(JSON.parse(budget(["bindings", "--json"]).stdout.toString()).invalidBindings).toHaveLength(1);
    // The CLI repairs it.
    const rebound = JSON.parse(budget(["bind", "--source", "claude-statusline", "--account", "personal-max", "--json"]).stdout.toString());
    expect(rebound).toMatchObject({ invalidBindings: [], bindings: [{ accountRef: "personal-max", configDir: claudeDir }] });
  }, 90_000);
});

describe("one shape on every surface", () => {
  let mcp: McpHarness;
  let mcpHome: string;

  beforeAll(async () => {
    mcpHome = tempDir("budget-mcp");
    mcp = await startMcpClient({ home: mcpHome, cwd: mcpHome, env: { HOME: mcpHome } });
  }, 40_000);

  afterAll(async () => {
    await mcp?.close();
    removeDir(mcpHome);
  });

  /** What differs by construction between two runs: ids, clocks, and the digest over a clock. */
  const stable = (payload: Record<string, unknown>) =>
    JSON.parse(
      JSON.stringify(payload, (key, value) =>
        ["id", "windowId", "dedupKey", "observedAt", "recordedAt", "resetsAt"].includes(key) && typeof value === "string" ? "<v>" : value,
      ),
    );

  it("refuses over MCP with the same envelope the CLI prints", async () => {
    const result = await mcp.call("record_budget_sample", { source: "claude-statusline", input: statusline() });
    expect(result.isError).toBe(true);
    expect(mcpEnvelope(result)).toMatchObject({ code: "validation", detail: { reason: "capture_disabled" } });
  }, 30_000);

  it("refuses an agent's manual reading over MCP until the operator opts in", async () => {
    const result = await mcp.call("record_budget_sample", { source: "manual", account: "personal-max", provider: "anthropic", limit_key: "five_hour", used: 10 });
    expect(result.isError).toBe(true);
    expect(mcpEnvelope(result)).toMatchObject({ code: "validation", detail: { reason: "capture_disabled", source: "operator_manual" } });
  }, 30_000);

  it("answers a manual reading with the same payload from the CLI and from MCP", async () => {
    // The MCP side needs the operator's opt-in; the CLI side is the operator typing it.
    const optIn = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", "capture", "on"], { cwd: REPO_ROOT, env: bareEnv({ STAPLE_HOME: mcpHome, HOME: mcpHome }) });
    expect(optIn.status).toBe(0);
    const cli = budget(["ingest", "--source", "manual", "--account", "personal-max", "--provider", "anthropic", "--limit-key", "five_hour", "--used", "37.5", "--resets-at", "2h", "--json"]);
    expect(cli.status).toBe(0);
    const result = await mcp.call("record_budget_sample", {
      source: "manual",
      account: "personal-max",
      provider: "anthropic",
      limit_key: "five_hour",
      used: 37.5,
      resets_at: "2h",
    });
    expect(result.isError).toBeFalsy();
    const fromCli = JSON.parse(cli.stdout.toString("utf8")) as Record<string, unknown>;
    const fromMcp = toolPayload(result) as Record<string, unknown>;
    expect(stable(fromMcp)).toEqual(stable(fromCli));
    expect(fromCli).toMatchObject({
      source: "operator_manual",
      storedCount: 1,
      outcomes: [{ stored: true, sample: { usedPercent: 37.5, remainingPercent: 62.5, resetsAtSource: "derived_from_relative", confidence: "low" } }],
    });
  }, 60_000);
});
