/**
 * O7b (STA-141) — /api/settings, the one route that reads AND writes.
 *
 * Against a REAL store over REAL HTTP, the pattern every other `ui-*.test.ts` follows,
 * because what is worth testing here is not "does it write" — `applyStatusOps` is O7a's
 * and has 34 tests of its own — but the four ways a thin HTTP route over it goes wrong:
 *
 *  1. THE METHOD PIN. This route made `expected` a list where it used to be a string, and
 *     a list is exactly how you accidentally stop pinning anything. So: GET works, POST
 *     works, PUT and DELETE are 405, and — the one that matters — every OTHER route still
 *     refuses the method it always refused.
 *  2. THE ORIGIN GATE moved from `expected === "POST"` to `req.method === "POST"`. A
 *     cross-origin POST to this route must still be 403, and a cross-origin GET must
 *     still be allowed, because a GET was never Origin-checked and quietly starting to
 *     check it would break the page in a browser that omits the header.
 *  3. THE ENVELOPE. GET and POST answer the SAME shape — the client's whole
 *     re-derive-without-merging story rests on that, so it is asserted rather than
 *     assumed. Including the derived orders, which the browser must NOT recompute.
 *  4. THE REFUSALS ARE THE STORE'S. Read back through `describeRefusal`, the same
 *     primitive the dialog renders with, so a reworded guard shows up here rather than in
 *     a screenshot three weeks later.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { STATUS_CATEGORIES } from "../src/core/types.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { describeRefusal, type Refusal } from "../src/ui/app/src/lib/refusal.js";

interface SettingsEnvelope {
  workspace: string;
  statuses: { id: string; label: string; category: string; sortOrder: number; isBuiltin: boolean }[];
  kinds: { id: string; label: string; sortOrder: number; isBuiltin: boolean }[];
  groupOrder: string[];
  openOrder: string[];
  pickupOrder: string[];
  categories: string[];
  requiredCategories: string[];
  usage: { statuses: Record<string, number>; kinds: Record<string, number> };
  registry: {
    categories: { id: string; scope: string; editor: string }[];
    definitions: { key: string; scope: string; category: string; default: unknown }[];
  };
  values: Record<string, { key: string; scope: string; value?: unknown; source: string; version: number }>;
  unknownKeys: string[];
  global: { path: string; present: boolean; values: Record<string, { value?: unknown; source: string }> };
}

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;

async function read(): Promise<SettingsEnvelope> {
  const res = await fetch(`${origin}/api/settings`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsEnvelope;
}

/** Exactly the request lib/api.ts's `putSettings()` makes: same-origin POST, JSON body. */
async function write(
  target: "statuses" | "kinds" | "settings",
  ops: unknown[],
  over: { origin?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-staple-token": token,
      origin: over.origin ?? origin,
    },
    body: JSON.stringify({ actor: "ui", target, ops }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A refusal as the dialog would render it — the envelope, through the shared primitive. */
async function refuse(target: "statuses" | "kinds" | "settings", ops: unknown[]): Promise<{ http: number; refusal: Refusal }> {
  const { status, body } = await write(target, ops);
  return { http: status, refusal: describeRefusal(body) };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uisettings-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uisettings" });

  // Two issues in `todo`, so a removal of it has something to migrate and the usage
  // count is a number this suite can name rather than a shape it has to trust.
  ws.store.createIssue({ title: "First" });
  ws.store.createIssue({ title: "Second" });
  ws.store.updateIssue("2", { status: "todo" }, "seed");
  ws.store.updateIssue("1", { status: "todo" }, "seed");
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

describe("GET /api/settings", () => {
  it("serves the seeded vocabulary in configured order", async () => {
    const settings = await read();
    expect(settings.workspace).toBe("uisettings");
    expect(settings.statuses.map((s) => s.id)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "awaiting_approval",
      "done",
      "blocked",
      "cancelled",
    ]);
    expect(settings.kinds.map((k) => k.id)).toEqual(["epic", "task", "bug", "chore", "spike"]);
    expect(settings.statuses.every((s) => s.isBuiltin)).toBe(true);
  });

  /**
   * THE DERIVED ORDERS. The client must not recompute the category tiering, so the server
   * has to send it — and for a default workspace it has to equal what the UI mirror's
   * frozen `OPEN_STATUS_ORDER` + `RESOLVED_STATUSES` always said, or every existing group
   * header silently reorders the day this lands.
   */
  it("sends the list rank, and it matches what the UI has always shown", async () => {
    const settings = await read();
    expect(settings.groupOrder).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
      "done",
      "cancelled",
    ]);
    expect(settings.openOrder).toEqual([
      "in_progress",
      "in_review",
      "awaiting_approval",
      "blocked",
      "todo",
      "backlog",
    ]);
    // `awaiting_approval` is in both lists above and in NEITHER of the pickup
    // tiers: open work that no agent may pick up is exactly what a gate is.
    expect(settings.pickupOrder).toEqual(["in_progress", "in_review", "todo", "backlog"]);
    // The configured order and the list rank are DIFFERENT lists, which is the whole
    // reason both are on the wire.
    expect(settings.statuses.map((s) => s.id)).not.toEqual(settings.groupOrder);
  });

  it("names the closed category set, so the client keeps no copy of it", async () => {
    const settings = await read();
    expect(settings.categories).toEqual([...STATUS_CATEGORIES]);
    expect(settings.requiredCategories).toEqual([
      "unstarted",
      "ready",
      "active",
      "blocked",
      "done",
      "cancelled",
    ]);
  });

  /**
   * `usage` is what makes the migrate-to picker REQUIRED rather than merely offered. Every
   * configured id is present, zeros included, so the client can tell "nothing uses this"
   * from "the server did not say".
   */
  it("counts what still carries each id, with a zero for the untouched ones", async () => {
    const settings = await read();
    expect(settings.usage.statuses.todo).toBe(2);
    expect(settings.usage.statuses.done).toBe(0);
    expect(Object.keys(settings.usage.statuses).sort()).toEqual(
      settings.statuses.map((s) => s.id).sort(),
    );
    // Both fixture issues were created without a kind, so they carry the default `task`;
    // every other seeded kind counts zero and none is missing.
    expect(Object.keys(settings.usage.kinds).sort()).toEqual(settings.kinds.map((k) => k.id).sort());
    expect(settings.usage.kinds.task).toBe(2);
    expect(Object.values(settings.usage.kinds).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("POST /api/settings", () => {
  it("adds, and answers with the same envelope a GET would", async () => {
    const { status, body } = await write("statuses", [
      { op: "add", id: "pairing", label: "Pairing", category: "active", after: "in_progress" },
    ]);
    expect(status).toBe(200);
    const posted = body as unknown as SettingsEnvelope;
    // Same KEYS as the read, which is the contract the client re-derives on.
    expect(Object.keys(posted).sort()).toEqual(Object.keys(await read()).sort());
    expect(posted.statuses.map((s) => s.id)).toContain("pairing");
    expect(posted.statuses.find((s) => s.id === "pairing")?.isBuiltin).toBe(false);
    // A custom `active` status joins the active tier ahead of everything below it.
    expect(posted.groupOrder.slice(0, 2)).toEqual(["in_progress", "pairing"]);
  });

  it("renames, and the label changes without the id moving", async () => {
    const { body } = await write("statuses", [{ op: "rename", id: "todo", label: "Queued" }]);
    const posted = body as unknown as SettingsEnvelope;
    expect(posted.statuses.find((s) => s.id === "todo")?.label).toBe("Queued");
    expect(posted.statuses.find((s) => s.id === "todo")?.id).toBe("todo");
  });

  /**
   * A reorder is one op carrying EVERY id. What is asserted is that it moves the LIST
   * RANK too — reordering within a category tier is the thing that reorders group headers,
   * and it would be easy to have a route that stored the order and served a stale rank.
   */
  it("reorders, and the served list rank moves with it", async () => {
    const before = await read();
    const ids = before.statuses.map((s) => s.id);
    const swapped = [
      ...ids.filter((id) => id !== "pairing" && id !== "in_progress"),
      "pairing",
      "in_progress",
    ];
    const { status, body } = await write("statuses", [{ op: "reorder", ids: swapped }]);
    expect(status).toBe(200);
    const posted = body as unknown as SettingsEnvelope;
    expect(posted.statuses.map((s) => s.id)).toEqual(swapped);
    expect(posted.groupOrder.slice(0, 2)).toEqual(["pairing", "in_progress"]);
    // Put it back so the removal tests below start from a known list.
    await write("statuses", [{ op: "reorder", ids }]);
  });

  it("recategorizes, and the status changes tier", async () => {
    const { body } = await write("statuses", [{ op: "recategorize", id: "pairing", category: "review" }]);
    const posted = body as unknown as SettingsEnvelope;
    expect(posted.statuses.find((s) => s.id === "pairing")?.category).toBe("review");
    expect(posted.groupOrder.indexOf("pairing")).toBeGreaterThan(posted.groupOrder.indexOf("in_progress"));
  });

  it("applies an ordered batch as one transaction", async () => {
    const { status, body } = await write("kinds", [
      { op: "add", id: "research" },
      { op: "reorder", ids: ["research", "epic", "task", "bug", "chore", "spike"] },
    ]);
    expect(status).toBe(200);
    const posted = body as unknown as SettingsEnvelope;
    expect(posted.kinds.map((k) => k.id)).toEqual(["research", "epic", "task", "bug", "chore", "spike"]);
    // The label was derived by the STORE, not by the caller.
    expect(posted.kinds[0]!.label).toBe("Research");
  });

  it("removes a kind nothing carries", async () => {
    const { status, body } = await write("kinds", [{ op: "remove", id: "research" }]);
    expect(status).toBe(200);
    expect((body as unknown as SettingsEnvelope).kinds.map((k) => k.id)).not.toContain("research");
  });
});

describe("removal, migrate-to, and the store's own refusals", () => {
  /**
   * `todo` is the workspace's only `ready` status, and `ready` is a category staple
   * WRITES into — `release` puts an issue there — so removing it is refused outright, with
   * or without a migrate target. Giving the category a second member first is what turns
   * the next two tests into tests about the migrate-to contract instead of tests that keep
   * tripping over the category guard.
   */
  it("gives `ready` a second member, so the category guard stops being the answer", async () => {
    const { status, body } = await write("statuses", [
      { op: "add", id: "staging", label: "Staging", category: "ready", after: "todo" },
    ]);
    expect(status).toBe(200);
    expect((body as unknown as SettingsEnvelope).statuses.map((s) => s.id)).toContain("staging");
  });

  /**
   * The refusal the migrate-to picker exists to prevent, in the store's own words. This is
   * what the dialog would render if the usage count it was holding had gone stale.
   */
  it("refuses to remove a referenced status with no target", async () => {
    expect((await read()).usage.statuses.todo).toBe(2);
    const { http, refusal } = await refuse("statuses", [{ op: "remove", id: "todo" }]);
    expect(http).toBe(409);
    expect(refusal.message).toMatch(/migrate/i);
    expect(refusal.message).toContain("todo");
  });

  /**
   * The end-to-end shape of the ticket's hardest interaction: two issues carry `todo`, the
   * removal names a target, and the rows move as a VOCABULARY rename rather than as two
   * status transitions — so the count lands on the target whole, and the removed id is
   * gone from the configured list AND from both derived orders at once.
   */
  it("removes a referenced status and moves its issues onto the target", async () => {
    const { status, body } = await write("statuses", [
      { op: "remove", id: "todo", migrateTo: "staging" },
    ]);
    expect(status).toBe(200);
    const posted = body as unknown as SettingsEnvelope;
    expect(posted.statuses.map((s) => s.id)).not.toContain("todo");
    expect(posted.groupOrder).not.toContain("todo");
    expect(posted.openOrder).not.toContain("todo");
    expect(posted.pickupOrder).not.toContain("todo");
    expect(posted.usage.statuses.staging).toBe(2);
    expect(posted.usage.statuses.todo).toBeUndefined();
  });

  /**
   * `staging` is now the only `ready` status, so the guard that stood in the way at the
   * top of this block is back — and it fires even though a perfectly good target was
   * named, because it is not about the rows, it is about the category being writable.
   */
  it("refuses to empty a category staple writes into, target or no target", async () => {
    const { http, refusal } = await refuse("statuses", [
      { op: "remove", id: "staging", migrateTo: "backlog" },
    ]);
    expect(http).toBe(409);
    expect(refusal.message).toMatch(/ready/);
  });

  it("refuses a duplicate id", async () => {
    const { http, refusal } = await refuse("statuses", [
      { op: "add", id: "blocked", category: "blocked" },
    ]);
    expect(http).toBe(409);
    expect(refusal.message).toContain("blocked");
  });

  it("refuses an id outside the character set", async () => {
    const { http, refusal } = await refuse("statuses", [{ op: "add", id: "Not Valid", category: "ready" }]);
    expect(http).toBe(409);
    expect(refusal.message.length).toBeGreaterThan(0);
  });

  /**
   * The kinds half of "the refusals are the store's": `removeKind`'s milestone guard
   * reaches the dialog through the same envelope, so a milestone that still owns dates
   * stops the removal here exactly as it does in the store.
   */
  it("refuses to remove the milestone kind while a milestone still owns dates", async () => {
    expect((await write("kinds", [{ op: "add", id: "milestone", label: "Milestone" }])).status).toBe(200);
    const created = await fetch(`${origin}/api/milestone/create`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staple-token": token, origin },
      body: JSON.stringify({ actor: "ui", title: "October cut", targetDate: "2026-10-31" }),
    });
    expect(created.status).toBe(200);

    const { http, refusal } = await refuse("kinds", [{ op: "remove", id: "milestone", migrateTo: "task" }]);
    expect(http).toBe(409);
    expect(refusal.message).toContain("Cannot remove the milestone kind");
    expect((await read()).kinds.map((k) => k.id)).toContain("milestone");
  });

  it("refuses a body with no target, or with no ops", async () => {
    expect((await write("statuses", [])).status).toBe(409);
    const res = await fetch(`${origin}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staple-token": token, origin },
      body: JSON.stringify({ ops: [{ op: "rename", id: "staging", label: "x" }] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain("target");
  });
});

describe("the transport gate the route had to widen", () => {
  it("accepts GET and POST, and nothing else", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${origin}/api/settings`, {
        method,
        headers: { "x-staple-token": token, origin },
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("method_not_allowed");
      expect(body.message).toContain("GET, POST");
      expect(res.headers.get("allow")).toBe("GET, POST");
    }
  });

  /**
   * THE REGRESSION THIS SUITE EXISTS FOR. `expected` became a list, and a list is how you
   * accidentally stop pinning anything — so the two routes on either side of the change
   * are asserted to be exactly as strict as they were.
   */
  it("leaves every other route's method pin exactly as it was", async () => {
    const readRoute = await fetch(`${origin}/api/bootstrap`, {
      method: "POST",
      headers: { "x-staple-token": token, origin },
    });
    expect(readRoute.status).toBe(405);
    expect(readRoute.headers.get("allow")).toBe("GET");

    const writeRoute = await fetch(`${origin}/api/action`, { headers: { "x-staple-token": token } });
    expect(writeRoute.status).toBe(405);
    expect(writeRoute.headers.get("allow")).toBe("POST");
  });

  it("refuses a cross-origin POST", async () => {
    const { status, body } = await write("statuses", [{ op: "rename", id: "blocked", label: "Nope" }], {
      origin: "http://evil.example",
    });
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden");
    // And it did not write.
    expect((await read()).statuses.find((s) => s.id === "blocked")?.label).toBe("Blocked");
  });

  /**
   * A GET was never Origin-checked and must not start being one: the gate moved from the
   * pinned method to the ACTUAL method, and getting that backwards would break the page in
   * any browser that omits the header on a same-origin GET.
   */
  it("does not Origin-check a GET", async () => {
    const res = await fetch(`${origin}/api/settings`, {
      headers: { "x-staple-token": token, origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses both methods without a token", async () => {
    expect((await fetch(`${origin}/api/settings`)).status).toBe(401);
    const posted = await fetch(`${origin}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ target: "kinds", ops: [{ op: "rename", id: "task", label: "x" }] }),
    });
    expect(posted.status).toBe(401);
  });
});

/**
 * R6a (STA-176) — the registry and both scopes' values ride the same envelope.
 *
 * The page enumerates categories and definitions from `registry`, reads a workspace
 * value with its provenance from `values`, and sees the machine's config.json under
 * `global` as a DIFFERENT store — served read-only here, written by `staple config set`.
 * `target: "settings"` is the write half for workspace values and answers the identical
 * envelope, so the editor re-derives rather than merges, exactly as the vocabulary does.
 */
describe("registered settings on /api/settings", () => {
  it("serves the registry: every category with its scope and editor, every definition typed", async () => {
    const settings = await read();
    expect(settings.registry.categories.map((c) => `${c.id}:${c.scope}:${c.editor}`)).toEqual([
      "statuses:workspace:statuses",
      "kinds:workspace:kinds",
      // R6d (STA-179): the Workflow category reaches the page from the registry alone.
      "queue:workspace:fields",
      "machine:global:fields",
    ]);
    expect(settings.registry.definitions.map((d) => `${d.key}:${d.scope}`)).toEqual([
      "kinds.default:workspace",
      "machine.browser:global",
      "queue.policy:workspace",
      "kinds.appearance:workspace",
      "machine.port:global",
      "machine.setupComplete:global",
    ]);
  });

  it("serves the workspace values with source default until one is stored, and the globals beside them", async () => {
    const settings = await read();
    expect(settings.values).toEqual({
      "kinds.default": { key: "kinds.default", scope: "workspace", value: "task", source: "default", version: 1 },
      "kinds.appearance": { key: "kinds.appearance", scope: "workspace", value: {}, source: "default", version: 1 },
      "queue.policy": { key: "queue.policy", scope: "workspace", value: "advisory", source: "default", version: 1 },
    });
    expect(settings.unknownKeys).toEqual([]);
    expect(settings.global.path).toBe(join(home, "config.json"));
    expect(settings.global.present).toBe(false);
    expect(settings.global.values["machine.port"]).toEqual({
      key: "machine.port",
      scope: "global",
      value: 4400,
      source: "default",
      version: 1,
    });
  });

  it("writes a workspace value through target settings and answers the same envelope", async () => {
    const { status, body } = await write("settings", [{ op: "set", key: "kinds.default", value: "bug" }]);
    expect(status).toBe(200);
    const posted = body as unknown as SettingsEnvelope;
    expect(Object.keys(posted).sort()).toEqual(Object.keys(await read()).sort());
    expect(posted.values["kinds.default"]).toEqual({
      key: "kinds.default",
      scope: "workspace",
      value: "bug",
      source: "workspace",
      version: 1,
    });
    // And it is what the workspace now does, not just what it says.
    const detail = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staple-token": token, origin },
      body: JSON.stringify({ type: "create", title: "Kindless", actor: "ui" }),
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { kind: string }).kind).toBe("bug");
    await write("settings", [{ op: "reset", key: "kinds.default" }]);
    expect((await read()).values["kinds.default"]!.source).toBe("default");
  });

  it("refuses with the registry's and the store's own sentences", async () => {
    const shape = await refuse("settings", [{ op: "set", key: "kinds.default", value: 12 }]);
    expect(shape.http).toBe(409);
    expect(shape.refusal.message).toMatch(/"kinds\.default" must be a kind id/);
    // `milestone` is a seeded kind once the milestone lane lands, so refuse on a kind no workspace ships.
    const unknown = await refuse("settings", [{ op: "set", key: "kinds.default", value: "unicorn" }]);
    expect(unknown.refusal.message).toMatch(/Unknown kind "unicorn"/);
    const global = await refuse("settings", [{ op: "set", key: "machine.port", value: 4500 }]);
    expect(global.refusal.message).toMatch(/global setting, not a workspace one/);
    expect((await read()).global.values["machine.port"]!.value).toBe(4400);
  });

  it("names the third target in the refusal for a target it does not know", async () => {
    const { status, body } = await write("bogus" as never, [{ op: "set" }]);
    expect(status).toBe(409);
    expect(body.message).toBe('settings requires target "statuses", "kinds" or "settings"');
  });
});
