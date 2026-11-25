/**
 * The suite is safe whatever `STAPLE_*` variables the shell that starts it exports.
 *
 * A run started from an agent shell inherited the live tracker's `STAPLE_DB`, and the
 * tests that open a workspace or spawn the CLI without `--db` wrote real issues into it.
 * `test/setup/scrub-env.ts` removes those variables in the vitest process and again in
 * every worker. These tests fail if either call is removed, if the setup files stop being
 * wired, or if the scrub starts keeping a variable that names the operator's tracker.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import config from "../vitest.config.js";
import { keepsStapleVariable, scrubInheritedStapleEnv } from "./setup/scrub-env.js";

/** What `staple run drive` and a connected agent shell export. */
const LIVE_SHELL: Record<string, string> = {
  STAPLE_DB: "/live/.staple/staple.db",
  STAPLE_WS: "LIVE",
  STAPLE_AGENT: "live-agent",
  STAPLE_RUN: "live-run",
  STAPLE_RUN_TICKET: "LIVE-1",
  STAPLE_RUN_INSTRUCTIONS: "work the live ticket",
  STAPLE_HOME: "/live/home/.staple",
  STAPLE_ROLE: "orchestrator",
  STAPLE_LINEAR_API_KEY: "lin_live",
  STAPLE_AZURE_DEVOPS_PAT: "ado_live",
  STAPLE_CLICKUP_API_TOKEN: "pk_live",
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("scrubInheritedStapleEnv", () => {
  it("removes every variable that names a tracker, an actor, a run or a credential", () => {
    const env: NodeJS.ProcessEnv = { ...LIVE_SHELL, PATH: "/bin", HOME: "/home/x" };
    expect(scrubInheritedStapleEnv(env)).toEqual(Object.keys(LIVE_SHELL).sort());
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x" });
  });

  it("keeps the suite's own seams and the documented opt-ins", () => {
    const env: NodeJS.ProcessEnv = {
      STAPLE_TEST_STALL_LOG: "/tmp/stall.log",
      STAPLE_LIVE_SYNC: "1",
      STAPLE_LIVE_ENDPOINT: "https://worker.example",
      STAPLE_WRITE_EMITTED_PAYLOADS: "1",
    };
    const before = { ...env };
    expect(scrubInheritedStapleEnv(env)).toEqual([]);
    expect(env).toEqual(before);
    for (const name of Object.keys(LIVE_SHELL)) expect(keepsStapleVariable(name), name).toBe(false);
  });
});

describe("the run's setup", () => {
  it("wires the vitest-process scrub and the per-worker scrub", () => {
    expect(config.test?.globalSetup).toContain("test/setup/isolated-home.ts");
    // First, so no other setup file runs with the inherited environment.
    expect((config.test?.setupFiles as string[])[0]).toBe("test/setup/isolate-env.ts");
  });

  it("scrubs a worker that inherited a live shell's variables", async () => {
    Object.assign(process.env, LIVE_SHELL);
    vi.resetModules();
    await import("./setup/isolate-env.js");
    for (const name of Object.keys(LIVE_SHELL).filter((n) => n !== "STAPLE_HOME")) expect(process.env[name], name).toBeUndefined();
    expect(process.env.STAPLE_HOME).toBe(inject("isolatedHome").stapleHome);
  });

  it("scrubs the vitest process before it starts a worker", async () => {
    const liveHome = mkdtempSync(join(tmpdir(), "staple-env-scrub-live-"));
    Object.assign(process.env, LIVE_SHELL, { STAPLE_HOME: liveHome });
    const { default: setup } = await import("./setup/isolated-home.js");
    const teardown = setup({ provide: () => undefined } as unknown as Parameters<typeof setup>[0]);
    try {
      for (const name of Object.keys(LIVE_SHELL).filter((n) => n !== "STAPLE_HOME")) expect(process.env[name], name).toBeUndefined();
      expect(process.env.STAPLE_HOME).not.toBe(liveHome);
    } finally {
      teardown();
      rmSync(liveHome, { recursive: true, force: true });
    }
  });

  it("leaves this worker, and a child it spawns, without the inherited tracker", () => {
    const owned = new Set(["STAPLE_HOME", "STAPLE_TEST_LAUNCHCTL"]);
    const seen = (names: string[]) => names.filter((n) => n.startsWith("STAPLE_") && !owned.has(n) && !keepsStapleVariable(n));
    expect(seen(Object.keys(process.env))).toEqual([]);
    const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });
    expect(seen(JSON.parse(child.stdout) as string[])).toEqual([]);
  });
});
