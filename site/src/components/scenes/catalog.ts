import type {ComponentType} from 'react';
import type {SceneOptions} from './Scene';
import PlanToTickets from './PlanToTickets';
import QueuePickup from './QueuePickup';
import TicketContext from './TicketContext';
import Handoff from './Handoff';
import ApprovalGate from './ApprovalGate';
import AutopilotRun from './AutopilotRun';
import MilestoneGoal from './MilestoneGoal';
import TrackerSync from './TrackerSync';
import Budget from './Budget';
import OneStore from './OneStore';

export type SceneEntry = {
  /** The component's name, and the anchor on the review page. */
  name: string;
  /** The feature it belongs to. */
  feature: string;
  /** What happens in it, in one sentence. */
  story: string;
  Component: ComponentType<SceneOptions>;
};

// Every scene, in the order a landing page would tell the story. The review page at
// /scenes lists them from here, so a new scene shows up there once it is added.
export const SCENES: SceneEntry[] = [
  {name: 'PlanToTickets', feature: 'Plan to tickets', story: 'A Markdown plan becomes an epic, its tickets and the dependencies between them.', Component: PlanToTickets},
  {name: 'QueuePickup', feature: 'Queue pickup', story: 'An agent asks what is next, gets the top ready ticket and claims it.', Component: QueuePickup},
  {name: 'TicketContext', feature: 'Ticket context', story: 'Done-when criteria are ticked and the worklog document moves to a new version.', Component: TicketContext},
  {name: 'Handoff', feature: 'Handoff', story: 'A session goes silent; another agent takes the claim over and reads the worklog.', Component: Handoff},
  {name: 'ApprovalGate', feature: 'Approval gate', story: 'An epic waits on a person. Approve all is pressed and the tickets under it become ready.', Component: ApprovalGate},
  {name: 'AutopilotRun', feature: 'Autopilot run', story: 'Tickets go done one after another, then the budget stops the run.', Component: AutopilotRun},
  {name: 'MilestoneGoal', feature: 'Milestone goal', story: 'Goal criteria are marked met with evidence and the progress fills.', Component: MilestoneGoal},
  {name: 'TrackerSync', feature: 'Tracker sync (planned)', story: 'staple beside GitHub Issues, ClickUp and Linear, each marked planned.', Component: TrackerSync},
  {name: 'Budget', feature: 'Budget', story: 'Provider limits as gauges with the reserve, and an estimate against what the work took.', Component: Budget},
  {name: 'OneStore', feature: 'One store', story: 'A command in the terminal changes the same ticket in the web UI and over MCP.', Component: OneStore},
];
