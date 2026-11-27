/**
 * A horizon section's sticky header in the Horizons lens: a first line with the fold chevron, the
 * name and date with their inline editors, and on the right Queue, the run setting and the `⋯` menu
 * (only the `⋯` under 760px of the Plan container; the menu holds Queue and the run setting too, as
 * the horizon's offered actions); then the shared `HorizonSummary` without its heading. Every
 * action is one the horizon's state offers. Under 760px each small control (the fold, the name,
 * clear, add a date) takes a 32px tap without changing how it looks.
 *
 * Under 760px only the first line sticks, at most 44px, with the server's percent at its right:
 * the header box gives way (`contents`), so the line sticks for the whole section while the bar,
 * flags, counts and the date link below it scroll away with the content. Once content runs under
 * the stuck line it grows a hairline, as the drawer's stuck tab strip does.
 */
import { CalendarPlus, ChevronDown, ChevronRight, ListPlus, MoreHorizontal, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { HorizonData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { horizonActionItems, offers, type PlanItem } from "@/detail/plain-actions";
import { RunSettingDialog, runSettingLabel } from "./RunSetting";
import type { Write } from "./plan-board";
import { HorizonSummary, HorizonWhen } from "./plan-parts";
import { percentText } from "./plan-tree";

/** Under 760px the header is two boxes, so a drop target's ring is drawn as one: open below the line, open above the block. */
const RING_LINE = "@max-[760px]/plan:shadow-[inset_0_2px_0_0_var(--color-ring),inset_2px_0_0_0_var(--color-ring),inset_-2px_0_0_0_var(--color-ring)]";
const RING_BLOCK = "@max-[760px]/plan:shadow-[inset_0_-2px_0_0_var(--color-ring),inset_2px_0_0_0_var(--color-ring),inset_-2px_0_0_0_var(--color-ring)]";

/**
 * A section's fold chevron, at the start of its header's first line; under 760px it takes a 32px
 * tap without changing how it looks. With no `onFold` (a focus or filter is on) it keeps its room.
 */
export function FoldButton({ name, folded, onFold, ...data }: { name: string; folded: boolean; onFold: (() => void) | null } & Record<`data-${string}`, string>) {
  if (onFold === null) return <span aria-hidden className="-ml-1 size-5 shrink-0" />;
  return (
    <button
      type="button"
      aria-expanded={!folded}
      aria-label={`${folded ? "Show" : "Hide"} ${name}`}
      {...data}
      onClick={onFold}
      className="focus-ring relative -ml-1 inline-flex size-5 min-h-0 shrink-0 self-center items-center justify-center rounded text-text-tertiary hover:bg-surface-hover @max-[760px]/plan:before:absolute @max-[760px]/plan:before:-inset-1.5 @max-[760px]/plan:before:content-['']"
    >
      {folded ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
    </button>
  );
}

/** How the header shows a drag over its section: a target it may drop on, the one under the pointer, or nothing. */
export type DropMark = "allowed" | "over" | null;

export function HorizonHeader({
  horizon,
  today,
  write,
  onOpen,
  done,
  folded,
  onFold,
  drop,
}: {
  horizon: HorizonData;
  today: string;
  write: Write;
  onOpen: (id: string) => void;
  done: boolean;
  folded: boolean;
  /** Null while a focus or filter is on: the section shows every match and cannot fold. */
  onFold: (() => void) | null;
  drop: DropMark;
}) {
  const [running, setRunning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dating, setDating] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLSpanElement>(null);
  const stuck = useStuck(sentinel);
  useEffect(() => {
    if (dating) dateRef.current?.focus();
  }, [dating]);
  const canRename = offers(horizon, "rename");
  const canDate = offers(horizon, "date");
  const items = horizonActionItems("", horizon);
  const queue = items.find((item) => item.id === "queue");
  const run = items.find((item) => item.id === "run");
  const percent = percentText(horizon.percent, horizon.complete);
  // Clear, or add a date: on the first line from 760px, under it below that.
  const dateLink = (
    horizon.date ? (
      canDate ? (
        <button type="button" className="focus-ring flex min-h-6 items-center gap-0.5 rounded-sm underline-offset-2 hover:underline @max-[760px]/plan:-my-1 @max-[760px]/plan:min-h-8" onClick={() => void write("horizon-update", { ref: horizon.id, date: null })} aria-label={`Clear ${horizon.name} date`} data-plan-horizon-clear-date={horizon.identifier}>
          <X className="size-3" aria-hidden /> clear
        </button>
      ) : null
    ) : canDate ? (
      <button type="button" className="focus-ring flex min-h-6 items-center gap-1 rounded-sm underline-offset-2 hover:underline @max-[760px]/plan:-my-1 @max-[760px]/plan:min-h-8" onClick={() => setDating(true)} data-plan-horizon-date={horizon.identifier}>
        <CalendarPlus className="size-3" aria-hidden /> add a date
      </button>
    ) : null
  );
  const over = drop === "over" && "bg-surface-hover";
  return (
    <header
      className={cn(
        "sticky top-0 z-10 border-b bg-card px-4 pt-3 pb-2.5 @max-[760px]/plan:contents",
        drop !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
        over,
      )}
      data-plan-horizon={horizon.identifier}
      data-plan-horizon-done={done ? "" : undefined}
    >
      {/* Zero height at the section's top under 760px: once it scrolls out, the first line is stuck. */}
      <span ref={sentinel} aria-hidden className="block h-0" />
      {/* The chevron and the actions share the name's line, so the bar and its flags below take the header's whole width. */}
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5",
          "@max-[760px]/plan:sticky @max-[760px]/plan:top-0 @max-[760px]/plan:z-10 @max-[760px]/plan:h-11 @max-[760px]/plan:flex-nowrap @max-[760px]/plan:items-center @max-[760px]/plan:gap-x-2 @max-[760px]/plan:border-b @max-[760px]/plan:border-transparent @max-[760px]/plan:bg-card @max-[760px]/plan:px-3",
          stuck && "@max-[760px]/plan:border-border",
          drop !== null && RING_LINE,
          over,
        )}
        data-plan-horizon-line={horizon.identifier}
        data-stuck={stuck ? "" : undefined}
      >
        <FoldButton name={horizon.name} folded={folded} onFold={onFold} data-plan-horizon-fold={horizon.identifier} />
        {renaming ? (
          <RenameField horizon={horizon} write={write} onClose={() => setRenaming(false)} />
        ) : (
          <h2 className="m-0 min-w-0 text-title font-semibold">
            {canRename ? (
              <button type="button" className="focus-ring min-h-0 max-w-full truncate rounded-sm text-left @max-[760px]/plan:-my-[5px] @max-[760px]/plan:py-[5px]" onClick={() => setRenaming(true)} title="Rename">
                {horizon.name}
              </button>
            ) : (
              <span className="block truncate">{horizon.name}</span>
            )}
          </h2>
        )}
        {/* Under 760px the date gives way before the name: it shrinks a hundred times faster and truncates. */}
        <span className={cn("flex items-center gap-2 text-caption text-text-tertiary", !dating && "@max-[760px]/plan:block @max-[760px]/plan:min-w-0 @max-[760px]/plan:shrink-[100] @max-[760px]/plan:truncate")}>
          {dating ? (
            <input
              ref={dateRef}
              type="date"
              defaultValue={horizon.date ?? ""}
              aria-label={`${horizon.name} date`}
              className="h-8 rounded-md border bg-field px-2 text-label text-foreground"
              onChange={(event) => {
                if (event.target.value) {
                  setDating(false);
                  void write("horizon-update", { ref: horizon.id, date: event.target.value });
                }
              }}
              onBlur={() => setDating(false)}
            />
          ) : (
            <>
              {horizon.date ? <HorizonWhen date={horizon.date} today={today} /> : null}
              {dateLink ? <span className="contents @max-[760px]/plan:hidden">{dateLink}</span> : null}
            </>
          )}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-1.5 self-center">
          {percent !== null && !renaming && !dating ? (
            <span className="hidden text-label font-semibold tabular-nums text-foreground @max-[760px]/plan:inline" data-plan-horizon-percent={horizon.identifier}>
              {percent}
            </span>
          ) : null}
          {queue ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 @max-[760px]/plan:hidden"
              disabled={Boolean(queue.disabledReason)}
              title={queue.disabledReason}
              data-plan-horizon-queue={horizon.identifier}
              onClick={() => queue.call?.route === "plan" && void write(queue.call.verb, queue.call.body)}
            >
              <ListPlus aria-hidden />
              {queue.disabledReason ? "Queued" : "Queue"}
            </Button>
          ) : null}
          {run ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 @max-[760px]/plan:hidden"
              disabled={Boolean(run.disabledReason)}
              title={run.disabledReason ?? "How far agents take this horizon when they pick its work up"}
              data-plan-horizon-run={horizon.identifier}
              onClick={() => setRunning(true)}
            >
              <SlidersHorizontal aria-hidden />
              {runSettingLabel(horizon.runMode)}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-text-tertiary @max-[760px]/plan:-my-2.5 @max-[760px]/plan:size-9" aria-label={`${horizon.name} options`} data-plan-horizon-menu={horizon.identifier}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onOpen(horizon.id)} data-plan-horizon-open={horizon.identifier}>
                Open the horizon
              </DropdownMenuItem>
              {/* From the horizon's offered actions: an active one is not removed, a held-back one says why. */}
              {canRename ? <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem> : null}
              {canDate ? <DropdownMenuItem onSelect={() => setDating(true)}>{horizon.date ? "Change date" : "Add a date"}</DropdownMenuItem> : null}
              {items.map((item) => (
                <HorizonMenuItem key={item.id} item={item} identifier={horizon.identifier} onChoose={(call) => void write(call.verb, call.body)} onOpen={() => setRunning(true)} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/* The bar beside it says the percent from 760px; under that the first line does. */}
      <div className={cn("mt-1.5 @max-[760px]/plan:mt-0 @max-[760px]/plan:border-b @max-[760px]/plan:bg-card @max-[760px]/plan:px-3 @max-[760px]/plan:pb-2.5", drop !== null && RING_BLOCK, over)}>
        <HorizonSummary horizon={horizon} today={today} heading={null} className="[&>div:first-child]:mt-0 @max-[760px]/plan:[&_[data-plan-tree-bar]>span]:hidden" />
        {dateLink ? <div className="mt-1 hidden text-caption text-text-tertiary @max-[760px]/plan:flex">{dateLink}</div> : null}
      </div>
      {running ? <RunSettingDialog horizon={horizon} write={write} onClose={() => setRunning(false)} /> : null}
    </header>
  );
}

/** Whether the element after `sentinel` is stuck: the sentinel has scrolled out above the lens's scroller. */
function useStuck(sentinel: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    const root = element?.closest("[data-plan-board]");
    if (!element || !root || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting && entry!.boundingClientRect.top < (entry!.rootBounds?.top ?? 0) + 1), { root, threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinel]);
  return stuck;
}

/**
 * The inline rename. It writes once: on submit, and on blur only when the name changed, no write
 * is in flight and it is not the name just refused. A refused write leaves it open with the name
 * as typed, so the person can fix it; Escape or an unchanged name closes it.
 */
export function RenameField({ horizon, write, onClose }: { horizon: Pick<HorizonData, "id" | "identifier" | "name">; write: Write; onClose: () => void }) {
  const [name, setName] = useState(horizon.name);
  const busy = useRef(false);
  const refused = useRef<string | null>(null);
  const submit = async () => {
    const clean = name.trim();
    if (busy.current) return;
    if (!clean || clean === horizon.name) {
      onClose();
      return;
    }
    busy.current = true;
    if (await write("horizon-update", { ref: horizon.id, name: clean })) {
      // Closing: a blur as the field goes away must not write it again.
      onClose();
      return;
    }
    busy.current = false;
    refused.current = clean;
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="min-w-0 flex-1"
      data-plan-horizon-rename={horizon.identifier}
    >
      <Input
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (busy.current || name.trim() === refused.current) return;
          void submit();
        }}
        aria-label="Horizon name"
        className="h-8"
      />
    </form>
  );
}

/**
 * One of the horizon's one-click actions in its menu. An action its state offers but cannot run
 * yet (Remove while it is queued) is shown disabled, with the reason under its label.
 */
export function HorizonMenuItem({ item, identifier, onChoose, onOpen }: { item: PlanItem; identifier: string; onChoose: (call: { verb: string; body: Record<string, unknown> }) => void; onOpen?: () => void }) {
  const call = item.call?.route === "plan" ? item.call : null;
  return (
    <DropdownMenuItem
      disabled={Boolean(item.disabledReason)}
      onSelect={() => (call ? onChoose(call) : item.opens === "run" ? onOpen?.() : undefined)}
      data-plan-horizon-remove={item.id === "remove" ? identifier : undefined}
      data-plan-horizon-action={item.id}
      className={item.disabledReason ? "flex-col items-start" : undefined}
    >
      <span className="inline-flex items-center gap-2">
        {item.id === "remove" ? <Trash2 aria-hidden /> : null}
        {item.label}
      </span>
      {item.disabledReason ? (
        <span className="text-caption text-text-tertiary" data-plan-horizon-held={item.id}>
          {item.disabledReason}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}
