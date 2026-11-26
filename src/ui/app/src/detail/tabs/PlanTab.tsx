/**
 * The Plan tab: an idea's plan as the person shapes it, in the shared drawer, read as a document.
 *
 * What it needs first leads ("Where it stands", PlanStanding.tsx), then its properties, then its
 * work once started, then a sticky row of section chips and the plan's sections
 * (PlanSections.tsx), the decisions, the sub-ideas, and the rare actions last. The layout follows
 * the tab's own width with a container query (`@container/plantab`), compact under 512px of
 * content, which is a 560px drawer less its gutters: the drawer can be a full page or a phone's
 * sheet.
 *
 * Every editor here renders only when the record's lifecycle state offers its action (`offers`,
 * from the core table through the payload): a raw idea shows no horizon or dates to set, a
 * shipped one shows its plan read-only, and nothing is offered that the store would refuse.
 * Maturity moves and promotion are the header's buttons. What is derived (stage, progress,
 * actual dates, lateness) is shown, never edited.
 */
import { ChevronDown, Link2, Unlink } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type RefObject } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getPlan } from "@/lib/api";
import type { IdeaDetailData, PlanData } from "@/lib/plan-types";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { dayLabel, descendantsOf } from "@/views/plan/plan-model";
import { Flag, Progress, StateGlyph } from "@/views/plan/plan-parts";
import { offers } from "../plain-actions";
import { STATE_WORDS, onScaffoldRequest, planRecordOf, usePlanWrite, type PlanWrite } from "../plan-record";
import { EmptyValue, PropertyList, PropertyRow } from "../PropertyGrid";
import { AddLine, FoldButton, PlanSectionsView, Section } from "./PlanSections";
import { WhereItStands } from "./PlanStanding";
import { datedDecision, planSectionsOf, type PlanSectionEntry, type PlanSectionId } from "./plan-tab-model";
import type { TabProps } from "./registry";

export function PlanTab({ detail, workspace, onAuthError, refresh }: TabProps) {
  const record = planRecordOf(detail);
  const session = useSession();
  const loadPlan = useCallback(() => getPlan({ ws: workspace }), [workspace]);
  const plan = useResource(loadPlan, [workspace, session.version], onAuthError).data ?? null;
  const { write, refusal } = usePlanWrite(workspace, refresh);
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stick = useTabStripHeight(rootRef);
  // The header's Scaffold opens the preview here: it is never a one-click write.
  useEffect(() => onScaffoldRequest(() => setScaffoldOpen(true)), []);
  if (!record) return null;
  const { idea } = record;
  const scaffold = async (fingerprint: string) => {
    setBusy(true);
    if (await write("scaffold", { ref: idea.id, fingerprint })) setScaffoldOpen(false);
    setBusy(false);
  };
  // Started or shipped: the work in the tracker is what it is now, so it comes right under the properties.
  const workFirst = idea.state === "started" || idea.state === "shipped";
  const jump = (id: PlanSectionId) => jumpTo(rootRef.current, id);
  return (
    <div ref={rootRef} className="@container/plantab space-y-6" style={{ "--plan-stick": `${stick}px` } as CSSProperties} data-plan-tab={idea.id} data-plan-state={idea.state}>
      {refusal ? <GuardRefusal refusal={refusal} /> : null}
      <WhereItStands record={record} write={write} onJump={jump} scaffold={{ open: scaffoldOpen, onToggle: () => setScaffoldOpen((open) => !open), onConfirm: (fingerprint) => void scaffold(fingerprint), busy }} />
      <Fields record={record} plan={plan} write={write} />
      {workFirst ? <Work record={record} write={write} /> : null}
      <SectionNav record={record} onJump={jump} />
      <PlanSectionsView record={record} write={write} />
      <Decisions record={record} write={write} />
      <SubIdeas record={record} workspace={workspace} />
      {workFirst ? null : <Work record={record} write={write} />}
      <RareActions record={record} write={write} />
    </div>
  );
}

/** The drawer's sticky tab strip's height: where the section chips stick, under it. */
function useTabStripHeight(rootRef: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const strip = rootRef.current?.closest("[data-detail-layout]")?.querySelector<HTMLElement>("[data-detail-tabs]");
    if (!strip || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(strip.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [rootRef]);
  return height;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Scrolls a section (or its chip on the "Not written yet" line) to just under the stuck chips, and moves focus there. */
function jumpTo(root: HTMLElement | null, id: PlanSectionId): void {
  const target = root?.querySelector<HTMLElement>(`[data-plan-anchor="${id}"]`);
  const scroller = root?.closest<HTMLElement>(".staple-detail-scroll");
  const nav = root?.querySelector<HTMLElement>("[data-plan-section-nav]");
  if (!target || !scroller) return;
  const covered = (Number.parseFloat(root ? getComputedStyle(root).getPropertyValue("--plan-stick") : "0") || 0) + (nav?.offsetHeight ?? 0);
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - covered - 12;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
  target.focus({ preventScroll: true });
}

/**
 * One chip per section in plan order: filled where it has content, starred where shaping
 * requires it, with a count for lists. A chip goes to its section; one whose section is not
 * drawn (empty, and edits not offered) goes nowhere.
 */
function SectionNav({ record, onJump }: { record: IdeaDetailData; onJump: (id: PlanSectionId) => void }) {
  const { completeness: c, idea } = record;
  const reachable = (entry: PlanSectionEntry) => entry.filled || offers(idea, entry.id === "decisions" ? "decide" : "edit");
  return (
    <nav aria-label="Plan sections" className="staple-plan-nav sticky z-[5] flex gap-1.5 overflow-x-auto border-b bg-card py-2.5" data-plan-section-nav data-plan-completeness={`${c.starred}/${c.starredTotal}`}>
      <span className="sr-only">
        {c.starred} of {c.starredTotal} required sections, {c.filled} of {c.total} in all
      </span>
      {planSectionsOf(record).map((entry) => (
        <button
          key={entry.id}
          type="button"
          disabled={!reachable(entry)}
          onClick={() => onJump(entry.id)}
          data-plan-chip={entry.id}
          data-filled={entry.filled ? "" : undefined}
          data-required={entry.star ? "" : undefined}
          title={reachable(entry) ? undefined : "Not written"}
          className={cn(
            "focus-ring inline-flex h-[26px] min-h-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-label whitespace-nowrap hover:bg-surface-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent pointer-coarse:h-8 @max-[512px]/plantab:h-8 @max-[512px]/plantab:text-body",
            entry.filled ? "text-foreground" : "text-text-tertiary",
          )}
        >
          <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full border-[1.5px]", entry.filled ? "border-foreground bg-foreground" : "border-border-strong")} />
          {entry.label}
          {entry.star ? (
            <>
              <span aria-hidden className="text-caption text-flag-todo">
                ★
              </span>
              <span className="sr-only">, required</span>
            </>
          ) : null}
          {entry.count !== null ? <span className="text-text-tertiary tabular-nums">{entry.count}</span> : null}
          {entry.filled ? null : <span className="sr-only">, not written</span>}
        </button>
      ))}
    </nav>
  );
}

/** A native date field that reads as text until hovered or focused. */
const QUIET = "h-8 min-w-0 max-w-full rounded-md border border-transparent bg-transparent px-2 -ml-2 text-body text-foreground hover:bg-surface-hover focus-visible:border-ring focus-visible:outline-none pointer-coarse:h-10 pointer-coarse:text-[16px]";

/**
 * A select that reads as its chosen option's words with a caret: the native control lies over
 * them, transparent, so the picker, the keyboard and the accessible name are the platform's.
 */
function QuietSelect({ options, value, className, ...props }: Omit<ComponentProps<"select">, "children" | "value"> & { value: string; options: Array<{ value: string; label: string }> }) {
  const chosen = options.find((option) => option.value === value)?.label ?? "";
  return (
    <span className={cn("relative -ml-2 inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-body text-foreground hover:bg-surface-hover has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring pointer-coarse:h-10", className)}>
      <span className="truncate">{chosen}</span>
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
      <select value={value} className="absolute inset-0 size-full min-h-0 cursor-pointer appearance-none opacity-0" {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

const horizonWords = (horizon: { name: string; date: string | null }) => `◇ ${horizon.name}${horizon.date ? ` · ${dayLabel(horizon.date)}` : ""}`;
const windowWords = (start: string | null, end: string | null) => `${start ? dayLabel(start, false) : "…"} – ${end ? dayLabel(end) : "…"}`;

/** Horizon, Part of and Planned, edited in place where offered; Baseline (when it differs) and Actual read-only. */
function Fields({ record, plan, write }: { record: IdeaDetailData; plan: PlanData | null; write: PlanWrite }) {
  const { idea } = record;
  const ref = idea.id;
  const save = (body: Record<string, unknown>) => void write("update", { ref, ...body });
  const below = new Set(plan ? descendantsOf(plan, idea).map((other) => other.id) : []);
  const parents = (plan?.ideas ?? []).filter((other) => other.id !== idea.id && !below.has(other.id) && other.state !== "dropped" && !other.promoted);
  const started = idea.stage === "started" || idea.stage === "shipped";
  const horizon = plan?.horizons.find((h) => h.id === idea.horizonId) ?? record.horizon;
  const later = idea.state === "raw" ? "After it is explored" : null;
  const baseline = idea.baseline && (idea.baseline.start !== idea.planned.start || idea.baseline.target !== idea.planned.target) ? idea.baseline : null;
  return (
    <div data-plan-fields>
      <PropertyList layout="grid">
        <PropertyRow label="Horizon" id="horizon">
          {offers(idea, "schedule") && plan ? (
            <QuietSelect
              aria-label="Horizon"
              value={idea.horizonId ?? ""}
              options={[{ value: "", label: "Not scheduled" }, ...plan.horizons.map((option) => ({ value: option.id, label: horizonWords(option) }))]}
              onChange={(event) => save({ horizon: event.target.value || null })}
              data-plan-detail-horizon
            />
          ) : (
            <span data-plan-field="horizon">{horizon ? horizonWords(horizon) : <EmptyValue>{later ?? "Not scheduled"}</EmptyValue>}</span>
          )}
        </PropertyRow>
        <PropertyRow label="Part of" id="parent">
          {offers(idea, "reparent") && plan ? (
            <QuietSelect
              aria-label="Part of"
              value={idea.parentId ?? ""}
              options={[{ value: "", label: "Top level" }, ...parents.map((other) => ({ value: other.id, label: other.title }))]}
              onChange={(event) => save({ parent: event.target.value || null })}
              data-plan-detail-parent
            />
          ) : (
            <span data-plan-field="parent">{record.parent?.title ?? <EmptyValue>Top level</EmptyValue>}</span>
          )}
        </PropertyRow>
        <PropertyRow label="Planned" id="planned" span={offers(idea, "plan_dates")}>
          {offers(idea, "plan_dates") ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1">
              <input type="date" aria-label="Planned start" className={cn(QUIET, "w-[8.5rem] pointer-coarse:w-[10rem]")} value={idea.planned.start ?? ""} max={idea.planned.target ?? undefined} onChange={(event) => save({ plannedStart: event.target.value || null })} data-plan-detail-start />
              {/* The dash wraps with the target, never alone at a line's end. */}
              <span className="inline-flex items-center gap-x-1 whitespace-nowrap">
                <span aria-hidden className="pr-1 text-text-tertiary">
                  –
                </span>
                <input type="date" aria-label="Planned target" className={cn(QUIET, "ml-0 w-[8.5rem] pointer-coarse:w-[10rem]")} value={idea.planned.target ?? ""} min={idea.planned.start ?? undefined} onChange={(event) => save({ plannedTarget: event.target.value || null })} data-plan-detail-target />
              </span>
            </span>
          ) : (
            <span data-plan-field="planned">{idea.planned.start || idea.planned.target ? windowWords(idea.planned.start, idea.planned.target) : <EmptyValue>{later ?? "Not planned"}</EmptyValue>}</span>
          )}
        </PropertyRow>
        {baseline ? (
          <PropertyRow label="Baseline" id="baseline">
            <span data-plan-detail-baseline>{windowWords(baseline.start, baseline.target)}</span>
          </PropertyRow>
        ) : null}
        {started ? (
          <PropertyRow label="Actual" id="actual">
            <span>
              {idea.actual.start ? dayLabel(idea.actual.start, false) : "not begun"}
              {" – "}
              {idea.actual.end ? dayLabel(idea.actual.end) : idea.actual.forecastEnd ? `about ${dayLabel(idea.actual.forecastEnd)}` : "open"}
            </span>
          </PropertyRow>
        ) : null}
      </PropertyList>
    </div>
  );
}

/**
 * The three latest decisions, newest first, each with its day where the text starts with one;
 * "Show all" for the rest, and the field that records the next.
 */
function Decisions({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const [all, setAll] = useState(false);
  const decides = offers(record.idea, "decide");
  if (!decides && record.decisions.length === 0) return null;
  const latest = [...record.decisions].reverse();
  const shown = all ? latest : latest.slice(0, 3);
  return (
    <Section label="Decisions" testId="decisions" hint={record.decisions.length > 0 ? String(record.decisions.length) : undefined}>
      {shown.length > 0 ? (
        <ol className="m-0 list-none p-0">
          {shown.map((decision, index) => {
            const { date, text } = datedDecision(decision);
            return (
              <li key={`${index}-${decision}`} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2.5 border-t py-1.5 first:border-t-0">
                <time dateTime={date ?? undefined} className="pt-px text-label whitespace-nowrap text-text-tertiary">
                  {date ? dayLabel(date, false) : ""}
                </time>
                <p className="m-0 text-body">{text}</p>
              </li>
            );
          })}
        </ol>
      ) : null}
      {record.decisions.length > 3 ? (
        <FoldButton open={all} onToggle={() => setAll((value) => !value)} testId="decisions">
          Show all {record.decisions.length}
        </FoldButton>
      ) : null}
      {decides ? <AddLine placeholder="Record a decision…" onAdd={(text) => write("decision", { ref: record.idea.id, text })} testId="decision" className="mt-2" /> : null}
    </Section>
  );
}

function SubIdeas({ record, workspace }: { record: IdeaDetailData; workspace: string }) {
  const session = useSession();
  if (record.children.length === 0) return null;
  return (
    <Section label="Sub-ideas" hint={String(record.children.length)} testId="children">
      <ul className="m-0 list-none overflow-hidden rounded-lg border p-0">
        {record.children.map((child) => (
          <li key={child.id} className="border-t first:border-t-0">
            <button
              type="button"
              className="focus-ring flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-surface-hover pointer-coarse:min-h-11"
              onClick={() => session.open(workspace, child.identifier ?? child.id)}
              data-plan-child={child.id}
            >
              <StateGlyph state={child.state} percent={child.percent} />
              <span className="min-w-0 flex-1 truncate">{child.title}</span>
              {child.late && child.state !== "shipped" ? <Flag tone="late" /> : null}
              {child.notStarted ? <Flag tone="notStarted" /> : null}
              <span className="shrink-0 text-label text-text-tertiary">
                {STATE_WORDS[child.state] ?? child.state}
                {child.state === "started" && child.percent !== null ? ` · ${child.percent}%` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Its linked work as one list: identifier, title, status, a bar and the percent; unlink where offered; adopt where offered. */
function Work({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const { idea } = record;
  const ref = idea.id;
  const unlinks = offers(idea, "unlink");
  const adopts = offers(idea, "adopt");
  if (!adopts && record.linked.length === 0 && idea.linkCount === 0) return null;
  return (
    <Section label="Work in the tracker" testId="work" hint={record.linked.length > 0 ? String(record.linked.length) : undefined}>
      {record.linked.length === 0 && idea.linkCount > 0 ? <p className="m-0 text-label text-text-tertiary">{idea.promoted ? "This record is the epic; its tasks are its work." : "Linked through its sub-ideas."}</p> : null}
      {record.linked.length > 0 ? (
        <ul className="m-0 list-none overflow-hidden rounded-lg border p-0">
          {record.linked.map((link) => (
            <li key={link.id} className={cn("staple-plan-link grid items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-body first:border-t-0", link.missing && "border-dashed")} data-plan-link={link.identifier} data-plan-link-missing={link.missing || undefined}>
              {link.missing ? (
                <div className="staple-plan-link-wide min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Flag tone="notStarted">missing</Flag>
                    <span className="truncate font-mono text-label text-text-tertiary">{link.id}</span>
                  </div>
                  <div className="mt-0.5 text-caption text-text-tertiary">This issue is no longer on this device. The idea keeps its stage; unlink it if it is gone for good.</div>
                </div>
              ) : (
                <>
                  <span className="font-mono text-label text-text-tertiary">{link.identifier}</span>
                  <span className="min-w-0 truncate" title={link.title}>
                    {link.title}
                  </span>
                  <span className="staple-plan-wide truncate text-label text-text-tertiary">{link.status.replace(/_/g, " ")}</span>
                  {/* The server's percent: a cancelled issue has no leaves to split, and still reads done. */}
                  <Progress percent={link.percent} className="staple-plan-link-bar mt-0" />
                </>
              )}
              {unlinks ? (
                <Button variant="ghost" size="icon" className="staple-plan-link-unlink size-7 pointer-coarse:size-9" aria-label={`Unlink ${link.identifier}`} onClick={() => void write("unlink", { ref, issue: link.id })} data-plan-unlink={link.identifier}>
                  <Unlink aria-hidden className="size-3.5" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {adopts ? <AddLine placeholder="Adopt an issue by its identifier" onAdd={(issue) => write("adopt", { ref, issue })} testId="adopt" icon={<Link2 className="size-3.5 shrink-0" aria-hidden />} button="Adopt" className="mt-2" /> : null}
    </Section>
  );
}

/**
 * The rare actions, quiet, at the end of the tab: "Delivered outside the tracker…" opens the
 * form that marks it (the day, a note, Mark delivered) in place. Everything else rare is in ⋯.
 */
function RareActions({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const { idea } = record;
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [on, setOn] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (idea.delivered || !offers(idea, "mark_delivered")) return null;
  const mark = async () => {
    setBusy(true);
    if (await write("update", { ref: idea.id, delivered: { on, note } })) setOpen(false);
    setBusy(false);
  };
  return (
    <div className="border-t pt-3" data-plan-rare>
      {open ? (
        <div data-plan-delivered-form>
          <h3 className="m-0 text-body font-semibold text-foreground">Delivered outside the tracker</h3>
          <p className="m-0 mt-1 text-label text-text-secondary">Work that shipped before or outside the tracker: it reads shipped, with no ticket.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="date" aria-label="Delivered on" className="h-9 rounded-md border bg-field px-2 pointer-coarse:text-[16px]" value={on} max={today} onChange={(event) => setOn(event.target.value)} data-plan-delivered-on />
            <Button size="sm" disabled={busy || on === ""} onClick={() => void mark()} data-plan-action="mark_delivered">
              Mark delivered
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <Textarea className="mt-2 min-h-16" placeholder="A note: where and how it was delivered (optional)" value={note} onChange={(event) => setNote(event.target.value)} data-plan-delivered-note />
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="-ml-2.5 text-text-secondary" aria-expanded={false} onClick={() => setOpen(true)} data-plan-delivered-open>
          Delivered outside the tracker…
        </Button>
      )}
    </div>
  );
}
