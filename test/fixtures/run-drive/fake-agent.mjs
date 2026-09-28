/**
 * A fake headless agent for `staple run drive` tests: `--agent custom --command
 * "node fake-agent.mjs <mode> {ref} {brief_file}"`. Never an LLM.
 *
 *   review  write <ref>.txt, print what the session was given, move the ticket to in_review
 *   done    the same, then close the ticket
 *   fail    exit 3
 *   idle    exit 0 and touch nothing (the ticket stays held)
 *   sleep   start a grandchild that sleeps, record both pids in <ref>.pids, never finish
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [mode, ref, briefFile] = process.argv.slice(2);

console.log(
  JSON.stringify({
    mode,
    ref,
    briefExists: existsSync(briefFile),
    cwd: process.cwd(),
    env: { STAPLE_AGENT: process.env.STAPLE_AGENT, STAPLE_DB: process.env.STAPLE_DB, STAPLE_RUN: process.env.STAPLE_RUN, STAPLE_RUN_TICKET: process.env.STAPLE_RUN_TICKET },
  }),
);

if (mode === "review" || mode === "done") {
  writeFileSync(`${ref}.txt`, `${ref}\n`);
  const verb = mode === "done" ? ["done", ref] : ["status", ref, "in_review"];
  const moved = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), ...verb, "--json"], {
    encoding: "utf8",
  });
  process.stderr.write(moved.stderr);
  process.exit(moved.status ?? 1);
} else if (mode === "fail") {
  process.exit(3);
} else if (mode === "idle") {
  process.exit(0);
} else if (mode === "sleep") {
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  writeFileSync(`${ref}.pids`, JSON.stringify({ session: process.pid, grandchild: sleeper.pid }));
  setTimeout(() => {}, 120000);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(64);
}
