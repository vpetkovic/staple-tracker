/**
 * An idea's plan sections in the Plan tab (design/plan.md, "Plan sections"), read as a document:
 * each section reads as formatted Markdown with an Edit control only where the idea's state
 * offers the edit action, long prose folds behind "Show all", the task breakdown reads as a
 * table whose row opens to its editor, and the sections not written yet wait on one line of
 * "+ Section" chips. Each save writes that one section whole. Also the scaffold preview, which
 * "Where it stands" holds.
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BreakdownRow, IdeaDetailData, PlanSections, ScaffoldPreviewData } from "@/lib/plan-types";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { offers } from "../plain-actions";
import type { PlanWrite } from "../plan-record";
import { estimateHours, foldsLong, planSectionsOf, type PlanSectionEntry, type PlanSectionId } from "./plan-tab-model";

/** The star a section shaping requires carries, read as words by assistive technology. */
export function Star() {
  return (
    <span aria-label="required to shape" title="Required before the idea is shaped" className="text-caption text-flag-todo">
      ★
    </span>
  );
}

/**
 * A section of the document: its heading (13px, sentence case, the star where shaping requires
 * it, a quiet hint), its action on the right, then its content. `data-plan-anchor` is where a
 * section chip scrolls to.
 */
export function Section({ label, star, children, testId, hint, action, className }: { label: string; star?: boolean; children: ReactNode; testId?: string; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section data-plan-section={testId} data-plan-anchor={testId} tabIndex={-1} className={cn("group/section outline-none", className)}>
      <div className="mb-1.5 flex min-h-7 items-center gap-2">
        <h3 className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-body font-semibold text-foreground">
          <span className="inline-flex items-baseline gap-0.5">
            {label}
            {star ? <Star /> : null}
          </span>
          {hint ? <span className="text-label font-normal text-text-tertiary">{hint}</span> : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A section's text, read or written: formatted Markdown by default, a textarea while being
 * edited. The Edit control is there only when the state offers edits; a save on blur writes
 * what changed, and Escape puts the text back.
 */
export function useProse({ value, editable, onSave, startEditing = false }: { value: string; editable: boolean; onSave: (value: string) => void; startEditing?: boolean }) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  return {
    editing: editable && editing,
    draft,
    setDraft,
    start: () => setEditing(true),
    finish: () => {
      setEditing(false);
      if (draft !== value) onSave(draft);
    },
    cancel: () => {
      setDraft(value);
      setEditing(false);
    },
  };
}

/** Edit, shown on hover and focus on a desk, always where the tab is narrow or the pointer coarse. */
export function EditButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="staple-plan-reveal -my-1 h-7 px-2 text-caption text-text-secondary"
      onClick={onClick}
      aria-label={`Edit ${label.toLowerCase()}`}
      data-plan-section-edit={testId}
    >
      <Pencil aria-hidden className="size-3.5" />
      Edit
    </Button>
  );
}

/** "Show all" and "Show less" for a folded part of a section. */
export function FoldButton({ open, onToggle, testId, children }: { open: boolean; onToggle: () => void; testId: string; children?: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="mt-1 -ml-2.5 h-7 px-2.5 text-label text-text-secondary" aria-expanded={open} onClick={onToggle} data-plan-fold={testId}>
      {open ? "Show less" : (children ?? "Show all")}
    </Button>
  );
}

/** Prose as it reads: Markdown at 14/22, at most 68 characters wide; long text folds to about six lines. */
function Prose({ text, fold, testId }: { text: string; fold?: boolean; testId: string }) {
  const [open, setOpen] = useState(false);
  const folds = Boolean(fold) && foldsLong(text);
  return (
    <div data-plan-section-read={testId}>
      <div className={cn(folds && !open && "staple-plan-folded")}>
        <Markdown text={text} className="staple-detail-prose staple-plan-prose" />
      </div>
      {folds ? <FoldButton open={open} onToggle={() => setOpen((value) => !value)} testId={testId} /> : null}
    </div>
  );
}

function SectionInput({ value, onChange, onBlur, onCancel, placeholder, rows, testId }: { value: string; onChange: (value: string) => void; onBlur: () => void; onCancel: () => void; placeholder: string; rows: number; testId: string }) {
  return (
    <Textarea
      autoFocus
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), onCancel())}
      placeholder={placeholder}
      className="staple-plan-prose-input"
      data-plan-section-input={testId}
    />
  );
}

/**
 * A text section: formatted Markdown to read, a textarea to edit where the state offers edits.
 * Drawn by the document only once it has text or was opened from its chip; `onClose` puts an
 * opened section that is still empty back on that line.
 */
export function TextSection({ label, star, value, editable, placeholder, onSave, testId, rows = 4, fold, opened, onClose }: { label: string; star?: boolean; value: string | null; editable: boolean; placeholder: string; onSave: (value: string) => void; testId: string; rows?: number; fold?: boolean; opened?: boolean; onClose?: () => void }) {
  const prose = useProse({ value: value ?? "", editable, onSave, startEditing: opened });
  const finish = () => {
    prose.finish();
    if (!prose.draft.trim()) onClose?.();
  };
  const cancel = () => {
    prose.cancel();
    if (!value?.trim()) onClose?.();
  };
  return (
    <Section label={label} star={star} testId={testId} action={editable && !prose.editing && value ? <EditButton label={label} testId={testId} onClick={prose.start} /> : null}>
      {prose.editing ? (
        <SectionInput value={prose.draft} onChange={prose.setDraft} onBlur={finish} onCancel={cancel} placeholder={placeholder} rows={rows} testId={testId} />
      ) : value?.trim() ? (
        <Prose text={value} fold={fold} testId={testId} />
      ) : editable ? (
        <WriteBox onClick={prose.start} testId={testId}>
          {placeholder}
        </WriteBox>
      ) : null}
    </Section>
  );
}

/** The dashed box that says what to write, where a section is empty and edits are offered. */
function WriteBox({ onClick, testId, children }: { onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button type="button" className="focus-ring w-full rounded-lg border border-dashed border-border-strong px-3 py-2 text-left text-body text-text-tertiary hover:bg-surface-hover" onClick={onClick} data-plan-section-empty={testId}>
      {children}
    </button>
  );
}

/** A list section, one item per line while editing; `foldAfter` shows three and "Show all n" past that many. */
export function ListSection({ label, star, items, editable, placeholder, onSave, testId, foldAfter, opened, onClose }: { label: string; star?: boolean; items: string[]; editable: boolean; placeholder: string; onSave: (items: string[]) => void; testId: string; foldAfter?: number; opened?: boolean; onClose?: () => void }) {
  const joined = items.join("\n");
  const toItems = (draft: string) => draft.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
  const prose = useProse({ value: joined, editable, onSave: (draft) => onSave(toItems(draft)), startEditing: opened });
  const [all, setAll] = useState(false);
  const folds = foldAfter !== undefined && items.length > foldAfter;
  const shown = folds && !all ? items.slice(0, 3) : items;
  const finish = () => {
    prose.finish();
    if (toItems(prose.draft).length === 0) onClose?.();
  };
  const cancel = () => {
    prose.cancel();
    if (items.length === 0) onClose?.();
  };
  return (
    <Section
      label={label}
      star={star}
      testId={testId}
      hint={prose.editing ? "one per line" : items.length > 0 ? String(items.length) : undefined}
      action={editable && !prose.editing && items.length > 0 ? <EditButton label={label} testId={testId} onClick={prose.start} /> : null}
    >
      {prose.editing ? (
        <SectionInput value={prose.draft} onChange={prose.setDraft} onBlur={finish} onCancel={cancel} placeholder={placeholder} rows={Math.min(8, Math.max(3, items.length + 1))} testId={testId} />
      ) : items.length === 0 ? (
        editable ? (
          <WriteBox onClick={prose.start} testId={testId}>
            {placeholder}
          </WriteBox>
        ) : null
      ) : (
        <div data-plan-section-read={testId}>
          <Markdown text={shown.map((item) => `- ${item}`).join("\n")} className="staple-detail-prose staple-plan-prose" />
          {folds ? (
            <FoldButton open={all} onToggle={() => setAll((value) => !value)} testId={testId}>
              Show all {items.length}
            </FoldButton>
          ) : null}
        </div>
      )}
    </Section>
  );
}

/** The fields a breakdown row has, in the order its editor lists them. */
const FIELDS: Array<{ field: keyof BreakdownRow; label: string; placeholder: string }> = [
  { field: "key", label: "#", placeholder: "1.1" },
  { field: "title", label: "Task", placeholder: "What to build" },
  { field: "estimate", label: "Est.", placeholder: "2h" },
  { field: "dependsOn", label: "After", placeholder: "1.1, 1.2" },
  { field: "acceptance", label: "Done when", placeholder: "How we know it is done" },
  { field: "owner", label: "Owner", placeholder: "who" },
  { field: "notes", label: "Notes", placeholder: "" },
];

/** The "done when" field of a row that inherits says so, so an empty field never reads as missing. */
const placeholderFor = (column: (typeof FIELDS)[number], inherits: boolean): string => (column.field === "acceptance" && inherits ? "Inherits the plan's acceptance" : column.placeholder);

/** A row without its own "done when": its task takes the plan's acceptance criteria, flagged to be sharpened. */
export function InheritedBadge() {
  return (
    <span className="rounded border border-dashed px-1.5 py-0.5 text-caption text-text-secondary" title="This row has no done-when of its own. Its task takes the plan's acceptance criteria and is labelled acceptance-inherited until someone sharpens it." data-plan-inherited>
      inherits the plan's acceptance
    </span>
  );
}

const cellValue = (row: BreakdownRow, field: keyof BreakdownRow): string => (field === "dependsOn" ? row.dependsOn.join(", ") : ((row[field] as string | null) ?? ""));

function withCell(row: BreakdownRow, field: keyof BreakdownRow, value: string): BreakdownRow {
  if (field === "dependsOn") return { ...row, dependsOn: value.split(/\s*[,;]\s*/).map((item) => item.trim()).filter(Boolean) };
  return { ...row, [field]: field === "key" || field === "title" ? value : value.trim() ? value : null };
}

function nextKey(rows: readonly BreakdownRow[]): string {
  const numbers = rows.map((row) => /^(\d+)\.(\d+)$/.exec(row.key)).filter((match): match is RegExpExecArray => match !== null);
  if (numbers.length === 0) return String(rows.length + 1);
  const last = numbers.at(-1)!;
  return `${last[1]}.${Number(last[2]) + 1}`;
}

const EMPTY_ROW = (rows: readonly BreakdownRow[]): BreakdownRow => ({ key: nextKey(rows), title: "", estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null });

/**
 * The task breakdown: a read table (#, Task, Est., After) whose row opens in place to its notes,
 * done-when and owner, and, where edits are offered, to the row's editor. Every change that
 * leaves a field saves the breakdown whole, against the revision this editor read.
 */
export function BreakdownSection({ rows, editable, onSave, inherits, warnings, opened, onClose }: { rows: BreakdownRow[]; editable: boolean; onSave: (rows: BreakdownRow[]) => void; inherits: boolean; warnings: string[]; opened?: boolean; onClose?: () => void }) {
  const [draft, setDraft] = useState(() => (opened && rows.length === 0 && editable ? [EMPTY_ROW(rows)] : rows));
  /** The row open in place; one at a time. */
  const [open, setOpen] = useState<number | null>(opened && rows.length === 0 && editable ? 0 : null);
  // A new payload replaces the draft; the first render keeps the row a chip opened.
  const seen = useRef(rows);
  useEffect(() => {
    if (seen.current === rows) return;
    seen.current = rows;
    setDraft(rows);
  }, [rows]);
  const commit = (next: BreakdownRow[]) => {
    setDraft(next);
    if (JSON.stringify(next) !== JSON.stringify(rows)) onSave(next);
  };
  const edit = (index: number, field: keyof BreakdownRow, value: string) => setDraft((current) => current.map((row, at) => (at === index ? withCell(row, field, value) : row)));
  const save = () => commit(draft.filter((row) => row.key.trim() || row.title.trim()));
  const close = () => {
    setOpen(null);
    if (rows.length === 0 && draft.every((row) => !row.key.trim() && !row.title.trim())) onClose?.();
  };
  const remove = (index: number) => {
    commit(draft.filter((_, at) => at !== index));
    setOpen(null);
  };
  const total = estimateHours(rows);
  const missingAcceptance = draft.filter((row) => !row.acceptance).length;
  const gap = missingAcceptance === 0 || inherits ? "" : ` · ${missingAcceptance} without "done when"`;
  return (
    <Section
      label="Task breakdown"
      star
      testId="breakdown"
      hint={`${draft.length} task${draft.length === 1 ? "" : "s"}${total ? ` · ${total}` : ""}${gap}`}
      action={
        editable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-my-1 h-7 px-2 text-caption text-text-secondary"
            onClick={() => {
              setDraft((current) => [...current, EMPTY_ROW(current)]);
              setOpen(draft.length);
            }}
            data-plan-add-row
          >
            <Plus aria-hidden className="size-3.5" />
            Task
          </Button>
        ) : null
      }
    >
      {draft.length > 0 ? (
        <div className="overflow-hidden rounded-lg border" data-plan-breakdown="read">
          <table className="w-full table-fixed border-collapse text-body">
            <thead>
              <tr className="bg-surface-sunken text-left text-caption text-text-tertiary">
                <th className="w-14 px-3 py-1.5 font-normal">#</th>
                <th className="px-1.5 py-1.5 font-normal">Task</th>
                <th className="w-14 px-1.5 py-1.5 font-normal">Est.</th>
                <th className="staple-plan-wide w-24 px-3 py-1.5 font-normal">After</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((row, index) => (
                <Fragment key={row.id ?? `new-${index}`}>
                  <tr
                    className={cn("cursor-pointer border-t align-top hover:bg-surface-hover", open === index && "bg-surface-selected hover:bg-surface-selected")}
                    onClick={() => setOpen(open === index ? null : index)}
                    data-plan-row={row.key}
                    data-plan-row-inherits={!row.acceptance && inherits ? "" : undefined}
                  >
                    <td className="px-3 py-2 font-mono text-label text-text-secondary">{row.key}</td>
                    <td className="min-w-0 px-1.5 py-2">
                      <button
                        type="button"
                        className="focus-ring block min-h-0 w-full rounded-sm text-left"
                        aria-expanded={open === index}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpen(open === index ? null : index);
                        }}
                        data-plan-row-open={row.key}
                      >
                        <span className={cn("block", !row.title && "text-text-tertiary")}>{row.title || "Untitled task"}</span>
                        {row.acceptance ? null : inherits ? (
                          <span className="block text-caption text-text-tertiary">done when: inherits the plan's acceptance</span>
                        ) : (
                          <span className="block text-caption text-flag-todo">No "done when" yet</span>
                        )}
                      </button>
                    </td>
                    <td className="px-1.5 py-2 tabular-nums">{row.estimate ?? <span className="text-text-tertiary">–</span>}</td>
                    <td className="staple-plan-wide px-3 py-2 text-label text-text-tertiary">{row.dependsOn.join(", ") || "–"}</td>
                  </tr>
                  {open === index ? (
                    <tr className="bg-surface-selected" data-plan-row-detail={row.key}>
                      <td colSpan={4} className="px-3 pt-0.5 pb-3">
                        {editable ? <RowEditor row={row} inherits={inherits} onEdit={(field, value) => edit(index, field, value)} onSave={save} onDone={close} onRemove={() => remove(index)} /> : <RowRead row={row} inherits={inherits} />}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 text-body text-text-secondary">No tasks yet.</p>
      )}
      {warnings.length > 0 ? (
        <ul className="m-0 mt-2 list-none space-y-0.5 p-0 text-caption text-flag-todo" data-plan-warnings>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

/** An open row where edits are not offered: what the table leaves out. */
function RowRead({ row, inherits }: { row: BreakdownRow; inherits: boolean }) {
  return (
    <dl className="m-0 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
      <dt className="text-text-tertiary">Done when</dt>
      <dd className="m-0">{row.acceptance ?? (inherits ? <InheritedBadge /> : <span className="text-text-tertiary">Not written</span>)}</dd>
      <dt className="text-text-tertiary">Owner</dt>
      <dd className="m-0">{row.owner ?? <span className="text-text-tertiary">Nobody named</span>}</dd>
      <dt className="text-text-tertiary">Notes</dt>
      <dd className="m-0 whitespace-pre-wrap">{row.notes ?? <span className="text-text-tertiary">No notes.</span>}</dd>
    </dl>
  );
}

/** The row's editor: every field, saved when a field is left. */
function RowEditor({ row, inherits, onEdit, onSave, onDone, onRemove }: { row: BreakdownRow; inherits: boolean; onEdit: (field: keyof BreakdownRow, value: string) => void; onSave: () => void; onDone: () => void; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-label" data-plan-row-editor={row.key}>
      {FIELDS.map((column) => (
        <label key={column.field} className="contents">
          <span className="text-caption text-text-tertiary">{column.label === "Est." ? "Estimate" : column.label}</span>
          <Input
            autoFocus={column.field === "title"}
            value={cellValue(row, column.field)}
            placeholder={placeholderFor(column, inherits)}
            onChange={(event) => onEdit(column.field, event.target.value)}
            onBlur={onSave}
            aria-label={`${column.label} for ${row.key || "new task"}`}
            className="h-8 bg-card px-2 pointer-coarse:h-10"
          />
        </label>
      ))}
      <span />
      <div className="mt-1 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="bg-card pointer-coarse:h-10" onClick={onDone}>
          Done
        </Button>
        <Button variant="ghost" size="sm" className="pointer-coarse:h-10" onClick={onRemove} aria-label={`Remove task ${row.key}`}>
          <Trash2 aria-hidden />
          Remove
        </Button>
      </div>
    </div>
  );
}

/** "Not written yet": one chip per empty section, each opening that section's editor in place. */
function Unwritten({ entries, onOpen }: { entries: PlanSectionEntry[]; onOpen: (id: PlanSectionId) => void }) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-plan-unwritten>
      <span className="mr-1 text-label text-text-tertiary">Not written yet</span>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="focus-ring inline-flex h-7 min-h-0 items-center gap-0.5 rounded-full border border-dashed border-border-strong px-2.5 text-label text-text-secondary hover:bg-surface-hover pointer-coarse:h-9"
          onClick={() => onOpen(entry.id)}
          data-plan-section-empty={entry.id}
          data-plan-anchor={entry.id}
        >
          + {entry.label}
          {entry.star ? <Star /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Every plan section of the record, in the order an agent reads them. A section with nothing in
 * it is drawn only once opened from its chip on the "Not written yet" line, where edits are
 * offered; where they are not, it is not drawn at all.
 */
export function PlanSectionsView({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const editable = offers(record.idea, "edit");
  const [opened, setOpened] = useState<ReadonlySet<PlanSectionId>>(() => new Set());
  const open = (id: PlanSectionId) => setOpened((current) => new Set(current).add(id));
  const close = (id: PlanSectionId) => () =>
    setOpened((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const save = (patch: Partial<PlanSections>) => void write("update", { ref: record.idea.id, plan: patch });
  const { plan } = record;
  const entries = planSectionsOf(record);
  const shown = (id: PlanSectionId) => entries.find((entry) => entry.id === id)!.filled || (editable && opened.has(id));
  const unwritten = editable ? entries.filter((entry) => entry.id !== "brief" && entry.id !== "decisions" && !entry.filled && !opened.has(entry.id)) : [];
  const text = (id: PlanSectionId, label: string, value: string | null, placeholder: string, onSave: (value: string) => void, extra: { star?: boolean; rows?: number; fold?: boolean } = {}) =>
    shown(id) ? <TextSection key={id} label={label} value={value} editable={editable} placeholder={placeholder} onSave={onSave} testId={id} opened={opened.has(id)} onClose={close(id)} {...extra} /> : null;
  const list = (id: PlanSectionId, label: string, items: string[], placeholder: string, onSave: (items: string[]) => void, extra: { star?: boolean; foldAfter?: number } = {}) =>
    shown(id) ? <ListSection key={id} label={label} items={items} editable={editable} placeholder={placeholder} onSave={onSave} testId={id} opened={opened.has(id)} onClose={close(id)} {...extra} /> : null;
  return (
    <>
      {record.brief?.trim() || editable ? (
        <TextSection label="Brief" value={record.brief} editable={editable} placeholder="What is it, who is it for, what does done look like?" onSave={(brief) => void write("update", { ref: record.idea.id, brief })} testId="brief" fold />
      ) : null}
      {text("goal", "Goal", plan.goal, "What done means, in one paragraph.", (goal) => save({ goal }), { star: true, rows: 3 })}
      {text("context", "Context and constraints", plan.context, "Layering, contracts, the ground rules that bind it.", (context) => save({ context }), { rows: 5, fold: true })}
      {shown("breakdown") ? (
        <BreakdownSection
          rows={plan.breakdown}
          editable={editable}
          inherits={plan.acceptance.length > 0}
          warnings={record.planWarnings}
          opened={opened.has("breakdown")}
          onClose={close("breakdown")}
          // Saved against the breakdown this editor read: a newer edit made meanwhile refuses the save instead of being lost.
          onSave={(breakdown) => void write("update", { ref: record.idea.id, plan: { breakdown }, breakdownBase: record.breakdownRevision })}
        />
      ) : null}
      {list("acceptance", "Acceptance criteria", plan.acceptance, "How the whole is proven done.", (acceptance) => save({ acceptance }), { star: true })}
      {list("dependencies", "Dependencies", plan.dependencies, "Other ideas or epics this waits on.", (dependencies) => save({ dependencies }))}
      {text("out-of-scope", "Out of scope", plan.outOfScope, "What this deliberately does not do.", (outOfScope) => save({ outOfScope }), { rows: 3 })}
      {text("risks", "Risks", plan.risks, "What could make it slip, and the early signal.", (risks) => save({ risks }), { rows: 3 })}
      {list("sources", "Sources and files", plan.sources, "Source plans, ADRs, mockups (files live under Files).", (sources) => save({ sources }), { foldAfter: 4 })}
      <Unwritten entries={unwritten} onOpen={open} />
    </>
  );
}

/**
 * Scaffold's preview, then its confirm: the epic this idea becomes and every task it would create,
 * with estimate, blockers and acceptance. What is shown is what the store makes; a row created
 * by an earlier scaffold shows its number and is not made again.
 */
export function ScaffoldSection({ preview, open, onToggle, onConfirm, busy }: { preview: ScaffoldPreviewData; open: boolean; onToggle: () => void; onConfirm: (fingerprint: string) => void; busy: boolean }) {
  const count = countTasks(preview);
  const fresh = countTasks(preview, true);
  const held = preview.problems.length > 0;
  return (
    <div className="mt-3" data-plan-scaffold data-plan-scaffold-held={held ? "" : undefined}>
      <p className="m-0 text-label text-text-secondary">
        {preview.epic.promoted ? `Already ${preview.epic.identifier}; scaffolding again adds only the tasks written since.` : "Promotes this idea into the epic and turns its task breakdown into the epic's tasks."}{" "}
        {fresh} new task{fresh === 1 ? "" : "s"} of {count}.
      </p>
      {held ? (
        <p className="m-0 mt-1.5 text-label text-flag-todo" data-plan-scaffold-problems>
          Held back, the plan is incomplete: {preview.problems.join("; ")}.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="bg-card" onClick={onToggle} data-plan-scaffold-preview aria-expanded={open}>
          {open ? "Hide the preview" : "Preview what it creates"}
        </Button>
        {open ? (
          // The confirm names this preview's fingerprint: the store refuses it if the plan changed since.
          <Button size="sm" onClick={() => onConfirm(preview.fingerprint)} disabled={busy || held || fresh === 0} data-plan-scaffold-confirm>
            {preview.epic.promoted ? `Create ${fresh} new task${fresh === 1 ? "" : "s"}` : `Create the epic and ${fresh} task${fresh === 1 ? "" : "s"}`}
          </Button>
        ) : null}
      </div>
      {open && preview.warnings.length > 0 ? (
        <ul className="m-0 mt-2 list-none space-y-0.5 p-0 text-caption text-flag-todo" data-plan-scaffold-warnings>
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {open ? <PreviewTree preview={preview} /> : null}
    </div>
  );
}

export function countTasks(preview: ScaffoldPreviewData, freshOnly = false): number {
  return preview.tasks.filter((task) => !freshOnly || !task.existing).length + preview.children.reduce((sum, child) => sum + countTasks(child, freshOnly), 0);
}

function PreviewTree({ preview, depth = 0 }: { preview: ScaffoldPreviewData; depth?: number }) {
  return (
    <div className={cn("mt-3 space-y-1.5", depth > 0 && "border-l pl-3")} data-plan-scaffold-tree={preview.idea.id}>
      <div className="text-label font-medium">
        {preview.epic.identifier ?? `New ${preview.epic.kind}`}: {preview.idea.title}
        <span className="ml-1.5 text-caption font-normal text-text-tertiary">{preview.epic.acceptance.length} acceptance criteria</span>
      </div>
      <ul className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
        {preview.tasks.map((task) => (
          <li key={task.key} className="border-t px-3 py-1.5 text-label first:border-t-0" data-plan-scaffold-task={task.key}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-caption text-text-tertiary">{task.existing ?? "new"}</span>
              <span className="min-w-0 flex-1">{task.title}</span>
              {task.estimateWarning ? (
                <span className="text-caption text-flag-todo" data-plan-scaffold-estimate-warning>
                  {task.estimateWarning}
                </span>
              ) : task.estimate ? (
                <span className="text-caption text-text-secondary tabular-nums">{task.estimate}</span>
              ) : null}
            </div>
            <div className="text-caption text-text-secondary">
              {task.blockedBy.length > 0 ? `after ${task.blockedBy.join(", ")}` : "no blockers"}
              {task.waitsOutside.length > 0 ? ` · waits on ${task.waitsOutside.join(", ")}` : ""}
              {task.acceptanceInherited ? " · " : task.acceptance[0] ? ` · done when ${task.acceptance[0]}` : " · no done-when"}
              {task.acceptanceInherited ? <InheritedBadge /> : null}
            </div>
          </li>
        ))}
      </ul>
      {preview.children.map((child) => (
        <PreviewTree key={child.idea.id} preview={child} depth={depth + 1} />
      ))}
    </div>
  );
}

/**
 * A one-line field that adds to a list (a question, a decision, adopted work): Enter adds and
 * clears it. A dashed box with a plus until focused.
 */
export function AddLine({ placeholder, onAdd, testId, icon, button, className }: { placeholder: string; onAdd: (text: string) => Promise<boolean>; testId: string; icon?: ReactNode; button?: string; className?: string }) {
  const [text, setText] = useState("");
  return (
    <form
      className={cn("flex items-center gap-2", className)}
      data-plan-add={testId}
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim() && (await onAdd(text.trim()))) setText("");
      }}
    >
      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed border-border-strong bg-card px-2.5 text-text-tertiary focus-within:border-solid focus-within:border-ring pointer-coarse:h-10">
        {icon ?? <Plus aria-hidden className="size-3.5 shrink-0" />}
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-full min-h-0 min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-text-tertiary pointer-coarse:text-[16px]"
        />
      </label>
      {button ? (
        <Button type="submit" size="sm" variant="outline">
          {button}
        </Button>
      ) : null}
    </form>
  );
}
