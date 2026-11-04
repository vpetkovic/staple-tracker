/**
 * The instructions a ticket is worked under (`core/instructions.ts`): its own instruction
 * documents, then its parents', then its milestone's, nearest first. On a milestone or an
 * epic the list is what it hands down; on a child ticket, what it inherits and from where.
 *
 * Every agent that takes the ticket receives exactly this list (get_task, checkout, the run's
 * take), so a person reading the ticket sees the rules the agent was given, with the source of
 * each. A run's own instructions are not here: a run is machine-local and the detail is not
 * read for one.
 */
import { ScrollText } from "lucide-react";
import { useSession } from "@/lib/session";
import { Markdown } from "@/lib/markdown";
import type { InstructionSource, ResolvedInstruction } from "@/lib/types";
import { cn } from "./parts/cn";
import { DetailCard, RelativeTime, SectionHeading } from "./parts";
import { openDetailTab } from "./tabs/registry";

/** Where an instruction comes from, in words: "This ticket", "Parent", "Milestone", "Run". */
export function sourceLabel(source: InstructionSource, kind: string): string {
  switch (source.kind) {
    case "self":
      return kind === "epic" || kind === "milestone" ? `This ${kind}` : "This ticket";
    case "parent":
      return "Parent";
    case "milestone":
      return "Milestone";
    case "run":
      return "Run";
  }
}

/**
 * Where it comes from, as text. Inside `<summary>`, which is itself the toggle: a control
 * nested in it would be an interactive element inside an interactive element. The link that
 * opens the source sits in the body instead (`SourceLink`).
 */
function SourceText({ source, kind }: { source: InstructionSource; kind: string }) {
  const label = sourceLabel(source, kind);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-label text-text-secondary" title={source.title && source.ref ? `${source.ref} · ${source.title}` : undefined}>
      <span>{label}</span>
      {source.kind !== "self" && source.ref ? <span className="font-medium">{source.ref}</span> : null}
      {source.kind !== "self" && source.title ? <span className="min-w-0 truncate max-sm:hidden">{source.title}</span> : null}
    </span>
  );
}

function SourceLink({ source, workspace, onOpen }: { source: InstructionSource; workspace: string; onOpen: (workspace: string, ref: string) => void }) {
  if (source.kind === "self" || source.kind === "run" || source.ref === null) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(workspace, source.ref!)}
      className="focus-ring mt-2 rounded text-label text-text-secondary underline-offset-2 hover:text-foreground hover:underline pointer-coarse:min-h-10"
      data-instruction-source={source.ref}
    >
      Open {source.ref}
    </button>
  );
}

export function InstructionsSection({
  instructions,
  issueKind,
  issueRef,
  workspace,
}: {
  instructions: readonly ResolvedInstruction[];
  issueKind: string;
  issueRef: string;
  workspace: string;
}) {
  const session = useSession();
  if (instructions.length === 0) return null;
  const own = instructions.filter((entry) => entry.source.kind === "self");
  const inherited = instructions.length - own.length;
  const caption =
    own.length > 0 && inherited === 0
      ? `Handed to every agent that works this ${issueKind === "milestone" || issueKind === "epic" ? `${issueKind} or anything inside it` : "ticket"}.`
      : "Every agent that works this ticket is given these, nearest first. Where two set the same key, the nearer one is in effect.";
  return (
    <section aria-label="Instructions" className="mt-8" data-instructions="">
      <SectionHeading action={<span className="text-text-tertiary">{instructions.length}</span>}>Instructions</SectionHeading>
      <p className="m-0 mb-2 text-label text-text-secondary">{caption}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {instructions.map((entry) => (
          <li key={`${entry.source.kind}:${entry.source.issueId ?? entry.source.runId}:${entry.key}`} data-instruction={entry.key} data-effective={entry.effective ? "true" : "false"}>
            <DetailCard className={cn("flex flex-col gap-2", !entry.effective && "opacity-70")}>
              <details open={entry.effective && instructions.length <= 3} className="group">
                <summary className="focus-ring flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 rounded pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden">
                  <ScrollText aria-hidden className="size-3.5 shrink-0 text-text-secondary" />
                  <span className="text-body font-medium text-foreground">{entry.title ?? entry.key}</span>
                  <span aria-hidden className="text-text-tertiary">
                    ·
                  </span>
                  <SourceText source={entry.source} kind={issueKind} />
                  <span className="ml-auto flex items-center gap-2 text-label text-text-tertiary">
                    {entry.updatedAt ? <RelativeTime iso={entry.updatedAt} inSentence /> : null}
                    {entry.revision !== null ? <span title={`Revision ${entry.revision}`}>Version {entry.revision}</span> : null}
                  </span>
                </summary>
                {!entry.effective && entry.shadowedBy ? (
                  <p className="m-0 mt-2 text-label text-text-secondary" data-instruction-shadowed="">
                    Not in effect: {sourceLabel(entry.shadowedBy, issueKind).toLowerCase()}
                    {entry.shadowedBy.ref ? ` ${entry.shadowedBy.ref}` : ""} sets "{entry.key}" too, and the nearer one wins.
                  </p>
                ) : null}
                <div className="mt-2 min-w-0 wrap-anywhere">
                  <Markdown text={entry.body} className="staple-detail-prose" />
                </div>
                <SourceLink source={entry.source} workspace={workspace} onOpen={session.open} />
                {entry.source.kind === "self" ? (
                  <button
                    type="button"
                    onClick={() => openDetailTab("documents", entry.key, issueRef)}
                    className="focus-ring mt-2 rounded text-label text-text-secondary underline-offset-2 hover:text-foreground hover:underline pointer-coarse:min-h-10"
                  >
                    Open in Documents
                  </button>
                ) : null}
              </details>
            </DetailCard>
          </li>
        ))}
      </ul>
    </section>
  );
}
