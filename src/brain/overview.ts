/**
 * The Settings → Brain overview: is the brain healthy, and is it helping?
 *
 * Every figure here answers one of those two questions, or it is not here. Health: is it on,
 * are the agents hooked, does the always-loaded block fit its budget, is anything waiting for
 * review or going stale, is retrieval inside its time budget. Helping: are sessions getting
 * memories, do turns find something, do agents cite what they were shown, does recall find the
 * right memory (the eval).
 *
 * The verdict is the worst of its checks, the way a health check reports: `ok`, `warn`,
 * `critical`, or `off` when the brain is switched off on purpose. Each check that is not ok
 * comes with the sentence that says what to do.
 */
import type { BrainConfig } from "./config.js";
import { isExpired } from "./config.js";
import type { HookStatus } from "./hooks-install.js";
import { computeStats, type BrainStats } from "./stats.js";
import type { UsageRow } from "./usage.js";
import { GLOBAL_SCOPE, type BrainKind, type BrainRecord } from "./types.js";

const DAY = 86_400_000;

export type Severity = "ok" | "warn" | "critical";

export interface Check {
  id: string;
  severity: Severity;
  text: string;
}

export interface WindowDelta {
  days: number;
  recordsAdded: number;
  recordsAddedBefore: number;
  sessions: number;
  sessionsBefore: number;
  turnsInjected: number;
  turnsInjectedBefore: number;
  citations: number;
  citationsBefore: number;
  remembers: number;
  remembersBefore: number;
}

export interface BrainOverview {
  generatedAt: string;
  verdict: Severity | "off";
  checks: Check[];
  budget: { tokens: number; avgTokens: number | null; utilization: number | null; shown: number | null; eligible: number | null };
  corpus: {
    live: number;
    byKind: Record<BrainKind, number>;
    global: number;
    projects: number;
    provisional: number;
    awaitingReview: number;
    promoted: number;
    expired: number;
    stale: number;
    superseded: number;
  };
  helping: {
    sessions: number;
    sessionsWithMemories: number;
    turnHitRate: number | null;
    recallHitRate: number | null;
    citationRate: number | null;
    citations: number;
    tokensPerSessionStart: number | null;
    tokensPerTurn: number | null;
    latency: { start: { p50: number | null; p95: number | null }; turn: { p50: number | null; p95: number | null }; recall: { p50: number | null; p95: number | null } };
    eval: { at: string; r1: number; r3: number; questions: number; misses: number } | null;
  };
  agents: Array<{ agent: string; label: string; sessions: number; turnInjections: number; recalls: number; remembers: number; citations: number }>;
  mostUsed: BrainStats["usage"]["mostUsed"];
  neverUsed: number;
  delta: WindowDelta;
  stats: BrainStats;
}

const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", mcp: "Other MCP clients", cli: "staple CLI", web: "Settings" };

function agentKey(provider: string | null): string {
  const p = (provider ?? "").toLowerCase();
  if (p.startsWith("claude")) return "claude";
  if (p.startsWith("codex")) return "codex";
  if (p === "cli" || p === "web") return p;
  if (p === "probe" || p === "") return "";
  return "mcp";
}

function inWindow(at: string, from: number, to: number): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && t >= from && t < to;
}

function deltaFor(records: readonly BrainRecord[], usage: readonly UsageRow[], days: number, now: number): WindowDelta {
  const start = now - days * DAY;
  const before = start - days * DAY;
  const count = (from: number, to: number) => {
    const rows = usage.filter((r) => inWindow(r.at, from, to));
    return {
      recordsAdded: records.filter((r) => inWindow(r.createdAt, from, to) && !r.source?.startsWith("import:")).length,
      sessions: new Set(rows.filter((r) => r.event === "session_start" && r.session).map((r) => r.session)).size,
      turnsInjected: rows.filter((r) => r.event === "turn" && r.recordIds.length > 0).length,
      citations: rows.filter((r) => r.event === "cite").reduce((n, r) => n + r.recordIds.length, 0),
      remembers: rows.filter((r) => r.event === "remember").length,
    };
  };
  const now_ = count(start, now + 1);
  const prev = count(before, start);
  return {
    days,
    recordsAdded: now_.recordsAdded,
    recordsAddedBefore: prev.recordsAdded,
    sessions: now_.sessions,
    sessionsBefore: prev.sessions,
    turnsInjected: now_.turnsInjected,
    turnsInjectedBefore: prev.turnsInjected,
    citations: now_.citations,
    citationsBefore: prev.citations,
    remembers: now_.remembers,
    remembersBefore: prev.remembers,
  };
}

export function computeOverview(
  records: readonly BrainRecord[],
  usage: readonly UsageRow[],
  config: BrainConfig,
  hooks: readonly HookStatus[],
  options: { days?: number; now?: number } = {},
): BrainOverview {
  const now = options.now ?? Date.now();
  const days = options.days ?? 7;
  // The probes that measured hook latency by hand are not agents; they stay out of every figure.
  const real = usage.filter((r) => r.provider !== "probe" && !r.detail?.config);
  const stats = computeStats(records, real, now);
  const live = records.filter((r) => r.supersededBy === null && !isExpired(config, r, now));
  const expired = records.filter((r) => r.supersededBy === null && isExpired(config, r, now)).length;
  const promoted = real.filter((r) => r.event === "verify").length;

  // ---- the always-loaded block against its budget, from what sessions actually received
  const starts = real.filter((r) => r.event === "session_start" && r.recordIds.length > 0);
  const lastStart = starts[0] ?? null;
  const avgTokens = stats.usage.avgTokens.sessionStart;
  const budget = {
    tokens: config.budgets.sessionTokens,
    avgTokens,
    utilization: avgTokens === null ? null : Math.round((avgTokens / config.budgets.sessionTokens) * 100) / 100,
    shown: lastStart ? lastStart.recordIds.length : null,
    eligible: lastStart && typeof lastStart.detail?.eligible === "number" ? (lastStart.detail.eligible as number) : null,
  };

  // ---- helping
  const sessions = new Map<string, number>();
  for (const r of real) if ((r.event === "session_start" || r.event === "turn") && r.session) sessions.set(r.session, (sessions.get(r.session) ?? 0) + r.recordIds.length);
  const citedSessions = new Set(real.filter((r) => r.event === "cite" && r.session).map((r) => r.session));
  const sessionsWithMemories = [...sessions.values()].filter((n) => n > 0).length;
  const lat = (event: string) => ({ p50: stats.usage.latency[event]?.p50 ?? null, p95: stats.usage.latency[event]?.p95 ?? null });
  const evalDetail = stats.eval?.detail as { all?: { unscoped: { r1: number; r3: number } }; questions?: number; misses?: unknown[] } | undefined;

  // ---- per agent
  const agents = new Map<string, { sessions: Set<string>; turnInjections: number; recalls: number; remembers: number; citations: number }>();
  for (const r of real) {
    const key = agentKey(r.provider);
    if (!key) continue;
    const a = agents.get(key) ?? { sessions: new Set<string>(), turnInjections: 0, recalls: 0, remembers: 0, citations: 0 };
    agents.set(key, a);
    if (r.event === "session_start" && r.session) a.sessions.add(r.session);
    if (r.event === "turn" && r.recordIds.length) a.turnInjections++;
    if (r.event === "recall") a.recalls++;
    if (r.event === "remember") a.remembers++;
    if (r.event === "cite") a.citations += r.recordIds.length;
  }

  // ---- checks
  const checks: Check[] = [];
  const add = (id: string, severity: Severity, text: string) => checks.push({ id, severity, text });
  for (const agent of ["claude", "codex"] as const) {
    const label = AGENT_LABEL[agent]!;
    if (!config.agents[agent].enabled) continue;
    const hook = hooks.find((h) => h.agent === agent);
    if (!hook || !hook.file) add(`hooks-${agent}`, "warn", `${label}: no config home to check (${hook?.refusal ?? "unknown"}).`);
    else if (!hook.events.SessionStart || !hook.events.UserPromptSubmit) {
      const missing = (["SessionStart", "UserPromptSubmit"] as const).filter((e) => !hook.events[e]);
      add(`hooks-${agent}`, "warn", `${label}: ${missing.join(" and ")} hook not installed, so its sessions start without the brain. Install it under Controls.`);
    } else add(`hooks-${agent}`, "ok", `${label} hooks are installed.`);
  }
  const lastSession = starts.length ? Date.parse(starts[0]!.at) : null;
  if (lastSession === null) add("activity", "critical", "No agent session has received the brain yet.");
  else if (now - lastSession > 7 * DAY) add("activity", "warn", `No agent session has received the brain in ${Math.floor((now - lastSession) / DAY)} days.`);
  else add("activity", "ok", `Last session received the brain ${Math.max(1, Math.round((now - lastSession) / 60_000))} minutes ago.`);
  const turnP95 = lat("turn").p95;
  if (turnP95 !== null && turnP95 > config.budgets.turnMs) add("latency", "warn", `Per-prompt retrieval p95 is ${Math.round(turnP95)} ms, over its ${config.budgets.turnMs} ms budget; slow turns skip retrieval.`);
  else if (turnP95 !== null) add("latency", "ok", `Per-prompt retrieval p95 is ${Math.round(turnP95)} ms, inside its ${config.budgets.turnMs} ms budget.`);
  const awaitingReview = live.filter((r) => r.provisional).length;
  if (config.writePolicy === "review" && awaitingReview > 0) add("review", "warn", `${awaitingReview} agent-written memories are waiting for review.`);
  const staleShare = live.length ? stats.health.stale.length / live.length : 0;
  if (staleShare > 0.5) add("stale", "warn", `${stats.health.stale.length} of ${live.length} memories are stale (unverified for 30+ days, or naming a missing path). Verify or supersede them.`);
  if (!evalDetail?.all) add("eval", "warn", "Recall has not been measured: run `staple brain eval` with a question set.");
  else if (evalDetail.all.unscoped.r3 < 0.8) add("eval", "warn", `Recall puts the right memory in the top 3 for only ${Math.round(evalDetail.all.unscoped.r3 * 100)}% of eval questions.`);
  else add("eval", "ok", `Recall puts the right memory in the top 3 for ${Math.round(evalDetail.all.unscoped.r3 * 100)}% of eval questions.`);
  if (config.writePolicy === "off") add("writes", "warn", "Agent writes are off, so nothing agents learn is kept.");

  const rank: Record<Severity, number> = { ok: 0, warn: 1, critical: 2 };
  const worst = checks.reduce<Severity>((w, c) => (rank[c.severity] > rank[w] ? c.severity : w), "ok");
  checks.sort((a, b) => rank[b.severity] - rank[a.severity]);

  return {
    generatedAt: new Date(now).toISOString(),
    verdict: config.enabled ? worst : "off",
    checks,
    budget,
    corpus: {
      live: live.length,
      byKind: stats.health.byKind,
      global: live.filter((r) => r.scope === GLOBAL_SCOPE).length,
      projects: new Set(live.filter((r) => r.scope !== GLOBAL_SCOPE).map((r) => r.scope)).size,
      provisional: awaitingReview,
      awaitingReview: config.writePolicy === "review" ? awaitingReview : 0,
      promoted,
      expired,
      stale: stats.health.stale.length,
      superseded: stats.health.superseded,
    },
    helping: {
      sessions: sessions.size,
      sessionsWithMemories,
      turnHitRate: stats.usage.turnInjectionRate,
      recallHitRate: stats.usage.recallHitRate,
      citationRate: sessions.size ? Math.round((citedSessions.size / sessions.size) * 100) / 100 : null,
      citations: stats.usage.citations,
      tokensPerSessionStart: stats.usage.avgTokens.sessionStart,
      tokensPerTurn: stats.usage.avgTokens.turn,
      latency: { start: lat("session_start"), turn: lat("turn"), recall: lat("recall") },
      eval: evalDetail?.all && stats.eval
        ? { at: stats.eval.at, r1: evalDetail.all.unscoped.r1, r3: evalDetail.all.unscoped.r3, questions: evalDetail.questions ?? 0, misses: evalDetail.misses?.length ?? 0 }
        : null,
    },
    agents: [...agents.entries()]
      .map(([agent, a]) => ({ agent, label: AGENT_LABEL[agent] ?? agent, sessions: a.sessions.size, turnInjections: a.turnInjections, recalls: a.recalls, remembers: a.remembers, citations: a.citations }))
      .filter((a) => a.sessions + a.turnInjections + a.recalls + a.remembers + a.citations > 0)
      .sort((a, b) => b.sessions - a.sessions || b.recalls - a.recalls),
    mostUsed: stats.usage.mostUsed.slice(0, 5),
    neverUsed: stats.usage.neverUsed.length,
    delta: deltaFor(records, real, days, now),
    stats,
  };
}
