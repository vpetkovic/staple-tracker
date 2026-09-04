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
 *
 * ── THE KINDS EDITOR ALSO EDITS `kinds.appearance` (R5d, STA-184) ─────────────────────
 *
 * A kind's row carries its glyph, and "Change" opens the `GlyphPicker` under it. That
 * choice is a SECOND draft — the `kinds.appearance` map, a registered setting, posted to
 * `target: "settings"` — held beside the vocabulary ops rather than inside them, because
 * the store lets that map name only CONFIGURED kinds: a glyph for a kind the same draft
 * is adding can only be written after the kinds batch lands. Save therefore posts the
 * ops first and the map second, and a refusal on the second cannot re-post the first.
 *
 * The user sees ONE form all the same: one dirty state (the union), one ActionBar whose
 * summary counts both, one Cancel that drops both, one guard, and one conflict banner
 * for either half moving underneath.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { KindAppearance } from "@/lib/kind-appearance";
import type { Refusal } from "@/lib/refusal";
import { titleCaseId, type SettingOp } from "@/lib/settings";
import type { StatusCategory, VocabularyOp } from "@/lib/types";
import { actionBarState, attributeRefusal, snapshotSignature } from "./form/form-model";
import { GlyphPicker, type SanitizeSvg } from "./glyph-picker/GlyphPicker";
import { GlyphPreview, PREVIEW_SIZES } from "./glyph-picker/GlyphPreview";
import {
  changedGlyphs,
  draftAppearance,
  glyphMapOps,
  isGlyphMapDirty,
  NO_GLYPHS,
  toStoredGlyph,
  withGlyph,
  type GlyphMap,
} from "./glyph-picker/glyph-picker-model";
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

/**
 * The Kinds editor's second half — R5d (STA-184). Absent for Statuses, which have no
 * appearance to configure, so the whole picker is one optional prop and one arm.
 */
export interface GlyphEditing {
  /** The served `kinds.appearance` map. `servedGlyphMap(envelope)` produces it. */
  served: GlyphMap;
  /** Post the map's op to `target: "settings"`. Same `applyTo` as every other write. */
  write: (ops: SettingOp[]) => Promise<Refusal | null>;
  /** `POST /api/glyph/sanitize`, injected so a test needs no fetch. */
  sanitize: SanitizeSvg;
}

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
  /** Kinds only: the glyph half of this editor. Without it no row shows a picker. */
  glyphs?: GlyphEditing;
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
  glyph,
  onRename,
  onRecategorize,
}: {
  row: VocabularyRow;
  target: "statuses" | "kinds";
  categories?: readonly StatusCategory[];
  usageCount: number | null;
  disabled: boolean;
  /** Kinds only (R5d): what this kind wears under the draft, and the control that opens the picker. */
  glyph?: { appearance: KindAppearance; open: boolean; panelId: string; onToggle: () => void };
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

      {/*
        The kind's glyph IS the control that changes it — the thing you want to change is
        the thing you press, and the row already has more chrome than columns. `Change` is
        the accessible name because the picture cannot be one, and `aria-expanded` says
        the panel below this row is what the press opens.
      */}
      {glyph ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-glyph-change={row.id}
          aria-label={`Change glyph for ${row.label}`}
          aria-expanded={glyph.open}
          aria-controls={glyph.panelId}
          disabled={disabled}
          onClick={glyph.onToggle}
          className="shrink-0"
        >
          <GlyphPreview kind={row.id} appearance={glyph.appearance} size={PREVIEW_SIZES.row} />
        </Button>
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
  glyphs,
  onDirtyChange,
}: VocabularyListProps) {
  const served = useMemo(() => emptyDraft(rows, usage), [rows, usage]);
  const draft = useDraft<VocabularyDraft>({
    served,
    signature: snapshotSignature(rows),
    isDirty: isDraftDirty,
    write: (next) => write(next.ops),
  });
  const { value, dirty, status, refusal, conflict } = draft;
  const painted = value.rows;

  // The glyph half (R5d). Always a hook — hooks cannot be conditional — but with no
  // `glyphs` prop it is a draft over an empty map that nothing can ever make dirty.
  const glyphServed = glyphs?.served ?? NO_GLYPHS;
  const glyphWrite = glyphs?.write;
  const glyphDraft = useDraft<GlyphMap>({
    served: glyphServed,
    signature: snapshotSignature([glyphServed]),
    isDirty: (next) => isGlyphMapDirty(next, glyphServed),
    write: async (next) => {
      const ops = glyphMapOps(glyphServed, next, painted.map((row) => row.id));
      // A draft that came back to what the server holds posts nothing: the store refuses
      // an empty batch, and it would be right to.
      return ops.length === 0 || !glyphWrite ? null : glyphWrite(ops);
    },
  });

  const disabled = status === "pending" || glyphDraft.status === "pending";
  const anyDirty = dirty || glyphDraft.dirty;
  const anyConflict = conflict || glyphDraft.conflict;

  // ONE dirty state reaches the shell's guard, because the user made one form's worth of
  // changes. `useDraft`'s own reporting is left unused for exactly that reason.
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const edit = useCallback((op: VocabularyOp) => draft.set(applyDraftOp(draft.value, op)), [draft]);
  const onMove = useCallback((from: number, to: number) => draft.set(moveDraftRow(draft.value, from, to)), [draft]);

  /** Kinds ops first, then the appearance map: the store lets the map name only configured kinds. */
  const saveAll = useCallback(async () => {
    if (dirty && !(await draft.save())) return;
    if (glyphDraft.dirty) await glyphDraft.save();
  }, [dirty, draft, glyphDraft]);

  const cancelAll = useCallback(() => {
    draft.cancel();
    glyphDraft.cancel();
  }, [draft, glyphDraft]);

  const keepAll = useCallback(() => {
    draft.keep();
    glyphDraft.keep();
  }, [draft, glyphDraft]);

  const [picking, setPicking] = useState<string | null>(null);
  const glyphPanelId = (id: string) => `glyph-panel-row-${id}`;

  /**
   * The row the store's refusal is about, or null when it is about the batch. Either
   * half can refuse — a duplicate id, or a glyph the store's own validator rejected —
   * and both sentences are attributed the same way, to the same rows.
   */
  const refused = refusal ?? glyphDraft.refusal;
  const refusedRow = refused ? attributeRefusal(refused.message, draftRefusalTargets(value)) : null;
  const rowErrors: Record<string, string> = refused && refusedRow ? { [refusedRow]: refused.message } : {};
  const sectionError = refused && !refusedRow ? refused.message : null;

  const [confirming, setConfirming] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<StatusCategory>("unstarted");
  const idError = useMemo(
    () => (newId.trim() === "" ? null : validateVocabularyId(newId, painted)),
    [newId, painted],
  );

  const noun = target === "statuses" ? "status" : "kind";
  const changes = value.ops.length + (glyphs ? changedGlyphs(glyphServed, glyphDraft.value) : 0);
  const bar = actionBarState({
    dirty: anyDirty,
    status: status === "idle" ? glyphDraft.status : status,
    blocked: anyConflict,
  });

  return (
    <Section error={sectionError}>
      {anyConflict ? (
        <ConflictBanner what={`${noun} list`} onReload={cancelAll} onKeep={keepAll} />
      ) : null}

      <div className="flex items-center gap-2 px-2 text-[11px] tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
        <span className="w-[1.6rem] shrink-0" />
        {target === "statuses" ? <span className="w-4 shrink-0" /> : null}
        {glyphs ? <span className="w-8 shrink-0">glyph</span> : null}
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
            glyph={
              glyphs
                ? {
                    appearance: draftAppearance(glyphDraft.value, row),
                    open: picking === row.id,
                    panelId: glyphPanelId(row.id),
                    onToggle: () => setPicking((open) => (open === row.id ? null : row.id)),
                  }
                : undefined
            }
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
            {glyphs && picking === row.id ? (
              <div id={glyphPanelId(row.id)} className="pt-2">
                <GlyphPicker
                  kind={row}
                  appearance={draftAppearance(glyphDraft.value, row)}
                  isDefault={glyphDraft.value[row.id] === undefined}
                  disabled={disabled}
                  sanitize={glyphs.sanitize}
                  onChoose={(choice) =>
                    glyphDraft.set(withGlyph(glyphDraft.value, row.id, toStoredGlyph(choice, row.label)))
                  }
                  onReset={() => glyphDraft.set(withGlyph(glyphDraft.value, row.id, null))}
                  onClose={() => setPicking(null)}
                />
              </div>
            ) : null}
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
        onSave={() => void saveAll()}
        onCancel={cancelAll}
        summary={anyDirty ? `${changes} unsaved ${changes === 1 ? "change" : "changes"}` : undefined}
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
