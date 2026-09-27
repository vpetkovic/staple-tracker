/**
 * A notice that belongs to one row, drawn directly under it: today, a status change the
 * store refused. It says what did not happen in plain words and offers the fix that is one
 * click away ("Assign me") or the task itself ("Open task").
 *
 * It is a `row` with one `gridcell` so it sits legally inside the treegrid; it is not in the
 * keyboard sequence, and `role="alert"` announces it the moment it appears.
 */
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RowNotice({
  identifier,
  sentence,
  needsAssignee,
  busy = false,
  onAssign,
  onOpen,
  onDismiss,
}: {
  identifier: string;
  sentence: string;
  needsAssignee: boolean;
  busy?: boolean;
  onAssign: () => void;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="row" className="staple-row-notice" data-row-notice={identifier}>
      <div role="gridcell" className="staple-row-notice-cell">
        <TriangleAlert aria-hidden className="staple-row-notice-icon" />
        <span role="alert" className="staple-row-notice-text">
          {sentence}
        </span>
        <span className="staple-row-notice-actions">
          {needsAssignee ? (
            <Button size="xs" disabled={busy} data-notice-action="assign" onClick={onAssign}>
              Assign me
            </Button>
          ) : null}
          <Button size="xs" variant="outline" disabled={busy} data-notice-action="open" onClick={onOpen}>
            Open task
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" data-notice-action="dismiss" onClick={onDismiss}>
            <X />
          </Button>
        </span>
      </div>
    </div>
  );
}
