/**
 * The macOS launch agent that runs `staple budget collect` every few minutes, in the
 * pattern of the tracker's own deploy watcher: a user LaunchAgent with `StartInterval`,
 * `RunAtLoad`, an explicit `PATH`, and its output in a log file.
 *
 * `launchctl` is reached only through a {@link LaunchctlRunner}, so tests pass a fake
 * and never load anything into the real session. Other platforms have no agent: the
 * collector is portable and the docs give a cron line for it.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { StapleError } from "../../types.js";

export const COLLECT_AGENT_LABEL = "com.staple.budget-collect";
export const DEFAULT_INTERVAL_MINUTES = 5;

export interface LaunchctlResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type LaunchctlRunner = (args: readonly string[]) => LaunchctlResult;

export const realLaunchctl: LaunchctlRunner = (args) => {
  const result = spawnSync("launchctl", [...args], { encoding: "utf8", timeout: 15_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message ?? "") };
};

export interface AgentSpec {
  /** The staple launcher (an absolute path). */
  readonly staple: string;
  /** The node binary whose directory goes on the agent's PATH (the launcher is `#!/usr/bin/env node`). */
  readonly nodePath: string;
  readonly userHome: string;
  /** Set only when the operator's staple home came from `STAPLE_HOME`; otherwise the locator finds it. */
  readonly stapleHomeEnv: string | null;
  readonly intervalMinutes: number;
  readonly logPath: string;
}

/** Where a node is commonly installed when the one setup ran under is gone. */
export const FALLBACK_NODE_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The PATH a plist staple wrote gives its agent, or null when it cannot be read. */
export function plistPathEnv(plistPath: string): string | null {
  try {
    const match = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(readFileSync(plistPath, "utf8"));
    return match ? match[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"') : null;
  } catch {
    return null;
  }
}

/** The first executable `node` on a PATH string, or null. */
export function nodeOnPath(path: string): string | null {
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function agentPlist(spec: AgentSpec): string {
  // The node setup ran under first (an nvm install, say), then the usual system homes of
  // a node, so the launcher's `#!/usr/bin/env node` still finds one after that version
  // is removed. `budget status` reports watcher_node_missing when none of them has one.
  const path = [dirname(spec.nodePath), ...FALLBACK_NODE_DIRS, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((dir, i, all) => all.indexOf(dir) === i).join(":");
  const env = [
    `    <key>PATH</key><string>${xml(path)}</string>`,
    `    <key>HOME</key><string>${xml(spec.userHome)}</string>`,
    ...(spec.stapleHomeEnv !== null ? [`    <key>STAPLE_HOME</key><string>${xml(spec.stapleHomeEnv)}</string>`] : []),
  ];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${COLLECT_AGENT_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[spec.staple, "budget", "collect", "--quiet"].map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env,
    `  </dict>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>StartInterval</key><integer>${Math.round(spec.intervalMinutes * 60)}</integer>`,
    `  <key>ProcessType</key><string>Background</string>`,
    `  <key>LowPriorityIO</key><true/>`,
    `  <key>WorkingDirectory</key><string>${xml(spec.userHome)}</string>`,
    `  <key>StandardOutPath</key><string>${xml(spec.logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(spec.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** The interval a plist staple wrote runs at, in minutes, or null when it cannot be read. */
export function plistIntervalMinutes(plistPath: string): number | null {
  try {
    const match = /<key>StartInterval<\/key><integer>(\d+)<\/integer>/.exec(readFileSync(plistPath, "utf8"));
    return match ? Number(match[1]) / 60 : null;
  } catch {
    return null;
  }
}

export function agentPlistPath(launchAgentsDir: string): string {
  return join(launchAgentsDir, `${COLLECT_AGENT_LABEL}.plist`);
}

const domain = (uid: number): string => `gui/${uid}`;

/**
 * The agent launchd has loaded under staple's label, if any, and the plist it was loaded
 * from. The label is per user, not per staple home: a scratch home (a test, a second
 * home) must never unload or replace the agent another home installed, so every load and
 * unload below checks the path first.
 */
export function loadedAgent(input: { uid: number; launchctl: LaunchctlRunner }): { path: string | null } | null {
  const printed = input.launchctl(["print", `${domain(input.uid)}/${COLLECT_AGENT_LABEL}`]);
  if (printed.status !== 0) return null;
  const match = /^\s*path = (.+)$/m.exec(printed.stdout);
  return { path: match ? match[1]!.trim() : null };
}

/** A path with symlinks resolved as far as it exists, so `/var/…` and `/private/var/…` compare equal. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

export function samePlist(a: string | null, b: string): boolean {
  return a !== null && canonical(a) === canonical(b);
}

/** Whether THIS plist is the one loaded. */
export function agentLoaded(input: { uid: number; launchctl: LaunchctlRunner; plistPath: string }): boolean {
  const loaded = loadedAgent(input);
  return loaded !== null && samePlist(loaded.path, input.plistPath);
}

/** The plist another staple home's agent was loaded from, when one holds the label; else null. */
export function foreignAgent(input: { uid: number; launchctl: LaunchctlRunner; plistPath: string }): { path: string | null } | null {
  const loaded = loadedAgent(input);
  return loaded !== null && !samePlist(loaded.path, input.plistPath) ? loaded : null;
}

/** The refusal for a label another home holds, naming the command that frees it. */
export function foreignAgentMessage(uid: number, loadedFrom: string | null, plistPath: string): string {
  return (
    `launchd already runs ${COLLECT_AGENT_LABEL} from ${loadedFrom ?? "an unknown plist"}, not ${plistPath}: another staple home's watcher. ` +
    `Remove it from that home (staple budget unsetup --yes there), or unload it with \`launchctl bootout ${domain(uid)}/${COLLECT_AGENT_LABEL}\`, then run setup again.`
  );
}

function refuseForeign(input: { uid: number; launchctl: LaunchctlRunner; plistPath: string }): void {
  const foreign = foreignAgent(input);
  if (foreign !== null) {
    throw new StapleError("conflict", foreignAgentMessage(input.uid, foreign.path, input.plistPath), { reason: "foreign_agent", loadedFrom: foreign.path });
  }
}

/** Write the plist and (re)load it. The previous instance is booted out first, so a changed plist takes effect. */
export function installAgent(input: { plistPath: string; plist: string; uid: number; launchctl: LaunchctlRunner }): void {
  refuseForeign(input);
  writeFileAtomic(input.plistPath, input.plist, { mode: 0o644 });
  input.launchctl(["bootout", `${domain(input.uid)}/${COLLECT_AGENT_LABEL}`]);
  const loaded = input.launchctl(["bootstrap", domain(input.uid), input.plistPath]);
  if (loaded.status !== 0) {
    throw new StapleError("conflict", `launchctl bootstrap ${domain(input.uid)} ${input.plistPath} failed (${loaded.status}): ${(loaded.stderr || loaded.stdout).trim()}`);
  }
}

/** Unload the agent (only when it runs from this plist) and delete the plist. True when there was anything to remove. */
export function uninstallAgent(input: { plistPath: string; uid: number; launchctl: LaunchctlRunner }): boolean {
  const wasLoaded = agentLoaded(input);
  if (wasLoaded) input.launchctl(["bootout", `${domain(input.uid)}/${COLLECT_AGENT_LABEL}`]);
  const present = existsSync(input.plistPath);
  if (present) rmSync(input.plistPath);
  return wasLoaded || present;
}

/** The line a non-macOS machine adds with `crontab -e` for the same schedule. */
export function cronLine(staple: string, intervalMinutes: number): string {
  const every = Math.max(1, Math.round(intervalMinutes));
  return `*/${every} * * * * ${staple.includes(" ") ? `'${staple}'` : staple} budget collect --quiet`;
}
