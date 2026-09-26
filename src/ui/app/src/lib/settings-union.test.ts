/**
 * All workspaces paints every workspace's rows with ONE vocabulary: the union of every
 * workspace's statuses and kinds (`mergeWorkspaceVocabularies`). These pin the dedup rule,
 * the re-derived orders, and that what the quick filters offer follows the union.
 */
import { afterEach, describe, expect, it } from "vitest";
import { filterPresets } from "@/components/filters/presets";
import { presetContextNow } from "@/components/filters/FilterChips";
import {
  SEED_SETTINGS,
  configuredGroupOrder,
  configuredKindOrder,
  kindLabel,
  mergeWorkspaceVocabularies,
  publishWorkspaceSettings,
  resetWorkspaceSettings,
  statusCategory,
  statusLabel,
  type WorkspaceSettingsEnvelope,
} from "./settings";
import type { StatusCategory } from "./types";

const EMPTY_REGISTRY = {
  registry: { categories: [], definitions: [] },
  values: {},
  unknownKeys: [],
  global: { path: "", present: false, values: {} },
};

function envelope(
  workspace: string,
  statuses: [string, string, StatusCategory][],
  kinds: [string, string][],
  usage: Record<string, number> = {},
): WorkspaceSettingsEnvelope {
  return {
    ...SEED_SETTINGS,
    ...EMPTY_REGISTRY,
    workspace,
    statuses: statuses.map(([id, label, category], sortOrder) => ({ id, label, category, sortOrder, isBuiltin: false })),
    kinds: kinds.map(([id, label], sortOrder) => ({ id, label, sortOrder, isBuiltin: false, appearance: { source: "lucide", value: "square", label, fallback: "□" } })) as WorkspaceSettingsEnvelope["kinds"],
    usage: { statuses: usage, kinds: {} },
  } as WorkspaceSettingsEnvelope;
}

const STAPLE = envelope(
  "staple",
  [["backlog", "Backlog", "unstarted"], ["todo", "Todo", "ready"], ["in_progress", "In Progress", "active"], ["blocked", "Blocked", "blocked"], ["done", "Done", "done"]],
  [["task", "Task"], ["epic", "Epic"]],
  { todo: 3 },
);
const PINECONE = envelope(
  "pinecone",
  [["todo", "To do (pinecone)", "unstarted"], ["pairing", "Pairing", "active"], ["qa", "In QA", "review"], ["done", "Shipped", "done"], ["cancelled", "Dropped", "cancelled"]],
  [["bug", "Bug"], ["task", "Ticket"]],
  { todo: 2, pairing: 1 },
);

afterEach(() => resetWorkspaceSettings());

describe("the union of every workspace's vocabulary", () => {
  const merged = mergeWorkspaceVocabularies([STAPLE, PINECONE])!;

  it("lists every id once, in order of first appearance across workspaces in hub order", () => {
    expect(merged.statuses.map((s) => s.id)).toEqual(["backlog", "todo", "in_progress", "blocked", "done", "pairing", "qa", "cancelled"]);
    expect(merged.kinds.map((k) => k.id)).toEqual(["task", "epic", "bug"]);
    expect(merged.statuses.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("lets the first workspace in hub order decide a shared id's label and category", () => {
    const todo = merged.statuses.find((s) => s.id === "todo")!;
    expect(todo).toMatchObject({ label: "Todo", category: "ready" });
    expect(merged.statuses.find((s) => s.id === "done")!.label).toBe("Done");
    expect(merged.kinds.find((k) => k.id === "task")!.label).toBe("Task");
    // …and the other order answers the other way, which is the rule, not an accident.
    const reversed = mergeWorkspaceVocabularies([PINECONE, STAPLE])!;
    expect(reversed.statuses.find((s) => s.id === "todo")).toMatchObject({ label: "To do (pinecone)", category: "unstarted" });
  });

  it("re-derives the list, open and pickup orders by category tier, as the store does", () => {
    expect(merged.groupOrder).toEqual(["in_progress", "pairing", "qa", "blocked", "todo", "backlog", "done", "cancelled"]);
    expect(merged.openOrder).toEqual(["in_progress", "pairing", "qa", "blocked", "todo", "backlog"]);
    expect(merged.pickupOrder).toEqual(["in_progress", "pairing", "qa", "todo", "backlog"]);
  });

  it("adds usage up, and belongs to no workspace", () => {
    expect(merged.usage.statuses).toEqual({ todo: 5, pairing: 1 });
    expect(merged.workspace).toBe("");
  });

  it("is the workspace itself with one, and nothing with none", () => {
    expect(mergeWorkspaceVocabularies([STAPLE])).toBe(STAPLE);
    expect(mergeWorkspaceVocabularies([])).toBeNull();
  });
});

describe("what the page offers on All workspaces follows the union", () => {
  it("paints a status only the second workspace has, instead of an unknown id", () => {
    publishWorkspaceSettings(mergeWorkspaceVocabularies([STAPLE, PINECONE])!);
    expect(statusLabel("pairing")).toBe("Pairing");
    expect(statusCategory("pairing")).toBe("active");
    expect(kindLabel("bug")).toBe("Bug");
    expect(configuredGroupOrder()[1]).toBe("pairing");
    expect(configuredKindOrder()).toContain("bug");
  });

  it("makes In progress cover every workspace's active statuses, and offers Bugs when any workspace has them", () => {
    publishWorkspaceSettings(mergeWorkspaceVocabularies([STAPLE, PINECONE])!);
    const presets = filterPresets(presetContextNow(null));
    expect(presets.find((p) => p.id === "in-progress")!.dims).toEqual({ status: ["in_progress", "pairing"] });
    expect(presets.map((p) => p.id)).toContain("bugs");
    // The first workspace alone — what All workspaces used to get — would have missed both.
    publishWorkspaceSettings(STAPLE);
    const firstOnly = filterPresets(presetContextNow(null));
    expect(firstOnly.find((p) => p.id === "in-progress")!.dims).toEqual({ status: ["in_progress"] });
    expect(firstOnly.map((p) => p.id)).not.toContain("bugs");
  });
});
