/**
 * A refused `initWorkspace` removes the database it created, and only that.
 *
 * The CLI tests in `init-lifecycle.test.ts` cover the refusal init can see coming: the slug is
 * already registered, so nothing is created at all. These cover the one it cannot: the hub
 * refusing the registration after the pre-check passed (another process won the slug in
 * between). The refusal is forced by making `register` throw.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";

let home: string;
let root: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-init-cleanup-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-init-cleanup-root-"));
  process.env.STAPLE_HOME = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STAPLE_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function refuseRegistration(): void {
  vi.spyOn(Hub.prototype, "register").mockImplementation(() => {
    throw new StapleError("conflict", "lost the race");
  });
}

describe("initWorkspace when the hub refuses after the pre-check", () => {
  it("removes the database it created and the .staple directory it made", () => {
    const dir = join(root, "raced");
    mkdirSync(dir);
    refuseRegistration();

    expect(() => initWorkspace({ dir })).toThrow("lost the race");
    expect(readdirSync(dir)).toEqual([]);

    vi.restoreAllMocks();
    expect(initWorkspace({ dir }).created).toBe(true);
  });

  it("removes the directories it made for a --dir that did not exist, and stops at one that did", () => {
    const dir = join(root, "fresh-parent", "nested");
    refuseRegistration();

    expect(() => initWorkspace({ dir })).toThrow("lost the race");
    expect(existsSync(join(root, "fresh-parent"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("keeps a .staple directory that already held something", () => {
    const dir = join(root, "has-manifest-dir");
    mkdirSync(join(dir, ".staple"), { recursive: true });
    writeFileSync(join(dir, ".staple", "notes.txt"), "mine\n");
    refuseRegistration();

    expect(() => initWorkspace({ dir })).toThrow("lost the race");
    expect(readdirSync(join(dir, ".staple"))).toEqual(["notes.txt"]);
  });

  it("never removes a database that existed before the call", () => {
    const dir = join(root, "existing");
    mkdirSync(dir);
    const first = initWorkspace({ dir });
    first.store.db.close();
    refuseRegistration();

    expect(() => initWorkspace({ dir })).toThrow("lost the race");
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);

    vi.restoreAllMocks();
    const again = initWorkspace({ dir });
    expect(again.created).toBe(false);
    expect(again.store.prefix).toBe(first.store.prefix);
    again.store.db.close();
  });
});

describe("initWorkspace when the slug is already registered", () => {
  it("refuses before it opens a database, so the refusal writes nothing", () => {
    const taken = join(root, "taken-a", "shared");
    mkdirSync(taken, { recursive: true });
    initWorkspace({ dir: taken }).store.db.close();

    const other = join(root, "taken-b", "shared");
    mkdirSync(other, { recursive: true });
    const register = vi.spyOn(Hub.prototype, "register");
    expect(() => initWorkspace({ dir: other })).toThrow('Workspace "shared" is registered with prefix');
    expect(register).not.toHaveBeenCalled();
    expect(readdirSync(other)).toEqual([]);
  });
});
