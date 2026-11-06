/**
 * How the brain behaves: ONE synced policy, edited in Settings → Brain.
 *
 * Synced, because it is a decision about the brain and not about a machine: a write policy
 * that held on one computer and not on another would make the brain disagree with itself.
 * It is the single setting entity `brainconfig` in the brain workspace, so it rides the same
 * protocol-1 `setting` entity as the records (`store.ts`) and needs nothing new on the wire.
 *
 * What is NOT here is machine-local by nature: whether a CLI's hooks are installed in this
 * computer's config home (`hooks-install.ts`), and whether this computer is connected to a
 * sync service (`staple cloud`).
 */
import type { WorkspaceStore } from "../core/store.js";
import { WORKSPACE_SETTING_META_PREFIX } from "../core/settings-registry.js";
import { StapleError } from "../core/types.js";
import { GLOBAL_SCOPE } from "./types.js";

export const BRAIN_CONFIG_KEY = "brainconfig";

/** The agents the brain knows how to label; MCP clients that are neither count as `mcp`. */
export const BRAIN_AGENTS = ["claude", "codex", "mcp"] as const;
export type BrainAgent = (typeof BRAIN_AGENTS)[number];

export const WRITE_POLICIES = ["auto", "review", "off"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

export interface BrainConfig {
  /** Off: hooks inject nothing and the MCP tools say the brain is off. */
  enabled: boolean;
  sync: {
    /** Off: new writes stay on the computer that made them. */
    enabled: boolean;
    /** `global` and/or `project:<slug>`; empty means every scope. */
    scopes: string[];
  };
  agents: Record<BrainAgent, { enabled: boolean; write: boolean }>;
  /** auto: agent writes are durable; review: they land provisional until verified; off: refused. */
  writePolicy: WritePolicy;
  budgets: { sessionTokens: number; turnTokens: number; turnMs: number };
  /** A provisional record older than this stops being injected or recalled. 0 = never. */
  provisionalExpiryDays: number;
}

export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
  enabled: true,
  sync: { enabled: true, scopes: [] },
  agents: { claude: { enabled: true, write: true }, codex: { enabled: true, write: true }, mcp: { enabled: true, write: true } },
  writePolicy: "auto",
  budgets: { sessionTokens: 1500, turnTokens: 600, turnMs: 300 },
  provisionalExpiryDays: 30,
};

const META_KEY = `${WORKSPACE_SETTING_META_PREFIX}${BRAIN_CONFIG_KEY}`;

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** Anything stored, made whole: missing or malformed fields take their default. */
export function normalizeConfig(raw: unknown): BrainConfig {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<BrainConfig> & Record<string, any>;
  const d = DEFAULT_BRAIN_CONFIG;
  const agents = {} as BrainConfig["agents"];
  for (const agent of BRAIN_AGENTS) {
    const a: { enabled?: unknown; write?: unknown } = v.agents?.[agent] ?? {};
    agents[agent] = { enabled: typeof a.enabled === "boolean" ? a.enabled : true, write: typeof a.write === "boolean" ? a.write : true };
  }
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    sync: {
      enabled: typeof v.sync?.enabled === "boolean" ? v.sync.enabled : d.sync.enabled,
      scopes: Array.isArray(v.sync?.scopes) ? v.sync.scopes.filter((s: unknown): s is string => typeof s === "string" && (s === GLOBAL_SCOPE || s.startsWith("project:"))) : [],
    },
    agents,
    writePolicy: (WRITE_POLICIES as readonly string[]).includes(v.writePolicy as string) ? (v.writePolicy as WritePolicy) : d.writePolicy,
    budgets: {
      sessionTokens: int(v.budgets?.sessionTokens, d.budgets.sessionTokens, 200, 20_000),
      turnTokens: int(v.budgets?.turnTokens, d.budgets.turnTokens, 0, 10_000),
      turnMs: int(v.budgets?.turnMs, d.budgets.turnMs, 50, 5_000),
    },
    provisionalExpiryDays: int(v.provisionalExpiryDays, d.provisionalExpiryDays, 0, 3650),
  };
}

export function readConfig(workspace: WorkspaceStore): BrainConfig {
  const row = workspace.db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as { value: string } | undefined;
  if (!row) return normalizeConfig(null);
  try {
    return normalizeConfig((JSON.parse(row.value) as { value?: unknown }).value);
  } catch {
    return normalizeConfig(null);
  }
}

/** Replace the policy. Journaled as the `brainconfig` setting, so every synced device converges on it. */
export function writeConfig(workspace: WorkspaceStore, next: unknown, actor: string | null): BrainConfig {
  if (!next || typeof next !== "object") throw new StapleError("validation", "The brain configuration must be an object.");
  const value = normalizeConfig(next);
  return workspace.journaled(() => {
    workspace.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(META_KEY, JSON.stringify({ v: 1, value }));
    workspace.journal.record({
      entity: "setting",
      entityId: BRAIN_CONFIG_KEY,
      verb: workspace.journal.isTombstoned("setting", BRAIN_CONFIG_KEY) ? "create" : "update",
      payload: { value },
      actor,
    });
    return value;
  });
}

/** The agent a hook or MCP client counts as. */
export function agentOf(provider: string | null | undefined): BrainAgent {
  if (!provider) return "mcp";
  const p = provider.toLowerCase();
  if (p.startsWith("claude")) return "claude";
  if (p.startsWith("codex")) return "codex";
  return "mcp";
}

/** Whether a record in `scope` leaves this computer under the policy. */
export function syncsScope(config: BrainConfig, scope: string): boolean {
  if (!config.sync.enabled) return false;
  return config.sync.scopes.length === 0 || config.sync.scopes.includes(scope);
}

/** Whether a provisional record has outlived the policy and should stay out of injections and recall. */
export function isExpired(config: BrainConfig, record: { provisional: boolean; createdAt: string }, now = Date.now()): boolean {
  if (!record.provisional || config.provisionalExpiryDays === 0) return false;
  const at = Date.parse(record.createdAt);
  return Number.isFinite(at) && now - at > config.provisionalExpiryDays * 86_400_000;
}
