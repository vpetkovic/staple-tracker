/**
 * Each agent CLI's stop-hook contract, as its own documentation states it (docs/runs.md,
 * "Interactive sessions: stop hooks", has the survey, the links and the quotes). A
 * provider is a row: how to read its stdin payload into a {@link StopEvent}, how to write
 * a {@link HookVerdict} back in the form it obeys, which variable (if any) carries its
 * session id into the agent's tool shells for `run hook bind`, and where and how its
 * settings install the hook. The decision itself is `run-hook.ts`'s, the same for all.
 *
 * Every row answers with exit 0 and JSON (or nothing). A hook that fails must let the
 * session stop, and exit 2 is a block for most of these CLIs whatever the output says, so
 * the adapter never leaves the exit code to chance: errors become an allow.
 *
 * Only a row whose CLI documents a hook that can keep the turn going is here. The survey
 * lists the ones that cannot (Aider, Cline, Windsurf) and the ones that need an in-process
 * plugin rather than a command (Amp, OpenCode); those use `run drive` or the instructions.
 */
import { join } from "node:path";
import { userHome } from "../config/home.js";
import type { HookVerdict, StopEvent } from "./run-hook.js";
import { StapleError } from "./types.js";

export interface HookOutput {
  stdout: string;
  exitCode: 0;
}

export type HookInstallScope = "user" | "project" | "local";
export const HOOK_INSTALL_SCOPES: readonly HookInstallScope[] = ["user", "project", "local"];

export interface HookProvider {
  /** `--provider <name>`, `run hook install <name>`, and the binding's file prefix. */
  name: string;
  /** The CLI, as the docs name it. */
  label: string;
  /** The hook verb: `staple run hook <command>`. */
  command: string;
  /** The event the hook is installed on, in the settings file. */
  event: string;
  /** The variable the CLI exports to the agent's shell commands with the session id; null when none is documented. */
  sessionEnv: string | null;
  /** The payload as the decision reads it; null when it is not a turn-ending event of the main agent. */
  parse(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): StopEvent | null;
  render(verdict: HookVerdict): HookOutput;
  /** The settings file of each scope it has; null for a scope it does not. */
  settingsPath(scope: HookInstallScope, projectDir: string, env: NodeJS.ProcessEnv): string | null;
  /** Keys from the file's root to the event's array of hook groups. */
  eventPath: readonly string[];
  /** Members a new file needs besides the hooks (`{version: 1}`). */
  fileBase: Record<string, unknown>;
  /** One entry of the event's array, running `command`. */
  entry(command: string): Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function envValue(env: NodeJS.ProcessEnv, key: string | null): string | null {
  if (key === null) return null;
  const value = (env[key] ?? "").trim();
  return value === "" ? null : value;
}

function home(env: NodeJS.ProcessEnv, variable: string | null, dir: string): string {
  return envValue(env, variable) ?? join(userHome(), dir);
}

/**
 * The answer every CLI with Claude Code's Stop contract reads: `{"decision":"block",
 * "reason"}` keeps the turn going with the reason as the next prompt; nothing lets it
 * stop. `systemMessage` is shown to the person where the CLI documents it.
 */
function claudeShapedRender(withMessage: boolean): (verdict: HookVerdict) => HookOutput {
  return (verdict) => {
    if (verdict.action === "block") return { stdout: `${JSON.stringify({ decision: "block", reason: verdict.reason })}\n`, exitCode: 0 };
    if (!withMessage || verdict.message === null) return { stdout: "", exitCode: 0 };
    return { stdout: `${JSON.stringify({ systemMessage: verdict.message })}\n`, exitCode: 0 };
  };
}

/** A Stop payload with Claude Code's field names; `event` is the `hook_event_name` it must carry. */
function claudeShapedParse(event: string, sessionEnv: string | null): HookProvider["parse"] {
  return (payload, env) => {
    const name = stringField(payload, "hook_event_name");
    if (name !== null && name !== event) return null;
    return {
      session: stringField(payload, "session_id") ?? envValue(env, sessionEnv),
      cwd: stringField(payload, "cwd"),
      continuing: payload.stop_hook_active === true,
      subagent: stringField(payload, "agent_id") !== null,
    };
  };
}

const commandEntry = (timeout: number) => (command: string) => ({ hooks: [{ type: "command", command, timeout }] });

/**
 * Claude Code, `Stop` (https://code.claude.com/docs/en/hooks#stop). stdin: `session_id`,
 * `cwd`, `hook_event_name`, `stop_hook_active` ("true when Claude Code is already
 * continuing as a result of a stop hook"), `agent_id` ("present only when the hook fires
 * inside a subagent call"). `systemMessage` is a "warning message shown to the user".
 * Claude Code itself caps consecutive continuations at 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
 * `CLAUDE_CODE_SESSION_ID` is "set automatically to the current session ID in Bash …
 * tool subprocesses [and] hook command subprocesses".
 */
const claude: HookProvider = {
  name: "claude",
  label: "Claude Code",
  command: "claude-stop",
  event: "Stop",
  sessionEnv: "CLAUDE_CODE_SESSION_ID",
  parse: claudeShapedParse("Stop", "CLAUDE_CODE_SESSION_ID"),
  render: claudeShapedRender(true),
  settingsPath(scope, projectDir, env) {
    if (scope === "user") return join(home(env, "CLAUDE_CONFIG_DIR", ".claude"), "settings.json");
    return join(projectDir, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
  },
  eventPath: ["hooks", "Stop"],
  fileBase: {},
  entry: commandEntry(60),
};

/**
 * OpenAI Codex CLI, `Stop` (https://developers.openai.com/codex/hooks). The same payload
 * and answer as Claude Code: "To keep Codex going, return {"decision": "block", "reason":
 * …}", which "creates a new continuation prompt"; `stop_hook_active` is "whether this
 * turn was already continued by Stop"; `systemMessage` is "surfaced as a warning". Files:
 * `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`; a new or changed hook runs only
 * after it is trusted in `/hooks`. No session variable is documented for tool shells.
 */
const codex: HookProvider = {
  name: "codex",
  label: "Codex CLI",
  command: "codex-stop",
  event: "Stop",
  sessionEnv: null,
  parse: claudeShapedParse("Stop", null),
  render: claudeShapedRender(true),
  settingsPath(scope, projectDir, env) {
    if (scope === "local") return null;
    return scope === "user" ? join(home(env, "CODEX_HOME", ".codex"), "hooks.json") : join(projectDir, ".codex", "hooks.json");
  },
  eventPath: ["hooks", "Stop"],
  fileBase: {},
  entry: commandEntry(60),
};

/**
 * Gemini CLI, `AfterAgent` (https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md):
 * "decision: Set to "deny" to reject the response and force a retry", with `reason` "sent
 * to the agent as a new prompt"; `stop_hook_active` "indicates if this hook is already
 * running as part of a retry sequence"; `systemMessage` is "displayed immediately to the
 * user"; stdout must be JSON only. `timeout` is in milliseconds. `GEMINI_SESSION_ID` is
 * documented for hooks' environment only.
 */
const gemini: HookProvider = {
  name: "gemini",
  label: "Gemini CLI",
  command: "gemini-stop",
  event: "AfterAgent",
  sessionEnv: "GEMINI_SESSION_ID",
  parse: claudeShapedParse("AfterAgent", "GEMINI_SESSION_ID"),
  render(verdict) {
    if (verdict.action === "block") return { stdout: `${JSON.stringify({ decision: "deny", reason: verdict.reason })}\n`, exitCode: 0 };
    return { stdout: `${JSON.stringify(verdict.message === null ? { decision: "allow" } : { decision: "allow", systemMessage: verdict.message })}\n`, exitCode: 0 };
  },
  settingsPath(scope, projectDir) {
    if (scope === "local") return null;
    return scope === "user" ? join(userHome(), ".gemini", "settings.json") : join(projectDir, ".gemini", "settings.json");
  },
  eventPath: ["hooks", "AfterAgent"],
  fileBase: {},
  entry: (command) => ({ matcher: "*", hooks: [{ name: "staple-autopilot", type: "command", command, timeout: 60_000 }] }),
};

/**
 * Cursor (editor and CLI), `stop` (https://cursor.com/docs/hooks): input `status`
 * ("completed" | "aborted" | "error") and `loop_count` ("how many times the stop hook has
 * already triggered an automatic follow-up for this conversation"), the session is
 * `conversation_id`, the project `workspace_roots`. Output `followup_message`: "Cursor will
 * automatically submit it as the next user message". Its own cap, `loop_limit`, defaults
 * to 5; the stanza lifts it and staple's guards bound the loop. No user-facing message is
 * documented for `stop`.
 */
const cursor: HookProvider = {
  name: "cursor",
  label: "Cursor",
  command: "cursor-stop",
  event: "stop",
  sessionEnv: null,
  parse(payload) {
    const name = stringField(payload, "hook_event_name");
    if (name !== null && name !== "stop") return null;
    // A person's abort, or an error, ends the loop: never answer it with more work.
    const status = stringField(payload, "status");
    if (status !== null && status !== "completed") return null;
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.filter((root): root is string => typeof root === "string") : [];
    return {
      session: stringField(payload, "conversation_id"),
      cwd: roots[0] ?? null,
      continuing: typeof payload.loop_count === "number" && payload.loop_count > 0,
      subagent: false,
    };
  },
  render(verdict) {
    return { stdout: `${JSON.stringify(verdict.action === "block" ? { followup_message: verdict.reason } : {})}\n`, exitCode: 0 };
  },
  settingsPath(scope, projectDir) {
    if (scope === "local") return null;
    return scope === "user" ? join(userHome(), ".cursor", "hooks.json") : join(projectDir, ".cursor", "hooks.json");
  },
  eventPath: ["hooks", "stop"],
  fileBase: { version: 1 },
  entry: (command) => ({ command, timeout: 60, loop_limit: null }),
};

/**
 * GitHub Copilot CLI, `agentStop` (https://docs.github.com/en/copilot/reference/hooks-configuration):
 * input `sessionId`, `cwd`, `stop_hook_active` ("true when this turn was already forced to
 * continue by a prior "block" decision from this hook"); output `decision` "block" "forces
 * another agent turn using reason as the prompt". Exit 2 does not block here, JSON does.
 * It ends the turn itself after 8 blocks in a row. Files: `~/.copilot/hooks/*.json`
 * (`$COPILOT_HOME/hooks/`) and `.github/hooks/*.json`.
 */
const copilot: HookProvider = {
  name: "copilot",
  label: "GitHub Copilot CLI",
  command: "copilot-stop",
  event: "agentStop",
  sessionEnv: null,
  parse(payload) {
    const name = stringField(payload, "hook_event_name");
    if (name !== null && name !== "Stop" && name !== "agentStop") return null;
    return {
      session: stringField(payload, "sessionId") ?? stringField(payload, "session_id"),
      cwd: stringField(payload, "cwd"),
      continuing: payload.stop_hook_active === true,
      subagent: false,
    };
  },
  render: claudeShapedRender(false),
  settingsPath(scope, projectDir, env) {
    if (scope === "local") return null;
    return scope === "user" ? join(home(env, "COPILOT_HOME", ".copilot"), "hooks", "staple-autopilot.json") : join(projectDir, ".github", "hooks", "staple-autopilot.json");
  },
  eventPath: ["hooks", "agentStop"],
  fileBase: { version: 1 },
  entry: (command) => ({ type: "command", bash: command, timeoutSec: 60 }),
};

/**
 * Factory Droid, `Stop` (https://docs.factory.ai/reference/hooks-reference): Claude Code's
 * payload (`session_id`, `cwd`, `stop_hook_active`) and answer ("decision: "block"
 * prevents stopping. Include reason so Droid knows what to do next"). Files:
 * `~/.factory/hooks.json` and `.factory/hooks.json`, keyed directly by event name.
 */
const droid: HookProvider = {
  name: "droid",
  label: "Factory Droid",
  command: "droid-stop",
  event: "Stop",
  sessionEnv: null,
  parse: claudeShapedParse("Stop", null),
  render: claudeShapedRender(false),
  settingsPath(scope, projectDir) {
    if (scope === "local") return null;
    return scope === "user" ? join(userHome(), ".factory", "hooks.json") : join(projectDir, ".factory", "hooks.json");
  },
  eventPath: ["Stop"],
  fileBase: {},
  entry: commandEntry(60),
};

/**
 * Qwen Code, `Stop` (https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md):
 * Claude Code's payload and answer; it ends the turn itself after 8 blocks
 * (`QWEN_CODE_STOP_HOOK_BLOCK_CAP`). Files: `~/.qwen/settings.json`, `.qwen/settings.json`.
 */
const qwen: HookProvider = {
  name: "qwen",
  label: "Qwen Code",
  command: "qwen-stop",
  event: "Stop",
  sessionEnv: null,
  parse: claudeShapedParse("Stop", null),
  render: claudeShapedRender(false),
  settingsPath(scope, projectDir) {
    if (scope === "local") return null;
    return scope === "user" ? join(userHome(), ".qwen", "settings.json") : join(projectDir, ".qwen", "settings.json");
  },
  eventPath: ["hooks", "Stop"],
  fileBase: {},
  entry: commandEntry(60),
};

export const HOOK_PROVIDERS: Readonly<Record<string, HookProvider>> = { claude, codex, gemini, cursor, copilot, droid, qwen };

/** The provider whose hook verb is `command` (`claude-stop`), or null. */
export function providerByCommand(command: string): HookProvider | null {
  return Object.values(HOOK_PROVIDERS).find((provider) => provider.command === command) ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings object that installs `command`, as a new file would hold it. */
export function hookStanza(provider: HookProvider, command: string): Record<string, unknown> {
  return mergeHook(provider, {}, command)!;
}

/** Every string inside `value`, however deep. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isObject(value)) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Whether a settings entry is this provider's staple hook: a command that is exactly
 * `command`, or any staple executable followed by exactly `run hook <verb>` (a hook installed
 * with another `--staple`). `run hook claude-stop-old`, or the verb with arguments after it,
 * is somebody else's.
 */
function isStapleHook(provider: HookProvider, entry: unknown, command: string): boolean {
  return strings(entry).some((text) => {
    if (text.trim() === command) return true;
    const words = text.trim().split(/\s+/);
    return words.length === 4 && words[1] === "run" && words[2] === "hook" && words[3] === provider.command;
  });
}

/**
 * `settings` with the hook added under {@link HookProvider.eventPath}, every other member
 * kept; null when this provider's staple hook is already there ({@link isStapleHook}), so
 * installing twice changes nothing. A member on the way that is not what the CLI expects
 * (an object, then an array of entries) is refused rather than replaced.
 */
export function mergeHook(provider: HookProvider, settings: Record<string, unknown>, command: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = { ...provider.fileBase, ...settings };
  let parent = root;
  const path: string[] = [];
  for (const key of provider.eventPath.slice(0, -1)) {
    path.push(key);
    if (parent[key] !== undefined && !isObject(parent[key])) {
      throw new StapleError("validation", `"${path.join(".")}" in the settings is ${describe(parent[key])}, not an object; nothing was written. Fix it by hand, or add the hook yourself (staple run hook install ${provider.name} --print).`);
    }
    const next = { ...((parent[key] as Record<string, unknown> | undefined) ?? {}) };
    parent[key] = next;
    parent = next;
  }
  const last = provider.eventPath[provider.eventPath.length - 1]!;
  path.push(last);
  if (parent[last] !== undefined && !Array.isArray(parent[last])) {
    throw new StapleError("validation", `"${path.join(".")}" in the settings is ${describe(parent[last])}, not an array; nothing was written. Fix it by hand, or add the hook yourself (staple run hook install ${provider.name} --print).`);
  }
  const entries = (parent[last] as unknown[] | undefined) ?? [];
  if (entries.some((entry) => isStapleHook(provider, entry, command))) return null;
  parent[last] = [...entries, provider.entry(command)];
  return root;
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
}
