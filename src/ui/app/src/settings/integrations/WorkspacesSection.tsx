/**
 * Settings → Integrations, second half: what each workspace searches and links. One row per
 * workspace, its sources as chips. Adding and removing save at once through `map` / `unmap`
 * on that row's own workspace, so the section needs no workspace of its own and has no Save.
 */
import { useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { integrationWrite } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ConnectionView } from "@/integrations/connection-status";
import { ProviderMark } from "@/integrations/parts";
import { InlineError, Section } from "../form/primitives";
import { ListFrame, SectionHeading } from "./ConnectionsSection";
import { SourcePicker } from "./SourcePicker";
import { chipLabel, orderWorkspaces, unmappedSentence, type MappedTarget, type WorkspaceMapping } from "./integrations-model";

const NO_READER = "No connection on this computer reads this source";

export function WorkspacesSection({ rows, error, onRetry, current, prefixes, connections, onRowChange }: {
  /** Null while the mapping is loading. */
  rows: WorkspaceMapping[] | null;
  error: string | null;
  onRetry: () => void;
  /** The workspace the app is on; its row comes first. */
  current: string;
  /** Workspace slug → identifier prefix, for the letter tile. */
  prefixes: Record<string, string>;
  connections: ConnectionView[];
  onRowChange: (workspace: string, targets: MappedTarget[]) => void;
}) {
  let body;
  if (error && !rows) {
    body = (
      <Section error={error}>
        <Button variant="outline" size="sm" onClick={onRetry} className="pointer-coarse:h-11">
          Try again
        </Button>
      </Section>
    );
  } else if (!rows) {
    body = (
      <ListFrame aria-busy>
        {[0, 1].map((i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="size-4 shrink-0 rounded-[5px]" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-6 w-24" />
          </li>
        ))}
      </ListFrame>
    );
  } else {
    body = (
      <ListFrame aria-label="Workspaces">
        {orderWorkspaces(rows, current).map((row) => (
          <WorkspaceRow
            key={row.workspace}
            row={row}
            rows={rows}
            current={row.workspace === current}
            tile={(prefixes[row.workspace] || row.workspace).slice(0, 1).toUpperCase()}
            connections={connections}
            onChange={(targets) => onRowChange(row.workspace, targets)}
          />
        ))}
      </ListFrame>
    );
  }
  return (
    <section aria-labelledby="integrations-workspaces" className="space-y-3" data-integrations-workspaces>
      <div className="space-y-1">
        <SectionHeading id="integrations-workspaces" title="Workspaces" tag="Shared with each workspace" />
        <p className="text-label text-muted-foreground">Choose what each workspace searches and links. A workspace with nothing chosen searches everything chosen here.</p>
      </div>
      {body}
    </section>
  );
}

function WorkspaceRow({ row, rows, current, tile, connections, onChange }: {
  row: WorkspaceMapping;
  rows: WorkspaceMapping[];
  current: boolean;
  tile: string;
  connections: ConnectionView[];
  onChange: (targets: MappedTarget[]) => void;
}) {
  const [rowError, setRowError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const withTeams = row.targets.some((t) => t.kind === "team");

  const unmap = async (target: MappedTarget) => {
    setRemoving(target.key);
    setRowError(null);
    try {
      const answer = await integrationWrite<{ targets: MappedTarget[] }>({ action: "unmap", targetKey: target.key }, row.workspace);
      onChange(answer.targets);
    } catch (caught) {
      setRowError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <li data-workspace-row={row.workspace} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2 pointer-coarse:py-2.5">
      {/* The rail's workspace tile: a letter on a 16px square, ink for the workspace the app is on. */}
      <div className="flex h-6 w-40 max-w-full min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[5px] text-[10px] leading-none font-semibold",
            current ? "bg-foreground text-background" : "bg-surface-selected text-foreground",
          )}
        >
          {tile}
        </span>
        <span className="truncate text-body font-medium" title={row.workspace}>
          {row.workspace}
        </span>
      </div>
      <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-1.5 pointer-coarse:gap-x-3 pointer-coarse:gap-y-4">
        {row.targets.length === 0 ? <span className="text-label text-text-tertiary">{unmappedSentence(rows, row.workspace)}</span> : null}
        {row.targets.map((target) => {
          const label = chipLabel(target);
          const orphan = target.connectionId === null;
          return (
            <span
              key={target.key}
              data-source-chip={target.kind}
              aria-busy={removing === target.key || undefined}
              title={orphan ? `${label.title}\n${NO_READER}` : label.title}
              className={cn("inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border pr-1 pl-2 text-label", removing === target.key && "opacity-60")}
            >
              {orphan ? <AlertTriangle aria-label={NO_READER} className="size-3.5 shrink-0 text-[var(--status-task-icon-todo)]" /> : null}
              <ProviderMark providerId={target.providerId} className="text-muted-foreground" />
              {target.kind === "project" && withTeams ? <span className="text-text-tertiary">Project</span> : null}
              <span className="max-w-[16rem] truncate">{label.text}</span>
              <button
                type="button"
                aria-label={`Remove ${label.text} from ${row.workspace}`}
                disabled={removing === target.key}
                onClick={() => void unmap(target)}
                className="relative flex size-4 min-h-0 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-hover hover:text-foreground focus-ring pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5"
              >
                {removing === target.key ? <Loader2 aria-hidden className="size-3 animate-spin" /> : <X aria-hidden className="size-3" />}
              </button>
            </span>
          );
        })}
        <SourcePicker workspace={row.workspace} targets={row.targets} connections={connections} onChange={onChange} />
      </div>
      {rowError ? (
        <div className="basis-full @min-[30rem]:pl-43">
          <InlineError>{rowError}</InlineError>
        </div>
      ) : null}
    </li>
  );
}
