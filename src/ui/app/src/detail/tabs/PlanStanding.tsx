/**
 * "Where it stands": the first thing in an idea's Plan tab, and what changes with its state. The
 * lifecycle track; then, while it is being shaped, what shaping still needs (the server's
 * `missingForShaped`, verbatim); once shaped, the scaffold it is ready for; once started, how far
 * its work has come. Then its open questions, answered or deferred in place, and the person's
 * delivered mark. Every count, percent and state is the payload's; every button is an offered
 * action's.
 */
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown";
import type { IdeaData, IdeaDetailData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { dayLabel } from "@/views/plan/plan-model";
import { Flag, SegmentedBar, StateGlyph } from "@/views/plan/plan-parts";
import { offers } from "../plain-actions";
import { STATE_WORDS, type PlanWrite } from "../plan-record";
import { DeliveredMark, ShippedCheck, ShippedMark } from "../ShippedMark";
import { AddLine, ScaffoldSection } from "./PlanSections";
import { capitalised, estimateHours, planSectionsOf, type PlanSectionId } from "./plan-tab-model";

/** The lifecycle as phases: thinking until work exists, then started, then shipped. */
const PHASES = [
  { id: "thinking", label: "Thinking" },
  { id: "started", label: "Started" },
  { id: "shipped", label: "Shipped" },
] as const;

export interface ScaffoldControl {
  open: boolean;
  onToggle: () => void;
  onConfirm: (fingerprint: string) => void;
  busy: boolean;
}

export function WhereItStands({ record, write, scaffold, onJump }: { record: IdeaDetailData; write: PlanWrite; scaffold: ScaffoldControl; onJump: (id: PlanSectionId) => void }) {
  const { idea } = record;
  return (
    <section aria-label="Where it stands" className="rounded-xl border bg-surface-sunken px-4 py-3.5" data-plan-standing={idea.state}>
      <Track idea={idea} />
      {idea.state === "raw" || idea.state === "exploring" ? <ShapeChecklist record={record} onJump={onJump} /> : null}
      <Proposal idea={idea} write={write} />
      {idea.state === "shaped" ? <Shaped record={record} /> : null}
      {idea.state === "started" || idea.state === "shipped" ? <Underway record={record} onJump={onJump} /> : null}
      {idea.planIncomplete.length > 0 ? (
        <p className="m-0 mt-2 text-label text-flag-todo" data-plan-incomplete>
          Shaped · plan incomplete: {idea.planIncomplete.slice(0, 5).join("; ")}
          {idea.planIncomplete.length > 5 ? `; and ${idea.planIncomplete.length - 5} more` : ""}. Scaffold and Promote wait until it passes again.
        </p>
      ) : null}
      {record.scaffold ? <ScaffoldSection preview={record.scaffold} {...scaffold} /> : null}
      <Delivered record={record} write={write} />
      <Questions record={record} write={write} />
    </section>
  );
}

function Track({ idea }: { idea: IdeaData }) {
  // Its own state, as every lens reads it: the rollup and the horizon never move the phase.
  const phase = idea.state === "shipped" ? "shipped" : idea.state === "started" ? "started" : "thinking";
  const at = PHASES.findIndex((entry) => entry.id === phase);
  return (
    <ol aria-label="Lifecycle" className="m-0 flex list-none flex-wrap items-center gap-y-1 p-0 text-label text-text-tertiary" data-plan-phases={phase}>
      {idea.state === "dropped" ? (
        <li className="inline-flex items-center gap-1.5 font-semibold text-destructive">
          <StateGlyph state="dropped" />
          Dropped
        </li>
      ) : (
        PHASES.map((entry, index) => (
          <li key={entry.id} className="inline-flex items-center gap-1.5" aria-current={index === at ? "step" : undefined}>
            {index > 0 ? <span aria-hidden className="staple-plan-track-rule h-px bg-border-strong" /> : null}
            {index === at ? (
              <StateGlyph state={idea.state} percent={idea.percent} />
            ) : (
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full border-[1.5px] border-border-strong", index < at && "border-text-secondary bg-text-secondary")} />
            )}
            <span className={cn("whitespace-nowrap", index === at && "font-semibold text-foreground")}>
              {entry.label}
              {entry.id === "thinking" && index === at ? ` · ${STATE_WORDS[idea.maturity]?.toLowerCase() ?? idea.maturity}` : ""}
            </span>
          </li>
        ))
      )}
    </ol>
  );
}

function Heading({ title, words }: { title: ReactNode; words?: ReactNode }) {
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <span className="text-title font-semibold text-foreground">{title}</span>
      {words ? <span className="text-label text-text-secondary">{words}</span> : null}
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What shaping still needs: the required sections written, each a way to it, then every entry the server lists. */
function ShapeChecklist({ record, onJump }: { record: IdeaDetailData; onJump: (id: PlanSectionId) => void }) {
  const missing = record.missingForShaped;
  const written = planSectionsOf(record).filter((entry) => entry.star && entry.filled);
  return (
    <>
      <Heading title={missing.length > 0 ? "To shape it" : "Ready to mark shaped"} words={missing.length > 0 ? `${plural(missing.length, "thing")} left` : "The plan passes the gate."} />
      <ul className="m-0 mt-2 grid list-none grid-cols-2 gap-x-4 gap-y-1.5 p-0 @max-[512px]/plantab:grid-cols-1" data-plan-missing={missing.length > 0 ? "" : undefined}>
        {written.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2 text-body text-text-secondary">
            <ShippedCheck label="" className="size-3.5 [&_svg]:size-2.5" />
            <button type="button" className="focus-ring min-h-0 rounded-sm text-left hover:text-foreground hover:underline pointer-coarse:min-h-8" onClick={() => onJump(entry.id)} data-plan-jump={entry.id}>
              {entry.id === "breakdown" ? `${entry.heading} (${plural(entry.count ?? 0, "task")})` : entry.heading}
            </button>
          </li>
        ))}
        {missing.map((item) => (
          <li key={item} className="flex items-start gap-2 text-body font-medium text-foreground" data-plan-missing-item="">
            <span aria-hidden className="mt-0.5 size-3.5 shrink-0 rounded-full border-[1.6px] border-[color:var(--status-task-icon-todo)]" />
            {capitalised(item)}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * An agent's standing proposal that it is ready to be marked shaped: who proposed it, when and
 * why, and the person's answer in one action. Accept is the offered Mark shaped, held back with
 * its reason while the plan fails the gate; Dismiss sets the proposal aside.
 */
function Proposal({ idea, write }: { idea: IdeaData; write: PlanWrite }) {
  const proposal = idea.shapeProposal;
  if (!proposal) return null;
  const shape = idea.actions.find((action) => action.id === "shape");
  return (
    <div className="mt-3 rounded-lg border bg-surface px-3 py-2.5" data-plan-proposal="">
      <p className="m-0 text-body text-text-secondary">
        <Flag tone="you" className="mr-2 align-[1px]">
          proposed shaped
        </Flag>
        <span className="font-medium text-foreground">{proposal.by ?? "An agent"}</span> proposed it shaped on {dayLabel(proposal.at.slice(0, 10), false)}
        {proposal.note ? <>: {proposal.note}</> : "."}
      </p>
      {shape?.disabledReason ? (
        <p className="m-0 mt-1 text-label text-flag-todo" data-plan-proposal-held="">
          {shape.disabledReason}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={!shape || Boolean(shape.disabledReason)} title={shape?.disabledReason} onClick={() => void write("update", { ref: idea.id, maturity: "shaped" })} data-plan-proposal-accept="">
          Accept shaped
        </Button>
        <Button size="sm" variant="outline" onClick={() => void write("update", { ref: idea.id, dismissProposal: true })} data-plan-proposal-dismiss="">
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** Shaped: ready to become an epic with tickets, the preview opening below. */
function Shaped({ record }: { record: IdeaDetailData }) {
  const tasks = record.scaffold?.tasks.length ?? record.plan.breakdown.length;
  const hours = estimateHours(record.plan.breakdown);
  const size = tasks > 0 ? `${plural(tasks, "task")}${hours ? ` · ${hours}` : ""}` : null;
  if (!record.scaffold) return <Heading title="Shaped" words={size ? `${size} planned` : undefined} />;
  return <Heading title="Ready to scaffold" words={size ? `${size} become an epic with tickets` : undefined} />;
}

/** Started or shipped: how far its work has come, when, and whether it is late. */
function Underway({ record, onJump }: { record: IdeaDetailData; onJump: (id: PlanSectionId) => void }) {
  const { idea } = record;
  const shipped = idea.state === "shipped";
  const { units } = idea;
  const words = units.total > 0 ? `${units.done} done · ${units.open} open${units.planned > 0 ? ` · ${units.planned} planned` : ""}` : null;
  const when = [
    idea.actual.start ? `started ${dayLabel(idea.actual.start, false)}` : null,
    shipped ? (idea.actual.end ? `shipped ${dayLabel(idea.actual.end, false)}` : null) : idea.actual.forecastEnd ? `forecast ${dayLabel(idea.actual.forecastEnd, false)}` : null,
    idea.planned.target ? `planned to ${dayLabel(idea.planned.target, false)}` : null,
  ].filter((part): part is string => part !== null);
  const shape = idea.actions.find((action) => action.id === "shape");
  return (
    <>
      {shipped && idea.delivered ? (words ? <Heading title="Its work" words={words} /> : null) : <Heading title={shipped ? <ShippedMark on={idea.actual.end} withYear className="font-semibold" /> : "Work is under way"} words={words} />}
      {idea.percent !== null && units.total > 0 ? <SegmentedBar units={units} percent={idea.percent} complete={shipped} size="lg" className="mt-2.5" /> : null}
      {when.length > 0 || idea.late ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-secondary" data-plan-when>
          {when.length > 0 ? <span>{capitalised(when.join(" · "))}</span> : null}
          {idea.late ? shipped ? <span>later than planned</span> : <Flag tone="late" /> : null}
        </div>
      ) : null}
      {shape && idea.maturity !== "shaped" ? (
        // Wherever Mark shaped is offered, say what it still needs; with nothing missing and nothing holding it, say it can be.
        record.missingForShaped.length > 0 ? (
          <div className="mt-3 border-t pt-0.5">
            <ShapeChecklist record={record} onJump={onJump} />
          </div>
        ) : !shape.disabledReason ? (
          <p className="m-0 mt-2.5 text-label text-text-secondary" data-plan-shape-note>
            It started while still exploring. Its plan passes the gate, so you can mark it shaped.
          </p>
        ) : null
      ) : null}
    </>
  );
}

/** The person's mark that it was delivered outside the tracker: its day, its note, and the clear where offered. */
function Delivered({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const { idea } = record;
  const [busy, setBusy] = useState(false);
  if (!idea.delivered) return null;
  const clear = async () => {
    setBusy(true);
    await write("update", { ref: idea.id, delivered: null });
    setBusy(false);
  };
  return (
    <div className="mt-3" data-plan-delivered-mark="">
      <DeliveredMark on={idea.delivered.on} className="text-body" />
      {idea.delivered.note ? <Markdown text={idea.delivered.note} className="staple-detail-prose staple-plan-prose mt-1.5" /> : null}
      {offers(idea, "clear_delivered") ? (
        <Button variant="outline" size="sm" className="mt-2 bg-card" disabled={busy} onClick={() => void clear()} data-plan-action="clear_delivered">
          Clear the delivered mark
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The questions, open ones first and in full: Answered and Defer (or Undefer) each write what
 * the old checkbox and Defer wrote, at the question's own position. Answered ones fold behind
 * their count. Nothing is offered where the state does not offer asking.
 */
function Questions({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const [showAnswered, setShowAnswered] = useState(false);
  const { idea } = record;
  const ref = idea.id;
  const asks = offers(idea, "ask");
  if (!asks && record.questions.length === 0) return null;
  const entries = record.questions.map((question, index) => ({ ...question, position: index + 1 }));
  const open = entries.filter((question) => !question.resolved);
  const answered = entries.filter((question) => question.resolved);
  return (
    <div className="mt-4 border-t pt-3" data-plan-section="questions">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-body font-semibold text-foreground">Open questions</h3>
        {idea.openQuestions > 0 ? <Flag tone="notStarted">{idea.openQuestions} to answer</Flag> : <span className="text-label text-text-tertiary">none open</span>}
      </div>
      {open.length > 0 ? (
        <ul className="m-0 mt-1 list-none p-0">
          {open.map((question) => (
            <li key={question.position} className="staple-plan-question grid items-start gap-x-2.5 gap-y-1.5 border-t py-2 first:border-t-0" data-plan-question={question.position}>
              <span aria-hidden className="mt-[7px] ml-[3px] size-2 rounded-full bg-[color:var(--status-task-icon-todo)]" />
              <p className="staple-plan-question-text m-0 min-w-0 text-foreground">
                {question.text}
                {question.deferred ? <span className="ml-1.5 text-label text-text-tertiary">(deferred)</span> : null}
              </p>
              {asks ? (
                <span className="staple-plan-question-actions flex gap-1">
                  <Button variant="outline" size="sm" className="bg-card pointer-coarse:h-9" onClick={() => void write("resolve", { ref, position: question.position, resolved: true })} data-plan-answer={question.position}>
                    Answered
                  </Button>
                  <Button variant="ghost" size="sm" className="pointer-coarse:h-9" onClick={() => void write("resolve", { ref, position: question.position, deferred: !question.deferred })} data-plan-defer={question.position}>
                    {question.deferred ? "Undefer" : "Defer"}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {asks || answered.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {asks ? <AddLine placeholder="Add a question…" onAdd={(text) => write("question", { ref, text })} testId="question" className="min-w-[200px] flex-1" /> : null}
          {answered.length > 0 ? (
            <Button variant="ghost" size="sm" className="text-text-secondary" aria-expanded={showAnswered} onClick={() => setShowAnswered((value) => !value)} data-plan-answered-toggle>
              {answered.length} answered
              <ChevronDown aria-hidden className={cn("size-3.5", !showAnswered && "-rotate-90")} />
            </Button>
          ) : null}
        </div>
      ) : null}
      {showAnswered ? (
        <ul className="m-0 mt-1 list-none p-0" data-plan-answered>
          {answered.map((question) => (
            <li key={question.position} className="flex items-start gap-2.5 py-1.5 text-body text-text-tertiary" data-plan-question={question.position}>
              <ShippedCheck label="" className="mt-0.5 size-3.5 opacity-70 [&_svg]:size-2.5" />
              <p className="m-0 min-w-0 flex-1">{question.text}</p>
              {asks ? (
                <Button variant="ghost" size="sm" className="-my-1 h-7 text-label" onClick={() => void write("resolve", { ref, position: question.position, resolved: false })} data-plan-reopen={question.position}>
                  Reopen
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
