import type { HorizonData } from "@/lib/plan-types";

export function countWord(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A horizon's counts, as the server gives them: leaf ideas (a parent apart from its children), then members. */
export function planCounts(horizon: Pick<HorizonData, "records" | "memberCount">): string {
  const parents = horizon.records.parentCount ? ` (+${countWord(horizon.records.parentCount, "parent")})` : "";
  return `${countWord(horizon.records.leaves, "idea")}${parents} · ${countWord(horizon.memberCount, "member")}`;
}
