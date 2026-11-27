/**
 * The Plan files tray: the plan files under the workspace root (Markdown in the root and
 * everything under plans/, or the paths the person set), each new, changed since its import,
 * imported or ignored, by path and content hash. The person imports one (Import), several
 * (Import selected) or ignores one (Ignore), and can change where it looks. Nothing is imported
 * until the person presses Import: opening the tray reads the files and writes nothing.
 */
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getPlanFiles, planFilesWrite, putSettings } from "@/lib/api";
import type { PlanData, PlanFileData, PlanFileIdea, PlanFilesData, PlanFileState } from "@/lib/plan-types";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { cn } from "@/lib/utils";

/** The tray's groups, in the order a person works them. */
export const FILE_GROUPS: ReadonlyArray<{ state: PlanFileState; label: string }> = [
  { state: "new", label: "New" },
  { state: "changed", label: "Changed since import" },
  { state: "imported", label: "Imported" },
  { state: "ignored", label: "Ignored" },
];

/** Whether a row can be picked for Import selected: new or changed, with nothing in the way. */
export const importable = (file: PlanFileData) => (file.state === "new" || file.state === "changed") && file.problem === null;

/** What Select all picks: every importable row except plans that read as done. */
export const selectAllOf = (files: readonly PlanFileData[]) => files.filter((file) => importable(file) && !file.done).map((file) => file.path);

/** The paths as the editor shows them, one per line, and back. */
export const pathsText = (paths: readonly string[]) => paths.join("\n");
export const textPaths = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

/** How a row names an idea: its ticket number once promoted, else its idea number. */
const ideaName = (idea: PlanFileIdea) => idea.identifier ?? idea.number ?? idea.title;

/** The tray's button on the Import form: opens the dialog. */
export function PlanFilesButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="h-9 justify-start" onClick={onOpen} data-plan-files-open>
      <FolderOpen aria-hidden />
      Plan files in this workspace…
    </Button>
  );
}

/**
 * The dialog. `onWritten` hands the plan an import or ignore answered back to the view, and
 * `onOpenIdea` opens an imported file's idea in the drawer.
 */
export function PlanFilesDialog({
  ws,
  actor,
  open,
  onOpenChange,
  onWritten,
  onOpenIdea,
}: {
  ws: string | undefined;
  actor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWritten: (plan: PlanData) => void;
  onOpenIdea: (id: string) => void;
}) {
  const [view, setView] = useState<PlanFilesData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setRefusal(null);
    try {
      setView(await getPlanFiles({ ws }));
    } catch (error) {
      setRefusal(describeRefusal(error));
    }
  }, [ws]);

  // A fresh read on every opening: the files may have changed on disk since.
  useEffect(() => {
    if (!open) return;
    setView(null);
    setSelected(new Set());
    setImported(null);
    setEditing(null);
    setShowDone({});
    void load();
  }, [open, load]);

  const write = async (verb: "files-import" | "files-ignore", body: Record<string, unknown>) => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await planFilesWrite(verb, { ws, actor, ...body });
      setView(result.files);
      setSelected((current) => new Set([...current].filter((path) => result.files.files.some((file) => file.path === path && importable(file)))));
      if (result.imported) setImported(result.imported.length);
      onWritten(result.plan);
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(false);
    }
  };
  const importPaths = (paths: string[]) => void write("files-import", { paths });
  const ignore = (path: string, ignored: boolean) => void write("files-ignore", { path, ignored });

  const savePaths = async () => {
    if (editing === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      const paths = textPaths(editing);
      await putSettings("settings", [{ op: "set", key: "plan.discoveryPaths", value: paths }], { ws, actor });
      setEditing(null);
      await load();
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const all = view ? selectAllOf(view.files) : [];
  const allPicked = all.length > 0 && all.every((path) => selected.has(path));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] flex-col gap-3 sm:max-w-none" data-plan-files>
        <div className="flex flex-col gap-1 pr-10">
          <DialogTitle>Plan files</DialogTitle>
          <DialogDescription>Plans already written in this workspace. Import one or several as ideas, each with its file under Files. Nothing is imported until you choose.</DialogDescription>
        </div>
        {view && view.unavailable === null ? (
          editing === null ? (
            <p className="m-0 text-label text-text-secondary" data-plan-files-paths>
              Looking in <span className="font-mono text-foreground">{view.paths.join(", ") || "nowhere"}</span>{" "}
              <button type="button" className="focus-ring rounded-sm font-medium text-foreground underline underline-offset-2" onClick={() => setEditing(pathsText(view.paths))} data-plan-files-paths-edit>
                Change
              </button>
            </p>
          ) : (
            <div className="flex flex-col gap-2" data-plan-files-paths-editor>
              <label className="text-label font-medium text-text-secondary" htmlFor="plan-files-paths">
                Paths from the workspace root, one per line. * matches within a folder name, ** any depth; case does not matter. Shared with every device.
              </label>
              <Textarea id="plan-files-paths" value={editing} onChange={(event) => setEditing(event.target.value)} rows={4} className="font-mono text-label" />
              <div className="flex gap-2">
                <Button type="button" size="sm" className="h-9" disabled={busy} onClick={() => void savePaths()} data-plan-files-paths-save>
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )
        ) : null}
        {refusal ? <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} /> : null}
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-y px-6 py-2" data-plan-files-list>
          {view === null ? (
            <p className="m-0 py-6 text-center text-label text-text-secondary">{refusal ? "The plan files could not be read." : "Looking for plan files…"}</p>
          ) : view.unavailable !== null ? (
            <p className="m-0 py-6 text-center text-label text-text-secondary" data-plan-files-unavailable>{view.unavailable}</p>
          ) : view.files.length === 0 ? (
            <p className="m-0 py-6 text-center text-label text-text-secondary" data-plan-files-empty>No plan files found where it looks.</p>
          ) : (
            FILE_GROUPS.map(({ state, label }) => {
              const files = view.files.filter((file) => file.state === state);
              if (files.length === 0) return null;
              // Imported and ignored files are context, not work: their groups start folded.
              const quiet = state === "imported" || state === "ignored";
              const shown = !quiet || showDone[state] === true;
              return (
                <section key={state} className="py-2" data-plan-files-group={state}>
                  <h3 className="m-0 flex items-center gap-2 py-1 text-label font-medium text-text-secondary">
                    {quiet ? (
                      <button type="button" className="focus-ring rounded-sm hover:text-foreground" aria-expanded={shown} onClick={() => setShowDone((current) => ({ ...current, [state]: !shown }))} data-plan-files-group-toggle={state}>
                        {label} <span className="tabular-nums">{files.length}</span> {shown ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span>
                        {label} <span className="tabular-nums">{files.length}</span>
                      </span>
                    )}
                  </h3>
                  {shown ? (
                    <ul className="m-0 flex list-none flex-col p-0">
                      {files.map((file) => (
                        <PlanFileRow
                          key={file.path}
                          file={file}
                          picked={selected.has(file.path)}
                          busy={busy}
                          onPick={() => toggle(file.path)}
                          onImport={() => importPaths([file.path])}
                          onIgnore={(ignored) => ignore(file.path, ignored)}
                          onOpenIdea={(id) => {
                            onOpenChange(false);
                            onOpenIdea(id);
                          }}
                        />
                      ))}
                    </ul>
                  ) : null}
                </section>
              );
            })
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" className="h-9" disabled={busy || selected.size === 0} aria-busy={busy || undefined} onClick={() => importPaths([...selected])} data-plan-files-import-selected>
            {busy ? "Working…" : `Import selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-9" disabled={busy || all.length === 0} onClick={() => setSelected(allPicked ? new Set() : new Set(all))} data-plan-files-select-all>
            {allPicked ? "Select none" : "Select all"}
          </Button>
          <span className="ml-auto text-label text-text-tertiary" role="status" data-plan-files-summary>
            {imported !== null ? `Imported ${imported}.` : view?.truncated ? "Cut short: narrow the paths to see the rest." : view && view.files.some((file) => file.done && importable(file)) ? "Plans that read as done are left out of Select all." : ""}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PlanFileRow({
  file,
  picked,
  busy,
  onPick,
  onImport,
  onIgnore,
  onOpenIdea,
}: {
  file: PlanFileData;
  picked: boolean;
  busy: boolean;
  onPick: () => void;
  onImport: () => void;
  onIgnore: (ignored: boolean) => void;
  onOpenIdea: (id: string) => void;
}) {
  const canPick = importable(file);
  // One id per row, whatever its path or content: two rows with the same content must not share a label.
  const id = useId();
  const notes = [
    file.kind === "folder" ? `folder · ${file.files.length} files` : null,
    file.done ? `done${file.status ? ` (${file.status})` : ""}` : file.status,
  ].filter((note): note is string => note !== null);
  return (
    <li className={cn("flex items-start gap-3 rounded-md px-2 py-2 hover:bg-surface-hover max-sm:flex-wrap", picked && "bg-surface-hover")} data-plan-file={file.path} data-plan-file-state={file.state}>
      {file.state === "new" || file.state === "changed" ? (
        <input
          id={id}
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={picked}
          disabled={!canPick || busy}
          onChange={onPick}
          aria-label={`Select ${file.path}`}
          data-plan-file-pick
        />
      ) : (
        <span aria-hidden className="mt-1 size-4 shrink-0" />
      )}
      <label htmlFor={canPick ? id : undefined} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-foreground">{file.title}</span>
        <span className="truncate font-mono text-label text-text-tertiary" title={file.path}>
          {file.path}
        </span>
        {notes.length > 0 || file.problem || file.idea ? (
          <span className="flex flex-wrap gap-x-1.5 text-label text-text-secondary">
            {notes.map((note, index) => (
              <span key={note} className="whitespace-nowrap" data-plan-file-note>
                {index > 0 ? <span aria-hidden className="mr-1.5">·</span> : null}
                {note}
              </span>
            ))}
            {file.problem ? <span className="text-destructive" data-plan-file-problem>Cannot import: {file.problem}</span> : null}
            {file.idea ? (
              <span className="whitespace-nowrap">
                {notes.length > 0 ? <span aria-hidden className="mr-1.5">·</span> : null}
                {file.changedSinceImport ? "changed since imported as " : "imported as "}
                <button type="button" className="focus-ring rounded-sm font-medium text-foreground underline underline-offset-2" onClick={() => onOpenIdea(file.idea!.id)} data-plan-file-idea>
                  {ideaName(file.idea)}
                </button>
              </span>
            ) : null}
            {file.alsoImportedAs.length > 0 ? (
              // The same file imported twice, as two devices can offline: both ideas are named.
              <span className="whitespace-nowrap" data-plan-file-also>
                <span aria-hidden className="mr-1.5">·</span>
                also as{" "}
                {file.alsoImportedAs.map((idea, index) => (
                  <span key={idea.id}>
                    {index > 0 ? ", " : null}
                    <button type="button" className="focus-ring rounded-sm font-medium text-foreground underline underline-offset-2" onClick={() => onOpenIdea(idea.id)}>
                      {ideaName(idea)}
                    </button>
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        ) : null}
      </label>
      {/* On a phone the actions take their own line under the name, so the name is not squeezed. An imported row has none. */}
      {file.state === "imported" ? null : (
        <span className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:pl-7">
          {file.state === "ignored" ? (
            <Button type="button" size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => onIgnore(false)} data-plan-file-unignore>
              Unignore
            </Button>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={!canPick || busy} onClick={onImport} data-plan-file-import>
                {file.state === "changed" ? "Import again" : "Import"}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => onIgnore(true)} data-plan-file-ignore>
                Ignore
              </Button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
