import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { startUiServer } from "../src/ui/server.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
it("a sync-only setting write changes the open page poll fingerprint without events or issue changes", async () => {
  const repo = "5eed0000-0000-4000-8000-000000000032";
  const fleet = new Fleet(new FakeSyncServer({ repositoryId: repo }), repo);
  const a = fleet.machine("a"); a.store.setSetting("features.planning", true, "Mira", { via: "settings" }); await a.sync();
  const b = fleet.machine("b"); await b.sync(); b.use();
  const ui = startUiServer({ port: 0, hub: false, db: b.dbPath }); await once(ui.server, "listening");
  const origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(origin + path, { headers: { "x-staple-token": ui.token } })).json();
  const stable = () => JSON.stringify([b.db.prepare("SELECT MAX(seq) FROM events").get(), b.db.prepare("SELECT COUNT(*), MAX(updated_at) FROM issues").get()]);
  try {
    for (const [key, value] of [["features.planning", false], ["queue.policy", "strict"]] as const) {
      b.use(); const before = (await get("/api/poll")).fingerprint; const rows = stable();
      a.use(); a.store.setSetting(key, value, "Mira", { via: "settings" }); await a.sync(); b.use(); await b.sync();
      expect(stable()).toBe(rows); expect((await get("/api/poll")).fingerprint).not.toBe(before);
    }
    expect((await get("/api/bootstrap")).features[b.store.slug]).toMatchObject({ planning: false });
  } finally { ui.close(); fleet.close(); }
});
