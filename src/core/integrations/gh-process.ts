import { execFile } from "node:child_process";
import { StapleError } from "../types.js";
import type { ProviderReadOptions } from "./contracts.js";

export type GhCommand = { kind: "version" } | { kind: "auth-status" } | { kind: "get"; host: string; endpoint: string };
export type GhRunner = (command: GhCommand, options?: ProviderReadOptions) => Promise<string>;

/** Only version, auth status and fixed GET requests are supported. No shell, token extraction or auth changes. */
export function createGhRunner(settings: {
  executable?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
} = {}): GhRunner {
  return async (command, options) => {
    options?.signal?.throwIfAborted();
    const args = command.kind === "version" ? ["--version"] : command.kind === "auth-status" ? ["auth", "status"] : apiArgs(command);
    const env = { ...(settings.env ?? process.env), GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat" };
    // gh honors GH_TOKEN before GITHUB_TOKEN, and the Enterprise equivalents on
    // other hosts. Preserve that behavior; GET /user checks the effective account.
    delete (env as NodeJS.ProcessEnv).GH_DEBUG;
    return new Promise<string>((resolve, reject) => {
      execFile(settings.executable ?? "gh", args, {
        env, encoding: "utf8", shell: false, windowsHide: true,
        timeout: settings.timeoutMs ?? 20_000, maxBuffer: settings.maxBytes ?? 4 * 1024 * 1024,
        signal: options?.signal, killSignal: "SIGKILL",
      }, (error, stdout, stderr) => {
        if (options?.signal?.aborted) return reject(options.signal.reason);
        if (!error) return resolve(command.kind === "auth-status" ? `${stdout}\n${stderr}` : stdout);
        // Never expose the child error: it embeds command output and may contain
        // remote bodies, private repository names or inherited authentication.
        if (error.code === "ENOENT") return reject(new StapleError("unavailable", "Install GitHub CLI on this machine", { reason: "missing_cli" }));
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new StapleError("unavailable", "GitHub CLI response exceeded the size limit", { reason: "output_limit" }));
        if (error.killed) return reject(new StapleError("unavailable", "GitHub CLI timed out; try again", { reason: "timeout" }));
        // gh exits 1 when any host is signed out; the per-host report is still the answer.
        // Older gh prints it on stderr. Tokens appear only masked, and callers parse logins only.
        if (command.kind === "auth-status") return resolve(`${stdout}\n${stderr}`);
        reject(providerFailure(stdout, stderr));
      });
    });
  };
}

function apiArgs(command: Extract<GhCommand, { kind: "get" }>): string[] {
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(command.host)
    || !/^(?:user(?:\/repos)?|repositories\/[1-9][0-9]*|repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/issues\/[1-9][0-9]*|\/pulls(?:\/[1-9][0-9]*)?|\/commits\/[0-9a-f]{40,64}\/(?:check-runs|status))?|search\/issues)(?:\?[^\s#]*)?$/.test(command.endpoint)) {
    throw new StapleError("validation", "Unsupported GitHub read request");
  }
  return ["api", "--hostname", command.host, "--method", "GET", "--include", "--header", "Accept: application/vnd.github+json", command.endpoint];
}

function providerFailure(stdout: string, stderr: string): StapleError {
  const status = Number(/^HTTP\/\S+\s+(\d+)/m.exec(stdout)?.[1] ?? /HTTP (\d{3})/.exec(stderr)?.[1]);
  const retry = Number(/^retry-after:\s*(\d+)\s*$/im.exec(stdout)?.[1]);
  if (status === 429 || (status === 403 && (/^x-ratelimit-remaining:\s*0\s*$/im.test(stdout) || /rate limit|secondary rate/i.test(stderr + stdout) || retry > 0))) {
    const reset = Number(/^x-ratelimit-reset:\s*(\d+)\s*$/im.exec(stdout)?.[1]);
    const retryAfterSeconds = retry > 0 ? retry : reset > 0 ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
    return new StapleError("rate_limited", "GitHub rate limit reached; try again later", { retryAfterSeconds });
  }
  if (status === 401 || /gh auth login|not logged|authentication required|GH_TOKEN.*environment variable/i.test(stderr)) return new StapleError("auth", "Sign in to GitHub CLI on this machine for the configured host");
  if (status === 403) return new StapleError("forbidden", "GitHub denied access; check repository permissions and organization SSO");
  if (status === 404) return new StapleError("not_found", "GitHub resource is unavailable or not accessible");
  if (/dial tcp|no such host|connection refused|network is unreachable|TLS handshake|could not resolve/i.test(stderr)) return new StapleError("offline", "Cannot reach the configured GitHub host");
  return new StapleError("unavailable", "GitHub CLI could not complete the read; check the connection and try again");
}
