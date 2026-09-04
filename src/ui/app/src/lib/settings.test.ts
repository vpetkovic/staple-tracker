/**
 * THE ACCESSORS OTHER TICKETS CONSUME — O7b (STA-141).
 *
 * `lib/settings.ts` is the module the O3 chain wires the tree through, so what this suite
 * actually pins is the CONTRACT rather than the implementation:
 *
 *   - the seed is a correct default workspace, not a placeholder — a surface that renders
 *     before the fetch resolves must be right, not blank;
 *   - `configuredGroupOrder()` is a drop-in for tree-model's
 *     `GROUP_ORDER = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]` on a default workspace,
 *     which is what makes the wiring a substitution and not a redesign;
 *   - every accessor is TOTAL. An id nobody has heard of gets an answer, because the wire
 *     can carry a status another process added a second ago and a render path is the worst
 *     place to discover that;
 *   - and the whole thing survives a workspace where every built-in id has been renamed
 *     away, which is the only test that actually proves nothing kept a string literal.
 *
 * No React, no fetch: the module state is driven directly through
 * `publishWorkspaceSettings`, which is exactly what the hook and the editor do.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredGroupOrder,
  configuredKindOrder,
  configuredOpenStatuses,
  configuredStatusOrder,
  isResolvedStatus,
  kindAppearance,
  kindLabel,
  publishWorkspaceSettings,
  requiresMigrateTo,
  resetWorkspaceSettings,
  settingCategories,
  settingDefinitions,
  settingValue,
  statusCategory,
  statusLabel,
  statusRank,
  titleCaseId,
  usageCount,
  workspaceSettings,
} from "./settings";
import { OPEN_STATUS_ORDER, RESOLVED_STATUSES, STATUS_CATEGORIES } from "./types";
import type { SettingDefinitionView, WorkspaceSettingsEnvelope } from "./settings";
import type { StatusCategory, WorkspaceSettings, WorkspaceStatus } from "./types";

const status = (id: string, category: StatusCategory, label = id): WorkspaceStatus => ({
  id,
  label,
  category,
  sortOrder: 0,
  isBuiltin: false,
});

/**
 * The category tiers `store.statusOrder()` sorts by — `LIST_CATEGORY_ORDER` in
 * src/core/types.ts. Restated here ONLY to build realistic fixtures: the client does not
 * compute this, the server sends it, and the whole argument for that is in the comment on
 * `configuredGroupOrder()`. A fixture that shipped the raw configured order as
 * `groupOrder` would be testing a response the server cannot produce.
 */
const TIERS: readonly StatusCategory[] = [
  "active",
  "review",
  "gated",
  "blocked",
  "ready",
  "unstarted",
  "done",
  "cancelled",
];

/** What the server would compute for these statuses. */
function serverOrders(statuses: readonly WorkspaceStatus[]) {
  const ranked = [...statuses].sort(
    (a, b) => TIERS.indexOf(a.category) - TIERS.indexOf(b.category),
  );
  const groupOrder = ranked.map((s) => s.id);
  const openOrder = ranked.filter((s) => !["done", "cancelled"].includes(s.category)).map((s) => s.id);
  const pickupOrder = ranked
    .filter((s) => ["active", "review", "ready", "unstarted"].includes(s.category))
    .map((s) => s.id);
  return { groupOrder, openOrder, pickupOrder };
}

function settings(over: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  const statuses = over.statuses ?? [];
  return {
    workspace: "test",
    statuses,
    kinds: [],
    ...serverOrders(statuses),
    categories: [...STATUS_CATEGORIES],
    requiredCategories: ["unstarted", "ready", "active", "blocked", "done", "cancelled"],
    usage: { statuses: {}, kinds: {} },
    ...over,
  };
}

afterEach(() => resetWorkspaceSettings());

describe("the seed", () => {
  it("is a correct default workspace before anything is fetched", () => {
    const seeded = workspaceSettings();
    expect(seeded.statuses.map((s) => s.id)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "awaiting_approval",
      "done",
      "blocked",
      "cancelled",
    ]);
    expect(seeded.kinds.map((k) => k.id)).toEqual(["epic", "task", "bug", "chore", "spike"]);
  });

  it("carries the real categories, so the first paint is not eight grey glyphs", () => {
    expect(statusCategory("in_progress")).toBe("active");
    expect(statusCategory("in_review")).toBe("review");
    expect(statusCategory("awaiting_approval")).toBe("gated");
    expect(statusCategory("backlog")).toBe("unstarted");
    expect(statusCategory("todo")).toBe("ready");
    expect(statusCategory("blocked")).toBe("blocked");
    expect(statusCategory("done")).toBe("done");
    expect(statusCategory("cancelled")).toBe("cancelled");
  });

  /**
   * THE DROP-IN CLAIM, stated as an assertion. `views/tree/tree-model.ts` derives
   * `GROUP_ORDER` from the two frozen constants; on a default workspace this accessor
   * produces the identical list, so the orchestrator's wiring is a substitution.
   */
  it("configuredGroupOrder() equals tree-model's GROUP_ORDER for a default workspace", () => {
    expect(configuredGroupOrder()).toEqual([...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]);
  });
});

describe("the two orders, and which one groups", () => {
  /**
   * CONFIGURED order is the dialog's own list — the sequence the drag produces. It is
   * what the editor paints, and it is deliberately NOT what a group header list uses.
   */
  it("configuredStatusOrder() is the served configured order, verbatim", () => {
    publishWorkspaceSettings(
      settings({
        statuses: [status("c", "active"), status("a", "ready"), status("b", "unstarted")],
      }),
    );
    expect(configuredStatusOrder()).toEqual(["c", "a", "b"]);
  });

  /**
   * LIST RANK is what groups. The server sends it; this asserts the accessor hands back
   * what it was sent rather than re-deriving anything.
   */
  it("configuredGroupOrder() is the server\'s list rank, not the configured order", () => {
    publishWorkspaceSettings(
      settings({
        statuses: [
          status("backlog", "unstarted"),
          status("todo", "ready"),
          status("in_progress", "active"),
          status("done", "done"),
        ],
      }),
    );
    expect(configuredStatusOrder()).toEqual(["backlog", "todo", "in_progress", "done"]);
    expect(configuredGroupOrder()).toEqual(["in_progress", "todo", "backlog", "done"]);
  });

  /**
   * A drag that reorders two statuses IN THE SAME TIER moves their headers — which is
   * what "configured order drives group headers" means once every behaviour keys off the
   * category. Moving one ACROSS tiers is a recategorize, which the dialog offers as a
   * select beside the drag handle.
   */
  it("a reorder within a tier moves the group headers", () => {
    const pairing = status("pairing", "active");
    const soloing = status("soloing", "active");
    publishWorkspaceSettings(settings({ statuses: [pairing, soloing, status("done", "done")] }));
    expect(configuredGroupOrder()).toEqual(["pairing", "soloing", "done"]);

    publishWorkspaceSettings(settings({ statuses: [soloing, pairing, status("done", "done")] }));
    expect(configuredGroupOrder()).toEqual(["soloing", "pairing", "done"]);
  });

  it("resolved statuses sort last, and drop out of the open list", () => {
    publishWorkspaceSettings(
      settings({
        statuses: [
          status("done", "done"),
          status("cancelled", "cancelled"),
          status("todo", "ready"),
          status("wip", "active"),
        ],
      }),
    );
    expect(configuredGroupOrder()).toEqual(["wip", "todo", "done", "cancelled"]);
    expect(configuredOpenStatuses()).toEqual(["wip", "todo"]);
  });

  it("statusRank sorts by group order and puts an unknown id last", () => {
    publishWorkspaceSettings(
      settings({ statuses: [status("a", "ready"), status("b", "active"), status("z", "done")] }),
    );
    expect(statusRank("b")).toBe(0);
    expect(statusRank("a")).toBe(1);
    expect(statusRank("z")).toBe(2);
    expect(statusRank("never-heard-of-it")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("configuredKindOrder() is the served kind order", () => {
    publishWorkspaceSettings(
      settings({
        kinds: [
          { id: "research", label: "Research", sortOrder: 0, isBuiltin: false },
          { id: "task", label: "Task", sortOrder: 1, isBuiltin: true },
        ],
      }),
    );
    expect(configuredKindOrder()).toEqual(["research", "task"]);
    expect(kindLabel("research")).toBe("Research");
  });
});

describe("kind appearance (R5a, STA-181)", () => {
  it("wears the built-in marks on the seed, so the first paint is right before the fetch", () => {
    expect(kindAppearance("epic")).toEqual({ source: "lucide", value: "layers", label: "Epic", fallback: "◆" });
    expect(kindAppearance("spike")).toEqual({ source: "lucide", value: "zap", label: "Spike", fallback: "↯" });
  });

  it("answers what the server resolved, verbatim, and falls back for a row served without one", () => {
    publishWorkspaceSettings(
      settings({
        kinds: [
          { id: "epic", label: "Initiative", sortOrder: 0, isBuiltin: true, appearance: { source: "emoji", value: "🚀", label: "Initiative", fallback: "E" } },
          { id: "research", label: "Research", sortOrder: 1, isBuiltin: false },
          { id: "milestone", label: "Milestone", sortOrder: 2, isBuiltin: false },
        ] as WorkspaceSettings["kinds"],
      }),
    );
    expect(kindAppearance("epic")).toEqual({ source: "emoji", value: "🚀", label: "Initiative", fallback: "E" });
    expect(kindAppearance("research")).toEqual({ source: "none", value: "", label: "Research", fallback: "•" });
    expect(kindAppearance("milestone")).toEqual({ source: "lucide", value: "milestone", label: "Milestone", fallback: "⚑" });
  });

  it("is total: an id nobody configured gets the generic mark and a title-cased label", () => {
    expect(kindAppearance("not_here")).toEqual({ source: "none", value: "", label: "Not Here", fallback: "•" });
  });
});

describe("behaviour keys off the category, never off the id", () => {
  /**
   * The test that actually proves it. Every built-in id is renamed away, so any guard
   * that kept a string literal would answer wrongly here and nowhere else.
   */
  it("survives a workspace where no built-in id remains", () => {
    publishWorkspaceSettings(
      settings({
        statuses: [
          status("icebox", "unstarted", "Icebox"),
          status("queued", "ready", "Queued"),
          status("pairing", "active", "Pairing"),
          status("checking", "review", "Checking"),
          status("stuck", "blocked", "Stuck"),
          status("shipped", "done", "Shipped"),
          status("dropped", "cancelled", "Dropped"),
        ],
      }),
    );

    expect(statusCategory("pairing")).toBe("active");
    expect(statusLabel("pairing")).toBe("Pairing");
    expect(isResolvedStatus("shipped")).toBe(true);
    expect(isResolvedStatus("dropped")).toBe(true);
    expect(isResolvedStatus("stuck")).toBe(false);
    expect(configuredGroupOrder()).toEqual([
      "pairing",
      "checking",
      "stuck",
      "queued",
      "icebox",
      "shipped",
      "dropped",
    ]);
    // The built-in ids are now the unknown ones, and they answer without throwing.
    expect(statusCategory("in_progress")).toBe("unstarted");
    expect(isResolvedStatus("done")).toBe(false);
  });

  it("a recategorised status changes what it MEANS, not just what it is called", () => {
    publishWorkspaceSettings(settings({ statuses: [status("in_review", "done", "In Review")] }));
    expect(isResolvedStatus("in_review")).toBe(true);
  });

  it("gated is open, not resolved", () => {
    publishWorkspaceSettings(settings({ statuses: [status("awaiting_approval", "gated")] }));
    expect(isResolvedStatus("awaiting_approval")).toBe(false);
    expect(configuredOpenStatuses()).toEqual(["awaiting_approval"]);
  });
});

describe("every accessor is total", () => {
  it("an unknown status is unstarted, unresolved, and title-cased", () => {
    expect(statusCategory("added_in_another_tab")).toBe("unstarted");
    expect(isResolvedStatus("added_in_another_tab")).toBe(false);
    expect(statusLabel("added_in_another_tab")).toBe("Added In Another Tab");
    expect(kindLabel("spike_ish")).toBe("Spike Ish");
  });

  it("titleCaseId mirrors the store's own derivation", () => {
    expect(titleCaseId("awaiting_approval")).toBe("Awaiting Approval");
    expect(titleCaseId("todo")).toBe("Todo");
    expect(titleCaseId("a__b")).toBe("A B");
  });
});

describe("usage and the migrate-to requirement", () => {
  it("asks for a target when rows reference the id", () => {
    publishWorkspaceSettings(settings({ usage: { statuses: { todo: 3, blocked: 0 }, kinds: {} } }));
    expect(requiresMigrateTo("statuses", "todo")).toBe(true);
    expect(usageCount("statuses", "todo")).toBe(3);
  });

  it("does not ask when the server counted zero", () => {
    publishWorkspaceSettings(settings({ usage: { statuses: { blocked: 0 }, kinds: {} } }));
    expect(requiresMigrateTo("statuses", "blocked")).toBe(false);
    expect(usageCount("statuses", "blocked")).toBe(0);
  });

  /**
   * Not-known errs toward ASKING. The cheap mistake is one unnecessary select on a
   * removal that did not need it; the expensive one is sending a removal the store
   * refuses and showing the user a failure where a field belonged.
   */
  it("asks when the count is simply not known yet", () => {
    publishWorkspaceSettings(settings());
    expect(requiresMigrateTo("statuses", "anything")).toBe(true);
    expect(usageCount("statuses", "anything")).toBeNull();
  });
});

// --------------------------------------------------- the registry (R6a, STA-176)

/** A definition as the server would serve one; the test invents the KEY, not the shape. */
const definition = (key: string, scope: "workspace" | "global", over: Partial<SettingDefinitionView> = {}): SettingDefinitionView => ({
  key,
  category: key.split(".")[0]!,
  scope,
  schema: { type: "boolean" },
  default: false,
  version: 1,
  sensitivity: "normal",
  ui: { label: key, description: "", control: "toggle", order: 1 },
  ...over,
});

function envelope(over: Partial<WorkspaceSettingsEnvelope> = {}): WorkspaceSettingsEnvelope {
  return {
    ...settings(),
    registry: { categories: [], definitions: [] },
    values: {},
    unknownKeys: [],
    global: { path: "/home/config.json", present: false, values: {} },
    ...over,
  };
}

describe("the registry accessors", () => {
  it("know nothing before the fetch rather than inventing a client-side copy of the registry", () => {
    expect(settingCategories()).toEqual([]);
    expect(settingDefinitions()).toEqual([]);
    expect(settingValue("kinds.default")).toBeUndefined();
  });

  it("accept a bare vocabulary envelope from a fixture that predates the registry", () => {
    publishWorkspaceSettings(settings());
    expect(workspaceSettings().registry).toEqual({ categories: [], definitions: [] });
    expect(workspaceSettings().unknownKeys).toEqual([]);
  });

  it("enumerate categories and definitions from what the server said, per scope and per category", () => {
    publishWorkspaceSettings(
      envelope({
        registry: {
          categories: [
            { id: "kinds", label: "Kinds", description: "", scope: "workspace", editor: "kinds", order: 20 },
            { id: "machine", label: "This machine", description: "", scope: "global", editor: "fields", order: 90 },
            { id: "features", label: "Features", description: "", scope: "workspace", editor: "fields", order: 30 },
          ],
          definitions: [
            definition("kinds.default", "workspace", { schema: { type: "string" }, default: "task" }),
            definition("features.darkLaunch", "workspace"),
            definition("machine.port", "global", { schema: { type: "integer", min: 1, max: 65535 }, default: 4400 }),
          ],
        },
      }),
    );
    // A category the client has never heard of is listed — nothing here hard-codes the tabs.
    expect(settingCategories().map((c) => c.id)).toEqual(["kinds", "machine", "features"]);
    expect(settingCategories("workspace").map((c) => c.id)).toEqual(["kinds", "features"]);
    expect(settingDefinitions("features").map((d) => d.key)).toEqual(["features.darkLaunch"]);
  });

  it("answer a value from the workspace, from the global store, or from the definition's default", () => {
    publishWorkspaceSettings(
      envelope({
        registry: {
          categories: [],
          definitions: [
            definition("kinds.default", "workspace", { schema: { type: "string" }, default: "task" }),
            definition("features.darkLaunch", "workspace"),
            definition("machine.port", "global", { schema: { type: "integer" }, default: 4400 }),
          ],
        },
        values: {
          "kinds.default": { key: "kinds.default", scope: "workspace", value: "bug", source: "workspace", version: 1 },
        },
        global: {
          path: "/home/config.json",
          present: true,
          values: { "machine.port": { key: "machine.port", scope: "global", value: 4500, source: "config", version: 1 } },
        },
      }),
    );
    expect(settingValue("kinds.default")).toEqual({
      key: "kinds.default",
      scope: "workspace",
      value: "bug",
      source: "workspace",
      version: 1,
    });
    expect(settingValue("machine.port")).toEqual({ key: "machine.port", scope: "global", value: 4500, source: "config", version: 1 });
    expect(settingValue("features.darkLaunch")).toEqual({
      key: "features.darkLaunch",
      scope: "workspace",
      value: false,
      source: "default",
      version: 1,
    });
    expect(settingValue("nobody.knows")).toBeUndefined();
  });
});
