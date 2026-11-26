/**
 * The one place staple loads `node:sqlite` at run time.
 *
 * Loading `node:sqlite` emits its ExperimentalWarning. src/quiet-sqlite-warning.ts
 * drops that warning, but only once it is installed, and a static `import … from
 * "node:sqlite"` loads the module while the import graph is still being resolved,
 * before any module body runs. Under tsx that resolution is asynchronous, so the
 * warning was printed before the filter existed. Loaded here instead, on the first
 * database a process opens, it always comes after the filter.
 *
 * Every other module imports `node:sqlite` for types only (`import type`), and
 * test/quiet-stderr.test.ts fails a value import anywhere else.
 */
import type { DatabaseSync, DatabaseSyncOptions } from "node:sqlite";

export function openSqlite(path: string, options?: DatabaseSyncOptions): DatabaseSync {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  // The constructor refuses an explicit `undefined` options argument.
  return options === undefined ? new DatabaseSync(path) : new DatabaseSync(path, options);
}
