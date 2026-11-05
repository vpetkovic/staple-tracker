/**
 * The brain's numbers: what is in it (health), what agents do with it (usage, from the
 * sidecar log), what changed (activity), and how well recall works (the latest eval run).
 * One function, read by `staple brain stats` and the dashboard, so the two never disagree.
 */
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { UsageRow } from "./usage.js";
import { BRAIN_KINDS, GLOBAL_SCOPE, type BrainKind, type BrainRecord } from "./types.js";

const DAY = 86_400_000;
export const STALE_DAYS = 30;

/** Absolute or `~` paths a record names. `~` is the OS user's real home, never `$HOME`, so a preview run under a temp HOME does not call every path missing. */
export function namedPaths(body: string): string[] {
  const home = userInfo().homedir;
  const found = new Set<string>();
  for (const m of body.matchAll(/(?:^|[\s`'"(])((?:~|\/Users|\/home|\/private|\/opt|\/etc)\/[A-Za-z0-9._\-/]+)/g)) {
    let p = m[1]!.replace(/[.,:;)]+$/, "");
    if (p.startsWith("~")) p = join(home, p.slice(1));
    if (!p.includes("*") && !p.includes("<")) found.add(p);
  }
  return [...found];
}

function words(r: BrainRecord): Set<string> {
  return new Set(`${r.name ?? ""} ${r.description ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const union = a.size + b.size - both;
  return union === 0 ? 0 : both / union;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! * 10) / 10;
}

const mean = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

export interface BrainStats {
  generatedAt: string;
  health: {
    total: number;
    live: number;
    byKind: Record<BrainKind, number>;
    global: number;
    projects: Array<{ scope: string; count: number }>;
    provisional: number;
    durable: number;
    superseded: number;
    stale: Array<{ id: string; name: string | null; reason: string }>;
    duplicates: Array<{ a: { id: string; name: string | null }; b: { id: string; name: string | null }; similarity: number }>;
  };
  usage: {
    events: number;
    sessions: number;
    byProvider: Array<{ provider: string; sessions: number; injections: number; recalls: number; writes: number; cites: number }>;
    perSession: Array<{ session: string; provider: string | null; startedAt: string; turns: number; injected: number; tokens: number; cites: number }>;
    avgTokens: { sessionStart: number | null; turn: number | null };
    turnInjectionRate: number | null;
    recallHitRate: number | null;
    citations: number;
    latency: Record<string, { n: number; p50: number | null; p95: number | null }>;
    mostUsed: Array<{ id: string; name: string | null; uses: number; cites: number }>;
    neverUsed: Array<{ id: string; name: string | null; kind: BrainKind }>;
  };
  activity: {
    recentWrites: Array<{ id: string; name: string | null; kind: BrainKind; source: string | null; at: string; superseded: boolean }>;
    bySource: Array<{ source: string; count: number }>;
    timeline: Array<{ day: string; created: number; updated: number; injections: number; recalls: number }>;
  };
  eval: { at: string; detail: Record<string, unknown> } | null;
}

function sourceGroup(source: string | null): string {
  if (!source) return "unknown";
  if (source.startsWith("import:")) return "import";
  return source.split("/")[0]!;
}

export function computeStats(records: readonly BrainRecord[], usage: readonly UsageRow[], now = Date.now()): BrainStats {
  const live = records.filter((r) => r.supersededBy === null);
  const byKind = Object.fromEntries(BRAIN_KINDS.map((k) => [k, live.filter((r) => r.kind === k).length])) as Record<BrainKind, number>;
  const projects = new Map<string, number>();
  for (const r of live) if (r.scope !== GLOBAL_SCOPE) projects.set(r.scope, (projects.get(r.scope) ?? 0) + 1);

  const stale: BrainStats["health"]["stale"] = [];
  for (const r of live) {
    const verified = Date.parse(r.verifiedAt ?? r.updatedAt);
    const missing = namedPaths(r.body).filter((p) => !existsSync(p));
    if (missing.length) stale.push({ id: r.id, name: r.name, reason: `names a missing path: ${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1})` : ""}` });
    else if (Number.isFinite(verified) && now - verified > STALE_DAYS * DAY) {
      stale.push({ id: r.id, name: r.name, reason: `unverified for ${Math.floor((now - verified) / DAY)} days` });
    }
  }

  const duplicates: BrainStats["health"]["duplicates"] = [];
  const bags = live.map((r) => ({ r, w: words(r) }));
  for (let i = 0; i < bags.length; i++) {
    for (let j = i + 1; j < bags.length; j++) {
      const s = jaccard(bags[i]!.w, bags[j]!.w);
      if (s >= 0.45) duplicates.push({ a: { id: bags[i]!.r.id, name: bags[i]!.r.name }, b: { id: bags[j]!.r.id, name: bags[j]!.r.name }, similarity: Math.round(s * 100) / 100 });
    }
  }
  duplicates.sort((x, y) => y.similarity - x.similarity);

  // ---- usage
  const sessions = new Map<string, BrainStats["usage"]["perSession"][number]>();
  const providers = new Map<string, { sessions: Set<string>; injections: number; recalls: number; writes: number; cites: number }>();
  const uses = new Map<string, number>();
  const cites = new Map<string, number>();
  const latency = new Map<string, number[]>();
  const startTokens: number[] = [];
  const turnTokens: number[] = [];
  let turns = 0;
  let turnsWithInjection = 0;
  let recalls = 0;
  let recallsWithHits = 0;
  for (const row of usage) {
    const provider = row.provider ?? "unknown";
    const p = providers.get(provider) ?? { sessions: new Set<string>(), injections: 0, recalls: 0, writes: 0, cites: 0 };
    providers.set(provider, p);
    if (row.session) p.sessions.add(row.session);
    if (row.latencyMs !== null) latency.set(row.event, [...(latency.get(row.event) ?? []), row.latencyMs]);
    if (row.event === "session_start" || row.event === "turn") {
      p.injections += row.recordIds.length ? 1 : 0;
      for (const id of row.recordIds) uses.set(id, (uses.get(id) ?? 0) + 1);
      if (row.event === "session_start") startTokens.push(row.tokens ?? 0);
      else {
        turns++;
        if (row.recordIds.length) {
          turnsWithInjection++;
          turnTokens.push(row.tokens ?? 0);
        }
      }
      if (row.session) {
        const s = sessions.get(row.session) ?? { session: row.session, provider: row.provider, startedAt: row.at, turns: 0, injected: 0, tokens: 0, cites: 0 };
        if (row.at < s.startedAt) s.startedAt = row.at;
        if (row.event === "turn") s.turns++;
        s.injected += row.recordIds.length;
        s.tokens += row.tokens ?? 0;
        sessions.set(row.session, s);
      }
    } else if (row.event === "recall") {
      p.recalls++;
      recalls++;
      if (row.recordIds.length) recallsWithHits++;
      for (const id of row.recordIds) uses.set(id, (uses.get(id) ?? 0) + 1);
    } else if (row.event === "remember" || row.event === "verify" || row.event === "forget") {
      p.writes++;
    } else if (row.event === "cite") {
      p.cites++;
      for (const id of row.recordIds) cites.set(id, (cites.get(id) ?? 0) + 1);
      if (row.session && sessions.has(row.session)) sessions.get(row.session)!.cites += row.recordIds.length;
    }
  }
  const nameOf = new Map(records.map((r) => [r.id, r.name]));
  const mostUsed = [...uses.entries()]
    .map(([id, n]) => ({ id, name: nameOf.get(id) ?? null, uses: n, cites: cites.get(id) ?? 0 }))
    .sort((a, b) => b.cites - a.cites || b.uses - a.uses)
    .slice(0, 10);
  const neverUsed = live.filter((r) => !uses.has(r.id) && !cites.has(r.id)).map((r) => ({ id: r.id, name: r.name, kind: r.kind }));

  // ---- activity
  const timeline = new Map<string, { day: string; created: number; updated: number; injections: number; recalls: number }>();
  const dayOf = (iso: string) => iso.slice(0, 10);
  const bump = (day: string, key: "created" | "updated" | "injections" | "recalls") => {
    const t = timeline.get(day) ?? { day, created: 0, updated: 0, injections: 0, recalls: 0 };
    t[key]++;
    timeline.set(day, t);
  };
  for (const r of records) {
    if (r.createdAt) bump(dayOf(r.createdAt), "created");
    if (r.updatedAt && dayOf(r.updatedAt) !== dayOf(r.createdAt)) bump(dayOf(r.updatedAt), "updated");
  }
  for (const row of usage) {
    if (row.event === "session_start" || row.event === "turn") bump(dayOf(row.at), "injections");
    if (row.event === "recall") bump(dayOf(row.at), "recalls");
  }
  const bySource = new Map<string, number>();
  for (const r of records) bySource.set(sourceGroup(r.source), (bySource.get(sourceGroup(r.source)) ?? 0) + 1);

  const lastEval = usage.find((row) => row.event === "eval") ?? null;

  return {
    generatedAt: new Date(now).toISOString(),
    health: {
      total: records.length,
      live: live.length,
      byKind,
      global: live.filter((r) => r.scope === GLOBAL_SCOPE).length,
      projects: [...projects.entries()].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count),
      provisional: live.filter((r) => r.provisional).length,
      durable: live.filter((r) => !r.provisional).length,
      superseded: records.length - live.length,
      stale,
      duplicates: duplicates.slice(0, 20),
    },
    usage: {
      events: usage.length,
      sessions: sessions.size,
      byProvider: [...providers.entries()]
        .map(([provider, p]) => ({ provider, sessions: p.sessions.size, injections: p.injections, recalls: p.recalls, writes: p.writes, cites: p.cites }))
        .sort((a, b) => b.sessions - a.sessions || b.recalls - a.recalls),
      perSession: [...sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20),
      avgTokens: { sessionStart: mean(startTokens), turn: mean(turnTokens) },
      turnInjectionRate: turns ? Math.round((turnsWithInjection / turns) * 100) / 100 : null,
      recallHitRate: recalls ? Math.round((recallsWithHits / recalls) * 100) / 100 : null,
      citations: [...cites.values()].reduce((a, b) => a + b, 0),
      latency: Object.fromEntries([...latency.entries()].map(([event, values]) => [event, { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }])),
      mostUsed,
      neverUsed,
    },
    activity: {
      recentWrites: [...records]
        .filter((r) => !r.source?.startsWith("import:"))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 12)
        .map((r) => ({ id: r.id, name: r.name, kind: r.kind, source: r.source, at: r.updatedAt, superseded: r.supersededBy !== null })),
      bySource: [...bySource.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
      timeline: [...timeline.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-60),
    },
    eval: lastEval ? { at: lastEval.at, detail: lastEval.detail ?? {} } : null,
  };
}
