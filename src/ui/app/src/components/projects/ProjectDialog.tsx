/**
 * The project dialog — create a project, or edit one. The foundation for a project's
 * settings: today it holds the name, the kind and the source; the next settings are
 * sections that slot into `projectFormSections` (see projectForm.ts).
 *
 * Two components, deliberately. `ProjectForm` is the whole surface and renders to a
 * string, so its markup is pinned in project-form.test.tsx; `ProjectDialog` is the Radix
 * shell around it, which a static render cannot see into (the content portals). The
 * mount owns the open flag; the form owns the draft; the store owns every rule — a
 * refusal renders the store's own sentence through `GuardRefusal`, never a paraphrase.
 *
 * REFETCH ON SUCCESS, not optimistic: `session.refresh()` bumps the version the rail and
 * the filter menu already refetch projects on, so what is listed a moment after a save
 * is what the store holds.
 */
import { Trash2 } from "lucide-react";
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
import { createProject, deleteProject, updateProject } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import type { ProjectDialogRequest } from "@/lib/shell-events";
import { PROJECT_KINDS, PROJECT_SOURCE_KINDS, type ProjectKind, type ProjectSourceKind } from "@/lib/types";
import { ConfirmDialog } from "@/settings/form/ConfirmDialog";
import {
  KIND_HINTS,
  KIND_LABELS,
  SOURCE_KIND_LABELS,
  SOURCE_PLACEHOLDERS,
  draftFromProject,
  emptyProjectDraft,
  isProjectDraftDirty,
  projectDraftPayload,
  projectFormCopy,
  projectFormSections,
  validateProjectDraft,
  withKind,
  withName,
  withSource,
  withSourceKind,
  type ProjectDraft,
  type ProjectFormMode,
} from "./projectForm";

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
      {children}
    </h3>
  );
}

function FieldError({ id, children }: { id: string; children: string | undefined }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-[12px] text-[var(--status-task-blocked)]">
      {children}
    </p>
  );
}

/**
 * The form. `onDone` is called after a successful create, save or delete; `onCancel`
 * when the user backs out. Errors show beside their field once a submit has been tried,
 * so a half-typed URL is not shouted at on the first keystroke.
 */
export function ProjectForm({
  mode,
  onDone,
  onCancel,
}: {
  mode: ProjectFormMode;
  onDone: () => void;
  onCancel: () => void;
}) {
  const session = useSession();
  const baseline = mode.mode === "edit" ? draftFromProject(mode.row.project) : emptyProjectDraft();
  const [draft, setDraft] = useState<ProjectDraft>(baseline);
  const [ws, setWs] = useState(mode.mode === "edit" ? mode.row.workspace : mode.workspace);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const copy = projectFormCopy(mode);
  const errors = tried ? validateProjectDraft(draft) : {};
  const dirty = mode.mode === "create" || isProjectDraftDirty(draft, baseline);
  // Only a create in hub mode, with more than one workspace, has to ask where.
  const askWorkspace = mode.mode === "create" && session.mode === "hub" && session.workspaces.length > 1;

  const submit = async () => {
    if (busy) return;
    setTried(true);
    if (Object.keys(validateProjectDraft(draft)).length > 0) return;
    setBusy(true);
    setRefusal(null);
    try {
      const payload = projectDraftPayload(draft);
      if (mode.mode === "create") await createProject({ ws: ws || undefined, ...payload });
      else await updateProject({ ws: mode.row.workspace, ref: mode.row.project.id, ...payload });
      session.refresh();
      onDone();
    } catch (caught) {
      setRefusal(describeRefusal(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (mode.mode !== "edit" || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await deleteProject({ ws: mode.row.workspace, ref: mode.row.project.id });
      session.refresh();
      onDone();
    } catch (caught) {
      setRefusal(describeRefusal(caught));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <form
      data-project-form={mode.mode}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {projectFormSections(draft).map((section) => (
        <section key={section.id} data-project-section={section.id} className="grid gap-3">
          <SectionTitle>{section.title}</SectionTitle>

          {section.id === "general" ? (
            <>
              {askWorkspace ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="project-workspace">Workspace</Label>
                  <Select value={ws} onValueChange={setWs}>
                    <SelectTrigger id="project-workspace" data-project-workspace className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      {session.workspaces.map((workspace) => (
                        <SelectItem key={workspace.slug} value={workspace.slug}>
                          {workspace.slug}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="grid gap-1.5">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  id="project-name"
                  data-project-name
                  autoFocus
                  value={draft.name}
                  placeholder="What is this project called?"
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={errors.name ? "project-name-error" : undefined}
                  onChange={(event) => setDraft(withName(draft, event.target.value))}
                />
                <FieldError id="project-name-error">{errors.name}</FieldError>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="project-kind">Kind</Label>
                <Select value={draft.kind} onValueChange={(value) => setDraft(withKind(draft, value as ProjectKind))}>
                  <SelectTrigger id="project-kind" data-project-kind className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {PROJECT_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[12px] text-muted-foreground">{KIND_HINTS[draft.kind]}</p>
              </div>
            </>
          ) : null}

          {section.id === "source" && draft.kind === "managed" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="project-source-kind">Source kind</Label>
                <Select
                  value={draft.sourceKind}
                  onValueChange={(value) => setDraft(withSourceKind(draft, value as ProjectSourceKind))}
                >
                  <SelectTrigger id="project-source-kind" data-project-source-kind className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {PROJECT_SOURCE_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {SOURCE_KIND_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="project-source">
                  {draft.sourceKind === "github" ? "Repository URL" : "Folder path"}
                </Label>
                <Input
                  id="project-source"
                  data-project-source
                  value={draft.source}
                  placeholder={SOURCE_PLACEHOLDERS[draft.sourceKind]}
                  spellCheck={false}
                  className="font-mono text-[13px]"
                  aria-invalid={errors.source ? true : undefined}
                  aria-describedby={errors.source ? "project-source-error" : undefined}
                  onChange={(event) => setDraft(withSource(draft, event.target.value))}
                />
                <FieldError id="project-source-error">{errors.source}</FieldError>
              </div>
            </>
          ) : null}
        </section>
      ))}

      {refusal ? <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} /> : null}

      <DialogFooter className="items-center sm:justify-between">
        {mode.mode === "edit" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-project-delete
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            className="text-[var(--status-task-blocked)] hover:text-[var(--status-task-blocked)]"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Delete project
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" data-project-submit disabled={busy || !dirty}>
            {copy.submit}
          </Button>
        </div>
      </DialogFooter>

      {mode.mode === "edit" ? (
        <ConfirmDialog
          open={confirmingDelete}
          title={`Delete ${mode.row.project.name}?`}
          description="Its issues stay exactly as they are; they are simply no longer filed under this project."
          confirmLabel="Delete project"
          destructive
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </form>
  );
}

export function ProjectDialog({
  request,
  onOpenChange,
}: {
  request: ProjectDialogRequest;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  const mode: ProjectFormMode =
    request.mode === "edit"
      ? { mode: "edit", row: request.row }
      : { mode: "create", workspace: request.workspace || session.ws || session.workspaces[0]?.slug || "" };
  const copy = projectFormCopy(mode);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-project-dialog className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <ProjectForm mode={mode} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
