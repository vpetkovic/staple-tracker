/**
 * SETTINGS — the dialog that hosts the sheet. O7b (STA-141) built the first panel; R6b
 * (STA-177) replaced its two tabs with a registry-driven shell; it is now global.
 *
 * ── WHY A DIALOG AND NOT A VIEW ───────────────────────────────────────────────────────
 *
 * Settings is not a place you look at work from; it is a thing you do and then leave. That
 * is a dialog, mounted above the shell beside the palette and the create form, reached from
 * a visible control, the command palette, the sync pill, and by URL
 * (`?settings=<section>&settings-ws=<workspace>`, see SettingsMount). On a phone it is a
 * full-screen sheet: the list of sections, then a section, with Back.
 *
 * ── GLOBAL, WITH A WORKSPACE PICKER INSIDE ────────────────────────────────────────────
 *
 * It opens from anywhere — All workspaces included — on the same sheet. The sections that
 * are about the computer (Cloud, Hub registry, Usage & budget, This machine) read the
 * page's own settings snapshot. The sections that are about ONE workspace edit `target`
 * (`settingsTarget` in settings-shell.ts), fetched on its own by `useTargetSettings` so the
 * page's vocabulary is never overwritten by another workspace's; the picker above them
 * changes `target` in place, through the URL, without closing anything. With no target
 * (All workspaces, nothing remembered) a per-workspace section asks which workspace.
 *
 * ── ONE WRITE PATH ────────────────────────────────────────────────────────────────────
 *
 * `applyTo` is the only function in this file that talks to the server, and every editor
 * shares it. It POSTs one ordered batch to the section's workspace, hands the returned
 * envelope to the target's local state (and to lib/settings.ts only when it IS the page's
 * workspace), and bumps the session's data version so the tree and the graph refetch.
 *
 * ── REFUSALS ARE THE STORE'S SENTENCE ─────────────────────────────────────────────────
 *
 * Nothing in this dialog decides whether an edit is ALLOWED. The store refuses, and each
 * refusal arrives as its own sentence through `describeRefusal`. `applyTo` RETURNS it
 * (null on success) so the form that posted the batch can put it where it belongs (R6c).
 *
 * ── LEAVING IS A CHOICE WHILE SOMETHING IS UNSAVED ────────────────────────────────────
 *
 * Every way out of a section — the X, Esc, the overlay, Back, another section, another
 * workspace in the picker — goes through one guard: clean, it proceeds; dirty, it asks
 * (`UnsavedChangesDialog`) and proceeds only on "Discard changes".
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, putSettings } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import {
  publishWorkspaceSettings,
  subscribeWorkspaceSettings,
  workspaceSettings,
  type SettingOp,
  type WorkspaceSettingsEnvelope,
} from "@/lib/settings";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { asksForWorkspace, loadRememberedWorkspace } from "@/lib/session-workspace";
import type { VocabularyOp } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBackToClose } from "@/lib/back-to-close";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { CategoryContent, type ApplyTo } from "./CategoryContent";
import { withCloudCategory } from "./cloud-settings";
import { withTelemetryCategory } from "./telemetry-settings";
import { UnsavedChangesDialog } from "./form/ConfirmDialog";
import { leaveDecision } from "./form/form-model";
import { SettingsShell } from "./SettingsShell";
import {
  STACKED_QUERY,
  needsWorkspaceChoice,
  otherShellMode,
  resolveCategory,
  scopeSummaryOf,
  settingsFrameClass,
  settingsTarget,
  withShellCategories,
  type ShellMode,
  type ShellPane,
} from "./settings-shell";
import { useTargetSettings } from "./useTargetSettings";
import { WorkspaceChooser } from "./WorkspaceChooser";

/**
 * Is the viewport too narrow for two panes? Read once at mount and then subscribed, so
 * rotating a tablet re-arranges the open dialog rather than leaving it in the wrong one.
 * `false` where there is no `matchMedia` (a string render), which is the two-pane layout.
 */
function useStacked(): boolean {
  const [stacked, setStacked] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(STACKED_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(STACKED_QUERY);
    const onChange = () => setStacked(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return stacked;
}

/** The page's own settings snapshot (lib/settings.ts), without fetching it a second time. */
function usePageSettings(): WorkspaceSettingsEnvelope {
  return useSyncExternalStore(subscribeWorkspaceSettings, workspaceSettings, workspaceSettings);
}

export function SettingsDialog({
  open,
  category,
  workspace = "",
  onCategoryChange,
  onWorkspaceChange = () => {},
  onOpenChange,
}: {
  open: boolean;
  /** The category the URL asked for; `""` for "whichever is first". */
  category: string;
  /** The workspace the URL asked the per-workspace sections to edit; `""` for the default. */
  workspace?: string;
  onCategoryChange: (category: string) => void;
  /** The in-Settings picker chose another workspace. The dialog stays open. */
  onWorkspaceChange?: (workspace: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  const page = usePageSettings();
  const [remembered] = useState(() => loadRememberedWorkspace());
  /** Which workspace the per-workspace sections edit; "" = not chosen, so they ask. */
  const target = settingsTarget(session, workspace, remembered);
  const targetSettings = useTargetSettings(target, session.version);

  const write = useCallback(
    async (
      kind: "statuses" | "kinds" | "settings",
      ops: VocabularyOp[] | SettingOp[],
      forWorkspace?: string,
    ): Promise<Refusal | null> => {
      // A global section writes through the page's workspace route (the server keeps global
      // keys in config.json whichever workspace carries them); a per-workspace one, the target's.
      const ws = forWorkspace ?? (session.ws || undefined);
      try {
        const next =
          kind === "settings"
            ? await putSettings(kind, ops as SettingOp[], { ws })
            : await putSettings(kind, ops as VocabularyOp[], { ws });
        if (forWorkspace !== undefined) targetSettings.replace(next as WorkspaceSettingsEnvelope);
        // The page's snapshot takes the answer only when it is the page's own workspace. On
        // All workspaces the snapshot is the union of every workspace's vocabulary, which
        // one workspace's answer must not replace: the refresh below re-reads the union.
        if (!isAllWorkspaces(session) && ws === (session.ws || undefined)) publishWorkspaceSettings(next);
        // A migrate-to removal rewrote issue rows. Everything on screen refetches.
        session.refresh();
        return null;
      } catch (error) {
        // AuthError is re-broadcast by lib/api and swaps in the token screen; anything
        // else is the store refusing, and the user reads what it said.
        if (error instanceof ApiError) return describeRefusal(error);
        return describeRefusal({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    [session, targetSettings],
  );
  /** The write path as each kind of section sees it: global through the page, per-workspace through the target. */
  const applyGlobal = useMemo(
    () => ((kind: "statuses" | "kinds" | "settings", ops: VocabularyOp[] | SettingOp[]) => write(kind, ops)) as ApplyTo,
    [write],
  );
  const applyTarget = useMemo(
    () =>
      ((kind: "statuses" | "kinds" | "settings", ops: VocabularyOp[] | SettingOp[]) => write(kind, ops, target)) as ApplyTo,
    [write, target],
  );

  /**
   * THE UNSAVED-CHANGES GUARD. `dirty` is whatever the open form last reported;
   * `pendingLeave` is the way out that is waiting on a decision.
   */
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  /**
   * Bumped on "Discard changes" so the form REMOUNTS and its draft is really gone —
   * the stacked layout's Back only hides the content pane, and a draft that survived
   * a discard would be dirty again the moment the pane came back.
   */
  const [formKey, setFormKey] = useState(0);
  const guard = useCallback(
    (leave: () => void) => {
      if (leaveDecision(dirty) === "confirm") setPendingLeave(() => leave);
      else leave();
    },
    [dirty],
  );
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /**
   * The served registry in shell order, plus the sections the browser declares itself:
   * Cloud and Usage & budget (machine-local stores, `cloud-settings.ts` and
   * `telemetry-settings.ts`), and the two this sheet split out of Cloud — Hub registry
   * (global) and Cloud sync (per workspace). None of those is a back door into the
   * registry: nothing they hold ever travels on `/api/settings`.
   */
  const categories = withShellCategories(withTelemetryCategory(withCloudCategory(page.registry.categories)));
  const active = resolveCategory(categories, category);

  const stacked = useStacked();
  const layout = stacked ? "stacked" : "two-pane";
  /**
   * Which pane a narrow shell opens on: the content when the URL named a category (a
   * deep link means "show me this"), the nav when it did not (the gear means "show me
   * what there is"). Selecting drills in; Back comes out. Neither touches the URL's
   * category, so Back in the shell and Back in the browser stay two different things.
   */
  const [pane, setPane] = useState<ShellPane>(() => (category ? "content" : "nav"));
  const [mode, setMode] = useState<ShellMode>("drawer");

  const select = useCallback(
    (id: string) => {
      if (id === active) {
        setPane("content");
        return;
      }
      guard(() => {
        onCategoryChange(id);
        setPane("content");
      });
    },
    [active, guard, onCategoryChange],
  );
  const back = useCallback(() => guard(() => setPane("nav")), [guard]);
  /**
   * On a phone a section is a screen of its own, so the system Back returns to the list of
   * sections — the way every phone settings app behaves — and only Back from the list
   * closes Settings (its own entry, SettingsMount). The section's entry is an overlay entry
   * (lib/back-to-close.ts); the in-sheet Back arrow consumes it.
   */
  useBackToClose(stacked && pane === "content", () => setPane("nav"));
  const toggleMode = useCallback(() => setMode((current) => otherShellMode(current)), []);
  const close = useCallback(() => guard(() => onOpenChange(false)), [guard, onOpenChange]);

  const fallback = <LoadingState rows={5} />;
  const chooseWorkspace = useCallback(
    (slug: string) => {
      if (slug === target) return;
      guard(() => onWorkspaceChange(slug));
    },
    [guard, onWorkspaceChange, target],
  );
  const workspacePicker = asksForWorkspace(session) ? (
    <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[13px] text-muted-foreground">Workspace</span>
      <Select value={target || undefined} onValueChange={chooseWorkspace}>
        <SelectTrigger
          data-settings-target
          aria-label="Workspace these settings change"
          className="h-11 min-w-[12rem] flex-1 text-[15px] sm:h-9 sm:max-w-xs sm:flex-none sm:text-sm"
        >
          <SelectValue placeholder="Choose a workspace" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {session.workspaces.map((entry) => (
            <SelectItem key={entry.slug} value={entry.slug} className="min-h-11 sm:min-h-8">
              {entry.slug}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-settings-dialog
          data-mode={mode}
          data-layout={layout}
          className={cn(
            "bg-popover text-foreground fixed z-50 flex flex-col overflow-hidden shadow-lg outline-none",
            settingsFrameClass(mode, layout),
          )}
          /**
           * Radix would focus the first tabbable control, which is a header button. The
           * selected category's nav entry is the thing you came here to act on, so focus
           * starts there and the arrow keys walk the nav; on a narrow screen showing the
           * content pane the shell itself moves focus to the category heading.
           */
          onOpenAutoFocus={(event) => {
            const root = event.currentTarget as HTMLElement | null;
            // A phone opening on the list: the sheet itself takes focus, no row does.
            if (stacked && pane === "nav") {
              event.preventDefault();
              root?.focus({ preventScroll: true });
              return;
            }
            const button = root?.querySelector<HTMLButtonElement>(`[data-settings-category="${active ?? ""}"]`);
            if (!button) return;
            event.preventDefault();
            button.focus({ preventScroll: true });
          }}
        >
          <SettingsShell
            categories={categories}
            active={active}
            layout={layout}
            pane={pane}
            mode={mode}
            scope={scopeSummaryOf(page, target)}
            workspacePicker={workspacePicker}
            onSelect={select}
            onBack={back}
            onToggleMode={toggleMode}
            onClose={close}
            TitleTag={DialogTitle}
            DescriptionTag={DialogDescription}
            fallback={fallback}
            renderCategory={(shown) => {
              const perWorkspace = shown.scope === "workspace";
              if (needsWorkspaceChoice(shown, target)) {
                return <WorkspaceChooser section={shown.label} workspaces={session.workspaces} onChoose={chooseWorkspace} />;
              }
              if (perWorkspace && targetSettings.error) return <ErrorState error={targetSettings.error} />;
              const envelope = perWorkspace ? targetSettings.settings : page;
              if (!envelope) return <LoadingState rows={4} />;
              return (
                <CategoryContent
                  key={`${shown.id}:${perWorkspace ? target : ""}:${formKey}`}
                  category={shown}
                  settings={envelope}
                  applyTo={perWorkspace ? applyTarget : applyGlobal}
                  onDirtyChange={setDirty}
                  ws={perWorkspace ? target : session.ws || undefined}
                />
              );
            }}
          />
          <UnsavedChangesDialog
            open={pendingLeave !== null}
            onDiscard={() => {
              const leave = pendingLeave;
              setPendingLeave(null);
              setDirty(false);
              setFormKey((key) => key + 1);
              leave?.();
            }}
            onKeep={() => setPendingLeave(null)}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
