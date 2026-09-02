/**
 * ONE editable, reorderable list — used for Statuses and for Kinds — O7b (STA-141).
 *
 * ── WHY ONE COMPONENT AND NOT TWO ─────────────────────────────────────────────────────
 *
 * Statuses and kinds differ in exactly one column (the category select) and in nothing
 * else: same rename-on-blur, same drag, same keyboard move, same remove-with-migrate-to,
 * same refusal surface. Two components that are ninety per cent identical drift, and they
 * drift in the half nobody opened recently — which here would mean a keyboard reorder that
 * works for statuses and silently does nothing for kinds. The category column is a prop.
 *
 * ── REORDER: DRAG, PLUS A REAL KEYBOARD PATH ──────────────────────────────────────────
 *
 * The drag is `@dnd-kit/core`. `@dnd-kit/sortable` is NOT installed and this ticket may
 * not add a dependency, so each row is its own droppable and the drop target is whichever
 * row the pointer is over — which for a single-column list is exactly what sortable would
 * have computed anyway.
 *
 * The keyboard path is a pair of VISIBLE, LABELLED buttons on every row, plus alt+arrow on
 * the row itself. It is deliberately not dnd-kit's keyboard sensor. A sensor is a mode you
 * have to know exists, entered from a control that reads as a drag handle and announces
 * nothing until you are already in it; two buttons that say "Move Todo up" are
 * discoverable, are what a screen reader lists when it enumerates the row's controls, and
 * are testable without a DOM event simulator. Both paths produce the same single
 * `{ op: "reorder", ids }`, so there is no second write path to keep honest.
 *
 * ── EVERY WRITE IS ONE BATCH, AND THE ANSWER IS THE WHOLE LIST ────────────────────────
 *
 * No local "draft" that is saved later. Each edit is a batch of one op, POSTed as the user
 * commits it, and the response is the entire new settings envelope, which is published to
 * lib/settings.ts. That is what makes "the UI re-derives from the served settings without a
 * reload" true rather than approximately true: nothing merges, nothing is patched in place,
 * and a workspace another agent edited underneath us corrects itself on the next write.
 *
 * The one exception is the reorder, which paints optimistically. A list that does not move
 * under the pointer until a round trip completes reads as a broken control; the server's
 * answer replaces the optimistic order a moment later, and a refusal restores it.
 */
import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Refusal } from "@/lib/refusal";
import { titleCaseId } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { StatusCategory, VocabularyOp } from "@/lib/types";
import {
  addOp,
  labelChanged,
  migrateCandidates,
  moveId,
  moveIndex,
  recategorizeOp,
  removeOp,
  renameOp,
  reorderOp,
  validateVocabularyId,
  type VocabularyRow,
} from "./settings-ops";

export interface VocabularyListProps {
  /** Which list this is — also the POST target and the `usage` bucket key. */
  target: "statuses" | "kinds";
  rows: VocabularyRow[];
  /** How many issues carry each id. A missing entry means "not known"; see `needsMigrate`. */
  usage: Record<string, number>;
  /** Statuses only: the fixed category set the select offers. */
  categories?: readonly StatusCategory[];
  /** Categories the store writes into, named in the removal warning. */
  requiredCategories?: readonly string[];
  /** Apply an ordered batch. Resolves true when the store accepted it. */
  apply: (ops: VocabularyOp[]) => Promise<boolean>;
  /** The last refusal, rendered once above the list rather than per row. */
  refusal: Refusal | null;
  busy: boolean;
}

const NO_MIGRATE = "__none__";

/**
 * One row. Draggable by its handle only — a row that is draggable by its whole surface
 * cannot also contain a text field you are allowed to select inside.
 */
function Row({
  row,
  index,
  count,
  target,
  categories,
  needsMigrate,
  usageCount,
  candidates,
  busy,
  onRename,
  onRecategorize,
  onMove,
  onRemove,
}: {
  row: VocabularyRow;
  index: number;
  count: number;
  target: "statuses" | "kinds";
  categories?: readonly StatusCategory[];
  needsMigrate: boolean;
  usageCount: number | null;
  candidates: VocabularyRow[];
  busy: boolean;
  onRename: (id: string, label: string) => void;
  onRecategorize: (id: string, category: StatusCategory) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string, migrateTo: string | null) => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [confirming, setConfirming] = useState(false);
  const [migrateTo, setMigrateTo] = useState<string>(NO_MIGRATE);

  const draggable = useDraggable({ id: row.id, disabled: busy });
  const droppable = useDroppable({ id: row.id, disabled: busy });

  // The label field is uncontrolled-by-the-server between edits: it holds what the user is
  // typing. `key={row.label}` on the input would fight the caret, so instead the local
  // state is re-seeded only when the row identity changes — see the `key` on this Row in
  // the list below, which is the id, not the label.
  const commit = useCallback(() => {
    if (labelChanged(row, label)) onRename(row.id, label);
    else setLabel(row.label);
  }, [label, onRename, row]);

  return (
    <div
      ref={droppable.setNodeRef}
      data-vocabulary-row={row.id}
      // alt+arrow, not bare arrow: bare arrows belong to whatever field has focus, and a
      // list that stole them would make the label field unnavigable.
      onKeyDown={(event) => {
        if (!event.altKey || busy) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMove(index, index - 1);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMove(index, index + 1);
        }
      }}
      className={cn(
        "flex flex-col gap-2 rounded-md border px-2 py-1.5",
        droppable.isOver && !draggable.isDragging ? "border-ring bg-surface-hover" : "border-transparent",
        draggable.isDragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          ref={draggable.setNodeRef}
          {...draggable.listeners}
          {...draggable.attributes}
          aria-label={`Drag ${row.label} to reorder`}
          title="Drag to reorder"
          className="shrink-0 cursor-grab rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>

        {target === "statuses" && row.category ? (
          <StatusIcon status={row.id} category={row.category} className="shrink-0" />
        ) : null}

        <span className="w-36 shrink-0 truncate font-mono text-[11px] text-text-tertiary" title={row.id}>
          {row.id}
        </span>

        <Input
          value={label}
          aria-label={`Label for ${row.id}`}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setLabel(row.label);
            }
          }}
          className="h-7 min-w-0 flex-1 text-[13px]"
        />

        {target === "statuses" && categories ? (
          <Select
            value={row.category}
            disabled={busy}
            onValueChange={(value) => onRecategorize(row.id, value as StatusCategory)}
          >
            <SelectTrigger size="sm" aria-label={`Category for ${row.id}`} className="w-[8.5rem] shrink-0 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <span className="w-16 shrink-0 text-right font-mono text-[11px] text-text-tertiary">
          {usageCount === null ? "" : `${usageCount}`}
        </span>

        {/*
          THE KEYBOARD ALTERNATIVE. Two ordinary buttons, always present, never a
          hover-reveal: an affordance that only exists once you have already pointed at
          the row is not an alternative to pointing at the row.
        */}
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move ${row.label} up`}
            disabled={busy || index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ChevronUp className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Move ${row.label} down`}
            disabled={busy || index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${row.label}`}
            disabled={busy}
            onClick={() => {
              setConfirming((open) => !open);
              setMigrateTo(NO_MIGRATE);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {confirming ? (
        /*
         * The migrate-to picker. REQUIRED when anything still carries this row, and the
         * confirm button stays disabled until a target is chosen — the store refuses
         * without one, and a form that lets you submit into a known refusal is a form that
         * teaches you to ignore it.
         *
         * When nothing carries it the picker is absent entirely rather than present-and-
         * optional. "Move 0 rows onto something" is not a decision worth offering.
         */
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-2 py-2">
          <span className="text-[12px] text-muted-foreground">
            {needsMigrate
              ? `${usageCount === null ? "Some" : usageCount} ${usageCount === 1 ? "issue" : "issues"} still carry "${row.label}". Move them to:`
              : `Remove "${row.label}"?`}
          </span>
          {needsMigrate ? (
            <Select value={migrateTo} onValueChange={setMigrateTo} disabled={busy}>
              <SelectTrigger size="sm" aria-label={`Migrate ${row.id} to`} className="w-[11rem] text-[12px]">
                <SelectValue placeholder="Choose a target…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || (needsMigrate && migrateTo === NO_MIGRATE)}
              onClick={() => {
                onRemove(row.id, migrateTo === NO_MIGRATE ? null : migrateTo);
                setConfirming(false);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VocabularyList({
  target,
  rows,
  usage,
  categories,
  requiredCategories,
  apply,
  refusal,
  busy,
}: VocabularyListProps) {
  /**
   * The order actually painted. Normally `rows` verbatim; briefly the optimistic order
   * between a drop and the server's answer. It is reset to `rows` on every render where
   * the served ids differ from the ones we are holding, which is what makes a refusal
   * put the list back without any explicit rollback.
   */
  const [pending, setPending] = useState<VocabularyRow[] | null>(null);
  const painted = pending ?? rows;

  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<StatusCategory>("unstarted");

  const idError = useMemo(
    () => (newId.trim() === "" ? null : validateVocabularyId(newId, rows)),
    [newId, rows],
  );

  const sensors = useSensors(
    // 4px so a click on the handle is still a click; without it every press starts a drag
    // and the button's own focus ring never appears.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const commitOrder = useCallback(
    async (next: VocabularyRow[]) => {
      setPending(next);
      const ok = await apply([reorderOp(next)]);
      // Either way, stop painting the optimistic list: on success the served order is
      // already identical, and on refusal it is the one the user should be looking at.
      setPending(null);
      return ok;
    },
    [apply],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const over = event.over?.id;
      if (!over || over === event.active.id) return;
      void commitOrder(moveId(painted, String(event.active.id), String(over)));
    },
    [commitOrder, painted],
  );

  const onMove = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= painted.length) return;
      void commitOrder(moveIndex(painted, from, to));
    },
    [commitOrder, painted],
  );

  const noun = target === "statuses" ? "status" : "kind";

  return (
    <div className="space-y-3">
      {refusal ? <GuardRefusal refusal={refusal} /> : null}

      <div className="flex items-center gap-2 px-2 text-[11px] tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
        <span className="w-[1.6rem] shrink-0" />
        {target === "statuses" ? <span className="w-4 shrink-0" /> : null}
        <span className="w-36 shrink-0">id</span>
        <span className="flex-1">label</span>
        {target === "statuses" ? <span className="w-[8.5rem] shrink-0">category</span> : null}
        <span className="w-16 shrink-0 text-right">in use</span>
        <span className="w-[6.5rem] shrink-0" />
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div role="list" className="space-y-0.5">
          {painted.map((row, index) => (
            <Row
              key={row.id}
              row={row}
              index={index}
              count={painted.length}
              target={target}
              categories={categories}
              // Not known -> ask anyway. See `requiresMigrateTo` in lib/settings.ts.
              needsMigrate={(usage[row.id] ?? 1) > 0}
              usageCount={usage[row.id] ?? null}
              candidates={migrateCandidates(painted, row.id)}
              busy={busy}
              onRename={(id, label) => void apply([renameOp(id, label)])}
              onRecategorize={(id, category) => void apply([recategorizeOp(id, category)])}
              onMove={onMove}
              onRemove={(id, migrateTo) => void apply([removeOp(id, migrateTo)])}
            />
          ))}
        </div>
      </DndContext>

      {/*
        Add. The label is OPTIONAL and its placeholder previews what the store will derive
        from the id, so the common case is one field and a button. `after` is the last row,
        so a new entry appears where the user is looking rather than at a position they
        then have to go and find.
      */}
      <form
        className="flex flex-wrap items-end gap-2 border-t pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (idError || newId.trim() === "") return;
          void apply([
            addOp({
              id: newId,
              label: newLabel,
              category: target === "statuses" ? newCategory : undefined,
              after: painted.at(-1)?.id ?? null,
            }),
          ]).then((ok) => {
            if (!ok) return;
            setNewId("");
            setNewLabel("");
          });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`new-${target}-id`} className="text-[11px] text-text-tertiary">
            New {noun} id
          </Label>
          <Input
            id={`new-${target}-id`}
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            placeholder={target === "statuses" ? "awaiting_qa" : "research"}
            disabled={busy}
            className="h-7 w-44 font-mono text-[12px]"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`new-${target}-label`} className="text-[11px] text-text-tertiary">
            Label
          </Label>
          <Input
            id={`new-${target}-label`}
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder={newId.trim() ? titleCaseId(newId.trim()) : "derived from the id"}
            disabled={busy}
            className="h-7 w-44 text-[13px]"
          />
        </div>
        {target === "statuses" && categories ? (
          <div className="space-y-1">
            <Label className="text-[11px] text-text-tertiary">Category</Label>
            <Select value={newCategory} onValueChange={(v) => setNewCategory(v as StatusCategory)} disabled={busy}>
              <SelectTrigger size="sm" aria-label="Category for the new status" className="w-[8.5rem] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || newId.trim() === "" || idError !== null}>
          <Plus className="size-3.5" aria-hidden />
          Add {noun}
        </Button>
        {idError ? (
          <p role="alert" className="basis-full text-[12px] text-[var(--status-task-icon-blocked)]">
            {idError}
          </p>
        ) : null}
      </form>

      {target === "statuses" && requiredCategories ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Behaviour follows the CATEGORY, never the id — a custom status in{" "}
          <code className="font-mono">active</code> is claimable and wears the in-progress
          glyph and colour. Lists group by category first (active, review, gated, blocked,
          ready, unstarted, then done and cancelled) and by the order below within each
          one, so moving a status between groups means changing its category. staple writes
          into {requiredCategories.join(", ")}, so the last status in one of those cannot
          be removed.
        </p>
      ) : null}
    </div>
  );
}
