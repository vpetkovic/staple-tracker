/**
 * The Analytics read as the server asks for it: a scope of open workspaces in, the contract's
 * answer out. The routes in `src/ui/server.ts` resolve the scope (which workspaces, which of
 * them could not be opened) and call one function here, so the HTTP layer stays a thin parse.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AgentTypeRule } from "./agent-type.js";
import type { AnalyticsReport, AnalyticsWorkspaceRef } from "./contract.js";
import { analyticsReport, type AnalyticsQuery } from "./metrics.js";
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
