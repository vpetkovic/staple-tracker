/**
 * Click-to-edit title, priority and labels — owned by U5.
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
 * Refusals go through describeRefusal() + GuardRefusal from views/board/ — the shared
 * primitive, imported and not re-implemented, so an editor can never show a sentence
 * the store did not say.
 */
import { Check, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PriorityLabel } from "@/components/PriorityLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { action } from "@/lib/api";
import { ISSUE_PRIORITIES, type ActionPayload, type Issue, type IssuePriority } from "@/lib/types";
import { GuardRefusal } from "@/views/board/GuardRefusal";
import { describeRefusal, type Refusal } from "@/views/board/refusal";

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
    <div data-edit-labels className="mt-2">
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
