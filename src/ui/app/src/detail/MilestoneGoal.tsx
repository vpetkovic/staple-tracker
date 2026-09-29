/**
 * THE MILESTONE'S GOAL, on its own detail: where "Done when" is on every other issue.
 *
 * A milestone's acceptance criteria are its goal (design/milestones.md "Goal"), and the goal
 * check weighs each one at every read: met, not met, or unknown, with the evidence it rests
 * on. So a milestone's criteria are not a static checklist; each row says what the check
 * says, the evidence as links (a ticket opens the ticket, a document opens it on that
 * ticket's Documents tab), who marked it and when, and, for an unknown one, why.
 *
 * Then the pace against the target date (the check's verdict and its numbers, in words),
 * the milestone's gate (whose approval it waits for, and whether a goal run or a person
 * asked for it), and the goal run working it, if any.
 *
 * Every word comes from lib/goal-text.ts over `milestonePlan.goal`; nothing is judged here.
 */
import { CircleCheck, CircleHelp, CircleX, FileText, ShieldCheck } from "lucide-react";
import { RunStatePill } from "@/components/autopilot/RunParts";
import {
  CRITERION_TONE,
  CRITERION_WORDS,
  PACE_TONE,
  PACE_WORDS,
  shownPace,
  gateText,
  goalSummary,
  markedByText,
  paceText,
  unknownText,
  unplannedText,
} from "@/lib/goal-text";
import { endedStateText, isLiveRun, liveStateText, tickets } from "@/lib/run-text";
import { useRuns } from "@/lib/runs";
import { useSession } from "@/lib/session";
import { statusLabel } from "@/lib/settings";
import { openRunHistory } from "@/lib/shell-events";
import type { CriterionVerdict, EvidenceItem, GoalCriterion, IssueGate, MilestoneView, RunEntry } from "@/lib/types";
import { DetailCard, SectionHeading, cn, useNow } from "./parts";
import { openDetailTab, openTabOnArrival } from "./tabs/registry";

const VERDICT_ICON: Record<CriterionVerdict, typeof CircleCheck> = { met: CircleCheck, unmet: CircleX, unknown: CircleHelp };

const statusWord = (status: string) => statusLabel(status as Parameters<typeof statusLabel>[0]);

/**
 * Follow a piece of evidence. Another ticket opens (on its Documents tab, the document pinned,
 * for a document). The milestone's own document switches the open panel's tab in place: the
 * panel does not remount for the issue already open, so an arrival request would wait
 * unconsumed and later land on the wrong visit.
 */
export function openEvidence(item: Pick<EvidenceItem, "kind" | "ref" | "document">, openRef: string, open: (ref: string) => void): void {
  if (item.ref === null) return;
  const document = item.kind === "document" ? item.document : null;
  if (item.ref === openRef) {
    if (document) openDetailTab("documents", document, item.ref);
    return;
  }
  if (document) openTabOnArrival(item.ref, "documents", document);
  open(item.ref);
}

/** One piece of evidence: a ticket or a document as a link, text as a quote. */
function Evidence({ item, workspace, openRef }: { item: EvidenceItem; workspace: string; openRef: string }) {
  const session = useSession();
  if (item.kind === "text" || item.ref === null) {
    return (
      <li data-evidence="text" className="min-w-0 text-body text-text-secondary wrap-anywhere">
        “{item.value}”
      </li>
    );
  }
  const ref = item.ref;
  const open = () => openEvidence(item, openRef, (target) => session.open(workspace, target));
  const label = item.kind === "document" ? `${ref} · ${item.document}` : ref;
  const state = item.kind === "ticket" && item.status ? statusWord(item.status) : null;
  return (
    <li data-evidence={item.kind} data-evidence-holds={String(item.holds)}>
      <button
        type="button"
        onClick={open}
        aria-label={state ? `${label}, ${state}` : label}
        title={item.kind === "document" ? `Open the "${item.document}" document on ${ref}` : `Open ${ref}`}
        className="focus-ring inline-flex min-h-7 max-w-full items-center gap-1 rounded-md border border-border bg-surface-sunken px-1.5 text-label text-foreground hover:bg-surface-hover pointer-coarse:min-h-10"
      >
        {item.kind === "document" ? <FileText aria-hidden className="size-3.5 shrink-0 text-text-tertiary" /> : null}
        <span className="truncate font-medium">{label}</span>
        {state ? <span className="shrink-0 text-text-secondary">· {state}</span> : null}
      </button>
    </li>
  );
}

/** One criterion: the verdict (glyph and word), the text, the evidence, who marked it, why unknown. */
export function CriterionRow({ criterion, workspace, openRef, now }: { criterion: GoalCriterion; workspace: string; openRef: string; now: Date }) {
  const Icon = VERDICT_ICON[criterion.verdict];
  const tone = CRITERION_TONE[criterion.verdict];
  const why = unknownText(criterion, statusWord);
  const marked = markedByText(criterion, now);
  return (
    <li data-goal-criterion={criterion.position} data-verdict={criterion.verdict} className="flex min-w-0 items-start gap-3 py-2.5">
      <Icon aria-hidden className="mt-[3px] size-4 shrink-0" style={{ color: `var(--plain-${tone}-fg)` }} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1 basis-48 text-reading text-foreground text-pretty wrap-anywhere">{criterion.text}</span>
          <RunStatePill text={CRITERION_WORDS[criterion.verdict]} tone={tone} />
        </div>
        {why ? (
          <p className="m-0 text-body text-text-secondary wrap-anywhere" data-goal-why="">
            {why}
          </p>
        ) : null}
        {criterion.evidence.length > 0 ? (
          <ul aria-label="Evidence" className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0">
            {criterion.evidence.map((item, i) => (
              <Evidence key={i} item={item} workspace={workspace} openRef={openRef} />
            ))}
          </ul>
        ) : null}
        {criterion.note ? <p className="m-0 text-body text-text-secondary wrap-anywhere">{criterion.note}</p> : null}
        {marked ? (
          <p className="m-0 text-label text-text-tertiary" data-goal-marked="">
            {marked}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** The newest goal run over this milestone, live first; null when none was ever run here. */
export function goalRunOf(entries: readonly RunEntry[], workspace: string, milestoneId: string): RunEntry | null {
  const over = entries.filter((entry) => entry.workspace === workspace && entry.run.scope.kind === "milestone" && entry.run.scope.issueId === milestoneId);
  return over.find((entry) => isLiveRun(entry.run)) ?? over[0] ?? null;
}

/** "opus's goal run: Working · created 1 of 5 tickets it may" — or how the last one ended. */
function GoalRunLine({ entry }: { entry: RunEntry }) {
  const live = isLiveRun(entry.run);
  const state = live ? liveStateText(entry) : endedStateText(entry.run);
  const children = entry.goal?.children ?? (entry.run.goal ? { created: entry.run.goal.children.length, cap: entry.run.goal.childCap } : null);
  return (
    <div data-goal-run={entry.run.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary">
      <span className="text-foreground">{live ? `${entry.run.actor}'s goal run` : `Last goal run (${entry.run.actor})`}</span>
      <RunStatePill text={state.text} tone={state.tone} wrap />
      {children ? <span>created {children.created} of {tickets(children.cap)} it may</span> : null}
      <button
        type="button"
        onClick={() => openRunHistory({ runId: entry.run.id })}
        className="rounded-sm text-body font-medium text-foreground underline underline-offset-2 hover:no-underline focus-ring pointer-coarse:min-h-11"
      >
        See the run
      </button>
    </div>
  );
}

/** "Goal": the criteria as the check reads them, then pace, gate and goal run. */
export function MilestoneGoalSection({ plan, gate, workspace }: { plan: MilestoneView; gate: IssueGate | null; workspace: string }) {
  const now = useNow();
  const { entries } = useRuns();
  const { goal } = plan;
  // Judged on the reader's local day, as the rest of the page is (`shownPace`).
  const pace = shownPace(goal.pace, now);
  const run = goalRunOf(entries, workspace, plan.milestone.id);
  const unplanned = unplannedText(goal.pace);
  const gateWords = gate ? gateText(gate, now) : null;
  return (
    <section aria-label="Goal" className="mt-8" data-milestone-goal="" data-goal-met={String(goal.met)}>
      <SectionHeading action={goal.counts.total > 0 ? <span className="text-text-tertiary">{`${goal.counts.met}/${goal.counts.total} met`}</span> : null}>
        Goal
      </SectionHeading>
      <p className="m-0 mb-2 text-reading text-foreground" data-goal-summary="">
        {goalSummary(goal.counts)}
      </p>
      {goal.criteria.length > 0 ? (
        <ul aria-label="Criteria" className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">
          {goal.criteria.map((criterion) => (
            <CriterionRow key={criterion.position} criterion={criterion} workspace={workspace} openRef={plan.milestone.identifier} now={now} />
          ))}
        </ul>
      ) : null}

      <DetailCard className="mt-3 flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1" data-goal-pace={pace.verdict}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-label font-medium text-text-secondary">Pace</span>
            <RunStatePill text={PACE_WORDS[pace.verdict]} tone={PACE_TONE[pace.verdict]} />
          </div>
          <p className="m-0 text-body text-foreground text-pretty">{paceText(goal.pace, now)}</p>
          {unplanned ? <p className="m-0 text-label text-text-tertiary">{unplanned}</p> : null}
        </div>
        {gateWords ? (
          <div className={cn("flex min-w-0 items-start gap-2 border-t pt-3")} data-goal-gate={gate!.state} data-goal-gate-by={gate!.requestedBy?.startsWith("goal-run:") ? "goal-run" : "person"}>
            <ShieldCheck aria-hidden className="mt-[3px] size-4 shrink-0 text-text-secondary" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="m-0 text-body text-foreground">{gateWords.text}</p>
              {gateWords.detail ? <p className="m-0 text-label text-text-tertiary">{gateWords.detail}</p> : null}
            </div>
          </div>
        ) : null}
        {run ? (
          <div className="border-t pt-3">
            <GoalRunLine entry={run} />
          </div>
        ) : null}
      </DetailCard>
    </section>
  );
}
