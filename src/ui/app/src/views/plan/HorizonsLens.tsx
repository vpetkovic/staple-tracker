/**
 * The Horizons lens is delivery: shaped, started and shipped records by horizon, with progress,
 * the shipped mark and the horizon's Queue and Run. Each column draws its horizon's plan as one
 * tree; a top row is framed as its delivery card.
 */
import { CalendarPlus, ChevronDown, ChevronRight, ListPlus, MoreHorizontal, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { horizonActionItems, offers, type PlanItem } from "@/detail/plain-actions";
import { RunSettingDialog, runSettingLabel } from "./RunSetting";
import { PlanTree } from "./PlanTree";
import { Board, ColumnFrame, MoveMenu, openOnKey, type BoardProps, type Write } from "./plan-board";
import { HorizonSummary, HorizonWhen } from "./plan-parts";
import { planTree, type TreeRow } from "./plan-tree";
import { horizonDone, horizonsColumns, isShipped, type BoardColumn } from "./plan-model";

export function HorizonsBoard(props: BoardProps) {
  const columns = horizonsColumns(props.plan);
  return (
    <Board
      columns={columns}
      currentColumn={props.currentColumn}
      onColumn={props.onColumn}
      hint="Delivery: shaped, started and shipped work by horizon. Drag a ready card into a horizon to schedule it, or back to Unscheduled. A horizon with a date is a release line."
      action={<AddHorizon write={props.write} />}
      column={(column, desk) => <HorizonColumn key={column.key} {...props} column={column} columns={columns} desk={desk} />}
    />
  );
}

function HorizonColumn({ plan, column, columns, write, desk, onOpen, selected }: BoardProps & { column: BoardColumn; columns: BoardColumn[]; desk: boolean }) {
  const tree = planTree({ horizonId: column.horizon?.id ?? null, ideas: plan.ideas, horizons: plan.horizons });
  const done = column.horizon ? horizonDone(column.horizon) : false;
  const [showDone, setShowDone] = useState(false);
  const folded = done && !showDone;
  return (
    <ColumnFrame plan={plan} column={column} write={write} desk={desk}>
      {column.horizon ? (
        <HorizonHeader column={column} today={plan.today} write={write} onOpen={onOpen} done={done} />
      ) : (
        <header className="border-b px-3 py-2">
          <div className="flex items-baseline gap-2 text-body font-semibold">
            {column.title}
            <span className="text-label font-normal text-text-tertiary">{column.ideas.length}</span>
          </div>
          <div className="text-caption text-text-tertiary">{column.hint}</div>
        </header>
      )}
      {done ? (
        <button
          type="button"
          className="mx-2 mt-2 flex min-h-9 items-center gap-1.5 rounded-md px-1.5 text-left text-label text-text-secondary hover:bg-surface-hover"
          aria-expanded={!folded}
          data-plan-done-toggle={column.horizon!.identifier}
          onClick={() => setShowDone(!showDone)}
        >
          {folded ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0" aria-hidden />}
          <span>
            {column.horizon!.memberCount === 1 ? "The member landed" : `All ${column.horizon!.memberCount} members landed`} · {folded ? "show" : "hide"}
          </span>
        </button>
      ) : null}
      <div data-plan-scroll-key={column.key} className={cn("flex flex-col gap-2 p-2", desk && "min-h-0 overflow-y-auto", folded && "hidden")}>
        <PlanTree
          rows={tree}
          opener={{ onOpen }}
          drag
          selected={selected}
          wrap={(row, node) => (row.reserved ? node : <DeliveryCard row={row} column={column} columns={columns} write={write} onOpen={onOpen} selected={selected}>{node}</DeliveryCard>)}
        />
        {tree.length === 0 ? <div className="rounded-md border border-dashed px-3 py-4 text-center text-caption text-text-tertiary">Drop an idea here</div> : null}
      </div>
    </ColumnFrame>
  );
}

/**
 * A top row of a Horizons column framed as its delivery card: dragged by its row (on the desk),
 * opened by a click, moved by its menu, marked when selected, late or shipped.
 */
function DeliveryCard({ row, column, columns, write, onOpen, selected, children }: { row: TreeRow; column: BoardColumn; columns: BoardColumn[]; write: Write; onOpen: (id: string) => void; selected: string | null; children: ReactNode }) {
  const { idea } = row;
  const shipped = isShipped(idea);
  return (
    <article
      tabIndex={0}
      role="button"
      aria-label={`Open ${idea.title}`}
      onClick={() => onOpen(idea.id)}
      onKeyDown={(event) => openOnKey(event, () => onOpen(idea.id))}
      data-plan-card={idea.id}
      data-plan-card-shipped={shipped ? "" : undefined}
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        shipped ? "bg-surface-sunken shadow-none" : "bg-card",
        selected === idea.id && "border-ring",
        idea.late && !shipped && "border-l-2 border-l-destructive",
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <MoveMenu idea={idea} column={column} columns={columns} write={write} />
    </article>
  );
}

// ---------------------------------------------------------------- horizons

function HorizonHeader({ column, today, write, onOpen, done }: { column: BoardColumn; today: string; write: Write; onOpen: (id: string) => void; done: boolean }) {
  const horizon = column.horizon!;
  const [running, setRunning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [dating, setDating] = useState(false);
  const [name, setName] = useState(horizon.name);
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => setName(horizon.name), [horizon.name]);
  useEffect(() => {
    if (dating) dateRef.current?.focus();
  }, [dating]);
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== horizon.name) await write("horizon-update", { ref: horizon.id, name: name.trim() });
    setRenaming(false);
  };
  const items = horizonActionItems("", horizon);
  const queue = items.find((item) => item.id === "queue");
  const run = items.find((item) => item.id === "run");
  return (
    <header className="border-b px-3 py-2" data-plan-horizon={horizon.identifier} data-plan-horizon-done={done ? "" : undefined}>
      <div className="flex items-start gap-2">
        <HorizonSummary
          horizon={horizon}
          today={today}
          className="flex-1"
          heading={
            <>
              {renaming ? (
                <form onSubmit={rename} className="min-w-0 flex-1">
                  <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onBlur={rename} aria-label="Horizon name" className="h-8" />
                </form>
              ) : (
                <button type="button" className="min-w-0 truncate text-left text-title font-semibold" onClick={() => (offers(horizon, "rename") ? setRenaming(true) : undefined)} title={offers(horizon, "rename") ? "Rename" : horizon.name}>
                  {horizon.name}
                </button>
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
                    <button type="button" className="flex min-h-6 items-center gap-0.5 underline-offset-2 hover:underline" onClick={() => void write("horizon-update", { ref: horizon.id, date: null })} aria-label={`Clear ${horizon.name} date`}>
                      <X className="size-3" aria-hidden /> clear
                    </button>
                  </>
                ) : (
                  <button type="button" className="flex min-h-6 items-center gap-1 underline-offset-2 hover:underline" onClick={() => setDating(true)} data-plan-horizon-date={horizon.identifier}>
                    <CalendarPlus className="size-3" aria-hidden /> add a date
                  </button>
                )}
              </span>
            </>
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-mr-1.5 size-8 shrink-0 text-text-tertiary" aria-label={`${horizon.name} options`} data-plan-horizon-menu={horizon.identifier}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen(horizon.id)} data-plan-horizon-open={horizon.identifier}>
              Open the horizon
            </DropdownMenuItem>
            {/* From the horizon's offered actions: an active one is not removed, a held-back one says why. */}
            {offers(horizon, "rename") ? <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem> : null}
            {offers(horizon, "date") ? <DropdownMenuItem onSelect={() => setDating(true)}>{horizon.date ? "Change date" : "Add a date"}</DropdownMenuItem> : null}
            {items.map((item) => (
              <HorizonMenuItem key={item.id} item={item} identifier={horizon.identifier} onChoose={(call) => void write(call.verb, call.body)} onOpen={() => setRunning(true)} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {queue || run ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {queue ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-8"
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
              className="min-h-8"
              disabled={Boolean(run.disabledReason)}
              title={run.disabledReason ?? "How far agents take this horizon when they pick its work up"}
              data-plan-horizon-run={horizon.identifier}
              onClick={() => setRunning(true)}
            >
              <SlidersHorizontal aria-hidden />
              {runSettingLabel(horizon.runMode)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {running ? <RunSettingDialog horizon={horizon} write={write} onClose={() => setRunning(false)} /> : null}
    </header>
  );
}

/**
 * One of the horizon's one-click actions in its column menu. An action its state offers but
 * cannot run yet (Remove while it is queued) is shown disabled, with the reason under its label.
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

export function AddHorizon({ write }: { write: Write }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (await write("horizon-create", { name: name.trim(), date: date || null })) {
      setName("");
      setDate("");
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <Button variant="outline" size="sm" className="min-h-9" onClick={() => setOpen(true)} data-plan-add-horizon>
        <Plus aria-hidden />
        Horizon
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2 md:w-auto" data-plan-add-horizon-form>
      <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Q2" aria-label="New horizon name" className="h-9 w-40" />
      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="New horizon date (optional)" className="h-9 rounded-md border bg-field px-2 text-label" />
      <Button type="submit" size="sm">Add</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}
