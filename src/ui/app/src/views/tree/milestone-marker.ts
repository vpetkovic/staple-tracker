/**
 * Where a row's milestone marker goes (TreeView): a horizon opens where the plan shows it
 * (`session.openHorizon`: Plan's Horizons lens while its workspace has planning on, else the
 * Milestones view); any other milestone opens the Milestones view on it, in its own workspace
 * (`openMilestoneIn`).
 */
import type { StapleSession } from "@/lib/session";
import { openMilestoneIn } from "@/views/milestones/AllWorkspacesMilestones";

export function openMilestoneMarker(
  session: Pick<StapleSession, "mode" | "ws" | "setWs" | "focusMilestone" | "openHorizon">,
  workspace: string,
  identifier: string,
  horizon: boolean,
): void {
  if (horizon) session.openHorizon(workspace, identifier);
  else openMilestoneIn(session, workspace, identifier);
}
