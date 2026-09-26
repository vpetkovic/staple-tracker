import { describe, expect, it } from "vitest";
import { VIEWS, VIEW_LABELS, VIEW_SHORT_LABELS, viewControls, viewUsesIssueFilters } from "@/lib/session";
import {
  NAV_GROUPS,
  RAIL_STORAGE_KEY,
  decodeRailCollapsed,
  encodeRailCollapsed,
  isRailToggleKey,
  loadRailCollapsed,
  navItemForView,
  overlayFocusTarget,
  projectCaption,
  railKeyAction,
  saveRailCollapsed,
} from "./nav-model";

describe("the rail's groups", () => {
  it("lists every view exactly once, across all groups", () => {
    const views = NAV_GROUPS.flatMap((group) => group.items.map((entry) => entry.view));
    expect([...views].sort()).toEqual([...VIEWS].sort());
    expect(new Set(views).size).toBe(views.length);
  });

  it("opens with the Workspace group, in the order Tasks, Queue, Graph, Milestones, Estimates (the calibration view)", () => {
    const first = NAV_GROUPS[0]!;
    expect(first.label).toBe("Workspace");
    expect(first.items.map((entry) => entry.label)).toEqual(["Tasks", "Queue", "Graph", "Milestones", "Estimates"]);
    expect(first.items.map((entry) => entry.view)).toEqual(["tree", "queue", "graph", "milestones", "calibration"]);
  });

  it("lists the machine's Usage in its own This machine group — Settings' name for it — after the workspace's views", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual(["Workspace", "This machine"]);
    const machine = NAV_GROUPS[1]!;
    expect(machine.items.map((entry) => entry.label)).toEqual(["Usage"]);
    expect(machine.items.map((entry) => entry.view)).toEqual(["budget"]);
    expect(navItemForView("budget")).toMatchObject({ id: "view:budget", label: "Usage" });
  });

  it("calls every view by ONE name: the tab bar says exactly what the rail says", () => {
    for (const view of VIEWS) expect(VIEW_SHORT_LABELS[view]).toBe(VIEW_LABELS[view]);
  });

  it("offers the issue filters only where they narrow something: Tasks and Graph", () => {
    expect(VIEWS.filter((view) => viewUsesIssueFilters(view))).toEqual(["tree", "graph"]);
  });

  it("shows each view only the header controls it honours", () => {
    expect(viewControls("tree")).toEqual({ arrange: true, filter: true, done: true });
    // The graph draws the filtered nodes; it has no rows to group or sort.
    expect(viewControls("graph")).toEqual({ arrange: false, filter: true, done: true });
    // Milestones lists finished milestones when Done is on, and filters nothing else.
    expect(viewControls("milestones")).toEqual({ arrange: false, filter: false, done: true });
    for (const view of ["queue", "calibration", "budget"] as const) {
      expect(viewControls(view)).toEqual({ arrange: false, filter: false, done: false });
    }
  });

  it("calls the tree view Tasks and keeps its internal value", () => {
    expect(VIEW_LABELS.tree).toBe("Tasks");
    expect(navItemForView("tree")).toMatchObject({ id: "view:tree", label: "Tasks", view: "tree" });
    // Every rail item wears an icon; a row without one would be the odd one out.
    for (const group of NAV_GROUPS) for (const entry of group.items) expect(entry.icon).toBeTruthy();
  });

  it("hangs the projects off the Tasks row and nowhere else", () => {
    expect(navItemForView("tree")).toMatchObject({
      action: { id: "new-project", label: "New project" },
      subItems: "projects",
    });
    for (const view of VIEWS) {
      if (view === "tree") continue;
      const entry = navItemForView(view)!;
      expect(entry.action, view).toBeUndefined();
      expect(entry.subItems, view).toBeUndefined();
    }
  });

  it("captions a project with its workspace only when the rows span more than one", () => {
    expect(projectCaption("staple", new Set(["staple"]))).toBeNull();
    expect(projectCaption("staple", new Set(["staple", "pinecone"]))).toBe("staple");
    expect(projectCaption("staple", new Set())).toBeNull();
  });
});

describe("the toggle shortcut", () => {
  const key = (over: Partial<Parameters<typeof isRailToggleKey>[0]>) => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("answers a bare [ and a cmd or ctrl backslash", () => {
    expect(isRailToggleKey(key({ key: "[" }))).toBe(true);
    expect(isRailToggleKey(key({ key: "\\", metaKey: true }))).toBe(true);
    expect(isRailToggleKey(key({ key: "\\", ctrlKey: true }))).toBe(true);
  });

  it("leaves every other combination alone", () => {
    expect(isRailToggleKey(key({ key: "\\" }))).toBe(false);
    expect(isRailToggleKey(key({ key: "[", metaKey: true }))).toBe(false);
    expect(isRailToggleKey(key({ key: "[", shiftKey: true }))).toBe(false);
    expect(isRailToggleKey(key({ key: "[", altKey: true }))).toBe(false);
    expect(isRailToggleKey(key({ key: "]" }))).toBe(false);
    expect(isRailToggleKey(key({ key: "k", metaKey: true }))).toBe(false);
  });
});

describe("what the shell does with a key", () => {
  const key = (over: Partial<Parameters<typeof railKeyAction>[0]>) => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  const quiet = { overlayOpen: false, surfaceOpen: false, typing: false };

  it("lets an open dialog, menu or listbox own the keyboard — Escape and the toggle alike", () => {
    const busy = { overlayOpen: true, surfaceOpen: true, typing: false };
    expect(railKeyAction(key({ key: "Escape" }), busy)).toBeNull();
    expect(railKeyAction(key({ key: "[" }), busy)).toBeNull();
    expect(railKeyAction(key({ key: "\\", metaKey: true }), busy)).toBeNull();
  });

  it("closes the sheet on Escape only while it is open", () => {
    expect(railKeyAction(key({ key: "Escape" }), { ...quiet, overlayOpen: true })).toBe("close-overlay");
    expect(railKeyAction(key({ key: "Escape" }), quiet)).toBeNull();
  });

  it("toggles on the shortcut, except a bare [ typed into a field", () => {
    expect(railKeyAction(key({ key: "[" }), quiet)).toBe("toggle");
    expect(railKeyAction(key({ key: "\\", ctrlKey: true }), quiet)).toBe("toggle");
    expect(railKeyAction(key({ key: "[" }), { ...quiet, typing: true })).toBeNull();
    // cmd-\ can afford to fire from a field: it is not a character anyone types there.
    expect(railKeyAction(key({ key: "\\", metaKey: true }), { ...quiet, typing: true })).toBe("toggle");
    expect(railKeyAction(key({ key: "k", metaKey: true }), quiet)).toBeNull();
  });
});

describe("where focus goes when the sheet opens or closes", () => {
  it("lands in the rail on open, returns to the show button on close, and moves otherwise not at all", () => {
    expect(overlayFocusTarget(false, true)).toBe("rail");
    expect(overlayFocusTarget(true, false)).toBe("show-navigation");
    expect(overlayFocusTarget(true, true)).toBeNull();
    expect(overlayFocusTarget(false, false)).toBeNull();
  });
});

describe("the collapsed envelope", () => {
  it("round-trips, and reads anything unexpected as open", () => {
    expect(decodeRailCollapsed(encodeRailCollapsed(true))).toBe(true);
    expect(decodeRailCollapsed(encodeRailCollapsed(false))).toBe(false);
    expect(decodeRailCollapsed(null)).toBe(false);
    expect(decodeRailCollapsed("garbage")).toBe(false);
  });

  it("survives a storage that throws, and a page with none", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveRailCollapsed(storage, true);
    expect(store.get(RAIL_STORAGE_KEY)).toBe("collapsed");
    expect(loadRailCollapsed(storage)).toBe(true);

    const broken = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(loadRailCollapsed(broken)).toBe(false);
    expect(() => saveRailCollapsed(broken, true)).not.toThrow();
    expect(loadRailCollapsed(undefined)).toBe(false);
  });
});
