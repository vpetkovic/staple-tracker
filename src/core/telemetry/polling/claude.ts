/**
 * Claude: the subscription limits Claude Code's `/usage` shows, from the OAuth usage
 * endpoint it calls (`GET https://api.anthropic.com/api/oauth/usage`, header
 * `anthropic-beta: oauth-2025-04-20`), read with Claude Code's own sign-in for the bound
 * config directory.
 *
 * ## Where the sign-in is
 *
 * Claude Code keeps it, on macOS, in the login keychain as a generic password filed under
 * the OS user name, service `Claude Code-credentials`, and for a non-default config
 * directory (`CLAUDE_CONFIG_DIR`) `Claude Code-credentials-<first 8 hex of sha256(dir)>`;
 * elsewhere (and as its own fallback) in `<config dir>/.credentials.json`. Both hold
 * `{"claudeAiOauth": {"accessToken", "expiresAt" (epoch ms), "scopes", …}}`. Only the access
 * token, its expiry and its scopes are read. A binding for a non-default directory is
 * only ever read from that directory's own item or file: never another account's.
 *
 * ## What is kept
 *
 * `five_hour` and `seven_day`, each `{utilization (percent), resets_at (ISO instant)}`: the
 * two limits the status line reports (`sources/claude-statusline.ts`), under the same
 * limit keys and documented window lengths, so a polled reading joins the same window a
 * status-line reading would. Everything else in the answer (spend, per-model and
 * codenamed limits, breakdowns) is ignored. A limit with no reset instant has no window
 * running: it is named in `idle` and stores nothing.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { userHome } from "../../../config/home.js";
import { expandHomePath } from "../bindings.js";
import type { KnownBinding } from "../config.js";
import type { BudgetReading, Missing } from "../budget-store.js";
import { normalizeInstant } from "../formats.js";
import { DOCUMENTED_WINDOW_SECONDS, skip, type ParsedItem } from "../sources/types.js";
import { asRecord, failure, getJson, type PollContext, type PollResult, type UsagePoller } from "./types.js";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
/** The limits the status line reports, and the only ones kept. */
const CLAUDE_LIMITS = ["five_hour", "seven_day"] as const;

const SIGN_IN = "Sign in to Claude Code again (run claude, then /login) and the next check will read your limits.";

/** The keychain services Claude Code may have filed this directory's sign-in under, in the order to try them. */
export function claudeKeychainServices(configDir: string, written: string = configDir): string[] {
  const hashed = (dir: string) => `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
  const services: string[] = [];
  if (configDir === join(userHome(), ".claude")) services.push("Claude Code-credentials");
  services.push(hashed(configDir));
  if (written !== configDir) services.push(hashed(written));
  return [...new Set(services)];
}

interface ClaudeLogin {
  readonly accessToken: string;
}

async function readLogin(binding: KnownBinding & { source: "claude_code_statusline" }, context: PollContext): Promise<ClaudeLogin | PollResult> {
  const configDir = expandHomePath(binding.configDir);
  let raw: string | null = null;
  if (context.platform === "darwin") {
    for (const service of claudeKeychainServices(configDir, binding.configDir)) {
      raw = await context.secrets.keychain(service, context.userName);
      if (raw !== null) break;
    }
  }
  raw ??= context.secrets.file(join(configDir, ".credentials.json"));
  if (raw === null) {
    return failure("signed_out", `Claude Code isn't signed in for ${configDir} on this computer, so we can't read your limits. ${SIGN_IN}`);
  }
  let oauth: Record<string, unknown> | null = null;
  try {
    oauth = asRecord(asRecord(JSON.parse(raw))?.claudeAiOauth);
  } catch {
    // Never quote the parse error: it can carry part of the stored sign-in.
  }
  const accessToken = oauth?.accessToken;
  if (oauth === null || typeof accessToken !== "string" || accessToken.trim() === "") {
    return failure("signed_out", `Claude Code's sign-in for ${configDir} has no subscription login, so we can't read your limits. ${SIGN_IN}`);
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.parse(context.now())) {
    return failure("expired", `Claude Code's sign-in on this computer has expired, so we can't read your limits. ${SIGN_IN}`);
  }
  const scopes = oauth.scopes;
  if (Array.isArray(scopes) && !scopes.includes("user:profile")) {
    return failure(
      "unsupported_login",
      "Claude Code is signed in with a token that can't read usage (a long-lived setup token). Sign in with /login in Claude Code to let us read your limits.",
    );
  }
  return { accessToken };
}

/** The usage answer as readings, or the reason it cannot be read. Pure: exported for the tests. */
export function parseClaudeUsage(body: unknown, observedAt: string): { items: ParsedItem[]; idle: string[] } | null {
  const record = asRecord(body);
  if (record === null) return null;
  const items: ParsedItem[] = [];
  const idle: string[] = [];
  let seen = 0;
  for (const limitKey of CLAUDE_LIMITS) {
    if (!(limitKey in record)) continue;
    seen += 1;
    const value = record[limitKey];
    if (value === null || value === undefined) {
      items.push(skip("not_reported_by_source", limitKey, observedAt));
      continue;
    }
    const limit = asRecord(value);
    const used = limit?.utilization;
    if (limit === null || (used !== null && used !== undefined && (typeof used !== "number" || !Number.isFinite(used)))) {
      items.push(skip("parse_error", limitKey, observedAt));
      continue;
    }
    if (used === null || used === undefined) {
      items.push(skip("not_reported_by_source", limitKey, observedAt));
      continue;
    }
    const rawReset = limit.resets_at;
    if (rawReset === null || rawReset === undefined) {
      // No reset instant: no window is running (nothing used since the last one ended).
      idle.push(limitKey);
      items.push(skip("not_reported_by_source", limitKey, observedAt));
      continue;
    }
    const resetsAt = normalizeInstant(rawReset);
    if (resetsAt === null) {
      items.push(skip("parse_error", limitKey, observedAt));
      continue;
    }
    const windowSeconds = DOCUMENTED_WINDOW_SECONDS.anthropic?.[limitKey] ?? null;
    const missing: Missing = { planTier: "not_reported_by_source", sessionRef: "not_reported_by_source" };
    if (windowSeconds === null) missing.windowSeconds = "not_reported_by_source";
    const reading: BudgetReading = {
      limitKey,
      unit: "percent_of_limit",
      usedPercent: used,
      resetsAt,
      resetsAtSource: "observed_absolute",
      windowSeconds,
      windowSecondsSource: windowSeconds === null ? null : "documented",
      planTier: null,
      method: "observed",
      // An undocumented endpoint, as the Codex rollout is.
      confidence: "medium",
      source: { kind: "usage_poll", harnessVersion: null, field: `oauth/usage.${limitKey}` },
      observedAt,
      observedAtSource: "provider",
      sessionRef: null,
      missing,
    };
    items.push({ kind: "reading", reading });
  }
  return seen === 0 ? null : { items, idle };
}

export const claudePoller: UsagePoller = {
  id: "claude",
  name: "Claude",
  bindingSource: "claude_code_statusline",
  provider: "anthropic",
  host: new URL(CLAUDE_USAGE_URL).host,
  isAvailable: (binding) => binding.source === "claude_code_statusline" && binding.provider === "anthropic",
  async poll(binding, context) {
    if (binding.source !== "claude_code_statusline") return failure("signed_out", "This binding is not a Claude Code config directory.");
    const login = await readLogin(binding, context);
    if (!("accessToken" in login)) return login;
    const answer = await getJson(
      context,
      CLAUDE_USAGE_URL,
      { Authorization: `Bearer ${login.accessToken}`, "anthropic-beta": CLAUDE_OAUTH_BETA, Accept: "application/json", "User-Agent": "staple-usage-poll" },
      "Claude",
      SIGN_IN,
    );
    if (!answer.ok) return answer;
    const parsed = parseClaudeUsage(answer.body, context.now());
    if (parsed === null) return failure("unexpected_response", "Claude answered without the 5-hour or weekly limit, so no reading was stored.");
    return { ok: true, items: parsed.items, idle: parsed.idle };
  },
};
