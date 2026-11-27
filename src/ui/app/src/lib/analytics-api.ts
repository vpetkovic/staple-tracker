/**
 * The Analytics page's API client: `/api/analytics`, `/api/analytics/cost-model` and
 * `/api/analytics/roi`.
 *
 * The wire types are not restated here. They are imported, type-only, from the server's
 * contract module (`src/core/analytics/contract.ts`), which has no imports of its own, so
 * the widgets and the server read one definition and cannot drift. The agreed text of the
 * contract is the `api-contract` document on the Analytics epic.
 */
import { apiRequest } from "./api";
import type {
  AnalyticsReport,
  Bucket,
  CostModelResponse,
  CostModelWrite,
  DateKey,
  RoiResponse,
} from "../../../../core/analytics/contract";

export type * from "../../../../core/analytics/contract";

/** What every Analytics read takes. Omitted fields take the server's defaults (all time, the hub, UTC). */
export interface AnalyticsQuery {
  /** `hub`, or a workspace slug. */
  readonly scope?: string;
  readonly from?: DateKey;
  readonly to?: DateKey;
  /** An IANA zone. Defaults to the browser's own. */
  readonly tz?: string;
  readonly bucket?: Bucket;
}

/** The browser's time zone, the default every read is placed in. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function analyticsSearch(query: AnalyticsQuery): string {
  const search = new URLSearchParams();
  const tz = query.tz ?? browserTimeZone();
  for (const [key, value] of Object.entries({ scope: query.scope, from: query.from, to: query.to, tz, bucket: query.bucket })) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

export const fetchAnalytics = (query: AnalyticsQuery = {}): Promise<AnalyticsReport> =>
  apiRequest<AnalyticsReport>(`/api/analytics${analyticsSearch(query)}`);

export const fetchRoi = (query: AnalyticsQuery = {}): Promise<RoiResponse> =>
  apiRequest<RoiResponse>(`/api/analytics/roi${analyticsSearch(query)}`);

export const fetchCostModel = (scope?: string): Promise<CostModelResponse> =>
  apiRequest<CostModelResponse>(`/api/analytics/cost-model${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);

/** Save parts of the cost model (or reset them). Answers the model as it now stands. */
export const saveCostModel = (write: CostModelWrite, scope?: string): Promise<CostModelResponse> =>
  apiRequest<CostModelResponse>(`/api/analytics/cost-model${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...write }),
  });
