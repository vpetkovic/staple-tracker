/**
 * The icon each Settings section wears in the sheet's list — the same icon a matching view
 * wears in the rail where there is one (Usage). An unknown section gets the generic sliders.
 */
import type { LucideIcon } from "lucide-react";
import { BatteryMedium, CircleDashed, Cloud, HardDrive, ListOrdered, Monitor, RefreshCw, Shapes, SlidersHorizontal } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  cloud: Cloud,
  "hub-registry": HardDrive,
  telemetry: BatteryMedium,
  machine: Monitor,
  statuses: CircleDashed,
  kinds: Shapes,
  queue: ListOrdered,
  "workspace-cloud": RefreshCw,
};

export function settingsIcon(id: string): LucideIcon {
  return ICONS[id] ?? SlidersHorizontal;
}
