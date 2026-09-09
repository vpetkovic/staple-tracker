/**
 * The static half of the redaction guarantee.
 *
 * Redaction here is structural: `src/log.ts` exposes a closed record of primitives, so
 * a credential cannot be logged through it because there is no parameter it would fit
 * in. That argument only holds if `log.ts` is the ONLY thing that talks to the console
 * — one `console.error(err)` elsewhere and the guarantee is gone, silently.
 *
 * The dynamic half is test/redaction.test.ts, which spies on the real console during
 * real authenticated requests. This is the half that catches the console call added on
 * a Friday to a path no test happens to drive.
 *
 * Run: npm run lint:logs
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const SRC = new URL("../src/", import.meta.url).pathname;
const ALLOWED = new Set(["log.ts"]);
const CONSOLE_CALL = /\bconsole\s*\.\s*(log|error|warn|info|debug|trace|dir|table)\s*\(/;

const offenders = [];
for (const name of (await readdir(SRC)).filter((f) => f.endsWith(".ts"))) {
  if (ALLOWED.has(name)) continue;
  const source = await readFile(join(SRC, name), "utf8");
  for (const [index, line] of source.split("\n").entries()) {
    // Skip comment lines: this file's own prose, and log.ts's, name `console.log`
    // deliberately while explaining why it must not appear.
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    if (CONSOLE_CALL.test(line)) offenders.push(`src/${name}:${index + 1}: ${code}`);
  }
}

if (offenders.length > 0) {
  console.error("console.* is only permitted in src/log.ts, which allowlists its fields.\n");
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    "\nRoute the message through log() instead, adding a field to LogFields if it needs one.",
  );
  process.exit(1);
}

console.log(`ok — no console.* outside src/log.ts`);
