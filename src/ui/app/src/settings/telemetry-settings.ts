/**
 * THE "USAGE & BUDGET" SECTION'S PURE HALF.
 *
 * The same discipline as `cloud-settings.ts`: everything this section decides that can be
 * decided without a DOM is here, so a test with no browser pins it, and the component
 * holds the wiring.
 *
 * ── NOT A REGISTRY CATEGORY, FOR THE CLOUD SECTION'S REASON ────────────────────────
 *
 * Capture, bindings and automatic collection live in this machine's staple home
 * (`config.json` `telemetry`, `telemetry/collection.json`), the Claude settings file and
 * `~/Library/LaunchAgents`: machine-local, never synced. The settings registry describes
 * values in the WORKSPACE database, which replicates. So the category is declared here
 * and composed into the nav by `SettingsDialog`, backed by the `/api/budget/*` routes;
 * `/api/settings` never learns it exists.
 *
 * ── WORDS FOR A NON-TECHNICAL READER, VALUES NOT PROSE ─────────────────────────────
 *
 * Every plain sentence below is chosen from a VALUE the server sends (a problem `code`, a
 * plan step's `part` and `action`, a wrapper `state`, a watcher's `installed`/`loaded`),
 * never by parsing a message. The server's own sentence is kept, verbatim, behind "Show
 * details", so nothing a power user or an agent reads is lost. An unknown code from a
 * newer server falls back to its own message.
 */
import { plainAge } from "@/lib/plain-language";
import type { PlainStatus } from "@/lib/plain-language";
import { CROSS_ORIGIN_MESSAGE } from "@/lib/refusal";
import type { SettingCategoryView } from "@/lib/settings";
import type {
  BindingSource,
  BindingSourceFlag,
  CollectResult,
  CollectionPlan,
  CollectionProblem,
  CollectionSetupOptions,
  CollectionStatus,
  KnownBinding,
  PlanStep,
  SourceStatus,
  StatuslineStatus,
  WatcherStatus,
} from "@/lib/telemetry-types";

export const TELEMETRY_CATEGORY_ID = "telemetry";

/**
 * The synthetic category. `scope: "global"` puts it under the nav's Global heading beside
 * Cloud and This machine, which is where a per-computer setting belongs. `order: 85` sits
 * it after Cloud (80) and before This machine (90). `editor` is inert: `CategoryContent`
 * matches the id before it switches on the editor.
 */
export const TELEMETRY_CATEGORY: SettingCategoryView = {
  id: TELEMETRY_CATEGORY_ID,
  // The Usage page's own name: one word for it everywhere (the rail, the tab bar, here).
  label: "Usage",
  description:
    "Whether this computer keeps track of how much of your Claude and Codex plans your agents use. " +
    "Stored on this computer only, never in the workspace.",
  scope: "global",
  editor: "fields",
  order: 85,
};

export function isTelemetryCategory(id: string | null | undefined): boolean {
  return id === TELEMETRY_CATEGORY_ID;
}

/** The served registry plus this one, in shell order; untouched while the registry is empty. */
export function withTelemetryCategory(categories: readonly SettingCategoryView[]): SettingCategoryView[] {
  if (categories.length === 0) return [...categories];
  if (categories.some((category) => category.id === TELEMETRY_CATEGORY_ID)) return [...categories];
  return [...categories, TELEMETRY_CATEGORY].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- fixed copy

export const PRIVACY_NOTE =
  "Readings stay on this computer; nothing is sent anywhere. Only the percentages your Claude and Codex plans report are kept, " +
  "never what you or your agents typed.";

export const WHAT_THIS_MEANS =
  "Claude and Codex plans have limits that reset every few hours and every week. When usage tracking is on, staple writes down " +
  "how much of each limit is left, so it can tell how much work fits before a limit runs out. An account link tells staple which " +
  "of your accounts a Claude or Codex folder on this computer spends from; the label is a name you choose, never an email.";

export const AUTOMATIC_COLLECTION_HELP =
  "Turning on automatic collection does, in one step, what would otherwise take five commands: it turns usage tracking on, " +
  "links your accounts, adds a small step to your Claude status line (a backup of your Claude settings is kept first) and " +
  "checks your Codex sessions every few minutes. Turning it off puts back exactly what it changed.";

/** The one wording of a write refused by the Origin check, shared with every view (`lib/refusal.ts`). */
export { CROSS_ORIGIN_MESSAGE };

/** True when the page is not on this computer's loopback address, so writes will be refused. */
export function viewedFromAnotherDevice(hostname: string): boolean {
  return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "";
}

/** What the section decides from the page's location (none outside a browser: not remote). */
export function remoteFromLocation(where: { hostname: string } | undefined): boolean {
  return where !== undefined && viewedFromAnotherDevice(where.hostname);
}

/**
 * The precise answer, once the server has said which origins it takes writes from
 * (`/api/bootstrap` `writeOrigins`): a page whose origin is not one of them is remote, which
 * also catches `localhost` on another port (a port-forward), where the hostname looks local.
 */
export function remoteFromOrigins(pageOrigin: string, writeOrigins: readonly string[]): boolean {
  return !writeOrigins.includes(pageOrigin);
}

// ---------------------------------------------------------------- words

export const SOURCE_WORDS: Record<BindingSource, { name: string; what: string; flag: BindingSourceFlag; folderLabel: string; defaultFolder: string }> = {
  claude_code_statusline: {
    name: "Claude",
    what: "Claude status line",
    flag: "claude-statusline",
    folderLabel: "Claude folder",
    defaultFolder: "~/.claude",
  },
  codex_rollout: {
    name: "Codex",
    what: "Codex sessions",
    flag: "codex-rollout",
    folderLabel: "Codex folder",
    defaultFolder: "~/.codex",
  },
};

export function sourceOfFlag(flag: BindingSourceFlag): BindingSource {
  return flag === "claude-statusline" ? "claude_code_statusline" : "codex_rollout";
}

export function bindingDir(binding: KnownBinding): string {
  return binding.source === "claude_code_statusline" ? binding.configDir : binding.home;
}

/** How long ago: "4 min ago", "3h ago", "2 days ago" (`plainAge`, shared with the Budget page). */
export function agoText(seconds: number): string {
  return `${plainAge(seconds)} ago`;
}

// ---------------------------------------------------------------- at a glance

export type GlanceState = "on" | "off" | "attention";

export interface Glance {
  state: GlanceState;
  word: string;
  headline: string;
}

/** The shared pill's status for each state: its colour tokens are the contrast-checked `--plain-*`. */
export const GLANCE_PILL: Record<GlanceState, PlainStatus> = { on: "on_track", off: "unknown", attention: "tight" };

/** Problems that are only a restatement of "capture is off" are not "attention" items. */
const OFF_PROBLEMS = new Set(["capture_off"]);

export function glanceOf(status: CollectionStatus): Glance {
  const real = status.problems.filter((problem) => !OFF_PROBLEMS.has(problem.code));
  if (!status.budgetCapture) {
    return { state: "off", word: "Off", headline: "Usage tracking is off. Nothing is being recorded." };
  }
  if (real.length === 0) return { state: "on", word: "On", headline: "Usage tracking is on and working." };
  return {
    state: "attention",
    word: "Needs attention",
    headline: `Usage tracking is on, but ${real.length === 1 ? "one thing needs" : `${real.length} things need`} your attention.`,
  };
}

/** Whether anything of automatic collection is in place, so "Turn off" has something to undo. */
export function collectionInstalled(status: CollectionStatus): boolean {
  return status.setup.recorded || status.watcher.installed || status.statusline.some((entry) => entry.state === "installed");
}

// ---------------------------------------------------------------- sources

export interface SourceRow {
  key: string;
  source: BindingSource;
  name: string;
  what: string;
  account: string;
  provider: string;
  folder: string;
  /** "Last reading 4 minutes ago", or "No reading yet". */
  reading: string;
  fresh: boolean;
  /** How this source is fed, in plain words: the wrapper for Claude, the watcher for Codex. */
  feed: string;
  feedOk: boolean;
}

/** A reading older than this reads as not fresh (the watcher's default interval is 5 minutes). */
export const FRESH_SECONDS = 60 * 60;

export function statuslineWords(entry: StatuslineStatus | undefined): { text: string; ok: boolean } {
  switch (entry?.state) {
    case "installed":
      return { text: "Recording from the Claude status line.", ok: true };
    case "hand_wrapped":
      return { text: "Recording from the Claude status line (set up by hand).", ok: true };
    case "not_installed":
      return { text: "Not recording: the small status-line step isn't installed.", ok: false };
    case "missing_file":
      return { text: "Not recording: Claude's settings file wasn't found in this folder.", ok: false };
    case "invalid_json":
      return { text: "Not recording: Claude's settings file can't be read (it isn't valid JSON).", ok: false };
    case "unsupported":
      return { text: "Not recording: this Claude status line can't be wrapped automatically.", ok: false };
    default:
      return { text: "Not recording: the small status-line step isn't installed.", ok: false };
  }
}

export function watcherWords(watcher: WatcherStatus): { text: string; ok: boolean } {
  const last = watcher.lastRunAgeSeconds === null ? "" : ` Last check ${agoText(watcher.lastRunAgeSeconds)}.`;
  if (!watcher.supported) {
    return { text: `Automatic checks aren't available on this system; Codex sessions are read when you press Collect now.${last}`, ok: false };
  }
  if (!watcher.installed) return { text: `Not checked automatically; Codex sessions are read when you press Collect now.${last}`, ok: false };
  if (watcher.loaded === false) return { text: `The background check is installed but not running.${last}`, ok: false };
  const every = watcher.intervalMinutes === null ? "regularly" : `every ${watcher.intervalMinutes === 1 ? "minute" : `${watcher.intervalMinutes} minutes`}`;
  return { text: `Checked in the background ${every}.${last}`, ok: true };
}

export function sourceRows(status: CollectionStatus): SourceRow[] {
  return status.sources.map((source: SourceStatus, index): SourceRow => {
    const words = SOURCE_WORDS[source.source];
    const feed = !status.budgetCapture
      ? { text: "Not recording: usage tracking is off.", ok: false }
      : source.source === "claude_code_statusline"
        ? statuslineWords(status.statusline.find((entry) => entry.configDir === source.dir))
        : watcherWords(status.watcher);
    const reading = source.lastReading;
    /**
     * A reading next to "Not recording" would read as a contradiction, so the reading says it
     * is older than the stop: the newest reading there is, from before recording stopped
     * (or, for Codex without a background check, from the last check that ran).
     */
    const since = !status.budgetCapture
      ? ", before tracking was turned off"
      : feed.ok
        ? ""
        : source.source === "claude_code_statusline"
          ? ", before recording stopped"
          : ", from the last check that ran";
    return {
      key: `${source.source}:${source.dir}:${index}`,
      source: source.source,
      name: words.name,
      what: words.what,
      account: source.accountRef,
      provider: source.provider,
      folder: source.dir,
      reading: reading === null ? "No reading yet" : `Last reading ${agoText(reading.ageSeconds)}${since}`,
      fresh: reading !== null && reading.ageSeconds <= FRESH_SECONDS,
      feed: feed.text,
      feedOk: feed.ok,
    };
  });
}

// ---------------------------------------------------------------- problems

/** Each problem code in everyday words. The server's own sentence stays behind "Show details". */
const PROBLEM_WORDS: Record<string, string> = {
  capture_off: "Usage tracking is off, so nothing is recorded.",
  no_binding: "No account is linked yet, so readings have nowhere to go. Add an account link below.",
  invalid_binding: "One account link in the settings file is broken and is being ignored. Edit or remove it, or add it again.",
  statusline_removed: "The small step staple added to your Claude status line is gone (the settings file was changed). Turn automatic collection on again to put it back.",
  statusline_invalid_json: "Your Claude settings file can't be read (it isn't valid JSON).",
  watcher_not_loaded: "The background check of Codex sessions is installed but not running. Turn on automatic collection again to restart it.",
  watcher_foreign: "Another copy of staple on this computer already runs the background check, so this one can't install its own.",
  watcher_node_missing: "The background check can't start because it can't find Node. Turn on automatic collection again to repair it.",
  watcher_orphaned: "A background check is still running although its file was deleted. Turn off automatic collection to stop it.",
  watcher_not_installed: "A Codex folder is linked, but nothing checks it in the background. Turn on automatic collection, or press Collect now.",
  watcher_stale: "The background check of Codex sessions hasn't run for a while.",
  collect_error: "The last check of Codex sessions ran into an error.",
  setup_record_unreadable: "staple's note of what automatic collection changed can't be read, so it won't guess what to undo.",
};

export interface ProblemRow {
  code: string;
  text: string;
  /** The server's sentence, verbatim. */
  detail: string;
}

/**
 * Problems that are about ONE account or folder are one line each, naming it: `no_reading`
 * (per bound source without a reading) and `statusline_not_installed` (per bound Claude
 * folder whose status line records nothing). The server raises them in a fixed order over
 * values the page also has (`status.sources`, `status.statusline`), so the subjects are
 * derived from those values, never read out of the message, and paired with the problems in
 * order; each line keeps its own server sentence for "Show details". When the counts do not
 * match (a server that raises them differently) the server's own sentences are shown.
 */
const claudeEntry = (status: CollectionStatus, dir: string): StatuslineStatus | undefined => status.statusline.find((entry) => entry.configDir === dir);

function noReadingText(status: CollectionStatus, source: SourceStatus): string {
  const what = SOURCE_WORDS[source.source].what;
  if (source.source === "codex_rollout") return `No reading yet from ${source.accountRef} (${what}). Codex records one on the next check.`;
  if (claudeEntry(status, source.dir)?.state === "missing_file") {
    return `No reading yet from ${source.accountRef} (${what}): the folder ${source.dir} has no Claude settings, so there is no status line to record from.`;
  }
  return `No reading yet from ${source.accountRef} (${what}). Claude records one the next time its status line updates.`;
}

interface Subject {
  dir: string;
  account: string;
  state: StatuslineStatus["state"];
}

/** The bound Claude folders the server reports `statusline_not_installed` for, in its order. */
function unwrappedFolders(status: CollectionStatus): Subject[] {
  return status.statusline.flatMap((entry): Subject[] => {
    const bound = status.sources.find((source) => source.source === "claude_code_statusline" && source.dir === entry.configDir);
    if (bound === undefined) return [];
    if (entry.recorded && entry.state !== "installed") return []; // statusline_removed
    if (entry.state === "invalid_json" || entry.state === "installed" || entry.state === "hand_wrapped") return [];
    return [{ dir: entry.configDir, account: bound.accountRef, state: entry.state }];
  });
}

function unwrappedText(subject: Subject): string {
  if (subject.state === "missing_file") {
    return `The Claude folder ${subject.dir} (account ${subject.account}) has no Claude settings file, so it has no status line to record from. Check the folder is right, or start Claude there once.`;
  }
  return `The Claude folder ${subject.dir} (account ${subject.account}) is linked, but its status line doesn't record usage yet. Turn on automatic collection to add the step.`;
}

export function problemRows(status: CollectionStatus): ProblemRow[] {
  const perSubject: Record<string, { texts: string[]; problems: CollectionProblem[] }> = {
    no_reading: {
      texts: (status.budgetCapture ? status.sources.filter((source) => source.lastReading === null) : []).map((source) => noReadingText(status, source)),
      problems: status.problems.filter((problem) => problem.code === "no_reading"),
    },
    statusline_not_installed: {
      texts: unwrappedFolders(status).map(unwrappedText),
      problems: status.problems.filter((problem) => problem.code === "statusline_not_installed"),
    },
  };
  const rows: ProblemRow[] = [];
  const done = new Set<string>();
  for (const problem of status.problems as CollectionProblem[]) {
    const group = perSubject[problem.code];
    if (group === undefined) {
      rows.push({ code: problem.code, text: PROBLEM_WORDS[problem.code] ?? problem.message, detail: problem.message });
    } else if (group.texts.length !== group.problems.length) {
      rows.push({ code: problem.code, text: problem.message, detail: problem.message });
    } else if (!done.has(problem.code)) {
      done.add(problem.code);
      group.texts.forEach((text, index) => rows.push({ code: problem.code, text, detail: group.problems[index]!.message }));
    }
  }
  return rows;
}

// ---------------------------------------------------------------- the plan, in plain words

export interface PlainStep {
  part: PlanStep["part"];
  action: PlanStep["action"];
  text: string;
  /** The server's sentence for the step, verbatim. */
  detail: string;
}

function setupStepText(step: PlanStep, options: CollectionSetupOptions): string {
  const folder = step.target ?? "";
  switch (step.part) {
    case "capture":
      return step.action === "change" ? "Turn on usage tracking." : "Usage tracking is already on.";
    case "claude_binding":
    case "codex_binding": {
      const name = step.part === "claude_binding" ? "Claude" : "Codex";
      const account = step.part === "claude_binding" ? options.claudeAccount : options.codexAccount;
      if (step.action === "skip") return `No ${name} account was named, so ${name} usage won't be collected.`;
      if (step.action === "unchanged") return `Your ${name} folder (${folder}) is already linked${account ? ` to "${account}"` : ""}.`;
      return `Link your ${name} folder (${folder}) to the account "${account ?? "the one named"}".`;
    }
    case "statusline":
      if (step.action === "change") return "Add a small step to your Claude status line so it records your usage (a backup of your Claude settings is kept).";
      if (step.action === "unchanged") return "Your Claude status line already records usage.";
      if (step.action === "refuse") return "Your Claude status line can't be changed safely, so nothing will be done (see details).";
      return "Your Claude status line will be left alone.";
    case "watcher":
      if (step.action === "change") return `Check your Codex sessions every ${options.intervalMinutes ?? 5} minutes in the background.`;
      if (step.action === "unchanged") return "Your Codex sessions are already checked in the background.";
      if (step.action === "refuse") return "The background check can't be installed (see details), so nothing will be done.";
      return "Codex sessions won't be checked in the background (see details); Collect now still works.";
    case "record":
      return "Keep a note of what was changed, so it can be undone.";
  }
}

function unsetupStepText(step: PlanStep): string {
  const folder = step.target ?? "";
  switch (step.part) {
    case "statusline":
      if (step.action === "change") return "Put your Claude status line back exactly as it was.";
      if (step.action === "refuse") return "Your Claude status line can't be put back automatically (see details), so nothing will be done.";
      return "There is no staple step in your Claude status line to remove.";
    case "watcher":
      return step.action === "change" ? "Stop and remove the background check of Codex sessions." : "There is no background check to remove.";
    case "claude_binding":
    case "codex_binding": {
      const name = step.part === "claude_binding" ? "Claude" : "Codex";
      if (step.action === "skip") return `Your ${name} folder (${folder}) was linked again by hand since, so that link is kept.`;
      return `Put the account link of your ${name} folder (${folder}) back as it was before.`;
    }
    case "capture":
      return step.action === "change" ? "Turn usage tracking off, as it was before. Readings already saved are kept." : "Usage tracking stays as it is.";
    case "record":
      return step.action === "change" ? "Delete staple's note of what was changed." : "There is no note of an earlier setup, so account links and tracking are left as they are.";
  }
}

export function plainPlan(plan: CollectionPlan, options: CollectionSetupOptions = {}): PlainStep[] {
  return plan.steps.map((step) => ({
    part: step.part,
    action: step.action,
    text: plan.action === "setup" ? setupStepText(step, options) : unsetupStepText(step),
    detail: step.summary,
  }));
}

/** The one sentence above the steps. */
export function planHeadline(plan: CollectionPlan): string {
  if (plan.refusals > 0) return "This can't be done right now. Nothing has been changed.";
  if (plan.changes === 0) return plan.action === "setup" ? "Everything is already set up. There is nothing to change." : "There is nothing to turn off.";
  return plan.action === "setup" ? "This will:" : "Turning automatic collection off will:";
}

// ---------------------------------------------------------------- results

export function collectResultText(result: CollectResult): string {
  if (result.skippedReason === "capture_disabled") return "Nothing was checked: usage tracking is off.";
  if (result.skippedReason === "no_codex_binding") return "Nothing was checked: no Codex folder is linked to an account. (Claude records through its status line, not here.)";
  if (result.skippedReason === "locked") return "A check is already running. Try again in a moment.";
  const readings = result.storedCount === 1 ? "1 new reading" : `${result.storedCount} new readings`;
  const files = result.changed === 1 ? "1 session file had" : `${result.changed} session files had`;
  const base = result.changed === 0 ? "Checked your Codex sessions: nothing new since the last check." : `Checked your Codex sessions: ${files} something new; saved ${readings}.`;
  const more = result.deferred > 0 ? ` ${result.deferred} more will be read on the next check.` : "";
  const errors = result.errors.length > 0 ? ` ${result.errors.length === 1 ? "1 file" : `${result.errors.length} files`} couldn't be read (see details).` : "";
  return base + more + errors;
}

/** The applied steps of a setup or unsetup, in plain words. */
export function appliedText(action: "setup" | "unsetup", applied: readonly PlanStep[], options: CollectionSetupOptions = {}): string[] {
  const plan: CollectionPlan = { action, steps: [...applied], changes: applied.length, refusals: 0, platform: "" };
  return plainPlan(plan, options).map((step) => step.text);
}

// ---------------------------------------------------------------- setup form defaults

/** The account each default folder is already linked to, so the setup form starts from what is there. */
export function setupDefaults(status: CollectionStatus): { claudeAccount: string; codexAccount: string } {
  const first = (source: BindingSource): string => status.bindings.find((binding) => binding.source === source)?.accountRef ?? "";
  return { claudeAccount: first("claude_code_statusline"), codexAccount: first("codex_rollout") };
}

/** The options a setup form sends: empty labels are left out, so the server uses what is bound. */
export function setupOptionsOf(draft: { claudeAccount: string; codexAccount: string; statusline: boolean; watcher: boolean }): CollectionSetupOptions {
  const options: CollectionSetupOptions = { statusline: draft.statusline, watcher: draft.watcher };
  if (draft.claudeAccount.trim() !== "") options.claudeAccount = draft.claudeAccount.trim();
  if (draft.codexAccount.trim() !== "") options.codexAccount = draft.codexAccount.trim();
  return options;
}

// ---------------------------------------------------------------- the binding form

export interface BindingDraft {
  source: BindingSourceFlag;
  folder: string;
  account: string;
  provider: string;
}

export const EMPTY_BINDING_DRAFT: BindingDraft = { source: "claude-statusline", folder: "", account: "", provider: "" };

export function draftOf(binding: KnownBinding): BindingDraft {
  return { source: SOURCE_WORDS[binding.source].flag, folder: bindingDir(binding), account: binding.accountRef, provider: binding.provider };
}

/** The home of a binding as the routes take it: `source`, and the folder under that source's own key. */
export function bindingHomeInput(source: BindingSourceFlag, folder: string): { source: BindingSourceFlag; configDir?: string; codexHome?: string } {
  const dir = folder.trim();
  if (dir === "") return { source };
  return source === "claude-statusline" ? { source, configDir: dir } : { source, codexHome: dir };
}

/**
 * What the bind route is sent for a draft. Nothing is validated here: the server runs the
 * CLI's own checks and its sentence is shown on the form, so the page can never accept a
 * label the CLI refuses or refuse one it accepts.
 */
export function bindInputOf(draft: BindingDraft, editing: KnownBinding | null) {
  const provider = draft.provider.trim();
  return {
    ...bindingHomeInput(draft.source, draft.folder),
    account: draft.account.trim(),
    ...(provider === "" ? {} : { provider }),
    ...(editing === null ? {} : { replacing: bindingHomeInput(SOURCE_WORDS[editing.source].flag, bindingDir(editing)) }),
  };
}

// ---------------------------------------------------------------- refusals in plain words

/**
 * A binding or capture refusal in everyday words, by the `detail.reason` the store sends
 * (`BindingRefusalReason` in core/telemetry/budget-config.ts). The server's sentence names
 * CLI flags, so it goes behind "Show details"; an unknown reason is shown as the server said it.
 */
const REFUSAL_WORDS: Record<string, string> = {
  invalid_account: "The account label can only use lowercase letters, digits and dashes (for example claude-max), up to 64 characters. It's a name you choose, never an email.",
  invalid_provider: "The provider must be a short lowercase name, such as anthropic or openai.",
  invalid_source: "Choose what it reads: the Claude status line or Codex sessions.",
  invalid_path: "The folder must be a full path (starting with /) or start with ~ for your home folder.",
  account_required: "Enter an account label.",
  binding_not_found: "That account link isn't there any more; it may have been changed elsewhere. The list below is up to date.",
  home_taken: "That folder already has its own account link. Edit or remove that link instead; nothing was changed.",
  invalid_body: "The page sent something the server couldn't read. Reload the page and try again.",
};

export interface PlainRefusal {
  text: string;
  /** The server's sentence, verbatim, for "Show details". Null when `text` already is it. */
  detail: string | null;
}

export function plainRefusal(refusal: { message: string; reason: string | null; serverMessage?: string }): PlainRefusal {
  if (refusal.serverMessage !== undefined) return { text: refusal.message, detail: refusal.serverMessage };
  const words = refusal.reason === null ? undefined : REFUSAL_WORDS[refusal.reason];
  return words === undefined ? { text: refusal.message, detail: null } : { text: words, detail: refusal.message };
}

/**
 * The source of a draft changes: the provider goes back to empty (the new source's
 * default), so a link switched from Claude to Codex does not keep "anthropic"; switching
 * back to the edited link's own source restores the provider it has stored.
 */
export function withSource(draft: BindingDraft, source: BindingSourceFlag, editing: KnownBinding | null = null): BindingDraft {
  if (source === draft.source) return draft;
  // Back to the source of the link being edited: its own stored provider, custom or not.
  const provider = editing !== null && SOURCE_WORDS[editing.source].flag === source ? editing.provider : "";
  return { ...draft, source, provider };
}
