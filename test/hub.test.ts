import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-test-"));
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function makeWorkspace(slug: string) {
  const ws = initWorkspace({ global: true, slug });
  return ws;
}

describe("hub registry", () => {
  it("allocates unique prefixes with suffix disambiguation", () => {
    const a = makeWorkspace("garage");
    const b = makeWorkspace("gargantua"); // same GAR base
    expect(a.store.prefix).toBe("GAR");
    expect(b.store.prefix).toBe("GARA");
    const hub = Hub.open();
    expect(hub.list().map((w) => w.slug).sort()).toEqual(["garage", "gargantua"]);
    hub.close();
    a.store.db.close();
    b.store.db.close();
  });

  it("re-init is idempotent and keeps the prefix", () => {
    const a = makeWorkspace("vitness");
    const prefix = a.store.prefix;
    a.store.db.close();
    const again = makeWorkspace("vitness");
    expect(again.store.prefix).toBe(prefix);
    again.store.db.close();
  });
});

describe("cross-workspace links", () => {
  it("links, detects cross-file cycles, and reports readiness", () => {
    const a = makeWorkspace("alpha");
    const b = makeWorkspace("beta");
    const gate = a.store.createIssue({ title: "API contract" });
    const consumer = b.store.createIssue({ title: "Use the API", assignee: "claude" });

    const hub = Hub.open();
    hub.addCrossLink(gate.identifier, consumer.identifier);
    expect(() => hub.addCrossLink(consumer.identifier, gate.identifier)).toThrowError(/cycles/);

    let states = hub.crossBlockersOf(consumer.identifier);
    expect(states).toHaveLength(1);
    expect(states[0]!.resolved).toBe(false);
    expect(states[0]!.unresolvable).toBe(false);

    a.store.updateIssue(gate.id, { status: "done" });
    hub.notifyResolved("alpha", gate.identifier);
    states = hub.crossBlockersOf(consumer.identifier);
    expect(states[0]!.resolved).toBe(true);

    const events = hub.listHubEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("cross_blockers_resolved");
    expect(events[0]!.payload.identifier).toBe(consumer.identifier);

    // Level-triggered: a second notify does not duplicate.
    hub.notifyResolved("alpha", gate.identifier);
    expect(hub.listHubEvents()).toHaveLength(1);

    hub.close();
    a.store.db.close();
    b.store.db.close();
  });

  it("treats a missing workspace file as unresolvable => blocked", () => {
    const a = makeWorkspace("gamma");
    const b = makeWorkspace("delta");
    const gate = a.store.createIssue({ title: "Remote work" });
    const consumer = b.store.createIssue({ title: "Depends on remote" });
    const hub = Hub.open();
    hub.addCrossLink(gate.identifier, consumer.identifier);
    a.store.db.close();
    b.store.db.close();
    rmSync(join(home, "workspaces", "gamma.db"));
    rmSync(join(home, "workspaces", "gamma.db-wal"), { force: true });
    rmSync(join(home, "workspaces", "gamma.db-shm"), { force: true });

    const states = hub.crossBlockersOf(consumer.identifier);
    expect(states[0]!.unresolvable).toBe(true);
    expect(states[0]!.resolved).toBe(false);
    hub.close();
  });
});

describe("holistic views", () => {
  it("unifies issues and builds the cross-workspace graph", () => {
    const a = makeWorkspace("one");
    const b = makeWorkspace("two");
    const x = a.store.createIssue({ title: "X", assignee: "claude" });
    const y = b.store.createIssue({ title: "Y", assignee: "claude" });
    const z = b.store.createIssue({ title: "Z" });
    b.store.setBlockedBy(z.id, [y.id]);

    const hub = Hub.open();
    hub.addCrossLink(x.identifier, y.identifier);

    const unified = hub.unifiedIssues({ assignee: "claude" });
    expect(unified.map((u) => `${u.workspace}`).sort()).toEqual(["one", "two"]);

    const graph = hub.graph();
    expect(graph.nodes).toHaveLength(3);
    /**
     * STA-124: the HUB branch of the graph carries `kind` too. Deliberately
     * unlike `parent`, which only the workspace route derives — a kind is a
     * scalar already on the row, so there is no reason for the two producers to
     * disagree and no degraded state for the client to detect.
     */
    for (const node of graph.nodes) expect(node.kind).toBe("task");
    const cross = graph.edges.filter((e) => e.cross);
    const local = graph.edges.filter((e) => !e.cross);
    expect(cross).toHaveLength(1);
    expect(local).toHaveLength(1);
    expect(cross[0]!.from).toBe(x.identifier);

    hub.close();
    a.store.db.close();
    b.store.db.close();
  });
});
