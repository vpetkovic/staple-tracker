/**
 * The Settings sheet — R6b (STA-177), made global — in the two halves a test can hold.
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
import { CLOUD_CATEGORY } from "./cloud-settings";
import { TELEMETRY_CATEGORY } from "./telemetry-settings";
import {
  HUB_REGISTRY_CATEGORY,
  SETTINGS_PARAM,
  SETTINGS_WS_PARAM,
  WORKSPACE_CLOUD_CATEGORY,
  appliesToText,
  closeAction,
  needsWorkspaceChoice,
  settingsTarget,
  withShellCategories,
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
  /**
   * DELIBERATELY CHANGED from "Work Workspace Settings". The sheet is the computer's and
   * every workspace's; a title naming a workspace was the thing that made All workspaces
   * read as "the first workspace".
   */
  it("is titled exactly Settings, and never names a workspace", () => {
    expect(SETTINGS_TITLE).toBe("Settings");
    expect(render()).toContain(">Settings</h2>");
    expect(render()).not.toContain("Workspace Settings");
  });

  it("says what the sheet holds, and names a workspace only when one is being edited", () => {
    expect(render()).toContain("Settings for this computer, and for the workspace &quot;staple&quot;.");
    // All workspaces with nothing chosen: no workspace is claimed at all.
    const all = render({ scope: { ...SCOPE, workspace: "" } });
    expect(all).toContain("Settings for this computer and for each of your workspaces, in one place.");
    expect(all).not.toContain("&quot;staple&quot;");
    expect(all).not.toContain("Applies to staple");
    expect(scopeSummaryText({ workspace: "", globalPath: "", globalPresent: false })).not.toMatch(/Editing|workspace "/);
  });

  it("uses the heading element it is handed, so the dialog can supply DialogTitle", () => {
    const html = render({ TitleTag: "h1" });
    expect(html).toContain(">Settings</h1>");
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

  it("lists the global sections apart from, and above, the per-workspace ones", () => {
    const html = render();
    const across = html.indexOf(">Across all workspaces<");
    const per = html.indexOf(">Per workspace<");
    expect(across).toBeGreaterThan(-1);
    expect(per).toBeGreaterThan(across);
    // The global section sits under its own heading; every workspace section under the other.
    expect(html.indexOf("This machine")).toBeGreaterThan(across);
    expect(html.indexOf("This machine")).toBeLessThan(per);
    for (const label of ["Statuses", "Kinds", "Pigeon lofts"]) expect(html.lastIndexOf(label)).toBeGreaterThan(per);
    expect(html).toContain('data-settings-group="global"');
    expect(html).toContain('data-settings-group="workspace"');
  });

  it("marks the selected section and renders only its content, saying which workspace it applies to", () => {
    const html = render({ active: "pigeons" });
    expect(html).toContain('data-settings-category="pigeons" aria-current="page"');
    expect(html).toContain("content for pigeons");
    expect(html).not.toContain("content for statuses");
    expect(html).toContain("Applies to staple only");
    expect(html).toContain("About pigeons.");
  });

  it("a global section says it applies everywhere", () => {
    expect(render({ active: "machine" })).toContain("Applies to every workspace on this computer");
    expect(appliesToText("workspace", "")).toBe("Applies to one workspace at a time");
  });

  it("puts the workspace picker above a per-workspace section, and never above a global one", () => {
    const picker = <select data-testid="picker" />;
    const workspace = render({ active: "statuses", workspacePicker: picker });
    expect(workspace).toContain("data-settings-workspace-picker");
    expect(workspace.indexOf('data-testid="picker"')).toBeLessThan(workspace.indexOf("content for statuses"));
    const global = render({ active: "machine", workspacePicker: picker });
    expect(global).not.toContain("data-settings-workspace-picker");
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

  it("uses the full dynamic viewport, so nothing inside is clipped by a centred frame or a toolbar", () => {
    expect(settingsFrameClass("drawer", "stacked")).toBe("inset-x-0 top-0 h-dvh rounded-none");
  });

  it("is a list of sections with 44px rows and a chevron, then the section with Back", () => {
    const list = render({ layout: "stacked", pane: "nav" });
    expect(list).toMatch(/data-settings-category="statuses"[^>]*class="[^"]*min-h-12/);
    expect(list).toContain("lucide-chevron-right");
    const section = render({ layout: "stacked", pane: "content", active: "statuses" });
    expect(section).toMatch(/aria-label="Back to categories"[^>]*class="[^"]*size-11|class="[^"]*size-11[^"]*"[^>]*aria-label="Back to categories"/);
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
    expect(readSettingsRoute("?settings")).toEqual({ category: "", workspace: "" });
    expect(readSettingsRoute("?token=t&settings=kinds")).toEqual({ category: "kinds", workspace: "" });
  });

  it("a deep link can name the workspace a per-workspace section edits", () => {
    expect(readSettingsRoute("?view=tasks&settings=statuses&settings-ws=pinecone")).toEqual({
      category: "statuses",
      workspace: "pinecone",
    });
  });

  it("a deep link focuses its category; an unknown or bare one lands on the first", () => {
    expect(resolveCategory(CATEGORIES, "kinds")).toBe("kinds");
    expect(resolveCategory(CATEGORIES, "pigeons")).toBe("pigeons");
    expect(resolveCategory(CATEGORIES, "")).toBe("statuses");
    expect(resolveCategory(CATEGORIES, "nope")).toBe("statuses");
    expect(resolveCategory([], "kinds")).toBeNull();
  });

  it("withSettingsRoute sets its own parameters and leaves the rest alone", () => {
    const href = "http://localhost:4400/?token=abc&graph=xyz&view=tasks";
    const opened = new URL(withSettingsRoute(href, ""));
    expect(opened.searchParams.get(SETTINGS_PARAM)).toBe("");
    expect(opened.searchParams.get("token")).toBe("abc");
    expect(opened.searchParams.get("graph")).toBe("xyz");
    expect(opened.searchParams.get("view")).toBe("tasks");
    const focused = new URL(withSettingsRoute(opened.toString(), "kinds"));
    expect(readSettingsRoute(focused.search)).toEqual({ category: "kinds", workspace: "" });
    const closed = new URL(withSettingsRoute(focused.toString(), null));
    expect(closed.searchParams.has(SETTINGS_PARAM)).toBe(false);
    expect(closed.searchParams.get("token")).toBe("abc");
  });

  it("changing the workspace keeps the sheet open on its section; closing drops both", () => {
    const open = withSettingsRoute("http://localhost:4400/?view=tasks", "statuses", "staple");
    const repointed = withSettingsRoute(open, "statuses", "pinecone");
    // Still open (the parameter is there), still on Statuses, now on the other workspace.
    expect(readSettingsRoute(new URL(repointed).search)).toEqual({ category: "statuses", workspace: "pinecone" });
    // A category change leaves the chosen workspace alone.
    expect(readSettingsRoute(new URL(withSettingsRoute(repointed, "kinds")).search)).toEqual({
      category: "kinds",
      workspace: "pinecone",
    });
    const closed = new URL(withSettingsRoute(repointed, null));
    expect(closed.searchParams.has(SETTINGS_PARAM)).toBe(false);
    expect(closed.searchParams.has(SETTINGS_WS_PARAM)).toBe(false);
    expect(closed.searchParams.get("view")).toBe("tasks");
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

describe("which workspace the per-workspace sections edit", () => {
  const workspaces = [
    { slug: "aardvark", prefix: "AAR" },
    { slug: "staple", prefix: "STA" },
    { slug: "pinecone", prefix: "PIN" },
  ];
  const hub = (ws: string) => ({ mode: "hub" as const, ws, workspaces });

  it("is the one the address names, when it is registered", () => {
    expect(settingsTarget(hub(""), "pinecone", "")).toBe("pinecone");
    expect(settingsTarget(hub("staple"), "pinecone", "")).toBe("pinecone");
    expect(settingsTarget(hub("staple"), "gone", "")).toBe("staple");
  });

  it("is the page's workspace when the page is on one", () => {
    expect(settingsTarget(hub("staple"), "", "pinecone")).toBe("staple");
  });

  it("on All workspaces is the remembered choice — and otherwise NOBODY, never the first workspace", () => {
    expect(settingsTarget(hub(""), "", "pinecone")).toBe("pinecone");
    expect(settingsTarget(hub(""), "", "")).toBe("");
    expect(settingsTarget(hub(""), "", "unregistered-since")).toBe("");
  });

  it("is the only workspace outside a hub", () => {
    expect(settingsTarget({ mode: "workspace", ws: "", workspaces: [workspaces[1]!] }, "", "")).toBe("staple");
  });

  it("asks only for a per-workspace section with nobody chosen", () => {
    const statuses = category("statuses");
    const machine = category("machine", { scope: "global" });
    expect(needsWorkspaceChoice(statuses, "")).toBe(true);
    expect(needsWorkspaceChoice(statuses, "staple")).toBe(false);
    expect(needsWorkspaceChoice(machine, "")).toBe(false);
    expect(needsWorkspaceChoice(null, "")).toBe(false);
  });
});

describe("the sections split out of Cloud", () => {
  it("names the computer's sections in plain words: Workspaces on this computer, Cloud account, Usage", () => {
    expect(HUB_REGISTRY_CATEGORY.label).toBe("Workspaces on this computer");
    expect(WORKSPACE_CLOUD_CATEGORY.label).toBe("Cloud sync");
    expect(CLOUD_CATEGORY.label).toBe("Cloud account");
    expect(TELEMETRY_CATEGORY.label).toBe("Usage");
    for (const label of [HUB_REGISTRY_CATEGORY.label, CLOUD_CATEGORY.label, TELEMETRY_CATEGORY.label]) {
      expect(label).not.toMatch(/registry|hub|&/i);
    }
  });

  it("adds Hub registry to the global group and Cloud sync to the per-workspace group", () => {
    const merged = withShellCategories(CATEGORIES);
    expect(merged.find((c) => c.id === HUB_REGISTRY_CATEGORY.id)?.scope).toBe("global");
    expect(merged.find((c) => c.id === WORKSPACE_CLOUD_CATEGORY.id)?.scope).toBe("workspace");
    expect(withShellCategories([])).toEqual([]);
    expect(withShellCategories(merged)).toEqual(merged);
  });
});
