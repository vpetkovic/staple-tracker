/**
 * The chrome. Everything true of the page regardless of which view is showing.
 *
 * ── A rail on the left, the view on the right ─────────────────────────────────────────
 *
 * The shell used to be a two-tier header: identity and global actions on one row, the
 * view tabs and the filter controls on a second, and a note here saying "no sidebar, per
 * VP" because with two views a rail had nothing to hold. There are four views now, with
 * projects arriving underneath one of them, and VP asked for Linear's layout instead. So
 * the split is by DIRECTION rather than by altitude:
 *
 *   THE RAIL (232px, left) — `components/nav/NavRail.tsx`. Where you are and what you
 *     can do from anywhere: the workspace switcher, New task, search, the views in named
 *     groups, and at the foot the settings and the theme. Nothing in it changes what the
 *     view below shows. It collapses (`[`, or cmd-\) and remembers that it did.
 *   THE CONTENT HEADER (44px, top of the pane) — what the view IS and how much of it.
 *     The view's name on the left; on the right the group, sort, search, filter and
 *     done controls that used to live on tier 2. Everything on this row scopes the thing
 *     underneath it, which is why it sits directly on top of it. `FilterChips` stays
 *     directly below it, as before, and still renders nothing when no filter is on.
 *
 * ── The rail is in-flow on a wide viewport and an overlay on a narrow one ─────────────
 *
 * Below 768px a permanent 232px column is 232px the list does not get, so the rail
 * becomes a sheet opened from the menu button in the content header and closed by a
 * row, the scrim or Escape. The two states are held separately: `collapsed` is the
 * persisted desktop preference, `overlayOpen` is transient. A narrow window never
 * writes to the preference, so opening the sheet on a phone does not un-collapse the
 * rail on the desk.
 *
 * ── Why the view rows are buttons and not the Tabs primitive ──────────────────────────
 *
 * They switch what the whole page is, and they control no `TabsContent` — App.tsx swaps
 * the view. `aria-current="page"` on a button is what this actually is.
 */
import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { FilterBar } from "@/components/filters/FilterBar";
import { FilterChips } from "@/components/filters/FilterChips";
import { NavRail } from "@/components/nav/NavRail";
import { isRailToggleKey, loadRailCollapsed, saveRailCollapsed } from "@/components/nav/nav-model";
import { Button } from "@/components/ui/button";
import { dialogIsOpen, isTyping } from "@/lib/keyboard";
import { useSession, viewLabel } from "@/lib/session";

/** Above this the rail is a column; below it, a sheet. */
const WIDE_QUERY = "(min-width: 768px)";

function subscribeWide(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function readWide(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(WIDE_QUERY).matches;
}

/** Is the viewport wide enough for the rail to be a column? True where nothing can answer. */
function useWideViewport(): boolean {
  return useSyncExternalStore(subscribeWide, readWide, () => true);
}

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const wide = useWideViewport();

  const [collapsed, setCollapsed] = useState(() => loadRailCollapsed(storage()));
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => saveRailCollapsed(storage(), collapsed), [collapsed]);

  const railVisible = wide ? !collapsed : overlayOpen;
  const toggleRail = useCallback(() => {
    if (wide) setCollapsed((current) => !current);
    else setOverlayOpen((current) => !current);
  }, [wide]);
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  // A sheet left open while the window grows would become a second rail beside the first.
  useEffect(() => {
    if (wide) setOverlayOpen(false);
  }, [wide]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && overlayOpen) {
        event.preventDefault();
        setOverlayOpen(false);
        return;
      }
      if (!isRailToggleKey(event)) return;
      // `[` is a bare letter and must not fire out of a text box; cmd-\ can afford to.
      if (event.key === "[" && isTyping(event.target)) return;
      if (dialogIsOpen()) return;
      event.preventDefault();
      toggleRail();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpen, toggleRail]);

  // The sheet takes focus when it opens so the keyboard lands inside it, not behind it.
  useEffect(() => {
    if (!overlayOpen) return;
    const first = document.querySelector<HTMLElement>("[data-nav-rail] button");
    first?.focus();
  }, [overlayOpen]);

  const title = viewLabel(session.view);
  useEffect(() => {
    document.title = `${title} · staple`;
  }, [title]);

  return (
    <div className="flex h-full bg-background text-foreground">
      {wide && railVisible ? <NavRail onHide={toggleRail} /> : null}

      {!wide && overlayOpen ? (
        <div className="fixed inset-0 z-40 flex" data-nav-overlay>
          <div
            aria-hidden
            className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
            onClick={closeOverlay}
          />
          <div className="relative h-full shadow-lg">
            <NavRail onHide={closeOverlay} onNavigate={closeOverlay} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── the content header: what the view is, and how much of it ── */}
        <header className="shrink-0 border-b">
          <div className="flex h-11 items-center gap-2 px-4">
            {railVisible ? null : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show navigation"
                title="Show navigation ([)"
                data-nav-show
                onClick={toggleRail}
                className="-ml-2 text-text-tertiary hover:text-foreground"
              >
                <PanelLeft className="size-4" />
              </Button>
            )}
            <h1 className="truncate text-[13px] font-medium">{title}</h1>
            {/* `FilterBar` owns its own `ml-auto`, so this row says nothing about its right. */}
            <FilterBar />
          </div>
        </header>

        {/*
          The active-filter strip, directly under the header. Renders nothing — no border,
          no height — when no filter is on, which is the app's usual state. See FilterChips.
        */}
        <FilterChips />

        {/*
          `relative` so anything that wants to anchor to the content area rather than the
          viewport has something to anchor to. `overflow-hidden` and NOT `overflow-y-auto`:
          the shell does not scroll its child. Each view owns its own scroll container,
          which is what lets the tree put sticky group headers at the top of the list and
          lets the graph canvas fill the box instead of computing its height from the
          viewport minus a guess at this header's size.
        */}
        <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
