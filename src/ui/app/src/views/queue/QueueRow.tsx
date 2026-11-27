/**
 * The Queue page's rows: a plan entry (its number is the drag handle), a task under an entry or
 * after the plan, an epic caption, and the state column they all share. They take props and
 * read no context, so `queue-render.test.tsx` renders them to static markup.
 *
 * ONE ROW, TWO SHAPES (queue.css). Wide, a row is one line: gutter, the task, its state, its
 * menu. Under 860px of the page's own width it is two lines: the title (up to two lines), then
 * the reference and the state under the status glyph. The markup is the same.
 */
import { ChevronRight, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { KindGlyph } from "@/components/task-list/KindGlyph";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import type { EffectiveQueueRow, IssueKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { CaptionLine, EntryBlock, TaskLine } from "./queue-lines";
import type { PlanRow } from "./queue-model";
import { PROGRESS_COLOR } from "@/views/progress-palette";
import { countParts, countsOf, coveredWords, rollUp, rowState, type Counts, type RowState } from "./queue-words";
import type { EntryDrag } from "./queue-drag";

/** The kinds that wear a glyph beside the reference: the containers and a bug. */
const MARKED_KINDS: ReadonlySet<IssueKind> = new Set(["epic", "milestone", "bug"]);

function KindMark({ kind }: { kind: IssueKind }) {
  return MARKED_KINDS.has(kind) ? (
    <span className="q-kind" title={kind}>
      <KindGlyph kind={kind} />
    </span>
  ) : null;
}

/**
 * The meter's colours: the app's progress palette, except waiting. Here waiting is the normal
 * state of a sequenced plan, so it is a neutral grey, not the palette's blocked red.
 */
const METER_COLOR = {
  done: PROGRESS_COLOR.done,
  active: PROGRESS_COLOR.active,
  ready: PROGRESS_COLOR.ready,
  waiting: "var(--ds-gray-600)",
} as const;

/** The meter, done → active → ready → waiting. */
export function Meter({ counts, small = false }: { counts: Counts; small?: boolean }) {
  const order = ["done", "active", "ready", "waiting"] as const;
  const total = order.reduce((sum, bucket) => sum + counts[bucket], 0);
  if (total === 0) return null;
  const label = countParts(counts)
    .map((part) => `${part.count} ${part.word}`)
    .join(", ");
  return (
    <span className={cn("q-meter", small && "q-meter-sm")} role="img" aria-label={label}>
      {order
        .filter((bucket) => counts[bucket] > 0)
        .map((bucket) => (
          <span key={bucket} data-segment={bucket} style={{ flexGrow: counts[bucket], background: METER_COLOR[bucket] }} />
        ))}
    </span>
  );
}

/**
 * A reference that jumps to its row when the row is on the page, and opens the task otherwise.
 * In the tab order only on the row that holds the list's tab stop, like the row's ⋯.
 */
function JumpLink({ identifier, tabIndex, onJump }: { identifier: string; tabIndex: number; onJump: (identifier: string) => void }) {
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      data-queue-jump={identifier}
      className="q-link"
      onClick={(event) => {
        event.stopPropagation();
        onJump(identifier);
      }}
    >
      {identifier}
    </button>
  );
}

/** The state column for a task row: mark and words, never colour alone. */
export function StateCell({
  state,
  identifier,
  eligibility,
  tabIndex,
  onJump,
}: {
  state: RowState;
  identifier: string;
  eligibility: EffectiveQueueRow["eligibility"];
  /** The row's own tab index, for the links in the words. */
  tabIndex: number;
  onJump: (identifier: string) => void;
}) {
  return (
    <span className={cn("q-state", `q-tone-${state.tone}`)} data-queue-eligibility={eligibility} title={state.words}>
      <span className="q-ref2">{identifier} ·</span>
      <span className="q-dot" aria-hidden />
      {state.holder ? (
        <span className="q-who" aria-hidden title={state.holder}>
          {state.initials}
        </span>
      ) : null}
      <span className="q-words">
        {state.blockers ? (
          <>
            Waiting on{" "}
            {state.blockers.map((blocker, i) => (
              <span key={blocker}>
                {i > 0 ? ", " : null}
                <JumpLink identifier={blocker} tabIndex={tabIndex} onJump={onJump} />
              </span>
            ))}
          </>
        ) : state.holder ? (
          <>
            Working · {state.holder}
            {state.quiet ? <span className="q-quiet"> · {state.quiet}</span> : null}
          </>
        ) : (
          state.words
        )}
      </span>
    </span>
  );
}

/** A roll-up with its ready count in bold: the number a reader scans the column for. */
function RollUpWords({ text }: { text: string }) {
  return (
    <>
      {text.split(" · ").map((part, i) => {
        const ready = /^(\d+) ready$/.exec(part);
        return (
          <span key={part}>
            {i > 0 ? " · " : null}
            {ready ? (
              <>
                <b>{ready[1]}</b> ready
              </>
            ) : (
              part
            )}
          </span>
        );
      })}
    </>
  );
}

/** A leaf entry's own state: its row's, or Done or Nothing open inside when the order holds no row for it. */
function leafState(plan: PlanRow): { state: RowState; eligibility: EffectiveQueueRow["eligibility"] } {
  if (plan.effective) return { state: rowState(plan.effective), eligibility: plan.effective.eligibility };
  return plan.entry.resolved
    ? { state: { tone: "done", words: "Done" }, eligibility: "resolved" }
    : { state: { tone: "waiting", words: "Nothing open inside" }, eligibility: "unavailable" };
}

/** What a row's state column says, as one spoken phrase: "Working · fable" → "Working, fable". */
function spoken(words: string): string {
  return words.split(" · ").join(", ");
}

/** The words of an entry's state column, whichever shape it takes. */
function entryWords(block: EntryBlock): string {
  if (block.container) return rollUp(block.plan.expansion);
  if (block.covered) return coveredWords(block.covered);
  return leafState(block.plan).state.words;
}

/** A plan entry's state: a container's roll-up, an entry the order already reached, or its own row's state. */
function EntryState({ block, tabIndex, onJump }: { block: EntryBlock; tabIndex: number; onJump: (identifier: string) => void }) {
  const { plan } = block;
  const identifier = plan.entry.identifier;
  if (block.container) {
    return (
      <span className="q-state q-rollup">
        <Meter counts={countsOf(plan.expansion)} small />
        <span className="q-words">
          <span className="q-wide">
            <RollUpWords text={rollUp(plan.expansion)} />
          </span>
          <span className="q-narrow">
            <RollUpWords text={rollUp(plan.expansion, true)} />
          </span>
        </span>
      </span>
    );
  }
  if (block.covered) {
    return (
      <span className="q-state q-tone-waiting" title={coveredWords(block.covered)}>
        <span className="q-ref2">{identifier} ·</span>
        <span className="q-dot" aria-hidden />
        <span className="q-words">
          Already in the order at #{block.covered.position}, inside{" "}
          <button
            type="button"
            tabIndex={tabIndex}
            className="q-link"
            data-queue-jump={block.covered.identifier}
            onClick={(event) => {
              event.stopPropagation();
              onJump(block.covered!.identifier);
            }}
          >
            {block.covered.via}
          </button>
        </span>
      </span>
    );
  }
  const { state, eligibility } = leafState(plan);
  return <StateCell state={state} identifier={identifier} eligibility={eligibility} tabIndex={tabIndex} onJump={onJump} />;
}

/**
 * The row's ⋯: the button the menu wraps (an element, not a component, so the menu's trigger
 * props and ref land on the button). Visible on hover and focus, always on touch.
 */
export function menuTrigger(identifier: string, tabIndex: number): ReactNode {
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={`Actions for ${identifier}`}
      data-queue-menu={identifier}
      className="q-more"
    >
      <MoreHorizontal aria-hidden className="size-4" />
    </button>
  );
}

/** How a row is wired into the page: its tab stop, its ref and its handlers. */
export interface RowWiring {
  /** It holds the page's one tab stop: it and its buttons are in the tab order. */
  active: boolean;
  rowRef?: (element: HTMLElement | null) => void;
  onOpen: (identifier: string) => void;
  onJump: (identifier: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** The row's ⋯ menu around the trigger it is handed. */
  menu: (identifier: string, trigger: ReactNode) => ReactNode;
}

function rowClick(onOpen: (identifier: string) => void, identifier: string) {
  return (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, a, [role=menu]")) return;
    onOpen(identifier);
  };
}

/** A plan entry: its number (the drag handle), the task or container, its state and its menu. */
export function EntryRow({
  block,
  wiring,
  pending,
  busy,
  total,
  dragging,
  handle,
  onToggle,
}: {
  block: EntryBlock;
  wiring: RowWiring;
  /** This entry's write is in flight. */
  pending: boolean;
  /** A write is in flight in this section: handles are inert. */
  busy: boolean;
  /** How many entries the plan has, for the handle's name. */
  total: number;
  dragging: boolean;
  handle?: ReturnType<EntryDrag["handleProps"]>;
  onToggle: (identifier: string) => void;
}) {
  const { plan } = block;
  const { entry } = plan;
  const identifier = entry.identifier;
  const tabIndex = wiring.active ? 0 : -1;
  const inFlight = plan.effective?.eligibility === "claimed";
  return (
    <div
      role="listitem"
      ref={wiring.rowRef}
      tabIndex={tabIndex}
      aria-busy={pending || undefined}
      aria-label={`${entry.planPosition}. ${identifier} ${entry.title}, ${spoken(entryWords(block))}${block.isNext ? ", next pick" : ""}`}
      data-queue-entry={identifier}
      data-queue-row={block.key}
      data-identifier={identifier}
      data-queue-resolved={entry.resolved ? "true" : undefined}
      data-queue-inflight={inFlight ? "true" : undefined}
      data-next={block.isNext ? "" : undefined}
      data-next-inside={block.holdsNext ? "" : undefined}
      data-open={block.open ? "" : undefined}
      data-pending={pending ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      title={block.holdsNext ? "The next pick is inside" : undefined}
      className="q-row q-entry"
      onClick={rowClick(wiring.onOpen, identifier)}
      onKeyDown={wiring.onKeyDown}
    >
      <button
        type="button"
        tabIndex={tabIndex}
        aria-disabled={busy || undefined}
        aria-label={`Move ${identifier}, now ${entry.planPosition} of ${total}. Drag, or press Alt and an arrow key`}
        title="Drag to reorder · Alt ↑ ↓"
        data-queue-handle={identifier}
        className="q-handle"
        onClick={(event) => event.stopPropagation()}
        {...(busy ? {} : handle)}
      >
        <GripVertical aria-hidden className="q-grip" />
        <span className="q-n">{entry.planPosition}</span>
      </button>
      <span className="q-main">
        <span className="q-lead">
          {block.container ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${block.open ? "Fold" : "Open"} ${identifier}`}
              aria-expanded={block.open}
              data-queue-fold={identifier}
              className="q-chev"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(identifier);
              }}
            >
              <ChevronRight aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </span>
        <StatusIcon status={entry.status} className="q-glyph" />
        <span className="q-ref">{identifier}</span>
        <KindMark kind={entry.kind} />
        <span className="q-title" title={entry.title}>
          {entry.title}
        </span>
      </span>
      <EntryState block={block} tabIndex={tabIndex} onJump={wiring.onJump} />
      <span className="q-actions">{wiring.menu(identifier, menuTrigger(identifier, tabIndex))}</span>
    </div>
  );
}

/** An entry's note: a 12px line under its row, an item of the list in its own right. */
export function EntryNote({ note }: { note: string }) {
  return (
    <div role="listitem" data-queue-note className="q-note">
      {note}
    </div>
  );
}

/** A task under a plan entry, or after the plan. */
export function TaskRow({
  line,
  place,
  wiring,
  onAdd,
}: {
  line: TaskLine;
  place: "nested" | "band";
  wiring: RowWiring;
  /** After the plan: the row's Add. */
  onAdd?: (identifier: string) => void;
}) {
  const { row } = line;
  const identifier = row.identifier;
  const tabIndex = wiring.active ? 0 : -1;
  const claimed = row.eligibility === "claimed";
  const resolved = row.eligibility === "resolved";
  const ordinal = place === "nested" && !resolved && !row.unqueued ? `#${row.position}` : null;
  const state = rowState(row);
  return (
    <div
      role="listitem"
      ref={wiring.rowRef}
      tabIndex={tabIndex}
      aria-label={`${ordinal ? `${ordinal} ` : ""}${identifier} ${row.title}, ${spoken(state.words)}${line.isNext ? ", next pick" : ""}`}
      data-queue-tree-row={identifier}
      data-queue-row={line.key}
      data-identifier={identifier}
      data-queue-inflight={claimed ? "true" : undefined}
      data-queue-resolved={resolved ? "true" : undefined}
      data-child={place === "nested" ? "" : undefined}
      data-next={line.isNext ? "" : undefined}
      className="q-row q-task"
      onClick={rowClick(wiring.onOpen, identifier)}
      onKeyDown={wiring.onKeyDown}
    >
      <span className={cn("q-ord", claimed && "q-taken")} aria-hidden={ordinal ? undefined : true}>
        {ordinal}
      </span>
      <span className="q-main">
        <span className="q-lead" />
        <StatusIcon status={row.status} className="q-glyph" />
        <span className="q-ref">{identifier}</span>
        <KindMark kind={row.kind} />
        <span className="q-title" title={row.title}>
          {row.title}
        </span>
      </span>
      <StateCell state={state} identifier={identifier} eligibility={row.eligibility} tabIndex={tabIndex} onJump={wiring.onJump} />
      <span className="q-actions">
        {onAdd ? (
          <button
            type="button"
            tabIndex={tabIndex}
            aria-label={`Add ${identifier} to the plan`}
            title={`Add ${identifier} to the plan`}
            data-queue-band-add={identifier}
            className="q-act"
            onClick={(event) => {
              event.stopPropagation();
              onAdd(identifier);
            }}
          >
            <Plus aria-hidden className="size-3.5" />
            <span className="q-act-word">Add</span>
          </button>
        ) : null}
        {wiring.menu(identifier, menuTrigger(identifier, tabIndex))}
      </span>
    </div>
  );
}

/** An epic between a plan entry and its tasks: context, not a row to act on. */
export function CaptionRow({ line }: { line: CaptionLine }) {
  return (
    <div
      role={line.title ? "listitem" : undefined}
      className="q-row q-caption"
      data-child=""
      data-queue-caption={line.identifier}
      aria-hidden={line.title ? undefined : true}
    >
      <span />
      <span className="q-main">
        <span className="q-lead" />
        <span className="q-kind">
          <KindGlyph kind={line.issueKind} />
        </span>
        <span className="q-ref">{line.identifier}</span>
        <span className="q-title" title={line.title}>
          {line.title}
        </span>
      </span>
    </div>
  );
}

/** "103 more in EXE-234 · Show all 108", and back. */
export function MoreRow({
  total,
  page,
  whole,
  inside,
  item = false,
  onToggle,
  marker,
}: {
  total: number;
  page: number;
  whole: boolean;
  inside?: string;
  /** It sits in a list, as one of its items. */
  item?: boolean;
  onToggle: () => void;
  marker: Record<string, string>;
}) {
  return (
    <div
      role={item ? "listitem" : undefined}
      className="q-moreline"
      {...marker}
    >
      {whole ? null : <span>{inside ? `${total - page} more in ${inside}` : `${total - page} more`}</span>}
      <button type="button" className="q-textbtn" onClick={onToggle}>
        {whole ? `Show the first ${page} only` : `Show all ${total}`}
      </button>
    </div>
  );
}
