/**
 * What is new in the Inbox for this browser (lib/inbox-seen.ts).
 */
import { describe, expect, it } from "vitest";
import { type InboxSeen, loadInboxSeen, reconciledInboxSeen, saveInboxSeen, unseenKeys, withInboxSeen } from "./inbox-seen";
import type { AttentionList, AttentionRow } from "./types";

const row = (key: string): AttentionRow => ({ key, workspace: key.slice(0, key.indexOf("/")) }) as AttentionRow;
const list = (keys: string[], over: Partial<AttentionList> = {}): AttentionList => ({
  rows: keys.map(row),
  workspaces: ["app", "web"],
  failed: [],
  now: "2026-11-26T18:00:00.000Z",
  ...over,
});
const fresh: InboxSeen = { started: false, seen: [] };

describe("the Inbox's new rows", () => {
  it("are none on the first read: what is there then is the baseline", () => {
    const first = list(["app/gate_pending/APP-1", "web/in_review/WEB-2"]);
    expect(unseenKeys(first, fresh)).toEqual([]);
    const state = reconciledInboxSeen(fresh, first);
    expect(unseenKeys(first, state)).toEqual([]);
  });

  it("are the rows that arrive after it, whenever they started waiting, until they are seen", () => {
    const state = reconciledInboxSeen(fresh, list(["app/gate_pending/APP-1"]));
    // A gate requested yesterday on another device that synced in now: its key is new.
    const later = list(["app/gate_pending/APP-1", "web/gate_pending/WEB-9"]);
    expect(unseenKeys(later, reconciledInboxSeen(state, later))).toEqual(["web/gate_pending/WEB-9"]);
    expect(unseenKeys(later, withInboxSeen(state, ["web/gate_pending/WEB-9"]))).toEqual([]);
  });

  it("are new again when a row leaves and comes back", () => {
    let state = reconciledInboxSeen(fresh, list(["app/gate_pending/APP-1"]));
    state = reconciledInboxSeen(state, list([]));
    expect(state.seen).toEqual([]);
    expect(unseenKeys(list(["app/gate_pending/APP-1"]), state)).toEqual(["app/gate_pending/APP-1"]);
  });

  it("keep a workspace's keys while it cannot be read, so its rows do not all read new when it returns", () => {
    const state = reconciledInboxSeen(fresh, list(["app/gate_pending/APP-1", "web/in_review/WEB-2"]));
    const webDown = list(["app/gate_pending/APP-1"], { failed: [{ workspace: "web", message: "locked" }] });
    expect(reconciledInboxSeen(state, webDown)).toBe(state);
    expect(unseenKeys(list(["app/gate_pending/APP-1", "web/in_review/WEB-2"]), state)).toEqual([]);
  });

  it("are kept in storage, and a corrupt value reads as a first visit", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const state = withInboxSeen({ started: true, seen: [] }, ["app/gate_pending/APP-1"]);
    saveInboxSeen(storage, state);
    expect(loadInboxSeen(storage)).toEqual(state);
    store.set("staple:inbox-seen:v1", "{not json");
    expect(loadInboxSeen(storage)).toEqual(fresh);
  });
});
