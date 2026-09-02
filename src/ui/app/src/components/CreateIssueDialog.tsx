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
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { ISSUE_PRIORITIES, type Issue, type IssuePriority, type IssueRow } from "@/lib/types";
import {
  EMPTY_CREATE_FORM,
  buildCreatePayload,
  issueOptions,
  labelOptions,
  withoutValues,
  splitLabels,
  splitRefs,
  type CreateFormState,
} from "./createIssueForm";

/**
 * Shown inside each relation dropdown, where the restriction is actually relevant —
 * see `note` on SearchableSelect for why it is not three lines under three fields.
 */
const SAME_WORKSPACE_NOTE = "Refs resolve inside one workspace.";

export function CreateIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const [form, setForm] = useState<CreateFormState>(EMPTY_CREATE_FORM);
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

  const close = () => {
    setForm(EMPTY_CREATE_FORM);
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

  const issues = issueOptions(rows, ws);
  const labels = labelOptions(rows);
  // Neither relation may offer what the other already holds: the same ref on both
  // sides is a two-node cycle, and the store can only refuse it once the task exists.
  // See withoutValues() — the deeper cycles are still the store's to catch.
  const blockedByOptions = withoutValues(issues, form.blocking);
  const blockingOptions = withoutValues(issues, form.blockedBy);

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

            <div className="grid gap-1.5">
              <Label htmlFor="create-parent">Parent</Label>
              {/* Single-select: a task has one parent, and the store enforces a depth
                  cap on it. Selecting replaces rather than appends. */}
              <SearchableSelect
                id="create-parent"
                name="parent"
                options={issues}
                selected={form.parent ? [form.parent] : []}
                onChange={(next) => set("parent", next[0] ?? "")}
                placeholder="No parent"
                actionLabel="Change parent"
                searchPlaceholder="Search tasks…"
                emptyText="no task matches"
                mono
                note={SAME_WORKSPACE_NOTE}
              />
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
                note={SAME_WORKSPACE_NOTE}
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
                note={SAME_WORKSPACE_NOTE}
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
                  // Every ref in the form named a task in the OLD workspace, and none
                  // of them can resolve in the new one. Dropping them is the honest
                  // move: carrying them over would send refs the store will refuse,
                  // and greying them out would leave a chip that means nothing.
                  setForm((current) => ({ ...current, parent: "", blockedBy: [], blocking: [] }));
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
