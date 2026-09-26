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
 * ── On a phone it is an app, not a squeezed desktop ───────────────────────────────────
 *
 * Below 768px the shell takes the shape every phone app has (STA-310's lane):
 *
 *   A TOP BAR — the menu button (the rail as a drawer: projects, Settings, theme), the
 *     workspace switcher as a pill with the FULL name (one tap opens it as a bottom sheet),
 *     the sync state as one icon, search, and New task. It sits under the status bar's
 *     safe area.
 *   THE CONTENT HEADER — the view's name, large, and its controls as 44px icon buttons.
 *   THE QUICK FILTERS — one sideways-scrolling row (FilterChips).
 *   A BOTTOM TAB BAR — the six views, one tap each, on the home-indicator safe area
 *     (`components/nav/ViewTabBar.tsx` argues the pattern).
 *
 * The frame is `100dvh`, so the browser's collapsing toolbars never hide the tab bar, and
 * nothing in the chrome is wider than the screen: the sync strip that used to overflow a
 * phone sideways is now a pill (CloudStrip).
 *
 * ── The scope is always named ─────────────────────────────────────────────────────────
 *
 * The header says which workspace the page is on — the workspace's name, or "All
 * workspaces" — beside the view's name, so no screen implies a workspace the person did not
 * pick (`scopeName` in lib/session.ts).
 *
 * ── Why the view rows are buttons and not the Tabs primitive ──────────────────────────
 *
 * They switch what the whole page is, and they control no `TabsContent` — App.tsx swaps
 * the view. `aria-current="page"` on a button is what this actually is.
 */
import { Menu, PanelLeft, Search, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CloudStrip } from "@/components/CloudStrip";
import { getCloudStatus, getCloudWorkspaces } from "@/lib/api";
import type { CloudSurfaceReport, HubCloudReport } from "@/lib/types";
import { FilterBar } from "@/components/filters/FilterBar";
import { FilterChips } from "@/components/filters/FilterChips";
import { NavRail } from "@/components/nav/NavRail";
import { ViewTabBar } from "@/components/nav/ViewTabBar";
import { WorkspaceSwitcher } from "@/components/nav/WorkspaceSwitcher";
import {
  loadRailCollapsed,
  overlayFocusTarget,
  railKeyAction,
  saveRailCollapsed,
} from "@/components/nav/nav-model";
import { Button } from "@/components/ui/button";
import { floatingSurfaceIsOpen, isTyping } from "@/lib/keyboard";
import { openCommandPalette, openCreateIssue } from "@/lib/shell-events";
import { isAllWorkspaces, scopeName, useSession, viewLabel, viewUsesIssueFilters } from "@/lib/session";

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

/**
 * Is the viewport wide enough for the rail to be a column? True where nothing can answer.
 * The server snapshot reads the same stub a test installs, so a string render can be asked
 * for the phone layout (see `useCompactHeader`).
 */
function useWideViewport(): boolean {
  return useSyncExternalStore(subscribeWide, readWide, readWide);
}

const storage = () => (typeof localStorage === "undefined" ? undefined : localStorage);

/** A 44px icon button for the phone's top bar. */
function BarButton({ label, onClick, children, ...rest }: { label: string; onClick: () => void; children: ReactNode } & Record<`data-${string}`, string | boolean>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="size-11 shrink-0 rounded-full text-foreground [&_svg:not([class*='size-'])]:size-5"
      {...rest}
    >
      {children}
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const wide = useWideViewport();
  const all = isAllWorkspaces(session);

  /**
   * Sync state, fetched ONCE per workspace shown — never on the 1.5s fingerprint poll.
   *
   * Connection state changes when a human runs `staple cloud connect`, not while they read a
   * page, so polling it would be a great deal of traffic to learn nothing — and a polled
   * status endpoint is the shape most likely to be quietly upgraded into a probe later. It
   * is keyed on the workspace, because a pill describing the workspace you just left would
   * be wrong; on All workspaces the hub's list is read instead and the pill counts.
   *
   * A failure leaves both null, which renders nothing: an unreachable local status route is
   * not a reason to put an error on a page about tasks.
   */
  const [cloud, setCloud] = useState<CloudSurfaceReport | null>(null);
  const [hubCloud, setHubCloud] = useState<HubCloudReport | null>(null);
  const ws = session.ws;
  useEffect(() => {
    let live = true;
    setCloud(null);
    setHubCloud(null);
    const read = all ? getCloudWorkspaces().then((report) => live && setHubCloud(report)) : getCloudStatus({ ws: ws || undefined }).then((report) => live && setCloud(report));
    read.catch(() => {
      /* Silence is the correct rendering of "this machine could not tell". */
    });
    return () => {
      live = false;
    };
  }, [all, ws]);

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

  /**
   * The keyboard, decided in `railKeyAction` (nav-model.ts) from three facts this
   * listener reads off the DOM: an open dialog, menu or listbox owns the key — so Escape
   * in a dialog closes the dialog and not the sheet behind it, and `[` cannot collapse
   * the rail under the open workspace switcher; Escape closes the sheet; the shortcut
   * toggles, unless `[` was typed into a field.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = railKeyAction(event, {
        overlayOpen,
        surfaceOpen: floatingSurfaceIsOpen(),
        typing: isTyping(event.target),
      });
      if (action === null) return;
      event.preventDefault();
      if (action === "close-overlay") setOverlayOpen(false);
      else toggleRail();
    };
    // CAPTURE phase, like the palette's cmd-K listener: Radix dismisses a dialog on a
    // document-capture keydown and React has unmounted it by the time a bubble listener
    // runs, so "is a dialog open" would already answer no and Escape would close the
    // sheet behind the dialog it just closed. Window capture runs before document capture.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [overlayOpen, toggleRail]);

  /**
   * Focus follows the sheet: into the rail when it opens, so the keyboard lands inside
   * it rather than behind it; back to the "Show navigation" button when it closes —
   * by Escape, the scrim or a row — rather than dropping to `<body>`. The button is
   * absent when the sheet closed because the window grew, and then there is nothing to
   * return to and nothing is done.
   */
  const wasOverlayOpen = useRef(false);
  useEffect(() => {
    const target = overlayFocusTarget(wasOverlayOpen.current, overlayOpen);
    wasOverlayOpen.current = overlayOpen;
    if (target === "rail") document.querySelector<HTMLElement>("[data-nav-rail] button")?.focus();
    if (target === "show-navigation") document.querySelector<HTMLElement>("[data-nav-show]")?.focus();
  }, [overlayOpen]);

  const title = viewLabel(session.view);
  const scope = scopeName(session);
  useEffect(() => {
    document.title = `${title} · ${scope} · staple`;
  }, [title, scope]);
  const filterable = viewUsesIssueFilters(session.view);

  return (
    /*
      THE FRAME. The whole page is the sidebar tint; the rail sits on it with no border
      of its own, and the content is an inset CARD — one hairline, an 8px gutter on
      top, right and bottom, a rounded top-left corner where it meets the rail — so the
      pane reads as a sheet laid on the desk rather than a region ruled off it. Below
      768px the gutter and the radius go: a phone has no desk to show. `h-dvh`: the
      frame is the DYNAMIC viewport, so a collapsing browser toolbar never hides the foot.
    */
    <div className="flex h-dvh bg-sidebar text-foreground" data-shell={wide ? "wide" : "phone"}>
      {wide && railVisible ? <NavRail onHide={toggleRail} /> : null}

      {!wide && overlayOpen ? (
        <div className="fixed inset-0 z-40 flex" data-nav-overlay>
          <div
            aria-hidden
            className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
            onClick={closeOverlay}
          />
          <div className="relative h-full max-w-[85vw] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-sidebar shadow-lg">
            <NavRail onHide={closeOverlay} onNavigate={closeOverlay} />
          </div>
        </div>
      ) : null}

      <div
        data-content-frame
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:mt-2 md:mr-2 md:mb-2 md:rounded-tl-lg md:border"
      >
        {wide ? null : (
          /* ── the phone's top bar: menu, where you are, and the three global verbs ── */
          <div
            data-app-bar
            className="flex shrink-0 items-center gap-1 border-b bg-card px-1.5 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1"
          >
            <BarButton label="Menu" onClick={toggleRail} data-nav-show>
              <Menu aria-hidden />
            </BarButton>
            <div className="flex min-w-0 flex-1 justify-start">
              <WorkspaceSwitcher variant="bar" />
            </div>
            <CloudStrip report={cloud} hub={hubCloud} compact />
            <BarButton label="Search and commands" onClick={openCommandPalette} data-bar-search>
              <Search aria-hidden />
            </BarButton>
            <BarButton label="New task" onClick={openCreateIssue} data-bar-new-task>
              <SquarePen aria-hidden />
            </BarButton>
          </div>
        )}

        {/* ── the content header: what the view is, where, and how much of it ── */}
        <header className="shrink-0 border-b">
          <div className="flex min-h-10 items-center gap-2 px-4 max-md:min-h-13 max-md:gap-1 max-md:pr-2">
            {!wide || railVisible ? null : (
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
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="truncate text-[13px] font-medium max-md:text-[20px] max-md:font-semibold max-md:tracking-tight">
                {title}
              </h1>
              {wide ? (
                <span data-scope-name className="truncate text-[13px] text-text-tertiary">
                  {scope}
                </span>
              ) : null}
            </div>
            {wide ? <CloudStrip report={cloud} hub={hubCloud} /> : null}
            {/* `FilterBar` owns its own `ml-auto`, so this row says nothing about its right. */}
            {filterable ? <FilterBar /> : null}
          </div>
        </header>

        {/*
          The quick-filter strip, directly under the header: presets, the filters that are
          on, and Clear all. See FilterChips.
        */}
        {filterable ? <FilterChips /> : null}

        {/*
          `relative` so anything that wants to anchor to the content area rather than the
          viewport has something to anchor to. `overflow-hidden` and NOT `overflow-y-auto`:
          the shell does not scroll its child. Each view owns its own scroll container,
          which is what lets the tree put sticky group headers at the top of the list and
          lets the graph canvas fill the box instead of computing its height from the
          viewport minus a guess at this header's size.
        */}
        <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>

        {wide ? null : <ViewTabBar />}
      </div>
    </div>
  );
}
