/**
 * The settings envelope of the workspace Settings is EDITING — which need not be the one the
 * page is showing.
 *
 * lib/settings.ts holds ONE module snapshot: the page's vocabulary, which every status icon
 * and filter reads without a hook. Settings can now edit any workspace from anywhere, and
 * publishing another workspace's statuses into that snapshot would repaint the page's rows
 * with a vocabulary that is not theirs. So this hook fetches the target into LOCAL state and
 * never publishes; after a write the dialog bumps the session's version, and the page's own
 * `useWorkspaceSettings` refetches and publishes its own answer if the write touched it.
 *
 * `""` means no workspace has been chosen (All workspaces, nothing remembered): nothing is
 * fetched and `settings` is null, and the section asks which workspace instead.
 */
import { useCallback, useEffect, useState } from "react";
import { AuthError, getSettings } from "@/lib/api";
import type { WorkspaceSettingsEnvelope } from "@/lib/settings";

export interface TargetSettings {
  settings: WorkspaceSettingsEnvelope | null;
  error: Error | undefined;
  /** Replace the held envelope with a write's answer, so the form shows it in the same frame. */
  replace: (next: WorkspaceSettingsEnvelope) => void;
}

export function useTargetSettings(target: string, version: number): TargetSettings {
  const [held, setHeld] = useState<{ target: string; settings: WorkspaceSettingsEnvelope } | null>(null);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (target === "") return;
    let alive = true;
    getSettings({ ws: target })
      .then((next) => {
        if (!alive) return;
        setError(undefined);
        setHeld({ target, settings: next as WorkspaceSettingsEnvelope });
      })
      .catch((caught: unknown) => {
        // An AuthError is re-broadcast by lib/api and swaps in the token screen.
        if (!alive || caught instanceof AuthError) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      });
    return () => {
      alive = false;
    };
  }, [target, version]);

  const replace = useCallback(
    (next: WorkspaceSettingsEnvelope) => setHeld((current) => (current ? { ...current, settings: next } : current)),
    [],
  );

  // A held envelope for a previous target is never shown as this one's.
  const settings = target !== "" && held?.target === target ? held.settings : null;
  return { settings, error: target === "" ? undefined : error, replace };
}
