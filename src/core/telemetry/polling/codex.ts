/**
 * Codex: the plan limits Codex CLI shows in `/status`, from the ChatGPT backend usage
 * endpoint it calls (`GET https://chatgpt.com/backend-api/wham/usage`, headers
 * `Authorization: Bearer <access token>` and `ChatGPT-Account-Id`), read with Codex's own
 * sign-in in the bound Codex home.
 *
 * ## Where the sign-in is
 *
 * `<codex home>/auth.json`: `{"auth_mode": "chatgpt", "tokens": {"access_token",
 * "account_id", …}}`. Only the access token and the account id are read; the token's
 * `exp` claim is decoded (not verified) to report an expired sign-in without sending it.
 * An API-key login has no plan limits to read. A Codex configured to keep its sign-in in
 * the OS keyring has no auth.json, and is reported as signed out.
 *
 * ## What is kept
 *
 * `rate_limit.primary_window` and `.secondary_window`, each `{used_percent,
 * limit_window_seconds, reset_at (epoch s), reset_after_seconds}`, as `codex.primary` and
 * `codex.secondary`: the limit keys the rollout parser gives the same limits
 * (`sources/codex-rollout.ts`, `limit_id: "codex"`), with the observed window length and
 * the plan name, so a polled reading joins the window a rollout reading would. An
 * `additional_rate_limits` entry is kept the same way under its `metered_feature`. The
 * rest of the answer (the account's email and user id among it) is never read into
 * anything kept.
 *
 * A window that has not started (nothing used since the last one ended) is reported with
 * 0% used and a reset one full window from now, which moves on every request. It is named
 * in `idle` and stores nothing, rather than minting a new window instance per check.
 */
import { join } from "node:path";
import { expandHomePath } from "../bindings.js";
import type { KnownBinding } from "../config.js";
import type { BudgetReading, Missing } from "../budget-store.js";
import { epochSecondsToIso } from "../formats.js";
import { skip, type ParsedItem } from "../sources/types.js";
import { asRecord, failure, getJson, type PollContext, type PollResult, type UsagePoller } from "./types.js";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** A window whose reset is this close to a full window away has not started. */
const NOT_STARTED_SLACK_SECONDS = 5;

const SIGN_IN = "Sign in to Codex again (run codex, or codex login) and the next check will read your limits.";

interface CodexLogin {
  readonly accessToken: string;
  readonly accountId: string;
}

/** The `exp` claim of a JWT, in epoch seconds, or null when it has none or is not a JWT. */
function tokenExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

function readLogin(binding: KnownBinding & { source: "codex_rollout" }, context: PollContext): CodexLogin | PollResult {
  const home = expandHomePath(binding.home);
  const raw = context.secrets.file(join(home, "auth.json"));
  if (raw === null) {
    return failure("signed_out", `Codex isn't signed in for ${home} on this computer, so we can't read your limits. ${SIGN_IN}`);
  }
  let auth: Record<string, unknown> | null = null;
  try {
    auth = asRecord(JSON.parse(raw));
  } catch {
    // Never quote the parse error: it can carry part of the stored sign-in.
  }
  const tokens = asRecord(auth?.tokens);
  const accessToken = tokens?.access_token;
  const accountId = tokens?.account_id;
  if (typeof accessToken !== "string" || accessToken === "" || typeof accountId !== "string" || accountId === "") {
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY !== "") {
      return failure("unsupported_login", "Codex is signed in with an API key, which has no plan limits to read. Sign in with your ChatGPT plan (codex login) to see them.");
    }
    return failure("signed_out", `Codex's sign-in for ${home} has no ChatGPT login, so we can't read your limits. ${SIGN_IN}`);
  }
  const exp = tokenExpiry(accessToken);
  if (exp !== null && exp * 1000 <= Date.parse(context.now())) {
    return failure("expired", `Codex's sign-in on this computer has expired, so we can't read your limits. ${SIGN_IN}`);
  }
  return { accessToken, accountId };
}

/** One window of a rate limit as a reading, a skip, or idle. */
function windowItem(
  limitId: string,
  position: "primary" | "secondary",
  value: unknown,
  planTier: string | null,
  observedAt: string,
  idle: string[],
): ParsedItem {
  const limitKey = `${limitId}.${position}`;
  if (value === null || value === undefined) return skip("not_reported_by_source", limitKey, observedAt);
  const window = asRecord(value);
  const used = window?.used_percent;
  if (window === null || typeof used !== "number" || !Number.isFinite(used)) return skip(window === null || used !== undefined ? "parse_error" : "not_reported_by_source", limitKey, observedAt);
  const length = window.limit_window_seconds;
  const windowSeconds = typeof length === "number" && Number.isFinite(length) && length > 0 ? length : null;
  const after = window.reset_after_seconds;
  if (used === 0 && windowSeconds !== null && typeof after === "number" && Math.abs(after - windowSeconds) <= NOT_STARTED_SLACK_SECONDS) {
    idle.push(limitKey);
    return skip("not_reported_by_source", limitKey, observedAt);
  }
  const resetsAt = epochSecondsToIso(window.reset_at);
  const missing: Missing = { sessionRef: "not_reported_by_source" };
  if (resetsAt === null) missing.resetsAt = window.reset_at === undefined || window.reset_at === null ? "reset_not_reported" : "parse_error";
  if (windowSeconds === null) missing.windowSeconds = length === undefined || length === null ? "not_reported_by_source" : "parse_error";
  if (planTier === null) missing.planTier = "not_reported_by_source";
  const reading: BudgetReading = {
    limitKey,
    unit: "percent_of_limit",
    usedPercent: used,
    resetsAt,
    resetsAtSource: resetsAt === null ? null : "observed_absolute",
    windowSeconds,
    windowSecondsSource: windowSeconds === null ? null : "observed",
    planTier,
    method: "observed",
    // An undocumented endpoint, as the rollout is.
    confidence: "medium",
    source: { kind: "usage_poll", harnessVersion: null, field: `wham/usage.${limitId === "codex" ? "rate_limit" : limitId}.${position}_window` },
    observedAt,
    // The answer carries no timestamp of its own: observedAt is this machine's clock when it arrived.
    observedAtSource: "capture",
    sessionRef: null,
    missing,
  };
  return { kind: "reading", reading };
}

/** The usage answer as readings, or null when it is not one. Pure: exported for the tests. */
export function parseCodexUsage(body: unknown, observedAt: string): { items: ParsedItem[]; idle: string[] } | null {
  const record = asRecord(body);
  const rateLimit = asRecord(record?.rate_limit);
  if (record === null || rateLimit === null) return null;
  const planTier = typeof record.plan_type === "string" && record.plan_type !== "" ? record.plan_type : null;
  const idle: string[] = [];
  const items: ParsedItem[] = [
    windowItem("codex", "primary", rateLimit.primary_window, planTier, observedAt, idle),
    windowItem("codex", "secondary", rateLimit.secondary_window, planTier, observedAt, idle),
  ];
  if (Array.isArray(record.additional_rate_limits)) {
    for (const entry of record.additional_rate_limits) {
      const extra = asRecord(entry);
      const feature = extra?.metered_feature;
      const limits = asRecord(extra?.rate_limit);
      if (typeof feature !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(feature) || limits === null) continue;
      const id = feature.toLowerCase();
      items.push(windowItem(id, "primary", limits.primary_window, planTier, observedAt, idle));
      items.push(windowItem(id, "secondary", limits.secondary_window, planTier, observedAt, idle));
    }
  }
  return { items, idle };
}

export const codexPoller: UsagePoller = {
  id: "codex",
  name: "Codex",
  bindingSource: "codex_rollout",
  provider: "openai",
  host: new URL(CODEX_USAGE_URL).host,
  isAvailable: (binding) => binding.source === "codex_rollout" && binding.provider === "openai",
  async poll(binding, context) {
    if (binding.source !== "codex_rollout") return failure("signed_out", "This binding is not a Codex home.");
    const login = readLogin(binding, context);
    if (!("accessToken" in login)) return login;
    const answer = await getJson(
      context,
      CODEX_USAGE_URL,
      { Authorization: `Bearer ${login.accessToken}`, "ChatGPT-Account-Id": login.accountId, Accept: "application/json", "User-Agent": "staple-usage-poll" },
      "Codex",
      SIGN_IN,
    );
    if (!answer.ok) return answer;
    const parsed = parseCodexUsage(answer.body, context.now());
    if (parsed === null) return failure("unexpected_response", "Codex answered without its rate limits, so no reading was stored.");
    return { ok: true, items: parsed.items, idle: parsed.idle };
  },
};
