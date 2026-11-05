/**
 * The web UI's brain routes (proof of concept). Each one calls what
 * `staple brain recall|context|list|remember|forget` calls, so the page and the CLI answer
 * the same records. Machine-level, like the budget: the brain is its own global workspace
 * (`STAPLE_BRAIN_DB`, else `<staple home>/workspaces/brain.db`), whichever workspace the
 * page has chosen, and every call opens and closes it.
 */
import { buildContext, DEFAULT_CONTEXT_BUDGET } from "../brain/context.js";
import { openBrain } from "../brain/open.js";
import { recall } from "../brain/recall.js";
import { projectKeysFor, projectScope, type ProjectKeys } from "../brain/scope.js";
import type { BrainStore } from "../brain/store.js";
import { GLOBAL_SCOPE, isBrainKind } from "../brain/types.js";
import { computeStats } from "../brain/stats.js";
import { buildTurn } from "../brain/turn.js";
import { withUsage, type UsageRow } from "../brain/usage.js";
import { StapleError } from "../core/types.js";

function withBrain<T>(fn: (brain: BrainStore, dbPath: string) => T): T {
  const opened = openBrain();
  try {
    return fn(opened.brain, opened.dbPath);
  } finally {
    opened.close();
  }
}

/** A project to preview as: a filesystem directory (`cwd`), or a stored scope (`project:<slug>`). */
function keysFor(params: URLSearchParams): ProjectKeys | null {
  const scope = params.get("scope");
  if (scope && scope.startsWith("project:")) return { slugs: [scope.slice("project:".length)], repoName: null };
  const cwd = params.get("cwd");
  return cwd ? projectKeysFor(cwd) : null;
}

/** `GET /api/brain/records`: every record, plus the project scopes they name, for the filters. */
export function brainRecords() {
  return withBrain((brain) => {
    const records = brain.all();
    const scopes = new Map<string, number>();
    for (const r of records) scopes.set(r.scope, (scopes.get(r.scope) ?? 0) + 1);
    return {
      records,
      scopes: [...scopes.entries()].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count),
    };
  });
}

/** `GET /api/brain/recall?q=…[&scope=|&cwd=][&limit=]` */
export function brainRecall(params: URLSearchParams) {
  const q = params.get("q") ?? "";
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 10) || 10, 1), 50);
  return withBrain((brain) => {
    const started = performance.now();
    const hits = recall(brain.live(), q, { limit, keys: keysFor(params) });
    return { q, ms: Math.round((performance.now() - started) * 10) / 10, hits: hits.map((h) => ({ score: h.score, record: h.record })) };
  });
}

/** `GET /api/brain/context?(scope=|cwd=)[&budget=]`: exactly what the SessionStart hook would inject. */
export function brainContext(params: URLSearchParams) {
  const keys = keysFor(params) ?? { slugs: [], repoName: null };
  const budget = Math.min(Math.max(Number(params.get("budget") ?? DEFAULT_CONTEXT_BUDGET) || DEFAULT_CONTEXT_BUDGET, 100), 20_000);
  return withBrain((brain) => ({ budget, ...buildContext(brain.all(), keys, budget) }));
}

/** `POST /api/brain/remember` with `{ kind, body, name?, description?, why?, scope?, cwd?, tags?, provisional? }` */
export function brainRemember(body: Record<string, unknown>) {
  const text = (key: string) => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : null);
  if (!isBrainKind(body.kind)) throw new StapleError("validation", "kind must be user, feedback, project or reference.");
  const content = text("body");
  if (!content) throw new StapleError("validation", "A memory needs a body.");
  const scopeIn = text("scope");
  const cwd = text("cwd");
  // "global" (or nothing), "project" with a cwd, or a stored `project:<slug>` as given.
  let scope = GLOBAL_SCOPE;
  if (scopeIn === "project") {
    if (!cwd) throw new StapleError("validation", "scope 'project' needs a cwd.");
    scope = projectScope(cwd);
  } else if (scopeIn && scopeIn !== "global") {
    if (!scopeIn.startsWith("project:")) throw new StapleError("validation", "scope must be global, project or project:<slug>.");
    scope = scopeIn;
  }
  // `id` edits that record in place; `supersedes` writes a new one and marks the old one replaced.
  const id = text("id");
  const supersedes = text("supersedes");
  return withBrain((brain, dbPath) => {
    const record = brain.remember({
      ...(id ? { id } : {}),
      kind: body.kind as never,
      body: content,
      name: text("name"),
      description: text("description"),
      why: text("why"),
      scope,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
      source: "human:web-ui",
      provisional: body.provisional === true,
      supersedes,
    });
    withUsage(dbPath, (log) => log.log({ event: "remember", provider: "web", recordIds: [record.id], detail: { edit: id !== null, supersedes } }));
    return record;
  });
}

/** `POST /api/brain/forget` with `{ id }` */
export function brainForget(body: Record<string, unknown>) {
  if (typeof body.id !== "string" || !body.id) throw new StapleError("validation", "id is required.");
  return withBrain((brain, dbPath) => {
    const record = brain.forget(body.id as string, "human:web-ui");
    withUsage(dbPath, (log) => log.log({ event: "forget", provider: "web", recordIds: [record.id] }));
    return record;
  });
}

/** `GET /api/brain/stats` — `staple brain stats --json`: health, usage from the log, activity, the latest eval. */
export function brainStats() {
  const opened = openBrain();
  try {
    let rows: UsageRow[] = [];
    withUsage(opened.dbPath, (log) => {
      rows = log.rows();
    });
    return computeStats(opened.brain.all(), rows);
  } finally {
    opened.close();
  }
}

/**
 * `GET /api/brain/turn?(scope=|cwd=)&prompt=…[&seen=start]` — what the UserPromptSubmit hook
 * would add for this prompt. With `seen=start`, the records the session-start block already
 * shows are excluded, exactly as a real session's first prompt would see it. A preview: nothing
 * is written to the usage log.
 */
export function brainTurnPreview(params: URLSearchParams) {
  const keys = keysFor(params) ?? { slugs: [], repoName: null };
  const prompt = params.get("prompt") ?? "";
  return withBrain((brain) => {
    const seen = params.get("seen") === "start" ? new Set(buildContext(brain.all(), keys).ids) : new Set<string>();
    const started = performance.now();
    const block = buildTurn(brain.live(), prompt, { keys, seen });
    return { prompt, ms: Math.round((performance.now() - started) * 10) / 10, ...block };
  });
}
