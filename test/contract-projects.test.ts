/**
 * Projects over HTTP — the `/api/projects` read and the `/api/project/*` writes,
 * against a real store, in the shape the milestone routes set.
 *
 * `store-projects.test.ts` pins what the store does. This suite pins the wire:
 *
 *   1. THE WRITES ARE GATED LIKE WRITES. Every `/api/project/*` route is POST-only
 *      and Origin-checked, and the plural read is GET-only — a new POST family
 *      that fell through the method gate would be a cross-origin-writable
 *      endpoint on a loopback server that holds the whole tracker.
 *   2. REFUSALS ARRIVE AS REFUSALS: the store's own `code` and sentence, with the
 *      status the error contract maps that code to.
 *   3. THE ROW SHAPE IS ONE SHAPE. The read answers `{ workspace, project }` rows;
 *      in hub mode with no `ws` it answers for every workspace at once, so two
 *      projects with one name in two workspaces are tellable apart.
 *   4. THE ISSUE CARRIES THE POINTER. `/api/issues` rows and `/api/issue` answer
 *      `issue.projectId`, and `assign` answers the refreshed detail payload.
 *
 * CLI and MCP exposure of projects is deliberately absent — `projectId` rides on
 * the issue shape those surfaces already print, and nothing more.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { httpStatusFor } from "./fixtures/error-contract.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let alphaDb: string;
let betaDb: string;

type Body = Record<string, unknown>;

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
  return { status: res.status, body: await res.json() };
}

async function post(
  path: string,
  body: Body,
  init: { origin?: string | null; method?: string } = {},
): Promise<{ status: number; body: Body }> {
  const headers: Record<string, string> = { "x-staple-token": token, "content-type": "application/json" };
  const sendOrigin = init.origin === undefined ? origin : init.origin;
  if (sendOrigin) headers.origin = sendOrigin;
  const res = await fetch(`${origin}${path}`, { method: init.method ?? "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Body };
}

/** The project rows the read answers, as `workspace/slug` for terse assertions. */
async function listed(query = ""): Promise<string[]> {
  const { status, body } = await get(`/api/projects${query}`);
  expect(status).toBe(200);
  return (body as Array<{ workspace: string; project: { slug: string } }>).map(
    (row) => `${row.workspace}/${row.project.slug}`,
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-projects-http-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const alpha = initWorkspace({ global: true, slug: "alpha" });
  alphaDb = alpha.dbPath;
  alpha.store.createIssue({ title: "alpha one" });
  alpha.store.createIssue({ title: "alpha two" });
  alpha.store.db.close();
  const beta = initWorkspace({ global: true, slug: "beta" });
  betaDb = beta.dbPath;
  beta.store.createIssue({ title: "beta one" });
  beta.store.db.close();

  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the method and origin gate", () => {
  it("answers the plural read to GET only", async () => {
    expect((await get("/api/projects?ws=alpha")).status).toBe(200);
    const { status, body } = await post("/api/projects", { ws: "alpha", name: "x" });
    expect(status).toBe(405);
    expect(body.code).toBe("method_not_allowed");
  });

  it("answers every write to POST only", async () => {
    for (const route of ["create", "update", "delete", "assign"]) {
      const res = await fetch(`${origin}/api/project/${route}?ws=alpha`, { headers: { "x-staple-token": token } });
      expect(res.status, route).toBe(405);
      expect(((await res.json()) as Body).code).toBe("method_not_allowed");
    }
  });

  it("refuses a cross-origin write and writes nothing", async () => {
    const { status, body } = await post(
      "/api/project/create",
      { ws: "alpha", name: "Injected" },
      { origin: "http://evil.example" },
    );
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden");
    expect(await listed("?ws=alpha")).toEqual([]);
  });

  it("accepts a write with no Origin at all, as curl sends it", async () => {
    const { status, body } = await post("/api/project/create", { ws: "alpha", name: "Scratch" }, { origin: null });
    expect(status).toBe(200);
    expect((body.project as Body).slug).toBe("scratch");
    expect((await post("/api/project/delete", { ws: "alpha", ref: "scratch" })).status).toBe(200);
  });
});

describe("the row shape", () => {
  it("creates a project and answers it as a workspace-labelled row", async () => {
    const { status, body } = await post("/api/project/create", {
      ws: "alpha",
      name: "Docs",
      kind: "managed",
      sourceKind: "github",
      source: "https://github.com/vpetkovic/staple-tracker",
    });
    expect(status).toBe(200);
    expect(body.workspace).toBe("alpha");
    expect(body.project).toMatchObject({
      slug: "docs",
      name: "Docs",
      kind: "managed",
      sourceKind: "github",
      source: "https://github.com/vpetkovic/staple-tracker",
    });
    expect(Object.keys(body.project as Body).sort()).toEqual([
      "createdAt",
      "id",
      "kind",
      "name",
      "slug",
      "source",
      "sourceKind",
      "updatedAt",
    ]);
  });

  it("lists one workspace when asked, and every workspace when not", async () => {
    expect((await post("/api/project/create", { ws: "beta", name: "Docs" })).status).toBe(200);
    expect(await listed("?ws=alpha")).toEqual(["alpha/docs"]);
    expect(await listed("?ws=beta")).toEqual(["beta/docs"]);
    // Two projects called Docs, told apart by the workspace on the row.
    expect((await listed()).sort()).toEqual(["alpha/docs", "beta/docs"]);
  });

  it("updates in place and keeps the slug", async () => {
    const { status, body } = await post("/api/project/update", { ws: "alpha", ref: "docs", name: "Documentation" });
    expect(status).toBe(200);
    expect(body.project).toMatchObject({ slug: "docs", name: "Documentation" });
    expect(await listed("?ws=alpha")).toEqual(["alpha/docs"]);
  });
});

describe("the issue carries the pointer", () => {
  it("answers projectId null on every row until something is assigned", async () => {
    const { body } = await get("/api/issues?ws=alpha");
    const rows = body as Array<{ issue: { identifier: string; projectId: string | null } }>;
    expect(rows.map((row) => row.issue.projectId)).toEqual([null, null]);
  });

  it("assigns through the route and answers the refreshed detail, then shows on the list", async () => {
    const docs = ((await get("/api/projects?ws=alpha")).body as Array<{ project: { id: string } }>)[0]!.project;
    const { status, body } = await post("/api/project/assign", { ws: "alpha", ref: "ALP-1", project: "docs" });
    expect(status).toBe(200);
    expect(body.workspace).toBe("alpha");
    expect((body.issue as Body).identifier).toBe("ALP-1");
    expect((body.issue as Body).projectId).toBe(docs.id);

    const list = (await get("/api/issues?ws=alpha")).body as Array<{ issue: { identifier: string; projectId: string | null } }>;
    expect(list.map((row) => [row.issue.identifier, row.issue.projectId])).toEqual([
      ["ALP-1", docs.id],
      ["ALP-2", null],
    ]);
    const detail = (await get("/api/issue?ws=alpha&ref=ALP-1")).body as { issue: { projectId: string | null } };
    expect(detail.issue.projectId).toBe(docs.id);

    // And `project: null` takes it out again.
    const cleared = await post("/api/project/assign", { ws: "alpha", ref: "ALP-1", project: null });
    expect((cleared.body.issue as Body).projectId).toBeNull();
  });

  it("files a task under a project at create time through the action route", async () => {
    const { status, body } = await post("/api/action", {
      ws: "alpha",
      type: "create",
      title: "Filed on arrival",
      project: "docs",
    });
    expect(status).toBe(200);
    const docs = ((await get("/api/projects?ws=alpha")).body as Array<{ project: { id: string } }>)[0]!.project;
    expect(body.projectId).toBe(docs.id);
    expect(body.identifier).toBe("ALP-3");
  });

  it("lets every issue go when the project is deleted", async () => {
    expect((await post("/api/project/assign", { ws: "alpha", ref: "ALP-2", project: "docs" })).status).toBe(200);
    const { status, body } = await post("/api/project/delete", { ws: "alpha", ref: "docs" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ workspace: "alpha", unassigned: 2, project: { slug: "docs" } });
    const list = (await get("/api/issues?ws=alpha")).body as Array<{ issue: { projectId: string | null } }>;
    expect(list.map((row) => row.issue.projectId)).toEqual([null, null, null]);
    expect(await listed("?ws=alpha")).toEqual([]);
  });
});

describe("refusals arrive as refusals", () => {
  it("validation, in the store's words, with the contract's status", async () => {
    const cases: Array<[string, Body, string]> = [
      ["/api/project/create", { ws: "alpha", name: "  " }, "Project name is required"],
      ["/api/project/create", { ws: "alpha", name: "X", kind: "managed" }, "source kind"],
      [
        "/api/project/create",
        { ws: "alpha", name: "X", kind: "managed", sourceKind: "github", source: "gitlab.com/x/y" },
        "https://github.com/owner/repo",
      ],
      ["/api/project/create", { ws: "alpha", name: "X", source: "/tmp" }, "unmanaged project has no source"],
    ];
    for (const [route, body, sentence] of cases) {
      const { status, body: envelope } = await post(route, body);
      expect(status, sentence).toBe(httpStatusFor("validation"));
      expect(envelope.code).toBe("validation");
      expect(envelope.retryable).toBe(false);
      expect(String(envelope.message)).toContain(sentence);
      expect(envelope.error).toBe(envelope.message);
    }
    expect(await listed("?ws=alpha")).toEqual([]);
  });

  it("not_found for an unknown project on every write that names one, and for an unknown issue", async () => {
    for (const [route, body] of [
      ["/api/project/update", { ws: "alpha", ref: "nowhere", name: "X" }],
      ["/api/project/delete", { ws: "alpha", ref: "nowhere" }],
      ["/api/project/assign", { ws: "alpha", ref: "ALP-1", project: "nowhere" }],
      ["/api/project/assign", { ws: "alpha", ref: "ALP-99", project: null }],
      ["/api/action", { ws: "alpha", type: "create", title: "Lost", project: "nowhere" }],
    ] as Array<[string, Body]>) {
      const { status, body: envelope } = await post(route, body);
      expect(status, route).toBe(httpStatusFor("not_found"));
      expect(envelope.code).toBe("not_found");
    }
    // The refused create spent no issue number.
    const list = (await get("/api/issues?ws=alpha")).body as Array<{ issue: { identifier: string } }>;
    expect(list.map((row) => row.issue.identifier)).toEqual(["ALP-1", "ALP-2", "ALP-3"]);
  });

  it("a missing or malformed ref, or an unsaid project on assign, is a validation refusal and never a 500", async () => {
    const cases: Array<[string, Body, string]> = [
      ["/api/project/update", { ws: "alpha", name: "X" }, "ref"],
      ["/api/project/update", { ws: "alpha", ref: 42, name: "X" }, "ref"],
      ["/api/project/delete", { ws: "alpha" }, "ref"],
      ["/api/project/delete", { ws: "alpha", ref: "  " }, "ref"],
      ["/api/project/assign", { ws: "alpha", project: null }, "ref"],
      ["/api/project/assign", { ws: "alpha", ref: "ALP-1" }, "project"],
      ["/api/project/assign", { ws: "alpha", ref: "ALP-1", project: 7 }, "project"],
    ];
    for (const [route, body, field] of cases) {
      const { status, body: envelope } = await post(route, body);
      expect(status, `${route} ${JSON.stringify(body)}`).toBe(httpStatusFor("validation"));
      expect(envelope.code).toBe("validation");
      expect((envelope.detail as Body | undefined)?.field).toBe(field);
      expect(envelope.error).toBe(envelope.message);
    }
    // Nothing moved: no issue was unfiled by a body that forgot to say which project.
    const list = (await get("/api/issues?ws=alpha")).body as Array<{ issue: { projectId: string | null } }>;
    expect(list.every((row) => row.issue.projectId === null)).toBe(true);
  });

  it("an unknown verb under the family is a plain 404", async () => {
    expect((await post("/api/project/explode", { ws: "alpha" })).status).toBe(404);
  });
});

describe("the database", () => {
  it("holds what the routes wrote, and nothing the refusals asked for", () => {
    const alpha = openWorkspace(alphaDb);
    try {
      expect(alpha.store.projects().list()).toEqual([]);
      expect(alpha.store.listIssues().map((issue) => issue.projectId)).toEqual([null, null, null]);
    } finally {
      alpha.store.db.close();
    }
    const beta = openWorkspace(betaDb);
    try {
      expect(beta.store.projects().list().map((project) => project.slug)).toEqual(["docs"]);
    } finally {
      beta.store.db.close();
    }
  });
});
