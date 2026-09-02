/**
 * H10 — CLI contract goldens.
 *
 * The CLI is the surface a shell-based agent branches on, so what is pinned
 * here is the pair it actually consumes: the single-line JSON envelope on
 * stderr and the typed exit code. Both are checked against the ONE canonical
 * table in fixtures/error-contract.ts, which is what keeps this surface honest
 * against MCP and HTTP.
 *
 * The fixture workspace is built through the CLI itself (`staple init --global`),
 * so this suite exercises the real binary end to end and imports nothing from
 * src/. One process per assertion is the cost of testing a process boundary;
 * the fixture setup is shared via beforeAll to keep it to a handful.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_AGENT, cliEnvelope, runCli, type CliResult } from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES, ERROR_CONTRACT, tripleOf, type ErrorTriple } from "./fixtures/error-contract.js";

const WS = "contract";
/** Deterministic stand-in for $USER, for the "CLI does not require an actor" pin. */
const FALLBACK_USER = "ci-user";

let home: string;
let planFile: string;

function cli(...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, USER: FALLBACK_USER });
}

/** Same, with an explicit default identity — the normal way an agent runs it. */
function cliAs(agent: string, ...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, USER: FALLBACK_USER, STAPLE_AGENT: agent });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-cli-"));
  planFile = join(home, "plan.md");

  expect(cli("init", "--global", WS).status).toBe(0);
  expect(cliAs(CONTRACT_AGENT, "new", "Contract root task", "--ws", WS).status).toBe(0);
  expect(cliAs(CONTRACT_AGENT, "start", "CON-1", "--agent", CONTRACT_AGENT, "--ws", WS).status).toBe(0);

  writeFileSync(planFile, "# plan v1\n");
  expect(cliAs(CONTRACT_AGENT, "doc", "CON-1", "plan", "--put", planFile, "--ws", WS).status).toBe(0);
}, 60_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// -------------------------------------------------------- error projection

interface CliErrorCase {
  label: string;
  args: string[];
  expected: ErrorTriple;
}

const CASES: CliErrorCase[] = [
  {
    label: "checkout conflict",
    args: ["start", "CON-1", "--agent", "other-agent", "--ws", WS],
    expected: ERROR_CONTRACT.checkoutConflict(CONTRACT_AGENT),
  },
  {
    label: "revision_conflict",
    args: ["doc", "CON-1", "plan", "--put", "<plan>", "--base", "99", "--ws", WS],
    expected: ERROR_CONTRACT.revisionConflict(1),
  },
  {
    label: "duplicate",
    args: ["new", "Contract root task", "--ws", WS],
    expected: ERROR_CONTRACT.duplicate("CON-1"),
  },
  {
    label: "not_found",
    args: ["show", "CON-999", "--ws", WS],
    expected: ERROR_CONTRACT.notFound(),
  },
  {
    label: "validation",
    args: ["status", "CON-1", "not_a_status", "--ws", WS],
    expected: { code: "validation", retryable: false },
  },
];

function runCase(testCase: CliErrorCase): CliResult {
  return cliAs(CONTRACT_AGENT, ...testCase.args.map((a) => (a === "<plan>" ? planFile : a)), "--json");
}

describe("error envelopes (CLI --json projection)", () => {
  it.each(CASES)("$label emits the canonical triple on one stderr line", (testCase) => {
    const result = runCase(testCase);
    expect(result.stdout).toBe("");
    const envelope = cliEnvelope(result); // throws unless stderr is exactly one line
    expect(tripleOf(envelope)).toEqual(testCase.expected);
    expect(typeof envelope.message).toBe("string");
    expect((envelope.message as string).length).toBeGreaterThan(0);
  });

  it.each(CASES)("$label exits with the typed code for its class", (testCase) => {
    const result = runCase(testCase);
    expect(result.status).toBe(CLI_EXIT_CODES[testCase.expected.code]);
  });

  it.each(CASES)("$label without --json reports prose, not JSON", (testCase) => {
    const args = testCase.args.map((a) => (a === "<plan>" ? planFile : a));
    const result = cliAs(CONTRACT_AGENT, ...args);
    expect(result.status).toBe(CLI_EXIT_CODES[testCase.expected.code]);
    expect(result.stderr).toContain(`error(${testCase.expected.code}):`);
    expect(() => JSON.parse(result.stderr)).toThrow();
  });

  it("revision_conflict is the ONLY retryable code on this surface", () => {
    const retryable = CASES.filter((c) => cliEnvelope(runCase(c)).retryable === true);
    expect(retryable.map((c) => c.label)).toEqual(["revision_conflict"]);
  });
});

// ------------------------------------------------------------- exit codes

describe("exit code contract", () => {
  it("pins the full code table", () => {
    expect(CLI_EXIT_CODES).toEqual({
      validation: 2,
      not_found: 3,
      conflict: 4,
      duplicate: 5,
      cycle: 6,
      revision_conflict: 7,
      timeout: 8,
    });
  });

  it("`staple help` documents exactly that table", () => {
    const help = cli("help");
    expect(help.status).toBe(0);
    // The help text is the contract a human reads; drift between it and the
    // switch in cli.ts is a bug in one of the two.
    expect(help.stdout).toContain(
      "Exit codes: 0 ok · 1 unknown · 2 validation · 3 not_found · 4 conflict",
    );
    expect(help.stdout).toContain("5 duplicate · 6 cycle · 7 revision_conflict · 8 timeout (wait)");
  });

  it("a successful command exits 0 with a clean stderr", () => {
    const result = cliAs(CONTRACT_AGENT, "ls", "--ws", WS, "--json");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
  });

  it("an unknown command and an unknown option are both validation, never unknown", () => {
    for (const args of [["bogus"], ["ls", "--nope", "--ws", WS]]) {
      const result = cliAs(CONTRACT_AGENT, ...args, "--json");
      expect(result.status).toBe(CLI_EXIT_CODES.validation);
      const envelope = cliEnvelope(result);
      expect(envelope.code).toBe("validation");
      expect(envelope.retryable).toBe(false);
    }
  });
});

// --------------------------------------------------- known surface gaps

describe("KNOWN: logical errors this surface cannot project", () => {
  /**
   * KNOWN — actor requirement is NOT enforced on the CLI. src/cli.ts resolves
   * identity as `--agent/--author ?? STAPLE_AGENT ?? $USER ?? "user"`, so a
   * write with no identity succeeds and is attributed to the shell user, while
   * the SAME write over MCP is refused with a validation envelope (H8).
   * Pinned, not fixed: closing it is a source change and its own ticket.
   */
  it("a CLI write with no actor succeeds and is attributed to $USER", () => {
    const result = cli("comment", "CON-1", "no actor here", "--ws", WS);
    expect(result.status).toBe(0);
    const context = JSON.parse(cli("show", "CON-1", "--ws", WS, "--json").stdout) as {
      comments: Array<{ author: string; body: string }>;
    };
    const posted = context.comments.find((c) => c.body === "no actor here");
    expect(posted?.author).toBe(FALLBACK_USER);
  });

  /**
   * KNOWN — `staple comment` hardcodes authorType "user" (src/cli.ts case
   * "comment"), while the MCP add_comment tool defaults to "agent" and the UI
   * server also writes "user". The same logical action therefore lands with a
   * different authorType depending on which surface an agent reached for.
   */
  it("a CLI comment is recorded as authorType \"user\", not \"agent\"", () => {
    expect(cliAs(CONTRACT_AGENT, "comment", "CON-1", "surface check", "--ws", WS).status).toBe(0);
    const context = JSON.parse(cliAs(CONTRACT_AGENT, "show", "CON-1", "--ws", WS, "--json").stdout) as {
      comments: Array<{ author: string; authorType: string; body: string }>;
    };
    const posted = context.comments.find((c) => c.body === "surface check");
    expect(posted?.author).toBe(CONTRACT_AGENT);
    expect(posted?.authorType).toBe("user");
  });

  /**
   * KNOWN — the CLI has no cursor flag at all (`ls`, `inbox`, and `board` return
   * the full result set), so the cursor-scope validation error is reachable only
   * over MCP. If a --cursor flag is ever added, this test should be replaced by a
   * real projection case in CASES above.
   */
  it("no CLI command accepts a --cursor flag", () => {
    const help = cli("help");
    expect(help.stdout).not.toContain("--cursor");
    const result = cliAs(CONTRACT_AGENT, "ls", "--cursor", "whatever", "--ws", WS, "--json");
    expect(result.status).toBe(CLI_EXIT_CODES.validation);
    expect(cliEnvelope(result).code).toBe("validation");
  });
});
