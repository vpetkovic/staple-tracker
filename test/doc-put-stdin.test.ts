/**
 * `staple doc <ref> <name> --put -` reads the whole of stdin, however slowly it
 * arrives.
 *
 * It used `readFileSync(0)`. On the packaged runtime fd 0 is non-blocking by
 * the time the command runs, so the first read took what was there and the next
 * one, made while the writer was still busy, failed with `EAGAIN` and exit 1:
 * `(sleep 1; echo hi) | staple doc … --put -` failed on every install path.
 *
 * Run against the real bundle (the suite's payload), because the source tree
 * under tsx happens to leave fd 0 blocking and passes either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { testPackageDir } from "./fixtures/package-payload.js";

const STAPLE = join(testPackageDir(), "staple.mjs");

let home: string;
let repo: string;
let ref: string;

function staple(args: string[]) {
  return spawnSync(process.execPath, [STAPLE, ...args], {
    cwd: repo,
    env: bareEnv({ STAPLE_HOME: home, NODE_NO_WARNINGS: "1" }),
    encoding: "utf8",
  });
}

beforeAll(() => {
  home = tempDir("doc-stdin-home");
  repo = tempDir("doc-stdin-repo");
  expect(staple(["init"]).status).toBe(0);
  const created = staple(["new", "a task with notes", "--json"]);
  expect(created.status, created.stderr).toBe(0);
  ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(repo);
});

describe("doc --put - (stdin)", () => {
  it("waits for a slow writer and keeps every byte, including a character split across the pause", () => {
    // "é" is two bytes; the writer sends the first, pauses, then the second.
    const script = `(printf 'first line\\n\\303'; sleep 1; printf '\\251 second line\\n') | "${process.execPath}" "${STAPLE}" doc "${ref}" notes --put -`;
    const put = spawnSync("sh", ["-c", script], {
      cwd: repo,
      env: bareEnv({ STAPLE_HOME: home, NODE_NO_WARNINGS: "1" }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(put.stderr).toBe("");
    expect(put.status).toBe(0);
    expect(put.stdout).toContain("notes @ revision 1");

    const read = staple(["doc", ref, "notes", "--json"]);
    expect(read.status, read.stderr).toBe(0);
    expect((JSON.parse(read.stdout) as { body: string }).body).toBe("first line\né second line\n");
  }, 60_000);
});
