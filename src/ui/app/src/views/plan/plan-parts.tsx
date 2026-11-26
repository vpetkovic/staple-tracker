/**
 * The Plan view's shared parts: how an idea's state, its flags, its progress and a horizon's
 * header are drawn, the same in every lens, the drawer and the Milestones view. Presentation
 * only: every count, unit, percent, state and flag is the server's.
 */
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Input } from "@/components/ui/input";
import type { HorizonData, IdeaData, IdeaState, PlanUnits } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { STATE_WORDS } from "@/detail/plan-record";
import { ShippedCheck, ShippedMark } from "@/detail/ShippedMark";
import { dayIndex, dayLabel, horizonDone, isShipped } from "./plan-model";
import { percentText, treeHeader } from "./plan-tree";

/**
 * The Plan container's widths where its layout changes (build spec, "Widths"): under `phone` the
 * toolbar takes its phone form, under `compact` rows go to two lines and Ideas and the Timeline
 * stack, under `medium` the Planned column drops, under `search` the filter folds to a button.
 * CSS switches on them with container queries on `@container/plan`; JS that must know measures.
 */
export const PLAN_WIDTH = { phone: 620, compact: 760, medium: 1040, search: 1100 } as const;

/** An element's own width, kept current; null until it has been laid out (and in a string render). */
export function useElementWidth<T extends HTMLElement>(): { ref: RefObject<T | null>; width: number | null } {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** The capture field: Enter captures a raw idea and clears it for the next one. Its form carries `data-plan-capture` wherever it sits. */
export function CaptureForm({ onCapture, autoFocus, className, inputClassName }: { onCapture: (title: string) => Promise<boolean>; autoFocus?: boolean; className?: string; inputClassName?: string }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = title.trim();
    if (!clean || busy) return;
    setBusy(true);
    const ok = await onCapture(clean);
    setBusy(false);
    if (ok) setTitle("");
  };
  return (
    <form className={className} onSubmit={submit} data-plan-capture>
      {/* Read-only, not disabled, while it writes: the field keeps focus for the next idea. */}
      <Input value={title} onChange={(event) => setTitle(event.target.value)} readOnly={busy} aria-busy={busy || undefined} placeholder="Capture an idea… (Enter)" aria-label="Capture an idea" autoFocus={autoFocus} className={cn("h-9", inputClassName)} />
    </form>
  );
}

/**
 * An idea's state as a 14px picture: raw a dotted ring, exploring a dashed amber ring with a dot,
 * shaped a plain ring, started a ring with a wedge filled to the server's percent, shipped the
 * check. Hidden from assistive technology: it sits beside the state word (`word`), or in a row
 * whose name says the state.
 */
export function StateGlyph({ state, percent = null, word = false, className }: { state: IdeaState; percent?: number | null; word?: boolean; className?: string }) {
  const glyph = (
    <span aria-hidden="true" data-plan-glyph={state} className={cn("inline-flex size-3.5 shrink-0", className)}>
      {state === "shipped" ? <ShippedCheck label="" className="size-3.5 [&_svg]:size-2.5" /> : <GlyphSvg state={state} percent={percent} />}
    </span>
  );
  if (!word) return glyph;
  return (
    <span className="inline-flex items-center gap-1.5">
      {glyph}
      <span>{STATE_WORDS[state] ?? state}</span>
    </span>
  );
}

function GlyphSvg({ state, percent }: { state: Exclude<IdeaState, "shipped">; percent: number | null }) {
  const ring = { cx: 7, cy: 7, r: 6, fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  switch (state) {
    case "started": {
      // Never read as empty or done: at least a sliver, never the whole disc.
      const share = Math.max(0.04, Math.min(0.999, (percent ?? 0) / 100));
      const angle = share * 2 * Math.PI;
      const x = (7 + 3.6 * Math.sin(angle)).toFixed(2);
      const y = (7 - 3.6 * Math.cos(angle)).toFixed(2);
      return (
        <svg viewBox="0 0 14 14" className="size-full text-[color:var(--status-task-icon-in_progress)]">
          <circle {...ring} />
          <path d={`M7 7 L7 3.4 A3.6 3.6 0 ${share > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill="currentColor" />
        </svg>
      );
    }
    case "shaped":
      return (
        <svg viewBox="0 0 14 14" className="size-full text-text-secondary">
          <circle {...ring} />
        </svg>
      );
    case "exploring":
      return (
        <svg viewBox="0 0 14 14" className="size-full text-[color:var(--status-task-icon-todo)]">
          <circle {...ring} strokeDasharray="3.2 2.2" />
          <circle cx={7} cy={7} r={1.8} fill="currentColor" />
        </svg>
      );
    case "dropped":
      return (
        <svg viewBox="0 0 14 14" className="size-full text-text-tertiary">
          <circle {...ring} strokeDasharray="1.2 2.6" strokeLinecap="round" />
          <path d="M3.5 10.5 10.5 3.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 14 14" className="size-full text-text-tertiary">
          <circle {...ring} strokeDasharray="1.2 2.6" strokeLinecap="round" />
        </svg>
      );
  }
}

export type FlagTone = "late" | "notStarted" | "you";

const FLAGS: Record<FlagTone, { words: string; className: string }> = {
  late: { words: "late", className: "bg-destructive/12 text-flag-late" },
  notStarted: { words: "not started", className: "bg-[color:var(--status-task-todo)]/16 text-flag-todo" },
  you: { words: "needs you", className: "bg-[color:var(--status-task-in_progress)]/12 text-flag-you" },
};

/**
 * A filled tag for what needs attention, and only that: late, not started, needs you and waiting
 * for your approval. It always says it in words; the tint repeats it.
 */
export function Flag({ tone, children, className, ...data }: { tone: FlagTone; children?: ReactNode; className?: string } & Record<`data-${string}`, string | number | undefined>) {
  const flag = FLAGS[tone];
  return (
    <span {...data} data-plan-flag={tone} className={cn("inline-flex h-4 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-caption leading-4 font-medium", flag.className, className)}>
      {children ?? flag.words}
    </span>
  );
}

/** Open questions, or anything else that waits on an answer: amber words, not a tag. */
export function Amber({ children, ...data }: { children: ReactNode } & Record<`data-${string}`, string | number | undefined>) {
  return (
    <span {...data} className="text-flag-todo">
      {children}
    </span>
  );
}

/** `Feb 27, 2027 · in 93 days`: the horizon's date, and its distance from the plan's day when the surface has one. */
export function HorizonWhen({ date, today }: { date: string; today?: string }) {
  const days = today ? dayIndex(date) - dayIndex(today) : null;
  const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  return (
    <span className="text-label text-text-secondary" data-plan-horizon-when={date}>
      <span className="font-medium text-foreground">{dayLabel(date)}</span>
      {days === null ? null : ` · ${days === 0 ? "today" : days > 0 ? `in ${plural(days)}` : `${plural(-days)} ago`}`}
    </span>
  );
}

/**
 * A horizon's header content, the same in the Horizons lens, the horizon drawer and the
 * Milestones view. Its name and date (`heading` replaces them with a surface's own, such as the
 * lens's inline editors; null leaves them to a surface that titles the horizon itself), then the
 * bar, the server's percent and the flags, then its counts and units. `risk` false leaves late,
 * not started, approval and shipped to a surface that prints them elsewhere.
 */
export function HorizonSummary({ horizon, today, heading, risk = true, className }: { horizon: HorizonData; today?: string; heading?: ReactNode; risk?: boolean; className?: string }) {
  const words = treeHeader(horizon);
  const done = horizonDone(horizon);
  const { units } = horizon;
  const flags = [
    risk && horizon.awaitingApproval ? (
      <Flag key="approval" tone="you" data-plan-horizon-awaiting={horizon.identifier}>
        Waiting for your approval
      </Flag>
    ) : null,
    words.needsYou ? (
      <Flag key="you" tone="you" data-plan-tree-needs-you={horizon.needsYou}>
        {words.needsYou}
      </Flag>
    ) : null,
    risk && !done && horizon.lateCount > 0 ? <Flag key="late" tone="late">{horizon.lateCount} late</Flag> : null,
    risk && !done && horizon.notStartedCount > 0 ? <Flag key="ns" tone="notStarted">{horizon.notStartedCount} not started</Flag> : null,
    risk ? done ? <ShippedMark key="shipped" className="text-caption" /> : horizon.shippedCount > 0 ? <ShippedMark key="shipped" count={horizon.shippedCount} className="text-caption" /> : null : null,
  ].filter((flag) => flag !== null);
  return (
    <div className={cn("@container min-w-0", className)} data-plan-tree-header={horizon.identifier}>
      {heading === null ? null : (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          {heading ?? (
            <>
              <span className="text-title font-semibold text-foreground">{horizon.name}</span>
              {horizon.date ? <HorizonWhen date={horizon.date} today={today} /> : null}
            </>
          )}
        </div>
      )}
      {horizon.percent !== null || flags.length > 0 ? (
        <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", heading !== null && "mt-1.5")}>
          {horizon.percent !== null ? <SegmentedBar units={units} percent={horizon.percent} complete={horizon.complete} size="lg" className="mt-0 min-w-[120px] flex-[0_1_340px] @max-[760px]:flex-[1_1_100%]" /> : null}
          {flags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-plan-horizon-risk={risk ? horizon.identifier : undefined}>
              {flags}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1.5 text-label text-text-tertiary">
        <span data-plan-tree-records>{words.records}</span>
        {words.states ? (
          <>
            {" · "}
            <span data-plan-tree-states>{words.states}</span>
          </>
        ) : null}
        {units.total > 0 ? ` · ${units.done} done, ${units.open} open, ${units.planned} planned` : null}
      </div>
    </div>
  );
}

/**
 * Done, open and planned, each segment growing by the server's count, never a width of the page's;
 * then the server's percent as the CLI prints it (a whole 100 that is not complete says so).
 */
export function SegmentedBar({ units, percent, complete, size = "sm", className }: { units: Pick<PlanUnits, "done" | "open" | "planned">; percent: number | null; complete: boolean; size?: "sm" | "lg"; className?: string }) {
  const text = percentText(percent, complete);
  const incomplete = text !== null && text.endsWith("incomplete");
  return (
    <div className={cn("mt-1.5 flex items-center gap-2", className)} aria-label={percent === null ? undefined : `${percent}% done${incomplete ? ", incomplete" : ""}`} data-plan-tree-bar={`${units.done}/${units.open}/${units.planned}`}>
      <div className={cn("flex min-w-0 flex-1 overflow-hidden rounded-full bg-muted", size === "lg" ? "h-2" : "h-1.5")} title={`${units.done} done · ${units.open} open · ${units.planned} planned`}>
        {units.done > 0 ? <span className="h-full bg-primary" style={{ flexGrow: units.done }} data-segment="done" /> : null}
        {units.open > 0 ? <span className="h-full bg-[color:var(--status-task-in_progress)]" style={{ flexGrow: units.open }} data-segment="open" /> : null}
        {units.planned > 0 ? <span className="h-full bg-border-strong" style={{ flexGrow: units.planned }} data-segment="planned" /> : null}
      </div>
      {text !== null ? <span className={cn("shrink-0 tabular-nums", size === "lg" ? "text-label font-semibold text-foreground" : "text-caption text-text-tertiary")}>{text}</span> : null}
    </div>
  );
}

/** A delivery card: where it stands, its work, and the shipped mark once all of it landed; `children` follow its chips. */
export function DeliveryChips({ idea, children }: { idea: IdeaData; children?: ReactNode }) {
  if (isShipped(idea)) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
        <ShippedMark on={idea.actual.end} outside={idea.delivered !== null} />
        {idea.linkCount > 0 ? <span className="text-text-tertiary">{idea.linkCount} linked</span> : null}
        {children}
      </div>
    );
  }
  const chips: ReactNode[] = [<StateGlyph key="s" state={idea.state} percent={idea.percent} word />];
  // Shaped, but its plan no longer passes the gate: shown here, flagged, and held back from Scaffold.
  if (planIncomplete(idea)) chips.push(<Amber key="pi" data-plan-card-incomplete="">plan incomplete</Amber>);
  if (idea.linkCount > 0) chips.push(<span key="l" className="text-text-tertiary">{idea.linkCount} linked</span>);
  if (idea.late) chips.push(<Flag key="late" tone="late" />);
  if (idea.notStarted) chips.push(<Flag key="ns" tone="notStarted" />);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
      {chips}
      {children}
    </div>
  );
}

/** The server names what an incomplete plan lacks; display that payload directly. */
export function planIncomplete(idea: IdeaData): boolean {
  return idea.planIncomplete.length > 0;
}

/** `◇ Now · Beta`: work that belongs to a horizon, the same chip here and in Tasks. */
export function HorizonChip({ label }: { label: string }) {
  return (
    <Chip>
      <span data-horizon-chip>
        <span aria-hidden>◇ </span>
        {label}
      </span>
    </Chip>
  );
}

export function Chip({ children, tone }: { children: ReactNode; tone?: "amber" | "blue" | "red" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px leading-tight text-text-secondary",
        tone === "amber" && "border-[color:var(--status-task-todo)]/60 text-foreground",
        tone === "blue" && "border-[color:var(--status-task-in_progress)]/50 text-foreground",
        tone === "red" && "border-destructive/60 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

/** The server's percent, as it gives it; a whole 100 that is not complete (an idea left unsized) says so. */
export function Progress({ percent, complete = true }: { percent: number; complete?: boolean }) {
  const incomplete = percent === 100 && !complete;
  return (
    <div className="mt-2 flex items-center gap-2" aria-label={`${percent}% done${incomplete ? ", incomplete" : ""}`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-caption tabular-nums text-text-tertiary">
        {percent}%{incomplete ? " incomplete" : ""}
      </span>
    </div>
  );
}
