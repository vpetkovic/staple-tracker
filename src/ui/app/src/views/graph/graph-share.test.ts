/**
 * G5 — the link, and the two promises it has to keep.
 *
 * 1. IT MUST NOT TOUCH THE TOKEN. The graph link rides on an authenticated URL. A
 *    rewrite that dropped, reordered or re-encoded `token` would turn "share this view"
 *    into "log this person out", and it would do it silently — the sender's own link
 *    still works, because their tab already has a session.
 *
 * 2. IT MUST ROUND-TRIP, INCLUDING THE DIFFERENCE BETWEEN "no link" AND "a link with
 *    nothing collapsed". Those two decode to different intentions: the first means "apply
 *    the size default", the second means "the sender had it all expanded". Collapsing
 *    them would make every shared link of a big expanded graph re-collapse on arrival —
 *    exactly what the sender was trying to prevent, and invisible to them.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_STATE,
  GRAPH_PARAM,
  decodeGraphView,
  encodeGraphView,
  withGraphView,
  type GraphViewState,
} from "./graph-share";

const state = (overrides: Partial<GraphViewState> = {}): GraphViewState => ({
  ...DEFAULT_VIEW_STATE,
  ...overrides,
});

describe("encode / decode", () => {
  it("round-trips a fully populated view", () => {
    const original = state({
      mode: "path",
      doneMode: "hide",
      epicFilter: "STA-24",
      collapsed: ["STA-1", "STA-12"],
      target: "STA-37",
    });
    expect(decodeGraphView(encodeGraphView(original))).toEqual(original);
  });

  it("produces a legible value with no percent-encoding", () => {
    const encoded = encodeGraphView(
      state({ mode: "path", doneMode: "hide", epicFilter: "STA-24", collapsed: ["STA-1"], target: "STA-37" }),
    );
    expect(encoded).toBe("ph_STA-24_STA-1_STA-37");
    // The whole reason for `_` and `.`: URLSearchParams must leave them alone.
    const params = new URLSearchParams({ [GRAPH_PARAM]: encoded });
    expect(params.toString()).toContain(encoded);
  });

  it("sorts the collapsed list so the same view is always the same link", () => {
    const a = encodeGraphView(state({ collapsed: ["STA-12", "STA-1"] }));
    const b = encodeGraphView(state({ collapsed: ["STA-1", "STA-12"] }));
    expect(a).toBe(b);
  });

  it("tells 'no parameter' apart from 'a link with nothing collapsed'", () => {
    expect(decodeGraphView(null)).toBeNull();
    expect(decodeGraphView("")).toBeNull();
    const explicit = decodeGraphView(encodeGraphView(state({ collapsed: [] })));
    expect(explicit).not.toBeNull();
    expect(explicit!.collapsed).toEqual([]);
  });
});

describe("decoding is total", () => {
  it("falls back on unknown flag characters", () => {
    const decoded = decodeGraphView("ZZ___")!;
    expect(decoded.mode).toBe("off");
    expect(decoded.doneMode).toBe("show");
  });

  it("survives a truncated value", () => {
    expect(decodeGraphView("f")).toEqual({
      mode: "frontier",
      doneMode: "show",
      epicFilter: null,
      collapsed: [],
      target: null,
    });
  });

  it("ignores fields a future version appended", () => {
    // Four fields are the contract; anything after them belongs to a version that does
    // not exist yet and must not disturb the four that do.
    const decoded = decodeGraphView("fs_STA-24_STA-1_STA-37_zoom.3_somethingelse")!;
    expect(decoded).toEqual({
      mode: "frontier",
      doneMode: "show",
      epicFilter: "STA-24",
      collapsed: ["STA-1"],
      target: "STA-37",
    });
  });
});

describe("withGraphView", () => {
  const href = "http://127.0.0.1:4400/?token=SECRET123";

  it("leaves the token exactly as it found it", () => {
    const next = withGraphView(href, state({ mode: "frontier" }));
    expect(new URL(next).searchParams.get("token")).toBe("SECRET123");
  });

  it("adds only its own parameter", () => {
    const next = new URL(withGraphView(href, state({ mode: "frontier" })));
    expect([...next.searchParams.keys()].sort()).toEqual(["graph", "token"]);
  });

  it("removes the parameter entirely for a default view", () => {
    // Someone who has touched nothing should have the address bar they arrived with.
    const dirty = withGraphView(href, state({ mode: "frontier" }));
    const clean = withGraphView(dirty, DEFAULT_VIEW_STATE);
    expect(new URL(clean).searchParams.has(GRAPH_PARAM)).toBe(false);
    expect(new URL(clean).searchParams.get("token")).toBe("SECRET123");
  });

  it("replaces rather than appends when the state changes", () => {
    const once = withGraphView(href, state({ mode: "frontier" }));
    const twice = withGraphView(once, state({ mode: "path" }));
    expect(new URL(twice).searchParams.getAll(GRAPH_PARAM)).toHaveLength(1);
    expect(decodeGraphView(new URL(twice).searchParams.get(GRAPH_PARAM))!.mode).toBe("path");
  });

  it("keeps any other parameter the app may be carrying", () => {
    const withWs = "http://127.0.0.1:4400/?token=T&ws=staple";
    const next = new URL(withGraphView(withWs, state({ doneMode: "hide" })));
    expect(next.searchParams.get("ws")).toBe("staple");
    expect(next.searchParams.get("token")).toBe("T");
  });
});
