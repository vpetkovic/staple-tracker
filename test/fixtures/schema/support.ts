import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FIXTURES, fixturePath } from "./generate.js";

export { FIXTURES, fixturePath };

/**
 * Copy a fixture into a fresh temp directory and hand back its path.
 *
 * ALWAYS copy. Migrating a fixture in place would rewrite the checked-in file
 * the first time the suite ran, and every run after that would be testing an
 * already-upgraded database while still calling it "v1" — the fixture would
 * quietly stop being evidence about anything.
 */
export function useFixture(name: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "staple-fixture-"));
  const path = join(dir, name.replace(/\.sqlite$/, ".db"));
  copyFileSync(fixturePath(name), path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function withFixture<T>(name: string, fn: (path: string) => T): T {
  const { path, cleanup } = useFixture(name);
  try {
    return fn(path);
  } finally {
    cleanup();
  }
}

/** Read a `meta` value without going through the store (the table may be old). */
export function rawMeta(path: string, key: string): string | null {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null; // no meta table at all — a pre-A4 hub
  } finally {
    db.close();
  }
}

/** `type:name` for every schema object, sorted — the characterization shape. */
export function schemaObjects(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare("SELECT type, name FROM sqlite_master").all() as unknown as Array<{
        type: string;
        name: string;
      }>
    )
      .map((row) => `${row.type}:${row.name}`)
      .sort();
  } finally {
    db.close();
  }
}
