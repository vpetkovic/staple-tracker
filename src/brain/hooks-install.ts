/**
 * The brain's hooks in an agent CLI's config home: whether they are there, and putting them
 * in or taking them out. Machine-local by nature: a hook is a line in this computer's
 * settings file and means nothing anywhere else.
 *
 * Claude Code reads `<CLAUDE_CONFIG_DIR>/settings.json`; Codex reads `<CODEX_HOME>/hooks.json`.
 * Both take the same shape under `hooks.<Event>`: groups of `{ type: "command", command }`.
 *
 * PROOF-OF-CONCEPT GUARD: this module only ever writes a config home named explicitly by
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and refuses one that is the user's real default
 * (`~/.claude`, `~/.codex` under the OS user's home). An install into a person's everyday
 * agent setup is a decision for a person at a terminal, not a button in a preview.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StapleError } from "../core/types.js";

export const HOOK_AGENTS = ["claude", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const COMMAND_OF: Record<HookEvent, string> = { SessionStart: "context", UserPromptSubmit: "turn", Stop: "stop" };
/** What marks an entry as the brain's own, so remove takes out exactly what install put in. */
const MARKER = "brain.mjs";

export interface HookTarget {
  agent: HookAgent;
  label: string;
  /** The config home, or null when none is set for this POC. */
  home: string | null;
  /** The settings file inside it. */
  file: string | null;
  /** Why the target cannot be written, when it cannot. */
  refusal: string | null;
}

export interface HookStatus extends HookTarget {
  events: Record<HookEvent, boolean>;
}

function realHome(agent: HookAgent): string {
  return join(userInfo().homedir, agent === "claude" ? ".claude" : ".codex");
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function hookTarget(agent: HookAgent, env: NodeJS.ProcessEnv = process.env): HookTarget {
  const variable = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const home = env[variable]?.trim() ? resolve(env[variable]!) : null;
  if (!home) {
    return { agent, label, home: null, file: null, refusal: `${variable} is not set, so there is no isolated config home to install into.` };
  }
  if (canonical(home) === canonical(realHome(agent))) {
    return { agent, label, home, file: null, refusal: `${variable} points at your real ${label} home; this preview only installs into an isolated one.` };
  }
  return { agent, label, home, file: join(home, agent === "claude" ? "settings.json" : "hooks.json"), refusal: null };
}

type HookFile = { hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>> } & Record<string, unknown>;

function readHookFile(file: string): HookFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as HookFile) : {};
  } catch {
    throw new StapleError("validation", `${file} is not valid JSON; fix or remove it first.`);
  }
}

const isBrainGroup = (group: { hooks?: Array<{ command?: string }> }) => (group.hooks ?? []).some((h) => (h.command ?? "").includes(MARKER));

export function hookStatus(agent: HookAgent, env: NodeJS.ProcessEnv = process.env): HookStatus {
  const target = hookTarget(agent, env);
  const events = Object.fromEntries(HOOK_EVENTS.map((e) => [e, false])) as Record<HookEvent, boolean>;
  if (target.file && existsSync(target.file)) {
    let file: HookFile = {};
    try {
      file = readHookFile(target.file);
    } catch {
      file = {};
    }
    for (const event of HOOK_EVENTS) events[event] = (file.hooks?.[event] ?? []).some(isBrainGroup);
  }
  return { ...target, events };
}

/** The command a hook runs: this build's bundled brain entry, against this brain. */
export function hookCommand(agent: HookAgent, event: HookEvent, bundle: string, brainDb: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `NODE_NO_WARNINGS=1 STAPLE_BRAIN_DB=${q(brainDb)} ${q(process.execPath)} ${q(bundle)} ${COMMAND_OF[event]} --hook --provider ${agent}`;
}

export function installHooks(agent: HookAgent, bundle: string, brainDb: string, env: NodeJS.ProcessEnv = process.env): HookStatus {
  const target = hookTarget(agent, env);
  if (!target.file) throw new StapleError("validation", target.refusal ?? "No config home.");
  if (!existsSync(bundle)) throw new StapleError("not_found", `The hook bundle is missing at ${bundle}; build it with \`npx tsx scripts/build-brain.ts\`.`);
  const file = readHookFile(target.file);
  const hooks = (file.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).filter((g) => !isBrainGroup(g));
    groups.push({ hooks: [{ type: "command", command: hookCommand(agent, event, bundle, brainDb), timeout: event === "UserPromptSubmit" ? 5 : 10 } as never] });
    hooks[event] = groups;
  }
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, `${JSON.stringify(file, null, 2)}\n`);
  return hookStatus(agent, env);
}

export function removeHooks(agent: HookAgent, env: NodeJS.ProcessEnv = process.env): HookStatus {
  const target = hookTarget(agent, env);
  if (!target.file) throw new StapleError("validation", target.refusal ?? "No config home.");
  if (!existsSync(target.file)) return hookStatus(agent, env);
  const file = readHookFile(target.file);
  for (const event of HOOK_EVENTS) {
    const kept = (file.hooks?.[event] ?? []).filter((g) => !isBrainGroup(g));
    if (file.hooks) {
      if (kept.length) file.hooks[event] = kept;
      else delete file.hooks[event];
    }
  }
  writeFileSync(target.file, `${JSON.stringify(file, null, 2)}\n`);
  return hookStatus(agent, env);
}
