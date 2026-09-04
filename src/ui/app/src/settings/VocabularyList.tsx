/**
 * ONE editable, reorderable list — used for Statuses and for Kinds. O7b (STA-141)
 * built it; R6c (STA-178) moved it onto the shared form primitives and a draft.
 *
 * ── WHY ONE COMPONENT AND NOT TWO ─────────────────────────────────────────────────────
 *
 * Statuses and kinds differ in exactly one column (the category select) and in nothing
 * else: same rename, same drag, same keyboard move, same remove-with-migrate-to, same
 * refusal surface. Two components that are ninety per cent identical drift, and they
 * drift in the half nobody opened recently. The category column is a prop.
 *
 * ── A DRAFT, SAVED AS ONE BATCH ───────────────────────────────────────────────────────
 *
 * Every operation this list ever had is still here — add, rename, recategorize,
 * reorder (drag, buttons, alt+arrow), remove with a migrate-to target — and each one is
 * still the op settings-ops.ts builds for it. What changed is WHEN it is posted: ops now
 * accumulate in a `VocabularyDraft` (form/vocabulary-draft.ts), the list paints the
 * draft, and Save posts the ordered batch through the dialog's `applyTo` — the same
 * all-or-nothing store call the MCP tools make. The response is the whole envelope, so
 * a successful save snaps the list to exactly what the store holds; nothing merges.
 *
 * Cancel drops the draft. A refusal keeps it, and the store's sentence lands
 * on the row it names (`attributeRefusal`) or on the section when it names none.
 * While a draft is dirty, the served vocabulary moving underneath — another tab, an
 * agent through MCP, the CLI — is a conflict banner, never a silent overwrite.
 */
import { useCallback, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Refusal } from "@/lib/refusal";
import { titleCaseId } from "@/lib/settings";
import type { StatusCategory, VocabularyOp } from "@/lib/types";
import { actionBarState, attributeRefusal, snapshotSignature } from "./form/form-model";
import {
  ActionBar,
  ConflictBanner,
  DestructiveConfirm,
  Field,
  InlineError,
  Section,
} from "./form/primitives";
import { ReorderList } from "./form/ReorderList";
import { useDraft } from "./form/useDraft";
import {
  applyDraftOp,
  draftRefusalTargets,
  emptyDraft,
  isDraftDirty,
  moveDraftRow,
  type VocabularyDraft,
} from "./form/vocabulary-draft";
import {
  addOp,
  labelChanged,
  migrateCandidates,
  recategorizeOp,
  removeOp,
  renameOp,
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
  /** Post the ordered batch. Resolves null when the store accepted it, else its refusal. */
  write: (ops: VocabularyOp[]) => Promise<Refusal | null>;
  /** The shell's unsaved-changes guard listens here. */
  onDirtyChange?: (dirty: boolean) => void;
}

const NO_MIGRATE = "__none__";

/** The editable middle of a row: glyph, id, label field, category select, usage count. */
function RowFields({
  row,
  target,
  categories,
  usageCount,
  disabled,
  onRename,
  onRecategorize,
}: {
  row: VocabularyRow;
  target: "statuses" | "kinds";
  categories?: readonly StatusCategory[];
  usageCount: number | null;
  disabled: boolean;
  onRename: (id: string, label: string) => void;
  onRecategorize: (id: string, category: StatusCategory) => void;
}) {
  // Holds what the user is typing; the row is re-keyed on its label (see the list), so a
  // committed rename, a Cancel or a Reload re-seeds it without fighting the caret.
  const [label, setLabel] = useState(row.label);
  const commit = useCallback(() => {
    if (labelChanged(row, label)) onRename(row.id, label);
    else setLabel(row.label);
  }, [label, onRename, row]);

  return (
    <>
      {target === "statuses" && row.category ? (
        <StatusIcon status={row.id} category={row.category} className="shrink-0" />
      ) : null}

      <span className="w-36 shrink-0 truncate font-mono text-[11px] text-text-tertiary" title={row.id}>
        {row.id}
      </span>

      <Input
        value={label}
        aria-label={`Label for ${row.id}`}
        disabled={disabled}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
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
          disabled={disabled}
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
    </>
  );
}

/**
 * The migrate-to picker. REQUIRED when anything still carries this row; absent entirely
 * when nothing does — "move 0 rows onto something" is not a decision worth offering.
 */
function RemoveConfirm({
  row,
  needsMigrate,
  usageCount,
  candidates,
  disabled,
  onRemove,
  onCancel,
}: {
  row: VocabularyRow;
  needsMigrate: boolean;
  usageCount: number | null;
  candidates: VocabularyRow[];
  disabled: boolean;
  onRemove: (id: string, migrateTo: string | null) => void;
  onCancel: () => void;
}) {
  const [migrateTo, setMigrateTo] = useState<string>(NO_MIGRATE);
  return (
    <DestructiveConfirm
      message={
        needsMigrate
          ? `${usageCount === null ? "Some" : usageCount} ${usageCount === 1 ? "issue" : "issues"} still carry "${row.label}". Move them to:`
          : `Remove "${row.label}"?`
      }
      confirmLabel="Remove"
      confirmDisabled={needsMigrate && migrateTo === NO_MIGRATE}
      disabled={disabled}
      onConfirm={() => onRemove(row.id, migrateTo === NO_MIGRATE ? null : migrateTo)}
      onCancel={onCancel}
    >
      {needsMigrate ? (
        <Select value={migrateTo} onValueChange={setMigrateTo} disabled={disabled}>
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
    </DestructiveConfirm>
  );
}

export function VocabularyList({
  target,
  rows,
  usage,
  categories,
  requiredCategories,
  write,
  onDirtyChange,
}: VocabularyListProps) {
  const served = useMemo(() => emptyDraft(rows, usage), [rows, usage]);
  const draft = useDraft<VocabularyDraft>({
    served,
    signature: snapshotSignature(rows),
    isDirty: isDraftDirty,
    write: (next) => write(next.ops),
    onDirtyChange,
  });
  const { value, dirty, status, refusal, conflict } = draft;
  const disabled = status === "pending";
  const painted = value.rows;

  const edit = useCallback((op: VocabularyOp) => draft.set(applyDraftOp(draft.value, op)), [draft]);
  const onMove = useCallback((from: number, to: number) => draft.set(moveDraftRow(draft.value, from, to)), [draft]);

  /** The row the store's refusal is about, or null when it is about the batch. */
  const refusedRow = refusal ? attributeRefusal(refusal.message, draftRefusalTargets(value)) : null;
  const rowErrors: Record<string, string> = refusal && refusedRow ? { [refusedRow]: refusal.message } : {};
  const sectionError = refusal && !refusedRow ? refusal.message : null;

  const [confirming, setConfirming] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<StatusCategory>("unstarted");
  const idError = useMemo(
    () => (newId.trim() === "" ? null : validateVocabularyId(newId, painted)),
    [newId, painted],
  );

  const noun = target === "statuses" ? "status" : "kind";
  const bar = actionBarState({ dirty, status, blocked: conflict });

  return (
    <Section error={sectionError}>
      {conflict ? (
        <ConflictBanner what={`${noun} list`} onReload={draft.cancel} onKeep={draft.keep} />
      ) : null}

      <div className="flex items-center gap-2 px-2 text-[11px] tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
        <span className="w-[1.6rem] shrink-0" />
        {target === "statuses" ? <span className="w-4 shrink-0" /> : null}
        <span className="w-36 shrink-0">id</span>
        <span className="flex-1">label</span>
        {target === "statuses" ? <span className="w-[8.5rem] shrink-0">category</span> : null}
        <span className="w-16 shrink-0 text-right">in use</span>
        <span className="w-[6.5rem] shrink-0" />
      </div>

      <ReorderList
        items={painted}
        getId={(row) => row.id}
        getLabel={(row) => row.label}
        disabled={disabled}
        onMove={onMove}
        rowState={(row) => ({ invalid: row.id in rowErrors })}
        renderItem={(row) => (
          <RowFields
            // The label, not just the id: a committed rename, Cancel and Reload each
            // re-seed the field without a controlled input fighting the caret.
            key={`${row.id}:${row.label}`}
            row={row}
            target={target}
            categories={categories}
            usageCount={value.usage[row.id] ?? null}
            disabled={disabled}
            onRename={(id, label) => edit(renameOp(id, label))}
            onRecategorize={(id, category) => edit(recategorizeOp(id, category))}
          />
        )}
        renderActions={(row) => (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${row.label}`}
            disabled={disabled}
            onClick={() => setConfirming((open) => (open === row.id ? null : row.id))}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        )}
        renderBelow={(row) => (
          <>
            {rowErrors[row.id] ? <InlineError>{rowErrors[row.id]}</InlineError> : null}
            {confirming === row.id ? (
              <RemoveConfirm
                row={row}
                // Not known -> ask anyway. See `requiresMigrateTo` in lib/settings.ts.
                needsMigrate={(value.usage[row.id] ?? 1) > 0}
                usageCount={value.usage[row.id] ?? null}
                candidates={migrateCandidates(painted, row.id)}
                disabled={disabled}
                onRemove={(id, migrateTo) => {
                  edit(removeOp(id, migrateTo));
                  setConfirming(null);
                }}
                onCancel={() => setConfirming(null)}
              />
            ) : null}
          </>
        )}
      />

      {/*
        Add. The label is OPTIONAL and its placeholder previews what the store will derive
        from the id. `after` is the last row, so a new entry appears where the user is
        looking rather than at a position they then have to go and find.
      */}
      <form
        className="flex flex-wrap items-end gap-2 border-t pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (idError || newId.trim() === "") return;
          edit(
            addOp({
              id: newId,
              label: newLabel,
              category: target === "statuses" ? newCategory : undefined,
              after: painted.at(-1)?.id ?? null,
            }),
          );
          setNewId("");
          setNewLabel("");
        }}
      >
        <Field id={`new-${target}-id`} label={`New ${noun} id`} error={idError} className="md:grid-cols-1 md:gap-x-0">
          {(aria) => (
            <Input
              {...aria}
              value={newId}
              onChange={(event) => setNewId(event.target.value)}
              placeholder={target === "statuses" ? "awaiting_qa" : "research"}
              disabled={disabled}
              className="h-7 w-44 font-mono text-[12px]"
            />
          )}
        </Field>
        <Field id={`new-${target}-label`} label="Label" className="md:grid-cols-1 md:gap-x-0">
          {(aria) => (
            <Input
              {...aria}
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder={newId.trim() ? titleCaseId(newId.trim()) : "derived from the id"}
              disabled={disabled}
              className="h-7 w-44 text-[13px]"
            />
          )}
        </Field>
        {target === "statuses" && categories ? (
          <Field id={`new-${target}-category`} label="Category" className="md:grid-cols-1 md:gap-x-0">
            <Select value={newCategory} onValueChange={(v) => setNewCategory(v as StatusCategory)} disabled={disabled}>
              <SelectTrigger
                id={`new-${target}-category`}
                size="sm"
                aria-label="Category for the new status"
                className="w-[8.5rem] text-[12px]"
              >
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
          </Field>
        ) : null}
        <Button type="submit" size="sm" variant="outline" disabled={disabled || newId.trim() === "" || idError !== null}>
          <Plus className="size-3.5" aria-hidden />
          Add {noun}
        </Button>
      </form>

      <ActionBar
        state={bar}
        onSave={() => void draft.save()}
        onCancel={draft.cancel}
        summary={dirty ? `${value.ops.length} unsaved ${value.ops.length === 1 ? "change" : "changes"}` : undefined}
      />

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
    </Section>
  );
}
