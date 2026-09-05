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
 * Refusals go through describeRefusal() + GuardRefusal, now lib/ and components/ — the shared
 * primitive, imported and not re-implemented, so an editor can never show a sentence
 * the store did not say.
 */
import { Check, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { PriorityLabel } from "@/components/PriorityLabel";
import { KindGlyph } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { action, assignProject } from "@/lib/api";
import { projectsForWorkspace } from "@/lib/projects";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { configuredKindOrder, kindLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { ISSUE_PRIORITIES, type ActionPayload, type Issue, type IssueKind, type IssuePriority } from "@/lib/types";

interface EditorProps {
  issue: Issue;
  workspace: string;
  refresh: () => void;
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
      await action({ ws: workspace, ref: issue.identifier }, patch);
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
function RefusalSlot({ refusal, onDismiss }: { refusal: Refusal | null; onDismiss: () => void }) {
  if (!refusal) return null;
  return (
    <div className="mt-2 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/5 p-2">
      <GuardRefusal refusal={refusal} onDismiss={onDismiss} />
    </div>
  );
}

// ---------------------------------------------------------------- title

export function InlineTitle({ issue, workspace, refresh }: EditorProps) {
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
          className="group mt-1 flex w-full items-start gap-1.5 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <h2 className="text-base leading-snug font-semibold">{issue.title}</h2>
          <Pencil
            aria-hidden
            className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        </button>
        <RefusalSlot refusal={refusal} onDismiss={dismiss} />
      </>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <Input
          ref={inputRef}
          data-edit-title-input
          autoFocus
          value={draft}
          disabled={busy}
          aria-label="Title"
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
      <RefusalSlot refusal={refusal} onDismiss={dismiss} />
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
export function InlineKind({ issue, workspace, refresh }: EditorProps) {
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
          className="h-auto w-auto gap-1.5 rounded-sm border-0 bg-transparent px-1 py-0 text-[12px] shadow-none hover:bg-accent"
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
            <SelectItem key={kind} value={kind}>
              <span className="flex items-center gap-1.5">
                <KindGlyph kind={kind} size={16} labelled={false} />
                {kindLabel(kind)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} />
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
export function InlineProject({ issue, workspace, refresh }: EditorProps) {
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
      await assignProject({ ws: workspace, ref: issue.identifier, project });
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
          className="h-auto w-auto gap-1.5 rounded-sm border-0 bg-transparent px-1 py-0 text-[12px] shadow-none hover:bg-accent"
        >
          <span className={cn("truncate", !current && "text-text-tertiary")}>
            {current ? current.project.name : "No project"}
          </span>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={NO_PROJECT}>No project</SelectItem>
          {rows.map((row) => (
            <SelectItem key={row.project.id} value={row.project.id}>
              {row.project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={() => setRefusal(null)} />
    </>
  );
}

// ------------------------------------------------------------- priority

export function InlinePriority({ issue, workspace, refresh }: EditorProps) {
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
          className="h-auto w-auto gap-1 rounded-sm border-0 bg-transparent px-1 py-0 shadow-none hover:bg-accent"
        >
          <PriorityLabel priority={issue.priority} />
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
            <SelectItem key={priority} value={priority}>
              {priority}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} />
    </>
  );
}

// --------------------------------------------------------------- labels

export function InlineLabels({ issue, workspace, refresh }: EditorProps) {
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
    <div data-edit-labels>
      <div className="flex flex-wrap items-center gap-1">
        {issue.labels.map((label) => (
          <span
            key={label}
            data-label-chip={label}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {label}
            <button
              type="button"
              data-label-remove={label}
              aria-label={`Remove label ${label}`}
              disabled={busy}
              onClick={() => void commitSet(issue.labels.filter((existing) => existing !== label))}
              className="-mr-0.5 rounded-full p-0.5 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
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
            className="h-6 w-28 px-2 py-0 text-[11px]"
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
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
          >
            <Plus className="size-3" aria-hidden />
            {issue.labels.length === 0 ? "add label" : null}
          </button>
        )}
      </div>
      <RefusalSlot refusal={refusal} onDismiss={dismiss} />
    </div>
  );
}
