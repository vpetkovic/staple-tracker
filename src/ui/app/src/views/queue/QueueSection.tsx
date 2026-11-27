/**
 * One workspace's queue as rows: the pinned next row, a write's banner, the plan entries (each
 * with its note and, open, its paged expansion), the drop line while a drag is on, and the band
 * after the plan. Takes props and reads no context, so `queue-render.test.tsx` renders it.
 */
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import type { EntryDrag } from "./queue-drag";
import type { RowPlace, SectionLayout } from "./queue-lines";
import { BandHead, ConflictBanner, NextRow, type NextState } from "./QueueParts";
import { CaptionRow, EntryNote, EntryRow, MoreRow, TaskRow, type RowWiring } from "./QueueRow";
import type { QueueWriteFailure } from "./use-workspace-queue";

export interface SectionBodyProps {
  workspace: string;
  layout: SectionLayout;
  next: NextState;
  /** On All workspaces, a folded section draws only its next row. */
  folded: boolean;
  hasPlan: boolean;
  busy: boolean;
  /** The entry whose write is in flight. */
  pending: string | null;
  failure: QueueWriteFailure | null;
  /** The row that holds the page's one tab stop. */
  activeKey: string | null;
  register?: (key: string) => (element: HTMLElement | null) => void;
  onOpen: (identifier: string) => void;
  /** Show a task in the list: open what hides it, scroll to it, flash it. */
  onShow: (identifier: string) => void;
  onToggle: (identifier: string) => void;
  onWhole: (identifier: string) => void;
  onBand: () => void;
  onBandWhole: () => void;
  onAdd: (identifier: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
  onRowKey?: (event: KeyboardEvent<HTMLDivElement>, key: string, place: RowPlace, identifier: string) => void;
  menu: (place: RowPlace, identifier: string, trigger: ReactNode) => ReactNode;
  drag?: EntryDrag;
  listRef?: RefObject<HTMLDivElement | null>;
  /** The empty plan's block on a workspace page; absent on All workspaces. */
  empty?: ReactNode;
}

export function SectionBody(props: SectionBodyProps) {
  const { workspace, layout, folded, failure } = props;
  const wiring = (key: string, place: RowPlace): RowWiring => ({
    active: props.activeKey === key,
    rowRef: props.register?.(key),
    onOpen: props.onOpen,
    onJump: props.onShow,
    onKeyDown: props.onRowKey
      ? (event) => props.onRowKey!(event, key, place, (event.currentTarget as HTMLElement).dataset.identifier ?? "")
      : undefined,
    menu: (identifier, trigger) => props.menu(place, identifier, trigger),
  });

  const nextRow = <NextRow state={props.next} onOpen={props.onOpen} onShow={props.onShow} />;
  if (folded) return nextRow;

  return (
    <>
      {failure ? (
        failure.kind === "conflict" ? (
          <ConflictBanner canRetry={failure.intended !== null} busy={props.busy} onRetry={props.onRetry} onDismiss={props.onDismiss} />
        ) : (
          <div className="q-refusal">
            <GuardRefusal refusal={failure.refusal} onDismiss={props.onDismiss} />
          </div>
        )
      ) : null}
      {nextRow}
      {layout.entries.length === 0 ? (
        props.empty ?? null
      ) : (
        <div role="list" aria-label={`${workspace}'s plan`} ref={props.listRef} className="q-list" data-queue-list={workspace}>
          {layout.entries.map((block) => (
            <div key={block.key} role="none" data-queue-entry-block={block.plan.entry.identifier}>
              <EntryRow
                block={block}
                wiring={wiring(block.key, "entry")}
                pending={props.pending === block.plan.entry.identifier}
                busy={props.busy}
                total={layout.entries.length}
                dragging={props.drag?.from === block.index}
                handle={props.drag?.handleProps(block.index)}
                onToggle={props.onToggle}
              />
              {block.plan.entry.note ? <EntryNote note={block.plan.entry.note} /> : null}
              {block.open ? (
                <div role="none" data-queue-expansion={block.plan.entry.identifier}>
                  {block.children.map((line) =>
                    line.kind === "caption" ? (
                      <CaptionRow key={line.key} line={line} />
                    ) : (
                      <TaskRow key={line.key} line={line} place="nested" wiring={wiring(line.key, "nested")} />
                    ),
                  )}
                  {block.more ? (
                    <MoreRow
                      {...block.more}
                      inside={block.plan.entry.identifier}
                      item
                      onToggle={() => props.onWhole(block.plan.entry.identifier)}
                      marker={{ "data-queue-expansion-more": block.plan.entry.identifier }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {props.drag?.lineTop != null ? <div role="presentation" className="q-dropline" style={{ top: props.drag.lineTop }} aria-hidden /> : null}
        </div>
      )}
      {layout.band ? (
        <section className="q-band" data-open={layout.band.open ? "" : undefined} data-queue-unqueued-section aria-label={props.hasPlan ? "After the plan" : "Open work"}>
          <BandHead count={layout.band.total} hasPlan={props.hasPlan} open={layout.band.open} onToggle={props.onBand} />
          {layout.band.open ? (
            <div role="list" aria-label={props.hasPlan ? `${workspace}'s open work after the plan` : `${workspace}'s open work`} data-queue-unqueued="true">
              {layout.band.rows.map((line) => (
                <TaskRow key={line.key} line={line} place="band" wiring={wiring(line.key, "band")} onAdd={props.onAdd} />
              ))}
            </div>
          ) : null}
          {layout.band.more ? <MoreRow {...layout.band.more} onToggle={props.onBandWhole} marker={{ "data-queue-unqueued-more": "" }} /> : null}
        </section>
      ) : null}
    </>
  );
}
