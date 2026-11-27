/**
 * The Analytics read as the server asks for it: a scope of open workspaces in, the contract's
 * answer out. The routes in `src/ui/server.ts` resolve the scope (which workspaces, which of
 * them could not be opened) and call one function here, so the HTTP layer stays a thin parse.
 */
import type { DatabaseSync } from "node:sqlite";
import { StapleError } from "../types.js";
import type { AgentTypeRule } from "./agent-type.js";
import type { AnalyticsReport, AnalyticsWorkspaceRef, Caveat, CostModelResponse, RoiResponse, RoiTicketsResponse } from "./contract.js";
import { COST_MODEL_PARTS, activeProfile, aiSpendFor, resolveRoles, roi, spendCovers, type CostModel } from "./cost-model.js";
import type { AgentType } from "./agent-type.js";
import { analyticsReport, resolvePeriod, roleTallies, round2, type AnalyticsQuery } from "./metrics.js";
import { readWorkspaceRows, type WorkspaceRows } from "./rows.js";

/** One workspace the scope covers, opened. */
export interface AnalyticsSource {
  readonly slug: string;
  readonly prefix: string;
  readonly db: DatabaseSync;
}

export interface AnalyticsScope {
  readonly kind: "hub" | "workspace";
  /** The workspaces to read. */
  readonly sources: readonly AnalyticsSource[];
  /** Every workspace the scope names, the ones that could not be opened included. */
  readonly refs: readonly AnalyticsWorkspaceRef[];
}

/** The rows of every source, in scope order. */
function rowsOf(scope: AnalyticsScope): WorkspaceRows[] {
  return scope.sources.map((source) => readWorkspaceRows(source.db, { slug: source.slug, prefix: source.prefix }));
}

export function readAnalytics(scope: AnalyticsScope, query: Omit<AnalyticsQuery, "rules">, rules: readonly AgentTypeRule[] = []): AnalyticsReport {
  return analyticsReport(rowsOf(scope), { kind: scope.kind, workspaces: scope.refs }, { ...query, rules });
}

/**
 * The ROI read (`RoiResponse`): the scope's value under both lenses against its share of the
 * hub's costs.
 *
 * Costs belong to the person, not to a workspace: one AI bill and one director cover every
 * workspace in the hub. So the AI spend over the period and the director's hours (the hub's
 * active days × hours per active day) are found for the whole hub, and a one-workspace scope
 * carries the share of them its agent-hours are of the hub's. Every workspace's costs then add
 * up to the hub's, and `basis` echoes each input so the page can print the formula.
 */
export function readRoi(input: {
  readonly scope: AnalyticsScope;
  /** The whole hub (the same as `scope` when the scope is the hub, or a single-workspace server). */
  readonly hub: AnalyticsScope;
  readonly query: Omit<AnalyticsQuery, "rules">;
  readonly model: CostModelResponse;
}): RoiResponse {
  const costModel = input.model.model as CostModel;
  const rules = costModel.roleMapping.rules;
  const hubRows = rowsOf(input.hub);
  // The scope's workspaces are read once, as part of the hub, whenever the hub holds them all.
  const wanted = new Set(input.scope.sources.map((source) => source.slug));
  const fromHub = hubRows.filter((rows) => wanted.has(rows.slug));
  const scopeRows = input.scope === input.hub ? hubRows : fromHub.length === wanted.size ? fromHub : rowsOf(input.scope);
  const report = analyticsReport(scopeRows, { kind: input.scope.kind, workspaces: input.scope.refs }, { ...input.query, rules });
  const resolved = resolvePeriod(scopeRows, input.query);
  const roles = resolveRoles(costModel);
  const roleOf = (type: AgentType): string => costModel.roleMapping.types[type];
  const scoped = roleTallies(scopeRows, resolved, rules, roleOf);
  const hub = hubRows === scopeRows ? scoped : roleTallies(hubRows, resolved, rules, roleOf);
  const share = hubRows === scopeRows ? 1 : hub.agentHours > 0 ? scoped.agentHours / hub.agentHours : 0;
  const days = resolved.window.days;
  const profile = activeProfile(costModel);
  // Each entry is the person's or the team's whole bill; a single workspace carries its share of it.
  const aiEntries = profile.entries.map((entry) => ({ entry, cost: aiSpendFor([entry], days) * share }));
  const aiSpendHub = aiSpendFor(profile.entries, days);
  const hoursPerActiveDay = profile.director.hoursPerActiveDay;
  const directorHoursHub = hub.activeDays * hoursPerActiveDay;
  const lens = (name: "measured" | "planned") =>
    roi({ lens: name, byRole: scoped[name], aiEntries, directorHours: directorHoursHub * share, model: costModel });
  const { fallbacks } = roles;
  const caveats: Caveat[] = [...report.caveats];
  const defaults = COST_MODEL_PARTS.filter((part) => input.model.source[part] === "default").length;
  if (defaults > 0) caveats.push({ code: "default_cost_model", count: defaults, of: COST_MODEL_PARTS.length });
  if (fallbacks.length > 0) caveats.push({ code: "mapping_fallback", count: fallbacks.length, of: null });
  if (input.model.home.slug !== null && !input.model.home.synced) caveats.push({ code: "home_not_synced", count: 1, of: null });
  if (input.model.home.others.length > 0) caveats.push({ code: "several_homes", count: input.model.home.others.length + 1, of: null });
  if (!spendCovers(profile.entries, days)) caveats.push({ code: "no_ai_spend", count: 1, of: null });
  return {
    asOf: input.query.now,
    period: report.period,
    scope: report.scope,
    model: input.model,
    measured: lens("measured"),
    planned: lens("planned"),
    basis: {
      aiSpendHub,
      directorHoursHub,
      activeDaysHub: hub.activeDays,
      hoursPerActiveDay,
      share,
      scopeAgentHours: round2(scoped.agentHours),
      hubAgentHours: round2(hub.agentHours),
    },
    agentTypes: report.agentTypes,
    fallbacks,
    caveats,
  };
}

/** The tickets behind one role row (`RoiTicketsResponse`), at most `limit` of them. */
export function readRoiTickets(input: {
  readonly scope: AnalyticsScope;
  readonly query: Omit<AnalyticsQuery, "rules">;
  readonly model: CostModelResponse;
  readonly roleId: string;
  readonly limit?: number;
}): RoiTicketsResponse {
  const costModel = input.model.model as CostModel;
  const rows = rowsOf(input.scope);
  const resolved = resolvePeriod(rows, input.query);
  const roles = resolveRoles(costModel);
  // Price unknown role ids the way the ROI does, so the list behind a row is the row's.
  const priced = (id: string): string => roles.role(id).id;
  const tallies = roleTallies(rows, resolved, costModel.roleMapping.rules, (type: AgentType) => costModel.roleMapping.types[type]);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
    throw new StapleError("validation", `limit takes a whole number from 1 to 200; got ${JSON.stringify(input.limit)}.`);
  }
  const limit = input.limit ?? 200;
  const tickets = [...tallies.tickets.entries()]
    .filter(([id]) => priced(id) === input.roleId)
    .flatMap(([, list]) => list)
    .sort((a, b) => b.agentSeconds - a.agentSeconds || a.identifier.localeCompare(b.identifier));
  const other = [...tallies.otherHours.entries()].filter(([id]) => priced(id) === input.roleId).reduce((sum, [, value]) => sum + value, 0);
  return {
    roleId: input.roleId,
    period: resolved.period,
    total: tickets.length,
    limit,
    tickets: tickets.slice(0, limit).map((ticket) => ({
      workspace: ticket.workspace,
      identifier: ticket.identifier,
      title: ticket.title,
      type: ticket.type,
      reason: { code: ticket.reason.code, detail: ticket.reason.detail },
      plannedHours: ticket.plannedSeconds === null ? null : round2(ticket.plannedSeconds / 3600),
      agentHours: round2(ticket.agentSeconds / 3600),
    })),
    otherAgentHours: round2(other),
  };
}
