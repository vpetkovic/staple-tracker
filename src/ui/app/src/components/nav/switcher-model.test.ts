/**
 * The workspace switcher's rules (switcher-model.ts): what it lists, what waits in each
 * workspace, when it searches, and that its trigger says the whole selection.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceScope } from "@/lib/session";
import {
  SWITCHER_SEARCH_THRESHOLD,
  filterSwitcherRows,
  switcherRows,
  switcherSearches,
  switcherTriggerLabel,
  waitingByWorkspace,
} from "./switcher-model";

const ws = (slug: string, prefix: string) => ({ slug, prefix });
const FEW = [ws("staple", "STA"), ws("ai-inbox-supabase", "AII")];
const MANY = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"].map((slug) => ws(slug, slug.slice(0, 3).toUpperCase()));
const hub = (current: string, workspaces = FEW): WorkspaceScope => ({ mode: "hub", ws: current, workspaces });

describe("the trigger", () => {
  it("says the whole selection — All workspaces, never an abbreviation, never the first workspace", () => {
    expect(switcherTriggerLabel(hub(""))).toBe("All workspaces");
    expect(switcherTriggerLabel(hub("ai-inbox-supabase"))).toBe("ai-inbox-supabase");
    expect(switcherTriggerLabel({ mode: "workspace", ws: "", workspaces: [ws("staple", "STA")] })).toBe("staple");
  });
});

describe("the rows", () => {
  it("lead with All workspaces in a hub, then every workspace in hub order, the current one marked", () => {
    const rows = switcherRows(hub("staple"));
    expect(rows.map((r) => r.value)).toEqual(["", "staple", "ai-inbox-supabase"]);
    expect(rows.filter((r) => r.current).map((r) => r.value)).toEqual(["staple"]);
    expect(switcherRows(hub("")).filter((r) => r.current).map((r) => r.value)).toEqual([""]);
  });

  it("carry each workspace's name and task-number prefix, and none for All workspaces", () => {
    const rows = switcherRows(hub(""));
    expect(rows[0]).toEqual({ value: "", name: "All workspaces", prefix: "", current: true });
    expect(rows[1]).toEqual({ value: "staple", name: "staple", prefix: "STA", current: false });
  });

  it("offer no All workspaces row outside a hub", () => {
    expect(switcherRows({ mode: "workspace", ws: "", workspaces: [ws("staple", "STA")] }).map((r) => r.value)).toEqual(["staple"]);
  });
});

describe("what waits in each workspace", () => {
  it("counts the Inbox's rows per workspace, and names no workspace that has none", () => {
    const counts = waitingByWorkspace([{ workspace: "staple" }, { workspace: "pinecone" }, { workspace: "staple" }]);
    expect([...counts]).toEqual([
      ["staple", 2],
      ["pinecone", 1],
    ]);
    expect(counts.has("aardvark")).toBe(false);
    expect(waitingByWorkspace([]).size).toBe(0);
  });
});

describe("search", () => {
  it(`appears only past ${SWITCHER_SEARCH_THRESHOLD} workspaces`, () => {
    expect(switcherSearches(hub("", MANY.slice(0, SWITCHER_SEARCH_THRESHOLD)))).toBe(false);
    expect(switcherSearches(hub("", MANY))).toBe(true);
  });

  it("matches the name ignoring case, spaces and dashes, or the task-number prefix", () => {
    const rows = switcherRows(hub("", [...FEW, ...MANY]));
    const prefixes = new Map([...FEW, ...MANY].map((w) => [w.slug, w.prefix]));
    expect(filterSwitcherRows(rows, "AI Inbox", prefixes).map((r) => r.value)).toEqual(["ai-inbox-supabase"]);
    expect(filterSwitcherRows(rows, "sta", prefixes).map((r) => r.value)).toEqual(["staple"]);
    // A prefix that appears nowhere in the name: "MKT" finds marketing-site.
    const withMarketing = switcherRows(hub("", [...FEW, ws("marketing-site", "MKT")]));
    expect(filterSwitcherRows(withMarketing, "mkt", new Map([["marketing-site", "MKT"]])).map((r) => r.value)).toEqual(["marketing-site"]);
    expect(filterSwitcherRows(rows, "all", prefixes).map((r) => r.value)).toEqual([""]);
    expect(filterSwitcherRows(rows, "", prefixes)).toHaveLength(rows.length);
    expect(filterSwitcherRows(rows, "zzz", prefixes)).toEqual([]);
  });
});
