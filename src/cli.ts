/**
 * staple CLI — the human/CI surface. Mirrors the MCP tools.
 * Ships as the `staple` bin of the `staple-cli` npm package (`npx staple-cli`);
 * contributors run it from source with `npm run staple -- <command> [...args]`.
 */
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveWorkspace } from "./core/workspace.js";
import { runInitCommand } from "./commands/init.js";
import { runOpenCommand } from "./commands/open.js";
import { runBareCommand } from "./commands/bare.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runAddCommand } from "./commands/add.js";
import { runDiscoverCommand } from "./commands/discover.js";
import { runMilestoneCommand } from "./commands/milestone.js";
import { findMigrationRoot, planMigration, runMigration } from "./core/path-migration.js";
import {
  type ConfigPatch,
  SETTING_KEYS,
  assertUsableHome,
  effectiveConfig,
  homeHasData,
  moveHome,
  resolveHome,
  setHomeOverride,
  stapleHome,
  updateConfig,
} from "./config/index.js";
import {
  coerceSettingInput,
  requireSettingDefinition,
  settingDefinitionsFor,
  type SettingValueView,
} from "./core/settings-registry.js";
import { Hub, notifyHubResolvedSafe } from "./core/hub.js";
import { runInstallCommand } from "./install/index.js";
import { dataVersion } from "./core/db.js";
import {
  DEFAULT_ISSUE_KIND,
  ISSUE_STATUSES,
  STATUS_CATEGORIES,
  type StatusCategory,
  StapleError,
  errorEnvelope,
  formatAgo,
  formatDuration,
  type Issue,
  type IssueGate,
  type IssueStatus,
  type QueuedBy,
  type StapleEvent,
} from "./core/types.js";
import type { WorkspaceStore } from "./core/store.js";

const STATUS_GLYPHS: Record<string, string> = {
  backlog: "◌",
  todo: "○",
  in_progress: "◐",
  in_review: "◑",
  // A ring with a pause bar: parked, not progressing. Deliberately not another
  // partial fill — the fill sequence means "how far along", and a gate is not a
  // stop on that path any more than `blocked` is.
  awaiting_approval: "⊙",
  done: "●",
  blocked: "⊘",
  cancelled: "✕",
};

/**
 * A glyph for a status this file has never heard of (STA-140), chosen by the
 * status's CATEGORY — so `awaiting_approval` renders as the gate it is instead
 * of as `?`. The built-in map above still wins for the seeded seven, which keeps
 * every existing line byte-identical.
 */
const CATEGORY_GLYPHS: Record<StatusCategory, string> = {
  unstarted: "◌",
  ready: "○",
  active: "◐",
  review: "◑",
  gated: "⏸",
  blocked: "⊘",
  done: "●",
  cancelled: "✕",
};

/**
 * Status id -> category for the workspace this process opened.
 *
 * Module-level and populated by `getStore` because `line()` is shared by nine
 * commands and threading a store through all of them to render one character
 * would be a worse trade than one process-scoped map. A CLI process opens
 * exactly one workspace, so there is nothing here to get stale.
 */
const statusCategories = new Map<string, StatusCategory>();

const PRIORITY_MARKS: Record<string, string> = {
  critical: "!!",
  high: "!",
  medium: " ",
  low: "·",
};

function statusGlyph(status: string): string {
  const category = statusCategories.get(status);
  return STATUS_GLYPHS[status] ?? (category ? CATEGORY_GLYPHS[category] : undefined) ?? "?";
}

function glyph(issue: Pick<Issue, "status" | "priority">): string {
  return `${statusGlyph(issue.status)}${PRIORITY_MARKS[issue.priority] ?? " "}`;
}

/**
 * The kind, as a suffix, and ONLY when it is not the default (STA-124).
 *
 * Two decisions in one line. It is a SUFFIX rather than a column because
 * `line()` is shared by nine commands and its three columns are load-bearing —
 * `characterize-cli-human-output` pins them by byte offset — so a new column
 * would reshuffle every row in the tracker to say `task` on most of them.
 *
 * And it is SUPPRESSED for the default because `task` is the unremarkable case.
 * A row that says `· epic` or `· bug` is carrying information; a column that
 * reads `task` nine times out of ten is carrying noise, and it would push the
 * title — the thing you are actually scanning for — further right on every
 * line. The criterion this serves is "an epic is distinguishable in the
 * terminal", and distinguishability is a property of the exception, not of the
 * rule. `staple show` prints the kind unconditionally; that is the surface for
 * completeness.
 */
function kindSuffix(kind: string): string {
  return kind === DEFAULT_ISSUE_KIND ? "" : ` · ${kind}`;
}

function line(issue: Issue, extra = ""): string {
  const assignee = issue.assignee ? ` @${issue.assignee}` : "";
  // The status column stays 11 wide. `awaiting_approval` is 17 and overflows it,
  // nudging that one row's title right — accepted deliberately over widening the
  // column, which would re-flow every line of every list for the sake of the
  // rarest status in the system. A configured status can be longer still, and
  // the same answer applies: one row moves, not every row.
  return `${glyph(issue)} ${issue.identifier.padEnd(9)} ${issue.status.padEnd(11)} ${issue.title}${assignee}${kindSuffix(issue.kind)}${extra}`;
}

/**
 * The one gate cue every list row uses, so `ls`, `inbox`, `tree` and the child
 * list under `show` can never describe the same ticket two different ways.
 *
 * Two mutually exclusive facts, and the row says at most one of them: this row
 * HOLDS a queue ("awaiting VP"), or it stands in one ("queued: STA-108/VP").
 * Empty for everything else, so an unrelated row renders exactly as it always
 * did.
 */
function gateCue(gate: IssueGate | null, queuedBy: QueuedBy | null): string {
  if (queuedBy) return `  [queued: ${queuedBy.identifier}/${queuedBy.owner}]`;
  if (gate?.state === "pending") return `  [awaiting ${gate.owner}]`;
  return "";
}

function getStore(values: { db?: string; ws?: string }) {
  const opened = resolveWorkspace({ db: values.db, ws: values.ws });
  // One place, so every command that renders a row can draw a configured status
  // (STA-140) without being handed the store just to look up a glyph.
  statusCategories.clear();
  for (const status of opened.store.getStatuses()) statusCategories.set(status.id, status.category);
  return opened;
}

/** Distinct exit codes so CI can branch on the failure class without parsing stderr. */
const EXIT_CODES: Record<string, number> = {
  validation: 2,
  not_found: 3,
  conflict: 4,
  duplicate: 5,
  cycle: 6,
  revision_conflict: 7,
  // `wait` only: a budget outcome, not a store error, so it is not a StapleError code.
  timeout: 8,
  /**
   * Refused by a review gate (STA-143). Its own number so CI and shell loops can
   * branch on "a human has to act" without parsing stderr — the one failure
   * class where retrying, picking another task, or waiting longer are all
   * equally useless.
   */
  gated: 9,
};

const SLEEP_LOCK = new Int32Array(new SharedArrayBuffer(4));

/**
 * Blocking sleep. The CLI is synchronous end to end (one main(), one sync
 * try/catch owning the exit code); Atomics.wait keeps the polling commands that
 * way — no busy spin, no async colouring of the error path, no dependency.
 */
function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(SLEEP_LOCK, 0, 0, ms);
}

/** SQLITE_BUSY and friends: contention, not corruption — safe to try again. */
function isTransientLock(error: unknown): boolean {
  return (
    (error as { code?: string } | null)?.code === "ERR_SQLITE_ERROR" &&
    /locked|busy/i.test((error as Error).message)
  );
}

/** Run a poll tick; a lock contention costs the tick, never the process. */
function tolerateLock<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (isTransientLock(error)) return undefined;
    throw error;
  }
}

/**
 * Bounded retry for the reads a poller must land before it can start blocking.
 * Long-lived pollers open the workspace while other agents are mid-commit, and
 * openDb runs `PRAGMA journal_mode=WAL` before busy_timeout is armed
 * (core/db.ts), so a concurrent writer can fail the open outright. One-shot
 * commands let that surface; `wait` and `events --follow` promise to block, so
 * they retry briefly instead of dying at t=0.
 */
function readWithRetry<T>(read: () => T, intervalMs: number): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read();
    } catch (error) {
      if (attempt >= 20 || !isTransientLock(error)) throw error;
      sleep(Math.min(intervalMs, 100));
    }
  }
}

/** Numeric flag parse that fails loudly instead of looping on a silent NaN. */
function positiveOption(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new StapleError("validation", `--${flag} must be a positive number, got "${raw}"`);
  }
  return value;
}

/**
 * Idleness durations for --steal-if-stale / --if-stale. Accepts `90s`, `30m`,
 * `2h`, `3d`, or a bare number of seconds. Returns seconds.
 *
 * A bad duration is a hard validation error, never a silent 0: `--steal-if-stale
 * xyz` collapsing to "steal anything" is precisely the automatic behaviour this
 * feature exists to avoid.
 */
function parseDuration(raw: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(raw.trim());
  if (!match) {
    throw new StapleError(
      "validation",
      `--${flag} must be a duration like 90s, 30m, 2h, 3d, or a number of seconds, got "${raw}"`,
    );
  }
  const scale = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]!]!;
  return Number(match[1]) * scale;
}

/**
 * `--estimate <dur>` / `--no-estimate`, folded into the store's three-state
 * patch value: undefined (untouched), null (cleared), or a number of seconds.
 *
 * ## Why clearing is a separate BOOLEAN flag, not `--estimate ""`
 *
 * `--estimate "$EST"` with `EST` unset expands to `--estimate ""`, and an empty
 * string that means "erase the estimate" would make an unset shell variable
 * silently destroy data. A distinct flag cannot be produced by accident: nothing
 * expands to `--no-estimate`. So an empty value is a validation error (via
 * parseDuration, which already refuses one), and erasing is something you have
 * to say out loud.
 *
 * Passing both is refused rather than resolved by precedence — whichever order
 * we picked, half the users who typed both would get the opposite of what they
 * meant, and there is no reading of "set it to 2h and also clear it" worth
 * guessing at.
 */
function estimateOption(
  raw: string | undefined,
  clear: boolean | undefined,
): number | null | undefined {
  if (clear && raw !== undefined) {
    throw new StapleError("validation", "--estimate and --no-estimate cannot be used together");
  }
  if (clear) return null;
  if (raw === undefined) return undefined;
  return parseDuration(raw, "estimate");
}

/** Read from argv, not parsed values: a parse failure must still honour --json. */
const jsonMode = process.argv.includes("--json");

function outJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

function agentName(explicit?: string): string {
  return explicit ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
}

/**
 * Stable UI credential, kept next to the hub (0600, like Jupyter's token file). A
 * browser page cannot read the filesystem, so persistence does not weaken the
 * localhost-CSRF story — it only makes bookmarks survive server restarts. Delete the
 * file to rotate.
 */
function persistentUiToken(): string {
  // src/config/home.ts is the one resolver; this used to compute its own home
  // from `process.env.HOME ?? "~"` and could mint the token into a literal `~`
  // directory while the hub it sits beside lived somewhere else entirely.
  const home = stapleHome();
  const path = join(home, "ui-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through to mint one
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function completeWithHub(
  store: WorkspaceStore,
  ref: string,
  status: IssueStatus,
  comment?: string,
  estimatedSeconds?: number | null,
) {
  const updated = store.updateIssue(
    ref,
    { status, comment, ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }) },
    agentName(),
  );
  notifyHubResolvedSafe(store.slug, updated.identifier);
  return updated;
}

/** listEvents' own row cap — drain in pages so an event burst is never truncated. */
const EVENT_PAGE = 200;

function eventsSince(store: WorkspaceStore, since: number): StapleEvent[] {
  const drained: StapleEvent[] = [];
  let cursor = since;
  for (;;) {
    const page = store.listEvents(cursor, EVENT_PAGE);
    if (page.length === 0) return drained;
    drained.push(...page);
    cursor = page[page.length - 1]!.seq;
    if (page.length < EVENT_PAGE) return drained;
  }
}

/** Head of the log: where a follower starts when no --since is given. */
function latestSeq(store: WorkspaceStore): number {
  let cursor = 0;
  for (;;) {
    const page = store.listEvents(cursor, EVENT_PAGE);
    if (page.length === 0) return cursor;
    cursor = page[page.length - 1]!.seq;
    if (page.length < EVENT_PAGE) return cursor;
  }
}

/** Single formatter, so one-shot and --follow output can never drift apart. */
function formatEvent(event: StapleEvent): string {
  return `${String(event.seq).padStart(4)}  ${event.createdAt.slice(0, 19)}  ${event.kind.padEnd(18)}  ${JSON.stringify(event.payload)}`;
}

function warnExecFailure(event: StapleEvent, reason: string, json: boolean): void {
  const message = `--exec hook failed for event ${event.seq} (${event.kind}): ${reason}`;
  if (json) {
    console.error(JSON.stringify({ code: "exec_failed", message, detail: { seq: event.seq, kind: event.kind }, retryable: false }));
  } else {
    console.error(message);
  }
}

/**
 * Hook dispatch: `sh -c '<cmd> "$@"' staple-exec <json>` keeps full shell power
 * while handing the event over as one already-quoted argv element — splicing JSON
 * into a shell line would break on its own quotes and spaces. The same JSON is in
 * STAPLE_EVENT for hooks that prefer the environment. A failing hook is reported
 * and skipped: a broken listener must never take the stream down with it.
 * Under --json the hook's stdout is redirected to stderr so NDJSON stays clean.
 */
function dispatchEvent(command: string, event: StapleEvent, json: boolean): void {
  const payload = JSON.stringify(event);
  try {
    const result = spawnSync("/bin/sh", ["-c", `${command} "$@"`, "staple-exec", payload], {
      env: { ...process.env, STAPLE_EVENT: payload },
      stdio: ["ignore", json ? 2 : "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      warnExecFailure(event, result.signal ? `killed by ${result.signal}` : `exited ${result.status}`, json);
    }
  } catch (error) {
    warnExecFailure(event, error instanceof Error ? error.message : String(error), json);
  }
}

// ------------------------------------------------------------------ config

/** Left column width for `config show`, so a script can slice the key off a line. */
const CONFIG_KEY_WIDTH = 14;

function configLine(key: string, value: string, note: string): string {
  return `${key.padEnd(CONFIG_KEY_WIDTH)}${value}  (${note})`;
}

/**
 * Coerce a command-line string into the typed value its key expects — through
 * the registry's global definitions (R6a), so a new machine preference is
 * settable the moment it is registered without a new arm here.
 */
function configValueFor(key: string, raw: string | undefined): ConfigPatch {
  if (raw === undefined) {
    throw new StapleError("validation", `config set ${key} needs a value`);
  }
  const definition = settingDefinitionsFor("global").find((d) => d.configKey === key);
  if (!definition) {
    throw new StapleError(
      "validation",
      `Unknown config key "${key}". Settable keys: ${SETTING_KEYS.join(", ")}.`,
    );
  }
  return { [key]: coerceSettingInput(definition, raw, "config set") } as ConfigPatch;
}

/**
 * `staple config` — plan §2 and the command table rows for `config` and
 * `config home`. Show effective settings and where each one came from, set UI
 * preferences, and relocate the machine home as a verified migration.
 */
function runConfigCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      // Scoped to this command on purpose: the plan gives `--home` to the
      // configuration and diagnostic commands, not to the task surface.
      home: { type: "string" },
      move: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  if (values.home !== undefined) setHomeOverride(values.home);
  const sub = positionals[0] ?? "show";

  if (sub === "show") {
    const effective = effectiveConfig();
    if (values.json) {
      outJson(effective);
      return;
    }
    console.log(configLine("home", effective.home.value, effective.home.source));
    console.log(
      configLine("config", effective.configPath, effective.configPresent ? "present" : "absent"),
    );
    console.log(
      configLine(
        "locator",
        effective.locator.path,
        effective.locator.present ? "present" : "absent",
      ),
    );
    console.log(
      configLine("browser", effective.settings.browser.value, effective.settings.browser.source),
    );
    console.log(
      configLine("port", String(effective.settings.port.value), effective.settings.port.source),
    );
    console.log(
      configLine(
        "setup",
        effective.settings.setupComplete.value ? "complete" : "incomplete",
        effective.settings.setupComplete.source,
      ),
    );
    // Kept off stdout so the settings table stays a clean six lines to parse.
    if (effective.unknownKeys.length > 0) {
      console.error(
        `note: ${effective.configPath} carries ${effective.unknownKeys.join(", ")} — written by a newer staple, preserved unread.`,
      );
    }
    return;
  }

  if (sub === "set") {
    const key = positionals[1];
    if (key === undefined) {
      throw new StapleError("validation", "usage: staple config set <key> <value>");
    }
    const patch = configValueFor(key, positionals[2]);
    const home = stapleHome();
    const updated = updateConfig(home, patch);
    const value = (updated as unknown as Record<string, unknown>)[key];
    if (values.json) {
      outJson({ key, value, path: join(home, "config.json") });
      return;
    }
    console.log(`${key} = ${String(value)}  (${join(home, "config.json")})`);
    return;
  }

  if (sub === "home") {
    const target = positionals[1];
    if (target === undefined) {
      throw new StapleError("validation", "usage: staple config home <path> --move --yes");
    }
    // Shape first, so a relative path or a filesystem root always reports the
    // real problem rather than "you forgot --move".
    const desired = assertUsableHome(target, "config home <path>");
    const current = resolveHome();

    if (!values.move && desired !== current.path && homeHasData(current.path)) {
      throw new StapleError(
        "validation",
        `${current.path} already holds data. Moving the home is a migration — re-run with --move (and --yes) to copy it, or it would be stranded.`,
      );
    }
    if (!values.yes) {
      throw new StapleError(
        "validation",
        `Refusing to change the machine home without --yes. Would move ${current.path} to ${desired}.`,
      );
    }

    const result = moveHome({ from: current.path, to: desired });

    // The locator is only consulted when STAPLE_HOME is unset, so a move made
    // inside a shell that exports it writes a pointer nothing will read.
    if (process.env.STAPLE_HOME) {
      console.error(
        `warning: STAPLE_HOME is set to ${process.env.STAPLE_HOME} and outranks the bootstrap locator. Unset STAPLE_HOME for the new home to take effect.`,
      );
    }
    // Hub path repair belongs to a later ticket; say so rather than let the user
    // find out when a workspace resolves to the retained copy.
    if (result.staleHubPaths > 0) {
      console.error(
        `warning: ${result.staleHubPaths} hub registration(s) still point inside ${result.from}. Re-run \`staple init\` in those workspaces to repoint them.`,
      );
    }

    if (values.json) {
      outJson(result);
      return;
    }
    if (result.noop) {
      console.log(`Home is already ${result.to}; recorded it in the bootstrap locator.`);
    } else {
      console.log(
        `Moved the staple home to ${result.to} (${result.copied.length} entr${result.copied.length === 1 ? "y" : "ies"} copied).`,
      );
      console.log(`Bootstrap locator updated: ${result.locator}`);
      console.log(
        `The old home is retained at ${result.retained} — delete it once the new one checks out.`,
      );
    }
    return;
  }

  throw new StapleError(
    "validation",
    `Unknown config subcommand "${sub}". Try: staple config [show|set <key> <value>|home <path> --move --yes]`,
  );
}

/**
 * `staple migrate` — move this repository's state from `.tasks/tasks.db` to
 * `.staple/staple.db`, or resume a migration a crash interrupted.
 *
 * Preview by default, mutate only with `--yes`. The plan's TTY matrix applies
 * that shape to every mutating command ("Without `--yes`, exit 2 without
 * mutation"), and it matters more here than anywhere else: this is the one
 * command that moves a database, and the plan's risk register is about exactly
 * this operation going wrong.
 *
 * The plan folds migration into `init` and bare `staple`. Both of those depend
 * on A6's consent and TTY machinery, which does not exist yet — and plan §1
 * step 4 requires printing "the exact migration command", which has to be a real
 * command for the sentence to be satisfiable. So the engine lives in
 * `core/path-migration.ts` with no CLI knowledge, this command is a thin shell
 * over it, and A6 composes the same two functions into `init`.
 */
function runMigrateCommand(options: { dir?: string; yes: boolean; json: boolean }): void {
  const start = resolve(options.dir ?? process.cwd());
  const root = findMigrationRoot(start);
  if (!root) {
    throw new StapleError(
      "not_found",
      `No staple workspace at or above ${start}. Run \`staple init\` to create one.`,
    );
  }

  const plan = planMigration(root);

  if (plan.action === "blocked") {
    throw plan.blocker ?? new StapleError("conflict", plan.reason);
  }

  if (plan.action === "already_current") {
    if (options.json) {
      console.log(JSON.stringify({ action: plan.action, root, reason: plan.reason, changed: false }));
    } else {
      console.log(plan.reason);
    }
    return;
  }

  if (!options.yes) {
    const preview = {
      action: plan.action,
      root,
      from: plan.sourcePath,
      to: plan.targetPath,
      workspace: plan.identity,
      reason: plan.reason,
      changed: false,
      confirmWith: "staple migrate --yes",
    };
    if (options.json) {
      console.error(JSON.stringify(preview));
    } else {
      console.log(plan.action === "resume" ? "Resume an interrupted migration:" : "Path migration plan:");
      console.log(`  from    ${plan.sourcePath}`);
      console.log(`  to      ${plan.targetPath}`);
      if (plan.identity) {
        console.log(`  workspace  ${plan.identity.slug} (prefix ${plan.identity.prefix})`);
      }
      console.log("");
      console.log("The legacy database is retained as a rollback copy; nothing is deleted.");
      console.log("Re-run with --yes to apply.");
    }
    process.exitCode = EXIT_CODES.validation;
    return;
  }

  const result = runMigration(root);

  if (options.json) {
    console.log(JSON.stringify({ ...result, root, changed: true }));
    return;
  }
  console.log(
    `${result.resumed ? "Resumed and completed" : "Migrated"} workspace "${result.slug}" ` +
      `(prefix ${result.prefix}) to ${result.targetPath}.`,
  );
  const tables = Object.entries(result.rowCounts).filter(([, n]) => n > 0);
  if (tables.length > 0) {
    console.log(`Verified: ${tables.map(([table, n]) => `${table} ${n}`).join(", ")}.`);
  }
  if (result.backupPath) {
    console.log(`Legacy database retained at ${result.backupPath} — delete it once you are satisfied.`);
  }
  console.log(`Journal kept at ${result.journalPath}.`);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
}

const HELP = `staple — local-first task tracker for coding agents

Workspace
  (no command) [--yes]                  set this repo up if it needs it, then open the UI;
              --yes skips the questions and takes the defaults — the same
              choices staple init --yes makes (a legacy .tasks repo is
              migrated; the legacy database is retained);
              with no terminal, --yes still does the setup but refuses to start
              the server and prints the follow-up commands, exit 0; without
              --yes it exits 2 and names the explicit commands instead of prompting
  init [--slug s] [--global <slug>] [--yes] [--no-gitignore] [--json]
              create + register a workspace and EXIT — never starts the UI;
              repo-local also writes .staple/AGENTS.md, the working protocol for
              agents on this repo — an existing one is never overwritten — and
              .staple/.gitignore, which ignores the database but NOT AGENTS.md;
              a legacy .tasks repo is opened where it is unless --yes migrates it
  migrate [--dir p] [--yes]             move a legacy .tasks/tasks.db workspace to
              .staple/staple.db, or resume one a crash interrupted; previews and
              exits 2 without --yes; the legacy database is retained, never deleted
  install [status] [--from p] [--yes] [--update-path] [--rollback]
              install/switch a user-owned staple runtime under <home>/runtime;
              previews and exits 2 without --yes; PATH edits need --update-path
  add <path> [--slug s] [--migrate] --yes
              register ONE named project (never scans); previews every change
              and exits 2 without --yes; an already-registered path just refreshes
  discover <root> [--depth 6] [--all-found|--select a,b] [--yes]
              find workspaces beneath ONE explicit root — both layouts, bounded
              depth, no symlinks, no other filesystems; previews by default and
              registers ONLY hub rows, only for what you select; never registers
              an ambiguous directory and never initializes anything
  hub [ls|links|events]                 registry, cross-links, cross-workspace events
  doctor [--json] [--dir p] [--home p]  read-only diagnosis of home, config, hub, workspace,
              schema, migration journals, UI port, runtime and assets; exits 1
              when a check fails and prints the exact repair commands
  doctor --fix --only <check> --yes     apply ONE named idempotent repair; bare --fix is
              refused with or without --yes, and --only without --yes previews;
              a failed migration additionally needs --keep legacy|new
  config [show]                         effective machine settings and where each came from
  config set <key> <value>              browser | port | setupComplete
  config home <path> --move --yes       relocate ~/.staple, verify, then repoint the
              bootstrap locator; the old home is retained until you delete it
              --home <path> targets a home other than the resolved one
  settings [ls]                         this WORKSPACE's registered settings, each with
              its value and where it came from (default | workspace)
  settings get <key>                    one setting, e.g. queue.policy
  settings set <key> <value>            write one; queue.policy takes advisory | strict

Tasks
  new <title> [-d text] [-p prio] [--parent REF] [--assignee A]
              [--blocked-by R1,R2] [--status S] [--criteria "a;b"]
              [--kind K]                epic|task|bug|chore|spike (default task),
              or whatever "staple kinds ls" shows for this workspace
              [--estimate <dur>]        record the plan-time estimate AT PLAN TIME
  ls [--status s1,s2] [--kind k1,k2] [--assignee A] [-q text] [--all]
  show <ref>                            full context (ancestry, relations, comments, docs)
  tree [ref]                            subtask tree
  board                                 terminal kanban
  inbox [--assignee A] [--hub]          ready vs queued vs blocked (pickup order);
              QUEUED is work a HUMAN has to release (see Approval gates below) and
              checkout of it is refused; BLOCKED is work waiting on other WORK;
              --hub = all workspaces

Flow
  start|checkout <ref> [--agent A] [--steal-if-stale <dur>]
              atomic checkout -> in_progress; --steal-if-stale ALSO takes over an
              issue held by another agent that has been silent at least <dur>
  done <ref> [-m comment]               complete (+ cross-workspace fan-out)
  cancel <ref> [-m comment]
  status <ref> <status> [--estimate <dur>|--no-estimate]
              any status, guards enforced; --estimate also re-records the
              estimate (same status = estimate-only write), --no-estimate clears
  release <ref> [--if-stale <dur>]      give a claim back -> todo; --if-stale frees
              a claim whose holder has been silent at least <dur> (any caller)
  block <ref> --owner O --action TEXT   mark blocked with an unblock descriptor
  blocked-by <ref> [R1,R2|--none]       replace the dependency set
  wait <ref> [--timeout S] [--interval MS]
              block until <ref> is ready (no unresolved blockers) or finished;
              --interval default 500ms, no --timeout means wait forever
  link <blocker> <blocked>              cross-workspace dependency (identifiers, via hub)
  comment <ref> <text> [--author A]

Approval gates
  gate <ref> --owner O [-m text]        park a PARENT behind a human review: it goes
              awaiting_approval, its claim is cleared, and every open descendant is
              QUEUED — listed apart in inbox and refused at checkout (exit 9 / gated).
              Resolved work is never queued, and neither is a parent with nothing
              open under it. Refused on a leaf (use in_review) and while a gate is
              already pending; re-gating after request-changes is how you resubmit
  approve <ref> [--children R1,R2] [-m text]
              with no --children: resolve the gate, release the whole subtree and
              re-derive the parent from its children. With --children: release only
              those (and everything under them) and leave the parent parked
  request-changes <ref> -m text         SEND IT BACK. Posts your note as a comment on
              <ref>, returns it to todo for the next agent, and keeps the queued
              children parked until you approve. Nobody is re-checked-out and the
              queue holds until an approve or a fresh gate cycle. The note is required

Milestones
  milestone ls [--all]                  dated, human-ordered plans (issues of the reserved
              "milestone" kind — run "staple kinds add milestone" once to enable);
              --all includes done and cancelled ones
  milestone show <ref>                  dates, derived state, progress, ordered members
  milestone new <title> [--target D] [--start D] [--from-epic <ref>] [--preview]
              --from-epic adds the epic as the ONE member (its children come along
              by descent, nothing is re-parented); --preview prints the exact plan
              and writes nothing; D is a UTC calendar day, YYYY-MM-DD
  milestone set <ref> [--target D|none] [--start D|none]
              only the dates; title, description, assignee and status are edited
              with the ordinary commands
  milestone add <milestone> <ref> [--before R|--after R|--at N] [--base N] [-m note]
  milestone rm <milestone> <ref> [--base N]
  milestone mv <ref> (--before R|--after R|--at N|--to <milestone>) [--base N]
  milestone reorder <milestone> <r1,r2,...> [--base N]
              --base N is the members revision "show" printed; a stale base is
              refused (exit 7) and the order stands. Membership never changes an
              issue's parent, blockers, status or claim

Documents & events
  doc <ref> <key>                       read (latest)
  doc <ref> <key> --put <file|->        write (--base N for optimistic concurrency)
  doc <ref> <key> --revisions           history
  events [--since N]                    workspace event log (blockers_resolved, ...)
  events --follow [--since N] [--interval MS] [--exec CMD] [--max N]
              tail new events (from the head of the log, or --since N);
              --exec runs CMD per event with the event JSON as the last argument
              and in $STAPLE_EVENT — a failing hook is logged, never fatal;
              --max N exits after N events (bounded runs, CI, tests)

UI
  open [--port 4400] [--hub] [--browser|--no-browser]
              local web UI (board, tree, graph, detail) in the FOREGROUND;
              Ctrl-C closes the server and every database handle; an implicit
              port that is busy falls back to a free one, an explicit --port
              collision fails; the browser follows config browser=auto|always|never
  ui [--port 4400] [--hub]              compatibility alias for open

Durations (<dur>): 90s, 30m, 2h, 3d, or a bare number of seconds.
Claim liveness: in_progress rows show "held <dur> · silent <dur>" in ls/show; the
              same numbers ride in --json as "claim". Nothing expires a claim on
              its own — a takeover only ever happens because you asked for one.
Estimates:    --estimate takes a <dur> and is what makes estimate-vs-actual honest,
              so record it when you PLAN, not when you finish. Actuals are derived
              from started_at/completed_at and never stored; show prints
              "time   est 2h · ran 3h10m" and --json carries "timing" (with
              children rollups over DIRECT children) beside the issue.

Global flags: --db <path>, --ws <slug|prefix>  (default: walk up for .staple/staple.db,
                      then a legacy .tasks/tasks.db)
              --json  machine-readable output (store objects, full ISO-8601 timestamps;
                      events emits NDJSON; errors are single-line JSON on stderr)
Workspace vocabulary
  statuses ls                           configured statuses, in configured order
  statuses add <id> --category C [--label L] [--after <id>]
              C is one of ${STATUS_CATEGORIES.join("|")}
              — every behaviour (checkout, derived epic status, resolved, pickup
              order) keys off the CATEGORY, never off the id
  statuses rename <id> --label "New Label"
  statuses recategorize <id> --category C
  statuses reorder a,b,c                 the new order, ALL of them; drives sort
  statuses rm <id> [--migrate-to <id>]   --migrate-to required while issues use it
  kinds ls|add|rename|reorder|rm         same verbs, no categories

Statuses (built-in seed; run "staple statuses ls" for this workspace's actual set):
          ${ISSUE_STATUSES.join(" ")}

Exit codes: 0 ok · 1 unknown · 2 validation · 3 not_found · 4 conflict
            5 duplicate · 6 cycle · 7 revision_conflict · 8 timeout (wait)
            9 gated (a review gate above this issue is unresolved — a human, not a retry)`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }
  /**
   * A bare `staple` is no longer help.
   *
   * Plan §1: bare `staple` "composes setup and open" — initialize this project
   * when needed, then run the UI. A1 pinned the old behaviour with a note saying
   * this assertion was "EXPECTED to be rewritten by A6, deliberately, rather
   * than to break by surprise"; this is that rewrite. `staple help` and
   * `staple --help` still print the same help text they always did, which is
   * where a reader who typed `staple` expecting a command list is sent.
   */
  if (!command || command === "--yes") {
    // `--yes` is the bare command's one flag (D5): `staple --yes` — and
    // therefore `npx staple-cli --yes` — is still the bare lifecycle, just with
    // the questions answered up front. Any other leading flag stays an unknown
    // command, exactly as before.
    runBareCommand(command ? [command, ...rest] : rest, { token: persistentUiToken() });
    return;
  }

  const common = {
    db: { type: "string" as const },
    ws: { type: "string" as const },
    json: { type: "boolean" as const },
  };

  switch (command) {
    case "init": {
      // Setup only — src/commands/init.ts does not import the UI server, so
      // "init never opens the UI" is structural rather than remembered.
      runInitCommand(rest);
      break;
    }

    case "new": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          description: { type: "string", short: "d" },
          priority: { type: "string", short: "p" },
          parent: { type: "string" },
          assignee: { type: "string" },
          "blocked-by": { type: "string" },
          status: { type: "string" },
          kind: { type: "string" },
          criteria: { type: "string" },
          estimate: { type: "string" },
          "no-estimate": { type: "boolean" },
          "allow-duplicate": { type: "boolean" },
        },
      });
      const title = positionals.join(" ");
      const { store } = getStore(values);
      const issue = store.createIssue({
        title,
        description: values.description,
        estimatedSeconds: estimateOption(values.estimate, values["no-estimate"]) ?? null,
        priority: values.priority as never,
        parent: values.parent,
        assignee: values.assignee,
        status: values.status as never,
        kind: values.kind,
        blockedBy: values["blocked-by"]?.split(",").map((s) => s.trim()).filter(Boolean),
        acceptanceCriteria: values.criteria?.split(";").map((s) => s.trim()).filter(Boolean),
        allowDuplicate: values["allow-duplicate"],
        createdBy: agentName(),
      });
      if (values.json) {
        outJson(issue);
        break;
      }
      console.log(line(issue));
      break;
    }

    case "ls": {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...common,
          status: { type: "string" },
          kind: { type: "string" },
          assignee: { type: "string" },
          q: { type: "string", short: "q" },
          all: { type: "boolean" },
        },
      });
      const { store } = getStore(values);
      const issues = store.listIssues({
        status: values.status?.split(",").map((s) => s.trim()) as never,
        // Comma-separated, for symmetry with --status. `--kind epic` is the
        // acceptance case; `--kind bug,chore` falls out of the same split.
        kind: values.kind?.split(",").map((s) => s.trim()).filter(Boolean),
        assignee: values.assignee,
        q: values.q,
        includeResolved: values.all,
      });
      // One batched query per fact for the whole list, never one per row.
      const ids = issues.map((i) => i.id);
      const claims = store.claimActivityFor(ids);
      const gates = store.gateFor(ids);
      const queued = store.queuedByFor(ids);
      if (values.json) {
        // Additive: every existing issue field is still at the top level, with
        // `claim` alongside (null unless the row is actually held), and `gate` /
        // `queuedBy` as further siblings on the same principle.
        outJson(
          issues.map((i) => ({
            ...i,
            claim: claims.get(i.id) ?? null,
            gate: gates.get(i.id) ?? null,
            queuedBy: queued.get(i.id) ?? null,
          })),
        );
        break;
      }
      if (issues.length === 0) console.log("(no issues)");
      for (const issue of issues) {
        const claim = claims.get(issue.id);
        console.log(
          line(
            issue,
            (claim
              ? ` · held ${formatAgo(claim.heldSeconds)} · silent ${formatAgo(claim.idleSeconds)}`
              : "") + gateCue(gates.get(issue.id) ?? null, queued.get(issue.id) ?? null),
          ),
        );
      }
      break;
    }

    case "show": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      const { store } = getStore(values);
      const ctx = store.context(positionals[0]!);
      if (values.json) {
        // Mirrors MCP get_task: claim, the gate pair and the timing pair ride
        // alongside the context, from the same store expressions get_task
        // spreads.
        outJson({
          ...ctx,
          claim: store.claimActivity(ctx.issue.id),
          gate: store.gate(ctx.issue.id),
          queuedBy: store.queuedBy(ctx.issue.id),
          ...store.detailTiming(ctx.issue.id),
        });
        break;
      }
      const i = ctx.issue;
      const claim = store.claimActivity(i.id);
      const timing = store.timing(i.id);
      console.log(`${i.identifier} · ${i.title}`);
      // `kind` is unconditional here — unlike `line()`, which suppresses the
      // default. This is the detail surface: "it is a task" is a fact somebody
      // asked for by name, and leaving it out would make its absence ambiguous
      // between "task" and "this build does not know about kinds".
      console.log(`status ${i.status} (v${i.statusVersion}) · kind ${i.kind} · priority ${i.priority}${i.assignee ? ` · @${i.assignee}` : ""}${i.checkoutAgent ? ` · held by ${i.checkoutAgent}` : ""}`);
      if (claim) {
        console.log(
          `claim  held ${formatAgo(claim.heldSeconds)} · silent ${formatAgo(claim.idleSeconds)} (last activity ${claim.lastActivityAt.slice(0, 19)}Z)`,
        );
      }
      /**
       * Its own line, beside `claim`, and emitted only when there is something
       * to say — so an issue with neither an estimate nor a start renders
       * exactly as it always did.
       *
       * Deliberately NOT folded into `ls`'s row: `line()` is shared by nine
       * commands and its columns are already full, and this is the surface
       * built for detail. `--json` carries the full rollup for anything that
       * wants to do arithmetic.
       */
      const timingParts: string[] = [];
      if (timing.estimatedSeconds != null) timingParts.push(`est ${formatDuration(timing.estimatedSeconds)}`);
      /**
       * `ran` prints the HEADLINE `activeSeconds`, which for a parent is its
       * children's aggregate — so it is labelled `aggregated` there rather than
       * left to read as an epic's own stopwatch, which is exactly the lie STA-90
       * removed. `children ran` still follows for the audit trail.
       */
      if (timing.activeSeconds != null) {
        timingParts.push(
          `ran ${formatDuration(timing.activeSeconds)}${timing.childCount > 0 ? " (aggregated)" : ""}`,
        );
      }
      // Only when nonzero, and never folded into `ran`: review is a queue, not
      // execution. See IssueTiming.reviewSeconds.
      if (timing.reviewSeconds) timingParts.push(`review ${formatDuration(timing.reviewSeconds)}`);
      if (timing.childrenEstimatedSeconds != null) {
        timingParts.push(`children est ${formatDuration(timing.childrenEstimatedSeconds)}`);
      }
      /**
       * The recursive plan (STA-192), one segment per parent. A parent with no
       * estimate of its own says where its plan came from and how much of the
       * subtree fed it; one that HAS an estimate keeps `est` as the plan and
       * shows the bottom-up number beside it, so a disagreement is visible
       * rather than one side quietly winning. A leaf adds nothing.
       */
      const plan = timing.subtreePlan;
      if (plan.source === "descendants" && plan.estimatedSeconds != null) {
        timingParts.push(
          `plan ${formatDuration(plan.estimatedSeconds)} (from ${plan.contributingCount} of ${plan.totalCount} descendants)`,
        );
      } else if (plan.source === "own" && plan.descendantsEstimatedSeconds != null) {
        timingParts.push(
          `descendants est ${formatDuration(plan.descendantsEstimatedSeconds)} (${plan.contributingCount} of ${plan.totalCount})`,
        );
      }
      if (timing.childrenActiveSeconds != null) {
        timingParts.push(`children ran ${formatDuration(timing.childrenActiveSeconds)}`);
      }
      // The clock stopped here, and it is not `now`. Said out loud so nobody
      // reads a frozen number as a live one.
      if (timing.countedThrough) {
        timingParts.push(`counted through ${timing.countedThrough.slice(0, 19)}Z`);
      }
      if (timing.approximate && timingParts.length > 0) timingParts.push("approx");
      if (timingParts.length > 0) console.log(`time   ${timingParts.join(" · ")}`);
      if (ctx.ancestors.length > 0) {
        console.log(`path   ${[...ctx.ancestors.map((a) => a.identifier), i.identifier].join(" > ")}`);
      }
      if (i.description) console.log(`\n${i.description}`);
      if (i.acceptanceCriteria?.length) {
        console.log("\nacceptance criteria:");
        for (const c of i.acceptanceCriteria) console.log(`  - ${c}`);
      }
      if (i.status === "blocked" && (i.unblockOwner || i.unblockAction)) {
        console.log(`\nunblock: ${i.unblockOwner ?? "?"} must ${i.unblockAction ?? "?"}`);
      }
      /**
       * The gate gets its own line rather than a suffix on the status line: it
       * is the single most consequential fact on a parked ticket — nothing
       * underneath it can be picked up — and burying it after the priority is
       * how it gets skimmed past.
       *
       * Printed for a RESOLVED gate too, because "VP approved this an hour ago"
       * is exactly what somebody re-reading the ticket needs, and a gate that
       * vanishes the moment it is answered leaves no trace of the review at all.
       */
      const gate = store.gate(i.id);
      if (gate) {
        const resolved = gate.resolvedAt
          ? ` · ${gate.state} by ${gate.resolvedBy ?? "?"} ${gate.resolvedAt.slice(0, 19)}Z`
          : "";
        console.log(
          `\ngate:  ${gate.state === "pending" ? `awaiting ${gate.owner}` : `${gate.owner}`}${resolved} (requested ${gate.requestedBy ?? "?"} ${gate.requestedAt.slice(0, 19)}Z)`,
        );
      }
      const queuedBy = store.queuedBy(i.id);
      if (queuedBy) {
        console.log(
          `queued: behind ${queuedBy.identifier}, awaiting approval by ${queuedBy.owner} — checkout is refused until then`,
        );
      }
      if (ctx.blockedBy.length) {
        console.log(`\nblocked by: ${ctx.blockedBy.map((b) => `${b.identifier}(${b.status})`).join(", ")}`);
      }
      if (ctx.blocks.length) {
        console.log(`blocks:     ${ctx.blocks.map((b) => `${b.identifier}(${b.status})`).join(", ")}`);
      }
      if (ctx.children.length) {
        console.log("\nchildren:");
        // The same batched pair `ls` uses, so a child reads identically here and
        // in a list — the cue is the row's, not the surface's.
        const childIds = ctx.children.map((c) => c.id);
        const childGates = store.gateFor(childIds);
        const childQueued = store.queuedByFor(childIds);
        for (const child of ctx.children) {
          console.log(
            `  ${line(child, gateCue(childGates.get(child.id) ?? null, childQueued.get(child.id) ?? null))}`,
          );
        }
      }
      if (ctx.documents.length) {
        console.log(`\ndocuments: ${ctx.documents.map((d) => `${d.key}@r${d.currentRevision}`).join(", ")}`);
      }
      if (ctx.comments.length) {
        console.log("\ncomments:");
        for (const c of ctx.comments) {
          console.log(`  [${c.createdAt.slice(0, 16)}] ${c.author} (${c.authorType}): ${c.body}`);
        }
      }
      break;
    }

    case "checkout":
    case "start": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          agent: { type: "string" },
          "steal-if-stale": { type: "string" },
        },
      });
      const { store } = getStore(values);
      const stale = values["steal-if-stale"];
      const before = stale === undefined ? null : store.claimActivity(positionals[0]!);
      const issue = store.checkoutIssue(positionals[0]!, agentName(values.agent), undefined, {
        stealIfIdleSeconds:
          stale === undefined ? undefined : parseDuration(stale, "steal-if-stale"),
      });
      if (values.json) {
        outJson(issue);
        break;
      }
      // Name whose work was taken: a silent "claimed" would hide the takeover.
      const stolen = before && before.heldBy !== issue.checkoutAgent;
      console.log(
        stolen
          ? `stole ${line(issue)} (was ${before.heldBy}, silent ${formatAgo(before.idleSeconds)})`
          : `claimed ${line(issue)}`,
      );
      break;
    }

    case "done":
    case "cancel": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, message: { type: "string", short: "m" } },
      });
      const { store } = getStore(values);
      const issue = completeWithHub(
        store,
        positionals[0]!,
        command === "done" ? "done" : "cancelled",
        values.message,
      );
      if (values.json) {
        outJson(issue);
        break;
      }
      console.log(line(issue));
      break;
    }

    case "status": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          estimate: { type: "string" },
          "no-estimate": { type: "boolean" },
        },
      });
      const { store } = getStore(values);
      const target = positionals[1]! as IssueStatus;
      /**
       * `status` is the CLI's only update path, so it is also where a re-estimate
       * lands. `staple status STA-81 in_progress --estimate 2h` is the natural
       * moment for one; `staple status STA-81 backlog --estimate 2h` sets an
       * estimate without moving the ticket (a same-status write is a no-op
       * transition, not an error).
       */
      const estimatedSeconds = estimateOption(values.estimate, values["no-estimate"]);
      const issue =
        target === "done" || target === "cancelled"
          ? completeWithHub(store, positionals[0]!, target, undefined, estimatedSeconds)
          : store.updateIssue(
              positionals[0]!,
              { status: target, ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }) },
              agentName(),
            );
      if (values.json) {
        outJson(issue);
        break;
      }
      console.log(line(issue));
      break;
    }

    case "release": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, "if-stale": { type: "string" } },
      });
      const { store } = getStore(values);
      const stale = values["if-stale"];
      const released = store.releaseIssue(positionals[0]!, agentName(), {
        ifIdleSeconds: stale === undefined ? undefined : parseDuration(stale, "if-stale"),
      });
      if (values.json) {
        outJson(released);
        break;
      }
      console.log(line(released));
      break;
    }

    /**
     * The three gate verbs (STA-143).
     *
     * Separate commands rather than flags on `status`, because `status` is a
     * statement about ONE row and each of these is a statement about a subtree:
     * `gate` queues everything underneath, `approve` releases it, and
     * `request-changes` sends the parent back while holding the queue. Folding
     * them into `status` would hide the blast radius behind a status word.
     */
    case "gate": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, owner: { type: "string" }, message: { type: "string", short: "m" } },
      });
      const { store } = getStore(values);
      const issue = store.gateIssue(
        positionals[0]!,
        { owner: values.owner ?? "", comment: values.message },
        agentName(),
      );
      const gate = store.gate(issue.id);
      if (values.json) {
        outJson({ ...issue, gate });
        break;
      }
      console.log(line(issue, gateCue(gate, null)));
      break;
    }

    case "approve": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          children: { type: "string" },
          message: { type: "string", short: "m" },
        },
      });
      const { store } = getStore(values);
      const children = (values.children ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const issue = store.approveGate(
        positionals[0]!,
        { children: children.length > 0 ? children : undefined, comment: values.message },
        agentName(),
      );
      const gate = store.gate(issue.id);
      if (values.json) {
        outJson({ ...issue, gate, releasedChildren: children });
        break;
      }
      // Naming what was released is the point of the granular form: "approved"
      // alone cannot say whether one child moved or the whole subtree did.
      console.log(
        line(
          issue,
          children.length > 0
            ? `  [released ${children.join(", ")}; still awaiting ${gate?.owner ?? "?"}]`
            : "  [gate approved]",
        ),
      );
      break;
    }

    case "request-changes": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, message: { type: "string", short: "m" } },
      });
      const { store } = getStore(values);
      const issue = store.requestChanges(
        positionals[0]!,
        { comment: values.message ?? "" },
        agentName(),
      );
      const gate = store.gate(issue.id);
      if (values.json) {
        outJson({ ...issue, gate });
        break;
      }
      // Says the half that surprises people: the parent is pickable again, the
      // children are not.
      console.log(line(issue, "  [changes requested; children stay queued]"));
      break;
    }

    case "block": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, owner: { type: "string" }, action: { type: "string" } },
      });
      const { store } = getStore(values);
      const issue = store.updateIssue(
        positionals[0]!,
        { status: "blocked", unblockOwner: values.owner, unblockAction: values.action },
        agentName(),
      );
      if (values.json) {
        outJson(issue);
        break;
      }
      console.log(line(issue, values.owner ? `  [unblock: ${values.owner} → ${values.action ?? "?"}]` : ""));
      break;
    }

    case "blocked-by": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, none: { type: "boolean" } },
      });
      const { store } = getStore(values);
      const refs = values.none
        ? []
        : (positionals[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const issue = store.setBlockedBy(positionals[0]!, refs, agentName());
      const blockers = store.unresolvedBlockersOf(issue.id);
      if (values.json) {
        outJson({ ...issue, unresolvedBlockers: blockers.map((b) => b.identifier) });
        break;
      }
      console.log(line(issue, blockers.length ? `  [waiting on ${blockers.map((b) => b.identifier).join(", ")}]` : "  [no unresolved blockers]"));
      break;
    }

    case "wait": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, timeout: { type: "string" }, interval: { type: "string" } },
      });
      const intervalMs = positiveOption(values.interval, 500, "interval");
      const timeoutMs =
        values.timeout === undefined ? undefined : positiveOption(values.timeout, 0, "timeout") * 1000;
      const { store } = readWithRetry(() => getStore(values), intervalMs);
      const ref = positionals[0]!;
      const startedAt = Date.now();
      const deadline = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
      /**
       * Readiness mirrors store.inbox() exactly, so `wait` and `inbox` can never
       * disagree: `blocked` is a human gate even with no blocker rows, and
       * finished work is trivially not-waiting rather than a hang.
       */
      const probe = () => {
        const issue = store.getIssue(ref);
        const unresolvedBlockers = store.unresolvedBlockersOf(issue.id).map((b) => b.identifier);
        const finished = store.isResolvedStatus(issue.status);
        /**
         * A gate is a human gate, so it counts here exactly as `blocked` does
         * (STA-143). Both halves matter: a PARKED parent is not ready — that is
         * the `gated` category, which `parked` covers alongside `blocked` — and
         * an issue QUEUED BEHIND someone else's gate is not ready either, which
         * no status can tell you because it is a fact about an ancestor.
         *
         * `wait` genuinely can return on these — a person approving is a commit
         * like any other, and the data_version tick wakes the loop — so this is
         * not "wait forever", it is "do not call a gate ready".
         */
        const category = store.categoryOf(issue.status);
        const parked = category === "blocked" || category === "gated";
        const queuedBy = store.queuedBy(issue.id);
        return {
          issue,
          unresolvedBlockers,
          queuedBy,
          reason: finished ? "finished" : "ready",
          ready: finished || (!parked && queuedBy === null && unresolvedBlockers.length === 0),
        };
      };
      // data_version only moves when another connection commits — an idle tick
      // costs one pragma instead of a lookup plus a relations join. Read it
      // BEFORE the initial probe: a commit landing between the two must look
      // like a version bump (re-probe), never like already-seen state — the
      // reverse order is a lost wakeup that hangs a ready `wait` forever.
      let lastVersion = tolerateLock(() => dataVersion(store.db)) ?? -1;
      let snapshot = readWithRetry(probe, intervalMs);
      let timedOut = false;
      while (!snapshot.ready) {
        if (deadline !== undefined && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        sleep(deadline === undefined ? intervalMs : Math.min(intervalMs, deadline - Date.now()));
        const version = tolerateLock(() => dataVersion(store.db));
        if (version === undefined || version === lastVersion) continue;
        const next = tolerateLock(probe);
        if (next === undefined) continue;
        lastVersion = version;
        snapshot = next;
      }
      const waitedMs = Date.now() - startedAt;
      if (timedOut) {
        const blockers = snapshot.unresolvedBlockers;
        // Name the gate when there is one: "timed out waiting for STA-113" with
        // no further explanation is the least useful thing this can say when the
        // real answer is that a named human never answered.
        const gateWhy = snapshot.queuedBy
          ? `; queued behind ${snapshot.queuedBy.identifier}, awaiting approval by ${snapshot.queuedBy.owner}`
          : "";
        const envelope = {
          code: "timeout",
          message: `Timed out after ${timeoutMs! / 1000}s waiting for ${snapshot.issue.identifier} (${snapshot.issue.status})${blockers.length ? `; unresolved blockers: ${blockers.join(", ")}` : ""}${gateWhy}`,
          detail: {
            identifier: snapshot.issue.identifier,
            status: snapshot.issue.status,
            unresolvedBlockers: blockers,
            queuedBy: snapshot.queuedBy,
            waitedMs,
            timeoutSeconds: timeoutMs! / 1000,
          },
          // Unlike the store's error codes, a timeout says nothing failed — the
          // budget ran out. Waiting again with a bigger one is the right move.
          retryable: true,
        };
        console.error(values.json ? JSON.stringify(envelope) : `error(${envelope.code}): ${envelope.message}`);
        process.exitCode = EXIT_CODES.timeout;
        break;
      }
      if (values.json) {
        outJson({ ...snapshot.issue, ready: true, reason: snapshot.reason, waitedMs, unresolvedBlockers: snapshot.unresolvedBlockers, queuedBy: snapshot.queuedBy });
        break;
      }
      console.log(line(snapshot.issue, `  [${snapshot.reason} after ${(waitedMs / 1000).toFixed(1)}s]`));
      break;
    }

    case "link": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      const hub = Hub.open();
      try {
        const link = hub.addCrossLink(positionals[0]!, positionals[1]!);
        if (values.json) {
          outJson(link);
          break;
        }
        console.log(`${link.blockerWs}/${link.blockerIdentifier} blocks ${link.blockedWs}/${link.blockedIdentifier}`);
      } finally {
        hub.close();
      }
      break;
    }

    case "comment": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, author: { type: "string" } },
      });
      const { store } = getStore(values);
      const [ref, ...body] = positionals;
      const comment = store.addComment(ref!, body.join(" "), agentName(values.author), "user");
      if (values.json) {
        outJson(comment);
        break;
      }
      console.log("commented.");
      break;
    }

    case "tree": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      const { store } = getStore(values);
      if (values.json) {
        outJson(store.tree(positionals[0]));
        break;
      }
      const print = (nodes: ReturnType<WorkspaceStore["tree"]>, indent: string) => {
        for (const node of nodes) {
          console.log(`${indent}${line(node.issue)}`);
          print(node.children as never, `${indent}  `);
        }
      };
      print(store.tree(positionals[0]), "");
      break;
    }

    case "board": {
      const { values } = parseArgs({ args: rest, options: common });
      const { store } = getStore(values);
      const issues = store.listIssues({ includeResolved: true });
      // Columns are the CONFIGURED statuses in configured order (STA-140). For a
      // default workspace that is the ISSUE_STATUSES order this used to hardcode.
      const columns = store.getStatuses();
      if (values.json) {
        // Full columns: the 15-row cap below is a terminal concern, not a data one.
        outJson(
          Object.fromEntries(
            columns.map(({ id }) => [id, issues.filter((i) => i.status === id)]),
          ),
        );
        break;
      }
      for (const { id: status, category } of columns) {
        const column = issues.filter((i) => i.status === status);
        // An empty RESOLVED column is noise on a terminal board; every other
        // empty column is information ("nothing is in review").
        if (column.length === 0 && (category === "done" || category === "cancelled")) continue;
        console.log(`\n${statusGlyph(status)} ${status.toUpperCase()} (${column.length})`);
        for (const issue of column.slice(0, 15)) {
          console.log(`   ${issue.identifier.padEnd(9)} ${issue.title}${issue.assignee ? ` @${issue.assignee}` : ""}`);
        }
        if (column.length > 15) console.log(`   … ${column.length - 15} more`);
      }
      break;
    }

    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { ...common, assignee: { type: "string" }, hub: { type: "boolean" } },
      });
      if (values.hub) {
        const hub = Hub.open();
        try {
          const unified = hub.unifiedIssues(values.assignee ? { assignee: values.assignee } : {});
          if (values.json) {
            outJson(unified);
            break;
          }
          for (const { workspace, issue } of unified) {
            console.log(`${workspace.padEnd(12)} ${line(issue as Issue)}`);
          }
          if (unified.length === 0) console.log("(nothing open anywhere)");
        } finally {
          hub.close();
        }
        break;
      }
      const { store } = getStore(values);
      const inbox = store.inbox(values.assignee);
      if (values.json) {
        outJson(inbox);
        break;
      }
      console.log("READY (pickup order):");
      for (const issue of inbox.ready) console.log(`  ${line(issue)}`);
      if (inbox.ready.length === 0) console.log("  (nothing ready)");
      /**
       * QUEUED sits between READY and BLOCKED because that is the order an agent
       * reads them in: take something, or find out a person is holding the rest,
       * or find out other work is. Printed only when non-empty, so a workspace
       * with no gates renders exactly as it always did.
       */
      if (inbox.queued.length) {
        console.log("QUEUED (waiting on a human — checkout is refused):");
        /**
         * Gate holders first, then the work behind them — a PRESENTATION choice,
         * made here and not in the store.
         *
         * `store.inbox()` returns this bucket in the ordinary pickup rank, where
         * `awaiting_approval` sorts after `backlog` and the parked parent
         * therefore lands underneath its own queue. That reads backwards: the
         * gate is the only row in the section a human can do anything about, and
         * burying it under the three tickets it is holding hides the one line
         * that says who to go and ask.
         *
         * The store's order is left alone because it is a contract MCP and the
         * web UI both consume; this is the terminal's business.
         */
        const orderedQueue = [
          ...inbox.queued.filter((i) => !i.queuedBy),
          ...inbox.queued.filter((i) => i.queuedBy),
        ];
        for (const issue of orderedQueue) {
          // The parked parent says who it is waiting on; the children say who
          // and behind what. Neither is ever "? must act".
          const why = issue.queuedBy
            ? `awaiting ${issue.queuedBy.owner} on ${issue.queuedBy.identifier}`
            : `awaiting ${issue.gate?.owner ?? "?"}`;
          console.log(`  ${line(issue, `  [${why}]`)}`);
        }
      }
      if (inbox.blocked.length) {
        console.log("BLOCKED:");
        // A parent blocked BY ITS CHILDREN (STA-98) has no descriptor of its own
        // — the fact lives on the child — so it borrows theirs rather than
        // printing "? must act". One batched lookup for the whole list.
        const blockingChildren = store.blockingChildrenOf(inbox.blocked.map((i) => i.id));
        for (const issue of inbox.blocked) {
          const borrowed =
            store.categoryOf(issue.status) === "blocked" && !issue.unblockOwner && !issue.unblockAction
              ? (blockingChildren.get(issue.id) ?? [])
                  .map((c) => `waiting on ${c.unblockOwner ?? "?"}${c.unblockAction ? `: ${c.unblockAction}` : ""}`)
                  .join(" · ")
              : "";
          const why =
            issue.unresolvedBlockers.length > 0
              ? `waiting on ${issue.unresolvedBlockers.join(", ")}`
              : borrowed || `${issue.unblockOwner ?? "?"} must ${issue.unblockAction ?? "act"}`;
          console.log(`  ${line(issue, `  [${why}]`)}`);
        }
      }
      break;
    }

    /**
     * ------------------------------------------------------- vocabulary (O7a)
     *
     * `staple statuses …` and `staple kinds …` are the CLI half of STA-140.
     * Both take the same verbs and both print the FULL list after a write, so a
     * reorder or a rename shows you the state you just created rather than an
     * "ok" you have to verify with a second command.
     */
    case "statuses":
    case "kinds": {
      const isStatus = command === "statuses";
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          label: { type: "string" },
          category: { type: "string" },
          after: { type: "string" },
          "migrate-to": { type: "string" },
        },
      });
      const { store } = getStore(values);
      const sub = positionals[0] ?? "ls";
      const target = positionals[1];
      const show = () => {
        if (isStatus) {
          const rows = store.getStatuses();
          if (values.json) return outJson(rows);
          for (const row of rows) {
            console.log(
              `${statusGlyph(row.id)} ${row.id.padEnd(20)} ${row.category.padEnd(10)} ${row.label}${row.isBuiltin ? "" : "  (custom)"}`,
            );
          }
        } else {
          // Each row carries its resolved appearance (R5a, STA-181); the human
          // list leads with the terminal fallback, the way statuses lead with
          // their glyph, so a custom mark is visible here without a browser.
          const rows = store.getKindsWithAppearance();
          if (values.json) return outJson(rows);
          for (const row of rows) {
            console.log(
              `${row.appearance.fallback} ${row.id.padEnd(20)} ${row.label}${row.isBuiltin ? "" : "  (custom)"}`,
            );
          }
        }
      };
      const need = (what: string): string => {
        if (!target) throw new StapleError("validation", `staple ${command} ${sub} needs ${what}`);
        return target;
      };
      const actor = agentName();
      switch (sub) {
        case "ls":
          show();
          break;
        case "add":
          if (isStatus) {
            if (!values.category) {
              throw new StapleError(
                "validation",
                "--category is required: every status inherits its behaviour from one. " +
                  `Valid: ${STATUS_CATEGORIES.join(", ")}`,
              );
            }
            store.addStatus(
              { id: need("an id"), label: values.label, category: values.category, after: values.after },
              actor,
            );
          } else {
            store.addKind({ id: need("an id"), label: values.label, after: values.after }, actor);
          }
          show();
          break;
        case "rename": {
          const label = values.label ?? positionals[2];
          if (!label) {
            throw new StapleError("validation", `staple ${command} rename <id> --label "New Label"`);
          }
          if (isStatus) store.renameStatus(need("an id"), label, actor);
          else store.renameKind(need("an id"), label, actor);
          show();
          break;
        }
        case "recategorize": {
          if (!isStatus) throw new StapleError("validation", "Kinds have no category — only statuses do.");
          const category = values.category ?? positionals[2];
          if (!category) {
            throw new StapleError("validation", `staple statuses recategorize <id> --category <${STATUS_CATEGORIES.join("|")}>`);
          }
          store.recategorizeStatus(need("an id"), category, actor);
          show();
          break;
        }
        case "reorder": {
          // Comma-separated, like `--blocked-by` and `--criteria`: one shell word
          // per LIST, so the order survives a copy-paste out of `ls`.
          const ids = need("a comma-separated order").split(",").map((s) => s.trim()).filter(Boolean);
          if (isStatus) store.reorderStatuses(ids, actor);
          else store.reorderKinds(ids, actor);
          show();
          break;
        }
        case "rm": {
          const id = need("an id");
          const result = isStatus
            ? store.removeStatus(id, { migrateTo: values["migrate-to"] }, actor)
            : store.removeKind(id, { migrateTo: values["migrate-to"] }, actor);
          if (!values.json && result.migrated > 0) {
            console.log(`moved ${result.migrated} issue(s) to ${values["migrate-to"]}`);
          }
          show();
          break;
        }
        default:
          throw new StapleError(
            "validation",
            `Unknown subcommand "${sub}". Use: ls, add, rename, ${isStatus ? "recategorize, " : ""}reorder, rm`,
          );
      }
      break;
    }

    case "doc": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          ...common,
          put: { type: "string" },
          base: { type: "string" },
          summary: { type: "string" },
          revisions: { type: "boolean" },
        },
      });
      const { store } = getStore(values);
      const [ref, key] = positionals;
      if (values.revisions) {
        if (values.json) {
          outJson(store.listDocumentRevisions(ref!, key!));
          break;
        }
        for (const rev of store.listDocumentRevisions(ref!, key!)) {
          console.log(`r${rev.revision}  ${rev.createdAt.slice(0, 16)}  ${rev.author ?? "?"}  ${rev.changeSummary ?? ""}`);
        }
        break;
      }
      if (values.put !== undefined) {
        const body =
          values.put === "-" ? readFileSync(0, "utf8") : readFileSync(values.put, "utf8");
        const result = store.putDocument(ref!, key!, body, {
          baseRevision: values.base ? Number(values.base) : undefined,
          changeSummary: values.summary,
          author: agentName(),
        });
        if (values.json) {
          outJson(result);
          break;
        }
        console.log(`${key} @ revision ${result.revision}`);
        break;
      }
      const doc = store.getDocument(ref!, key!);
      if (values.json) {
        outJson(doc);
        break;
      }
      console.log(`# ${doc.key} @ r${doc.revision} (${doc.createdAt.slice(0, 16)})\n`);
      console.log(doc.body);
      break;
    }

    case "events": {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...common,
          since: { type: "string" },
          follow: { type: "boolean" },
          interval: { type: "string" },
          exec: { type: "string" },
          max: { type: "string" },
        },
      });
      if (values.follow) {
        const intervalMs = positiveOption(values.interval, 500, "interval");
        const max = values.max === undefined ? Infinity : positiveOption(values.max, 0, "max");
        const since = values.since === undefined ? undefined : Number(values.since);
        if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
          throw new StapleError("validation", `--since must be a non-negative integer, got "${values.since}"`);
        }
        // A follower exists to be piped (`| head`, `| jq`); when the consumer
        // closes the pipe, stop quietly instead of dumping an EPIPE stack.
        process.stdout.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") throw error;
          process.exit(0);
        });
        const { store } = readWithRetry(() => getStore(values), intervalMs);
        // Default cursor is the head of the log: a follower reports the future,
        // not the history. --since resumes from a supervisor's checkpoint.
        let cursor = since ?? readWithRetry(() => latestSeq(store), intervalMs);
        let emitted = 0;
        let lastVersion = -1;
        for (;;) {
          const batch =
            tolerateLock(() => {
              // data_version only moves when another connection commits, so an
              // idle tick costs one pragma instead of a scan. Advance the marker
              // only once the drain behind it has actually landed.
              const version = dataVersion(store.db);
              if (version === lastVersion) return [];
              const drained = eventsSince(store, cursor);
              lastVersion = version;
              return drained;
            }) ?? [];
          for (const event of batch) {
            cursor = event.seq;
            if (values.json) outJson(event);
            else console.log(formatEvent(event));
            if (values.exec) dispatchEvent(values.exec, event, Boolean(values.json));
            emitted += 1;
            if (emitted >= max) break;
          }
          if (emitted >= max) break;
          sleep(intervalMs);
        }
        break;
      }
      const { store } = getStore(values);
      const eventList = store.listEvents(values.since ? Number(values.since) : 0);
      if (values.json) {
        // NDJSON: one event per line, streamable, no wrapping array.
        for (const event of eventList) outJson(event);
        break;
      }
      for (const event of eventList) {
        console.log(formatEvent(event));
      }
      break;
    }

    case "hub": {
      const sub = rest.filter((arg) => !arg.startsWith("--"))[0] ?? "ls";
      const hub = Hub.open();
      try {
        if (sub === "ls") {
          if (jsonMode) {
            outJson(hub.list());
            break;
          }
          for (const ws of hub.list()) {
            console.log(
              `${ws.prefix.padEnd(6)} ${ws.slug.padEnd(20)} ${ws.kind.padEnd(7)} ${ws.available ? "available" : "MISSING"}  ${ws.path}`,
            );
          }
        } else if (sub === "links") {
          if (jsonMode) {
            outJson(hub.listCrossLinks());
            break;
          }
          for (const link of hub.listCrossLinks()) {
            console.log(`${link.blockerIdentifier} blocks ${link.blockedIdentifier}  (${link.blockerWs} → ${link.blockedWs})`);
          }
        } else if (sub === "events") {
          if (jsonMode) {
            for (const event of hub.listHubEvents()) outJson(event);
            break;
          }
          for (const event of hub.listHubEvents()) {
            console.log(`${String(event.seq).padStart(4)}  ${event.createdAt.slice(0, 19)}  ${event.kind}  ${JSON.stringify(event.payload)}`);
          }
        } else {
          console.log("usage: staple hub [ls|links|events]");
        }
      } finally {
        hub.close();
      }
      break;
    }

    case "open":
    case "ui": {
      // One implementation, two spellings. The plan keeps `ui` as "a
      // compatibility alias for `open` … for at least one minor release", and an
      // alias that is a second code path is how the two stop agreeing.
      runOpenCommand(rest, { token: persistentUiToken() });
      break;
    }

    case "config": {
      runConfigCommand(rest);
      break;
    }

    case "install": {
      runInstallCommand(rest);
      break;
    }

    case "doctor": {
      runDoctorCommand(rest);
      break;
    }

    case "add": {
      runAddCommand(rest);
      break;
    }

    case "discover": {
      runDiscoverCommand(rest);
      break;
    }

    case "milestone": {
      runMilestoneCommand(rest);
      break;
    }

    case "migrate": {
      const { values } = parseArgs({
        args: rest,
        options: { dir: { type: "string" }, yes: { type: "boolean" }, json: { type: "boolean" } },
      });
      runMigrateCommand({ dir: values.dir, yes: values.yes === true, json: values.json === true });
      break;
    }

    /**
     * `staple settings` — R6d (STA-179). The WORKSPACE twin of `config`: every
     * registered workspace setting with its effective value and provenance,
     * one by key, or a write. Reads and writes go through the store, so the
     * value and `source` printed here are the object `/api/settings` serves and
     * `get_setting` answers — one shape on every surface, and a global key is
     * refused with the sentence that names `staple config set`.
     */
    case "settings": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      const { store } = getStore(values);
      const sub = positionals[0] ?? "ls";
      // A structured value (kinds.appearance is a map) prints as JSON rather
      // than "[object Object]"; a scalar prints as itself.
      const shown = (value: unknown) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      const line = (view: SettingValueView) =>
        console.log(`${view.key} = ${view.redacted ? "<redacted>" : shown(view.value)}  (${view.source})`);
      switch (sub) {
        case "ls": {
          const views = store.settingValues();
          if (values.json) outJson(views);
          else for (const view of views) line(view);
          break;
        }
        case "get": {
          const key = positionals[1];
          if (!key) throw new StapleError("validation", "usage: staple settings get <key>");
          const view = store.settingValue(key);
          if (values.json) outJson(view);
          else line(view);
          break;
        }
        case "set": {
          const key = positionals[1];
          const raw = positionals[2];
          if (!key || raw === undefined) throw new StapleError("validation", "usage: staple settings set <key> <value>");
          const definition = requireSettingDefinition(key, "workspace");
          const view = store.setSetting(key, coerceSettingInput(definition, raw, `workspace ${store.slug}`), agentName());
          if (values.json) outJson(view);
          else line(view);
          break;
        }
        default:
          throw new StapleError("validation", `Unknown subcommand "${sub}". Use: ls, get, set`);
      }
      break;
    }

    default: {
      const message = `Unknown command "${command}". Run \`staple help\`.`;
      if (jsonMode) {
        console.error(JSON.stringify({ code: "validation", message, retryable: false }));
      } else {
        console.error(message);
      }
      process.exitCode = EXIT_CODES.validation;
    }
  }
}

try {
  main();
} catch (error) {
  // parseArgs failures (unknown option, missing value) are usage errors, not
  // transient faults — classify them as validation so the retry bit stays honest.
  const parseCode = (error as NodeJS.ErrnoException)?.code;
  const normalized =
    typeof parseCode === "string" && parseCode.startsWith("ERR_PARSE_ARGS")
      ? new StapleError("validation", (error as Error).message)
      : error;
  const envelope = errorEnvelope(normalized);
  if (jsonMode) {
    console.error(JSON.stringify(envelope));
  } else if (error instanceof StapleError) {
    console.error(`error(${error.code}): ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = EXIT_CODES[envelope.code] ?? 1;
}
