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
      epicFilters: ["STA-24", "STA-30"],
      collapsed: ["STA-1", "STA-12"],
      target: "STA-37",
    });
    expect(decodeGraphView(encodeGraphView(original))).toEqual(original);
  });

  it("produces a legible value with no percent-encoding", () => {
    const encoded = encodeGraphView(
      state({ mode: "path", doneMode: "hide", epicFilters: ["STA-24"], collapsed: ["STA-1"], target: "STA-37" }),
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
      epicFilters: [],
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
      epicFilters: ["STA-24"],
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

/**
 * ── O4b (STA-134): the filter went plural, and old links still have to open ──────────
 *
 * The single `epicFilter` became `epicFilters[]`. The promise that costs something is
 * the second one: every graph link anyone has already pasted into a doc, a ticket or a
 * Slack thread was written by the old encoder, nobody can go back and reissue them, and
 * the person opening one cannot fix it. A link that 404s the view is a feature that
 * broke silently for everyone who was using it well.
 */
describe("epic filters (O4b)", () => {
  it("round-trips several epics", () => {
    const many = state({ epicFilters: ["STA-24", "STA-30", "STA-31"] });
    expect(decodeGraphView(encodeGraphView(many))!.epicFilters).toEqual([
      "STA-24",
      "STA-30",
      "STA-31",
    ]);
  });

  it("stays legible — the list is `.`-joined and URLSearchParams leaves it alone", () => {
    const encoded = encodeGraphView(
      state({ mode: "path", doneMode: "hide", epicFilters: ["STA-24", "STA-30"], collapsed: ["STA-1"] }),
    );
    expect(encoded).toBe("ph_STA-24.STA-30_STA-1_");
    expect(new URLSearchParams({ [GRAPH_PARAM]: encoded }).toString()).toContain(encoded);
  });

  it("sorts and de-duplicates, so the same view is always the same link", () => {
    const a = encodeGraphView(state({ epicFilters: ["STA-30", "STA-24"] }));
    const b = encodeGraphView(state({ epicFilters: ["STA-24", "STA-30", "STA-24"] }));
    expect(a).toBe(b);
  });

  it("OPENS AN OLD LINK that carried a single epicFilter", () => {
    // Written by the pre-O4b encoder, byte for byte. A scalar is a one-element list, so
    // this needs no version flag and no legacy branch — see decodeGraphView.
    const legacy = "ph_STA-24_STA-1.STA-12_STA-37";
    expect(decodeGraphView(legacy)).toEqual({
      mode: "path",
      doneMode: "hide",
      epicFilters: ["STA-24"],
      collapsed: ["STA-1", "STA-12"],
      target: "STA-37",
    });
  });

  it("re-encodes an old link to the new shape without changing what it means", () => {
    const decoded = decodeGraphView("ph_STA-24_STA-1_STA-37")!;
    expect(encodeGraphView(decoded)).toBe("ph_STA-24_STA-1_STA-37");
  });

  it("treats an empty filter field as the whole graph, not as an epic named ''", () => {
    expect(decodeGraphView("os__STA-1_")!.epicFilters).toEqual([]);
    expect(decodeGraphView("os_..._")!.epicFilters).toEqual([]);
  });

  it("keeps selection and collapse in separate fields", () => {
    // The bug this ticket exists to kill is the two being confused. In the link they are
    // two fields, so a change to one cannot move the other.
    const selectedOnly = encodeGraphView(state({ epicFilters: ["STA-24"] }));
    const collapsedOnly = encodeGraphView(state({ collapsed: ["STA-24"] }));
    expect(selectedOnly).not.toBe(collapsedOnly);
    expect(decodeGraphView(selectedOnly)!.collapsed).toEqual([]);
    expect(decodeGraphView(collapsedOnly)!.epicFilters).toEqual([]);
  });

  it("drops the parameter for a state with no filters and nothing collapsed", () => {
    const href = "http://127.0.0.1:4400/?token=T";
    const next = withGraphView(href, state({ epicFilters: [] }));
    expect(new URL(next).searchParams.has(GRAPH_PARAM)).toBe(false);
  });
});
