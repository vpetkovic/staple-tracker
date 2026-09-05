/**
 * MOUNT POINT — the project dialog. Above the shell in App.tsx, like the other mounts,
 * so the rail's `+` and a project row's gear can open it without owning it and it
 * survives a view switch. Mounted only while a request is held, so the form's state
 * resets between opens and an edit never shows the previous project's draft.
 */
import { useEffect, useState } from "react";
import { onOpenProjectDialog, type ProjectDialogRequest } from "@/lib/shell-events";
import { ProjectDialog } from "./ProjectDialog";

export function ProjectDialogMount() {
  const [request, setRequest] = useState<ProjectDialogRequest | null>(null);
  useEffect(() => onOpenProjectDialog(setRequest), []);
  if (!request) return null;
  return <ProjectDialog request={request} onOpenChange={(open) => (open ? undefined : setRequest(null))} />;
}
