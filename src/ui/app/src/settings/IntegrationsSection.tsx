/**
 * Settings → Integrations. Connections belong to this computer and every workspace maps its
 * own sources, so the screen needs no workspace: `ws` is whatever the shell has (or none) and
 * only reaches routes that ignore it. Each workspace row writes to its own workspace.
 *
 * This file only fetches; the two halves under ./integrations render from what it passes.
 */
import { useCallback, useEffect, useState } from "react";
import { integrationRead } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { WorkspaceSettingsEnvelope } from "@/lib/settings";
import { useConnections } from "@/integrations/useConnections";
import type { ApplyTo } from "./CategoryContent";
import { ConnectionsSection } from "./integrations/ConnectionsSection";
import { WorkspacesSection } from "./integrations/WorkspacesSection";
import type { MappedTarget, WorkspaceMapping } from "./integrations/integrations-model";

export function IntegrationsSection({ ws, onDirtyChange }: {
  ws?: string;
  /** Unused: nothing here goes through the generic settings route. */
  settings: WorkspaceSettingsEnvelope;
  applyTo: ApplyTo;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const state = useConnections(ws, { poll: true });
  const session = useSession();
  const [rows, setRows] = useState<WorkspaceMapping[] | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);

  const loadMapping = useCallback(() => {
    let active = true;
    setMappingError(null);
    integrationRead<{ workspaces: WorkspaceMapping[] }>({ action: "mapping", allWorkspaces: true }, ws)
      .then((answer) => active && setRows(answer.workspaces))
      .catch((caught: unknown) => active && setMappingError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      active = false;
    };
  }, [ws]);
  useEffect(loadMapping, [loadMapping]);
  // A connection added or removed changes which machine connection serves each source.
  const connectionIds = state.connections.map((c) => c.id).join(",");
  useEffect(() => {
    if (state.loaded && rows) loadMapping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionIds]);

  const setRow = useCallback((workspace: string, targets: MappedTarget[]) => {
    setRows((held) => held?.map((row) => (row.workspace === workspace ? { ...row, targets } : row)) ?? held);
  }, []);

  const current = session.mode === "hub" ? session.ws : (session.workspaces[0]?.slug ?? "");
  const prefixes = Object.fromEntries(session.workspaces.map((w) => [w.slug, w.prefix]));
  return (
    <div className="@container space-y-8" data-integrations>
      <ConnectionsSection state={state} ws={ws} onDirtyChange={onDirtyChange} />
      <WorkspacesSection
        rows={rows}
        error={mappingError}
        onRetry={loadMapping}
        current={current}
        prefixes={prefixes}
        connections={state.connections}
        cachedOnly={state.cachedOnly}
        onRowChange={setRow}
      />
      <p className="text-label text-text-tertiary">
        Connections and keys stay on this computer and never reach the browser. What each workspace searches syncs with that workspace.
      </p>
    </div>
  );
}
