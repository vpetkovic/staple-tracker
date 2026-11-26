/**
 * A horizon section's sticky header in the Horizons lens: the fold chevron, the shared
 * `HorizonSummary` with the inline rename and date editors, and on the right Queue, the run
 * setting and the `⋯` menu (only the `⋯` under 760px of the Plan container; the menu holds Queue
 * and the run setting too, as the horizon's offered actions). Every action is one the horizon's
 * state offers. Under 760px each small control (the fold, the name, clear, add a date) takes a
 * 32px tap without changing how it looks.
 */
import { CalendarPlus, ChevronDown, ChevronRight, ListPlus, MoreHorizontal, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { HorizonData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { horizonActionItems, offers, type PlanItem } from "@/detail/plain-actions";
import { RunSettingDialog, runSettingLabel } from "./RunSetting";
import type { Write } from "./plan-board";
import { HorizonSummary, HorizonWhen } from "./plan-parts";

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
  useEffect(() => {
    if (dating) dateRef.current?.focus();
  }, [dating]);
  const canRename = offers(horizon, "rename");
  const canDate = offers(horizon, "date");
  const items = horizonActionItems("", horizon);
  const queue = items.find((item) => item.id === "queue");
  const run = items.find((item) => item.id === "run");
  return (
    <header
      className={cn(
        "sticky top-0 z-10 border-b bg-card px-4 pt-3 pb-2.5 @max-[760px]/plan:px-3",
        drop !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
        drop === "over" && "bg-surface-hover",
      )}
      data-plan-horizon={horizon.identifier}
      data-plan-horizon-done={done ? "" : undefined}
    >
      <HorizonSummary
        horizon={horizon}
        today={today}
        heading={
          // The chevron and the actions share the name's line, so the bar and its flags below
          // take the header's whole width, as the summary lays them out on every surface.
          <>
            {onFold === null ? (
              <span aria-hidden className="-ml-1 size-5 shrink-0" />
            ) : (
              <button
                type="button"
                aria-expanded={!folded}
                aria-label={`${folded ? "Show" : "Hide"} ${horizon.name}`}
                data-plan-horizon-fold={horizon.identifier}
                onClick={onFold}
                className="focus-ring relative -ml-1 inline-flex size-5 min-h-0 shrink-0 self-center items-center justify-center rounded text-text-tertiary hover:bg-surface-hover @max-[760px]/plan:before:absolute @max-[760px]/plan:before:-inset-1.5 @max-[760px]/plan:before:content-['']"
              >
                {folded ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
              </button>
            )}
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
            <span className="flex items-center gap-2 text-caption text-text-tertiary">
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
              ) : horizon.date ? (
                <>
                  <HorizonWhen date={horizon.date} today={today} />
                  {canDate ? (
                    <button type="button" className="focus-ring flex min-h-6 items-center gap-0.5 rounded-sm underline-offset-2 hover:underline @max-[760px]/plan:-my-1 @max-[760px]/plan:min-h-8" onClick={() => void write("horizon-update", { ref: horizon.id, date: null })} aria-label={`Clear ${horizon.name} date`} data-plan-horizon-clear-date={horizon.identifier}>
                      <X className="size-3" aria-hidden /> clear
                    </button>
                  ) : null}
                </>
              ) : canDate ? (
                <button type="button" className="focus-ring flex min-h-6 items-center gap-1 rounded-sm underline-offset-2 hover:underline @max-[760px]/plan:-my-1 @max-[760px]/plan:min-h-8" onClick={() => setDating(true)} data-plan-horizon-date={horizon.identifier}>
                  <CalendarPlus className="size-3" aria-hidden /> add a date
                </button>
              ) : null}
            </span>
            <div className="ms-auto flex shrink-0 items-center gap-1.5 self-center">
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
          </>
        }
      />
      {running ? <RunSettingDialog horizon={horizon} write={write} onClose={() => setRunning(false)} /> : null}
    </header>
  );
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
