/**
 * The row's quick "change status" menu — the first of the desktop row's hover actions.
 *
 * The menu is a list of the workspace's own statuses, each with its glyph and its configured
 * name, and picking one applies it: the same `status` action the detail's status control
 * sends, so there is one write path. The current status is shown checked and cannot be
 * picked again.
 *
 * Like `QueueRowMenu`, it does not know how to write; the caller hands it `onPick` and owns
 * the refusal. It only knows how to ask.
 */
import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBackToClose } from "@/lib/back-to-close";
import { configuredStatusOrder, statusLabel } from "@/lib/settings";
import { ISSUE_STATUSES, type StatusId } from "@/lib/types";
import { statusChoices } from "@/detail/plain-actions";
import { StatusIcon } from "./StatusIcon";

export function RowStatusMenu({
  trigger,
  identifier,
  status,
  disabled = false,
  onPick,
}: {
  trigger: ReactNode;
  identifier: string;
  status: StatusId;
  disabled?: boolean;
  onPick: (status: StatusId) => void;
}) {
  const [open, setOpen] = useState(false);
  useBackToClose(open, () => setOpen(false));
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Change status of ${identifier}`} data-row-status-menu={identifier} align="end">
        <DropdownMenuLabel className="normal-case tracking-normal">Move to</DropdownMenuLabel>
        {statusChoices(configuredStatusOrder(), ISSUE_STATUSES, status).map((choice) => (
          <DropdownMenuItem
            key={choice}
            data-status-choice={choice}
            disabled={disabled || choice === status}
            onSelect={() => onPick(choice)}
          >
            <StatusIcon status={choice} />
            <span className="flex-1">{statusLabel(choice)}</span>
            {choice === status ? <Check aria-label="current status" className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
