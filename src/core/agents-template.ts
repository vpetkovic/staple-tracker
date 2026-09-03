import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The onboarding guide `staple init` drops next to a repo workspace, so the next
 * harness to arrive learns the protocol from the repo instead of from whoever
 * happened to brief the last one.
 *
 * Zero runtime deps by construction: a template literal in a source module, not
 * a bundled asset, not a file read at runtime.
 */

export const AGENTS_GUIDE_FILENAME = "AGENTS.md";

/** Absolute path to this checkout's MCP entry point, for a copy-pasteable wiring line. */
function mcpEntryPath(): string {
  // .../src/core/agents-template.(ts|js) -> .../src/mcp.(ts|js). There is no build
  // step for the server today (everything runs through tsx), but keep the extension
  // derived rather than hardcoded so a compiled layout still points somewhere real.
  const here = fileURLToPath(import.meta.url);
  return join(dirname(dirname(here)), here.endsWith(".ts") ? "mcp.ts" : "mcp.js");
}

export interface AgentsGuideContext {
  /** Workspace slug, e.g. `staple`. */
  slug: string;
  /** Identifier prefix minted by the hub, e.g. `STA`. */
  prefix: string;
}

/**
 * Render the guide. Imperative and written for an agent reading it cold: it
 * assumes no prior briefing and no memory of a previous session.
 */
export function renderAgentsGuide({ slug, prefix }: AgentsGuideContext): string {
  const ref = `${prefix}-42`;
  return `# Working this repo with staple

This repo tracks its work in **staple**, a local-first tracker. The workspace is
\`${slug}\`; its tasks are identified \`${prefix}-1\`, \`${prefix}-2\`, …  State lives in
\`.staple/staple.db\` next to this file. Nothing here is optional politeness — the
protocol below is what makes an interrupted task resumable by whoever comes next.

Read this before you touch the repo. It takes a minute.

## The loop

1. \`staple inbox\` — what is ready, in pickup order. Blocked work is listed
   separately with the blocker that must land first. Do not invent work that is
   not a task; make a task.

   The inbox has a third section, **QUEUED**, and it means something different
   from BLOCKED: a human has parked the parent above those tasks behind an
   approval gate (\`awaiting_approval\`), so nothing underneath it may be picked
   up yet. \`staple checkout\` on a queued task is **refused** — exit code 9,
   \`gated\` — and that refusal will not clear by retrying, by waiting, or by
   \`--steal-if-stale\`. It clears when the named person runs \`staple approve\`.
   Take something from READY instead, and if there is nothing, say so rather
   than working around the gate.
2. \`staple checkout ${ref}\` — atomic claim, moves it to \`in_progress\`.
   **A conflict means pick a different task. Never retry the same one.** The
   claim is already held; retrying just burns turns. (Exit code 4 / \`conflict\`.)
3. Write the plan: \`staple doc ${ref} plan --put plan.md\`. Documents are keyed
   and revisioned — this replaces a scratch \`plan.md\` nobody else can find.
   **Record your estimate while you are planning** — \`staple status ${ref} in_progress
   --estimate 2h\`, or \`--estimate\` on \`staple new\`. An estimate written after the
   work is a memory of how long it took, not a prediction, and the whole
   estimate-vs-actual comparison is worthless the moment it becomes one.
4. Work. Leave progress as you go: \`staple comment ${ref} "…"\`.
   **Your comments are the clock.** Time worked is measured as the span from your
   claim to your newest event or comment — never to "now" — so a task you hold in
   silence records nothing, and one you narrate records what you actually did.
   That is deliberate: it means a crashed agent's ticket stops accruing instead
   of billing the estimate for the weekend. Comment when you finish a step.
5. \`staple done ${ref} -m "<evidence>"\` — evidence, not a victory lap. What you
   ran, what passed, what you deliberately left.
6. \`staple events\` — see what your completion unblocked (\`blockers_resolved\`,
   \`children_complete\`). Then go back to \`inbox\`.

## Parents close themselves

**An epic's status follows its children. You never have to remember to close
one.** When the last open child of a parent lands, the parent goes \`done\` on its
own — \`cancelled\` only if every child was cancelled, and any mix of done and
cancelled reads \`done\`. Re-open a child and the parent comes back out. A parent
is \`in_progress\` only while a child genuinely is, so an epic can never sit there
claiming work that stopped days ago. An issue with **no children** is untouched
by any of this.

\`\`\`bash
staple done ${ref}          # the last child of an epic…
staple show <epic>          # …and the epic already reads done
\`\`\`

**One exception: an epic with an open review gate does not close itself.** While
its gate is \`pending\` or \`changes_requested\`, the human review IS the remaining
work, so the last child landing leaves the epic open and waiting. It closes on
the next transition after the gate is answered — or the moment \`staple approve\`
is run, if everything underneath had already landed.

What is still yours to do:

- **Write the summary.** The automatic close records *that* the epic finished,
  never *what* shipped. When you see \`children_complete\` on a parent, comment on
  it: \`staple comment <epic> "Shipped X and Y; Z deliberately left, see …"\`.
  That comment is the only account of the epic anyone will read later.
- **\`staple done <epic>\` is still allowed**, and still idempotent — close one by
  hand whenever you mean it, for instance while a child is deliberately being
  abandoned. A status a human or an agent sets on a parent **outranks** the
  derivation from then on: the tracker will not re-open or re-close it behind
  you.

## Act under one identity, all session

Set \`STAPLE_AGENT\` (or pass \`--agent\` / \`--author\` / MCP \`actor\`) and **use the
same value you claimed with for the entire session.**

This is not bookkeeping. Liveness is derived from your claim plus the newest
event or comment *by the holder*. Write a comment under a different name and it
does not count as your activity: your own task reads as silent, and you look
stealable to the next agent that walks past. Set it once, at the top:

\`\`\`bash
export STAPLE_AGENT=your-name
\`\`\`

## The worklog protocol — checkpoint as you go

Keep a document keyed \`worklog\` on every task you hold, and **revise it at every
milestone**, not at the end.

\`\`\`bash
staple doc ${ref} worklog --put worklog.md
staple doc ${ref} worklog              # read the latest
staple doc ${ref} worklog --revisions  # the history, checkpoint by checkpoint
\`\`\`

Three sections, always:

\`\`\`markdown
## Done
- Ported the claim guard; \`store.checkoutIssue\` now CASes on the holder (a1b2c3d).

## Next
- Wire the same guard into the HTTP surface, then re-run \`npm run smoke:mcp\`.

## Files touched
- src/core/store.ts, src/mcp.ts, test/store-claim.test.ts
\`\`\`

Reference commit SHAs where the work is real code — a SHA is the only pointer
that survives a rebase of your working tree.

**Why before, not after:** the checkpoint you write *before* the interruption is
the handoff. A summary written at the end never survives a kill, a usage limit,
or a crashed harness — the whole class of events that make a handoff necessary
are exactly the events that prevent you from writing one. Assume every turn is
your last one and the protocol costs you nothing.

## The vocabulary is this workspace's, not staple's

Statuses and kinds are **configured per workspace**. Do not assume the eight you
have seen elsewhere — read them:

\`\`\`bash
staple statuses ls          # id, category, label, in the configured order
staple kinds ls
\`\`\`

Every status carries a **category** from a fixed set — \`unstarted\`, \`ready\`,
\`active\`, \`review\`, \`gated\`, \`blocked\`, \`done\`, \`cancelled\` — and **all
behaviour keys off the category, never off the id**: checkout claims from
\`ready\`/\`unstarted\`/\`blocked\`, a claim only ever sits in \`active\`, \`done\` and
\`cancelled\` mean resolved, and an epic's status is derived from its children by
their categories — including the automatic close above, which lands in whatever
status this workspace puts in the \`done\` category, and the review gate, which
parks a parent in whatever it puts in the \`gated\` one. So a workspace can rename
\`in_review\`, or call its gate \`needs_signoff\`, and every guard still means what
it meant.

The configured ORDER is the canonical order everywhere — group headers, board
columns, tree sort. Changing it changes what everyone sees:

\`\`\`bash
staple statuses add awaiting_approval --category gated --after in_review
staple statuses reorder backlog,todo,in_progress,in_review,done,blocked,cancelled
staple statuses rm old_status --migrate-to backlog   # --migrate-to is required
                                                     # while issues still use it
\`\`\`

Every issue **declares a kind** — \`epic\`, \`bug\`, \`spike\`, whatever this
workspace configured. Declare it when you file the ticket, because nothing infers
it later:

\`\`\`bash
staple new "Login 500s on retry" --kind bug
staple ls --kind epic          # just the epics
\`\`\`

The default is \`task\`. **Kind is declared, never derived**: a task that grows
subtasks stays a task until somebody says otherwise, so if you break an epic out
into children, set the parent's kind yourself. \`staple ls\` prints the kind only
when it is not \`task\` — a bare row IS a task — while \`staple show\` always names
it.

**Edit the vocabulary only when a human asks.** It is workspace-wide
configuration, not a per-task decision, and a reorder moves every board in the
repo. The MCP tools are \`list_statuses\`, \`list_kinds\`, \`update_statuses\` and
\`update_kinds\`; the two reads cost nothing, so prefer reading over guessing.

## Branch pointer

The task says what; it does not say where. **At checkout, comment where the
physical work lives** — branch, worktree path, and the base commit:

\`\`\`bash
staple comment ${ref} "Branch pointer: worktree /path/to/wt on branch feat/${prefix.toLowerCase()}-42, base a1b2c3d."
\`\`\`

Without it, the next agent has a perfect description of the work and no idea
which of six worktrees contains it.

## Approval gates — when the next move is a human's

A **gate** parks a parent on a named person. The parent goes
\`awaiting_approval\`, **its claim is cleared** — nobody is working a parked
ticket — and every open task underneath it becomes QUEUED: out of READY, and
refused at checkout until that person answers.

Use it the moment the next move on your ticket belongs to a human — a design
that needs a decision, an epic whose plan needs a read before its children
start:

\`\`\`bash
staple gate ${ref} --owner VP -m "Schema plus the three CLI verbs — ok to build on this?"
\`\`\`

**That is how a design-first ticket ends. Not with a held claim.** Sitting in
\`in_progress\` while you wait on a person is the exact failure this exists to
stop: the ticket bills time against its estimate, it reads as live work to
everyone scanning the board, and it looks stealable to the next agent that
walks past. A gate says the true thing instead — the work stopped, and here is
who it stopped on.

The rules:

- **A gate needs children, and it needs an owner.** On a leaf there is nothing
  to queue, and the refusal points you at \`staple status ${ref} in_review\`,
  which already means "finished, waiting on a human" and still ranks READY.
  \`--owner\` is mandatory: a gate with nobody to chase never opens.
- **Never route around one.** \`staple checkout\` on a queued task exits **9**
  (\`gated\`), and that refusal does not clear by retrying, by waiting, or by
  \`--steal-if-stale\`. Take something from READY instead.
- **Only open work is queued.** A \`done\` or \`cancelled\` task under a gated
  parent is never queued, never listed for approval and never counted — and
  neither is a parent that has nothing open left underneath it, because there is
  nothing there to release.
- **Approving is the reviewer's move, not yours.** \`staple approve ${ref}\`
  resolves the gate, releases the whole subtree, and re-derives the parent from
  its children. \`staple approve ${ref} --children ${prefix}-43,${prefix}-44\`
  releases only those and everything underneath them and leaves the parent
  parked — one thread proceeds, the review carries on.
- **Changes requested returns the parent, not the queue.**
  \`staple request-changes ${ref} -m "…"\` posts the note as a comment on
  ${ref}, returns it to todo for the next agent, and keeps the queued children
  parked until somebody approves. Nobody is re-checked-out — if you want it
  back, check it out like any other task. (The web UI calls this **Send back**;
  the command name is the same.)
- **Re-gating is how you resubmit.** Fix what was asked, then run
  \`staple gate ${ref} --owner VP\` again. A \`changes_requested\` gate is the
  one state \`gate\` deliberately does not refuse, because that second read is
  the whole loop.

## Continuity — resuming someone else's interrupted task

Every \`in_progress\` task shows its claim: \`ls\` and \`show\` print
\`held 2h · silent 45m\`, and \`--json\` / the MCP \`claim\` object carry \`heldBy\`,
\`lastActivityAt\`, \`heldSeconds\`, \`idleSeconds\`. That is how you tell an agent
that is working from one a usage limit killed hours ago.

Taking over is **explicit and opt-in**:

\`\`\`bash
staple checkout ${ref} --steal-if-stale 2h    # take over a holder silent >= 2h
staple release ${ref} --if-stale 2h           # or just free the claim
\`\`\`

Durations: \`90s\`, \`30m\`, \`2h\`, \`3d\`, or a bare number of seconds. A takeover
logs \`claim_stolen\` / \`claim_released_stale\` with the previous holder and their
last activity, so the trail shows who took what from whom.

The rules, and they do not bend:

- **Only when a human says "continue."** These flags are affordances for a
  person resuming work, not a policy you apply on your own initiative. Never
  steal because a task looks abandoned and you are idle.
- **Nothing is automatic.** No sweeper, no daemon, no TTL. A claim never expires
  on its own; staleness is information, not a verdict.
- **Blockers still win.** A steal is refused while dependencies are unresolved,
  however dead the holder looks. Stale is not a bypass.
- **A plain checkout of a stale claim is still refused** — by name, with the
  holder's last activity. That refusal is telling you to pick another task, not
  to escalate to \`--steal-if-stale\`.

When you do resume someone's task, read their \`worklog\` and their branch pointer
comment first. That is what they left you. Leave the same for the next one.

## Wiring

\`\`\`bash
claude mcp add staple -e STAPLE_AGENT=your-name -- npx tsx ${mcpEntryPath()}
\`\`\`

The MCP tools mirror the CLI: \`inbox\`, \`checkout_task\` (with
\`steal_if_idle_seconds\`), \`put_document\`, \`add_comment\`, \`update_task\`,
\`release_task\` (with \`if_idle_seconds\`), \`events_since\`, \`list_statuses\`,
\`list_kinds\`, \`update_statuses\`, \`update_kinds\`, and the gate verbs
\`gate_task\` / \`approve_task\` / \`request_changes\`. Writes require an
identity — pass \`actor\` or set \`STAPLE_AGENT\`; there is no silent default.

---

*Generated by \`staple init\`. Edit it freely — re-running \`init\` will not
overwrite your changes.*
`;
}

export interface AgentsGuideResult {
  /** Where the guide lives (or would live). */
  path: string;
  /** false when a file was already there and was left exactly as it was. */
  written: boolean;
}

/**
 * Write the guide beside a repo workspace's db, **never clobbering** an existing
 * file. Init runs every time someone re-registers a workspace; an operator's
 * edits to this file outrank the template, always.
 */
export function writeAgentsGuide(workspaceDir: string, context: AgentsGuideContext): AgentsGuideResult {
  const path = join(workspaceDir, AGENTS_GUIDE_FILENAME);
  if (existsSync(path)) return { path, written: false };
  writeFileSync(path, renderAgentsGuide(context), "utf8");
  return { path, written: true };
}
