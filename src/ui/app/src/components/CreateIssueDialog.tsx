/**
 * The create form — owned by U5, upgraded by R7 (STA-103).
 *
 * Two decisions worth stating, because both look like omissions:
 *
 *  1. NOTHING is validated here. The submit button is live even with an empty title,
 *     so `store.createIssue` gets to throw "Title is required" and the user reads the
 *     store's sentence. A disabled button would hide a rule that lives in the store
 *     behind a rule that lives in this file, and the two could drift.
 *  2. The relational fields are SearchableSelects over tasks that exist, so a ref
 *     cannot be a typo. Before R7 they were text boxes you typed `STA-12` into from
 *     memory, which failed late and silently: the store's `not_found` arrived after
 *     the rest of the form was already filled in.
 *
 * WHERE THE OPTIONS COME FROM. One `getIssues({})` when the dialog opens, not
 * `session.issues`. The session's list is scoped to the workspace the PAGE is filtered
 * to, and this dialog has its own workspace select — so if you are looking at `staple`
 * and create into `pinecone`, the session list is the wrong list and would leave the
 * relation fields silently empty. The fetch is per-open, not per-keystroke; the list is
 * narrowed in memory by `filterOptions`.
 *
 * CROSS-WORKSPACE, HONESTLY. Every option and every chip carries a workspace pill, but
 * the issue options are restricted to the target workspace, because the store cannot
 * hold a cross-workspace parent or blocker — see the long note on `issueOptions`. The
 * fields say so rather than offering a choice the store will refuse.
 *
 * Refusals render through describeRefusal() + GuardRefusal, which live in lib/ and
 * components/ since V2 (STA-87) retired the board they used to sit behind. Imported,
 * never copied: a second refusal renderer is a second chance to paraphrase a guard.
 */
import { useEffect, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { KindGlyph } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { action, getIssues } from "@/lib/api";
import { projectsForWorkspace } from "@/lib/projects";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { configuredKindOrder, kindLabel } from "@/lib/settings";
import { ISSUE_PRIORITIES, type Issue, type IssueKind, type IssuePriority, type IssueRow } from "@/lib/types";
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  createFormDefaultKind,
  forWorkspaceSwitch,
  labelOptions,
  parentOptions,
  relationOptions,
  withoutValues,
  splitLabels,
  splitRefs,
  type CreateFormState,
} from "./createIssueForm";

/**
 * Parent only. A parent is a local row id with a derived depth, so it genuinely cannot
 * point at another workspace — see parentOptions() for why that is storage and not policy.
 */
const PARENT_NOTE = "A parent lives in the same workspace.";

/**
 * Blocked by / Blocking. Says what a foreign pick DOES rather than warning about it:
 * cross-workspace is the normal case in a hub, it just lands in a different table.
 */
const CROSS_WORKSPACE_NOTE = "Picks from another workspace become hub links.";

/** Radix Select forbids an empty item value; this stands for "no project". */
const NO_PROJECT = "__none__";

export function CreateIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  /**
   * The workspace's kind vocabulary, read at render — O1b (STA-125). A plain accessor
   * and not a hook: `App.tsx` holds the single `/api/settings` subscription and
   * re-renders this tree when it changes, exactly as `StatusIcon` and the settings
   * dialog already rely on. A second subscriber here would be a second fetch.
   */
  const kinds = configuredKindOrder();
  const freshForm = (): CreateFormState => ({
    ...EMPTY_CREATE_FORM,
    kind: createFormDefaultKind(configuredKindOrder()),
  });
  const [form, setForm] = useState<CreateFormState>(freshForm);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  // In hub mode "" means "every workspace", which is not a thing you can create into.
  // Fall back to the first one so the select always has a real target.
  const [ws, setWs] = useState(session.ws || session.workspaces[0]?.slug || "");

  /**
   * Every issue the server will show us, for the relation dropdowns.
   *
   * Empty until it lands, and NOT a blocker for anything: an empty option list makes
   * the relation fields say "nothing matches" for a moment, while the title and
   * description — the only required field and the one people start with — are already
   * usable. A spinner over the whole form would be slower for the common case, which
   * is creating a task with no relations at all.
   */
  const [rows, setRows] = useState<IssueRow[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // No ws filter: in hub mode this returns every workspace, which is what the LABEL
    // list wants. The relation lists narrow it themselves, per issueOptions.
    getIssues({})
      .then((next) => {
        if (live) setRows(next);
      })
      // Deliberately silent. A failed option fetch degrades the dropdowns to empty; it
      // is not a refusal of anything the user asked for, and putting it in the refusal
      // panel would put a fetch error where store guards are supposed to speak.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, session.version]);

  const set = <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /**
   * The late-settings correction — O1b (STA-125), and the bug O7b's browser pass found
   * the general form of: this dialog can mount before `/api/settings` resolves, and the
   * seed it opens on is `task`. On a workspace that removed `task` from its vocabulary
   * that leaves a select whose value is not one of its options, which the store would
   * refuse at submit on a form that never offered anything else.
   *
   * It only ever fires when the held value is genuinely NOT ON OFFER, so it cannot
   * overwrite a deliberate choice — and an empty list (nothing fetched yet) is left
   * alone, because "we have not been told" is not "it is not there".
   */
  const offered = kinds.join(",");
  useEffect(() => {
    if (!open || kinds.length === 0) return;
    setForm((current) => (kinds.includes(current.kind) ? current : { ...current, kind: createFormDefaultKind(kinds) }));
    // `offered` rather than `kinds`: the accessor returns a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offered]);

  const close = () => {
    setForm(freshForm());
    setRefusal(null);
    onOpenChange(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const created = await action<Issue>({ ws: ws || undefined }, buildCreatePayload(form));
      // Refetch, then select what was just made: creating a task and then having to
      // find it is the thing that makes a create dialog feel like a form rather than
      // part of the tool.
      session.refresh();
      session.open(ws || session.workspaces[0]?.slug || "", created.identifier);
      close();
    } catch (caught) {
      setRefusal(describeRefusal(caught));
    } finally {
      setBusy(false);
    }
  };

  const parents = parentOptions(rows, ws);
  const relations = relationOptions(rows, ws);
  const labels = labelOptions(rows);
  /**
   * The page's own project list (migration 009) — every workspace's, since App fetches it
   * unscoped — narrowed to the target workspace: a project elsewhere is not a place this
   * task can go. No fetch of its own, so the dialog and the rail cannot disagree.
   */
  const projects = projectsForWorkspace(session.projects.data ?? [], ws);
  const projectValue = projects.some((row) => row.project.id === form.project) ? form.project : NO_PROJECT;
  // Neither relation may offer what the other already holds: the same ref on both
  // sides is a two-node cycle, and the store can only refuse it once the task exists.
  // See withoutValues() — the deeper cycles are still the store's to catch.
  const blockedByOptions = withoutValues(relations, form.blocking);
  const blockingOptions = withoutValues(relations, form.blockedBy);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent data-create-dialog className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Everything except the title is optional — the store fills in the rest.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="create-title">Title</Label>
            <Input
              id="create-title"
              data-create-title
              autoFocus
              value={form.title}
              placeholder="What needs doing?"
              onChange={(event) => set("title", event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="create-description">Description</Label>
            <Textarea
              id="create-description"
              data-create-description
              rows={3}
              value={form.description}
              placeholder="Context an agent picking this up would need."
              onChange={(event) => set("description", event.target.value)}
            />
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="create-kind">Kind</Label>
              {/*
                O1b (STA-125). Paired with Priority rather than given a row of its own,
                because the two are the same thing to fill in — a short pick from a closed
                list — and they are the two questions you answer about a ticket before you
                have decided anything about its place in the tree.

                THE OPTIONS ARE THE SERVED VOCABULARY, never `ISSUE_KINDS`. O7a made kinds
                workspace data, so a select over the five built-in constants would omit
                `staple kinds add milestone` and offer anything the operator removed —
                which the store would then refuse, at submit time, on a form that had
                offered it.
              */}
              <Select value={form.kind} onValueChange={(value) => set("kind", value as IssueKind)}>
                <SelectTrigger id="create-kind" data-create-kind className="w-full">
                  <SelectValue />
                </SelectTrigger>
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
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="create-priority">Priority</Label>
              <Select value={form.priority} onValueChange={(value) => set("priority", value as IssuePriority)}>
                <SelectTrigger id="create-priority" data-create-priority className="w-full">
                  <SelectValue />
                </SelectTrigger>
                {/* popper, not the vendored "item-aligned" default: item-aligned
                    positions the list by the selected row, which pushes the top of it
                    off-screen for the lower priorities. See InlineProperties.tsx. */}
                <SelectContent position="popper" align="start">
                  {ISSUE_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {priority}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

          </div>

          {/*
            Parent moved out of the Kind/Priority row and onto a line of its own — O1b
            (STA-125). It is not a third short pick: it is a search over every task in the
            workspace, with a note under it, and half of 576px was already the tightest
            field in the dialog. Kind takes the slot it vacated.

            IT DOES NOT TOUCH THE KIND, and that is the point of putting them next to each
            other rather than deriving one from the other. STA-120's premise is that a kind
            is DECLARED and never derived: filing a ticket under an epic does not make it a
            sub-anything, and a task that later grows children stays a task until somebody
            says otherwise. The only field this control writes is `parent`.
          */}
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="create-parent">Parent</Label>
              {/* Single-select: a task has one parent, and the store enforces a depth
                  cap on it. Selecting replaces rather than appends. */}
              <SearchableSelect
                id="create-parent"
                name="parent"
                options={parents}
                selected={form.parent ? [form.parent] : []}
                onChange={(next) => set("parent", next[0] ?? "")}
                placeholder="No parent"
                actionLabel="Change parent"
                searchPlaceholder="Search tasks…"
                emptyText="no task matches"
                mono
                note={PARENT_NOTE}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="create-project">Project</Label>
              {/*
                Where the task is filed (migration 009). A short pick from a closed list
                like Kind, and optional like Parent: "No project" is the default and a real
                answer. The value is the project's ID, which is what `/api/action` resolves.
              */}
              <Select
                value={projectValue}
                onValueChange={(value) => set("project", value === NO_PROJECT ? "" : value)}
              >
                <SelectTrigger id="create-project" data-create-project className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value={NO_PROJECT}>No project</SelectItem>
                  {projects.map((row) => (
                    <SelectItem key={row.project.id} value={row.project.id}>
                      {row.project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="create-labels">Labels</Label>
            {/* The only field that can invent a value. Existing labels come from every
                workspace in scope — a label is a plain string, so reusing one another
                project already uses costs nothing and is usually the intent. */}
            <SearchableSelect
              id="create-labels"
              name="labels"
              options={labels}
              selected={form.labels}
              onChange={(next) => set("labels", next)}
              multiple
              placeholder="No labels"
              actionLabel="Add another label"
              searchPlaceholder="Search or create a label…"
              emptyText="no label matches"
              onCreate={splitLabels}
            />
          </div>

          <div className="grid items-start gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="create-blocked-by">Blocked by</Label>
              <SearchableSelect
                id="create-blocked-by"
                name="blocked-by"
                options={blockedByOptions}
                selected={form.blockedBy}
                onChange={(next) => set("blockedBy", next)}
                multiple
                placeholder="Nothing blocking this"
                actionLabel="Add another blocker"
                searchPlaceholder="Search tasks…"
                emptyText="no task matches"
                expandPaste={splitRefs}
                mono
                note={CROSS_WORKSPACE_NOTE}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="create-blocking">Blocking</Label>
              {/* The inverse relation. The store has no create-time input for it — the
                  server applies it after the insert by rewriting each target's
                  blocked-by set. See the `create` branch in src/ui/server.ts. */}
              <SearchableSelect
                id="create-blocking"
                name="blocking"
                options={blockingOptions}
                selected={form.blocking}
                onChange={(next) => set("blocking", next)}
                multiple
                placeholder="Blocking nothing"
                actionLabel="Add another"
                searchPlaceholder="Search tasks…"
                emptyText="no task matches"
                expandPaste={splitRefs}
                mono
                note={CROSS_WORKSPACE_NOTE}
              />
            </div>
          </div>

          {session.mode === "hub" && session.workspaces.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="create-workspace">Workspace</Label>
              <Select
                value={ws}
                onValueChange={(next) => {
                  setWs(next);
                  // The parent and the project go; the relations stay. R7 cleared the
                  // relations too, which was right while they were workspace-locked and
                  // is wrong now: a blocker chosen before the switch is still a real task,
                  // just a cross-workspace one. The parent and the project cannot survive —
                  // both are rows of the old workspace. See forWorkspaceSwitch().
                  setForm(forWorkspaceSwitch);
                }}
              >
                <SelectTrigger id="create-workspace" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {session.workspaces.map((workspace) => (
                    <SelectItem key={workspace.slug} value={workspace.slug}>
                      {workspace.slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {refusal ? (
            <div className="rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/5 p-3">
              <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} />
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" data-create-submit disabled={busy}>
              {busy ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
