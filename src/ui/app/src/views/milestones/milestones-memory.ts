/**
 * What the Milestones page remembers per workspace, in this browser: which open milestones the
 * person folded or unfolded, and whether the Finished shelf is open. Modelled on the Plan view's
 * memory (`views/plan/plan-memory.ts`): the same storage guard, bad or missing data reads as no
 * choice, and a choice for a milestone that no longer exists is dropped on the next save.
 */
import { browserStorage } from "@/views/plan/plan-memory";

export interface MilestonesMemory {
  /** Milestone id → folded. A milestone with no entry follows the page's default. */
  folded: Record<string, boolean>;
  /** The Finished shelf is open. */
  finished: boolean;
}

const defaults = (): MilestonesMemory => ({ folded: {}, finished: false });
export const milestonesMemoryKey = (workspace: string) => `staple:milestones:v1:${workspace}`;

/** The container width under which the page takes its phone form, and sections start folded. */
export const MILESTONES_NARROW = 760;

export function loadMilestonesMemory(workspace: string, storage = browserStorage()): MilestonesMemory {
  try {
    const value = JSON.parse(storage?.getItem(milestonesMemoryKey(workspace)) ?? "null");
    if (!value || typeof value !== "object") return defaults();
    const result = defaults();
    if (value.folded && typeof value.folded === "object" && !Array.isArray(value.folded)) {
      for (const [id, folded] of Object.entries(value.folded)) if (typeof folded === "boolean") result.folded[id] = folded;
    }
    if (typeof value.finished === "boolean") result.finished = value.finished;
    return result;
  } catch {
    return defaults();
  }
}

/** Saves the memory, keeping fold choices only for `existing` milestone ids. */
export function saveMilestonesMemory(workspace: string, memory: MilestonesMemory, existing: readonly string[], storage = browserStorage()): void {
  const keep = new Set(existing);
  const folded = Object.fromEntries(Object.entries(memory.folded).filter(([id]) => keep.has(id)));
  try {
    storage?.setItem(milestonesMemoryKey(workspace), JSON.stringify({ folded, finished: memory.finished }));
  } catch {
    /* Best effort per-viewer preference. */
  }
}

/** Whether a section is folded: the remembered choice, else folded only under the narrow width. */
export function sectionFolded(memory: Pick<MilestonesMemory, "folded">, id: string, narrow: boolean): boolean {
  return memory.folded[id] ?? narrow;
}

/** The one Collapse all / Expand all control: it collapses while any open section is unfolded. */
export function foldAllAction(ids: readonly string[], isFolded: (id: string) => boolean): "collapse" | "expand" {
  return ids.some((id) => !isFolded(id)) ? "collapse" : "expand";
}

/** The memory with every one of `ids` folded (collapse) or unfolded (expand). */
export function withAllFolded(memory: MilestonesMemory, ids: readonly string[], folded: boolean): MilestonesMemory {
  return { ...memory, folded: { ...memory.folded, ...Object.fromEntries(ids.map((id) => [id, folded])) } };
}
