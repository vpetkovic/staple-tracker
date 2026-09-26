/**
 * "Choose a workspace" — what a per-workspace page shows in All workspaces mode instead of
 * quietly reading the first one. See workspace-scope.ts for why these pages cannot
 * aggregate.
 *
 * Built from the plain-language card the Budget and Estimate accuracy pages use: a plain
 * sentence saying what this is and what to do, the answer one tap away, and the why behind
 * "What does this mean?". Picking a workspace here is `session.setWs`, the same call the
 * switcher makes, so the rest of the app follows. The choice is also remembered as the
 * default "which workspace?" answer that Create task and Settings offer.
 */
import { ChevronRight } from "lucide-react";
import { PlainCard } from "@/components/plain/PlainCard";
import { rememberWorkspace } from "@/lib/session-workspace";
import type { WorkspaceRef } from "@/lib/types";

export function ChooseWorkspace({
  page,
  sentence,
  workspaces,
  onChoose,
}: {
  /** The page's own name, for the card's accessible label. */
  page: string;
  sentence: string;
  workspaces: readonly WorkspaceRef[];
  onChoose: (slug: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto" data-choose-workspace={page}>
      <div className="mx-auto max-w-2xl px-4 py-5">
        <PlainCard
          title="Choose a workspace"
          headline={sentence}
          headlineTestId="choose-workspace-sentence"
          help={
            <>
              You are looking at all workspaces. Tasks and Graph can show every workspace at
              once, but this page is about one workspace at a time. Choosing one here does the
              same as choosing it in the workspace switcher.
            </>
          }
        >
          <ul className="grid gap-2 sm:grid-cols-2" aria-label="Workspaces">
            {workspaces.map((workspace) => (
              <li key={workspace.slug} className="min-w-0">
                <button
                  type="button"
                  data-choose-workspace-option={workspace.slug}
                  onClick={() => {
                    rememberWorkspace(workspace.slug);
                    onChoose(workspace.slug);
                  }}
                  className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{workspace.slug}</span>
                  <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{workspace.prefix}</span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" />
                </button>
              </li>
            ))}
          </ul>
        </PlainCard>
      </div>
    </div>
  );
}
