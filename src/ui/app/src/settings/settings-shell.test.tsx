/**
 * R6b (STA-177) — the Work Workspace Settings shell, in the two halves a test can hold.
 *
 * Rendered to a string with `react-dom/server`, following `detail/gate-review.test.tsx`:
 * the suite has no jsdom and does not want one. So —
 *
 *   ASSERTED HERE: the exact title; the scope line; that the nav is the registry (an
 *   invented category appears with no edit to the shell); which pane a stacked shell
 *   shows and that the Back path exists exactly when it should; what the full-screen
 *   toggle says in each mode; and the PURE FUNCTIONS the mount hangs the URL and the
 *   history on — `readSettingsRoute`, `withSettingsRoute`, `resolveCategory`,
 *   `closeAction` — which are the whole of "deep links focus a category and browser
 *   back restores the prior location" once the browser's own `popstate` is trusted.
 *
 *   NOT HERE: layout. "No clipped forms at 375px" and "the scroll offset came back" are
 *   facts about a real viewport, verified in the browser and recorded on the ticket.
 *   What this file pins is the contract those facts rest on: the stacked frame is the
 *   full viewport, and `rememberScroll`/`recallScroll` return what they were given.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingCategoryView } from "@/lib/settings";
import { SETTINGS_TITLE, SettingsShell, type SettingsShellProps } from "./SettingsShell";
import {
  SETTINGS_PARAM,
  closeAction,
  readSettingsRoute,
  recallScroll,
  rememberScroll,
  resolveCategory,
  scopeSummaryText,
  settingsFrameClass,
  withSettingsRoute,
  type ScrollMemory,
} from "./settings-shell";

const category = (id: string, over: Partial<SettingCategoryView> = {}): SettingCategoryView => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  description: `About ${id}.`,
  scope: "workspace",
  editor: "fields",
  order: 0,
  ...over,
});

/** The served registry plus one category this shell was never written for. */
const CATEGORIES: SettingCategoryView[] = [
  category("statuses", { editor: "statuses", order: 10 }),
  category("kinds", { editor: "kinds", order: 20 }),
  category("pigeons", { label: "Pigeon lofts", order: 30 }),
  category("machine", { label: "This machine", scope: "global", order: 90 }),
];

const SCOPE = { workspace: "staple", globalPath: "/home/vp/.staple/config.json", globalPresent: true };

function render(over: Partial<SettingsShellProps> = {}): string {
  return renderToStaticMarkup(
    <SettingsShell
      categories={CATEGORIES}
      active="statuses"
      layout="two-pane"
      pane="nav"
      mode="drawer"
      scope={SCOPE}
      onSelect={() => {}}
      onBack={() => {}}
      onToggleMode={() => {}}
      onClose={() => {}}
      renderCategory={(c) => <div data-testid="content">{`content for ${c.id}`}</div>}
      {...over}
    />,
  );
}

describe("the header", () => {
  it("is titled exactly Work Workspace Settings", () => {
    expect(SETTINGS_TITLE).toBe("Work Workspace Settings");
    expect(render()).toContain(">Work Workspace Settings</h2>");
  });

  it("says which workspace is being edited and where global preferences live", () => {
    const html = render();
    expect(html).toContain("Editing workspace &quot;staple&quot;. Global preferences live in /home/vp/.staple/config.json.");
    expect(scopeSummaryText({ ...SCOPE, globalPresent: false })).toContain("(not created yet)");
    expect(scopeSummaryText({ workspace: "", globalPath: "", globalPresent: false })).toBe(
      "Editing this workspace. Global preferences live in this machine's config.json.",
    );
  });

  it("uses the heading element it is handed, so the dialog can supply DialogTitle", () => {
    const html = render({ TitleTag: "h1" });
    expect(html).toContain(">Work Workspace Settings</h1>");
  });
});

describe("the navigation is the registry", () => {
  it("lists every served category, including one the shell has never heard of", () => {
    const html = render();
    expect(html).toContain('data-settings-category="statuses"');
    expect(html).toContain('data-settings-category="kinds"');
    expect(html).toContain('data-settings-category="pigeons"');
    expect(html).toContain("Pigeon lofts");
    expect(html).toContain('data-settings-category="machine"');
  });

  it("groups by scope and names both scopes", () => {
    const html = render();
    expect(html).toContain(">Workspace<");
    expect(html).toContain(">Global<");
    // Workspace categories come before the global heading; the global one after it.
    expect(html.indexOf("Pigeon lofts")).toBeLessThan(html.indexOf(">Global<"));
    expect(html.indexOf(">Global<")).toBeLessThan(html.indexOf("This machine"));
  });

  it("marks the selected category and renders only its content, labelled with its scope", () => {
    const html = render({ active: "pigeons" });
    expect(html).toContain('data-settings-category="pigeons" aria-current="page"');
    expect(html).toContain("content for pigeons");
    expect(html).not.toContain("content for statuses");
    expect(html).toContain("Workspace scope");
    expect(html).toContain("About pigeons.");
  });

  it("a global category says so beside its content", () => {
    expect(render({ active: "machine" })).toContain("Global scope");
  });

  it("with no registry yet, the nav is empty and the fallback shows", () => {
    const html = render({ categories: [], active: null, fallback: <p>Loading…</p> });
    expect(html).not.toContain("data-settings-category=");
    expect(html).toContain("Loading…");
  });
});

describe("the narrow, stacked layout", () => {
  it("shows the nav first, with no Back button and no full-screen toggle", () => {
    const html = render({ layout: "stacked", pane: "nav" });
    expect(html).toContain('data-layout="stacked" data-pane="nav"');
    expect(html).not.toContain("Back to categories");
    expect(html).not.toContain("full screen");
    // The nav is visible, the content pane is hidden — not removed, so its scroll survives.
    expect(html).toMatch(/<nav[^>]*aria-label="Settings categories"(?![^>]*hidden)/);
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*data-settings-content/);
  });

  it("drilled into a category, the Back path is in the header and the nav is hidden", () => {
    const html = render({ layout: "stacked", pane: "content", active: "kinds" });
    expect(html).toContain('aria-label="Back to categories"');
    expect(html).toMatch(/<nav[^>]*hidden=""/);
    expect(html).toContain("content for kinds");
  });

  it("uses the full viewport, so nothing inside is clipped by a centred frame", () => {
    expect(settingsFrameClass("drawer", "stacked")).toBe("inset-0 rounded-none");
  });
});

describe("full-screen mode", () => {
  it("is offered on the wide layout and reads as enter/exit per mode", () => {
    const drawer = render({ mode: "drawer" });
    expect(drawer).toContain('aria-label="Enter full screen"');
    expect(drawer).toContain('aria-pressed="false"');
    const full = render({ mode: "full" });
    expect(full).toContain('aria-label="Exit full screen"');
    expect(full).toContain('aria-pressed="true"');
    expect(full).toContain('data-mode="full"');
  });

  it("changes the frame and nothing else — the drawer route and the nav stay", () => {
    expect(settingsFrameClass("full", "two-pane")).toBe("inset-0 rounded-none");
    expect(settingsFrameClass("drawer", "two-pane")).toContain("top-1/2");
    expect(render({ mode: "full" })).toContain('data-settings-category="pigeons"');
  });
});

describe("the route", () => {
  it("is closed without the parameter, open on the first category with it bare, focused with a value", () => {
    expect(readSettingsRoute("")).toBeNull();
    expect(readSettingsRoute("?graph=abc")).toBeNull();
    expect(readSettingsRoute("?settings")).toEqual({ category: "" });
    expect(readSettingsRoute("?token=t&settings=kinds")).toEqual({ category: "kinds" });
  });

  it("a deep link focuses its category; an unknown or bare one lands on the first", () => {
    expect(resolveCategory(CATEGORIES, "kinds")).toBe("kinds");
    expect(resolveCategory(CATEGORIES, "pigeons")).toBe("pigeons");
    expect(resolveCategory(CATEGORIES, "")).toBe("statuses");
    expect(resolveCategory(CATEGORIES, "nope")).toBe("statuses");
    expect(resolveCategory([], "kinds")).toBeNull();
  });

  it("withSettingsRoute sets exactly one parameter and leaves the rest alone", () => {
    const href = "http://localhost:4400/?token=abc&graph=xyz";
    const opened = new URL(withSettingsRoute(href, ""));
    expect(opened.searchParams.get(SETTINGS_PARAM)).toBe("");
    expect(opened.searchParams.get("token")).toBe("abc");
    expect(opened.searchParams.get("graph")).toBe("xyz");
    const focused = new URL(withSettingsRoute(opened.toString(), "kinds"));
    expect(readSettingsRoute(focused.search)).toEqual({ category: "kinds" });
    const closed = new URL(withSettingsRoute(focused.toString(), null));
    expect(closed.searchParams.has(SETTINGS_PARAM)).toBe(false);
    expect(closed.searchParams.get("token")).toBe("abc");
  });

  it("closing pops the entry the shell pushed, and strips the parameter after a deep link", () => {
    expect(closeAction(true)).toBe("history-back");
    expect(closeAction(false)).toBe("replace-url");
  });
});

describe("scroll memory", () => {
  it("returns a category to where it was left, and a new one to the top", () => {
    const memory: ScrollMemory = new Map();
    rememberScroll(memory, "statuses", 240);
    rememberScroll(memory, null, 999);
    expect(recallScroll(memory, "statuses")).toBe(240);
    expect(recallScroll(memory, "kinds")).toBe(0);
    expect(recallScroll(memory, null)).toBe(0);
  });
});
