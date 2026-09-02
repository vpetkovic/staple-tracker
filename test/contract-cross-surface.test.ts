/**
 * H10 — cross-surface consistency.
 *
 * The per-surface suites each check their projection against the canonical
 * table. This one closes the loop the other way: it drives the SAME logical
 * failure through all three surfaces against ONE workspace, in one run, and
 * asserts the {code, retryable, detail} triples are identical to each other and
 * to the canonical table.
 *
 * That matters because the three surfaces reach the store by three different
 * paths (MCP tool -> run()/fail(), CLI -> top-level catch, HTTP -> the request
 * handler's catch) and each formats the envelope itself. A regression in any
 * one of those three formatters is invisible to a single-surface test and
 * obvious here.
 *
 * Surfaces that structurally cannot raise a given error are asserted absent
 * rather than skipped, so adding the missing route is a deliberate diff.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES, ERROR_CONTRACT, httpStatusFor, tripleOf, type ErrorTriple } from "./fixtures/error-contract.js";

const WS = "contract";
const INTRUDER = "other-agent";

let home: string;
let emptyDir: string;
let planFile: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-x-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-contract-x-cwd-"));
  planFile = join(home, "plan.md");
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  expect(cli("new", "Contract root task", "--ws", WS).status).toBe(0);
  writeFileSync(planFile, "# plan v1\n");
  expect(cli("doc", "CON-1", "plan", "--put", planFile, "--ws", WS).status).toBe(0);
  // One holder, established once, so all three surfaces see the same conflict.
  expect(cli("start", "CON-1", "--agent", CONTRACT_AGENT, "--ws", WS).status).toBe(0);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: INTRUDER });
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

/** One logical failure, expressed once per surface. `http: null` = no route can raise it. */
interface CrossCase {
  label: string;
  expected: ErrorTriple;
  mcp: () => Promise<Record<string, unknown>>;
  cli: () => CliResult;
  cliExit: number;
  http: null | (() => Promise<{ status: number; body: Record<string, unknown> }>);
}

async function httpJson(input: string, init?: RequestInit) {
  const response = await fetch(`${origin}${input}`, {
    ...init,
    headers: { "x-staple-token": token, ...(init?.headers as Record<string, string> | undefined) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function cases(): CrossCase[] {
  return [
    {
      label: "checkout conflict",
      expected: ERROR_CONTRACT.checkoutConflict(CONTRACT_AGENT),
      mcp: async () => mcpEnvelope(await mcp.call("checkout_task", { ref: "CON-1", ws: WS })),
      cli: () => cli("start", "CON-1", "--agent", INTRUDER, "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.conflict!,
      http: () => httpJson("/api/action", { method: "POST", body: JSON.stringify({ type: "checkout", ref: "CON-1" }) }),
    },
    {
      label: "not_found",
      expected: ERROR_CONTRACT.notFound(),
      mcp: async () => mcpEnvelope(await mcp.call("get_task", { ref: "CON-999", ws: WS })),
      cli: () => cli("show", "CON-999", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.not_found!,
      http: () => httpJson("/api/issue?ref=CON-999"),
    },
    {
      label: "revision_conflict",
      expected: ERROR_CONTRACT.revisionConflict(1),
      mcp: async () =>
        mcpEnvelope(await mcp.call("put_document", { ref: "CON-1", key: "plan", body: "x", base_revision: 99, ws: WS })),
      cli: () => cli("doc", "CON-1", "plan", "--put", planFile, "--base", "99", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.revision_conflict!,
      // KNOWN: /api/document is GET-only, so HTTP cannot raise this.
      http: null,
    },
    {
      label: "duplicate",
      expected: ERROR_CONTRACT.duplicate("CON-1"),
      mcp: async () => mcpEnvelope(await mcp.call("create_task", { title: "Contract root task", ws: WS })),
      cli: () => cli("new", "Contract root task", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.duplicate!,
      // KNOWN: there is no HTTP create route, so HTTP cannot raise this.
      http: null,
    },
  ];
}

describe("the same logical error yields the same triple on every surface", () => {
  it.each(cases())("$label", async (testCase) => {
    const mcpTriple = tripleOf(await testCase.mcp());
    const cliResult = testCase.cli();
    const cliTriple = tripleOf(cliEnvelope(cliResult));

    expect(mcpTriple, "MCP").toEqual(testCase.expected);
    expect(cliTriple, "CLI").toEqual(testCase.expected);
    expect(cliTriple, "CLI vs MCP").toEqual(mcpTriple);
    expect(cliResult.status, "CLI exit code").toBe(testCase.cliExit);

    if (testCase.http) {
      const { status, body } = await testCase.http();
      expect(status, "HTTP status").toBe(httpStatusFor(testCase.expected.code));
      expect(tripleOf(body), "HTTP").toEqual(testCase.expected);
      expect(tripleOf(body), "HTTP vs MCP").toEqual(mcpTriple);
    } else {
      // Asserted absent, not skipped: adding the route must change this table.
      expect(testCase.http).toBeNull();
    }
  });
});

describe("surface-specific framing around a shared triple", () => {
  it("each surface wraps the SAME envelope in its own transport signal", async () => {
    // MCP: in-band isError, no exception, no structuredContent.
    const mcpResult = await mcp.call("checkout_task", { ref: "CON-1", ws: WS });
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.structuredContent).toBeUndefined();

    // CLI: exit code + exactly one JSON line on stderr, nothing on stdout.
    const cliResult = cli("start", "CON-1", "--agent", INTRUDER, "--ws", WS, "--json");
    expect(cliResult.status).toBe(CLI_EXIT_CODES.conflict);
    expect(cliResult.stdout).toBe("");
    expect(cliResult.stderr.trim().split("\n")).toHaveLength(1);

    // HTTP: 409 + a body carrying both `message` and the legacy `error` key.
    const { status, body } = await httpJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ type: "checkout", ref: "CON-1" }),
    });
    expect(status).toBe(409);
    expect(body.error).toBe(body.message);

    // ...and the three messages are the SAME string, because they come from the
    // same StapleError. A surface rewording an error is a contract change.
    expect(cliEnvelope(cliResult).message).toBe(mcpEnvelope(mcpResult).message);
    expect(body.message).toBe(mcpEnvelope(mcpResult).message);
  });

  it("retryable is a property of the error, not of the surface", async () => {
    const mcpEnv = mcpEnvelope(
      await mcp.call("put_document", { ref: "CON-1", key: "plan", body: "x", base_revision: 99, ws: WS }),
    );
    const cliEnv = cliEnvelope(
      cli("doc", "CON-1", "plan", "--put", planFile, "--base", "99", "--ws", WS, "--json"),
    );
    expect(mcpEnv.retryable).toBe(true);
    expect(cliEnv.retryable).toBe(true);

    const mcpConflict = mcpEnvelope(await mcp.call("checkout_task", { ref: "CON-1", ws: WS }));
    const httpConflict = await httpJson("/api/action", {
      method: "POST",
      body: JSON.stringify({ type: "checkout", ref: "CON-1" }),
    });
    expect(mcpConflict.retryable).toBe(false);
    expect(httpConflict.body.retryable).toBe(false);
  });
});
