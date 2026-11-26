/**
 * The page's address — lib/session-url.ts. The URL is the source of truth for the workspace,
 * the view and the filters: these are the rules that make a reload, a bookmark and Back land
 * on the same page, asserted over real hrefs.
 */
import { describe, expect, it } from "vitest";
import { emptyFilters, type FilterState } from "./filters";
import {
  VIEW_SLUGS,
  afterWorkspaceSwitch,
  isNavigation,
  readShellUrl,
  runHref,
  viewFromSlug,
  withShellState,
  type ShellUrlState,
} from "./session-url";
import { VIEWS } from "./session";

const BASE = "http://127.0.0.1:4400/";
const state = (over: Partial<ShellUrlState> = {}): ShellUrlState => ({
  ws: "",
  view: "tree",
  filters: emptyFilters(),
  focus: null,
  run: null,
  ...over,
});
const filters = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...over });
const search = (href: string) => new URL(href).search;

describe("an address that describes a page", () => {
  it("round-trips the workspace, the view, every filter dimension, the search, done and the focus", () => {
    const page = state({
      ws: "pinecone",
      view: "milestones",
      filters: filters({
        dims: { status: ["in_progress", "in_review"], priority: ["critical"], label: ["a,b", "ui"], project: ["p-1"] },
        text: "flaky login",
        showDone: true,
      }),
      focus: "PIN-4",
    });
    const href = withShellState(BASE, page);
    expect(readShellUrl(search(href))).toEqual(page);
  });

  it("reads like words: tasks, not tree; repeated values, not a JSON blob", () => {
    const href = withShellState(BASE, state({ ws: "staple", filters: filters({ dims: { status: ["todo", "blocked"] } }) }));
    expect(search(href)).toBe("?ws=staple&view=tasks&status=todo&status=blocked");
    expect(VIEW_SLUGS.calibration).toBe("estimate-accuracy");
  });

  it("says All workspaces by leaving ws out", () => {
    const href = withShellState(BASE, state({ ws: "" }));
    expect(new URL(href).searchParams.has("ws")).toBe(false);
    expect(readShellUrl(search(href))?.ws).toBe("");
  });

  it("knows every view by its slug, and by its internal id", () => {
    for (const view of VIEWS) {
      expect(viewFromSlug(VIEW_SLUGS[view])).toBe(view);
      expect(viewFromSlug(view)).toBe(view);
    }
    expect(viewFromSlug("Tasks")).toBe("tree");
  });
});

describe("an address that says nothing about the page", () => {
  it("is null without a view, so a bare / opens on what the browser remembered", () => {
    expect(readShellUrl("")).toBeNull();
    expect(readShellUrl("?status=todo&ws=staple")).toBeNull();
    expect(readShellUrl("?settings=telemetry")).toBeNull();
  });

  it("is null for a view this build does not have, rather than a broken page", () => {
    expect(readShellUrl("?view=nonsense")).toBeNull();
  });

  it("drops blank and unknown dimensions instead of inventing filters", () => {
    const read = readShellUrl("?view=tasks&status=&status=%20&colour=red&status=todo&status=todo");
    expect(read?.filters.dims).toEqual({ status: ["todo"] });
  });
});

describe("the other features' parameters survive", () => {
  it("keeps settings, settings-ws, graph and token verbatim while rewriting its own", () => {
    const href = "http://127.0.0.1:4400/?token=t0k&graph=g1&settings=statuses&settings-ws=pinecone&view=graph&status=todo";
    const onGraph = new URL(withShellState(href, state({ view: "graph" })));
    expect(onGraph.searchParams.get("graph")).toBe("g1");
    const next = new URL(withShellState(href, state({ view: "queue" })));
    expect(next.searchParams.get("token")).toBe("t0k");
    // The graph's layout is the Graph's: it does not follow the reader to another page.
    expect(next.searchParams.get("graph")).toBeNull();
    expect(next.searchParams.get("settings")).toBe("statuses");
    expect(next.searchParams.get("settings-ws")).toBe("pinecone");
    expect(next.searchParams.get("view")).toBe("queue");
    // Its own old values are gone, not duplicated.
    expect(next.searchParams.getAll("status")).toEqual([]);
    expect(next.searchParams.getAll("view")).toEqual(["queue"]);
  });

  it("is stable: the same state always writes the same href, so an unchanged page writes nothing", () => {
    const page = state({ ws: "staple", filters: filters({ dims: { kind: ["bug"] }, text: "x" }) });
    const once = withShellState(BASE, page);
    expect(withShellState(once, page)).toBe(once);
  });
});

describe("Back", () => {
  it("steps back over a workspace or view change, not over a filter tweak", () => {
    const tasks = state({ ws: "staple" });
    expect(isNavigation(tasks, { ...tasks, view: "graph" })).toBe(true);
    expect(isNavigation(tasks, { ...tasks, ws: "" })).toBe(true);
    expect(isNavigation(tasks, { ...tasks, filters: filters({ text: "a" }) })).toBe(false);
    expect(isNavigation(null, tasks)).toBe(false);
  });
});

describe("switching workspace keeps the page", () => {
  it("keeps the view, takes the target's own filters, and drops a milestone focus that named the old workspace", () => {
    const targetFilters = filters({ dims: { priority: ["high"] } });
    const landing = afterWorkspaceSwitch({ view: "graph" }, "pinecone", (ws, view) =>
      ws === "pinecone" && view === "graph" ? targetFilters : emptyFilters(),
    );
    expect(landing).toEqual({ ws: "pinecone", view: "graph", focus: null, run: null, filters: targetFilters });
  });

  it("lands on All workspaces with the view unchanged", () => {
    expect(afterWorkspaceSwitch({ view: "milestones" }, "", () => emptyFilters()).view).toBe("milestones");
  });
});

describe("the Inbox and the Autopilot page", () => {
  it("calls the Inbox inbox, and an old ?view=attention still lands there and is rewritten", () => {
    expect(readShellUrl("?view=inbox")?.view).toBe("attention");
    const old = readShellUrl("?ws=staple&view=attention");
    expect(old?.view).toBe("attention");
    expect(search(withShellState(`${BASE}?ws=staple&view=attention`, old!))).toBe("?ws=staple&view=inbox");
  });

  it("names a run on the Autopilot page, and round-trips it", () => {
    const page = state({ ws: "staple", view: "autopilot", run: "cfe86469-75c5-465b-ae80-c5d4f9510448" });
    const href = withShellState(BASE, page);
    expect(search(href)).toBe("?ws=staple&view=autopilot&run=cfe86469-75c5-465b-ae80-c5d4f9510448");
    expect(readShellUrl(search(href))).toEqual(page);
    expect(readShellUrl("?view=autopilot")?.run).toBeNull();
  });

  it("keeps a run to the Autopilot page: read nowhere else, and dropped on the way out", () => {
    expect(readShellUrl("?view=tasks&run=abc")?.run).toBeNull();
    const onRun = withShellState(BASE, state({ view: "autopilot", run: "abc" }));
    expect(new URL(withShellState(onRun, state({ view: "queue" }))).searchParams.has("run")).toBe(false);
    expect(new URL(withShellState(onRun, state({ view: "autopilot" }))).searchParams.has("run")).toBe(false);
  });

  it("makes going from the list to a run, from a run to the list, and between runs a step Back returns from", () => {
    const list = state({ view: "autopilot" });
    expect(isNavigation(list, { ...list, run: "a" })).toBe(true);
    expect(isNavigation({ ...list, run: "a" }, list)).toBe(true);
    expect(isNavigation({ ...list, run: "a" }, { ...list, run: "b" })).toBe(true);
    expect(isNavigation({ ...list, run: "a" }, { ...list, run: "a" })).toBe(false);
  });

  it("drops the run when the workspace changes: it lives in the workspace being left", () => {
    expect(afterWorkspaceSwitch({ view: "autopilot" }, "pinecone", () => emptyFilters()).run).toBeNull();
  });
});

describe("a link to a run", () => {
  it("keeps the workspace and the other features' parameters, and leaves the page's own behind", () => {
    const from = `${BASE}?ws=staple&view=tasks&status=todo&q=x&issue=STA-1&settings=statuses&token=t`;
    const href = new URL(runHref(from, "run-1"));
    expect(href.searchParams.get("ws")).toBe("staple");
    expect(href.searchParams.get("view")).toBe("autopilot");
    expect(href.searchParams.get("run")).toBe("run-1");
    expect(href.searchParams.get("settings")).toBe("statuses");
    for (const gone of ["status", "q", "issue"]) expect(href.searchParams.has(gone)).toBe(false);
    expect(readShellUrl(href.search)).toMatchObject({ ws: "staple", view: "autopilot", run: "run-1" });
  });
});
