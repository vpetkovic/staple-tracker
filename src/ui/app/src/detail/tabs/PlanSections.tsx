/**
 * An idea's plan sections in the Plan tab (design/plan.md, "Plan sections"): the completeness
 * meter, each text and list section, the task breakdown as an editable table (stacked cards below
 * 768px), and the scaffold preview. Every editor renders only when the idea's state offers the
 * edit action; a section read-only otherwise. Each save writes that one section whole.
 */
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BreakdownRow, IdeaDetailData, PlanSections, ScaffoldPreviewData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { offers } from "../plain-actions";
import type { PlanWrite } from "../plan-record";

export function Section({ label, star, children, testId, hint }: { label: string; star?: boolean; children: ReactNode; testId?: string; hint?: string }) {
  return (
    <section data-plan-section={testId}>
      <h3 className="mb-2 flex items-baseline gap-1.5 text-caption font-semibold tracking-wide text-text-tertiary uppercase">
        {label}
        {star ? (
          <span aria-label="required to shape" title="Required before the idea is shaped" className="text-[color:var(--status-task-todo)]">
            ★
          </span>
        ) : null}
        {hint ? <span className="font-normal tracking-normal normal-case">{hint}</span> : null}
      </h3>
      {children}
    </section>
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
      {thinking && missingForShaped.length > 0 ? (
        <p className="m-0 mt-1.5 text-caption text-text-secondary" data-plan-missing>
          To shape it: {missingForShaped.slice(0, 5).join("; ")}
          {missingForShaped.length > 5 ? `; and ${missingForShaped.length - 5} more` : ""}.
        </p>
      ) : null}
    </div>
  );
}

/** A text section: a textarea saved on blur, or the text when the state offers no edits. */
export function TextSection({ label, star, value, editable, placeholder, onSave, testId, rows = 4 }: { label: string; star?: boolean; value: string | null; editable: boolean; placeholder: string; onSave: (value: string) => void; testId: string; rows?: number }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <Section label={label} star={star} testId={testId}>
      {editable ? (
        <Textarea value={draft} rows={rows} onChange={(event) => setDraft(event.target.value)} onBlur={() => draft !== (value ?? "") && onSave(draft)} placeholder={placeholder} data-plan-section-input={testId} />
      ) : (
        <p className="m-0 text-body whitespace-pre-wrap text-text-secondary">{value || "Not written."}</p>
      )}
    </Section>
  );
}

/** A list section, one item per line while editing. */
export function ListSection({ label, star, items, editable, placeholder, onSave, testId }: { label: string; star?: boolean; items: string[]; editable: boolean; placeholder: string; onSave: (items: string[]) => void; testId: string }) {
  const joined = items.join("\n");
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined]);
  return (
    <Section label={label} star={star} testId={testId} hint={editable ? "one per line" : undefined}>
      {editable ? (
        <Textarea
          value={draft}
          rows={Math.min(8, Math.max(3, items.length + 1))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== joined && onSave(draft.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean))}
          placeholder={placeholder}
          data-plan-section-input={testId}
        />
      ) : items.length === 0 ? (
        <p className="m-0 text-body text-text-secondary">None.</p>
      ) : (
        <ul className="m-0 list-disc space-y-1 pl-5 text-body">
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
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
export function BreakdownSection({ rows, editable, onSave }: { rows: BreakdownRow[]; editable: boolean; onSave: (rows: BreakdownRow[]) => void }) {
  const desk = useIsDesk();
  const [draft, setDraft] = useState(rows);
  useEffect(() => setDraft(rows), [rows]);
  const commit = (next: BreakdownRow[]) => {
    setDraft(next);
    if (JSON.stringify(next) !== JSON.stringify(rows)) onSave(next);
  };
  const edit = (index: number, field: keyof BreakdownRow, value: string) => setDraft((current) => current.map((row, at) => (at === index ? withCell(row, field, value) : row)));
  const save = () => commit(draft.filter((row) => row.key.trim() || row.title.trim()));
  const missingAcceptance = draft.filter((row) => !row.acceptance).length;
  return (
    <Section label="Task breakdown" star testId="breakdown" hint={`${draft.length} task${draft.length === 1 ? "" : "s"}${missingAcceptance > 0 ? ` · ${missingAcceptance} without "done when"` : ""}`}>
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
                <tr key={index} className={cn("border-b last:border-b-0 align-top", !row.acceptance && "bg-[color:var(--status-task-todo)]/5")} data-plan-row={row.key}>
                  {COLUMNS.map((column) => (
                    <td key={column.field} className="px-1 py-1">
                      {editable ? (
                        <Input value={cellValue(row, column.field)} placeholder={column.placeholder} onChange={(event) => edit(index, column.field, event.target.value)} onBlur={save} aria-label={`${column.label} for ${row.key || "new task"}`} className="h-8 px-1.5" />
                      ) : (
                        <span className="block px-1 py-1">{cellValue(row, column.field) || <span className="text-text-tertiary">—</span>}</span>
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
            <li key={index} className={cn("rounded-md border p-2.5", !row.acceptance && "border-[color:var(--status-task-todo)]/50")} data-plan-row={row.key}>
              {editable ? (
                <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-label">
                  {COLUMNS.map((column) => (
                    <label key={column.field} className="contents">
                      <span className="text-caption text-text-tertiary">{column.label}</span>
                      <Input value={cellValue(row, column.field)} placeholder={column.placeholder} onChange={(event) => edit(index, column.field, event.target.value)} onBlur={save} className="h-10" />
                    </label>
                  ))}
                  <span />
                  <Button variant="ghost" size="sm" className="h-10 justify-self-start" onClick={() => commit(draft.filter((_, at) => at !== index))}>
                    <Trash2 aria-hidden />
                    Remove task {row.key}
                  </Button>
                </div>
              ) : (
                <div className="space-y-1 text-label">
                  <div className="font-medium">
                    <span className="font-mono text-text-tertiary">{row.key}</span> {row.title}
                  </div>
                  <div className="text-caption text-text-secondary">
                    {[row.estimate, row.dependsOn.length ? `after ${row.dependsOn.join(", ")}` : null, row.owner].filter(Boolean).join(" · ")}
                  </div>
                  <div className="text-caption">{row.acceptance ? `Done when: ${row.acceptance}` : <span className="text-[color:var(--status-task-todo)]">No "done when" yet</span>}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 min-h-9"
          onClick={() => setDraft((current) => [...current, { key: nextKey(current), title: "", estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null }])}
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
      <BreakdownSection rows={plan.breakdown} editable={editable} onSave={(breakdown) => save({ breakdown })} />
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
export function ScaffoldSection({ preview, open, onToggle, onConfirm, busy }: { preview: ScaffoldPreviewData; open: boolean; onToggle: () => void; onConfirm: () => void; busy: boolean }) {
  const count = countTasks(preview);
  const fresh = countTasks(preview, true);
  return (
    <Section label="Scaffold" testId="scaffold">
      <div className="rounded-lg border border-dashed p-3" data-plan-scaffold>
        <p className="m-0 text-label text-text-secondary">
          {preview.epic.promoted ? `Already ${preview.epic.identifier}; scaffolding again adds only the tasks written since.` : "Promotes this idea into the epic and turns its task breakdown into the epic's tasks."}{" "}
          {fresh} new task{fresh === 1 ? "" : "s"} of {count}.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onToggle} data-plan-scaffold-preview aria-expanded={open}>
            {open ? "Hide the preview" : "Preview what it creates"}
          </Button>
          {open ? (
            <Button size="sm" onClick={onConfirm} disabled={busy || fresh === 0} data-plan-scaffold-confirm>
              {preview.epic.promoted ? `Create ${fresh} new task${fresh === 1 ? "" : "s"}` : `Create the epic and ${fresh} task${fresh === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>
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
              {task.estimate ? <span className="text-caption text-text-secondary">{task.estimate}</span> : null}
            </div>
            <div className="text-caption text-text-secondary">
              {task.blockedBy.length > 0 ? `after ${task.blockedBy.join(", ")}` : "no blockers"}
              {task.waitsOutside.length > 0 ? ` · waits on ${task.waitsOutside.join(", ")}` : ""}
              {task.acceptance[0] ? ` · done when ${task.acceptance[0]}` : " · no done-when"}
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
