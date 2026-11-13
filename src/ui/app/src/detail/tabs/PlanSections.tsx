/**
 * An idea's plan sections in the Plan tab (design/plan.md, "Plan sections"): the completeness
 * meter, each text and list section, the task breakdown as an editable table (stacked cards below
 * 768px), and the scaffold preview. A text section reads as formatted Markdown, with an Edit
 * control only where the idea's state offers the edit action; each save writes that one section
 * whole.
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BreakdownRow, IdeaDetailData, PlanSections, ScaffoldPreviewData } from "@/lib/plan-types";
import { Markdown } from "@/lib/markdown";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { offers } from "../plain-actions";
import type { PlanWrite } from "../plan-record";

export function Section({ label, star, children, testId, hint, action }: { label: string; star?: boolean; children: ReactNode; testId?: string; hint?: string; action?: ReactNode }) {
  return (
    <section data-plan-section={testId}>
      <div className="mb-2 flex min-h-6 items-center gap-2">
        <h3 className="m-0 flex min-w-0 flex-1 items-baseline gap-1.5 text-caption font-semibold tracking-wide text-text-tertiary uppercase">
          {label}
          {star ? (
            <span aria-label="required to shape" title="Required before the idea is shaped" className="text-[color:var(--status-task-todo)]">
              ★
            </span>
          ) : null}
          {hint ? <span className="font-normal tracking-normal normal-case">{hint}</span> : null}
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
export function useProse({ value, editable, onSave }: { value: string; editable: boolean; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
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

export function EditButton({ label, testId, onClick }: { label: string; testId: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-my-1 h-7 px-2 text-caption text-text-secondary" onClick={onClick} aria-label={`Edit ${label.toLowerCase()}`} data-plan-section-edit={testId}>
      <Pencil aria-hidden className="size-3.5" />
      Edit
    </Button>
  );
}

/** The text as it reads: Markdown, or what is missing, with a way to write it where edits are offered. */
function Reading({ text, empty, editable, onStart, testId }: { text: string; empty: string; editable: boolean; onStart: () => void; testId: string }) {
  if (!text.trim()) {
    return editable ? (
      <button type="button" className="w-full rounded-md border border-dashed px-3 py-2 text-left text-body text-text-tertiary hover:bg-surface-hover" onClick={onStart} data-plan-section-empty={testId}>
        {empty}
      </button>
    ) : (
      <p className="m-0 text-body text-text-secondary">Not written.</p>
    );
  }
  return (
    <div data-plan-section-read={testId}>
      <Markdown text={text} className="staple-detail-prose text-body" />
    </div>
  );
}

/** How much of the plan is written, and what shaping still needs. */
export function Completeness({ record }: { record: IdeaDetailData }) {
  const { completeness: c, missingForShaped, idea } = record;
  const thinking = idea.state === "raw" || idea.state === "exploring";
  return (
    <div className="rounded-lg border bg-surface-raised px-3 py-2.5 text-label" data-plan-completeness={`${c.starred}/${c.starredTotal}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          ★ {c.starred}/{c.starredTotal} required
        </span>
        <span className="text-text-secondary">
          {c.filled}/{c.total} sections written
        </span>
        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((c.filled / c.total) * 100)}%` }} />
        </div>
      </div>
      {idea.planIncomplete.length > 0 ? (
        <p className="m-0 mt-1.5 text-caption text-[color:var(--status-task-todo)]" data-plan-incomplete>
          Shaped · plan incomplete: {idea.planIncomplete.slice(0, 5).join("; ")}
          {idea.planIncomplete.length > 5 ? `; and ${idea.planIncomplete.length - 5} more` : ""}. Scaffold and Promote wait until it passes again.
        </p>
      ) : null}
      {thinking && missingForShaped.length > 0 ? (
        <p className="m-0 mt-1.5 text-caption text-text-secondary" data-plan-missing>
          To shape it: {missingForShaped.slice(0, 5).join("; ")}
          {missingForShaped.length > 5 ? `; and ${missingForShaped.length - 5} more` : ""}.
        </p>
      ) : null}
    </div>
  );
}

/** A text section: formatted Markdown to read, a textarea to edit where the state offers edits. */
export function TextSection({ label, star, value, editable, placeholder, onSave, testId, rows = 4 }: { label: string; star?: boolean; value: string | null; editable: boolean; placeholder: string; onSave: (value: string) => void; testId: string; rows?: number }) {
  const prose = useProse({ value: value ?? "", editable, onSave });
  return (
    <Section label={label} star={star} testId={testId} action={editable && !prose.editing && value ? <EditButton label={label} testId={testId} onClick={prose.start} /> : null}>
      {prose.editing ? (
        <Textarea
          autoFocus
          value={prose.draft}
          rows={rows}
          onChange={(event) => prose.setDraft(event.target.value)}
          onBlur={prose.finish}
          onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), prose.cancel())}
          placeholder={placeholder}
          data-plan-section-input={testId}
        />
      ) : (
        <Reading text={value ?? ""} empty={placeholder} editable={editable} onStart={prose.start} testId={testId} />
      )}
    </Section>
  );
}

/** A list section, one item per line while editing. */
export function ListSection({ label, star, items, editable, placeholder, onSave, testId }: { label: string; star?: boolean; items: string[]; editable: boolean; placeholder: string; onSave: (items: string[]) => void; testId: string }) {
  const joined = items.join("\n");
  const prose = useProse({ value: joined, editable, onSave: (draft) => onSave(draft.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean)) });
  return (
    <Section
      label={label}
      star={star}
      testId={testId}
      hint={prose.editing ? "one per line" : undefined}
      action={editable && !prose.editing && items.length > 0 ? <EditButton label={label} testId={testId} onClick={prose.start} /> : null}
    >
      {prose.editing ? (
        <Textarea
          autoFocus
          value={prose.draft}
          rows={Math.min(8, Math.max(3, items.length + 1))}
          onChange={(event) => prose.setDraft(event.target.value)}
          onBlur={prose.finish}
          onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), prose.cancel())}
          placeholder={placeholder}
          data-plan-section-input={testId}
        />
      ) : items.length === 0 ? (
        editable ? (
          <Reading text="" empty={placeholder} editable onStart={prose.start} testId={testId} />
        ) : (
          <p className="m-0 text-body text-text-secondary">None.</p>
        )
      ) : (
        <Markdown text={items.map((item) => `- ${item}`).join("\n")} className="staple-detail-prose text-body" />
      )}
    </Section>
  );
}

const COLUMNS: Array<{ field: keyof BreakdownRow; label: string; width: string; placeholder: string }> = [
  { field: "key", label: "#", width: "w-16", placeholder: "1.1" },
  { field: "title", label: "Task", width: "min-w-48 flex-1", placeholder: "What to build" },
  { field: "estimate", label: "Est.", width: "w-16", placeholder: "2h" },
  { field: "dependsOn", label: "After", width: "w-24", placeholder: "1.1, 1.2" },
  { field: "acceptance", label: "Done when", width: "min-w-48 flex-1", placeholder: "How we know it is done" },
  { field: "owner", label: "Owner", width: "w-24", placeholder: "who" },
  { field: "notes", label: "Notes", width: "min-w-32 flex-1", placeholder: "" },
];

/** The "done when" cell of a row that inherits says so, so an empty cell never reads as missing. */
const placeholderFor = (column: (typeof COLUMNS)[number], inherits: boolean): string => (column.field === "acceptance" && inherits ? "Inherits the plan's acceptance" : column.placeholder);

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

/**
 * The task breakdown: structured rows, edited in place and saved whole on each change that
 * leaves a cell. A table on a desk; a card per row on a phone, every field still reachable.
 */
export function BreakdownSection({ rows, editable, onSave, inherits, warnings }: { rows: BreakdownRow[]; editable: boolean; onSave: (rows: BreakdownRow[]) => void; inherits: boolean; warnings: string[] }) {
  const desk = useIsDesk();
  const [draft, setDraft] = useState(rows);
  /** On a phone one row is open for editing at a time; the rest read as a summary. */
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setDraft(rows), [rows]);
  const commit = (next: BreakdownRow[]) => {
    setDraft(next);
    if (JSON.stringify(next) !== JSON.stringify(rows)) onSave(next);
  };
  const edit = (index: number, field: keyof BreakdownRow, value: string) => setDraft((current) => current.map((row, at) => (at === index ? withCell(row, field, value) : row)));
  const save = () => commit(draft.filter((row) => row.key.trim() || row.title.trim()));
  const missingAcceptance = draft.filter((row) => !row.acceptance).length;
  // A row without its own "done when" takes the plan's acceptance criteria, flagged so it is sharpened later.
  const gap = missingAcceptance === 0 ? "" : inherits ? ` · ${missingAcceptance} inherit the plan's acceptance` : ` · ${missingAcceptance} without "done when"`;
  return (
    <Section label="Task breakdown" star testId="breakdown" hint={`${draft.length} task${draft.length === 1 ? "" : "s"}${gap}`}>
      {draft.length === 0 && !editable ? <p className="m-0 text-body text-text-secondary">No tasks yet.</p> : null}
      {desk ? (
        <div className="overflow-x-auto rounded-md border" data-plan-breakdown="table">
          <table className="w-full min-w-[44rem] border-collapse text-label">
            <thead>
              <tr className="border-b bg-surface-sunken text-left text-caption text-text-tertiary">
                {COLUMNS.map((column) => (
                  <th key={column.field} className="px-2 py-1.5 font-medium">
                    {column.label}
                  </th>
                ))}
                {editable ? <th className="w-8" /> : null}
              </tr>
            </thead>
            <tbody>
              {draft.map((row, index) => (
                <tr key={row.id ?? `new-${index}`} className={cn("border-b last:border-b-0 align-top", !row.acceptance && !inherits && "bg-[color:var(--status-task-todo)]/5")} data-plan-row={row.key} data-plan-row-inherits={!row.acceptance && inherits ? "" : undefined}>
                  {COLUMNS.map((column) => (
                    <td key={column.field} className="px-1 py-1">
                      {editable ? (
                        <Input value={cellValue(row, column.field)} placeholder={placeholderFor(column, inherits)} onChange={(event) => edit(index, column.field, event.target.value)} onBlur={save} aria-label={`${column.label} for ${row.key || "new task"}`} className="h-8 px-1.5" />
                      ) : (
                        <span className="block px-1 py-1">{cellValue(row, column.field) || (column.field === "acceptance" && inherits ? <InheritedBadge /> : <span className="text-text-tertiary">—</span>)}</span>
                      )}
                    </td>
                  ))}
                  {editable ? (
                    <td className="px-1 py-1">
                      <Button variant="ghost" size="icon" className="size-8" aria-label={`Remove task ${row.key}`} onClick={() => commit(draft.filter((_, at) => at !== index))}>
                        <Trash2 aria-hidden />
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0" data-plan-breakdown="cards">
          {draft.map((row, index) => (
            <li key={row.id ?? `new-${index}`} className={cn("rounded-md border p-2.5", !row.acceptance && !inherits && "border-[color:var(--status-task-todo)]/50")} data-plan-row={row.key} data-plan-row-inherits={!row.acceptance && inherits ? "" : undefined}>
              {editable && open === index ? (
                <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-label">
                  {COLUMNS.map((column) => (
                    <label key={column.field} className="contents">
                      <span className="text-caption text-text-tertiary">{column.label}</span>
                      <Input value={cellValue(row, column.field)} placeholder={placeholderFor(column, inherits)} onChange={(event) => edit(index, column.field, event.target.value)} onBlur={save} className="h-10" />
                    </label>
                  ))}
                  <span />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" className="h-10" onClick={() => setOpen(null)}>
                      Done
                    </Button>
                    <Button variant="ghost" size="sm" className="h-10" onClick={() => (commit(draft.filter((_, at) => at !== index)), setOpen(null))}>
                      <Trash2 aria-hidden />
                      Remove task {row.key}
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!editable}
                  onClick={() => setOpen(index)}
                  className="block w-full space-y-1 text-left text-label disabled:cursor-default"
                  aria-label={editable ? `Edit task ${row.key}` : undefined}
                  data-plan-row-open={row.key}
                >
                  <div className="font-medium">
                    <span className="font-mono text-text-tertiary">{row.key}</span> {row.title}
                  </div>
                  <div className="text-caption text-text-secondary">
                    {[row.estimate, row.dependsOn.length ? `after ${row.dependsOn.join(", ")}` : null, row.owner].filter(Boolean).join(" · ")}
                  </div>
                  <div className="text-caption">{row.acceptance ? `Done when: ${row.acceptance}` : inherits ? <InheritedBadge /> : <span className="text-[color:var(--status-task-todo)]">No "done when" yet</span>}</div>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 ? (
        <ul className="m-0 mt-2 list-none space-y-0.5 p-0 text-caption text-[color:var(--status-task-todo)]" data-plan-warnings>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 min-h-9"
          onClick={() => {
            setDraft((current) => [...current, { key: nextKey(current), title: "", estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null }]);
            setOpen(draft.length);
          }}
          data-plan-add-row
        >
          <Plus aria-hidden />
          Add a task
        </Button>
      ) : null}
    </Section>
  );
}

/** Every plan section of the record, in the order an agent reads them. */
export function PlanSectionsView({ record, write }: { record: IdeaDetailData; write: PlanWrite }) {
  const editable = offers(record.idea, "edit");
  const save = (patch: Partial<PlanSections>) => void write("update", { ref: record.idea.id, plan: patch });
  const { plan } = record;
  return (
    <>
      <TextSection label="Goal" star value={plan.goal} editable={editable} placeholder="What done means, in one paragraph." onSave={(goal) => save({ goal })} testId="goal" rows={3} />
      <TextSection label="Context & constraints" value={plan.context} editable={editable} placeholder="Layering, contracts, the ground rules that bind it." onSave={(context) => save({ context })} testId="context" rows={5} />
      <BreakdownSection
        rows={plan.breakdown}
        editable={editable}
        inherits={plan.acceptance.length > 0}
        warnings={record.planWarnings}
        // Saved against the breakdown this editor read: a newer edit made meanwhile refuses the save instead of being lost.
        onSave={(breakdown) => void write("update", { ref: record.idea.id, plan: { breakdown }, breakdownBase: record.breakdownRevision })}
      />
      <ListSection label="Acceptance criteria" star items={plan.acceptance} editable={editable} placeholder="How the whole is proven done." onSave={(acceptance) => save({ acceptance })} testId="acceptance" />
      <ListSection label="Dependencies" items={plan.dependencies} editable={editable} placeholder="Other ideas or epics this waits on." onSave={(dependencies) => save({ dependencies })} testId="dependencies" />
      <TextSection label="Out of scope" value={plan.outOfScope} editable={editable} placeholder="What this deliberately does not do." onSave={(outOfScope) => save({ outOfScope })} testId="out-of-scope" rows={3} />
      <TextSection label="Risks" value={plan.risks} editable={editable} placeholder="What could make it slip, and the early signal." onSave={(risks) => save({ risks })} testId="risks" rows={3} />
      <ListSection label="Sources & files" items={plan.sources} editable={editable} placeholder="Source plans, ADRs, mockups (files live under Files)." onSave={(sources) => save({ sources })} testId="sources" />
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
    <Section label="Scaffold" testId="scaffold">
      <div className="rounded-lg border border-dashed p-3" data-plan-scaffold data-plan-scaffold-held={held ? "" : undefined}>
        <p className="m-0 text-label text-text-secondary">
          {preview.epic.promoted ? `Already ${preview.epic.identifier}; scaffolding again adds only the tasks written since.` : "Promotes this idea into the epic and turns its task breakdown into the epic's tasks."}{" "}
          {fresh} new task{fresh === 1 ? "" : "s"} of {count}.
        </p>
        {held ? (
          <p className="m-0 mt-1.5 text-label text-[color:var(--status-task-todo)]" data-plan-scaffold-problems>
            Held back, the plan is incomplete: {preview.problems.join("; ")}.
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onToggle} data-plan-scaffold-preview aria-expanded={open}>
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
          <ul className="m-0 mt-2 list-none space-y-0.5 p-0 text-caption text-[color:var(--status-task-todo)]" data-plan-scaffold-warnings>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {open ? <PreviewTree preview={preview} /> : null}
      </div>
    </Section>
  );
}

function countTasks(preview: ScaffoldPreviewData, freshOnly = false): number {
  return preview.tasks.filter((task) => !freshOnly || !task.existing).length + preview.children.reduce((sum, child) => sum + countTasks(child, freshOnly), 0);
}

function PreviewTree({ preview, depth = 0 }: { preview: ScaffoldPreviewData; depth?: number }) {
  return (
    <div className={cn("mt-3 space-y-1.5", depth > 0 && "border-l pl-3")} data-plan-scaffold-tree={preview.idea.id}>
      <div className="text-label font-medium">
        {preview.epic.identifier ?? `New ${preview.epic.kind}`}: {preview.idea.title}
        <span className="ml-1.5 text-caption font-normal text-text-tertiary">{preview.epic.acceptance.length} acceptance criteria</span>
      </div>
      <ul className="m-0 list-none space-y-1 p-0">
        {preview.tasks.map((task) => (
          <li key={task.key} className="rounded border px-2 py-1.5 text-label" data-plan-scaffold-task={task.key}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-caption text-text-tertiary">{task.existing ?? "new"}</span>
              <span className="min-w-0 flex-1">{task.title}</span>
              {task.estimateWarning ? (
                <span className="text-caption text-[color:var(--status-task-todo)]" data-plan-scaffold-estimate-warning>
                  {task.estimateWarning}
                </span>
              ) : task.estimate ? (
                <span className="text-caption text-text-secondary">{task.estimate}</span>
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
