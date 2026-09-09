/**
 * Is this directory inside a version control checkout?
 *
 * Contract: `docs/sync.md`, "Repository identity" and "A copied home is not a
 * second device".
 *
 * ## What this is NOT
 *
 * It is not a gate on identity. A workspace gets a sync identity whether or not
 * anything here answers true — that is the whole of STA-281, and the module that
 * mints identities calls no function in this file on the way to minting one.
 *
 * What it answers is the narrower question of HOW a copy of this workspace could
 * reach another machine, because the two ways differ in the one respect that
 * matters:
 *
 *   - through a checkout, the identity travels and the DATABASE does not. The
 *     second machine starts from an empty local state, adopts the id, and the two
 *     converge. That is what a clone is for, and refusing it would break the
 *     feature.
 *   - any other way — a backup restore, an rsync, a file sync service, a copied
 *     folder — brings the database with it, and with it the cursor, the epoch and
 *     the client-sequence allocator. Two machines allocating from one counter mint
 *     operation ids for different work that the service cannot tell apart.
 *
 * So a workspace that is NOT in a checkout is host-bound (see `repo-identity.ts`,
 * "the host binding"), and one that is stays exactly as it was.
 *
 * ## Why a file test and never a subprocess
 *
 * `host-id.ts` says it and this file keeps it: nothing in the identity path
 * invokes a version control system. Not for correctness — `git rev-parse` would
 * answer this more precisely — but because `openWorkspace` runs on every single
 * command, and a spawn per open is a cost and a hang risk on a path that must
 * stay a few syscalls. `existsSync` for `.git` is one stat per ancestor.
 *
 * ## Why `.git` and nothing else
 *
 * The two answers are not symmetric in cost. Reading a checkout as plain lands on
 * the LOUD side: the workspace is host-bound, and a copy that turns out to have
 * been a legitimate clone produces one explicit refusal naming two ways out.
 * Reading a plain directory as a checkout lands on the SILENT side: no binding,
 * and a genuine copy forks the workspace weeks before anybody notices. So the
 * marker set is deliberately minimal rather than generous, for the same reason
 * `host-id.ts` pushes its failure onto the loud side.
 *
 * A `.git` FILE counts as much as a directory: that is what a worktree and a
 * submodule have, and both carry committed files to other machines exactly as a
 * plain checkout does.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The one marker. See the module header on why the set is not larger. */
const CHECKOUT_MARKER = ".git";

/**
 * Walk up from `dir` looking for a checkout marker.
 *
 * Bounded at 64 hops like `findWorkspace`, so a pathological symlink cycle costs
 * a bounded number of stats rather than the process.
 */
export function isInsideCheckout(dir: string): boolean {
  let current = resolve(dir);
  for (let hops = 0; hops < 64; hops += 1) {
    if (existsSync(join(current, CHECKOUT_MARKER))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}
