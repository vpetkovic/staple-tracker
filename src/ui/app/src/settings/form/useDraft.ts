/**
 * DIRTY STATE, ASYNC SAVE AND EXTERNAL REVISIONS, as one hook — R6c (STA-178).
 *
 * Every settings form holds the same three things beside its draft: whether the draft
 * differs from what the server said, where the save is (idle, pending, failed with the
 * store's sentence), and the signature of the served state the draft was started from.
 * This hook holds them so an editor holds only its draft.
 *
 * ── THE DRAFT IS NULL WHEN CLEAN ──────────────────────────────────────────────────────
 *
 * A clean form shows the SERVED state directly: `draft` is `null` and `value` is
 * `served`. That is what makes the 1.5s poll harmless while nobody is editing — a
 * republished envelope simply becomes what the form shows — and what makes Cancel a
 * matter of dropping a reference. The first edit copies the served value into a draft
 * AND records the served signature as the baseline; from then on the served state
 * changing underneath is a conflict (`hasConflict`), surfaced by the editor as a
 * banner, and the two ways out are here: `reload` drops the draft, `keep` moves the
 * baseline up so the next save is a deliberate overwrite.
 *
 * ── SAVE ──────────────────────────────────────────────────────────────────────────────
 *
 * `save` hands the draft to the caller's writer (the dialog's `applyTo`, which posts
 * the batch and publishes the answer). Success clears the draft, so the form snaps to
 * exactly what the server stored; a refusal keeps the draft and the sentence, so the
 * user can fix what the store named and try again. Nothing is retried on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Refusal } from "@/lib/refusal";
import { hasConflict, type SaveStatus } from "./form-model";

export interface Draft<S> {
  /** The draft when dirty, the served state when clean. */
  value: S;
  dirty: boolean;
  status: SaveStatus;
  /** The failed save's refusal; cleared on the next edit or save. */
  refusal: Refusal | null;
  /** The served state moved while the draft was dirty. */
  conflict: boolean;
  /** Replace the draft. Passing the served state's equal is still an edit; use `cancel` to go clean. */
  set: (next: S) => void;
  /** Drop the draft (Cancel, Reset, and the conflict banner's Reload). */
  cancel: () => void;
  /** Acknowledge the external revision and keep the draft over it. */
  keep: () => void;
  save: () => Promise<boolean>;
}

export function useDraft<S>(options: {
  served: S;
  /** `snapshotSignature` of the served state this form edits. */
  signature: string;
  isDirty: (draft: S) => boolean;
  /** Post the draft. Resolves null on success, or the store's refusal. */
  write: (draft: S) => Promise<Refusal | null>;
  /** The shell's guard listens here. */
  onDirtyChange?: (dirty: boolean) => void;
}): Draft<S> {
  const { served, signature, isDirty, write, onDirtyChange } = options;
  const [draft, setDraft] = useState<S | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [baseline, setBaseline] = useState(signature);

  const dirty = draft !== null && isDirty(draft);
  const conflict = hasConflict({ dirty, baseline, served: signature });

  // Mirrors `draft` so `set` can tell a first edit from a later one without an updater
  // side effect (React may run updaters twice).
  const editing = useRef(false);
  const set = useCallback(
    (next: S) => {
      if (!editing.current) setBaseline(signature);
      editing.current = true;
      setDraft(next);
      setRefusal(null);
    },
    [signature],
  );

  const cancel = useCallback(() => {
    editing.current = false;
    setDraft(null);
    setRefusal(null);
    setStatus("idle");
  }, []);

  const keep = useCallback(() => setBaseline(signature), [signature]);

  // The writer the save uses is the latest one, even when the promise outlives a render.
  const writer = useRef(write);
  writer.current = write;

  const save = useCallback(async () => {
    if (draft === null || status === "pending") return false;
    setStatus("pending");
    setRefusal(null);
    const refused = await writer.current(draft);
    if (refused) {
      setStatus("failed");
      setRefusal(refused);
      return false;
    }
    setStatus("idle");
    editing.current = false;
    setDraft(null);
    return true;
  }, [draft, status]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Leaving the form (unmount) is never leaving it dirty as far as the shell knows.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  return {
    value: draft ?? served,
    dirty,
    status,
    refusal,
    conflict,
    set,
    cancel,
    keep,
    save,
  };
}
