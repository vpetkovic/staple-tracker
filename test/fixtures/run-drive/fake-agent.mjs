/**
 * A fake headless agent for `staple run drive` tests: `--agent custom --command
 * "node fake-agent.mjs <mode> {ref} {brief_file}"`. Never an LLM.
 *
 *   review      write <ref>.txt, record its review, move the ticket to in_review
 *   done        the same, then close the ticket
 *   unreviewed  write <ref>.txt and move the ticket to in_review with NO review comment
 *   fail    exit 3
 *   idle    exit 0 and touch nothing (the ticket stays held)
 *   sleep   start a grandchild that sleeps, record both pids in <ref>.pids, never finish
 *   stubborn  the same, but both ignore SIGTERM (only KILL ends them)
 *   background  leave a sleeping grandchild behind (pids in <ref>.pids), then do `review`
 *   mainline    move .git/refs/heads/master by writing the file, then do `review`
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const staple = (...args) =>
  spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/cli.ts"), ...args, "--json"], {
    encoding: "utf8",
  });

const sleeper = (ignoreTerm) =>
  spawn(process.execPath, ["-e", `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setTimeout(() => {}, 120000)`], { stdio: "ignore" });

if (mode === "background") {
  const child = sleeper(false);
  child.unref();
  writeFileSync(`${ref}.pids`, JSON.stringify({ session: process.pid, grandchild: child.pid }));
}
if (mode === "mainline" || mode === "mainline-sleep" || mode === "mainline-handed-on") {
  mkdirSync(".git/refs/heads", { recursive: true });
  writeFileSync(".git/refs/heads/master", "2222222222222222222222222222222222222222\n");
}
if (mode === "mainline-handed-on") {
  // Moves the main line AND hands its ticket on, then lingers: nothing holds it any more.
  staple("comment", ref, "review: done");
  staple("status", ref, "in_review");
}

if (["review", "done", "unreviewed", "background", "mainline"].includes(mode)) {
  writeFileSync(`${ref}.txt`, `${ref}\n`);
  if (mode !== "unreviewed") {
    const reviewed = staple("comment", ref, `review: reproduced ${ref}.txt; nothing found`);
    if (reviewed.status !== 0) process.stderr.write(reviewed.stderr);
  }
  const verb = mode === "done" ? ["done", ref] : ["status", ref, "in_review"];
  const moved = staple(...verb);
  process.stderr.write(moved.stderr);
  process.exit(moved.status ?? 1);
} else if (mode === "fail") {
  process.exit(3);
} else if (mode === "idle") {
  process.exit(0);
} else if (mode === "sleep" || mode === "stubborn" || mode === "mainline-sleep" || mode === "mainline-handed-on") {
  if (mode === "stubborn") process.on("SIGTERM", () => {});
  const child = sleeper(mode === "stubborn");
  writeFileSync(`${ref}.pids`, JSON.stringify({ session: process.pid, grandchild: child.pid }));
  setTimeout(() => {}, 120000);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(64);
}
