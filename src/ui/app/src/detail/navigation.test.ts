/**
 * R6 (STA-106) — everything about prev/next that is not a button.
 *
 * The feature looks like two chevrons and is really one question asked repeatedly:
 * given the list the user can see and the issue they are looking at, what is on
 * either side of it? Every wrong answer to that is silent — you press down, you land
 * somewhere, and unless you were watching the list you have no way to know it was
 * the wrong somewhere. So the answer is computed by a pure function and pinned here,
 * where "wrong" is loud.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so
 * the app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import { neighbours, sameTarget, type NavTarget } from "./navigation";

const t = (ref: string, workspace = "staple"): NavTarget => ({ workspace, ref });
const list = [t("STA-1"), t("STA-2"), t("STA-3"), t("STA-4")];

describe("neighbours", () => {
  it("gives both sides in the middle of the list", () => {
    const nav = neighbours(list, t("STA-2"));
    expect(nav.prev).toEqual(t("STA-1"));
    expect(nav.next).toEqual(t("STA-3"));
    expect(nav.index).toBe(1);
    expect(nav.total).toBe(4);
  });

  /**
   * The ends do NOT wrap. Wrapping is the natural thing to write and the wrong thing
   * to ship: pressing "next" on the last row and arriving at the first is
   * indistinguishable, for one frame, from having gone somewhere sensible, and the
   * ticket asks for disabled states precisely because the end of the list is
   * information the user wants.
   */
  it("stops at the ends rather than wrapping", () => {
    const first = neighbours(list, t("STA-1"));
    expect(first.prev).toBeNull();
    expect(first.next).toEqual(t("STA-2"));

    const last = neighbours(list, t("STA-4"));
    expect(last.prev).toEqual(t("STA-3"));
    expect(last.next).toBeNull();
  });

  it("has no neighbours in a list of one", () => {
    const nav = neighbours([t("STA-9")], t("STA-9"));
    expect(nav.prev).toBeNull();
    expect(nav.next).toBeNull();
    expect(nav.index).toBe(0);
    expect(nav.total).toBe(1);
  });

  /**
   * THE CASE THAT IS A DECISION, NOT AN EDGE CASE.
   *
   * You can be looking at an issue that is not in the visible list: click a blocker
   * chip, or an ancestor breadcrumb, for something the current filter excludes, and
   * the panel is now showing a ticket the list has never heard of. The tempting
   * reading of "not found" is "start from the top", which makes the down arrow jump
   * to an unrelated ticket — worse than a disabled button, because it looks like it
   * worked. Not in the list means no neighbours, and the arrows say so.
   */
  it("has no neighbours for an issue that is not in the visible list", () => {
    const nav = neighbours(list, t("STA-77"));
    expect(nav.prev).toBeNull();
    expect(nav.next).toBeNull();
    expect(nav.index).toBe(-1);
    expect(nav.total).toBe(4);
  });

  it("has no neighbours with nothing selected, and none in an empty list", () => {
    expect(neighbours(list, null).index).toBe(-1);
    expect(neighbours([], t("STA-1"))).toEqual({ prev: null, next: null, index: -1, total: 0 });
  });

  /**
   * HUB MODE MAKES THE WORKSPACE LOAD-BEARING. Two workspaces can both have a
   * "STA-2"-shaped identifier in one federated list, and matching on `ref` alone
   * would put you in the wrong workspace's ticket while the identifier in the chrome
   * bar looked exactly right. The key is the pair.
   */
  it("keys on workspace AND ref, not ref alone", () => {
    const hub = [t("WOR-1", "workshop"), t("STA-1", "staple"), t("WOR-1", "staple")];
    const nav = neighbours(hub, t("WOR-1", "staple"));
    expect(nav.index).toBe(2);
    expect(nav.prev).toEqual(t("STA-1", "staple"));
    expect(nav.next).toBeNull();
  });

  /**
   * A duplicate is a bug upstream, not something to resolve cleverly here. First
   * match wins, deterministically, so the arrows stay stable across renders instead
   * of oscillating between two indices for the same ticket.
   */
  it("takes the first match when the list repeats an entry", () => {
    const dupes = [t("STA-1"), t("STA-2"), t("STA-1"), t("STA-3")];
    const nav = neighbours(dupes, t("STA-1"));
    expect(nav.index).toBe(0);
    expect(nav.prev).toBeNull();
    expect(nav.next).toEqual(t("STA-2"));
  });

  it("never returns the current issue as its own neighbour", () => {
    for (const current of list) {
      const nav = neighbours(list, current);
      expect(nav.prev).not.toEqual(current);
      expect(nav.next).not.toEqual(current);
    }
  });

  /**
   * Walking the whole list with `next` must visit every entry exactly once and stop.
   * This is the property the two chevrons actually promise, and it is the one thing
   * an off-by-one in either direction cannot survive.
   */
  it("walks the entire list exactly once and terminates", () => {
    const seen: string[] = [];
    let at: NavTarget | null = list[0] ?? null;
    while (at) {
      seen.push(at.ref);
      at = neighbours(list, at).next;
      if (seen.length > 10) throw new Error("next never terminated");
    }
    expect(seen).toEqual(["STA-1", "STA-2", "STA-3", "STA-4"]);
  });

  it("walks backwards to the same list", () => {
    const seen: string[] = [];
    let at: NavTarget | null = list[list.length - 1] ?? null;
    while (at) {
      seen.push(at.ref);
      at = neighbours(list, at).prev;
      if (seen.length > 10) throw new Error("prev never terminated");
    }
    expect(seen).toEqual(["STA-4", "STA-3", "STA-2", "STA-1"]);
  });
});

describe("sameTarget", () => {
  it("compares the pair, and tolerates nulls on either side", () => {
    expect(sameTarget(t("STA-1"), t("STA-1"))).toBe(true);
    expect(sameTarget(t("STA-1"), t("STA-2"))).toBe(false);
    expect(sameTarget(t("STA-1", "a"), t("STA-1", "b"))).toBe(false);
    expect(sameTarget(null, null)).toBe(false);
    expect(sameTarget(null, t("STA-1"))).toBe(false);
    expect(sameTarget(t("STA-1"), null)).toBe(false);
  });
});
