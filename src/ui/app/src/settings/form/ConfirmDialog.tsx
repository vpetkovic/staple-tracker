/**
 * A DELIBERATE CHOICE — R6c (STA-178). One modal for the two places a settings form
 * must not let a keypress decide: leaving with unsaved changes, and a destructive
 * action (a removal that will rewrite issue rows).
 *
 * A nested Radix dialog rather than `window.confirm`: it keeps focus inside the app,
 * it is styled like every other dialog here, and — the part that matters for the
 * acceptance criterion — Esc on THIS dialog cancels the choice rather than closing the
 * settings shell underneath it, because Radix scopes the key to the topmost layer.
 *
 * The buttons say what they DO, never "OK": "Discard changes" / "Keep editing",
 * "Remove" / "Cancel". The safe action is the one focus starts on.
 */
import { useRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  /** The button that does the thing. */
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const safe = useRef<HTMLButtonElement>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogPortal>
        <DialogOverlay className="z-[60]" />
        <DialogPrimitive.Content
          role="alertdialog"
          data-confirm-dialog
          className="bg-popover text-foreground fixed top-1/2 left-1/2 z-[60] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-4 shadow-lg outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            safe.current?.focus();
          }}
        >
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button ref={safe} type="button" variant="outline" size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button type="button" variant={destructive ? "destructive" : "default"} size="sm" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

/** The unsaved-changes guard's copy, fixed so every path out of the shell asks the same thing. */
export const UNSAVED_CHANGES = {
  title: "Discard unsaved changes?",
  description: "You have changes that have not been saved. Leaving now throws them away.",
  confirmLabel: "Discard changes",
  cancelLabel: "Keep editing",
} as const;

/** The unsaved-changes guard's dialog. */
export function UnsavedChangesDialog({
  open,
  onDiscard,
  onKeep,
}: {
  open: boolean;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      {...UNSAVED_CHANGES}
      destructive
      onConfirm={onDiscard}
      onCancel={onKeep}
    />
  );
}
