/**
 * One idea, opened from a card, a timeline row or a sub-idea: a panel on the right from the
 * desk breakpoint, the whole screen below it.
 *
 * What a person sets is editable here (title, maturity, horizon, parent, planned dates,
 * brief, questions, decisions) and so are the links into the tracker: Start creates an epic
 * with the brief as its plan document, Adopt links an existing issue, Unlink removes one.
 * What is derived (stage, progress, actual dates, lateness) is shown and never edited. The
 * baseline appears once the idea is started and resets only from its own button.
 */
import { ArrowLeft, Link2, Rocket, RotateCcw, Unlink, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { IdeaDetailData, PlanData, Stage } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { Chip, Progress, type Write } from "./PlanBoards";
import { MATURITY_COLUMNS, dayLabel, descendantsOf } from "./plan-model";

const LADDER: readonly Stage[] = ["raw", "exploring", "shaped", "scheduled", "started", "shipped"];

export function IdeaDetail({ plan, detail, write, onClose, onOpen }: { plan: PlanData; detail: IdeaDetailData; write: Write; onClose: () => void; onOpen: (id: string) => void }) {
  const desk = useIsDesk();
  const { idea } = detail;
  const ref = idea.id;
  const [title, setTitle] = useState(idea.title);
  const [brief, setBrief] = useState(detail.brief ?? "");
  useEffect(() => setTitle(idea.title), [idea.title]);
  useEffect(() => setBrief(detail.brief ?? ""), [detail.brief]);
  const started = idea.stage === "started" || idea.stage === "shipped";
  const below = new Set(descendantsOf(plan, idea).map((other) => other.id));
  const parents = plan.ideas.filter((other) => other.id !== idea.id && !below.has(other.id) && other.maturity !== "dropped");
  const save = (body: Record<string, unknown>) => void write("update", { ref, ...body });

  return (
    <aside
      aria-label={`Idea ${idea.title}`}
      data-plan-detail={idea.identifier}
      className={cn("z-40 flex flex-col bg-card", desk ? "absolute inset-y-0 right-0 w-[28rem] max-w-full border-l shadow-lg" : "fixed inset-0")}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {desk ? null : (
          <Button variant="ghost" size="icon" className="size-10" aria-label="Back to the plan" onClick={onClose}>
            <ArrowLeft aria-hidden />
          </Button>
        )}
        <form
          className="min-w-0 flex-1"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (title.trim() && title.trim() !== idea.title) save({ title: title.trim() });
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() && title.trim() !== idea.title && save({ title: title.trim() })}
            aria-label="Title"
            className="h-9 border-transparent px-1 text-title font-semibold shadow-none focus-visible:border-input"
          />
        </form>
        <span className="shrink-0 font-mono text-caption text-text-tertiary" data-plan-detail-id>{idea.identifier}</span>
        {desk ? (
          <Button variant="ghost" size="icon" className="size-9" aria-label="Close" onClick={onClose}>
            <X aria-hidden />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section label="Stage">
          <ol className="flex flex-wrap gap-1 text-caption" data-plan-ladder>
            {LADDER.map((stage, index) => {
              const at = LADDER.indexOf(idea.stage);
              return (
                <li
                  key={stage}
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    index < at && "border-transparent bg-muted text-text-secondary",
                    index === at && "border-primary bg-primary text-primary-foreground",
                    index > at && "text-text-tertiary",
                  )}
                >
                  {stage}
                </li>
              );
            })}
            {idea.stage === "dropped" ? <li className="rounded-full border border-destructive/60 px-2 py-0.5 text-destructive">dropped</li> : null}
          </ol>
          <div className="mt-2 flex flex-wrap gap-1.5 text-caption">
            {idea.late ? <Chip tone="red">late</Chip> : null}
            {idea.notStarted ? <Chip tone="amber">not started</Chip> : null}
          </div>
        </Section>

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-label">
          <span className="text-text-tertiary">Maturity</span>
          <select className="h-9 rounded-md border bg-field px-2" value={idea.maturity} onChange={(event) => save({ maturity: event.target.value })} data-plan-detail-maturity>
            {MATURITY_COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>{column.title}</option>
            ))}
            <option value="dropped">Dropped</option>
          </select>
          <span className="text-text-tertiary">Horizon</span>
          <select className="h-9 rounded-md border bg-field px-2" value={idea.horizonId ?? ""} onChange={(event) => save({ horizon: event.target.value || null })} data-plan-detail-horizon>
            <option value="">Unscheduled</option>
            {plan.horizons.map((horizon) => (
              <option key={horizon.id} value={horizon.id}>{horizon.name}{horizon.date ? ` · ${dayLabel(horizon.date)}` : ""}</option>
            ))}
          </select>
          <span className="text-text-tertiary">Part of</span>
          <select className="h-9 rounded-md border bg-field px-2" value={idea.parentId ?? ""} onChange={(event) => save({ parent: event.target.value || null })} data-plan-detail-parent>
            <option value="">Nothing (top level)</option>
            {parents.map((other) => (
              <option key={other.id} value={other.id}>{other.title}</option>
            ))}
          </select>
          <span className="text-text-tertiary">Planned</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <input type="date" aria-label="Planned start" className="h-9 rounded-md border bg-field px-2" value={idea.planned.start ?? ""} max={idea.planned.target ?? undefined} onChange={(event) => save({ plannedStart: event.target.value || null })} data-plan-detail-start />
            <span className="text-text-tertiary">to</span>
            <input type="date" aria-label="Planned target" className="h-9 rounded-md border bg-field px-2" value={idea.planned.target ?? ""} min={idea.planned.start ?? undefined} onChange={(event) => save({ plannedTarget: event.target.value || null })} data-plan-detail-target />
          </div>
          {idea.baseline ? (
            <>
              <span className="text-text-tertiary">Baseline</span>
              <div className="flex flex-wrap items-center gap-2" data-plan-detail-baseline>
                <span>{dayLabel(idea.baseline.start)} to {dayLabel(idea.baseline.target)}</span>
                <Button variant="ghost" size="sm" className="h-8" onClick={() => void write("reset-baseline", { ref })} data-plan-reset-baseline>
                  <RotateCcw aria-hidden />
                  Reset to the plan
                </Button>
              </div>
            </>
          ) : null}
          {started ? (
            <>
              <span className="text-text-tertiary">Actual</span>
              <span>
                {idea.actual.start ? dayLabel(idea.actual.start) : "not begun"}
                {" to "}
                {idea.actual.end ? dayLabel(idea.actual.end) : idea.actual.forecastEnd ? `about ${dayLabel(idea.actual.forecastEnd)} (forecast)` : "open"}
              </span>
            </>
          ) : null}
        </div>

        <Section label="Brief">
          <Textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            onBlur={() => brief !== (detail.brief ?? "") && save({ brief })}
            placeholder="What is it, who is it for, what does done look like?"
            className="min-h-24"
            data-plan-detail-brief
          />
        </Section>

        <Section label="Open questions">
          <ul className="space-y-1">
            {detail.questions.map((question, index) => (
              <li key={`${index}-${question.text}`}>
                <label className={cn("flex min-h-8 items-start gap-2 text-label", question.resolved && "text-text-tertiary line-through")}>
                  <input type="checkbox" className="mt-1" checked={question.resolved} onChange={(event) => void write("resolve", { ref, position: index + 1, resolved: event.target.checked })} />
                  <span>{question.text}</span>
                </label>
              </li>
            ))}
          </ul>
          <AddLine placeholder="Add a question…" onAdd={(text) => write("question", { ref, text })} testId="question" />
        </Section>

        <Section label="Decisions">
          <ul className="space-y-1 text-label">
            {detail.decisions.map((decision, index) => (
              <li key={`${index}-${decision}`}>• {decision}</li>
            ))}
          </ul>
          <AddLine placeholder="Record a decision…" onAdd={(text) => write("decision", { ref, text })} testId="decision" />
        </Section>

        {detail.children.length > 0 ? (
          <Section label={`Sub-ideas (${detail.children.length})`}>
            <ul className="space-y-1">
              {detail.children.map((child) => (
                <li key={child.id}>
                  <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded px-1 text-left text-label hover:bg-surface-hover" onClick={() => onOpen(child.id)}>
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    {child.late ? <Chip tone="red">late</Chip> : child.notStarted ? <Chip tone="amber">not started</Chip> : <Chip>{child.stage}</Chip>}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section label="Work in the tracker">
          {idea.linkCount > 0 && idea.progress !== null ? <Progress value={idea.progress} /> : null}
          {detail.linked.length === 0 && idea.linkCount > 0 ? <p className="mt-1 text-caption text-text-tertiary">Linked through its sub-ideas.</p> : null}
          <ul className="mt-2 space-y-2">
            {detail.linked.map((link) => (
              <li key={link.id} className="rounded-md border px-2.5 py-2" data-plan-link={link.identifier}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-label"><span className="font-mono text-text-tertiary">{link.identifier}</span> {link.title}</div>
                    <div className="text-caption text-text-tertiary">
                      {link.status} · {link.doneLeaves}/{link.leaves} done{link.milestone ? ` · in ${link.milestone.title} (${link.milestone.state}${link.milestone.run ? `, run ${link.milestone.run.state}` : ""})` : ""}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Unlink ${link.identifier}`} onClick={() => void write("unlink", { ref, issue: link.id })} data-plan-unlink={link.identifier}>
                    <Unlink aria-hidden />
                  </Button>
                </div>
                <Progress value={link.progress} />
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-2 rounded-md border border-dashed p-3">
            {idea.maturity !== "shaped" && !started ? (
              <p className="text-caption text-[color:var(--status-task-todo)]">Still {idea.maturity}. Starting now skips shaping.</p>
            ) : null}
            <p className="text-caption text-text-tertiary">Start creates an epic and stores this brief on it as its plan. Adopt links work that already exists.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void write("start", { ref })} data-plan-start>
                <Rocket aria-hidden />
                Start as an epic
              </Button>
            </div>
            <AddLine placeholder="Adopt an issue by its identifier" onAdd={(issue) => write("adopt", { ref, issue })} testId="adopt" icon={<Link2 className="size-4" aria-hidden />} button="Adopt" />
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-text-tertiary">{label}</h3>
      {children}
    </section>
  );
}

function AddLine({ placeholder, onAdd, testId, icon, button }: { placeholder: string; onAdd: (text: string) => Promise<boolean>; testId: string; icon?: ReactNode; button?: string }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-1.5 flex items-center gap-2"
      data-plan-add={testId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() && (await onAdd(text.trim()))) setText("");
      }}
    >
      {icon}
      <Input value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-9" />
      {button ? <Button type="submit" size="sm" variant="outline">{button}</Button> : null}
    </form>
  );
}
