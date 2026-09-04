/**
 * STA-172 — milestones across the three machine surfaces.
 *
 * `store-milestones.test.ts` pins what the service does. This suite pins that
 * the CLI (`--json`), the MCP tools and the UI server's routes are three
 * projections of ONE shape and ONE refusal table: the same milestone view
 * byte-for-byte after normalization, the same {code, retryable, detail} triple
 * for a non-milestone, an unknown reference, a stale base revision and a
 * workspace without the kind, and a create-from-epic preview that names the
 * same changes on every surface as the commit does. Every test name is the one
 * docs/milestones.md says pins the paragraph.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MILESTONE_KIND_MISSING_MESSAGE } from "../src/core/milestones.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  cliEnvelope,
  mcpEnvelope,
  normalize,
  runCli,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES, ERROR_CONTRACT, httpStatusFor, tripleOf, type ErrorTriple } from "./fixtures/error-contract.js";

const WS = "contract";
/** A second workspace that never ran `kinds add milestone`. */
const BARE = "bare";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

function cliJson(...args: string[]): unknown {
  const result = cli(...args, "--json");
  expect(result.stderr, result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

async function mcpJson(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result);
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: CONTRACT_AGENT, ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function httpJson(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const { status, body: payload } = await http(path, body);
  expect(status, JSON.stringify(payload)).toBe(200);
  return payload;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-ms-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-contract-ms-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  expect(cli("init", "--global", BARE).status).toBe(0);
  expect(cli("kinds", "add", "milestone", "--label", "Milestone", "--ws", WS).status).toBe(0);
  // CON-1 programme > CON-2 epic > CON-3 task; CON-4 a standalone task.
  expect(cli("new", "R programme", "--kind", "epic", "--ws", WS).status).toBe(0);
  expect(cli("new", "S: opt-in cloud continuity", "--kind", "epic", "--parent", "CON-1", "--ws", WS).status).toBe(0);
  expect(cli("new", "S2", "--parent", "CON-2", "--ws", WS).status).toBe(0);
  expect(cli("new", "Flake", "--ws", WS).status).toBe(0);
  // CON-5 is the milestone the shape tests read; it has one member (CON-4).
  expect(cli("milestone", "new", "October cut", "--target", "2026-10-31", "--ws", WS).status).toBe(0);
  expect(cli("milestone", "add", "CON-5", "CON-4", "--ws", WS).status).toBe(0);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
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

describe("every operation has the same shape and refusal on every surface", () => {
  it("show is one shape on CLI, MCP and HTTP", async () => {
    const fromCli = normalize(cliJson("milestone", "show", "CON-5", "--ws", WS), [home]);
    const fromMcp = normalize(await mcpJson("get_milestone", { ref: "CON-5" }), [home]);
    const fromHttp = normalize(await httpJson(`/api/milestone?ref=CON-5&ws=${WS}`), [home]);
    expect(fromCli).toEqual({
      milestone: {
        identifier: "CON-5",
        title: "October cut",
        status: "backlog",
        kind: "milestone",
        assignee: null,
        targetDate: "2026-10-31",
        startDate: null,
        state: "planned",
        planPosition: null,
      },
      progress: {
        total: 1,
        countable: 1,
        counts: { unstarted: 1, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done: 0, cancelled: 0 },
        percent: 0,
        complete: false,
      },
      revision: 1,
      members: [
        {
          identifier: "CON-4",
          title: "Flake",
          kind: "task",
          status: "backlog",
          position: 1,
          rank: 1024,
          parent: null,
          nestedUnder: null,
          addedBy: CONTRACT_AGENT,
          addedAt: "<iso>",
          note: null,
        },
      ],
      next: null,
    });
    expect(fromMcp).toEqual(fromCli);
    expect(fromHttp).toEqual(fromCli);
  });

  it("list is one shape on CLI, MCP and HTTP", async () => {
    const fromCli = normalize(cliJson("milestone", "ls", "--ws", WS), [home]);
    const fromMcp = normalize(await mcpJson("list_milestones", {}), [home]);
    const fromHttp = normalize(await httpJson(`/api/milestones?ws=${WS}`), [home]);
    expect(fromCli).toEqual([
      expect.objectContaining({ milestone: expect.objectContaining({ identifier: "CON-5" }), revision: 1, memberCount: 1, next: null }),
    ]);
    // The MCP text block is the bare array (structuredContent wraps it as {items}).
    expect(fromMcp).toEqual(fromCli);
    expect(fromHttp).toEqual(fromCli);
  });

  interface CrossCase {
    label: string;
    expected: ErrorTriple;
    mcp: () => Promise<Record<string, unknown>>;
    cli: () => CliResult;
    cliExit: number;
    http: () => Promise<{ status: number; body: Record<string, unknown> }>;
  }

  const cases: CrossCase[] = [
    {
      label: "a non-milestone is refused naming its kind",
      expected: { code: "validation", retryable: false, detail: { identifier: "CON-2", kind: "epic" } },
      mcp: async () => mcpEnvelope(await mcp.call("get_milestone", { ref: "CON-2", ws: WS })),
      cli: () => cli("milestone", "show", "CON-2", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.validation!,
      http: () => http(`/api/milestone?ref=CON-2&ws=${WS}`),
    },
    {
      label: "an unknown reference is not_found",
      expected: ERROR_CONTRACT.notFound(),
      mcp: async () => mcpEnvelope(await mcp.call("get_milestone", { ref: "CON-999", ws: WS })),
      cli: () => cli("milestone", "show", "CON-999", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.not_found!,
      http: () => http(`/api/milestone?ref=CON-999&ws=${WS}`),
    },
    {
      label: "removing a non-member is not_found",
      expected: { code: "not_found", retryable: false, detail: { identifier: "CON-3", milestone: "CON-5" } },
      mcp: async () => mcpEnvelope(await mcp.call("remove_milestone_member", { milestone: "CON-5", ref: "CON-3", ws: WS })),
      cli: () => cli("milestone", "rm", "CON-5", "CON-3", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.not_found!,
      http: () => http("/api/milestone/remove", { milestone: "CON-5", ref: "CON-3" }),
    },
    {
      label: "a stale base revision is revision_conflict",
      expected: ERROR_CONTRACT.revisionConflict(1),
      mcp: async () =>
        mcpEnvelope(await mcp.call("add_milestone_member", { milestone: "CON-5", ref: "CON-3", base_revision: 99, ws: WS })),
      cli: () => cli("milestone", "add", "CON-5", "CON-3", "--base", "99", "--ws", WS, "--json"),
      cliExit: CLI_EXIT_CODES.revision_conflict!,
      http: () => http("/api/milestone/add", { milestone: "CON-5", ref: "CON-3", baseRevision: 99 }),
    },
  ];

  it.each(cases)("$label", async (testCase) => {
    const mcpTriple = tripleOf(await testCase.mcp());
    const cliResult = testCase.cli();
    const cliTriple = tripleOf(cliEnvelope(cliResult));
    const { status, body } = await testCase.http();

    expect(mcpTriple, "MCP").toEqual(testCase.expected);
    expect(cliTriple, "CLI").toEqual(testCase.expected);
    expect(cliResult.status, "CLI exit code").toBe(testCase.cliExit);
    expect(status, "HTTP status").toBe(httpStatusFor(testCase.expected.code));
    expect(tripleOf(body), "HTTP").toEqual(testCase.expected);
    expect(body.error).toBe(body.message);
    // Nothing moved: the stale add and the bad remove left the order standing.
    expect((await mcpJson("get_milestone", { ref: "CON-5" }) as { revision: number }).revision).toBe(1);
  });
});

describe("every surface refuses with the same validation envelope when the kind is absent", () => {
  it("names the kinds add that enables the feature, on every surface", async () => {
    const fromMcp = mcpEnvelope(await mcp.call("list_milestones", { ws: BARE }));
    const cliResult = cli("milestone", "ls", "--ws", BARE, "--json");
    const fromCli = cliEnvelope(cliResult);
    const { status, body } = await http(`/api/milestones?ws=${BARE}`);

    const expected = { code: "validation", message: MILESTONE_KIND_MISSING_MESSAGE, detail: { kind: "milestone" }, retryable: false };
    expect(fromMcp).toEqual(expected);
    expect(fromCli).toEqual(expected);
    expect(cliResult.status).toBe(CLI_EXIT_CODES.validation);
    expect(status).toBe(409);
    expect(body).toEqual({ ...expected, error: expected.message });

    // The writes too — a workspace without the vocabulary gets nothing created on its behalf.
    expect(mcpEnvelope(await mcp.call("create_milestone", { title: "x", ws: BARE })).message).toBe(MILESTONE_KIND_MISSING_MESSAGE);
    expect((await http("/api/milestone/create", { title: "x", ws: BARE })).body.message).toBe(MILESTONE_KIND_MISSING_MESSAGE);
    expect(cliEnvelope(cli("milestone", "new", "x", "--ws", BARE, "--json")).message).toBe(MILESTONE_KIND_MISSING_MESSAGE);
  });
});

describe("the preview and the commit name the same changes on every surface", () => {
  it("previews one membership and no hierarchy change, then commits exactly that", async () => {
    const expected = {
      preview: true,
      milestone: { title: "S: opt-in cloud continuity", targetDate: "2026-12-31", startDate: null },
      members: [{ identifier: "CON-2", position: 1 }],
      hierarchyChanges: [],
    };
    const before = (await mcpJson("list_milestones", { all: true }) as unknown[]).length;
    expect(cliJson("milestone", "new", "--from-epic", "CON-2", "--target", "2026-12-31", "--preview", "--ws", WS)).toEqual(expected);
    expect(await mcpJson("create_milestone", { from_epic: "CON-2", target_date: "2026-12-31", preview: true })).toEqual(expected);
    expect(await httpJson("/api/milestone/create", { fromEpic: "CON-2", targetDate: "2026-12-31", preview: true })).toEqual(expected);
    // Three previews wrote nothing.
    expect(await mcpJson("list_milestones", { all: true })).toHaveLength(before);
    expect((await mcpJson("get_task", { ref: "CON-2" }) as { issue: { parentId: string } }).issue.parentId).toBeTruthy();

    const committed = (await httpJson("/api/milestone/create", { fromEpic: "CON-2", targetDate: "2026-12-31" })) as {
      preview: boolean;
      milestone: { identifier: string; title: string; targetDate: string };
      members: Array<{ identifier: string; position: number; parent: string; nestedUnder: string | null }>;
      hierarchyChanges: unknown[];
      progress: { total: number };
    };
    expect(committed.preview).toBe(false);
    expect(committed.milestone).toMatchObject({ identifier: "CON-6", title: expected.milestone.title, targetDate: "2026-12-31" });
    expect(committed.members.map(({ identifier, position }) => ({ identifier, position }))).toEqual(expected.members);
    expect(committed.hierarchyChanges).toEqual(expected.hierarchyChanges);
    // The epic is still the programme's child, its task came along by descent and was not copied in.
    expect(committed.members[0]!.parent).toBe("CON-1");
    expect(committed.members).toHaveLength(1);
    expect(committed.progress.total).toBe(1);
    const epic = (await mcpJson("get_task", { ref: "CON-2" }) as { issue: { parentId: string }; children: unknown[] });
    expect(epic.children).toHaveLength(1);
    // And the commit is what every surface now reads.
    expect(normalize(cliJson("milestone", "show", "CON-6", "--ws", WS), [home])).toEqual(
      normalize(await mcpJson("get_milestone", { ref: "CON-6" }), [home]),
    );
  });
});

describe("round-trips dates, order and removal", () => {
  it("a date set on one surface is read on the others, and `none` clears it", async () => {
    await httpJson("/api/milestone/update", { ref: "CON-5", startDate: "2026-10-01", targetDate: "2026-11-30" });
    expect((await mcpJson("get_milestone", { ref: "CON-5" }) as { milestone: Record<string, unknown> }).milestone).toMatchObject({
      startDate: "2026-10-01",
      targetDate: "2026-11-30",
    });
    const cleared = cliJson("milestone", "set", "CON-5", "--start", "none", "--ws", WS) as { milestone: Record<string, unknown> };
    expect(cleared.milestone).toMatchObject({ startDate: null, targetDate: "2026-11-30" });
    expect(((await httpJson(`/api/milestone?ref=CON-5&ws=${WS}`)) as { milestone: Record<string, unknown> }).milestone).toMatchObject({
      startDate: null,
      targetDate: "2026-11-30",
    });
    const bad = await mcp.call("update_milestone", { ref: "CON-5", start_date: "2026-12-01", ws: WS });
    expect(mcpEnvelope(bad)).toMatchObject({ code: "validation", detail: { startDate: "2026-12-01", targetDate: "2026-11-30" } });
  });

  it("order written on one surface is the order every surface reads, with the revision as the base", async () => {
    // CON-5 holds [CON-4]. Add CON-3 first over MCP, move it after CON-4 over the
    // CLI, reorder over HTTP with the revision the CLI printed, read everywhere.
    const added = (await mcpJson("add_milestone_member", { milestone: "CON-5", ref: "CON-3", at: 1 })) as {
      replayed: boolean;
      revision: number;
      members: Array<{ identifier: string }>;
    };
    expect(added.replayed).toBe(false);
    expect(added.members.map((m) => m.identifier)).toEqual(["CON-3", "CON-4"]);
    const moved = cliJson("milestone", "mv", "CON-3", "--after", "CON-4", "--base", String(added.revision), "--ws", WS) as {
      revision: number;
      members: Array<{ identifier: string }>;
    };
    expect(moved.members.map((m) => m.identifier)).toEqual(["CON-4", "CON-3"]);
    const reordered = (await httpJson("/api/milestone/reorder", {
      milestone: "CON-5",
      order: ["CON-3", "CON-4"],
      baseRevision: moved.revision,
    })) as { revision: number; members: Array<{ identifier: string; rank: number }> };
    expect(reordered.revision).toBe(moved.revision + 1);
    expect(reordered.members.map((m) => [m.identifier, m.rank])).toEqual([
      ["CON-3", 1024],
      ["CON-4", 2048],
    ]);
    const fromCli = normalize(cliJson("milestone", "show", "CON-5", "--ws", WS), [home]);
    expect(fromCli).toEqual(normalize(await mcpJson("get_milestone", { ref: "CON-5" }), [home]));
    expect(fromCli).toEqual(normalize(await httpJson(`/api/milestone?ref=CON-5&ws=${WS}`), [home]));
    // A replayed add is the same shape plus the flag, and bumps nothing.
    const replay = (await mcpJson("add_milestone_member", { milestone: "CON-5", ref: "CON-3" })) as { replayed: boolean; revision: number };
    expect(replay).toMatchObject({ replayed: true, revision: reordered.revision });
  });

  it("a member removed on one surface is gone on the others, and the member itself is untouched", async () => {
    const before = (await mcpJson("get_task", { ref: "CON-3" }) as { issue: Record<string, unknown> }).issue;
    const removed = cliJson("milestone", "rm", "CON-5", "CON-3", "--ws", WS) as { members: Array<{ identifier: string }> };
    expect(removed.members.map((m) => m.identifier)).toEqual(["CON-4"]);
    expect(((await httpJson(`/api/milestone?ref=CON-5&ws=${WS}`)) as { members: unknown[] }).members).toHaveLength(1);
    expect((await mcpJson("get_milestone", { ref: "CON-5" }) as { members: unknown[] }).members).toHaveLength(1);
    const after = (await mcpJson("get_task", { ref: "CON-3" }) as { issue: Record<string, unknown> }).issue;
    expect(after).toEqual(before);
  });
});
