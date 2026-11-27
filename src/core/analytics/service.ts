/**
 * The Analytics read as the server asks for it: a scope of open workspaces in, the contract's
 * answer out. The routes in `src/ui/server.ts` resolve the scope (which workspaces, which of
 * them could not be opened) and call one function here, so the HTTP layer stays a thin parse.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AgentTypeRule } from "./agent-type.js";
import type { AnalyticsReport, AnalyticsWorkspaceRef, Caveat, CostModelResponse, RoiResponse } from "./contract.js";
import { COST_MODEL_PARTS, aiSpendFor, resolveRoles, roi, type CostModel } from "./cost-model.js";
import { analyticsReport, hoursByType, resolvePeriod, type AnalyticsQuery } from "./metrics.js";
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
export function rowsOf(scope: AnalyticsScope): WorkspaceRows[] {
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
  const scopeRows = rowsOf(input.scope);
  const hubRows = input.scope === input.hub ? scopeRows : rowsOf(input.hub);
  const report = analyticsReport(scopeRows, { kind: input.scope.kind, workspaces: input.scope.refs }, { ...input.query, rules });
  const resolved = resolvePeriod(scopeRows, input.query);
  const scoped = hoursByType(scopeRows, resolved, rules);
  const hub = hubRows === scopeRows ? scoped : hoursByType(hubRows, resolved, rules);
  const share = input.scope.kind === "hub" || hubRows === scopeRows ? 1 : hub.agentHours > 0 ? scoped.agentHours / hub.agentHours : 0;
  const aiSpendHub = aiSpendFor(costModel.aiSpend, resolved.window.days);
  const hoursPerActiveDay = costModel.scenario.director.hoursPerActiveDay;
  const directorHoursHub = hub.activeDays * hoursPerActiveDay;
  const lens = (name: "measured" | "planned") =>
    roi({ lens: name, hoursByType: scoped[name], aiCost: aiSpendHub * share, directorHours: directorHoursHub * share, model: costModel });
  const { fallbacks } = resolveRoles(costModel);
  const caveats: Caveat[] = [...report.caveats];
  const defaults = COST_MODEL_PARTS.filter((part) => input.model.source[part] === "default").length;
  if (defaults > 0) caveats.push({ code: "default_cost_model", count: defaults, of: COST_MODEL_PARTS.length });
  if (fallbacks.length > 0) caveats.push({ code: "mapping_fallback", count: fallbacks.length, of: null });
  if (input.model.home.slug !== null && !input.model.home.synced) caveats.push({ code: "home_not_synced", count: 1, of: null });
  if (input.model.home.others.length > 0) caveats.push({ code: "several_homes", count: input.model.home.others.length + 1, of: null });
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
      scopeAgentHours: scoped.agentHours,
      hubAgentHours: hub.agentHours,
    },
    agentTypes: report.agentTypes,
    fallbacks,
    caveats,
  };
}
