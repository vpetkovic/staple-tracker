/**
 * MOUNT POINT — the settings dialog. O7b (STA-141).
 *
 * The same shape as `CreateIssueMount`, and for the same reasons: rendered once in
 * App.tsx above the shell so it survives view switches and can sit over the detail
 * drawer, opened through a `lib/shell-events` verb so the open flag stays here rather
 * than being lifted into the header that happens to have the button, and mounted ONLY
 * while open so a half-typed new status id does not come back next time.
 *
 * No bare-letter keyboard shortcut. `c` earned one because creating a task is the thing
 * you do twenty times a day; editing the status vocabulary is a thing you do twice a
 * year, and spending another single letter on it would take that letter away from
 * something that deserves it. Two ways in is the app's convention and this has both: the
 * gear in the header, and the command palette.
 */
import { useEffect, useState } from "react";
import { onOpenSettings } from "@/lib/shell-events";
import { SettingsDialog } from "./SettingsDialog";

export function SettingsMount() {
  const [open, setOpen] = useState(false);

  useEffect(() => onOpenSettings(() => setOpen(true)), []);

  if (!open) return null;
  return <SettingsDialog open onOpenChange={setOpen} />;
}
