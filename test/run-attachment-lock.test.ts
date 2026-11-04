/**
 * `driver.lock` under contention, with real processes: several `run drive` processes
 * starting at once over a lock a dead driver left behind. Exactly one may own it.
 *
 * Each child waits for one shared instant before it tries, so the attempts really overlap,
 * then holds what it got long enough that no two holds can be mistaken for a sequence.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TSX_CLI, removeDir, tempDir } from "./fixtures/characterize-support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => removeDir(dir)));

const CHILD = `
import { acquireDriverLock } from ${JSON.stringify(join(REPO_ROOT, "src/core/run-attachment.ts"))};
const [dbFile, runId, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
const lock = acquireDriverLock(dbFile, runId);
if ("release" in lock) {
  console.log("owned");
  setTimeout(() => { lock.release(); process.exit(0); }, 1500);
} else {
  console.log("held");
}
`;

/** A pid that is certainly not running: a process that has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

async function trial(processes: number): Promise<string[]> {
  const dir = tempDir("driver-lock");
  dirs.push(dir);
  const dbFile = join(dir, "staple.db");
  const runId = "run-1";
  mkdirSync(join(dir, "runs", runId), { recursive: true });
  // The dead driver's lock.
  writeFileSync(join(dir, "runs", runId, "driver.lock"), JSON.stringify({ pid: deadPid(), host: hostname() }));
  const child = join(dir, "child.ts");
  writeFileSync(child, CHILD);
  const at = Date.now() + 2500;
  const outputs = await Promise.all(
    Array.from({ length: processes }, () =>
      new Promise<string>((resolve) => {
        const proc = spawn(process.execPath, [TSX_CLI, child, dbFile, runId, String(at)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        proc.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
        proc.on("exit", () => resolve(out.trim()));
      }),
    ),
  );
  return outputs;
}

describe("driver.lock", () => {
  it("of six drivers taking over a dead driver's lock at once, exactly one owns it, every trial", async () => {
    for (let round = 0; round < 5; round++) {
      const outputs = await trial(6);
      expect(outputs.filter((line) => line === "owned"), outputs.join(" | ")).toHaveLength(1);
      expect(outputs.filter((line) => line === "held"), outputs.join(" | ")).toHaveLength(5);
    }
  }, 120_000);
});
