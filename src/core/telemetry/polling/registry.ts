/**
 * Every provider staple can poll. Adding one is a module beside these (a
 * {@link UsagePoller}) and a line here; nothing else learns its name.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { claudePoller } from "./claude.js";
import { codexPoller } from "./codex.js";
import type { SecretReader, UsagePoller } from "./types.js";

export const USAGE_POLLERS: readonly UsagePoller[] = [claudePoller, codexPoller];

/** Runs `/usr/bin/security` with these arguments; the password it prints, or null. */
export type SecurityRunner = (args: readonly string[]) => Promise<string | null>;

/**
 * Stored sign-ins read the way their own tools read them. The keychain through
 * `/usr/bin/security` (the tool Claude Code itself uses, so its item already allows it
 * without a prompt), searching the keychain list of the environment staple runs in and
 * nothing else: with HOME pointed elsewhere, `security` finds no login keychain, exactly as
 * Claude Code would not, and the directory's own `.credentials.json` is used instead
 * (`claude.ts`). Never a keychain named by path, which would hand one environment the
 * sign-in of another. Plain files as they are. Any failure reads as "no sign-in": the
 * subprocess's own output and error are never looked at beyond the password it prints,
 * because either could carry it.
 */
export function createSystemSecrets(run: SecurityRunner = runSecurity): SecretReader {
  return {
    keychain: (service, account) => run(["find-generic-password", "-a", account, "-w", "-s", service]),
    file(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export const systemSecrets: SecretReader = createSystemSecrets();

function runSecurity(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/security", [...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
        resolve(error || typeof stdout !== "string" || stdout.trim() === "" ? null : stdout.trim()),
      );
    } catch {
      resolve(null);
    }
  });
}
