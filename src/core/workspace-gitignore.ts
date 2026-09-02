/**
 * The `.staple/.gitignore` that makes the database uncommittable while leaving
 * the protocol guide tracked.
 *
 * ## Why this file exists, and why it is not what plan §3 literally says
 *
 * Plan §3 says: "Init adds `.staple/` to `.gitignore` if the repository has a
 * Git root and the rule is absent." Plan §5 says: "Do not write
 * `.staple/AGENTS.md`", and its stated reason is that the directory is ignored.
 *
 * Those two sentences are one design, and A5 (STA-35) shipped neither half —
 * deliberately, and flagged it: writing the whole-directory ignore rule without
 * first re-homing the guide would delete the only onboarding surface a cold
 * harness finds when it lands in a repository, and STA-25/B1-B4 owns the
 * replacement and has not built it. A5's comment on STA-59 proposes the
 * resolution this module implements, and STA-59 is the ticket for it:
 *
 *   a PER-DIRECTORY `.staple/.gitignore` that ignores `*.db`, `*.db-wal`,
 *   `*.db-shm` — and NOT `AGENTS.md`.
 *
 * That dissolves the conflict rather than trading one half of it away:
 *
 *   - The database stops being committable by default, which is the entire
 *     point of plan §3's rule and the reason STA-59 was filed.
 *   - `AGENTS.md` stays tracked, so it travels with the repository and a fresh
 *     clone has the protocol before anybody runs `init` — which is STA-59's own
 *     stated goal ("the protocol guide dies on clone").
 *   - Plan §5's PREMISE — that a guide inside `.staple/` would be invisible —
 *     stops being true, so its prohibition no longer applies to a guide that is
 *     demonstrably tracked.
 *
 * It is also strictly less invasive than the plan's wording in a second way:
 * nothing is written to the repository's own root `.gitignore`. Staple's ignore
 * rules live inside staple's own directory, which `init` creates in the same
 * breath, so uninstalling staple from a repository is `rm -rf .staple` and
 * leaves no residue in a file the project owns.
 *
 * The legacy `.tasks/` rule, wherever a repository already carries one, is left
 * exactly as it is — plan §3: "It leaves the existing `.tasks/` ignore rule
 * during the compatibility window."
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_GITIGNORE_FILENAME = ".gitignore";

/**
 * The patterns, and the reasoning, in the file itself.
 *
 * The comment block is not decoration: the person most likely to read this file
 * is someone wondering why their staple database is not in `git status`, and the
 * answer has to be where they are looking. `!AGENTS.md` is stated explicitly
 * rather than left implicit — a future editor who broadens the first rule to
 * `*` needs to trip over the exception rather than discover it by losing the
 * guide on the next clone.
 */
export const WORKSPACE_GITIGNORE_BODY = `# Staple keeps this repository's task state here.
#
# The DATABASE is machine-local: it carries WAL sidecars, absolute-path history
# and per-machine identifiers, and two people committing it would conflict on
# every task. It is ignored.
#
# AGENTS.md is NOT ignored. It is the working protocol for this repository and
# it is meant to travel with the repo, so a fresh clone (and any agent that
# lands in one) has the protocol before anyone runs \`staple init\`.
*.db
*.db-wal
*.db-shm
!AGENTS.md
`;

export interface WorkspaceGitignoreResult {
  /** Where the ignore file lives (or would live). */
  path: string;
  /** false when a file was already there and was left exactly as it was. */
  written: boolean;
}

/**
 * Write `.staple/.gitignore`, **never clobbering** an existing file.
 *
 * Same rule as {@link writeAgentsGuide}: `init` is idempotent and runs again
 * every time somebody re-registers a workspace, so an operator's edits outrank
 * the template permanently. A repository that has deliberately narrowed or
 * widened these patterns keeps its version forever.
 */
export function writeWorkspaceGitignore(workspaceDir: string): WorkspaceGitignoreResult {
  const path = join(workspaceDir, WORKSPACE_GITIGNORE_FILENAME);
  if (existsSync(path)) return { path, written: false };
  writeFileSync(path, WORKSPACE_GITIGNORE_BODY, "utf8");
  return { path, written: true };
}
