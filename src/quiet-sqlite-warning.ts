/**
 * Keeps node:sqlite's ExperimentalWarning off stderr, and nothing else.
 *
 * Every staple process loads `node:sqlite`, and Node prints "ExperimentalWarning:
 * SQLite is an experimental feature …" plus a `--trace-warnings` hint the first time
 * it does. That put two lines of noise on stderr in every run, including a
 * successful `--json` one an agent parses. Staple cannot act on the warning, so it
 * drops exactly that one: any other warning, another ExperimentalWarning included,
 * still goes to Node's own printer unchanged, and errors never pass through here.
 *
 * Node prints warnings from its default `'warning'` listener. This module takes that
 * listener off and puts a wrapper in its place that forwards everything except the
 * SQLite warning. `--no-warnings`, `NODE_NO_WARNINGS`, `--trace-warnings` and
 * `--disable-warning` keep working, because the printer still makes those decisions.
 * The `--disable-warning=ExperimentalWarning` flag would have done this by type, and
 * hidden every other experimental feature's warning with it.
 *
 * It must be installed before node:sqlite loads, so it is the first import of every
 * entry: src/cli.ts (which also runs `staple ui`), src/mcp.ts and
 * src/package/staple.ts, the packaged bundle the installed launcher runs. node:sqlite
 * itself loads later, when the first database opens (src/core/sqlite.ts says why).
 * test/quiet-stderr.test.ts spawns each entry and pins both halves.
 */

const SQLITE_EXPERIMENTAL = "SQLite is an experimental feature";

export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === "ExperimentalWarning" && warning.message.startsWith(SQLITE_EXPERIMENTAL);
}

const INSTALLED = Symbol.for("staple.quietSqliteWarning");

/** Idempotent: the packaged bundle reaches it through both its entry and the CLI or MCP module. */
export function quietSqliteWarning(): void {
  const state = process as NodeJS.Process & { [INSTALLED]?: true };
  if (state[INSTALLED]) return;
  state[INSTALLED] = true;

  const printers = process.listeners("warning");
  for (const printer of printers) process.off("warning", printer);
  process.on("warning", (warning) => {
    if (isSqliteExperimentalWarning(warning)) return;
    for (const printer of printers) printer.call(process, warning);
  });
}

quietSqliteWarning();
