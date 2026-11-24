/**
 * The icon each Settings section wears in the sheet's list — the same icon a matching view
 * wears in the rail where there is one (Usage). An unknown section gets the generic sliders.
 */
import type { LucideIcon } from "lucide-react";
import { Plug, BatteryMedium, CircleDashed, Cloud, HardDrive, ListOrdered, Monitor, RefreshCw, Shapes, SlidersHorizontal, Users } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  integrations: Plug,
  cloud: Cloud,
  "hub-registry": HardDrive,
  telemetry: Plug, BatteryMedium,
  machine: Monitor,
  statuses: CircleDashed,
  kinds: Shapes,
  queue: ListOrdered,
  "workspace-cloud": RefreshCw,
  members: Users,
};

export function settingsIcon(id: string): LucideIcon {
  return ICONS[id] ?? SlidersHorizontal;
}
