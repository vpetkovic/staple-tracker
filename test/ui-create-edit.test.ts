/**
 * U5 (STA-17) — creating and editing a task from the page.
 *
 * The two new /api/action branches are thin by design: they shape a JSON body into a
 * store call and get out of the way. So what is worth testing is not "does it write" but
 * the three ways a thin branch is usually wrong:
 *
 *  1. it drops a field on the floor (parent, labels, blockedBy silently ignored);
 *  2. it sends `undefined` as a value, so a partial patch overwrites what it omitted;
 *  3. it catches a guard and re-words it, so the page shows a rule the store never
 *     stated.
 *
 * (3) is the one that matters most, and it is tested the same way U6 tests the board:
 * against a REAL store over REAL HTTP, then through the same `describeRefusal()` the
 * dialog and the inline editors render with. A hand-written envelope fixture would keep
 * passing after someone reworded `createIssue`'s guards, which is exactly the regression
 * that would make the create dialog lie.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { MAX_TREE_DEPTH } from "../src/core/types.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { describeRefusal, type Refusal } from "../src/ui/app/src/views/board/refusal.js";

interface Issue {
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  statusVersion: number;
  priority: string;
  parentId: string | null;
  depth: number;
  labels: string[];
  createdBy: string | null;
}

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
const refs: Record<string, string> = {};

/** Exactly the request lib/api.ts's `action()` makes: same-origin POST, JSON body. */
async function act(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-staple-token": token, origin },
    body: JSON.stringify({ actor: "ui", ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A refusal as the dialog would render it — the envelope, through the shared primitive. */
async function refuse(body: Record<string, unknown>): Promise<{ http: number; refusal: Refusal }> {
  const { status, body: envelope } = await act(body);
  return { http: status, refusal: describeRefusal(envelope) };
}

async function read(ref: string): Promise<Issue> {
  const res = await fetch(`${origin}/api/issue?ref=${ref}`, { headers: { "x-staple-token": token } });
  return ((await res.json()) as { issue: Issue }).issue;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-createedit-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "createedit" });

  refs.parent = ws.store.createIssue({ title: "A parent to hang things off" }).identifier;
  refs.blocker = ws.store.createIssue({ title: "Something in the way" }).identifier;
  refs.taken = ws.store.createIssue({ title: "Already open under this title" }).identifier;
  refs.editable = ws.store.createIssue({
    title: "Edit me",
    priority: "low",
    labels: ["keep-me"],
    description: "leave this alone",
  }).identifier;
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("create from the dialog", () => {
  it("carries every field the dialog offers through to the store", async () => {
    const { status, body } = await act({
      type: "create",
      title: "Everything at once",
      description: "with a body",
      priority: "critical",
      parent: refs.parent,
      labels: ["ui", "u5"],
      blockedBy: [refs.blocker],
    });
    expect(status).toBe(200);
    const issue = body as unknown as Issue;
    expect(issue.title).toBe("Everything at once");
    expect(issue.description).toBe("with a body");
    expect(issue.priority).toBe("critical");
    expect(issue.labels).toEqual(["ui", "u5"]);
    // The parent landed as a real edge, not just a field: depth proves the store
    // resolved the ref rather than storing the string.
    expect(issue.depth).toBe(1);

    // …and blockedBy became a dependency, which is only visible from the detail read.
    const detail = await fetch(`${origin}/api/issue?ref=${issue.identifier}`, {
      headers: { "x-staple-token": token },
    });
    const { blockedBy } = (await detail.json()) as { blockedBy: Array<{ identifier: string }> };
    expect(blockedBy.map((b) => b.identifier)).toEqual([refs.blocker]);
  });

  it("takes the store's defaults for everything the dialog left out", async () => {
    const { status, body } = await act({ type: "create", title: "Bare minimum" });
    expect(status).toBe(200);
    const issue = body as unknown as Issue;
    expect(issue.description).toBeNull();
    expect(issue.priority).toBe("medium");
    expect(issue.parentId).toBeNull();
    expect(issue.labels).toEqual([]);
    // Unassigned, so the store's own rule puts it in backlog rather than todo.
    expect(issue.status).toBe("backlog");
  });

  it('attributes the create to the actor, defaulting to "ui"', async () => {
    const named = await act({ type: "create", title: "Made by a named actor", actor: "kim" });
    expect((named.body as unknown as Issue).createdBy).toBe("kim");

    const res = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staple-token": token, origin },
      body: JSON.stringify({ type: "create", title: "Made by nobody in particular" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Issue).createdBy).toBe("ui");
  });

  it("appears in the list the board reads, not just in the create response", async () => {
    const { body } = await act({ type: "create", title: "Should show up on the board" });
    const identifier = (body as unknown as Issue).identifier;
    const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": token } });
    const rows = (await res.json()) as Array<{ issue: Issue }>;
    expect(rows.map((r) => r.issue.identifier)).toContain(identifier);
  });
});

describe("create refusals arrive in the store's own words", () => {
  it("says 'Title is required' — the form does not pre-empt it", async () => {
    const { http, refusal } = await refuse({ type: "create", title: "   " });
    expect(http).toBe(409);
    expect(refusal.code).toBe("validation");
    // Verbatim. A friendlier "please enter a title" here would be a second copy of a
    // rule that lives in store.createIssue().
    expect(refusal.message).toBe("Title is required");
    expect(refusal.fromServer).toBe(true);
  });

  it("names the issue it collided with, and offers the store's own way out", async () => {
    const { http, refusal } = await refuse({ type: "create", title: "Already open under this title" });
    expect(http).toBe(409);
    expect(refusal.code).toBe("duplicate");
    expect(refusal.message).toBe(
      `An open issue with this title already exists (${refs.taken}). ` +
        "Pass allowDuplicate to bypass, or use an idempotencyKey for safe retries.",
    );
    expect(refusal.retryable).toBe(false);
  });

  it("refuses a parent that does not exist as not_found, not as a validation error", async () => {
    const { http, refusal } = await refuse({ type: "create", title: "Orphan", parent: "NOPE-1" });
    expect(http).toBe(404);
    expect(refusal.code).toBe("not_found");
  });

  /**
   * Built for real rather than faked, because the interesting part is the OFF-BY-ONE:
   * the guard is `parent.depth + 1 > MAX_TREE_DEPTH`, so a parent at depth 99 must
   * still accept a child and a parent at depth 100 must not. A mocked guard would
   * pass whichever way that comparison was written.
   */
  it("surfaces the tree depth cap, with the cap named in the sentence", async () => {
    let parent = (await act({ type: "create", title: "depth 0" })).body as unknown as Issue;
    for (let depth = 1; depth <= MAX_TREE_DEPTH; depth += 1) {
      const { status, body } = await act({ type: "create", title: `depth ${depth}`, parent: parent.identifier });
      expect(status).toBe(200);
      parent = body as unknown as Issue;
    }
    // The deepest legal issue sits exactly at the cap.
    expect(parent.depth).toBe(MAX_TREE_DEPTH);

    const { http, refusal } = await refuse({
      type: "create",
      title: "one too deep",
      parent: parent.identifier,
    });
    expect(http).toBe(409);
    expect(refusal.code).toBe("validation");
    expect(refusal.message).toBe(`Tree depth cap (${MAX_TREE_DEPTH}) exceeded`);
  });
});

describe("inline property editing", () => {
  it("renames without touching anything else", async () => {
    const { status, body } = await act({ type: "update", ref: refs.editable, title: "Renamed inline" });
    expect(status).toBe(200);
    const issue = body as unknown as Issue;
    expect(issue.title).toBe("Renamed inline");
    expect(issue.priority).toBe("low");
    expect(issue.labels).toEqual(["keep-me"]);
    expect(issue.description).toBe("leave this alone");
  });

  it("sets priority without touching the title", async () => {
    const { body } = await act({ type: "update", ref: refs.editable, priority: "critical" });
    const issue = body as unknown as Issue;
    expect(issue.priority).toBe("critical");
    expect(issue.title).toBe("Renamed inline");
  });

  it("replaces the whole label set, so removing a chip actually removes it", async () => {
    await act({ type: "update", ref: refs.editable, labels: ["keep-me", "added"] });
    expect((await read(refs.editable!)).labels).toEqual(["keep-me", "added"]);

    await act({ type: "update", ref: refs.editable, labels: ["added"] });
    expect((await read(refs.editable!)).labels).toEqual(["added"]);

    // The empty set is reachable — a UI that could add but never clear would be a bug.
    await act({ type: "update", ref: refs.editable, labels: [] });
    expect((await read(refs.editable!)).labels).toEqual([]);
  });

  it("persists — the next read sees it, not just the write's own response", async () => {
    await act({ type: "update", ref: refs.editable, title: "Persisted", priority: "high" });
    const issue = await read(refs.editable!);
    expect(issue.title).toBe("Persisted");
    expect(issue.priority).toBe("high");
  });

  it("does not tick statusVersion — a property edit is not a status change", async () => {
    const before = await read(refs.editable!);
    await act({ type: "update", ref: refs.editable, title: "Still not a status change" });
    expect((await read(refs.editable!)).statusVersion).toBe(before.statusVersion);
  });

  /**
   * Status has its own action, and that branch is also the one that fans a resolved
   * issue out to the hub. Letting `update` set status would mean two paths that both
   * have to remember notifyHubResolvedSafe(), which is the kind of duplication that
   * stays correct for exactly as long as nobody edits it.
   */
  it("ignores a status smuggled into an update, rather than applying it", async () => {
    const before = await read(refs.editable!);
    const { status } = await act({ type: "update", ref: refs.editable, title: "No smuggling", status: "done" });
    expect(status).toBe(200);
    const after = await read(refs.editable!);
    expect(after.status).toBe(before.status);
    expect(after.statusVersion).toBe(before.statusVersion);
  });

  it("refuses an empty title in the store's words", async () => {
    const { http, refusal } = await refuse({ type: "update", ref: refs.editable, title: "  " });
    expect(http).toBe(409);
    expect(refusal.code).toBe("validation");
    // Note this is NOT create's "Title is required" — updateIssue words it differently,
    // and passing it through verbatim is what keeps that visible.
    expect(refusal.message).toBe("Title cannot be empty");
  });

  it("refuses an update that patches nothing, rather than writing an empty change", async () => {
    const { http, refusal } = await refuse({ type: "update", ref: refs.editable });
    expect(http).toBe(409);
    expect(refusal.code).toBe("validation");
    // STA-81 added estimateSeconds to the patchable set, so it joins the list of
    // things this refusal names. The refusal itself is the characterization: an
    // update that patches NOTHING is a mistake worth saying out loud, not a
    // silent no-op write that bumps updated_at.
    expect(refusal.message).toBe(
      "update requires one of title, priority, labels, estimateSeconds",
    );
  });

  it("refuses a bad priority with the store's list of the good ones", async () => {
    const { refusal } = await refuse({ type: "update", ref: refs.editable, priority: "urgent" });
    expect(refusal.code).toBe("validation");
    expect(refusal.message).toContain("urgent");
  });

  it("passes a missing ref through as not_found", async () => {
    const { http, refusal } = await refuse({ type: "update", ref: "NOPE-1", title: "x" });
    expect(http).toBe(404);
    expect(refusal.code).toBe("not_found");
  });
});

describe("the write gate still covers the new branches", () => {
  it("rejects a create with no token", async () => {
    const res = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "create", title: "Should never exist" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a cross-origin create even with a valid token", async () => {
    const res = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-staple-token": token,
        origin: "http://evil.example",
      },
      body: JSON.stringify({ type: "create", title: "Should never exist either" }),
    });
    expect(res.status).toBe(403);
  });

  it("wrote neither of the tasks those two denials tried to create", async () => {
    const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": token } });
    const titles = ((await res.json()) as Array<{ issue: Issue }>).map((r) => r.issue.title);
    expect(titles).not.toContain("Should never exist");
    expect(titles).not.toContain("Should never exist either");
  });
});
