/**
 * The row's quick "change status" menu — the desktop row's first action, and the same list
 * as the "Change status" submenu in the row's `⋯` menu (for a keyboard or a finger).
 *
 * The choices are the ROW'S workspace vocabulary (`row-status.ts`), loaded by the caller;
 * `null` while they load. Picking one hands it to `onPick`; the caller writes and owns the
 * refusal, which it shows at the row.
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBackToClose } from "@/lib/back-to-close";
import type { RowStatusChoice } from "./row-status";
import { StatusIcon } from "./StatusIcon";

/** The status items themselves, for this menu and for the `⋯` menu's submenu. */
export function StatusChoiceItems({
  choices,
  disabled = false,
  onPick,
}: {
  choices: readonly RowStatusChoice[] | null;
  disabled?: boolean;
  onPick: (status: string, label: string) => void;
}) {
  if (choices === null) {
    return (
      <DropdownMenuItem disabled data-status-loading="">
        Loading this workspace's statuses…
      </DropdownMenuItem>
    );
  }
  if (choices.length === 0) {
    return (
      <DropdownMenuItem disabled data-status-failed="">
        Couldn't load this workspace's statuses. Open the task to change it.
      </DropdownMenuItem>
    );
  }
  return (
    <>
      {choices.map((choice) => (
        <DropdownMenuItem
          key={choice.id}
          data-status-choice={choice.id}
          data-current={choice.current ? "" : undefined}
          disabled={disabled || choice.disabled}
          onSelect={() => onPick(choice.id, choice.label)}
        >
          <StatusIcon status={choice.id} category={choice.category} />
          <span className="flex-1">{choice.label}</span>
          {choice.current ? <Check aria-label="current status" className="size-3.5" /> : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function RowStatusMenu({
  trigger,
  identifier,
  choices,
  disabled = false,
  open,
  onOpenChange,
  onPick,
}: {
  trigger: ReactNode;
  identifier: string;
  choices: readonly RowStatusChoice[] | null;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (status: string, label: string) => void;
}) {
  useBackToClose(open, () => onOpenChange(false));
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Change status of ${identifier}`} data-row-status-menu={identifier} align="end">
        <DropdownMenuLabel className="normal-case tracking-normal">Move to</DropdownMenuLabel>
        <StatusChoiceItems choices={choices} disabled={disabled} onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
