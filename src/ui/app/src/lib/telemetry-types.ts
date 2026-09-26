/**
 * The wire shapes of the budget-collection and binding routes, mirrored from
 * `src/core/telemetry/collection/service.ts` and `src/core/telemetry/budget-config.ts`
 * (`GET /api/budget/collection`, `POST /api/budget/collection/*`, `GET /api/budget/bindings`,
 * `POST /api/budget/bindings/*`, `POST /api/budget/capture`). The same payloads as
 * `staple budget status|setup|unsetup|collect|bindings|bind|unbind|capture --json`.
 *
 * Kept apart from lib/types.ts only so this lane's mirror is one file; the rule is the
 * same: a mirror, field for field, and nothing the server does not send.
 */

export type BindingSource = "claude_code_statusline" | "codex_rollout";

export type KnownBinding =
  | { source: "claude_code_statusline"; configDir: string; provider: string; accountRef: string }
  | { source: "codex_rollout"; home: string; provider: string; accountRef: string };

export interface BudgetConfigView {
  budgetCapture: boolean;
  bindings: KnownBinding[];
  unknownBindings: number;
  invalidBindings: Array<{ index: number; problem: string }>;
}

export type StepPart = "capture" | "claude_binding" | "codex_binding" | "statusline" | "watcher" | "record";
export type StepAction = "change" | "unchanged" | "skip" | "refuse";

export interface PlanStep {
  part: StepPart;
  action: StepAction;
  summary: string;
  path: string | null;
  target?: string;
}

export interface CollectionPlan {
  action: "setup" | "unsetup";
  steps: PlanStep[];
  changes: number;
  refusals: number;
  platform: string;
}

export interface PlanConsentTicket {
  id: string;
  digest: string;
  expiresAt: string;
}

export interface CollectionPlanResponse {
  plan: CollectionPlan;
  /** Null when the plan changes nothing or refuses something: there is nothing to consent to. */
  consent: PlanConsentTicket | null;
}

/** The options `/plan` takes for setup (the CLI's `staple budget setup` flags). */
export interface CollectionSetupOptions {
  claudeAccount?: string;
  codexAccount?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  statusline?: boolean;
  watcher?: boolean;
  intervalMinutes?: number;
}

export interface CollectionProblem {
  code: string;
  message: string;
}

export interface SourceStatus {
  source: BindingSource;
  dir: string;
  provider: string;
  accountRef: string;
  lastReading: { observedAt: string; recordedAt: string; sampleCount: number; ageSeconds: number } | null;
}

export type StatuslineState = "installed" | "hand_wrapped" | "not_installed" | "missing_file" | "invalid_json" | "unsupported";

export interface StatuslineStatus {
  configDir: string;
  settingsPath: string;
  state: StatuslineState;
  recorded: boolean;
  backupPath: string | null;
}

export interface CollectRunSummary {
  at: string;
  ok: boolean;
  skippedReason: "capture_disabled" | "no_codex_binding" | "locked" | null;
  scanned: number;
  changed: number;
  ingested: number;
  deferred: number;
  storedCount: number;
  errors: Array<{ file: string; message: string }>;
}

export interface WatcherStatus {
  supported: boolean;
  plistPath: string | null;
  installed: boolean;
  loaded: boolean | null;
  intervalMinutes: number | null;
  lastRun: CollectRunSummary | null;
  lastRunAgeSeconds: number | null;
  lastError: { at: string; message: string } | null;
  logPath: string;
  cronLine: string | null;
}

export interface CollectionStatus {
  budgetCapture: boolean;
  platform: string;
  bindings: KnownBinding[];
  sources: SourceStatus[];
  statusline: StatuslineStatus[];
  watcher: WatcherStatus;
  setup: { recorded: boolean; setupAt: string | null; path: string };
  problems: CollectionProblem[];
}

export interface CollectionOutcome {
  plan: CollectionPlan;
  applied: PlanStep[];
  status: CollectionStatus;
}

/** One collect run (`staple budget collect --json`). */
export interface CollectResult extends CollectRunSummary {
  homes: Array<{ home: string; sessionsDir: string; accountRef: string; present: boolean }>;
  cursorPath: string;
  logPath: string;
}

/** What a binding write sends: `source` as the CLI spells it, and the directory of that source. */
export type BindingSourceFlag = "claude-statusline" | "codex-rollout";

export interface BindingHomeInput {
  source: BindingSourceFlag;
  configDir?: string;
  codexHome?: string;
}

export interface BindInput extends BindingHomeInput {
  account: string;
  provider?: string;
  /** Edit: the binding this one replaces, removed in the same write. */
  replacing?: BindingHomeInput;
}
