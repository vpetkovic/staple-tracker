/**
 * The Plan tab: an idea's plan as the person shapes it, in the shared drawer.
 *
 * Every editor here renders only when the record's lifecycle state offers its action
 * (`offers`, from the core table through the payload): a raw idea shows no horizon or dates to
 * set, a shipped one shows its plan read-only, and nothing is offered that the store would
 * refuse. Maturity moves and promotion are the header's buttons; this tab holds the editors that
 * need input: the plan sections an agent scaffolds from (PlanSections.tsx), and Scaffold's
 * preview and confirm. What is derived (stage, progress, actual dates, lateness) is shown, never
 * edited.
 */
import { Link2, Unlink } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getPlan } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { IdeaDetailData, PlanData } from "@/lib/plan-types";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { Chip, Progress } from "@/views/plan/PlanBoards";
import { ShippedMark } from "../ShippedMark";
import { dayLabel, descendantsOf } from "@/views/plan/plan-model";
import { offers } from "../plain-actions";
import { STATE_WORDS, onScaffoldRequest, planRecordOf, usePlanWrite, type PlanWrite } from "../plan-record";
import { Completeness, EditButton, PlanSectionsView, ScaffoldSection, Section, useProse } from "./PlanSections";
import type { TabProps } from "./registry";

/**
 * The lifecycle as phases: thinking until work exists, then started, then shipped. Maturity and
 * the horizon are separate facts shown below it, so being scheduled never reads as being further
 * along than exploring.
 */
const PHASES = [
  { id: "thinking", label: "Thinking" },
  { id: "started", label: "Started" },
  { id: "shipped", label: "Shipped" },
] as const;

export function PlanTab({ detail, workspace, onAuthError, refresh }: TabProps) {
  const record = planRecordOf(detail);
  const session = useSession();
  const loadPlan = useCallback(() => getPlan({ ws: workspace }), [workspace]);
  const plan = useResource(loadPlan, [workspace, session.version], onAuthError).data ?? null;
  const { write, refusal } = usePlanWrite(workspace, refresh);
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The header's Scaffold opens the preview here: it is never a one-click write.
  useEffect(() => onScaffoldRequest(() => setScaffoldOpen(true)), []);
  if (!record) return null;
  const scaffold = async (fingerprint: string) => {
    setBusy(true);
    if (await write("scaffold", { ref: record.idea.id, fingerprint })) setScaffoldOpen(false);
    setBusy(false);
  };
  return (
    <div className="space-y-6" data-plan-tab={record.idea.id} data-plan-state={record.idea.state}>
      {refusal ? <GuardRefusal refusal={refusal} /> : null}
      <Stage record={record} />
      <Completeness record={record} />
      {record.scaffold ? <ScaffoldSection preview={record.scaffold} open={scaffoldOpen} onToggle={() => setScaffoldOpen((open) => !open)} onConfirm={(fingerprint) => void scaffold(fingerprint)} busy={busy} /> : null}
      <Fields record={record} plan={plan} write={write} />
      <Brief record={record} write={write} />
      <PlanSectionsView record={record} write={write} />
      <Questions record={record} write={write} />
      <Decisions record={record} write={write} />
      <SubIdeas record={record} workspace={workspace} />
      <Work record={record} write={write} />
    </div>
  );
}

function Stage({ record }: { record: IdeaDetailData }) {
  const { idea } = record;
  // Its own state, as every lens reads it: the rollup and the horizon never move the phase.
  const phase = idea.state === "shipped" ? "shipped" : idea.state === "started" ? "started" : "thinking";
  const at = PHASES.findIndex((entry) => entry.id === phase);
  return (
    <Section label="Stage" testId="stage">
      <ol className="flex flex-wrap gap-1 text-caption" data-plan-phases={phase}>
        {idea.state === "dropped" ? (
          <li className="rounded-full border border-destructive/60 px-2 py-0.5 text-destructive">dropped</li>
        ) : (
          PHASES.map((entry, index) => (
            <li
              key={entry.id}
              className={cn(
                "rounded-full border px-2 py-0.5",
                index < at && "border-transparent bg-muted text-text-secondary",
                index === at && "border-primary bg-primary text-primary-foreground",
                index > at && "text-text-tertiary",
              )}
            >
              {entry.label}
              {entry.id === "thinking" && index === at ? ` · ${STATE_WORDS[idea.maturity]?.toLowerCase() ?? idea.maturity}` : ""}
            </li>
          ))
        )}
      </ol>
      <div className="mt-2 flex flex-wrap gap-1.5 text-caption">
        {idea.late ? <Chip tone="red">late</Chip> : null}
        {idea.notStarted ? <Chip tone="amber">not started</Chip> : null}
        {idea.state === "shipped" ? <ShippedMark on={idea.actual.end} withYear /> : null}
      </div>
    </Section>
  );
}

function Fields({ record, plan, write }: { record: IdeaDetailData; plan: PlanData | null; write: PlanWrite }) {
  const { idea } = record;
  const ref = idea.id;
  const save = (body: Record<string, unknown>) => void write("update", { ref, ...body });
  const below = new Set(plan ? descendantsOf(plan, idea).map((other) => other.id) : []);
  const parents = (plan?.ideas ?? []).filter((other) => other.id !== idea.id && !below.has(other.id) && other.state !== "dropped" && !other.promoted);
  const started = idea.stage === "started" || idea.stage === "shipped";
  const horizon = plan?.horizons.find((h) => h.id === idea.horizonId) ?? record.horizon;
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-label" data-plan-fields>
      <span className="text-text-tertiary">Maturity</span>
      <span data-plan-field="maturity">{STATE_WORDS[idea.maturity] ?? idea.maturity}</span>

      <span className="text-text-tertiary">Horizon</span>
      {offers(idea, "schedule") && plan ? (
        <select className="h-9 min-w-0 rounded-md border bg-field px-2" value={idea.horizonId ?? ""} onChange={(event) => save({ horizon: event.target.value || null })} data-plan-detail-horizon>
          <option value="">Unscheduled</option>
          {plan.horizons.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.date ? ` · ${dayLabel(option.date)}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <span data-plan-field="horizon">{horizon ? `${horizon.name}${horizon.date ? ` · ${dayLabel(horizon.date)}` : ""}` : "Unscheduled"}</span>
      )}

      <span className="text-text-tertiary">Part of</span>
      {offers(idea, "reparent") && plan ? (
        <select className="h-9 min-w-0 rounded-md border bg-field px-2" value={idea.parentId ?? ""} onChange={(event) => save({ parent: event.target.value || null })} data-plan-detail-parent>
          <option value="">Nothing (top level)</option>
          {parents.map((other) => (
            <option key={other.id} value={other.id}>
              {other.title}
            </option>
          ))}
        </select>
      ) : (
        <span data-plan-field="parent">{record.parent?.title ?? "Nothing (top level)"}</span>
      )}

      <span className="text-text-tertiary">Planned</span>
      {offers(idea, "plan_dates") ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" aria-label="Planned start" className="h-9 rounded-md border bg-field px-2" value={idea.planned.start ?? ""} max={idea.planned.target ?? undefined} onChange={(event) => save({ plannedStart: event.target.value || null })} data-plan-detail-start />
          <span className="text-text-tertiary">to</span>
          <input type="date" aria-label="Planned target" className="h-9 rounded-md border bg-field px-2" value={idea.planned.target ?? ""} min={idea.planned.start ?? undefined} onChange={(event) => save({ plannedTarget: event.target.value || null })} data-plan-detail-target />
        </div>
      ) : (
        <span data-plan-field="planned">{idea.planned.start || idea.planned.target ? `${dayLabel(idea.planned.start)} to ${dayLabel(idea.planned.target)}` : "Not planned"}</span>
      )}

      {idea.baseline ? (
        <>
          <span className="text-text-tertiary">Baseline</span>
          <span data-plan-detail-baseline>
            {dayLabel(idea.baseline.start)} to {dayLabel(idea.baseline.target)}
          </span>
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
  );
}

function Brief({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const editable = offers(record.idea, "edit");
  const prose = useProse({ value: record.brief ?? "", editable, onSave: (brief) => void write("update", { ref: record.idea.id, brief }) });
  return (
    <Section label="Brief" testId="brief" action={editable && !prose.editing && record.brief ? <EditButton label="Brief" testId="brief" onClick={prose.start} /> : null}>
      {prose.editing ? (
        <Textarea
          autoFocus
          value={prose.draft}
          onChange={(event) => prose.setDraft(event.target.value)}
          onBlur={prose.finish}
          onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), prose.cancel())}
          placeholder="What is it, who is it for, what does done look like?"
          className="min-h-24"
          data-plan-detail-brief
        />
      ) : record.brief ? (
        <Markdown text={record.brief} className="staple-detail-prose text-body" />
      ) : editable ? (
        <button type="button" className="w-full rounded-md border border-dashed px-3 py-2 text-left text-body text-text-tertiary hover:bg-surface-hover" onClick={prose.start} data-plan-section-empty="brief">
          What is it, who is it for, what does done look like?
        </button>
      ) : (
        <p className="m-0 text-body text-text-secondary">No brief.</p>
      )}
    </Section>
  );
}

function Questions({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const ref = record.idea.id;
  const asks = offers(record.idea, "ask");
  if (!asks && record.questions.length === 0) return null;
  return (
    <Section label="Open questions" testId="questions">
      <ul className="space-y-1">
        {record.questions.map((question, index) => (
          <li key={`${index}-${question.text}`}>
            <div className="flex min-h-8 items-start gap-2">
              <label className={cn("flex flex-1 items-start gap-2 text-label", question.resolved && "text-text-tertiary line-through")}>
                <input type="checkbox" className="mt-1" disabled={!asks} checked={question.resolved} onChange={(event) => void write("resolve", { ref, position: index + 1, resolved: event.target.checked })} />
                <span>
                  {question.text}
                  {question.deferred ? <span className="ml-1.5 text-caption text-text-tertiary">(deferred)</span> : null}
                </span>
              </label>
              {asks && !question.resolved ? (
                <Button variant="ghost" size="sm" className="h-8 shrink-0 text-caption" onClick={() => void write("resolve", { ref, position: index + 1, deferred: !question.deferred })} data-plan-defer={index + 1}>
                  {question.deferred ? "Undefer" : "Defer"}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {asks ? <AddLine placeholder="Add a question…" onAdd={(text) => write("question", { ref, text })} testId="question" /> : null}
    </Section>
  );
}

function Decisions({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const decides = offers(record.idea, "decide");
  if (!decides && record.decisions.length === 0) return null;
  return (
    <Section label="Decisions" testId="decisions">
      <ul className="space-y-1 text-label">
        {record.decisions.map((decision, index) => (
          <li key={`${index}-${decision}`}>• {decision}</li>
        ))}
      </ul>
      {decides ? <AddLine placeholder="Record a decision…" onAdd={(text) => write("decision", { ref: record.idea.id, text })} testId="decision" /> : null}
    </Section>
  );
}

function SubIdeas({ record, workspace }: { record: IdeaDetailData; workspace: string }) {
  const session = useSession();
  if (record.children.length === 0) return null;
  return (
    <Section label={`Sub-ideas (${record.children.length})`} testId="children">
      <ul className="space-y-1">
        {record.children.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              className="flex min-h-9 w-full items-center gap-2 rounded px-1 text-left text-label hover:bg-surface-hover"
              onClick={() => session.open(workspace, child.identifier ?? child.id)}
              data-plan-child={child.id}
            >
              <span className="min-w-0 flex-1 truncate">{child.title}</span>
              {child.late ? <Chip tone="red">late</Chip> : child.notStarted ? <Chip tone="amber">not started</Chip> : <Chip>{STATE_WORDS[child.state]?.toLowerCase() ?? child.stage}</Chip>}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Work({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const { idea } = record;
  const ref = idea.id;
  const unlinks = offers(idea, "unlink");
  const adopts = offers(idea, "adopt");
  if (!adopts && record.linked.length === 0 && idea.linkCount === 0) return null;
  return (
    <Section label="Work in the tracker" testId="work">
      {idea.linkCount > 0 && idea.progress !== null ? <Progress value={idea.progress} /> : null}
      {record.linked.length === 0 && idea.linkCount > 0 ? <p className="mt-1 text-caption text-text-tertiary">{idea.promoted ? "This record is the epic; its tasks are its work." : "Linked through its sub-ideas."}</p> : null}
      <ul className="mt-2 space-y-2">
        {record.linked.map((link) => (
          <li key={link.id} className={cn("rounded-md border px-2.5 py-2", link.missing && "border-dashed")} data-plan-link={link.identifier} data-plan-link-missing={link.missing || undefined}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {link.missing ? (
                  <>
                    <div className="flex items-center gap-1.5 text-label">
                      <Chip tone="amber">missing</Chip>
                      <span className="truncate font-mono text-text-tertiary">{link.id}</span>
                    </div>
                    <div className="text-caption text-text-tertiary">This issue is no longer on this device. The idea keeps its stage; unlink it if it is gone for good.</div>
                  </>
                ) : (
                  <>
                    <div className="text-label">
                      <span className="font-mono text-text-tertiary">{link.identifier}</span> {link.title}
                    </div>
                    <div className="text-caption text-text-tertiary">
                      {link.status} · {link.doneLeaves}/{link.leaves} done{link.milestone ? ` · in ${link.milestone.title} (${link.milestone.state}${link.milestone.run ? `, run ${link.milestone.run.state}` : ""})` : ""}
                    </div>
                  </>
                )}
              </div>
              {unlinks ? (
                <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Unlink ${link.identifier}`} onClick={() => void write("unlink", { ref, issue: link.id })} data-plan-unlink={link.identifier}>
                  <Unlink aria-hidden />
                </Button>
              ) : null}
            </div>
            {link.missing ? null : <Progress value={link.progress} />}
          </li>
        ))}
      </ul>
      {adopts ? (
        <AddLine placeholder="Adopt an issue by its identifier" onAdd={(issue) => write("adopt", { ref, issue })} testId="adopt" icon={<Link2 className="size-4" aria-hidden />} button="Adopt" />
      ) : null}
    </Section>
  );
}

function AddLine({ placeholder, onAdd, testId, icon, button }: { placeholder: string; onAdd: (text: string) => Promise<boolean>; testId: string; icon?: ReactNode; button?: string }) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-2 flex items-center gap-2"
      data-plan-add={testId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() && (await onAdd(text.trim()))) setText("");
      }}
    >
      {icon}
      <Input value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-9" />
      {button ? (
        <Button type="submit" size="sm" variant="outline">
          {button}
        </Button>
      ) : null}
    </form>
  );
}
