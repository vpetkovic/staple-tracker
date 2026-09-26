/**
 * "Which workspace?" — All workspaces is its own state, and a workspace-only action asks
 * with a remembered default rather than silently using the first workspace.
 */
import { describe, expect, it } from "vitest";
import { currentWorkspace, isAllWorkspaces, scopeName, type WorkspaceScope } from "./session";
import {
  TARGET_WORKSPACE_KEY,
  asksForWorkspace,
  defaultTargetWorkspace,
  loadRememberedWorkspace,
  rememberWorkspace,
} from "./session-workspace";

const WORKSPACES = [
  { slug: "aardvark", prefix: "AAR" },
  { slug: "staple", prefix: "STA" },
  { slug: "pinecone", prefix: "PIN" },
];
const hub = (ws: string): WorkspaceScope => ({ mode: "hub", ws, workspaces: WORKSPACES });
const single: WorkspaceScope = { mode: "workspace", ws: "", workspaces: [{ slug: "staple", prefix: "STA" }] };

function memory(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe("All workspaces is its own state", () => {
  it("is All only in a hub with nothing selected", () => {
    expect(isAllWorkspaces(hub(""))).toBe(true);
    expect(isAllWorkspaces(hub("staple"))).toBe(false);
    expect(isAllWorkspaces(single)).toBe(false);
  });

  it("has no current workspace — not the first one", () => {
    expect(currentWorkspace(hub(""))).toBeNull();
    expect(currentWorkspace(hub("pinecone"))?.slug).toBe("pinecone");
    // Single-workspace mode: the one workspace IS current.
    expect(currentWorkspace(single)?.slug).toBe("staple");
  });

  it("is named All workspaces wherever the scope is said", () => {
    expect(scopeName(hub(""))).toBe("All workspaces");
    expect(scopeName(hub("pinecone"))).toBe("pinecone");
    expect(scopeName(single)).toBe("staple");
    expect(scopeName(hub(""))).not.toBe("aardvark");
  });
});

describe("the default answer to 'which workspace?'", () => {
  it("is the page's workspace when it is on one", () => {
    expect(defaultTargetWorkspace(hub("pinecone"), "staple")).toBe("pinecone");
    expect(defaultTargetWorkspace(single, "")).toBe("staple");
  });

  it("on All workspaces is the remembered choice, when it is still registered", () => {
    expect(defaultTargetWorkspace(hub(""), "staple")).toBe("staple");
    expect(defaultTargetWorkspace(hub(""), "gone-since")).toBe("");
  });

  it("on All workspaces with nothing remembered is NOTHING — the form asks — never the first", () => {
    expect(defaultTargetWorkspace(hub(""), "")).toBe("");
    expect(defaultTargetWorkspace(hub(""), "")).not.toBe("aardvark");
  });

  it("is the only workspace of a one-workspace hub", () => {
    expect(defaultTargetWorkspace({ mode: "hub", ws: "", workspaces: [WORKSPACES[1]!] }, "")).toBe("staple");
  });

  it("is asked only when there is a choice to make", () => {
    expect(asksForWorkspace(hub(""))).toBe(true);
    expect(asksForWorkspace(hub("staple"))).toBe(true);
    expect(asksForWorkspace(single)).toBe(false);
    expect(asksForWorkspace({ mode: "hub", ws: "", workspaces: [WORKSPACES[0]!] })).toBe(false);
  });
});

describe("the remembered choice", () => {
  it("is written by a choice and read back, and a blank is never stored", () => {
    const store = memory();
    expect(loadRememberedWorkspace(store)).toBe("");
    rememberWorkspace("pinecone", store);
    expect(store.getItem(TARGET_WORKSPACE_KEY)).toBe("pinecone");
    rememberWorkspace("", store);
    expect(loadRememberedWorkspace(store)).toBe("pinecone");
  });

  it("survives a storage that throws, as nothing remembered", () => {
    const broken = { getItem: () => { throw new Error("private mode"); }, setItem: () => { throw new Error("private mode"); } };
    expect(loadRememberedWorkspace(broken)).toBe("");
    expect(() => rememberWorkspace("staple", broken)).not.toThrow();
  });
});
