/**
 * THE WORKSPACE VOCABULARY, as the browser sees it — O7b (STA-141).
 *
 * O7a (STA-140) turned the status set and the kind list into workspace DATA. This is the
 * single module that holds what the server said about them, and every other surface asks
 * it rather than importing a frozen tuple from lib/types.ts.
 *
 * ── WHY A MODULE-LEVEL SNAPSHOT AND NOT A REACT CONTEXT ───────────────────────────────
 *
 * Two kinds of caller need the same answer and only one of them is a component.
 *
 *   `views/tree/tree-model.ts` is a pure module. It derives `GROUP_ORDER`, it answers
 *   `isResolvedStatus`, and it does both outside React, in code that vitest runs with no
 *   DOM and no provider. It cannot call a hook. Neither can `lib/filters.ts`,
 *   `views/graph/graph-clusters.ts`, or any of the other places that ask a question about
 *   a status while building a list.
 *
 * So the truth lives in a module variable with a subscriber set, and `useWorkspaceSettings`
 * is a thin React window onto it. The alternative — a context for the components plus a
 * second copy for the pure modules — is two sources of truth for one fact, which is the
 * exact failure this file exists to prevent.
 *
 * ── THE SEED IS NOT A PLACEHOLDER ─────────────────────────────────────────────────────
 *
 * The snapshot starts as the built-in seven and the built-in five, in seed order, with
 * their real categories. A surface that renders before `/api/settings` resolves is
 * therefore CORRECT for a default workspace rather than blank — and a default workspace is
 * every workspace until somebody opens the settings dialog. Nothing has to guard against
 * "settings not loaded yet"; it only has to be prepared for the answer to change.
 *
 * ── EVERY ACCESSOR IS TOTAL ───────────────────────────────────────────────────────────
 *
 * An id this module has never heard of gets an answer, not an exception: `statusCategory`
 * says `unstarted`, `statusLabel` title-cases the id, `statusRank` sorts it last. The wire
 * can always carry a status that was added a second ago by another process, and a render
 * path is the worst possible place to discover that.
 */
import { AuthError, getSettings } from "./api";
import { fallbackKindAppearance, type KindAppearance, type KindRow } from "./kind-appearance";
import { useCallback, useEffect, useState } from "react";
import {
  ISSUE_KINDS,
  ISSUE_STATUSES,
  RESOLVED_CATEGORIES,
  STATUS_CATEGORIES,
  VOCABULARY_ID_PATTERN,
  type StatusCategory,
  type StatusId,
  type WorkspaceSettings,
  type WorkspaceStatus,
} from "./types";

/**
 * The built-in status seed, WITH ITS CATEGORIES — the mirror of `BUILTIN_STATUS_SEED`
 * in src/core/types.ts, which is what a fresh workspace is seeded with.
 *
 * The categories are the load-bearing half. Without them the fallback could not answer
 * `statusCategory("in_progress")`, and the icon and the chip hue both key off that — so a
 * first paint before the fetch lands would render eight grey glyphs and then repaint.
 * `awaiting_approval` is `gated` (STA-143), which is how `StatusIcon` knows to draw the
 * gate rather than borrowing `in_review`'s hue.
 */
const BUILTIN_STATUS_SEED: readonly { id: string; label: string; category: StatusCategory }[] = [
  { id: "backlog", label: "Backlog", category: "unstarted" },
  { id: "todo", label: "Todo", category: "ready" },
  { id: "in_progress", label: "In Progress", category: "active" },
  { id: "in_review", label: "In Review", category: "review" },
  { id: "awaiting_approval", label: "Awaiting Approval", category: "gated" },
  { id: "done", label: "Done", category: "done" },
  { id: "blocked", label: "Blocked", category: "blocked" },
  { id: "cancelled", label: "Cancelled", category: "cancelled" },
];

const BUILTIN_KIND_SEED: readonly { id: string; label: string }[] = [
  { id: "epic", label: "Epic" },
  { id: "task", label: "Task" },
  { id: "bug", label: "Bug" },
  { id: "chore", label: "Chore" },
  { id: "spike", label: "Spike" },
];

/**
 * `awaiting_approval` -> `Awaiting Approval`. The mirror of the store's `defaultLabel`,
 * so the label the dialog PREVIEWS for a new id is the label the store will store.
 */
export function titleCaseId(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Re-exported so a caller reaching in here for the vocabulary need not reach elsewhere. */
export { VOCABULARY_ID_PATTERN };

export function isValidVocabularyId(id: string): boolean {
  return VOCABULARY_ID_PATTERN.test(id);
}

const SEED: WorkspaceSettings = {
  workspace: "",
  statuses: BUILTIN_STATUS_SEED.map((row, index) => ({
    id: row.id,
    label: row.label,
    category: row.category,
    sortOrder: index,
    isBuiltin: true,
  })),
  kinds: BUILTIN_KIND_SEED.map((row, index) => ({
    id: row.id,
    label: row.label,
    sortOrder: index,
    isBuiltin: true,
    // The built-in mark (R5a, STA-181), so the first paint wears the right glyphs
    // rather than six generic dots that repaint when the fetch lands.
    appearance: fallbackKindAppearance(row),
  })),
  // The list rank of the seeded statuses — identical to what `OPEN_STATUS_ORDER` and
  // `RESOLVED_STATUSES` in lib/types.ts spell out, because that is exactly what
  // `store.statusOrder()` produces for a default workspace. `awaiting_approval` sits
  // between `in_review` and `blocked` because `gated` sits there in the category tiering,
  // and it is absent from `pickupOrder` because `gated` is absent from the pickup tiers.
  groupOrder: [
    "in_progress",
    "in_review",
    "awaiting_approval",
    "blocked",
    "todo",
    "backlog",
    "done",
    "cancelled",
  ],
  openOrder: ["in_progress", "in_review", "awaiting_approval", "blocked", "todo", "backlog"],
  pickupOrder: ["in_progress", "in_review", "todo", "backlog"],
  categories: [...STATUS_CATEGORIES],
  requiredCategories: ["unstarted", "ready", "active", "blocked", "done", "cancelled"],
  // Nothing is known to be in use before the fetch, and that is the SAFE direction: a
  // removal control that has not heard otherwise offers the migrate-to picker anyway
  // (see `requiresMigrateTo`), and the store refuses if the count was actually non-zero.
  usage: { statuses: {}, kinds: {} },
};

/** The seed, for a caller that wants a known-default vocabulary (tests, fixtures). */
export const SEED_SETTINGS: WorkspaceSettings = SEED;

// ---------------------------------------------------------------- the registry (R6a, STA-176)

/**
 * The typed settings registry, AS THE SERVER SERVES IT. Mirrors the wire views in
 * src/core/settings-registry.ts field for field — and mirrors nothing else: the
 * definitions themselves (defaults, schemas, categories) are not restated here, because
 * the whole point of a registry is that there is one, and a client-side copy would be the
 * second one. Before the fetch resolves `registry` is EMPTY, not seeded, for that reason;
 * every accessor below is total over that.
 */
export type SettingScope = "workspace" | "global";
export type SettingValueSource = "default" | "workspace" | "config";
export type SettingCategoryEditor = "fields" | "statuses" | "kinds";

export interface SettingCategoryView {
  id: string;
  label: string;
  description: string;
  scope: SettingScope;
  editor: SettingCategoryEditor;
  order: number;
}

export type SettingSchemaView =
  | { type: "boolean" }
  | { type: "integer"; min?: number; max?: number }
  | { type: "string"; pattern?: string; patternHint?: string }
  | { type: "enum"; values: string[] }
  | { type: "kindAppearance" };

export type SettingControl = "toggle" | "number" | "text" | "select" | "glyph";

export interface SettingDefinitionView {
  key: string;
  category: string;
  scope: SettingScope;
  schema: SettingSchemaView;
  default: unknown;
  version: number;
  sensitivity: "normal" | "sensitive";
  ui: { label: string; description: string; control: SettingControl; order: number };
}

/** One effective value with its provenance. `value` is absent when `redacted`. */
export interface SettingValueView {
  key: string;
  scope: SettingScope;
  value?: unknown;
  source: SettingValueSource;
  version: number;
  redacted?: true;
}

/** One op in a `putSettings("settings", …)` batch — the mirror of the store's `SettingOp`. */
export type SettingOp = { op: "set"; key: string; value: unknown } | { op: "reset"; key: string };

/** What `/api/settings` answers: the vocabulary envelope plus the registry and both scopes' values. */
export interface WorkspaceSettingsEnvelope extends WorkspaceSettings {
  /** Each row with its resolved appearance (R5a, STA-181); see `kindAppearance()`. */
  kinds: KindRow[];
  registry: { categories: SettingCategoryView[]; definitions: SettingDefinitionView[] };
  /** This workspace's registered values, keyed by setting key. */
  values: Record<string, SettingValueView>;
  /** Stored keys this build has no definition for: preserved and reported, never rewritten. */
  unknownKeys: string[];
  /** The machine's config.json — a DIFFERENT store, read-only on this route. */
  global: { path: string; present: boolean; values: Record<string, SettingValueView> };
}

/** The registry half of the envelope before the fetch: nothing known, nothing invented. */
const EMPTY_REGISTRY: Pick<WorkspaceSettingsEnvelope, "registry" | "values" | "unknownKeys" | "global"> = {
  registry: { categories: [], definitions: [] },
  values: {},
  unknownKeys: [],
  global: { path: "", present: false, values: {} },
};

// ---------------------------------------------------------------- the snapshot

let current: WorkspaceSettingsEnvelope = { ...SEED, ...EMPTY_REGISTRY };
const listeners = new Set<() => void>();

/** What the server last said. Never null — see "the seed is not a placeholder" above. */
export function workspaceSettings(): WorkspaceSettingsEnvelope {
  return current;
}

/**
 * Publish a fresh answer. Called by `useWorkspaceSettings` after a GET and by the
 * settings editor after a POST — both hand over the SAME envelope, which is why the
 * editor never has to merge a write result into a list it fetched earlier.
 *
 * A bare vocabulary envelope (what a fixture that predates the registry builds) is
 * accepted and completed with the empty registry, so a test about statuses need not
 * know that settings have definitions.
 */
export function publishWorkspaceSettings(next: WorkspaceSettings | WorkspaceSettingsEnvelope): void {
  current = { ...EMPTY_REGISTRY, ...next };
  for (const listener of [...listeners]) listener();
}

/** Back to the built-in seed. Exists for tests; nothing in the app calls it. */
export function resetWorkspaceSettings(): void {
  publishWorkspaceSettings(SEED);
}

// ---------------------------------------------------------------- registry accessors

/** Registered categories in shell order, optionally one scope's. Empty before the fetch. */
export function settingCategories(scope?: SettingScope): SettingCategoryView[] {
  return current.registry.categories.filter((c) => scope === undefined || c.scope === scope);
}

/** Registered definitions in display order, optionally one category's. */
export function settingDefinitions(category?: string): SettingDefinitionView[] {
  return current.registry.definitions.filter((d) => category === undefined || d.category === category);
}

/**
 * The effective value of a setting in EITHER scope, with provenance — the workspace
 * value, the global value, or the definition's default when neither has been stored. An
 * unknown key answers `undefined` rather than throwing, for the same reason every other
 * accessor here is total: a render path is the wrong place to discover a key.
 */
export function settingValue(key: string): SettingValueView | undefined {
  return settingValueIn(current, key);
}

/** `settingValue` over a given envelope, for a form that holds the snapshot it renders (R6c). */
export function settingValueIn(envelope: WorkspaceSettingsEnvelope, key: string): SettingValueView | undefined {
  const stored = envelope.values[key] ?? envelope.global.values[key];
  if (stored) return stored;
  const definition = envelope.registry.definitions.find((d) => d.key === key);
  if (!definition) return undefined;
  return { key, scope: definition.scope, value: definition.default, source: "default", version: definition.version };
}

export function subscribeWorkspaceSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------- plain accessors

function statusById(id: StatusId): WorkspaceStatus | undefined {
  return current.statuses.find((status) => status.id === id);
}

function kindById(id: string): KindRow | undefined {
  return current.kinds.find((kind) => kind.id === id);
}

/**
 * THE APPEARANCE RESOLVER (R5a, STA-181) — what every surface that draws a kind
 * asks, and the accessor STA-185 wires the list, the groups, the forms and the
 * graph through. The server resolved it (stored choice, built-in mark, or the
 * generic one); this only falls back for a row an older server served without
 * one, and for an id nobody has configured, which gets the generic mark with a
 * title-cased label. Total, like every accessor here.
 */
export function kindAppearance(id: string): KindAppearance {
  const kind = kindById(id);
  return kind?.appearance ?? fallbackKindAppearance(kind ?? { id, label: titleCaseId(id) });
}

/**
 * The behaviour class of a status. THE accessor of this module — colour, glyph and every
 * "is this finished" question resolve through it, and none of them may key off the id.
 *
 * An unknown id answers `unstarted`, which is the most conservative reading available:
 * not started, not resolved, not claimed by anything. A throw here would take out a
 * render for a status somebody added in another tab two seconds ago.
 */
export function statusCategory(id: StatusId): StatusCategory {
  return statusById(id)?.category ?? "unstarted";
}

/** The configured display label, or a title-cased id for one we have not been told about. */
export function statusLabel(id: StatusId): string {
  return statusById(id)?.label ?? titleCaseId(id);
}

export function kindLabel(id: string): string {
  return kindById(id)?.label ?? titleCaseId(id);
}

export function isResolvedStatus(id: StatusId): boolean {
  return RESOLVED_CATEGORIES.includes(statusCategory(id));
}

export function isResolvedCategory(category: StatusCategory): boolean {
  return RESOLVED_CATEGORIES.includes(category);
}

/**
 * Every configured status id, IN CONFIGURED ORDER — what the settings editor's drag
 * produces, verbatim, and what the editor paints.
 *
 * This is NOT the order a list groups by. See `configuredGroupOrder()`.
 */
export function configuredStatusOrder(): StatusId[] {
  return current.statuses.map((status) => status.id);
}

/**
 * GROUP-HEADER AND SORT ORDER — THE ACCESSOR THE TREE WIRES TO.
 *
 * A DROP-IN for `views/tree/tree-model.ts`'s
 * `GROUP_ORDER = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]`: on a default workspace it
 * produces exactly that list, byte for byte. This is how STA-141's "group-by-status
 * headers follow configured order" criterion is delivered.
 *
 * ── WHY IT IS SERVED AND NOT DERIVED FROM `statuses` HERE ─────────────────────────────
 *
 * There are two orders, they are both real, and confusing them is the trap this comment
 * exists to mark.
 *
 *   CONFIGURED order is `statuses` — the sequence of rows in the settings dialog, which is
 *   also the seed order (`backlog, todo, in_progress, in_review, done, blocked, cancelled`).
 *
 *   LIST RANK is `store.statusOrder()` — categories in a fixed sequence (active, review,
 *   gated, blocked, ready, unstarted, done, cancelled) with the configured order breaking
 *   ties INSIDE each tier. For the seeded seven that is
 *   `in_progress, in_review, blocked, todo, backlog, done, cancelled`.
 *
 * The list rank is the one to group by, and not as a matter of taste: it is the same rank
 * the store's own `CASE` fragment sorts ROWS by, so grouping any other way would put a
 * header above rows that sorted differently. It is also what today's UI already shows, so
 * a default workspace does not silently reorder itself the day this ships — which
 * grouping by the raw configured order WOULD have done, hoisting `backlog` to the top of
 * the page.
 *
 * A reorder still moves headers: dragging one `active` status above another reorders that
 * tier, and moving a status ACROSS tiers is what the category select next to the drag
 * handle is for. That is the honest reading of "configured order is canonical" against a
 * design whose whole premise (STA-139) is that behaviour follows the category.
 *
 * It arrives from the server for the same reason: the store computes it once, and a
 * browser that re-derived the tiering would be a second authority on it.
 */
export function configuredGroupOrder(): StatusId[] {
  return [...current.groupOrder];
}

/** `configuredGroupOrder()` minus the resolved categories. */
export function configuredOpenStatuses(): StatusId[] {
  return [...current.openOrder];
}

/** The agent inbox's pickup tiers, as the store derives them. */
export function configuredPickupOrder(): StatusId[] {
  return [...current.pickupOrder];
}

/** Sort key for a status: its index in `configuredGroupOrder()`; unknown ids sort last. */
export function statusRank(id: StatusId): number {
  const index = configuredGroupOrder().indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Every configured kind id, in configured order. O1a (STA-124) consumes this. */
export function configuredKindOrder(): string[] {
  return current.kinds.map((kind) => kind.id);
}

/**
 * Does removing this row need a migrate-to target?
 *
 * True when the server counted rows still carrying it — and ALSO true when the count is
 * simply not known yet, because `usage` is empty until the first fetch resolves. Erring
 * toward asking is the cheap mistake (one extra select on a removal that did not need
 * one); erring the other way sends a removal the store refuses and shows the user a
 * failure instead of a field.
 */
export function requiresMigrateTo(kind: "statuses" | "kinds", id: string): boolean {
  const counts = current.usage[kind];
  const count = counts[id];
  return count === undefined ? true : count > 0;
}

/** How many issues carry this id, or null when the server has not said. */
export function usageCount(kind: "statuses" | "kinds", id: string): number | null {
  return current.usage[kind][id] ?? null;
}

// ---------------------------------------------------------------- the React window

export interface SettingsResource {
  settings: WorkspaceSettingsEnvelope;
  loading: boolean;
  error: Error | undefined;
  reload: () => void;
}

/**
 * Subscribe to the snapshot, and fetch it once per workspace.
 *
 * `ws` is the workspace slug in hub mode and `undefined` in single-workspace mode — the
 * vocabulary is per workspace, so switching workspaces refetches. `version` is the
 * session's fingerprint tick: another process (an agent through MCP, a shell through the
 * CLI) can change the vocabulary underneath an open page, and that write moves the
 * fingerprint, so the page picks it up on the same 1.5s poll everything else uses.
 *
 * ONLY an `AuthError` goes to `onAuthError`; everything else is a local `error` on the
 * returned resource. Routing every failure up there would turn a 500 into the token
 * screen, which tells the user to fix a credential that was never the problem. And when
 * no handler is given the auth failure is swallowed, because the fingerprint poll hits
 * the same 401 within 1.5s and swaps in the token screen — a settings fetch is never the
 * thing that has to own that decision.
 */
export function useWorkspaceSettings(options: {
  ws?: string;
  version?: number;
  onAuthError?: (error: AuthError) => void;
} = {}): SettingsResource {
  const { ws, version, onAuthError } = options;
  const [snapshot, setSnapshot] = useState<WorkspaceSettingsEnvelope>(current);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => subscribeWorkspaceSettings(() => setSnapshot(current)), []);

  useEffect(() => {
    let alive = true;
    getSettings({ ws })
      .then((next) => {
        if (!alive) return;
        setError(undefined);
        // Publishes to the module, which notifies every other subscriber — including the
        // pure accessors' callers on their next render.
        publishWorkspaceSettings(next);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (caught instanceof AuthError) {
          onAuthError?.(caught);
          return;
        }
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, version, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { settings: snapshot, loading, error, reload };
}

/**
 * The built-in ids, re-exported so a caller does not have to reach into lib/types.ts for
 * the seed while reaching in here for the live list.
 */
export { ISSUE_KINDS, ISSUE_STATUSES, STATUS_CATEGORIES };
