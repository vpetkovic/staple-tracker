/**
 * Every provider staple can poll. Adding one is a module beside these (a
 * {@link UsagePoller}) and a line here; nothing else learns its name.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { claudePoller } from "./claude.js";
import { codexPoller } from "./codex.js";
import type { SecretReader, UsagePoller } from "./types.js";

export const USAGE_POLLERS: readonly UsagePoller[] = [claudePoller, codexPoller];

/**
 * The real stored sign-ins: the macOS keychain through `/usr/bin/security` (the tool
 * Claude Code itself uses, so its keychain item already allows it without a prompt), and
 * plain files. Any failure reads as "no sign-in": the subprocess's own output and error
 * are never looked at beyond the password it prints, because either could carry it.
 */
export const systemSecrets: SecretReader = {
  async keychain(service, account) {
    // The search list first, as Claude Code reads it; then the user's login keychain by
    // path, which `security` cannot find on its own when HOME is not the user's home.
    const found = await findPassword(["find-generic-password", "-a", account, "-w", "-s", service]);
    if (found !== null) return found;
    const loginKeychain = join(userInfo().homedir, "Library", "Keychains", "login.keychain-db");
    return existsSync(loginKeychain) ? findPassword(["find-generic-password", "-a", account, "-w", "-s", service, loginKeychain]) : null;
  },
  file(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

function findPassword(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("/usr/bin/security", args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
        resolve(error || typeof stdout !== "string" || stdout.trim() === "" ? null : stdout.trim()),
      );
    } catch {
      resolve(null);
    }
  });
}
