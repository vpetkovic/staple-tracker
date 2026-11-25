/**
 * GET /api/search: the toolbar's text query, answered by the same store match `staple ls -q`
 * uses, so a word written only in a plan, worklog, comment or criterion finds the ticket.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
const id: Record<string, string> = {};

async function search(q: string): Promise<{ q: string; ids: string[] }> {
  const res = await fetch(`${origin}/api/search?q=${encodeURIComponent(q)}`, { headers: { "x-staple-token": token } });
  expect(res.status).toBe(200);
  return (await res.json()) as { q: string; ids: string[] };
}

function seed(store: WorkspaceStore): void {
  id.title = store.createIssue({ title: "Rotate the zephyrine keys" }).id;
  id.criterion = store.createIssue({ title: "Criterion holder", acceptanceCriteria: ["The quokkas are counted"] }).id;
  const commented = store.createIssue({ title: "Comment holder" });
  store.addComment(commented.identifier, "tried the marmoset approach");
  id.comment = commented.id;
  const planned = store.createIssue({ title: "Plan holder" });
  store.putDocument(planned.identifier, "plan", "1. migrate the axolotl table");
  id.plan = planned.id;
  const logged = store.createIssue({ title: "Worklog holder", status: "done" });
  store.putDocument(logged.identifier, "worklog", "## Done\nbisected to the pangolin commit");
  id.worklog = logged.id;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uisearch-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uisearch" });
  seed(ws.store);
  const dbPath = ws.dbPath;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui.close();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/search", () => {
  it("is gated by the token like every other read", async () => {
    expect((await fetch(`${origin}/api/search?q=axolotl`)).status).toBe(401);
  });

  it.each([
    ["zephyrine", "title"],
    ["quokkas", "criterion"],
    ["marmoset", "comment"],
    ["axolotl", "plan"],
    ["pangolin", "worklog"],
  ])("finds %s, written only in the %s", async (word, where) => {
    expect(await search(word)).toEqual({ q: word, ids: [id[where]] });
  });

  it("echoes the trimmed text it answered and finds nothing for an empty one", async () => {
    expect(await search("  axolotl  ")).toEqual({ q: "axolotl", ids: [id.plan] });
    expect(await search("   ")).toEqual({ q: "", ids: [] });
  });
});
