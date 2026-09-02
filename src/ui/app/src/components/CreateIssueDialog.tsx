/**
 * The create form — owned by U5.
 *
 * Two decisions worth stating, because both look like omissions:
 *
 *  1. NOTHING is validated here. The submit button is live even with an empty title,
 *     so `store.createIssue` gets to throw "Title is required" and the user reads the
 *     store's sentence. A disabled button would hide a rule that lives in the store
 *     behind a rule that lives in this file, and the two could drift.
 *  2. It is a plain Dialog with plain inputs. cmdk is not involved, so the vendored
 *     command.tsx's missing `shouldFilter` forwarding is not in the way, and nothing
 *     under components/ui/ had to be touched.
 *
 * Refusals render through describeRefusal() + GuardRefusal, which live in lib/ and
 * components/ since V2 (STA-87) retired the board they used to sit behind. Imported,
 * never copied: a second refusal renderer is a second chance to paraphrase a guard.
 */
import { useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { action } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { ISSUE_PRIORITIES, type Issue, type IssuePriority } from "@/lib/types";
import { EMPTY_CREATE_FORM, buildCreatePayload, type CreateFormState } from "./createIssueForm";

export function CreateIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const [form, setForm] = useState<CreateFormState>(EMPTY_CREATE_FORM);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  // In hub mode "" means "every workspace", which is not a thing you can create into.
  // Fall back to the first one so the select always has a real target.
  const [ws, setWs] = useState(session.ws || session.workspaces[0]?.slug || "");

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

          <div className="grid gap-3 sm:grid-cols-2">
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
              <Input
                id="create-parent"
                data-create-parent
                value={form.parent}
                placeholder="STA-12"
                className="font-mono"
                onChange={(event) => set("parent", event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="create-labels">Labels</Label>
              <Input
                id="create-labels"
                data-create-labels
                value={form.labels}
                placeholder="ui, needs review"
                onChange={(event) => set("labels", event.target.value)}
              />
              {/* Commas only, because a label may contain spaces. Said out loud so
                  nobody has to discover it by losing half a label. */}
              <p className="text-[11px] text-muted-foreground">Separated by commas.</p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="create-blocked-by">Blocked by</Label>
              <Input
                id="create-blocked-by"
                data-create-blocked-by
                value={form.blockedBy}
                placeholder="STA-13, STA-9"
                className="font-mono"
                onChange={(event) => set("blockedBy", event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">Refs, separated by commas or spaces.</p>
            </div>
          </div>

          {session.mode === "hub" && session.workspaces.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="create-workspace">Workspace</Label>
              <Select value={ws} onValueChange={setWs}>
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
