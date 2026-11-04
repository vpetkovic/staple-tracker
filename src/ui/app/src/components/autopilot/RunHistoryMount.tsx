/**
 * MOUNT POINT — the autopilot run history. Above the shell in App.tsx, like the other
 * mounts, so the rail, the phone strip and a task's detail can open it without owning it.
 * Mounted only while a request is held; phone Back closes it (lib/back-to-close.ts).
 *
 * Opening a ticket from it closes the history first, then opens the task's detail: the two
 * overlays never stack, so Back from the task returns to the page, not to a stale dialog.
 */
import { useEffect, useState } from "react";
import { useBackToClose } from "@/lib/back-to-close";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { onOpenRunHistory, type RunHistoryRequest } from "@/lib/shell-events";
import { RunHistoryDialog } from "./RunHistoryDialog";

export function RunHistoryMount() {
  const session = useSession();
  const [request, setRequest] = useState<RunHistoryRequest | null>(null);
  useEffect(() => onOpenRunHistory(setRequest), []);
  useBackToClose(request !== null, () => setRequest(null));
  if (!request) return null;
  return (
    <RunHistoryDialog
      focusRunId={request.runId}
      showWorkspace={isAllWorkspaces(session)}
      onOpenTicket={(workspace, ref) => {
        setRequest(null);
        session.open(workspace, ref);
      }}
      onOpenChange={(open) => (open ? undefined : setRequest(null))}
    />
  );
}
