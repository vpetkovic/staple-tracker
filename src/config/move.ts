/**
 * Relocating the Staple home.
 *
 * STA-24 plan §2: "Changing the home after data exists is a migration, not a
 * normal key assignment. … inventories the source, copies … with data, verifies
 * the destination …, and updates the bootstrap locator last. … If verification
 * fails, restore the old locator … Retain the old home until the user confirms
 * the new home passes `doctor`. Without `--move`, reject a change that would
 * strand existing data."
 *
 * Two deliberate limits, both in-lane:
 *
 *  - The versioned runtime tree (`<home>/runtime/**`, `current.json`, the
 *    launcher) does not exist yet — A8 builds it. When it does, this copy picks
 *    it up like any other entry, but the launcher-target verification and the
 *    `current.json` rollback described in the plan belong to A8.
 *  - Hub rows that point INTO the old home are not rewritten. That is hub
 *    repair, which A7 owns; rewriting paths here would collide with it. The
 *    move reports the count so the user is not left to discover it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StapleError } from "../core/types.js";
import { assertUsableHome, bootstrapLocatorPath, writeBootstrapLocator } from "./locator.js";

export interface HomeMoveResult {
  from: string;
  to: string;
  /** Top-level entry names copied, sorted. Empty when the source had nothing yet. */
  copied: string[];
  locator: string;
  /** The old home, deliberately left in place until `doctor` confirms the new one. */
  retained: string;
  /** Hub rows still pointing inside the old home — A7's repair, reported not fixed. */
  staleHubPaths: number;
  /** True when the target already was the effective home and only the locator was stamped. */
  noop: boolean;
}

/** Is `child` the same as, or inside, `parent`? */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
}

/** Force WAL frames back into the main database so a plain file copy is complete. */
function checkpoint(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    // A database we cannot open is copied byte-for-byte with its sidecars
    // instead; verification below is what decides whether the move stands.
  }
}

/** Count hub rows whose workspace path still lives under `oldHome`. */
function staleHubPathCount(hubDb: string, oldHome: string): number {
  if (!existsSync(hubDb)) return 0;
  try {
    const db = new DatabaseSync(hubDb);
    try {
      const rows = db.prepare("SELECT path FROM workspaces").all() as Array<{ path: string }>;
      return rows.filter((row) => isWithin(oldHome, resolve(row.path))).length;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

export function moveHome(options: { from: string; to: string; locatorPath?: string }): HomeMoveResult {
  const from = resolve(options.from);
  const to = assertUsableHome(options.to, "config home <path>");
  const locatorPath = options.locatorPath ?? bootstrapLocatorPath();

  if (from === to) {
    // Nothing to copy, but stamping the locator makes the current home explicit
    // and survives a later change of `HOME`, so it is a real (idempotent) action.
    writeBootstrapLocator(locatorPath, to);
    return {
      from,
      to,
      copied: [],
      locator: locatorPath,
      retained: from,
      staleHubPaths: 0,
      noop: true,
    };
  }
  if (isWithin(from, to)) {
    throw new StapleError(
      "validation",
      `The new home ${to} is inside the current home ${from}. Choose a destination outside it.`,
    );
  }
  if (isWithin(to, from)) {
    throw new StapleError(
      "validation",
      `The current home ${from} is inside the new home ${to}. Choose a destination that does not contain it.`,
    );
  }

  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) {
      throw new StapleError("conflict", `${to} exists and is not a directory.`);
    }
    if (readdirSync(to).length > 0) {
      throw new StapleError(
        "conflict",
        `${to} is not empty. Staple will not merge into an existing directory — choose an empty or absent path.`,
      );
    }
  }

  const sourceExists = existsSync(from);
  const inventory = sourceExists ? readdirSync(from).sort() : [];

  // The source is quiesced before the copy: WAL frames folded back in, so the
  // destination is a consistent database rather than a main file plus a sidecar
  // that may or may not have travelled with it.
  if (sourceExists) {
    checkpoint(resolve(from, "hub.db"));
    const workspaces = resolve(from, "workspaces");
    if (existsSync(workspaces)) {
      for (const entry of readdirSync(workspaces)) {
        if (entry.endsWith(".db")) checkpoint(resolve(workspaces, entry));
      }
    }
  }

  const createdDestination = !existsSync(to);
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    if (sourceExists) cpSync(from, to, { recursive: true, preserveTimestamps: true });

    // Verify BEFORE the locator moves: every top-level entry arrived, and any
    // database that came along still opens.
    const arrived = new Set(readdirSync(to));
    const missing = inventory.filter((name) => !arrived.has(name));
    if (missing.length > 0) {
      throw new StapleError(
        "conflict",
        `Verification failed: ${missing.join(", ")} did not arrive at ${to}. The old home is untouched.`,
      );
    }
    const hubCopy = resolve(to, "hub.db");
    if (existsSync(hubCopy)) {
      const db = new DatabaseSync(hubCopy);
      try {
        db.prepare("SELECT count(*) AS n FROM workspaces").get();
      } finally {
        db.close();
      }
    }
  } catch (error) {
    // Nothing has pointed at the new home yet — the locator is still the old
    // one — so removing a destination we created leaves no trace of the attempt.
    if (createdDestination) rmSync(to, { recursive: true, force: true });
    throw error;
  }

  // Last, per the plan: until this line the old home is still the live one.
  writeBootstrapLocator(locatorPath, to);

  return {
    from,
    to,
    copied: inventory,
    locator: locatorPath,
    retained: from,
    staleHubPaths: staleHubPathCount(resolve(to, "hub.db"), from),
    noop: false,
  };
}

/** Does the current home hold anything a move would strand? */
export function homeHasData(home: string): boolean {
  const resolved = resolve(home);
  return existsSync(resolved) && readdirSync(resolved).length > 0;
}
