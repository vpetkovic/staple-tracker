import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGhRunner } from "../src/core/integrations/gh-process.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function runner(source: string, settings: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "staple-gh-process-"));
  directories.push(dir);
  const executable = join(dir, "fake-gh");
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return createGhRunner({ executable, ...settings });
}
const read = { kind: "get" as const, host: "github.example.com", endpoint: "user" };

describe("bounded GitHub CLI process", () => {
  it("executes fixed GET arguments without a shell, preserves gh token precedence inputs and suppresses debug/prompts", async () => {
    const run = runner("console.log(JSON.stringify({args:process.argv.slice(2),env:process.env}))", {
      env: { GH_TOKEN: "test-primary", GITHUB_TOKEN: "test-fallback", GH_ENTERPRISE_TOKEN: "test-enterprise", GH_DEBUG: "api" },
    });
    const result = JSON.parse(await run(read));
    expect(result.args).toEqual(["api", "--hostname", "github.example.com", "--method", "GET", "--include", "--header", "Accept: application/vnd.github+json", "user"]);
    expect(result.env).toMatchObject({ GH_TOKEN: "test-primary", GITHUB_TOKEN: "test-fallback", GH_ENTERPRISE_TOKEN: "test-enterprise", GH_PROMPT_DISABLED: "1" });
    expect(result.env.GH_DEBUG).toBeUndefined();
  });

  it("reads auth status as text even when gh exits non-zero because another host is signed out", async () => {
    const status = "github.com\n  ✓ Logged in to github.com account alice (keyring)\n";
    const run = runner(`console.log(JSON.stringify(process.argv.slice(2)));process.stderr.write(${JSON.stringify(status)});process.exit(1)`);
    const output = await run({ kind: "auth-status" });
    expect(output).toContain(JSON.stringify(["auth", "status"]));
    expect(output).toContain("Logged in to github.com account alice");
    const missing = createGhRunner({ executable: join(tmpdir(), "missing-gh-binary-for-staple-test") });
    await expect(missing({ kind: "auth-status" })).rejects.toMatchObject({ code: "unavailable", detail: { reason: "missing_cli" } });
  });

  it("rejects arbitrary endpoints and hosts before execution", async () => {
    const run = runner("console.log('should not run')");
    for (const endpoint of ["https://evil.test/user", "../auth/token", "graphql", "repos/a/b/issues/1;touch x", "-XPOST"])
      await expect(run({ ...read, endpoint })).rejects.toMatchObject({ code: "validation" });
    await expect(run({ ...read, host: "evil.test/path" })).rejects.toMatchObject({ code: "validation" });
  });

  it.each([
    [401, "", "auth"], [403, "", "forbidden"], [404, "", "not_found"],
    [429, "Retry-After: 15\r\n", "rate_limited"], [403, "X-RateLimit-Remaining: 0\r\n", "rate_limited"],
    [503, "", "unavailable"],
  ])("maps HTTP %s without leaking raw output", async (status, headers, code) => {
    const raw = `HTTP/2.0 ${status} Error\r\n${headers}\r\nprivate-test-secret`;
    const run = runner(`process.stdout.write(${JSON.stringify(raw)});process.stderr.write('private-test-secret');process.exit(1)`);
    const error = await run(read).catch(error => error);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain("private-test-secret");
    if (status === 429) expect(error.detail).toEqual({ retryAfterSeconds: 15 });
  });

  it("classifies a missing binary and network failures without leaking child diagnostics", async () => {
    const missing = createGhRunner({ executable: join(tmpdir(), "missing-gh-binary-for-staple-test") });
    await expect(missing(read)).rejects.toMatchObject({ code: "unavailable", detail: { reason: "missing_cli" } });
    const offline = runner("process.stderr.write('dial tcp: private hostname');process.exit(1)");
    await expect(offline(read)).rejects.toMatchObject({ code: "offline" });
  });

  it("bounds stdout and stderr and terminates a hung process", async () => {
    for (const stream of ["stdout", "stderr"]) {
      const run = runner(`process.${stream}.write('x'.repeat(5000))`, { maxBytes: 100 });
      await expect(run(read)).rejects.toMatchObject({ code: "unavailable", detail: { reason: "output_limit" } });
    }
    const run = runner("setInterval(()=>{},1000)", { timeoutMs: 100 });
    await expect(run(read)).rejects.toMatchObject({ code: "unavailable", detail: { reason: "timeout" } });
  });

  it("preserves the caller's cancellation reason before and during execution", async () => {
    const run = runner("setInterval(()=>{},1000)");
    const before = AbortSignal.abort(new Error("cancelled before"));
    await expect(run(read, { signal: before })).rejects.toBe(before.reason);
    const controller = new AbortController();
    const pending = run(read, { signal: controller.signal });
    controller.abort(new Error("cancelled during"));
    await expect(pending).rejects.toBe(controller.signal.reason);
  });
});
