/**
 * The change fingerprint also moves on a clock while work is started.
 *
 * The page refetches only when `/api/poll` answers a different fingerprint, and writes are
 * what move it. The claim's idle reading and time in status are computed at response time,
 * so a ticket an agent works for hours without a write would show hours-old times. While a
 * workspace has an active, review or gated ticket, its fingerprint carries a 30-second time
 * bucket. With nothing started it carries none, so an idle tracker is not refetched.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "../src/core/store.js";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let dbPath: string;
let ref: string;
let epic: string;

/** A bucket boundary, so +29s stays in it and +30s crosses it. */
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 30_000);

async function fingerprintAt(ms: number): Promise<string> {
  vi.spyOn(Date, "now").mockReturnValue(ms);
  const res = await fetch(`${origin}/api/poll`, { headers: { "x-staple-token": token } });
  return ((await res.json()) as { fingerprint: string }).fingerprint;
}

function withStore(write: (store: WorkspaceStore) => void): void {
  const ws = openWorkspace(dbPath);
  try {
    write(ws.store);
  } finally {
    ws.store.db.close();
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ui-poll-clock-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "clock" });
  dbPath = ws.dbPath;
  ref = ws.store.createIssue({ title: "long run", status: "todo" }).identifier;
  epic = ws.store.createIssue({ title: "gated epic" }).identifier;
  ws.store.createIssue({ title: "gated child", parent: epic, status: "todo" });
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the change fingerprint's clock", () => {
  it("stays still with nothing started, however much time passes", async () => {
    expect(await fingerprintAt(T0 + 3_600_000)).toBe(await fingerprintAt(T0));
  });

  const started: Array<[string, (store: WorkspaceStore) => void]> = [
    ["active", (store) => store.updateIssue(ref, { status: "in_progress", assignee: "agent" })],
    ["in review", (store) => store.updateIssue(ref, { status: "in_review" })],
    [
      "gated",
      (store) => {
        store.updateIssue(ref, { status: "done" });
        store.gateIssue(epic, { owner: "vp" });
      },
    ],
  ];
  for (const [label, move] of started) {
    it(`moves every 30 seconds while a ticket is ${label}, and not sooner`, async () => {
      withStore(move);
      const now = await fingerprintAt(T0);
      expect(await fingerprintAt(T0 + 29_000)).toBe(now);
      expect(await fingerprintAt(T0 + 30_000)).not.toBe(now);
    });
  }

  it("follows the configured category, not the built-in status names", async () => {
    withStore((store) => {
      store.approveGate(epic);
      store.addStatus({ id: "deploying", category: "active" });
      store.updateIssue(ref, { status: "deploying" });
    });
    expect(await fingerprintAt(T0 + 30_000)).not.toBe(await fingerprintAt(T0));
  });

  it("stops again once the work is done", async () => {
    withStore((store) => store.updateIssue(ref, { status: "done" }));
    expect(await fingerprintAt(T0 + 3_600_000)).toBe(await fingerprintAt(T0));
  });
});
