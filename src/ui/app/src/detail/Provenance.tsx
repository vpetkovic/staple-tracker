/**
 * Where a record came from (core/plan-provenance.ts): the "from I-STA-n · row K" chip on a ticket
 * Scaffold made, opening its idea in Plan; the ticket whose work sparked an idea; and the ideas a
 * ticket's work sparked. The server sends none of it while planning is off.
 */
import { ArrowUpRight, Sparkles } from "lucide-react";
import { StatusIcon } from "@/components/task-list";
import { parentUnsettledWords, scaffoldedFromWords, sparkedIdeaWords } from "../../../../core/plan-provenance-words";
import { useOptionalSession } from "@/lib/session";
import { statusLabel } from "@/lib/settings";
import type { IssueDetail, IssueRef, ScaffoldedFromRef, SparkedIdeaRef } from "@/lib/types";
import { cn } from "./parts/cn";
import { SectionHeading } from "./parts";
import { ideaPlanHref } from "./PlannedIdeaLinks";

const CHIP = "focus-ring inline-flex min-h-7 max-w-full min-w-0 items-center gap-1.5 rounded-[6px] border border-border bg-card px-2 py-[3px] text-label text-text-secondary hover:bg-surface-hover hover:text-foreground pointer-coarse:min-h-11";


/** The chip on a scaffolded ticket: the idea and row it came from, opening the idea in Plan. */
export function ScaffoldedFromChip({ workspace, from }: { workspace: string; from: ScaffoldedFromRef }) {
  return (
    <a
      href={ideaPlanHref(workspace, from.ideaId)}
      data-scaffolded-from={from.ideaNumber ?? from.ideaId}
      title={`Scaffolded from ${from.title}${from.rowKey === null ? "" : `, breakdown row ${from.rowKey}`}. Open the idea in Plan`}
      className={CHIP}
    >
      <span aria-hidden>◇</span>
      <span className="min-w-0 truncate">{scaffoldedFromWords(from)}</span>
      <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
    </a>
  );
}

/** The ticket whose work sparked this idea, opening it. */
export function SparkedByChip({ sparkedBy, onOpen }: { sparkedBy: IssueRef; onOpen: (identifier: string) => void }) {
  return (
    <button
      type="button"
      data-sparked-by={sparkedBy.identifier}
      title={`Sparked by ${sparkedBy.identifier} · ${sparkedBy.title} (${statusLabel(sparkedBy.status)})`}
      onClick={() => onOpen(sparkedBy.identifier)}
      className={CHIP}
    >
      <Sparkles aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">sparked by</span>
      <StatusIcon status={sparkedBy.status} className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground">{sparkedBy.identifier}</span>
    </button>
  );
}

/** The provenance chips a record carries, in one wrapping row; nothing when it has none. */
export function ProvenanceChips({ detail, className }: { detail: IssueDetail; className?: string }) {
  const session = useOptionalSession();
  const from = detail.scaffoldedFrom ?? null;
  const sparkedBy = detail.sparkedBy ?? null;
  if (from === null && sparkedBy === null) return null;
  const onOpen = (identifier: string) => session?.open(detail.workspace, identifier);
  const unsettled = from?.parentUnsettled ?? null;
  return (
    <div data-provenance="" className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {from ? <ScaffoldedFromChip workspace={detail.workspace} from={from} /> : null}
      {sparkedBy ? <SparkedByChip sparkedBy={sparkedBy} onOpen={onOpen} /> : null}
      {unsettled ? (
        // Flagged, never cancelled: an idea above the one it came from went back to exploring or was dropped.
        <span data-parent-unsettled={unsettled.maturity} className="basis-full text-label text-flag-todo">
          Flagged: {parentUnsettledWords(unsettled)} since this was scaffolded. Nothing was cancelled.
        </span>
      ) : null}
    </div>
  );
}

/** A sparked idea's reference on the page: its idea number, with its ticket number once it is an epic (its maturity is a column of its own). */
function sparkedRef(idea: SparkedIdeaRef): string {
  return idea.identifier === null ? (idea.ideaNumber ?? "Idea") : sparkedIdeaWords(idea);
}

/** The ideas a ticket's work sparked, each opening in Plan. */
export function SparkedIdeas({ workspace, ideas }: { workspace: string; ideas: readonly SparkedIdeaRef[] }) {
  if (ideas.length === 0) return null;
  return (
    <section aria-label="Sparked ideas" data-sparked-ideas="" className="mt-8">
      <SectionHeading action={<span className="text-text-tertiary">{ideas.length}</span>}>Sparked ideas</SectionHeading>
      <ul className="-mx-2 m-0 flex list-none flex-col gap-0.5 p-0">
        {ideas.map((idea) => (
          <li key={idea.id}>
            <a
              href={ideaPlanHref(workspace, idea.id)}
              data-sparked-idea={idea.ideaNumber ?? idea.id}
              title={`${sparkedRef(idea)} · open it in Plan`}
              className="focus-ring group flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-surface-hover pointer-coarse:min-h-11"
            >
              <span aria-hidden className="w-4 shrink-0 text-center text-text-secondary">◇</span>
              <span className="min-w-0 flex-1 truncate text-body text-foreground">{idea.title}</span>
              {idea.maturity && idea.identifier === null ? <span className="shrink-0 text-label text-text-secondary">{idea.maturity}</span> : null}
              <span className="shrink-0 text-label text-text-tertiary">{sparkedRef(idea)}</span>
              <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
