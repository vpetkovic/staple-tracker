/**
 * The Claude Code status-line wrapper: installing staple's rollback-safe ingestion in
 * front of whatever `statusLine` command a Claude config directory already runs, and
 * taking it out again so the file is byte for byte what it was.
 *
 * ## The wrapper
 *
 * The recipe docs/cli.md documents, as a plain POSIX command list that the shell Claude
 * Code already uses runs directly (no nested `bash -c`):
 *
 *     : staple-statusline-wrapper/v2; __stf=$(mktemp); cat >| "$__stf"; exec 3<"$__stf" 4<"$__stf"; rm -f "$__stf"; unset __stf;
 *     '<staple>' budget ingest --source claude-statusline --config-dir '<dir>' <&3 >/dev/null 2>&1 &
 *     exec 0<&4 3<&- 4<&-; <original command>
 *
 *   - `: staple-statusline-wrapper/v2` is a no-op that marks the command as staple's,
 *     so a second setup does not wrap it twice and `unsetup` knows it is ours.
 *   - The original is the tail, verbatim, run by the SAME shell that ran it before, with
 *     stdin moved to its copy of the input. Nesting a shell would change what it means:
 *     `echo "\033[32m"` prints an escape under sh and zsh and a backslash under bash.
 *   - Everything after the `exec 0<&4 3<&- 4<&-;` separator IS the original: the wrapper
 *     alone is enough to restore it, even if staple's own record of the install is gone.
 *
 * Version 1 wrapped the same script in `bash -c '…'`. It is still recognised, unwrapped
 * and, by a new setup, upgraded in place.
 *
 * Nothing waits on staple and nothing staple prints reaches the status line: if staple
 * is missing, rolled back to a build without `budget`, or refuses the reading, the
 * status line is exactly what it was.
 *
 * ## The edit
 *
 * Every edit is computed and validated in full before anything is written, so the plan
 * refuses what apply would fail on. The file is refused unless `JSON.parse` accepts it,
 * and unless it (and its directory, for the rename) is writable. A symlinked
 * settings.json (a dotfile manager's) is followed: the backup, the edit and the rename
 * happen at the real file, and the link stays a link. Only the `command` string's span is
 * replaced (or one `statusLine` member inserted when there was none), so every other byte
 * stays as the owner wrote it. A timestamped copy is taken first, and the write is a
 * temporary file renamed over the original.
 */
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { StapleError } from "../../types.js";
import { member, memberIndent, memberRemovalSpan, scanJson, splice, type JsonNode } from "./json-spans.js";

export const WRAPPER_MARKER = "staple-statusline-wrapper/v2";
const MARKER_FAMILY = "staple-statusline-wrapper/v";
const PREFIX = `: ${WRAPPER_MARKER}; `;
const V1_PREFIX = ": staple-statusline-wrapper/v1; ";
const SEPARATOR = "exec 0<&4 3<&- 4<&-;";
/** How many backups of one settings file are kept. */
export const BACKUPS_KEPT = 10;

/** POSIX single-quoting: safe for any byte string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Undo {@link shellQuote} over a run of quoted segments and `\'`; null when it is not one. */
function shellUnquote(value: string): string | null {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === "'") {
      const close = value.indexOf("'", i + 1);
      if (close < 0) return null;
      out += value.slice(i + 1, close);
      i = close + 1;
    } else if (value.startsWith("\\'", i)) {
      out += "'";
      i += 2;
    } else return null;
  }
  return out;
}

/** The status-line command staple installs, around `original` (null: there was none). */
export function wrapperCommand(input: { staple: string; configDir: string; original: string | null }): string {
  const ingest = `${shellQuote(input.staple)} budget ingest --source claude-statusline --config-dir ${shellQuote(input.configDir)} <&3 >/dev/null 2>&1 &`;
  // `>|`: mktemp has already created the file, and `set -C` (noclobber) would refuse `>`.
  return `${PREFIX}__stf=$(mktemp); cat >| "$__stf"; exec 3<"$__stf" 4<"$__stf"; rm -f "$__stf"; unset __stf; ${ingest} ${SEPARATOR}${input.original === null ? "" : ` ${input.original}`}`;
}

export type WrapperKind = "staple" | "hand_wrapped" | "plain";

/** What a status-line command is: staple's wrapper (any version), someone's own ingestion recipe, or neither. */
export function classifyCommand(command: string): WrapperKind {
  if (command.includes(MARKER_FAMILY)) return "staple";
  if (/budget\s+ingest\b/.test(command) && command.includes("claude-statusline")) return "hand_wrapped";
  return "plain";
}

/** Whether a staple wrapper is the current version (false: an older one setup upgrades). */
export function isCurrentWrapper(command: string): boolean {
  return command.startsWith(PREFIX);
}

/**
 * The command a staple wrapper wraps: a string, or null for a wrapper installed where
 * there was no status line. Throws when the text is marked but not in a shape staple
 * writes, so a damaged wrapper is never "restored" to a guess.
 */
export function unwrapCommand(command: string): string | null {
  const damaged = (): never => {
    throw new StapleError("validation", `The status-line command is marked ${MARKER_FAMILY}… but is not in the shape staple writes; restore it by hand from a backup.`);
  };
  let script: string;
  if (command.startsWith(PREFIX)) script = command;
  else if (command.startsWith("bash -c ")) {
    // Version 1: the same script, single-quoted inside `bash -c`.
    const inner = shellUnquote(command.slice("bash -c ".length));
    if (inner === null || !inner.startsWith(V1_PREFIX)) return damaged();
    script = inner;
  } else return damaged();
  const at = script.indexOf(SEPARATOR);
  if (at < 0) return damaged();
  const tail = script.slice(at + SEPARATOR.length);
  if (tail === "") return null;
  if (!tail.startsWith(" ")) return damaged();
  return tail.slice(1);
}

// ------------------------------------------------------------------ reading the file

export type SettingsState =
  | { readonly state: "missing_file" }
  | { readonly state: "invalid_json"; readonly problem: string }
  | { readonly state: "not_an_object" }
  | { readonly state: "no_statusline" }
  /** A statusLine that is not `{type: "command", command: "<string>"}`: left alone. */
  | { readonly state: "unsupported"; readonly problem: string }
  | { readonly state: "command"; readonly command: string; readonly kind: WrapperKind };

interface Parsed {
  readonly text: string;
  readonly root: JsonNode;
}

function parse(text: string): Parsed | { problem: string } {
  try {
    JSON.parse(text);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  return { text, root: scanJson(text) };
}

function statusLineOf(parsed: Parsed): SettingsState {
  if (parsed.root.kind !== "object") return { state: "not_an_object" };
  const line = member(parsed.root, "statusLine");
  if (line === null) return { state: "no_statusline" };
  if (line.value.kind !== "object") return { state: "unsupported", problem: "statusLine is not an object" };
  const value = JSON.parse(parsed.text.slice(line.value.start, line.value.end)) as Record<string, unknown>;
  if (value.type !== undefined && value.type !== "command") return { state: "unsupported", problem: `statusLine.type is ${JSON.stringify(value.type)}, not "command"` };
  if (typeof value.command !== "string") return { state: "unsupported", problem: "statusLine.command is not a string" };
  return { state: "command", command: value.command, kind: classifyCommand(value.command) };
}

export function settingsPathFor(configDir: string): string {
  return join(configDir, "settings.json");
}

/** What the settings file of a Claude config directory says about its status line. */
export function readSettingsState(settingsPath: string): SettingsState {
  if (!existsSync(settingsPath)) return { state: "missing_file" };
  const parsed = parse(readFileSync(settingsPath, "utf8"));
  if ("problem" in parsed) return { state: "invalid_json", problem: parsed.problem };
  return statusLineOf(parsed);
}

/**
 * Where an edit of `settingsPath` must land: the file itself, or the file a symlink
 * points at, so the rename happens beside the real file and the link survives. Null
 * with a reason when the edit cannot be made there: a dangling link, or a file or
 * directory this process cannot write (a rename replaces a read-only file without
 * asking, which is exactly what a 0444 file says not to do).
 */
export function editTarget(settingsPath: string): { path: string; symlink: boolean } | { problem: string } {
  let path = settingsPath;
  let symlink = false;
  try {
    if (lstatSync(settingsPath).isSymbolicLink()) {
      symlink = true;
      try {
        path = realpathSync(settingsPath);
      } catch {
        return { problem: `${settingsPath} is a symlink to a file that does not exist` };
      }
    }
  } catch {
    // Absent: it will be created in its directory.
  }
  const writable = (target: string): boolean => {
    try {
      accessSync(target, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(path) && !writable(path)) return { problem: `${path} is not writable (mode ${(statSync(path).mode & 0o777).toString(8)}); nothing will be written to it` };
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (!writable(dir)) return { problem: `${dir} is not writable, so ${basename(path)} cannot be replaced there` };
  return { path, symlink };
}

// ------------------------------------------------------------------ install / uninstall

/** What staple keeps to undo its own edit exactly. Machine-local; lives in the setup record. */
export interface StatuslineInstall {
  readonly settingsPath: string;
  readonly configDir: string;
  /** The wrapper as written, to recognise the file still holds staple's edit. */
  readonly wrapperCommand: string;
  /** The original `command` value's exact JSON text, when there was one. */
  readonly originalLiteral: string | null;
  /** The exact text inserted, when there was no statusLine to wrap. */
  readonly insertedText: string | null;
  /** True when staple created the file itself. */
  readonly createdFile: boolean;
  readonly backupPath: string | null;
  readonly installedAt: string;
}

export interface StatuslinePlan {
  readonly settingsPath: string;
  readonly action: "install" | "upgrade" | "already_installed" | "hand_wrapped" | "refuse";
  /** The command today (null: none), and what it will become. */
  readonly currentCommand: string | null;
  readonly newCommand: string | null;
  readonly reason: string;
}

function statuslineMemberText(command: string, indent: string, multiline: boolean): string {
  if (!multiline) return `"statusLine": {"type": "command", "command": ${JSON.stringify(command)}}`;
  const inner = `${indent}${indent === "" ? "  " : indent}`;
  return `"statusLine": {\n${inner}"type": "command",\n${inner}"command": ${JSON.stringify(command)}\n${indent}}`;
}

const createdText = (command: string): string => `{\n  ${statuslineMemberText(command, "  ", true)}\n}\n`;

interface InstallEdit {
  /** The whole new file. */
  readonly text: string;
  readonly originalLiteral: string | null;
  readonly insertedText: string | null;
  readonly createdFile: boolean;
}

/** Throw unless `text` is JSON: every computed edit is checked before it is planned or written. */
function assertJson(text: string, what: string): void {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new StapleError("validation", `staple's edit of ${what} would not be valid JSON (${(error as Error).message}); nothing was written. Edit the statusLine by hand.`, {
      reason: "statusline_refused",
    });
  }
}

/**
 * The edit that installs `command`, computed from the file's current text (null: no
 * file) without writing anything. `previous` is the record of an older staple wrapper
 * being upgraded: its original literal and inserted text are carried over.
 */
function computeInstall(text: string | null, command: string, what: string, previous: StatuslineInstall | null): InstallEdit {
  if (text === null) {
    const created = createdText(command);
    return { text: created, originalLiteral: null, insertedText: null, createdFile: true };
  }
  const parsed = parse(text) as Parsed;
  const line = member(parsed.root, "statusLine");
  let edit: InstallEdit;
  if (line !== null) {
    const commandMember = member(line.value, "command")!;
    const currentLiteral = text.slice(commandMember.value.start, commandMember.value.end);
    const currentCommand = JSON.parse(currentLiteral) as string;
    let originalLiteral: string | null = currentLiteral;
    let insertedText: string | null = null;
    let createdFile = false;
    if (classifyCommand(currentCommand) === "staple") {
      // Upgrading an older wrapper: what it wrapped is what comes back later.
      const recorded = previous !== null && previous.wrapperCommand === currentCommand;
      const original = unwrapCommand(currentCommand);
      originalLiteral = recorded ? previous.originalLiteral : original === null ? null : JSON.stringify(original);
      insertedText = recorded && previous.insertedText !== null ? previous.insertedText.replace(currentLiteral, JSON.stringify(command)) : null;
      createdFile = recorded ? previous.createdFile : false;
    }
    edit = { text: splice(text, commandMember.value.start, commandMember.value.end, JSON.stringify(command)), originalLiteral, insertedText, createdFile };
  } else {
    const root = parsed.root;
    const members = root.members ?? [];
    const multiline = text.slice(root.start, root.end).includes("\n");
    let insertedText: string;
    let at: number;
    if (members.length > 0) {
      const indent = memberIndent(text, root);
      insertedText = multiline ? `,\n${indent}${statuslineMemberText(command, indent, true)}` : `, ${statuslineMemberText(command, "", false)}`;
      at = members[members.length - 1]!.value.end;
    } else {
      insertedText = multiline ? `\n  ${statuslineMemberText(command, "  ", true)}` : statuslineMemberText(command, "", false);
      at = root.start + 1;
    }
    edit = { text: splice(text, at, at, insertedText), originalLiteral: null, insertedText, createdFile: false };
  }
  assertJson(edit.text, what);
  return edit;
}

export function planStatuslineInstall(input: { configDir: string; staple: string; record?: StatuslineInstall | null }): StatuslinePlan {
  const settingsPath = settingsPathFor(input.configDir);
  const state = readSettingsState(settingsPath);
  const base = { settingsPath, currentCommand: null, newCommand: null };
  const refuse = (reason: string): StatuslinePlan => ({ ...base, action: "refuse", reason });
  let action: "install" | "upgrade";
  let original: string | null = null;
  let reason: string;
  switch (state.state) {
    case "invalid_json":
      return refuse(`${settingsPath} is not valid JSON (${state.problem}); nothing will be written to it. Fix the file first.`);
    case "not_an_object":
      return refuse(`${settingsPath} is not a JSON object; nothing will be written to it.`);
    case "unsupported":
      return refuse(`${settingsPath}: ${state.problem}, so there is no command to wrap; left alone.`);
    case "missing_file":
    case "no_statusline":
      action = "install";
      reason =
        state.state === "missing_file"
          ? `${settingsPath} does not exist; it will be created with a status line that records readings and prints nothing.`
          : "No statusLine is configured; one that records readings and prints nothing will be added.";
      break;
    case "command":
      if (state.kind === "hand_wrapped") {
        return { ...base, action: "hand_wrapped", currentCommand: state.command, reason: "The status line already runs `staple budget ingest` (a hand-installed wrapper); it is left as it is and not wrapped twice." };
      }
      if (state.kind === "staple") {
        try {
          original = unwrapCommand(state.command);
        } catch (error) {
          return refuse((error as Error).message);
        }
        // Current only when it is exactly what this build would write around the same
        // original: an older form (v1's `bash -c`, v2 before noclobber-safety) is rewritten.
        if (state.command === wrapperCommand({ staple: input.staple, configDir: input.configDir, original })) {
          return { ...base, action: "already_installed", currentCommand: state.command, reason: "staple's wrapper is already installed." };
        }
        action = "upgrade";
        reason = isCurrentWrapper(state.command)
          ? "An older staple wrapper is replaced by the current one (noclobber-safe, or a new staple path or config directory); the command it wraps is unchanged."
          : "An older staple wrapper (a nested `bash -c`) is replaced by the current one; the command it wraps is unchanged.";
        break;
      }
      action = "install";
      original = state.command;
      reason = "The existing status-line command will run unchanged behind staple's wrapper, in the same shell.";
      break;
  }
  const target = editTarget(settingsPath);
  if ("problem" in target) return refuse(`${target.problem}.`);
  const newCommand = wrapperCommand({ staple: input.staple, configDir: input.configDir, original });
  try {
    computeInstall(state.state === "missing_file" ? null : readFileSync(target.path, "utf8"), newCommand, settingsPath, input.record ?? null);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const via = target.symlink ? ` (${settingsPath} is a symlink; ${target.path} is edited and the link is kept)` : "";
  return { ...base, action, currentCommand: state.state === "command" ? state.command : null, newCommand, reason: `${reason}${via}` };
}

function stamp(now: string): string {
  return now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Copy the settings file into the backup directory, keeping the newest {@link BACKUPS_KEPT}. */
function backup(settingsPath: string, backupDir: string, now: string): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const name = `${basename(settingsPath)}.${stamp(now)}`;
  let target = join(backupDir, name);
  for (let n = 1; existsSync(target); n += 1) target = join(backupDir, `${name}.${n}`);
  copyFileSync(settingsPath, target);
  const kept = readdirSync(backupDir)
    .filter((entry) => entry.startsWith(`${basename(settingsPath)}.`))
    .map((entry) => ({ entry, mtime: statSync(join(backupDir, entry)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.entry.localeCompare(a.entry));
  for (const old of kept.slice(BACKUPS_KEPT)) rmSync(join(backupDir, old.entry), { force: true });
  return target;
}

/** Write a settings file atomically at its real path, keeping the mode the file had. */
function writeSettings(realPath: string, text: string): void {
  let mode = 0o644;
  try {
    mode = statSync(realPath).mode & 0o777;
  } catch {
    // a new file
  }
  writeFileAtomic(realPath, text, {
    mode,
    validate: (temp) => {
      JSON.parse(readFileSync(temp, "utf8"));
    },
  });
}

function targetOrThrow(settingsPath: string): string {
  const target = editTarget(settingsPath);
  if ("problem" in target) throw new StapleError("validation", `${target.problem}.`, { reason: "statusline_refused", settingsPath });
  return target.path;
}

/**
 * Install (or upgrade) the wrapper. Returns the record that undoes it, or null when
 * nothing needed to change. Refuses (and writes nothing) when the plan does.
 */
export function installStatusline(input: { configDir: string; staple: string; backupDir: string; now: string; record?: StatuslineInstall | null }): StatuslineInstall | null {
  const plan = planStatuslineInstall(input);
  if (plan.action === "refuse") throw new StapleError("validation", plan.reason, { reason: "statusline_refused", settingsPath: plan.settingsPath });
  if (plan.action !== "install" && plan.action !== "upgrade") return null;
  const settingsPath = plan.settingsPath;
  const real = targetOrThrow(settingsPath);
  const exists = existsSync(real);
  const edit = computeInstall(exists ? readFileSync(real, "utf8") : null, plan.newCommand!, settingsPath, input.record ?? null);
  const backupPath = exists ? backup(real, input.backupDir, input.now) : null;
  writeSettings(real, edit.text);
  return {
    settingsPath,
    configDir: input.configDir,
    wrapperCommand: plan.newCommand!,
    originalLiteral: edit.originalLiteral,
    insertedText: edit.insertedText,
    createdFile: edit.createdFile,
    backupPath: backupPath ?? input.record?.backupPath ?? null,
    installedAt: input.now,
  };
}

export interface StatuslineRemovalPlan {
  readonly settingsPath: string;
  readonly action: "restore" | "remove_statusline" | "delete_file" | "not_installed" | "refuse";
  /** The command that comes back (null: none). */
  readonly restoredCommand: string | null;
  readonly reason: string;
}

/** The file after staple's wrapper is taken out, or null when the file itself goes. Writes nothing. */
function computeRemoval(text: string, record: StatuslineInstall | null, what: string): string | null {
  const parsed = parse(text) as Parsed;
  const line = member(parsed.root, "statusLine")!;
  const commandMember = member(line.value, "command")!;
  const current = text.slice(commandMember.value.start, commandMember.value.end);
  const command = JSON.parse(current) as string;
  const original = unwrapCommand(command);
  const recorded = record !== null && JSON.stringify(record.wrapperCommand) === current;
  let next: string;
  if (original !== null) {
    // The recorded literal brings back the original's exact escapes; without the record,
    // the wrapper's own copy of the command is written as JSON.
    const literal = recorded && record.originalLiteral !== null ? record.originalLiteral : JSON.stringify(original);
    next = splice(text, commandMember.value.start, commandMember.value.end, literal);
  } else {
    if (record?.createdFile && recorded && text === createdText(command)) return null;
    const at = recorded && record.insertedText !== null ? text.indexOf(record.insertedText) : -1;
    if (at >= 0 && text.indexOf(record!.insertedText!, at + 1) < 0) next = splice(text, at, at + record!.insertedText!.length, "");
    else {
      const span = memberRemovalSpan(parsed.root, line);
      next = splice(text, span.start, span.end, "");
    }
  }
  assertJson(next, what);
  return next;
}

export function planStatuslineRemoval(input: { configDir: string; record: StatuslineInstall | null }): StatuslineRemovalPlan {
  const settingsPath = settingsPathFor(input.configDir);
  const state = readSettingsState(settingsPath);
  const base = { settingsPath, restoredCommand: null };
  if (state.state === "invalid_json") return { ...base, action: "refuse", reason: `${settingsPath} is not valid JSON (${state.problem}); nothing will be written to it.` };
  if (state.state !== "command" || state.kind !== "staple") {
    const removed = input.record !== null ? " (staple's wrapper was installed but the file no longer holds it; nothing to undo)" : "";
    return { ...base, action: "not_installed", reason: `staple's wrapper is not in ${settingsPath}${removed}.` };
  }
  const target = editTarget(settingsPath);
  if ("problem" in target) return { ...base, action: "refuse", reason: `${target.problem}.` };
  let original: string | null;
  let next: string | null;
  try {
    original = unwrapCommand(state.command);
    next = computeRemoval(readFileSync(target.path, "utf8"), input.record, settingsPath);
  } catch (error) {
    return { ...base, action: "refuse", reason: (error as Error).message };
  }
  if (original !== null) {
    return { ...base, action: "restore", restoredCommand: original, reason: "The original status-line command comes back unchanged." };
  }
  if (next === null) return { ...base, action: "delete_file", reason: `staple created ${settingsPath}; it is removed again.` };
  return { ...base, action: "remove_statusline", reason: "There was no status line before; staple's is removed." };
}

/** Take the wrapper out. Returns false when there was nothing of staple's to remove. */
export function uninstallStatusline(input: { configDir: string; record: StatuslineInstall | null; backupDir: string; now: string }): boolean {
  const plan = planStatuslineRemoval(input);
  if (plan.action === "refuse") throw new StapleError("validation", plan.reason, { reason: "statusline_refused", settingsPath: plan.settingsPath });
  if (plan.action === "not_installed") return false;
  const real = targetOrThrow(plan.settingsPath);
  const next = computeRemoval(readFileSync(real, "utf8"), input.record, plan.settingsPath);
  if (next === null) {
    rmSync(plan.settingsPath);
    return true;
  }
  backup(real, input.backupDir, input.now);
  writeSettings(real, next);
  return true;
}
