/**
 * Click-to-edit title, kind, priority and labels — owned by U5, extended by O1b (STA-125).
 *
 * These three live here rather than in IssueActions because they belong where they are
 * READ: a title you have to scroll to a form to change is not inline editing. The panel
 * header substitutes these in for its static `<h2>` and `<PriorityLabel>` and adds the
 * label row; nothing else about the header, the tab registry, or the fetch moves.
 *
 * One shared decision across all three: REFETCH ON SUCCESS, not optimistic.
 * `session.refresh()` bumps the version the panel already refetches on, so what is on
 * screen a moment after a write is what the store actually holds. Optimism would be
 * cheap here and wrong: `updateIssue` normalizes the title it stores, and a guard can
 * refuse, so the value the UI guessed and the value the store kept are not reliably the
 * same thing. On a loopback SQLite round trip there is nothing to buy by guessing.
 *
 * Refusals go through describeRefusal() and the detail's one refusal look (RefusalNotice in
 * IssueActions.tsx): a plain sentence first, the store's own words one tap away. An editor
 * given `report` hands its refusal to the panel instead (the phone's chips), so it is shown
 * in the panel's one refusal slot and never breaks the chip row.
 */
import { Check, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KindGlyph, PrioritySignal } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { action, assignProject } from "@/lib/api";
import { projectsForWorkspace } from "@/lib/projects";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { configuredKindOrder, kindLabel } from "@/lib/settings";
import { cn } from "./parts/cn";
import { ISSUE_PRIORITIES, type ActionPayload, type Issue, type IssueKind, type IssuePriority } from "@/lib/types";
import { RefusalNotice } from "./IssueActions";
import { PRIORITY_WORDS } from "./properties";

/**
 * How an editor's trigger is drawn: `row` for a value in the property list (quiet, grows a
 * hover wash), `chip` for the phone's summary chips (a bordered, finger-sized pill).
 */
export type EditorVariant = "row" | "chip";

interface EditorProps {
  issue: Issue;
  workspace: string;
  refresh: () => void;
  variant?: EditorVariant;
  /** Send a refusal to the panel's refusal slot instead of drawing it here. */
  report?: (refusal: Refusal | null) => void;
}

/** The trigger classes for both variants, so kind, priority and project look like one family. */
function triggerClass(variant: EditorVariant): string {
  // Sizes are arbitrary values on purpose: the Select trigger merges these with its own
  // `text-base md:text-sm` through the shared `cn`, which does not know the type-scale
  // tokens (see parts/cn.ts). 13px is `text-body`.
  return variant === "chip"
    ? "focus-ring w-auto gap-1.5 rounded-full border border-border bg-surface-raised px-3 text-[13px] md:text-[13px] font-medium text-foreground shadow-none hover:bg-surface-hover data-[size=sm]:h-9 [&>svg:last-child]:size-3.5 [&>svg:last-child]:opacity-60"
    : "focus-ring -ml-1.5 w-auto max-w-full gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[13px] md:text-[13px] text-foreground shadow-none hover:bg-surface-hover data-[size=sm]:h-8 pointer-coarse:data-[size=sm]:h-10 [&>svg:last-child]:size-3.5 [&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-60 focus-visible:[&>svg:last-child]:opacity-60";
}

/**
 * The write half of every editor below: POST, refetch on success, keep the refusal on
 * failure. Returns whether it succeeded, so a caller can decide what to close.
 */
function useUpdate(issue: Issue, workspace: string, refresh: () => void) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const update = async (patch: Extract<ActionPayload, { type: "update" }>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setRefusal(null);
    try {
      await action({ ws: workspace, ref: issue.id }, patch);
      refresh();
      return true;
    } catch (caught) {
      setRefusal(describeRefusal(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { update, busy, refusal, dismiss: () => setRefusal(null) };
}

/** The refusal panel, in the one style all three editors share. */
function RefusalSlot({ refusal, onDismiss, report }: { refusal: Refusal | null; onDismiss: () => void; report?: (refusal: Refusal | null) => void }) {
  useEffect(() => {
    if (report && refusal) report(refusal);
  }, [report, refusal]);
  if (!refusal || report) return null;
  return <RefusalNotice feedback={{ kind: "refused", refusal }} onDismiss={onDismiss} className="mt-2" />;
}

// ---------------------------------------------------------------- title

export function InlineTitle({ issue, workspace, refresh, size = "display", report }: EditorProps & { size?: "display" | "heading" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.title);
  const { update, busy, refusal, dismiss } = useUpdate(issue, workspace, refresh);
  const inputRef = useRef<HTMLInputElement>(null);

  // A poll can land a newer title while the panel is open. Adopt it whenever the field
  // is closed; never while it is open, which would eat what is being typed.
  useEffect(() => {
    if (!editing) setDraft(issue.title);
  }, [issue.title, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    if (draft === issue.title) {
      setEditing(false);
      return;
    }
    // The draft is sent as typed, blank included: "Title cannot be empty" is the
    // store's sentence to say, not this component's.
    if (await update({ type: "update", title: draft })) setEditing(false);
  };

  if (!editing) {
    return (
      <>
        <button
          type="button"
          data-edit-title
          onClick={() => setEditing(true)}
          title="Rename"
          className="group focus-ring flex w-full items-start gap-2 rounded-md text-left"
        >
          <h2
            className={cn(
              "min-w-0 font-semibold text-balance wrap-anywhere text-foreground",
              size === "display" ? "text-display" : "text-heading",
            )}
          >
            {issue.title}
          </h2>
          <Pencil
            aria-hidden
            className={cn(
              "shrink-0 text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
              size === "display" ? "mt-2 size-4" : "mt-1.5 size-3.5",
            )}
          />
        </button>
        <RefusalSlot refusal={refusal} onDismiss={dismiss} report={report} />
      </>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          data-edit-title-input
          autoFocus
          value={draft}
          disabled={busy}
          aria-label="Title"
          // Arbitrary sizes: Input merges through the shared `cn` (see parts/cn.ts).
          className={cn("h-auto py-1 font-semibold", size === "display" ? "text-[24px] leading-[30px] md:text-[24px]" : "text-[18px] leading-[26px] md:text-[18px]")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              // Escape is an undo, so the draft goes back rather than being kept.
              setDraft(issue.title);
              setEditing(false);
              dismiss();
            }
          }}
        />
        <Button size="icon" variant="ghost" aria-label="Save title" disabled={busy} onClick={() => void commit()}>
          <Check className="size-4" />
        </Button>
      </div>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} report={report} />
    </div>
  );
}

// ----------------------------------------------------------------- kind

/**
 * The declared kind — O1b (STA-125).
 *
 * ── WHY IT IS AN EDITOR AND NOT A FACT ────────────────────────────────────────────────
 *
 * O1's premise (STA-120) is that a kind is DECLARED, never derived: a task can gain
 * children and stay a task, and the UI may suggest promoting it but must never do it. A
 * declaration that has no control is not a declaration — it is a value somebody else
 * chose — so the moment kind became a first-class field it had to become writable on the
 * surface it is read on. That is the same argument priority makes below, which is why
 * this is the same component shape and not a new one.
 *
 * ── THE OPTIONS COME FROM THE SERVED VOCABULARY, NEVER FROM `ISSUE_KINDS` ─────────────
 *
 * O7a (STA-140) made kinds workspace DATA and O1a's own worklog says so explicitly: a
 * picker rendering the five built-in constants would omit every kind the operator added
 * and would offer any they removed. `configuredKindOrder()` is the list the settings
 * dialog edits, in the order it edits it, and `kindLabel()` is the name the operator gave
 * it — so renaming `spike` to "Investigation" renames it here with no change to this file.
 *
 * ── SURVIVING THE POLL ────────────────────────────────────────────────────────────────
 *
 * Nothing here is optimistic. `update()` POSTs and then `refresh()`es, which bumps the
 * version the panel refetches on, so the value on screen after a write is the value the
 * store actually holds — and the 1.5s poll that lands next finds the same thing and
 * changes nothing. A local `useState` mirror of the kind would be the bug this avoids:
 * it would win against the poll for as long as the component stayed mounted and lose the
 * moment it did not.
 */
export function InlineKind({ issue, workspace, refresh, variant = "row", report }: EditorProps) {
  const { update, busy, refusal, dismiss } = useUpdate(issue, workspace, refresh);
  const kinds = configuredKindOrder();

  return (
    <>
      <Select
        value={issue.kind}
        disabled={busy}
        onValueChange={(value) => void update({ type: "update", kind: value as IssueKind })}
      >
        {/* Unstyled as a control, exactly like the priority trigger beside it: this is a
            row of the property block, where a full-width bordered select would outshout
            every read-only value in the same grid. The trigger draws the real
            `KindGlyph` rather than a `<SelectValue/>`, so making kind editable does not
            quietly drop the mark every ROW in the app now carries — the same component,
            the same shapes, at the 16px StatusIcon size the panel has room for. */}
        <SelectTrigger
          size="sm"
          data-edit-kind
          aria-label="Kind"
          className={triggerClass(variant)}
        >
          <span className="flex items-center gap-1.5">
            {/* `labelled={false}`: the label is right there in text, and two readings of
                one fact is worse than none. */}
            <KindGlyph kind={issue.kind} size={16} labelled={false} />
            {kindLabel(issue.kind)}
          </span>
        </SelectTrigger>
        {/* `position="popper"` for the reason spelled out under InlinePriority: the
            vendored "item-aligned" default positions the list by the SELECTED row, so a
            kind near the end of the vocabulary pushes the top of the list off-screen. */}
        <SelectContent position="popper" align="start">
          {kinds.map((kind) => (
            <SelectItem key={kind} value={kind} className="pointer-coarse:min-h-11">
              <span className="flex items-center gap-1.5">
                <KindGlyph kind={kind} size={16} labelled={false} />
                {kindLabel(kind)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} report={report} />
    </>
  );
}

// ------------------------------------------------------------- project

/** Radix Select forbids an empty item value; this stands for "no project". */
const NO_PROJECT = "__none__";

/**
 * The project an issue is filed under (migration 009) — an editor, like kind, because
 * the store can refuse it (an unknown project is `not_found`) and because the value has
 * to be writable where it is read. The options are the page's own `session.projects`,
 * narrowed to the issue's workspace: a project in another workspace is not a place this
 * issue can go. The write is `/api/project/assign`, not `/api/action`, which is why this
 * editor does not share `useUpdate` with its neighbours; the refetch-on-success rule is
 * the same.
 */
export function InlineProject({ issue, workspace, refresh, variant = "row", report }: EditorProps) {
  const session = useSession();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  // The page's list is every workspace's; this issue can only go into its own workspace's.
  const rows = projectsForWorkspace(session.projects.data ?? [], workspace);
  const current = rows.find((row) => row.project.id === issue.projectId);

  const assign = async (project: string | null) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await assignProject({ ws: workspace, ref: issue.id, project });
      refresh();
    } catch (caught) {
      setRefusal(describeRefusal(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Select
        value={issue.projectId && current ? issue.projectId : NO_PROJECT}
        disabled={busy}
        onValueChange={(value) => void assign(value === NO_PROJECT ? null : value)}
      >
        <SelectTrigger
          size="sm"
          data-edit-project
          aria-label="Project"
          className={triggerClass(variant)}
        >
          <span className={cn("truncate", !current && "text-text-tertiary")}>
            {current ? current.project.name : "No project"}
          </span>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={NO_PROJECT} className="pointer-coarse:min-h-11">No project</SelectItem>
          {rows.map((row) => (
            <SelectItem key={row.project.id} value={row.project.id} className="pointer-coarse:min-h-11">
              {row.project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={() => setRefusal(null)} report={report} />
    </>
  );
}

// ------------------------------------------------------------- priority

export function InlinePriority({ issue, workspace, refresh, variant = "row", report }: EditorProps) {
  const { update, busy, refusal, dismiss } = useUpdate(issue, workspace, refresh);

  return (
    <>
      <Select
        value={issue.priority}
        disabled={busy}
        onValueChange={(value) => void update({ type: "update", priority: value as IssuePriority })}
      >
        {/* Sized to the text and unstyled as a control: this sits in the metadata row,
            where a full-width bordered select would shout louder than the status chip.
            The trigger renders a PriorityLabel rather than <SelectValue/> so making
            priority editable does not quietly drop the weight-and-hue encoding the rest
            of the page uses — same component, same rules, now clickable. */}
        <SelectTrigger
          size="sm"
          data-edit-priority
          aria-label="Priority"
          className={triggerClass(variant)}
        >
          <PriorityValue priority={issue.priority} />
        </SelectTrigger>
        {/*
          `position="popper"`, not the vendored default of "item-aligned".
          item-aligned puts the SELECTED row over the trigger, so on a `low` issue —
          last of four — the list is shifted up by three rows and `critical` lands
          above the top of the window, unclickable. That is invisible on a `medium`
          issue and reproducible on a `low` one, which is exactly the kind of bug a
          headless pass catches and a demo does not. The vendored component already
          supports this prop; nothing under components/ui/ was edited.
        */}
        <SelectContent position="popper" align="start">
          {ISSUE_PRIORITIES.map((priority) => (
            <SelectItem key={priority} value={priority} className="pointer-coarse:min-h-11">
              <PriorityValue priority={priority} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} report={report} />
    </>
  );
}

/** The priority's icon (the list's own signal) and its word, "Urgent" for `critical`. */
export function PriorityValue({ priority }: { priority: IssuePriority }) {
  return (
    <span className="flex items-center gap-1.5" data-priority-value={priority}>
      <span aria-hidden className="flex">
        <PrioritySignal priority={priority} />
      </span>
      {PRIORITY_WORDS[priority]}
    </span>
  );
}

// --------------------------------------------------------------- labels

export function InlineLabels({ issue, workspace, refresh, report }: EditorProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const { update, busy, refusal, dismiss } = useUpdate(issue, workspace, refresh);

  // The store replaces the whole label array, so both add and remove send the RESULT.
  const commitSet = async (next: string[]) => update({ type: "update", labels: next });

  const add = async () => {
    const value = draft.trim();
    if (!value || issue.labels.includes(value)) {
      setDraft("");
      setAdding(false);
      return;
    }
    if (await commitSet([...issue.labels, value])) {
      setDraft("");
      setAdding(false);
    }
  };

  return (
    // V3 (STA-88): the `mt-2` this carried is gone. It was correct while labels hung
    // directly under the title; they are now a row of the property grid, and a top
    // margin inside a grid cell pushes its own row off the baseline every other row
    // in the block is aligned to. Spacing belongs to whatever places this.
    <div data-edit-labels className="min-w-0 max-w-full">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {issue.labels.map((label) => (
          <span
            key={label}
            data-label-chip={label}
            className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full border bg-surface-sunken pr-1 pl-2.5 text-label text-foreground pointer-coarse:h-8"
          >
            <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
            <button
              type="button"
              data-label-remove={label}
              aria-label={`Remove label ${label}`}
              disabled={busy}
              onClick={() => void commitSet(issue.labels.filter((existing) => existing !== label))}
              className="focus-ring flex shrink-0 items-center justify-center rounded-full p-0.5 text-text-tertiary hover:text-foreground pointer-coarse:-my-2 pointer-coarse:-mr-1 pointer-coarse:size-10"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {adding ? (
          <Input
            data-label-input
            autoFocus
            value={draft}
            disabled={busy}
            aria-label="New label"
            placeholder="label"
            className="h-7 w-32 px-2.5 py-0 text-label"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void add()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                setAdding(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            data-label-add
            onClick={() => setAdding(true)}
            aria-label="Add label"
            className="focus-ring inline-flex h-6 items-center gap-1 rounded-full px-2 text-label text-text-tertiary hover:bg-surface-hover hover:text-foreground pointer-coarse:h-10 pointer-coarse:px-3"
          >
            <Plus className="size-3.5" aria-hidden />
            {issue.labels.length === 0 ? "Add label" : null}
          </button>
        )}
      </div>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} report={report} />
    </div>
  );
}
