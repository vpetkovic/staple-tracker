/**
 * The brief `staple run drive` hands each fresh agent session: everything a session that
 * knows nothing needs to work one ticket the way this repository works tickets, and to
 * stop there.
 *
 * It is the only place the driver says anything about branches and merging, and what it
 * says is a prohibition: the session leaves its work on a branch (and a pull request when
 * the repository has a remote) for a person to merge. The driver's own code runs no git
 * at all (`run-driver.ts`; a test holds both halves).
 */

/** Where a finished session moves its ticket. */
export type DriveFinish = "in_review" | "done";

export interface BriefInput {
  ref: string;
  title: string;
  /** The directory the session runs in. */
  workspace: string;
  /** The workspace database the session's staple commands are pinned to (STAPLE_DB). */
  db: string;
  runId: string;
  actor: string;
  finish: DriveFinish;
  /** Extra instructions from `--instructions <file>`: this repository's gates, conventions. */
  instructions: string | null;
  /** An earlier session worked this ticket and ended without finishing it. */
  resumed?: boolean;
}

/** The branch a ticket's work goes on. Sessions run one after another in one checkout, so each branches off the last: a stack. */
export function ticketBranch(ref: string): string {
  return `autopilot/${ref.toLowerCase()}`;
}

export function buildBrief(input: BriefInput): string {
  const branch = ticketBranch(input.ref);
  const finishStep =
    input.finish === "done"
      ? `\`staple done ${input.ref} --json\``
      : `\`staple status ${input.ref} in_review --json\` (a person closes it after reviewing)`;
  const extra = input.instructions?.trim()
    ? `\n## This repository's instructions\n\n${input.instructions.trim()}\n`
    : "";
  const resumed =
    input.resumed === true
      ? `
RESUMING: an earlier session worked ${input.ref} and ended without finishing it. Read its comments, plan and worklog first, check ${branch} for what it already did, and carry on from there rather than starting over. A review recorded before this session does not count: post a fresh one (step 5).
`
      : "";
  return `You are one fresh session of a staple autopilot run. Work exactly ONE ticket, ${input.ref}, to a finished, evidenced state, then end your session.
${resumed}
Ticket:    ${input.ref} "${input.title}"
Workspace: ${input.workspace}
Database:  ${input.db}
Run:       ${input.runId} (actor ${input.actor})

## The tracker

- \`STAPLE_AGENT=${input.actor}\` and \`STAPLE_DB=${input.db}\` are already exported in your environment, so every \`staple\` command acts as ${input.actor} on this workspace and no other. Work only inside ${input.workspace}. Never pass --db or --ws, and never touch any other staple workspace or database.
- The run has ALREADY CHECKED OUT ${input.ref} to you. Do not run \`staple checkout\`, do not release it, and do not take, start or edit any other ticket.
- Read the ticket first: \`staple show ${input.ref} --json\` (description, acceptance criteria, comments, documents). Its acceptance criteria are the definition of done.
- Do not call \`staple run continue\`, \`run stop\` or any other \`staple run\` command: the driver that started you does that when you exit.

## Steps

1. Branch. Put the work on its own branch, off the current HEAD: \`git switch -c ${branch}\` (or \`git switch ${branch}\` if it exists). Record it: \`staple comment ${input.ref} "working on branch ${branch}"\`.
2. Plan. Write a short plan to a file and store it: \`staple doc ${input.ref} plan --put <file>\`.
3. Work. Keep a worklog (Done / Next / Files) and store it after each step: \`staple doc ${input.ref} worklog --put <file>\`. Comment milestones on the ticket as you go.
4. Gates. Run this repository's own checks (build, typecheck, tests, whatever its README or CONTRIBUTING names). Read the counts, not only the exit code. Green gates are not evidence on their own.
5. Adversarial review, before you finish. Review your change as a skeptic whose job is to find where it fails the acceptance criteria. Reproduce, do not read: run the thing and observe each criterion hold, including an edge case. If you can start a separate reviewer (a sub-agent), give it this instruction and act on its findings; otherwise do the review yourself. Fix what it finds and review again. Record the findings and what you did about each as a comment: \`staple comment ${input.ref} "review: ..."\`.
6. Commit your work on ${branch}. If the repository has a remote you may push ${branch} and open a draft pull request against the branch you started from.
   NEVER merge anything into master or main, never push to master or main, and never run \`git merge\`, \`gh pr merge\` or anything else that lands work on them. Merging is a person's decision; leave the branch (and its pull request) for them.
7. Finish. Comment the evidence (what you ran and what it showed, the branch and commit), then move the ticket: ${finishStep}.
   If you cannot finish, comment exactly why and what is left, leave the ticket where it is, and end the session: the run records it failed and a person looks.
${extra}`;
}
