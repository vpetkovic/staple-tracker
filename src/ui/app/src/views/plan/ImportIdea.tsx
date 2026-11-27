/**
 * Import on the Plan toolbar: the person picks a .md, .html or .jsx file and, if they want, the
 * stage it starts at. The server makes it an idea (Markdown maps to its sections), keeps the
 * original under the idea's Files, and with no stage chosen leaves it raw for an agent to
 * classify: read the file, fill the plan and set or propose its stage. Nothing is imported until
 * the person presses Import.
 */
import { FileUp } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** What the file picker offers, as the server takes them. */
export const IMPORT_ACCEPT = ".md,.markdown,.html,.htm,.jsx";

/** The stage an import starts at: left to an agent, or the person's own pick. */
export const IMPORT_STAGES = [
  { id: "classify", label: "Let an agent classify it", hint: "Raw for now; an agent reads the file and fills the plan" },
  { id: "raw", label: "Raw", hint: "Captured for discussion" },
  { id: "exploring", label: "Exploring", hint: "Being worked until every section is shaped" },
  { id: "shaped", label: "Shaped", hint: "Settled: needs a plan that passes the shaped gate" },
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number]["id"];

/** The file's bytes as base64, the way the import route takes them. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The import route's body for one file and the stage picked: no maturity when it is left to an agent. */
export async function importBody(file: File, stage: ImportStage): Promise<Record<string, unknown>> {
  return { filename: file.name, contentBase64: await fileBase64(file), ...(stage === "classify" ? {} : { maturity: stage }) };
}

export function ImportIdea({ onImport, onViewIdeas }: { onImport: (body: Record<string, unknown>) => Promise<boolean>; onViewIdeas: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<ImportStage>("classify");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reset = () => {
    setFile(null);
    setStage("classify");
    if (picker.current) picker.current.value = "";
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null || busy) return;
    setBusy(true);
    const ok = await onImport(await importBody(file, stage));
    setBusy(false);
    if (ok) {
      setImported(file.name);
      reset();
    } else {
      // The refusal is shown under the toolbar, where the popover would cover it.
      setOpen(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setImported(null);
      }}
    >
      <PopoverTrigger asChild>
        {/* Icon-only under 900px, where the bar has no room for the word. */}
        <Button
          variant="outline"
          size="sm"
          className="relative h-8 @max-[900px]/plan:w-8 @max-[900px]/plan:px-0 @max-[620px]/plan:min-h-0 @max-[620px]/plan:before:absolute @max-[620px]/plan:before:-inset-1 @max-[620px]/plan:before:content-['']"
          aria-label="Import an idea from a file"
          data-plan-import-open
        >
          <FileUp aria-hidden />
          <span className="@max-[900px]/plan:hidden">Import</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        <form onSubmit={submit} className="flex flex-col gap-3" data-plan-import>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-body font-medium text-foreground">Import an idea from a file</p>
            <p className="m-0 text-label text-text-secondary">A plan in Markdown, or a chat export or design as HTML or JSX. The file is kept under the idea's Files.</p>
          </div>
          <input
            ref={picker}
            type="file"
            accept={IMPORT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            data-plan-import-file
          />
          <Button type="button" variant="outline" size="sm" className="h-9 justify-start truncate" onClick={() => picker.current?.click()} data-plan-import-choose>
            <FileUp aria-hidden />
            <span className="truncate">{file ? file.name : "Choose a .md, .html or .jsx file"}</span>
          </Button>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 p-0 text-label font-medium text-text-secondary">Starts as</legend>
            {IMPORT_STAGES.map((option) => (
              <label
                key={option.id}
                className={cn("flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover", stage === option.id && "bg-surface-hover")}
                data-plan-import-stage={option.id}
              >
                <input type="radio" name="import-stage" value={option.id} checked={stage === option.id} onChange={() => setStage(option.id)} className="mt-0.5 accent-primary" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body text-foreground">{option.label}</span>
                  <span className="text-label text-text-tertiary">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button type="submit" size="sm" className="h-9" disabled={file === null || busy} aria-busy={busy || undefined} data-plan-import-submit>
            {busy ? "Importing…" : "Import"}
          </Button>
          {imported ? (
            <p role="status" className="m-0 text-label text-text-secondary" data-plan-imported>
              Imported {imported}.{" "}
              <button
                type="button"
                className="focus-ring rounded-sm font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setOpen(false);
                  onViewIdeas();
                }}
                data-plan-imported-view
              >
                View
              </button>
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
