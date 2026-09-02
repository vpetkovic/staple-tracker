/**
 * What the cmd-K palette can do, as data — owned by U7 (STA-19).
 *
 * A command here is a plain object with a discriminated `action`, never a closure. That
 * is the whole design decision in this file: ranking, contextual ordering and recency
 * are the parts most likely to be subtly wrong, and keeping them as pure functions over
 * plain data means they can be tested without React, cmdk, a DOM or a fetch. The
 * component that consumes this (CommandPalette.tsx) is deliberately a switch statement.
 *
 * Imports are relative rather than "@/…" because there is no vitest config at the repo
 * root, so the app's `@` alias — which lives in src/ui/app/vite.config.ts — does not
 * exist at test time.
 */
import { VIEWS, type Selection, type ViewName } from "../../lib/session";
import { ISSUE_STATUSES, type IssueRow, type IssueStatus, type WorkspaceRef } from "../../lib/types";

/** What running a command does. The React layer switches on `type`; nothing else does. */
export type CommandAction =
  | { type: "open"; workspace: string; ref: string }
  | { type: "status"; status: IssueStatus }
  | { type: "release" }
  /** Opens the agent-name page; the typed text becomes the checkout actor. */
  | { type: "page"; page: PalettePage }
  | { type: "view"; view: ViewName }
  | { type: "workspace"; ws: string }
  | { type: "assignee"; assignee: string };

export type PalettePage = "checkout" | "assignee";

export type CommandGroup = "issue" | "actions" | "view" | "filter";

export interface PaletteCommand {
  /** Stable across renders and across sessions — recency is keyed on it. */
  id: string;
  group: CommandGroup;
  label: string;
  /** Secondary text on the right. Never the only place information lives. */
  hint?: string;
  /** Extra words the fuzzy matcher should consider. Not rendered. */
  keywords: string;
  action: CommandAction;
}

// ---------- fuzzy matching ----------

const WORD_BREAK = /[\s\-_/.:]/;

/**
 * Subsequence match with a score, or null when the query is not a subsequence at all.
 *
 * Null rather than a large negative number on purpose: a palette that ranks
 * non-matches last still *shows* them, and a list of seven irrelevant issues under a
 * three-letter query is how a palette stops being trusted.
 *
 * Scoring favours, in order: a whole-string hit, a prefix, consecutive runs, and
 * characters that start a word — which is what makes "btn" find "the export button"
 * and "s13" find "STA-13".
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - (t.length - q.length);

  const contiguous = t.indexOf(q);
  if (contiguous >= 0) {
    // A hit at a word boundary reads as intentional; one mid-word is a coincidence.
    const boundary = contiguous === 0 || WORD_BREAK.test(t[contiguous - 1] ?? "");
    return (boundary ? 600 : 400) - contiguous;
  }

  let score = 0;
  let ti = 0;
  let run = 0;
  for (const char of q) {
    // Where the scan starts matters: a hit exactly here continues the previous run.
    // (`ti` is advanced by the scan itself, so it cannot be used for that comparison.)
    const from = ti;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === char) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found < 0) return null;
    const atWordStart = found === 0 || WORD_BREAK.test(t[found - 1] ?? "");
    run = run > 0 && found === from ? run + 1 : 1;
    score += 10 + run * 4 + (atWordStart ? 12 : 0);
    ti = found + 1;
  }
  // Shorter haystacks win ties: "STA-1" should beat "STA-100" for the query "sta1".
  return score - Math.floor(t.length / 8);
}

// ---------- jump-to-issue ----------

export interface RankedIssue {
  row: IssueRow;
  score: number;
}

/**
 * Rank issues for the jump list.
 *
 * The identifier is weighted far above the title because an identifier is what you
 * reach for when you already know which issue you want, and a title match on the way to
 * a known identifier is noise. An empty query falls back to the natural order the server
 * returned, which is already the useful one.
 */
export function rankIssues(rows: readonly IssueRow[], query: string, limit = 12): RankedIssue[] {
  const trimmed = query.trim();
  if (trimmed === "") return rows.slice(0, limit).map((row) => ({ row, score: 0 }));

  const ranked: RankedIssue[] = [];
  for (const row of rows) {
    const byId = fuzzyScore(trimmed, row.issue.identifier);
    const byTitle = fuzzyScore(trimmed, row.issue.title);
    if (byId === null && byTitle === null) continue;
    ranked.push({ row, score: Math.max((byId ?? 0) * 2, byTitle ?? 0) });
  }
  ranked.sort((a, b) => b.score - a.score || a.row.issue.identifier.localeCompare(b.row.issue.identifier));
  return ranked.slice(0, limit);
}

export function issueCommand(row: IssueRow, showWorkspace: boolean): PaletteCommand {
  const { issue } = row;
  return {
    id: `open:${row.workspace}:${issue.identifier}`,
    group: "issue",
    label: `${issue.identifier} ${issue.title}`,
    hint: showWorkspace ? `${row.workspace} · ${issue.status}` : issue.status,
    keywords: `${issue.identifier} ${issue.title} ${issue.status} ${issue.assignee ?? ""}`,
    action: { type: "open", workspace: row.workspace, ref: issue.identifier },
  };
}

// ---------- everything that is not an issue ----------

export interface PaletteContext {
  /** The issue every action command acts on. Null means the actions group is empty. */
  selection: Selection | null;
  /** Status of the selected issue, when known — used to hide a no-op transition. */
  selectionStatus?: IssueStatus | null;
  view: ViewName;
  ws: string;
  assignee: string;
  workspaces: readonly WorkspaceRef[];
  hub: boolean;
}

/**
 * Every non-issue command, in natural order. Ordering for display is a separate
 * concern — see `orderCommands`.
 */
export function buildCommands(context: PaletteContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  if (context.selection) {
    const ref = context.selection.ref;
    for (const status of ISSUE_STATUSES) {
      // The status it already has is not a command, it is a no-op that would occupy a
      // row and, if run, spend a round trip to be told nothing changed.
      if (context.selectionStatus === status) continue;
      commands.push({
        id: `status:${status}`,
        group: "actions",
        label: `Set status → ${status}`,
        hint: ref,
        keywords: `status ${status} move ${ref}`,
        action: { type: "status", status },
      });
    }
    commands.push({
      id: "checkout",
      group: "actions",
      label: "Check out as…",
      hint: ref,
      keywords: `checkout claim start agent assign ${ref}`,
      action: { type: "page", page: "checkout" },
    });
    commands.push({
      id: "release",
      group: "actions",
      label: "Release the checkout",
      hint: ref,
      keywords: `release unclaim give back ${ref}`,
      action: { type: "release" },
    });
  }

  for (const view of VIEWS) {
    if (view === context.view) continue;
    commands.push({
      id: `view:${view}`,
      group: "view",
      label: `Go to ${view}`,
      keywords: `view switch ${view}`,
      action: { type: "view", view },
    });
  }

  commands.push({
    id: "filter:assignee",
    group: "filter",
    label: "Filter by assignee…",
    hint: context.assignee || undefined,
    keywords: "filter assignee who owner mine",
    action: { type: "page", page: "assignee" },
  });
  if (context.assignee !== "") {
    commands.push({
      id: "filter:assignee:clear",
      group: "filter",
      label: "Clear the assignee filter",
      hint: context.assignee,
      keywords: "clear reset assignee filter all",
      action: { type: "assignee", assignee: "" },
    });
  }

  if (context.hub) {
    if (context.ws !== "") {
      commands.push({
        id: "ws:all",
        group: "filter",
        label: "Workspace → all",
        keywords: "workspace all every hub",
        action: { type: "workspace", ws: "" },
      });
    }
    for (const workspace of context.workspaces) {
      if (workspace.slug === context.ws) continue;
      commands.push({
        id: `ws:${workspace.slug}`,
        group: "filter",
        label: `Workspace → ${workspace.slug}`,
        hint: workspace.prefix,
        keywords: `workspace ${workspace.slug} ${workspace.prefix}`,
        action: { type: "workspace", ws: workspace.slug },
      });
    }
  }

  return commands;
}

// ---------- ordering ----------

/** How many command ids the palette remembers. Small: a long MRU stops being an MRU. */
export const RECENTS_LIMIT = 8;

export function rememberCommand(recents: readonly string[], id: string): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, RECENTS_LIMIT);
}

/**
 * Contextual first, then recent, then natural.
 *
 * "Contextual" means: acts on the issue that is open right now. If you have an issue on
 * screen, the reason you hit cmd-K is almost always to do something to it, and that
 * should not be outranked by the view switch you happened to use ten minutes ago.
 * Stable within each tier, so the natural order still shows through.
 */
export function orderCommands(
  commands: readonly PaletteCommand[],
  recents: readonly string[],
  hasSelection: boolean,
): PaletteCommand[] {
  const tier = (command: PaletteCommand): number => {
    if (hasSelection && command.group === "actions") return 0;
    if (recents.includes(command.id)) return 1;
    return 2;
  };
  return [...commands]
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const byTier = tier(a.command) - tier(b.command);
      if (byTier !== 0) return byTier;
      if (tier(a.command) === 1) {
        // Within the recent tier, most-recently-used first.
        return recents.indexOf(a.command.id) - recents.indexOf(b.command.id);
      }
      return a.index - b.index;
    })
    .map(({ command }) => command);
}

/** Filter the non-issue commands by the query, keeping `orderCommands`' order. */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const trimmed = query.trim();
  if (trimmed === "") return [...commands];
  const scored: { command: PaletteCommand; score: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const byLabel = fuzzyScore(trimmed, command.label);
    const byKeywords = fuzzyScore(trimmed, command.keywords);
    if (byLabel === null && byKeywords === null) return;
    scored.push({ command, score: Math.max(byLabel ?? 0, byKeywords ?? 0), index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ command }) => command);
}
