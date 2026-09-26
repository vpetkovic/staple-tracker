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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function agentPlist(spec: AgentSpec): string {
  const path = [dirname(spec.nodePath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((dir, i, all) => all.indexOf(dir) === i).join(":");
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

/** Whether THIS plist is the one loaded. */
export function agentLoaded(input: { uid: number; launchctl: LaunchctlRunner; plistPath: string }): boolean {
  return loadedAgent(input)?.path === input.plistPath;
}

function refuseForeign(input: { uid: number; launchctl: LaunchctlRunner; plistPath: string }): void {
  const loaded = loadedAgent(input);
  if (loaded !== null && loaded.path !== input.plistPath) {
    throw new StapleError(
      "conflict",
      `launchd already runs ${COLLECT_AGENT_LABEL} from ${loaded.path ?? "an unknown plist"}, not ${input.plistPath}: another staple home's watcher. Remove it from that home (staple budget unsetup --yes) first.`,
      { reason: "foreign_agent", loadedFrom: loaded.path },
    );
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
