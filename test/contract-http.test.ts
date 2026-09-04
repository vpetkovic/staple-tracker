/**
 * H10 — HTTP (local UI server) contract goldens.
 *
 * The UI server is the third machine surface: the page consumes it, and so does
 * anything that curls the loopback API with the token. What is pinned here is
 * the status/body pair for every error class this surface can produce, checked
 * against the ONE canonical table in fixtures/error-contract.ts, plus the
 * `message` + legacy `error` duplication the page still depends on.
 *
 * The suite also pins, as an explicit golden, WHICH logical errors this surface
 * cannot produce — the API has no unattributed write and no paginated route —
 * so widening it later is a deliberate diff rather than a silent change. That
 * list has shrunk twice: U2's doc_restore made revision_conflict projectable,
 * and U5's create made duplicate projectable.
 *
 * Runs in-process on port 0 with the token startUiServer() hands back.
 */
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  ISO,
  REPO_ROOT,
  SECONDS,
  UUID,
  claimGolden,
  timingGolden,
  commentGolden,
  issueGolden,
  normalize,
  runCli,
} from "./fixtures/contract-support.js";
import { ERROR_CONTRACT, httpStatusFor, tripleOf, type ErrorTriple } from "./fixtures/error-contract.js";

const WS = "contract";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

function get(path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": token, ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-contract-http-"));
  // startUiServer resolves the workspace through the hub, which reads STAPLE_HOME
  // from this process — so it has to be set here, not only in the CLI child env.
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  expect(cli("new", "Contract root task", "--ws", WS).status).toBe(0);
  expect(cli("start", "CON-1", "--agent", CONTRACT_AGENT, "--ws", WS).status).toBe(0);
  expect(cli("comment", "CON-1", "contract comment", "--ws", WS).status).toBe(0);

  // CON-2 carries a document, so the revision_conflict projection has something to
  // conflict with. It has to be a different issue from CON-1: the "not_found
  // (document revision)" case above depends on CON-1 having no `plan`.
  expect(cli("new", "Contract documented task", "--ws", WS).status).toBe(0);
  const docFile = join(home, "plan.md");
  writeFileSync(docFile, "# plan\n\nrevision one\n");
  expect(cli("doc", "CON-2", "plan", "--put", docFile, "--summary", "first", "--ws", WS).status).toBe(0);

  ui = startUiServer({ port: 0, hub: false, ws: WS });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

// -------------------------------------------------------- error projection

interface HttpErrorCase {
  label: string;
  send: () => Promise<Response>;
  expected: ErrorTriple;
}

const CASES: HttpErrorCase[] = [
  {
    label: "checkout conflict",
    // The UI actor defaults to "ui", so this is a different agent claiming a held task.
    send: () => post({ type: "checkout", ref: "CON-1" }),
    expected: ERROR_CONTRACT.checkoutConflict(CONTRACT_AGENT),
  },
  {
    label: "not_found (issue)",
    send: () => get("/api/issue?ref=CON-999"),
    expected: ERROR_CONTRACT.notFound(),
  },
  {
    label: "not_found (document revision)",
    send: () => get("/api/document?ref=CON-1&key=plan"),
    expected: ERROR_CONTRACT.notFound(),
  },
  {
    label: "validation (unknown action)",
    send: () => post({ type: "definitely-not-an-action", ref: "CON-1" }),
    expected: { code: "validation", retryable: false },
  },
  {
    // U2 gave this surface a document write (doc_restore), so revision_conflict —
    // the one retryable code in the canonical table — is now projectable over HTTP.
    // It was previously listed as a structural gap; see the gap golden below.
    label: "revision_conflict (restore from a stale base)",
    send: () => post({ type: "doc_restore", ref: "CON-2", key: "plan", revision: 1, baseRevision: 99 }),
    expected: ERROR_CONTRACT.revisionConflict(1),
  },
  {
    // U5 gave this surface a create action, so `duplicate` — the normalized-title
    // guard on an open sibling — is projectable over HTTP for the first time. It
    // was listed as a structural gap ("no create route"); see the gap golden below.
    //
    // CON-1 is in_progress (open) with no parent, so a second root task with the
    // same title collides with it. This case is safe to run repeatedly because it
    // never succeeds: the guard fires before any row is written.
    label: "duplicate (create re-using an open title)",
    send: () => post({ type: "create", title: "Contract root task" }),
    expected: ERROR_CONTRACT.duplicate("CON-1"),
  },
];

describe("error envelopes (HTTP projection)", () => {
  it.each(CASES)("$label projects the canonical triple", async ({ send, expected }) => {
    const response = await send();
    const body = (await response.json()) as Record<string, unknown>;
    expect(tripleOf(body)).toEqual(expected);
  });

  it.each(CASES)("$label uses the status this code maps to", async ({ send, expected }) => {
    const response = await send();
    expect(response.status).toBe(httpStatusFor(expected.code));
  });

  it.each(CASES)("$label carries message AND the legacy error key, identically", async ({ send }) => {
    const body = (await (await send()).json()) as Record<string, unknown>;
    expect(typeof body.message).toBe("string");
    expect((body.message as string).length).toBeGreaterThan(0);
    // `error` predates `message` and the page still reads it; keeping them equal
    // is the contract, not an accident.
    expect(body.error).toBe(body.message);
  });

  it("every error body is JSON with a charset", async () => {
    for (const testCase of CASES) {
      const response = await testCase.send();
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });

  /**
   * KNOWN — validation maps to 409 here. 409 Conflict is the wrong status for a
   * malformed request (400 would be right), but it is what the page and every
   * existing caller branch on today, so it is pinned rather than fixed.
   */
  it("KNOWN: validation is projected as 409, not 400", async () => {
    const response = await post({ type: "definitely-not-an-action", ref: "CON-1" });
    expect(response.status).toBe(409);
  });
});

// ------------------------------------------------- transport-level denials

describe("transport denials keep the envelope shape", () => {
  const denials = [
    {
      label: "401 without a token",
      status: 401,
      code: "unauthorized",
      send: () => fetch(`${origin}/api/bootstrap`),
    },
    {
      label: "405 with the wrong method",
      status: 405,
      code: "method_not_allowed",
      send: () =>
        fetch(`${origin}/api/bootstrap`, { method: "POST", headers: { "x-staple-token": token } }),
    },
    {
      label: "403 from a cross-origin POST",
      status: 403,
      code: "forbidden",
      send: () => post({ type: "checkout", ref: "CON-1" }, { origin: "http://evil.example" }),
    },
  ];

  it.each(denials)("$label answers {error, message, code, retryable}", async ({ status, code, send }) => {
    const response = await send();
    expect(response.status).toBe(status);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "error", "message", "retryable"]);
    expect(body.code).toBe(code);
    expect(body.retryable).toBe(false);
    expect(body.error).toBe(body.message);
  });

  /**
   * KNOWN — the route-miss 404 is the one response that is NOT an envelope: it
   * answers {error: "not found"} with no code, message, or retryable. A client
   * that reads `code` gets undefined here and nowhere else.
   */
  it("KNOWN: an unknown /api path answers a bare {error} with no code", async () => {
    const response = await get("/api/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});

// ------------------------------------------------------------ success shape

describe("read shapes", () => {
  it("/api/issue returns the get_task context plus the workspace slug", async () => {
    const body = normalize(await (await get("/api/issue?ref=CON-1")).json(), [home]);
    expect(body).toEqual({
      workspace: WS,
      issue: issueGolden({
        identifier: "CON-1",
        title: "Contract root task",
        status: "in_progress",
        statusVersion: 1,
        assignee: CONTRACT_AGENT,
        checkoutAgent: CONTRACT_AGENT,
        checkoutAt: ISO,
        startedAt: ISO,
      }),
      ancestors: [],
      children: [],
      blockedBy: [],
      blocks: [],
      // KNOWN: authorType is "user" because the fixture comment was posted by the
      // CLI, which hardcodes "user" (src/cli.ts case "comment"), while MCP
      // add_comment defaults to "agent". Same store call, different default per
      // surface — pinned here and in contract-cli.test.ts, not fixed.
      comments: [commentGolden({ body: "contract comment", authorType: "user" })],
      documents: [],
      crossBlockers: [],
      // C1: claim liveness rides with the issue, matching MCP get_task.
      claim: claimGolden(),
      // STA-143: and so does the gate pair, for the same reason — this route is
      // get_task's context plus a workspace slug, and it must not diverge by a
      // field.
      gate: null,
      queuedBy: null,
      /**
       * STA-144: and `childrenQueued`, which is where this route DOES diverge from
       * get_task — deliberately, and it is the second such field after `workspace`.
       *
       * It is the reviewer's checklist. STA-154 changed its SHAPE from a map of
       * direct children to a flat pre-ordered LIST of the open descendants the gate
       * still holds, each with a depth, because approving a parent releases its
       * subtree and a map of direct children cannot show a subtree. An agent has no
       * checklist to draw and `/api/agent-context` is pinned byte-for-byte against
       * get_task, so this is a UI affordance and it stays on the UI's own route — the
       * same line `deps` draws on `/api/issues`. `[]` here because CON-1 has no gate.
       */
      childrenQueued: [],
      // STA-81/STA-90: so does the timing pair. CON-1 here is in_progress with
      // no children in this fixture, so it is a LEAF — its own interval IS the
      // headline, and `countedThrough` names where that open interval was
      // counted through (the holder's last activity, never `now`).
      timing: timingGolden({
        ownActiveSeconds: SECONDS,
        activeSeconds: SECONDS,
        countedThrough: ISO,
      }),
      childrenTiming: {},
    });
  });

  it("/api/bootstrap reports the mode and the workspaces it serves", async () => {
    expect(await (await get("/api/bootstrap")).json()).toEqual({
      mode: "workspace",
      workspaces: [{ slug: WS, prefix: "CON" }],
    });
  });

  it("/api/poll returns an opaque change fingerprint", async () => {
    const body = (await (await get("/api/poll")).json()) as { fingerprint: string };
    expect(Object.keys(body)).toEqual(["fingerprint"]);
    expect(typeof body.fingerprint).toBe("string");
  });
});

// --------------------------------------------------- known surface gaps

describe("KNOWN: logical errors this surface cannot project", () => {
  /**
   * One golden for the whole gap list. The HTTP API is deliberately narrower
   * than MCP — it exists to drive one page — so two canonical errors have no
   * route that can raise them. Adding a paginated list, or letting a write go
   * unattributed, must change THIS list, which is the review moment.
   */
  it("pins the exact API surface, read out of the server source", () => {
    // Derived, not restated: adding a route to src/ui/server.ts changes this
    // list and fails here, which is the review moment. U5's create and update
    // are branches inside POST /api/action rather than routes of their own,
    // which is why this list did not move for them.
    //
    // O7b (STA-141) MOVED IT, and moved the sentence above with it: /api/action
    // is no longer the only path that accepts a write. `/api/settings` is the
    // one route that reads AND writes — GET lists the workspace vocabulary,
    // POST applies an ordered op batch — because the two are the same resource
    // and a second path for the write half would have been a second name for it.
    // The gate now pins a LIST of methods per path rather than a single one, and
    // `test/ui-settings.test.ts` asserts that every other route kept exactly the
    // pin it had (bootstrap GET-only, action POST-only).
    // R3b (STA-172) added the `/api/milestone/*` family, the gate routes' shape:
    // a `switch` over literal paths under one `startsWith`. The pattern admits a
    // slash and a `case` so those literals — and the three gate routes that were
    // invisible to the old pattern — are derived too rather than hidden behind
    // the family.
    //
    // R5d (STA-184) added `/api/glyph/sanitize`, a POST that WRITES NOTHING: it
    // runs core's SVG sanitiser over the body so the picker can store the
    // canonical document and never the raw one. `test/ui-glyph-sanitize.test.ts`
    // pins it.
    const source = readFileSync(join(REPO_ROOT, "src/ui/server.ts"), "utf8");
    const routes = [...new Set([...source.matchAll(/(?:url\.pathname === |case )"(\/api\/[a-z/-]+)"/g)].map((m) => m[1]!))];
    expect(routes.sort()).toEqual([
      "/api/action",
      "/api/agent-context",
      "/api/bootstrap",
      "/api/document",
      "/api/events",
      "/api/gate/approve",
      "/api/gate/request",
      "/api/gate/request-changes",
      "/api/glyph/sanitize",
      "/api/graph",
      "/api/inbox",
      "/api/issue",
      "/api/issues",
      "/api/milestone",
      "/api/milestone/add",
      "/api/milestone/create",
      "/api/milestone/move",
      "/api/milestone/remove",
      "/api/milestone/reorder",
      "/api/milestone/update",
      "/api/milestones",
      "/api/poll",
      "/api/revisions",
      "/api/settings",
    ]);
  });

  /**
   * STA-124. The acceptance criterion is that BOTH graph producers carry `kind`
   * — this is the workspace branch; `Hub.graph()` is pinned in test/hub.test.ts.
   * They are separate code paths in separate files, which is exactly why the
   * field needs an assertion on each rather than one on "the graph".
   */
  it("carries the issue kind on every graph node", async () => {
    const graph = (await (await get("/api/graph")).json()) as {
      nodes: Array<{ id: string; kind: string; status: string; parent: string | null }>;
    };
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["CON-1", "CON-2"]);
    for (const node of graph.nodes) expect(node.kind).toBe("task");
    expect(Object.keys(graph.nodes[0]!).sort()).toEqual([
      "id",
      "kind",
      "parent",
      "status",
      "title",
      "workspace",
    ]);
  });

  it("documents why two canonical errors have no HTTP projection", () => {
    // Keyed by the canonical code, so a reader of error-contract.ts can see at a
    // glance which surfaces owe a projection and which structurally cannot.
    const gaps = {
      missing_actor: 'POST /api/action defaults actor to "ui", so a write is never unattributed',
      cursor_scope_mismatch: "no route accepts a cursor; /api/issues and /api/inbox return everything",
    };
    expect(Object.keys(gaps).sort()).toEqual(["cursor_scope_mismatch", "missing_actor"]);
    // The gap list and the projected list must together cover the canonical table.
    // revision_conflict LEFT this list in U2: the doc_restore action is a document
    // write, so a stale baseRevision now has an HTTP projection (see CASES).
    // duplicate LEFT it in U5, for the same kind of reason: the create action means
    // the normalized-title guard finally has a route that can raise it.
    const projected = new Set(CASES.map((c) => c.expected.code));
    expect([...projected].sort()).toEqual([
      "conflict",
      "duplicate",
      "not_found",
      "revision_conflict",
      "validation",
    ]);
  });

  /**
   * Runs LAST in the file on purpose: it is the only test here that adds a row, and
   * every golden above reads CON-1, CON-2, or a count-free shape. Keeping the writes
   * behind the reads means the read goldens never depend on what this created.
   */
  it("create answers a full Issue, attributed to the default \"ui\" actor", async () => {
    const response = await post({
      type: "create",
      title: "Contract created from the page",
      description: "made over HTTP",
      priority: "high",
      labels: ["ui", "u5"],
    });
    expect(response.status).toBe(200);
    expect(normalize(await response.json(), [home])).toEqual(
      issueGolden({
        identifier: "CON-3",
        title: "Contract created from the page",
        description: "made over HTTP",
        priority: "high",
        labels: ["ui", "u5"],
        createdBy: "ui",
      }),
    );
  });

  it("update patches only the keys it was given, and leaves the rest alone", async () => {
    const before = (await (await get("/api/issue?ref=CON-3")).json()) as { issue: Record<string, unknown> };
    expect(before.issue.labels).toEqual(["ui", "u5"]);

    // Title alone. The labels set must survive — the server builds the patch key by
    // key precisely so this cannot regress into a whole-object overwrite.
    const response = await post({ type: "update", ref: "CON-3", title: "Contract renamed from the page" });
    expect(response.status).toBe(200);
    const after = normalize(await response.json(), [home]) as Record<string, unknown>;
    expect(after.title).toBe("Contract renamed from the page");
    expect(after.labels).toEqual(["ui", "u5"]);
    expect(after.priority).toBe("high");
    expect(after.description).toBe("made over HTTP");
    // A property edit is not a status change: statusVersion must not tick.
    expect(after.statusVersion).toBe(0);
    expect(after.status).toBe("backlog");
  });

  it("a write with no actor is accepted and attributed to \"ui\"", async () => {
    const response = await post({ type: "comment", ref: "CON-1", body: "from the page" });
    expect(response.status).toBe(200);
    const comment = normalize(await response.json(), [home]) as Record<string, unknown>;
    expect(comment).toEqual({
      id: UUID,
      issueId: UUID,
      author: "ui",
      authorType: "user",
      body: "from the page",
      idempotencyKey: null,
      deletedAt: null,
      createdAt: ISO,
    });
  });
});
