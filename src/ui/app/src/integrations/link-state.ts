/**
 * How a linked issue or pull request reads: its tone, its state word, its shortest key,
 * where it lives and how old the saved copy is. Pure, so every surface (task rows, task
 * detail, the External links tab, the link dialog) says the same thing about the same link.
 */
import type { SourceItem } from "./model";

/**
 * One tone per meaning, mapped onto the app's existing status hues (parts.tsx):
 * open = done green, merged = in-review purple, active = in-progress blue. A state
 * the provider did not name, or one we cannot classify, stays neutral.
 */
export type LinkTone = "open" | "merged" | "active" | "done" | "closed" | "draft" | "neutral";

type Status = { id: string; name: string; category?: string } | null | undefined;

const statusOf = (item: SourceItem): Status => ("status" in item ? item.status : null);

export function linkTone(item: SourceItem): LinkTone {
  const status = statusOf(item);
  if (!status) return "neutral";
  // A provider workflow category, when the server supplies one (Linear state types).
  switch (status.category) {
    case "started": return "active";
    case "completed": return "done";
    case "canceled": return "closed";
    case "backlog":
    case "unstarted": return "neutral";
  }
  if (item.ref.providerId !== "github") return "neutral";
  switch (status.id.toLowerCase()) {
    case "open": return "open";
    case "merged": return "merged";
    case "closed": return "closed";
    case "draft": return "draft";
    default: return "neutral";
  }
}

/** The provider's own word, capitalised ("merged" → "Merged"). Null when no state was read. */
export function stateLabel(item: SourceItem): string | null {
  const name = statusOf(item)?.name.trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

export function providerName(providerId: string): string {
  if (providerId === "github") return "GitHub";
  if (providerId === "linear") return "Linear";
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/** `owner/repo` for a GitHub key, the team key for a Linear one (`ENG-4` → `ENG`). */
export function containerLabel(item: SourceItem): string {
  const hash = item.key.lastIndexOf("#");
  if (hash > 0) return item.key.slice(0, hash);
  const dash = item.key.lastIndexOf("-");
  return dash > 0 ? item.key.slice(0, dash) : item.key;
}

/**
 * The shortest key that is still unambiguous among `peers` (the links shown beside it).
 * `owner/repo#218` becomes `#218` when every peer is in that repository, `repo#218` when the
 * repository names differ, and stays whole when two owners share a repository name.
 */
export function shortKey(item: SourceItem, peers: readonly SourceItem[]): string {
  const hash = item.key.lastIndexOf("#");
  if (hash <= 0) return item.key;
  const container = item.key.slice(0, hash);
  const number = item.key.slice(hash);
  const containers = new Set(peers.map(containerLabel));
  containers.add(container);
  if (containers.size === 1) return number;
  const repo = container.slice(container.lastIndexOf("/") + 1);
  const sameRepoName = [...containers].filter((c) => c.slice(c.lastIndexOf("/") + 1) === repo);
  return sameRepoName.length === 1 ? `${repo}${number}` : item.key;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SavedAge {
  /** Compact, for a column: "now", "2 min", "3 hr", "1 d". */
  short: string;
  /** In a sentence: "Saved copy from 2 min ago". */
  sentence: string;
  /** Older than a day: worth refreshing before trusting the state. */
  stale: boolean;
}

/** Null when the source was linked by URL and never read. */
export function savedAge(item: SourceItem, now = Date.now()): SavedAge | null {
  const fetchedAt = "fetchedAt" in item ? item.fetchedAt : null;
  const at = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (Number.isNaN(at)) return null;
  const age = Math.max(0, now - at);
  const stale = age > DAY;
  if (age < MINUTE) return { short: "now", sentence: "Saved copy from just now", stale };
  const [count, unit] =
    age < HOUR ? [Math.floor(age / MINUTE), "min"] : age < DAY ? [Math.floor(age / HOUR), "hr"] : [Math.floor(age / DAY), "d"];
  return { short: `${count} ${unit}`, sentence: `Saved copy from ${count} ${unit} ago`, stale };
}

// A state we cannot classify (neutral) may still be in motion, so it ranks ahead of everything finished.
const TONE_RANK: Record<LinkTone, number> = { open: 0, active: 1, draft: 2, neutral: 3, merged: 4, done: 5, closed: 6 };

/** A badge that stands for several links wears the tone of the one most in motion. */
export function leadingTone(tones: readonly LinkTone[]): LinkTone {
  return tones.reduce<LinkTone>((best, tone) => (TONE_RANK[tone] < TONE_RANK[best] ? tone : best), tones[0] ?? "neutral");
}
