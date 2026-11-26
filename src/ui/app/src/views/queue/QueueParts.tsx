/**
 * The Queue page's section furniture: the workspace page's strip, a section header on All
 * workspaces, the policy tag, Add to queue, the pinned next row, the band after the plan, the
 * conflict banner, the empty plan, the skeleton and the key hint. They take props and read no
 * context, so `queue-render.test.tsx` renders them to static markup.
 */
import { ChevronDown, ChevronRight, Lock, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterOptions, type SelectOption } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import type { EffectiveQueueRow, QueuePolicy } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Meter } from "./QueueRow";
import type { QueueSummary } from "./queue-summary";
import { bandWords, countParts, type Why } from "./queue-words";

// ---------- the policy tag ----------

const POLICY_TEXT: Readonly<Record<QueuePolicy, { name: string; body: string; hint: string }>> = {
  advisory: {
    name: "Advisory order",
    body: "Agents are handed work in this order, but an agent can still claim any ready task. Switch to strict when several agents work unattended and the order matters.",
    hint: "Agents may take any ready task; the order is a strong hint",
  },
  strict: {
    name: "Strict order",
    body: "An agent is refused a later task while an earlier one in the plan can be taken. Only you can step over the plan.",
    hint: "Agents must take work in this order",
  },
};

/** "Advisory order" or "Strict order"; opens one paragraph and the way to Settings. No switch here. */
export function PolicyTag({ policy, workspace, onOpenSettings }: { policy: QueuePolicy; workspace: string; onOpenSettings: () => void }) {
  const text = POLICY_TEXT[policy];
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("q-tag", policy === "strict" && "q-tag-strict")} title={text.hint} data-queue-policy={policy}>
          {policy === "strict" ? <Lock aria-hidden className="size-3" /> : null}
          {text.name}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-16px))] p-3 text-label text-text-secondary">
        <p className="m-0 mb-2">
          <span className="font-semibold text-foreground">{text.name}</span> in {workspace}.
        </p>
        <p className="m-0 mb-3">{text.body}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            onOpenSettings();
          }}
        >
          Change in Settings
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// ---------- Add to queue ----------

/**
 * Add to queue: the app's task picker (the same options, filter and option row as
 * `SearchableSelect`) in a popover behind a button. Picking adds to the end of the plan. It
 * never offers to create: a queue entry is a relation to work that exists.
 */
export function AddToQueue({
  workspace,
  options,
  onPick,
  disabled,
  primary = false,
  compact = false,
}: {
  workspace: string;
  options: readonly SelectOption[];
  onPick: (ref: string) => void;
  disabled: boolean;
  /** The workspace page's own action; a section header's is outline. */
  primary?: boolean;
  /** Icon-only when the page is narrow. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = filterOptions(options, query).slice(0, 60);
  return (
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={primary ? "default" : "outline"}
          size="xs"
          disabled={disabled}
          data-queue-add={workspace}
          aria-label={compact ? `Add to ${workspace}'s queue` : undefined}
          className={cn("q-add h-7 px-2.5 text-[12px]", compact && "q-add-compact")}
        >
          <Plus aria-hidden />
          <span className="q-add-word">Add to queue</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-[min(420px,calc(100vw-16px))] p-0" data-select-list="queue-add">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={`Search ${workspace} by title or reference…`} data-select-search="queue-add" />
          <CommandList>
            {matches.length === 0 ? <CommandEmpty>Nothing matches, or it is already in the plan.</CommandEmpty> : null}
            {matches.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                data-select-option={option.value}
                onSelect={() => {
                  setOpen(false);
                  onPick(option.value);
                }}
              >
                {option.status ? <StatusIcon status={option.status} className="size-3.5 shrink-0" /> : null}
                <span className="w-[68px] shrink-0 font-mono text-[12px] text-text-tertiary">{option.label}</span>
                <span className="min-w-0 flex-1 truncate">{option.hint}</span>
              </CommandItem>
            ))}
          </CommandList>
          <div className="border-t px-2.5 py-1.5 text-[11px] text-text-tertiary">
            Adds to the end of {workspace}'s plan. An epic or a milestone stands for the open tasks inside it.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------- the counts ----------

/** Meter, "19 in the plan: 3 ready · 4 being worked on · …" and Clear N finished. */
export function Standing({
  summary,
  finished,
  busy,
  onPrune,
}: {
  summary: QueueSummary;
  finished: number;
  busy: boolean;
  onPrune: () => void;
}) {
  if (summary.planned === 0) {
    return (
      <span className="q-stand">
        <span className="q-words">No plan</span>
      </span>
    );
  }
  const wide = countParts(summary.counts);
  const narrow = countParts(summary.counts, true);
  return (
    <span className="q-stand">
      <Meter counts={summary.counts} />
      <span className="q-words">
        <span className="q-wide">
          <b>{summary.planned}</b> in the plan:{" "}
        </span>
        {wide.map((part, i) => (
          <span key={part.bucket}>
            {i > 0 ? " · " : null}
            <b>{part.count}</b> <span className="q-wide">{part.word}</span>
            <span className="q-narrow">{narrow[i]!.word}</span>
          </span>
        ))}
      </span>
      {finished > 0 ? (
        <button type="button" className="q-textbtn" disabled={busy} onClick={onPrune} aria-label={`Clear ${finished} finished`} title="Remove finished entries from the plan">
          Clear<span className="q-wide"> {finished} finished</span>
        </button>
      ) : null}
    </span>
  );
}

/** The workspace page's strip: policy, counts, the autopilot link, Add (wide only; narrow has it on the title line). */
export function PageStrip({ policy, standing, autopilot, add }: { policy: ReactNode; standing: ReactNode; autopilot?: ReactNode; add: ReactNode }) {
  return (
    <div className="q-head q-strip" data-queue-strip="">
      {policy}
      {standing}
      {autopilot}
      <span className="q-sp" />
      <span className="q-strip-add">{add}</span>
    </div>
  );
}

/** "Autopilot is working this queue", to the run's page. */
export function AutopilotLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="q-tag q-tag-live q-wide-flex" onClick={onOpen} data-queue-autopilot="">
      <i aria-hidden />
      Autopilot is working this queue
    </button>
  );
}

/** A section header on All workspaces: fold, tile and name, policy, counts, Add. */
export function SectionHeader({
  workspace,
  prefix,
  folded,
  onToggle,
  policy,
  standing,
  add,
}: {
  workspace: string;
  prefix: string;
  folded: boolean;
  onToggle: () => void;
  policy: ReactNode;
  standing: ReactNode;
  add: ReactNode;
}) {
  return (
    <div className="q-head q-sechead" data-queue-section-head={workspace}>
      <button type="button" className="q-fold" aria-expanded={!folded} aria-label={`${folded ? "Open" : "Fold"} ${workspace}`} onClick={onToggle}>
        <ChevronDown aria-hidden className="size-3.5" />
      </button>
      <h2 className="q-name">
        <span className="q-tile" aria-hidden>
          {(prefix[0] ?? workspace[0] ?? "?").toUpperCase()}
        </span>
        <span className="truncate">{workspace}</span>
      </h2>
      {policy}
      {standing}
      <span className="q-sp" />
      {add}
    </div>
  );
}

/** All workspaces' strip: how many plans, and Collapse all / Expand all. */
export function AllStrip({ plans, workspaces, allFolded, onFoldAll }: { plans: number; workspaces: number; allFolded: boolean; onFoldAll: () => void }) {
  return (
    <div className="q-allstrip">
      <span>
        {plans} {plans === 1 ? "plan" : "plans"} across {workspaces} {workspaces === 1 ? "workspace" : "workspaces"}. Each workspace keeps its own order.
      </span>
      <span className="q-sp" />
      <FoldAllButton allFolded={allFolded} onFoldAll={onFoldAll} />
    </div>
  );
}

export function FoldAllButton({ allFolded, onFoldAll }: { allFolded: boolean; onFoldAll: () => void }) {
  return (
    <Button variant="ghost" size="xs" onClick={onFoldAll} data-queue-fold-all={allFolded ? "expand" : "collapse"}>
      {allFolded ? "Expand all" : "Collapse all"}
    </Button>
  );
}

// ---------- the pinned next row ----------

export type NextState =
  | { kind: "pick"; row: EffectiveQueueRow; why: Why }
  | { kind: "none"; text: string }
  | { kind: "empty" };

/**
 * The first row under every header: what an agent asking now would be handed, and why that one.
 * The only place the word Next appears. A click shows the task in the list.
 */
export function NextRow({ state, onOpen, onShow }: { state: NextState; onOpen: (identifier: string) => void; onShow: (identifier: string) => void }) {
  if (state.kind === "empty") {
    return (
      <div className="q-next q-next-plain" data-queue-next-up data-queue-next="none">
        <span className="q-lab">Next</span>
        <span className="q-main">
          <span className="q-title text-text-tertiary">No open work</span>
        </span>
      </div>
    );
  }
  if (state.kind === "none") {
    return (
      <div className="q-next q-next-none" data-queue-next-up data-queue-next="none">
        <span className="q-lab">Next</span>
        <span className="q-main">
          <span className="q-title">Nothing can be picked up right now</span>
        </span>
        <span className="q-why">{state.text}</span>
      </div>
    );
  }
  const { row, why } = state;
  return (
    <div className="q-next" data-queue-next-up data-queue-next="eligible" onClick={() => onShow(row.identifier)}>
      <span className="q-lab">Next</span>
      <span className="q-main">
        <StatusIcon status={row.status} className="q-glyph" />
        <span className="q-ref" data-queue-next-ref>
          {row.identifier}
        </span>
        <button
          type="button"
          className="q-title q-next-title"
          title={row.title}
          aria-label={`Next pick: ${row.identifier} ${row.title}. Show it in the list`}
          onClick={(event) => {
            event.stopPropagation();
            onShow(row.identifier);
          }}
        >
          {row.title}
        </button>
      </span>
      <span className="q-why">
        <span className="q-wide">{why.wide}</span>
        <span className="q-narrow">{why.narrow}</span>
      </span>
      <Button
        variant="ghost"
        size="xs"
        data-queue-next-open
        className="q-next-open bg-card px-2.5 hover:bg-surface-hover"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(row.identifier);
        }}
      >
        Open
      </Button>
    </div>
  );
}

// ---------- the band after the plan ----------

export function BandHead({ count, hasPlan, open, onToggle }: { count: number; hasPlan: boolean; open: boolean; onToggle: () => void }) {
  const words = bandWords(count, hasPlan);
  return (
    <button type="button" className="q-band-head" data-queue-unqueued-toggle aria-expanded={open} onClick={onToggle}>
      <ChevronRight aria-hidden className="q-band-chev size-3.5" />
      <b>{words.title}</b>
      <span data-queue-unqueued-count>
        {words.count}
        <span className="q-wide"> · {words.rest}</span>
      </span>
    </button>
  );
}

/** A plan with nothing in it, on a workspace page: what that means and the way to start one. */
export function EmptyPlan({ add }: { add: ReactNode }) {
  return (
    <div className="q-empty" data-queue-empty="">
      <h3>No plan yet</h3>
      <p>Agents take open work in list order until you put something first. Add a task, an epic or a milestone, and it goes to the front of the line.</p>
      {add}
    </div>
  );
}

// ---------- banners and states ----------

/** A move made against an older plan: nothing was saved, and the order shown is the current one. */
export function ConflictBanner({ canRetry, busy, onRetry, onDismiss }: { canRetry: boolean; busy: boolean; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" data-queue-conflict className="q-banner">
      <span>
        <b>The plan changed somewhere else, so your move was not saved.</b> The order below is the current one.
      </span>
      <span className="q-sp" />
      {canRetry ? (
        <Button variant="outline" size="xs" disabled={busy} onClick={onRetry}>
          Apply my move again
        </Button>
      ) : null}
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** Loading: skeleton rows in the list's shape, under the real header's shape. */
export function QueueSkeleton({ rows = 7, header = true }: { rows?: number; header?: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-queue-loading="">
      <span className="sr-only">Loading the queue</span>
      {header ? (
        <div aria-hidden className="q-head q-strip">
          <Skeleton className="h-3 w-24 rounded-full" />
          <Skeleton className="h-3 w-52 rounded-full" />
        </div>
      ) : null}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="q-row q-skel">
          <span />
          <span className="q-main">
            <span className="q-lead" />
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-2.5 w-[52px] rounded-full" />
            <Skeleton className="h-2.5 rounded-full" style={{ width: `${38 + ((i * 29) % 45)}%` }} />
          </span>
          <span className="q-state">
            <Skeleton className="h-2.5 rounded-full" style={{ width: `${30 + ((i * 17) % 40)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The keyboard, once, at the foot of a wide page. */
export function KeyHint() {
  return (
    <div className="q-foot" data-queue-keys="">
      <span>
        <kbd>↑</kbd> <kbd>↓</kbd> move through rows
      </span>
      <span>
        <kbd>Alt</kbd> + <kbd>↑</kbd> <kbd>↓</kbd> reorder
      </span>
      <span>
        <kbd>→</kbd> <kbd>←</kbd> open and fold
      </span>
      <span>
        <kbd>Enter</kbd> open the task
      </span>
    </div>
  );
}
