/**
 * "Which workspace?" — what a per-workspace section shows when Settings was opened from All
 * workspaces and no workspace has been chosen yet. It asks, in a sentence, with one large
 * button per workspace, rather than quietly editing the first one.
 */
import { ChevronRight } from "lucide-react";
import type { WorkspaceRef } from "@/lib/types";

export function WorkspaceChooser({
  section,
  workspaces,
  onChoose,
}: {
  /** The section's name, for the sentence: "Statuses are set for each workspace…". */
  section: string;
  workspaces: readonly WorkspaceRef[];
  onChoose: (slug: string) => void;
}) {
  return (
    <div data-settings-choose-workspace className="flex max-w-lg flex-col gap-3 rounded-xl border bg-card p-4">
      <h4 className="text-[12px] font-medium text-muted-foreground">Which workspace?</h4>
      <p className="text-[14px] leading-relaxed text-pretty">
        {section} can be different in each workspace. Choose the workspace you want to change — you can switch at any
        time with the picker above, without leaving Settings.
      </p>
      <ul className="m-0 list-none divide-y overflow-hidden rounded-lg border p-0">
        {workspaces.map((workspace) => (
          <li key={workspace.slug}>
            <button
              type="button"
              data-settings-choose={workspace.slug}
              onClick={() => onChoose(workspace.slug)}
              className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-[14px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{workspace.slug}</span>
              <span className="shrink-0 font-mono text-[12px] text-text-tertiary">{workspace.prefix}</span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
