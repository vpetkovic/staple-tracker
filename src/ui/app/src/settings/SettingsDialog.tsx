/**
 * WORK WORKSPACE SETTINGS — the dialog that hosts the shell. O7b (STA-141) built the
 * first panel; R6b (STA-177) replaced its two tabs with a registry-driven shell.
 *
 * ── WHY A DIALOG AND NOT A VIEW ───────────────────────────────────────────────────────
 *
 * `lib/session.ts` VIEWS is `["tree", "graph"]` and the tuple is load-bearing: the header
 * tabs, the palette's "Go to …" commands and App's switch are all derived from it, so a
 * third member would put "settings" in the tab row beside the two things the app is FOR.
 * Settings is not a place you look at work from; it is a thing you do to the workspace and
 * then leave. That is a dialog, mounted above the shell beside the palette and the create
 * form, reached the same two ways every other shell verb is — a visible control and the
 * command palette — and, since R6b, by URL (`?settings=<category>`, see SettingsMount).
 *
 * ── WHAT THIS FILE OWNS, AND WHAT IT HANDS DOWN ───────────────────────────────────────
 *
 * Three things: the fetch (`useWorkspaceSettings`), the write path (`applyTo`), and the
 * dialog's FRAME — which of the shell's arrangements applies, from the viewport width and
 * the full-screen toggle. The shell (`SettingsShell`) draws the nav and the panes from
 * `settingCategories()` and asks `CategoryContent` what goes in the selected one. The URL
 * belongs to the mount, which passes the requested category in and takes selections out.
 *
 * ── ONE WRITE PATH ────────────────────────────────────────────────────────────────────
 *
 * `applyTo` is the only function in this file that talks to the server, and every editor
 * shares it. It POSTs one ordered batch, publishes the WHOLE returned envelope to
 * lib/settings.ts, and bumps the session's data version so the tree and the graph refetch —
 * because a removal with a migrate-to has just rewritten the status of every issue that
 * carried it, and a list still showing the old one is a list that is wrong rather than
 * merely stale.
 *
 * ── REFUSALS ARE THE STORE'S SENTENCE ─────────────────────────────────────────────────
 *
 * Nothing in this dialog decides whether an edit is ALLOWED. The store refuses a duplicate
 * id, a removal that still has rows and no target, and the removal of the last status in a
 * category it writes into — and each refusal arrives as its own sentence through
 * `describeRefusal`. `applyTo` RETURNS it (null on success) rather than holding it, so the
 * form that posted the batch can put the sentence on the row or field it names (R6c).
 *
 * ── LEAVING IS A CHOICE WHILE SOMETHING IS UNSAVED ────────────────────────────────────
 *
 * Since R6c the editors hold a draft, and every way out of the shell — the X, Esc, a
 * click on the overlay, the stacked layout's Back, selecting another category — goes
 * through one guard: clean, it proceeds; dirty, it asks (`UnsavedChangesDialog`) and
 * proceeds only on "Discard changes". The forms report their dirty state through
 * `onDirtyChange`; the dialog does not know what is dirty, only that something is.
 * `beforeunload` covers the tab itself.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, putSettings } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import {
  publishWorkspaceSettings,
  settingCategories,
  useWorkspaceSettings,
  type SettingOp,
} from "@/lib/settings";
import { useSession } from "@/lib/session";
import type { VocabularyOp } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { CategoryContent, type ApplyTo } from "./CategoryContent";
import { UnsavedChangesDialog } from "./form/ConfirmDialog";
import { leaveDecision } from "./form/form-model";
import { SettingsShell } from "./SettingsShell";
import {
  STACKED_QUERY,
  otherShellMode,
  resolveCategory,
  scopeSummaryOf,
  settingsFrameClass,
  type ShellMode,
  type ShellPane,
} from "./settings-shell";

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

export function SettingsDialog({
  open,
  category,
  onCategoryChange,
  onOpenChange,
}: {
  open: boolean;
  /** The category the URL asked for; `""` for "whichever is first". */
  category: string;
  onCategoryChange: (category: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  // `ws || undefined` — "" means "all workspaces" on the session and there is no such
  // thing as an all-workspaces vocabulary; the server then resolves its default handle,
  // which in single-workspace mode is the only one there is.
  const resource = useWorkspaceSettings({ ws: session.ws || undefined, version: session.version });
  const applyTo = useCallback<ApplyTo>(
    async (target: "statuses" | "kinds" | "settings", ops: VocabularyOp[] | SettingOp[]): Promise<Refusal | null> => {
      try {
        const next =
          target === "settings"
            ? await putSettings(target, ops as SettingOp[], { ws: session.ws || undefined })
            : await putSettings(target, ops as VocabularyOp[], { ws: session.ws || undefined });
        publishWorkspaceSettings(next);
        // A migrate-to removal rewrote issue rows. Everything on screen has to refetch,
        // and the fingerprint poll would get there within 1.5s anyway — this only makes
        // the list agree with the dialog in the same frame the dialog updates.
        session.refresh();
        return null;
      } catch (error) {
        // AuthError is re-broadcast by lib/api and swaps in the token screen; anything
        // else is the store refusing, and the user reads what it said.
        if (error instanceof ApiError) return describeRefusal(error);
        return describeRefusal({ message: error instanceof Error ? error.message : String(error) });
      }
    },
    [session],
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

  const settings = resource.settings;
  // Re-read on every render: `settings` above is the same snapshot the accessor reads,
  // so this is the served registry, in shell order, with no list of its own.
  const categories = settingCategories();
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
  const toggleMode = useCallback(() => setMode((current) => otherShellMode(current)), []);
  const close = useCallback(() => guard(() => onOpenChange(false)), [guard, onOpenChange]);

  const fallback = resource.error ? <ErrorState error={resource.error} /> : <LoadingState rows={5} />;

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
            scope={scopeSummaryOf(settings)}
            onSelect={select}
            onBack={back}
            onToggleMode={toggleMode}
            onClose={close}
            TitleTag={DialogTitle}
            DescriptionTag={DialogDescription}
            fallback={fallback}
            renderCategory={(current) =>
              resource.error ? (
                <ErrorState error={resource.error} />
              ) : (
                <CategoryContent
                  key={`${current.id}:${formKey}`}
                  category={current}
                  settings={settings}
                  applyTo={applyTo}
                  onDirtyChange={setDirty}
                />
              )
            }
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
