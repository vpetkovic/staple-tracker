/**
 * The Claude Code status-line wrapper: installing staple's rollback-safe ingestion in
 * front of whatever `statusLine` command a Claude config directory already runs, and
 * taking it out again so the file is byte for byte what it was.
 *
 * ## The wrapper
 *
 * The recipe docs/cli.md documents, with two additions:
 *
 *     bash -c ': staple-statusline-wrapper/v1; f=$(mktemp); cat > "$f"; exec 3<"$f" 4<"$f"; rm -f "$f";
 *              '<staple>' budget ingest --source claude-statusline --config-dir '<dir>' <&3 >/dev/null 2>&1 &
 *              exec 0<&4 3<&- 4<&-; <original command>'
 *
 *   - `: staple-statusline-wrapper/v1` is a no-op that marks the command as staple's,
 *     so a second setup does not wrap it twice and `unsetup` knows it is ours.
 *   - The original runs as the tail of the script with stdin moved to its copy of the
 *     input, verbatim, so a pipeline or a `;` list keeps working. Everything after the
 *     `exec 0<&4 …;` separator IS the original: the wrapper alone is enough to restore
 *     it, even if staple's own record of the install is gone.
 *
 * Nothing waits on staple and nothing staple prints reaches the status line: if staple
 * is missing, rolled back to a build without `budget`, or refuses the reading, the
 * status line is exactly what it was.
 *
 * ## The edit
 *
 * The file is refused unless `JSON.parse` accepts it. Only the `command` string's span
 * is replaced (or one `statusLine` member inserted when there was none), so every other
 * byte stays as the owner wrote it. A timestamped copy is taken first, and the write is a
 * temporary file renamed over the original.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { StapleError } from "../../types.js";
import { member, memberIndent, memberRemovalSpan, scanJson, splice, type JsonNode } from "./json-spans.js";

export const WRAPPER_MARKER = "staple-statusline-wrapper/v1";
const PREFIX = `: ${WRAPPER_MARKER}; `;
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
  const inner = `${PREFIX}f=$(mktemp); cat > "$f"; exec 3<"$f" 4<"$f"; rm -f "$f"; ${ingest} ${SEPARATOR}${input.original === null ? "" : ` ${input.original}`}`;
  return `bash -c ${shellQuote(inner)}`;
}

export type WrapperKind = "staple" | "hand_wrapped" | "plain";

/** What a status-line command is: staple's wrapper, someone's own ingestion recipe, or neither. */
export function classifyCommand(command: string): WrapperKind {
  if (command.includes(WRAPPER_MARKER)) return "staple";
  if (/budget\s+ingest\b/.test(command) && command.includes("claude-statusline")) return "hand_wrapped";
  return "plain";
}

/**
 * The command a staple wrapper wraps: a string, or null for a wrapper installed where
 * there was no status line. Throws when the text is marked but not in the shape this
 * build writes, so a damaged wrapper is never "restored" to a guess.
 */
export function unwrapCommand(command: string): string | null {
  const damaged = (): never => {
    throw new StapleError("validation", `The status-line command is marked ${WRAPPER_MARKER} but is not in the shape staple writes; restore it by hand from a backup.`);
  };
  if (!command.startsWith("bash -c ")) return damaged();
  const inner = shellUnquote(command.slice("bash -c ".length));
  if (inner === null || !inner.startsWith(PREFIX)) return damaged();
  const at = inner.indexOf(SEPARATOR);
  if (at < 0) return damaged();
  const tail = inner.slice(at + SEPARATOR.length);
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
  readonly action: "install" | "already_installed" | "hand_wrapped" | "refuse";
  /** The command today (null: none), and what it will become. */
  readonly currentCommand: string | null;
  readonly newCommand: string | null;
  readonly reason: string;
}

export function planStatuslineInstall(input: { configDir: string; staple: string }): StatuslinePlan {
  const settingsPath = settingsPathFor(input.configDir);
  const state = readSettingsState(settingsPath);
  const base = { settingsPath, currentCommand: null, newCommand: null };
  switch (state.state) {
    case "invalid_json":
      return { ...base, action: "refuse", reason: `${settingsPath} is not valid JSON (${state.problem}); nothing will be written to it. Fix the file first.` };
    case "not_an_object":
      return { ...base, action: "refuse", reason: `${settingsPath} is not a JSON object; nothing will be written to it.` };
    case "unsupported":
      return { ...base, action: "refuse", reason: `${settingsPath}: ${state.problem}, so there is no command to wrap; left alone.` };
    case "missing_file":
    case "no_statusline":
      return {
        ...base,
        action: "install",
        newCommand: wrapperCommand({ staple: input.staple, configDir: input.configDir, original: null }),
        reason:
          state.state === "missing_file"
            ? `${settingsPath} does not exist; it will be created with a status line that records readings and prints nothing.`
            : "No statusLine is configured; one that records readings and prints nothing will be added.",
      };
    case "command":
      if (state.kind === "staple") return { ...base, action: "already_installed", currentCommand: state.command, reason: "staple's wrapper is already installed." };
      if (state.kind === "hand_wrapped") {
        return { ...base, action: "hand_wrapped", currentCommand: state.command, reason: "The status line already runs `staple budget ingest` (a hand-installed wrapper); it is left as it is and not wrapped twice." };
      }
      return {
        ...base,
        action: "install",
        currentCommand: state.command,
        newCommand: wrapperCommand({ staple: input.staple, configDir: input.configDir, original: state.command }),
        reason: "The existing status-line command will run unchanged behind staple's wrapper.",
      };
  }
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

/** Write a settings file atomically, keeping the mode the file had. */
function writeSettings(settingsPath: string, text: string): void {
  let mode = 0o644;
  try {
    mode = statSync(settingsPath).mode & 0o777;
  } catch {
    // a new file
  }
  writeFileAtomic(settingsPath, text, {
    mode,
    validate: (temp) => {
      JSON.parse(readFileSync(temp, "utf8"));
    },
  });
}

function statuslineMemberText(command: string, indent: string, multiline: boolean): string {
  if (!multiline) return `"statusLine": {"type": "command", "command": ${JSON.stringify(command)}}`;
  const inner = `${indent}${indent === "" ? "  " : indent}`;
  return `"statusLine": {\n${inner}"type": "command",\n${inner}"command": ${JSON.stringify(command)}\n${indent}}`;
}

/**
 * Install the wrapper. Returns the record that undoes it, or null when nothing needed to
 * change. Refuses (and writes nothing) when the plan does.
 */
export function installStatusline(input: { configDir: string; staple: string; backupDir: string; now: string }): StatuslineInstall | null {
  const plan = planStatuslineInstall(input);
  if (plan.action === "refuse") throw new StapleError("validation", plan.reason, { reason: "statusline_refused", settingsPath: plan.settingsPath });
  if (plan.action !== "install") return null;
  const settingsPath = plan.settingsPath;
  const command = plan.newCommand!;
  const base = { settingsPath, configDir: input.configDir, wrapperCommand: command, installedAt: input.now };

  if (!existsSync(settingsPath)) {
    const text = `{\n  ${statuslineMemberText(command, "  ", true)}\n}\n`;
    writeSettings(settingsPath, text);
    return { ...base, originalLiteral: null, insertedText: null, createdFile: true, backupPath: null };
  }

  const backupPath = backup(settingsPath, input.backupDir, input.now);
  const parsed = parse(readFileSync(settingsPath, "utf8")) as Parsed;
  const text = parsed.text;
  const line = member(parsed.root, "statusLine");
  if (line !== null) {
    const commandMember = member(line.value, "command")!;
    const originalLiteral = text.slice(commandMember.value.start, commandMember.value.end);
    writeSettings(settingsPath, splice(text, commandMember.value.start, commandMember.value.end, JSON.stringify(command)));
    return { ...base, originalLiteral, insertedText: null, createdFile: false, backupPath };
  }

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
  writeSettings(settingsPath, splice(text, at, at, insertedText));
  return { ...base, originalLiteral: null, insertedText, createdFile: false, backupPath };
}

export interface StatuslineRemovalPlan {
  readonly settingsPath: string;
  readonly action: "restore" | "remove_statusline" | "delete_file" | "not_installed" | "refuse";
  /** The command that comes back (null: none). */
  readonly restoredCommand: string | null;
  readonly reason: string;
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
  let original: string | null;
  try {
    original = unwrapCommand(state.command);
  } catch (error) {
    return { ...base, action: "refuse", reason: (error as Error).message };
  }
  if (original !== null) {
    return { ...base, action: "restore", restoredCommand: original, reason: "The original status-line command comes back unchanged." };
  }
  const text = readFileSync(settingsPath, "utf8");
  if (input.record?.createdFile && input.record.wrapperCommand === state.command && text === `{\n  ${statuslineMemberText(state.command, "  ", true)}\n}\n`) {
    return { ...base, action: "delete_file", reason: `staple created ${settingsPath}; it is removed again.` };
  }
  return { ...base, action: "remove_statusline", reason: "There was no status line before; staple's is removed." };
}

/** Take the wrapper out. Returns false when there was nothing of staple's to remove. */
export function uninstallStatusline(input: { configDir: string; record: StatuslineInstall | null; backupDir: string; now: string }): boolean {
  const plan = planStatuslineRemoval(input);
  if (plan.action === "refuse") throw new StapleError("validation", plan.reason, { reason: "statusline_refused", settingsPath: plan.settingsPath });
  if (plan.action === "not_installed") return false;
  const settingsPath = plan.settingsPath;
  if (plan.action === "delete_file") {
    rmSync(settingsPath);
    return true;
  }
  backup(settingsPath, input.backupDir, input.now);
  const parsed = parse(readFileSync(settingsPath, "utf8")) as Parsed;
  const text = parsed.text;
  const line = member(parsed.root, "statusLine")!;
  const commandMember = member(line.value, "command")!;
  const current = text.slice(commandMember.value.start, commandMember.value.end);
  const record = input.record;
  const recorded = record !== null && JSON.stringify(record.wrapperCommand) === current;

  if (plan.action === "restore") {
    // The recorded literal brings back the original's exact escapes; without the record,
    // the wrapper's own copy of the command is written as JSON.
    const literal = recorded && record.originalLiteral !== null ? record.originalLiteral : JSON.stringify(plan.restoredCommand);
    writeSettings(settingsPath, splice(text, commandMember.value.start, commandMember.value.end, literal));
    return true;
  }
  if (recorded && record.insertedText !== null) {
    const at = text.indexOf(record.insertedText);
    if (at >= 0 && text.indexOf(record.insertedText, at + 1) < 0) {
      writeSettings(settingsPath, splice(text, at, at + record.insertedText.length, ""));
      return true;
    }
  }
  const span = memberRemovalSpan(text, parsed.root, line);
  writeSettings(settingsPath, splice(text, span.start, span.end, ""));
  return true;
}
