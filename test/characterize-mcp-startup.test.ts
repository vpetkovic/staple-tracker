/**
 * A1 — MCP SERVER STARTUP and workspace-less behaviour, frozen before A2 and B1.
 *
 * `contract-mcp.test.ts` already pins the 20-tool inventory, every annotation,
 * and every tool payload — that ground is covered and is deliberately not
 * repeated here. What it never touches is the process boundary AROUND those
 * tools: the readiness banner the server writes to stderr, and what happens when
 * the server is started somewhere that has no workspace at all.
 *
 * Both matter to the epic. A2 replaces `npx tsx src/mcp.ts` with
 * `staple mcp` dispatched from a bundled executable, and B1/B2/B3 add connectors
 * that "verify that the configured command starts and lists MCP tools" — a
 * verifier reads exactly this banner. A harness is also, by construction, often
 * launched from a directory that has no `.staple/` or `.tasks/` in it, so the workspace-less
 * path is the FIRST thing a new user hits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  bareEnv,
  MCP_ENTRY,
  removeDir,
  runCliAt,
  spawnStaple,
  tempDir,
  TSX_CLI,
} from "./fixtures/characterize-support.js";

let home: string;
let root: string;
let repo: string;
let repoDb: string;
/** A directory with no workspace at or above it. */
let orphan: string;

beforeAll(() => {
  home = tempDir("char-mcp-home");
  root = tempDir("char-mcp-root");
  orphan = tempDir("char-mcp-orphan");
  repo = join(root, "mcprepo");
  mkdirSync(repo, { recursive: true });
  repoDb = join(repo, ".staple", "staple.db");
  expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
  expect(runCliAt(repo, ["init", "--global", "mcpglobal"], { STAPLE_HOME: home }).status).toBe(0);
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
  removeDir(orphan);
});

/** Start the MCP server, wait for its one-line banner, kill it, return the line. */
async function banner(cwd: string, env: Record<string, string>): Promise<string> {
  const proc = spawnStaple(MCP_ENTRY, [], { cwd, env: { STAPLE_HOME: home, ...env } });
  const seen = await proc.waitFor((_out, err) => err.includes("\n"), 25_000);
  proc.kill();
  expect(seen, `no banner from ${cwd}`).toBe(true);
  return proc.stderr().trim();
}

describe("the readiness banner", () => {
  const PREAMBLE = "staple mcp ready — ";
  const CODA = "; pass ws to target another, or call init if there is none";

  it("goes to STDERR, on one line, and stdout stays clean for the protocol", async () => {
    const proc = spawnStaple(MCP_ENTRY, [], { cwd: repo, env: { STAPLE_HOME: home } });
    await proc.waitFor((_out, err) => err.includes("\n"), 25_000);
    // stdio transport owns stdout; a single stray byte there corrupts the
    // JSON-RPC framing, so "stdout is empty at rest" is a hard contract.
    expect(proc.stdout()).toBe("");
    expect(proc.stderr().trimEnd().split("\n")).toHaveLength(1);
    proc.kill();
  }, 40_000);

  it("names the walk-up directory when no workspace variable is set", async () => {
    expect(await banner(repo, {})).toBe(
      `${PREAMBLE}no STAPLE_AGENT — every write must pass actor, ` +
        `workspace resolved per call (walking up from ${repo})${CODA}`,
    );
  }, 40_000);

  it("names STAPLE_DB and the default agent when both are set", async () => {
    expect(await banner(repo, { STAPLE_DB: repoDb, STAPLE_AGENT: "a1-agent" })).toBe(
      `${PREAMBLE}default agent "a1-agent", workspace resolved per call (STAPLE_DB ${repoDb})${CODA}`,
    );
  }, 40_000);

  it("names STAPLE_WS when it is the only selector", async () => {
    expect(await banner(repo, { STAPLE_WS: "mcpglobal" })).toBe(
      `${PREAMBLE}no STAPLE_AGENT — every write must pass actor, ` +
        `workspace resolved per call (STAPLE_WS mcpglobal)${CODA}`,
    );
  }, 40_000);

  /**
   * QUIRK (A2/A7): the banner reports the CONFIGURATION, never a resolution.
   * Started in a directory with no workspace at or above it, it still announces
   * itself as ready and prints the same "walking up from …" line, because
   * nothing is resolved until the first tool call. A connector verifier that
   * treats the banner as proof of a working setup gets a false positive.
   */
  it("KNOWN: reports ready even from a directory with no workspace anywhere above it", async () => {
    expect(await banner(orphan, {})).toBe(
      `${PREAMBLE}no STAPLE_AGENT — every write must pass actor, ` +
        `workspace resolved per call (walking up from ${orphan})${CODA}`,
    );
  }, 40_000);
});

describe("a server started with no workspace in reach", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, MCP_ENTRY],
      cwd: orphan,
      env: bareEnv({ STAPLE_HOME: home, STAPLE_AGENT: "char-mcp" }),
      stderr: "ignore",
    });
    client = new Client({ name: "characterize-mcp", version: "0.0.0" });
    await client.connect(transport);
  }, 40_000);

  afterAll(async () => {
    await client?.close();
  });

  it("still connects and still lists all 40 tools", async () => {
    const { tools } = await client.listTools();
    // The inventory does not shrink when there is nowhere to write: a harness
    // configured before the user ever ran `init` sees the full tool set.
    // 16 before this merge, plus STA-140's four vocabulary tools, STA-143's
    // three gate verbs, STA-172's eight milestone tools, STA-179's
    // get_setting / set_setting and STA-168's seven queue tools.
    expect(tools).toHaveLength(40);
  });

  it("pins the not_found guidance a read tool returns instead of an empty result", async () => {
    const result = (await client.callTool({ name: "list_tasks", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text!;
    const [prose, ...rest] = text.split("\n");
    expect(prose).toBe(
      'ERROR(not_found): No staple workspace found at or above this server\'s working directory. ' +
        'Call the "init" tool to create one, or pass "ws" (a hub-registered workspace slug or ' +
        'identifier prefix) on this call. "hub_overview" lists the registered workspaces.',
    );
    // The machine-readable envelope rides on the LAST line, as elsewhere.
    expect(JSON.parse(rest[rest.length - 1]!)).toEqual({
      error: {
        code: "not_found",
        message:
          'No staple workspace found at or above this server\'s working directory. ' +
          'Call the "init" tool to create one, or pass "ws" (a hub-registered workspace slug or ' +
          'identifier prefix) on this call. "hub_overview" lists the registered workspaces.',
        retryable: false,
      },
    });
  }, 30_000);

  it("`hub_overview` works without a workspace, so the escape hatch it names is real", async () => {
    const result = (await client.callTool({ name: "hub_overview", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text!) as { workspaces: Array<{ slug: string }> };
    expect(payload.workspaces.map((w) => w.slug).sort()).toEqual(["mcpglobal", "mcprepo"]);
  }, 30_000);

  it("the `init` tool creates the same layout the CLI does, and returns the same fields", async () => {
    const target = join(orphan, "made-by-mcp");
    const result = (await client.callTool({ name: "init", arguments: { dir: target } })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      slug: "made-by-mcp",
      prefix: "MAD",
      dbPath: join(target, ".staple", "staple.db"),
      created: true,
      guidePath: join(target, ".staple", "AGENTS.md"),
      guideWritten: true,
    });

    // Parity check against the CLI: the workspace the tool made is a first-class
    // one that `staple ls` opens by walk-up, with no extra step.
    expect(runCliAt(target, ["ls"], { STAPLE_HOME: home }).stdout).toBe("(no issues)\n");
  }, 40_000);
});
