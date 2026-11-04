/**
 * The chrome. Everything true of the page regardless of which view is showing.
 *
 * ── On a desk: a rail, a top bar, one toolbar, the view ─────────────────────────────────
 *
 *   THE RAIL (w-rail: 240px, 264px from 1680px) — `components/nav/NavRail.tsx`. Where you
 *     are: the workspaces, listed (so the scope and the way to change it are on screen
 *     without a menu), the views in that scope, and at the foot what belongs to this
 *     computer, Settings and the theme. It collapses (`[`, or cmd-\) and remembers that.
 *   THE TOP BAR (h-topbar: 52px) — `TopBar` below. "All workspaces › Tasks": the scope (a
 *     click opens the switcher) and the page's name, the sync pill, then on the right find
 *     anything (the palette, cmd-K) and the page's one primary action, New task.
 *   THE TOOLBAR (h-toolbar: 44px) — `components/filters/Toolbar.tsx`. Which tasks (Filter,
 *     the quick filters beside it, the filters that are on, search) and how they look
 *     (Group, Sort, Done). Only on the views that honour them (`viewControls`); a report
 *     page has no toolbar at all rather than a row of controls that do nothing.
 *
 * The content is a card on the desk (`--shell-gutter` of the sidebar tint round it). Every
 * size, surface and ring here is a token from styles/system-tokens.css.
 *
 * ── The rail is in-flow on a wide viewport and an overlay on a narrow one ─────────────
 *
 * Below 768px a permanent rail column is width the list does not get, so the rail
 * becomes a sheet opened from the menu button in the content header and closed by a
 * row, the scrim or Escape. The two states are held separately: `collapsed` is the
 * persisted desktop preference, `overlayOpen` is transient. A narrow window never
 * writes to the preference, so opening the sheet on a phone does not un-collapse the
 * rail on the desk.
 *
 * ── On a phone it is an app, not a squeezed desktop ───────────────────────────────────
 *
 * Below 768px the shell takes the shape every phone app has:
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
import { ChevronRight, Menu, Monitor, PanelLeft, Plus, Search, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CloudStrip } from "@/components/CloudStrip";
import { RunStrip } from "@/components/autopilot/RunBanner";
import { RunStopNotices } from "@/components/autopilot/RunStopNotices";
import { getCloudStatus, getCloudWorkspaces } from "@/lib/api";
import type { CloudSurfaceReport, HubCloudReport } from "@/lib/types";
import { FilterBar } from "@/components/filters/FilterBar";
import { FilterChips } from "@/components/filters/FilterChips";
import { DoneToggle, Toolbar, doneLivesInTopBar } from "@/components/filters/Toolbar";
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
import { isAllWorkspaces, isMachineView, scopeName, useSession, viewControls, viewLabel } from "@/lib/session";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBackToClose } from "@/lib/back-to-close";
import { cn } from "@/lib/utils";
import { useIsDesk } from "@/lib/use-media";

/** Is the viewport wide enough for the rail to be a column? The one breakpoint (lib/use-media). */
const useWideViewport = useIsDesk;

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

/** "⌘K" on a Mac, "Ctrl K" elsewhere — the palette's shortcut as the keyboard spells it. */
function paletteKeys(): string {
  if (typeof navigator === "undefined") return "⌘K";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";
}

/**
 * THE DESK'S TOP BAR — where you are, and the two things you can do from anywhere.
 *
 * Left: the scope, then the page — "All workspaces › Tasks" — so the first words on the page
 * say which workspace it is about and what it is. The scope is itself the switcher (a click
 * opens the workspace list), which keeps it changeable while the rail is put away; a view
 * about this computer (Usage) says "This computer" there instead, because it is the same
 * whichever workspace is chosen. Then the sync state, as one pill.
 *
 * Right: find anything (the command palette, as a field-shaped button that shows its
 * shortcut) and the page's PRIMARY action, New task — the one filled button in the chrome.
 */
export function TopBar({
  railVisible,
  onShowRail,
  cloud,
  hubCloud,
}: {
  railVisible: boolean;
  onShowRail: () => void;
  cloud: CloudSurfaceReport | null;
  hubCloud: HubCloudReport | null;
}) {
  const session = useSession();
  const title = viewLabel(session.view);
  const machine = isMachineView(session.view);
  return (
    <header data-top-bar className="flex h-topbar shrink-0 items-center gap-3 border-b px-page">
      {railVisible ? null : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Show navigation"
          title="Show navigation ([)"
          data-nav-show
          onClick={onShowRail}
          className="-ml-2 rounded-lg text-text-tertiary hover:text-foreground pointer-coarse:size-11"
        >
          <PanelLeft className="size-4" />
        </Button>
      )}
      <div className="flex min-w-0 items-center gap-1" data-top-bar-title>
        {machine ? (
          <span data-scope-name className="flex shrink-0 items-center gap-1.5 text-body text-text-secondary">
            <Monitor aria-hidden className="size-3.5 text-text-tertiary" />
            This computer
          </span>
        ) : session.mode === "hub" ? (
          <WorkspaceSwitcher variant="crumb" />
        ) : (
          // One workspace, nothing to switch to: its name, as words, not a menu of one.
          <span data-scope-name className="truncate text-body text-text-secondary">
            {scopeName(session)}
          </span>
        )}
        <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" />
        <h1 className="truncate pl-0.5 text-heading font-semibold">{title}</h1>
      </div>
      {machine ? null : <CloudStrip report={cloud} hub={hubCloud} />}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {doneLivesInTopBar(viewControls(session.view)) ? <DoneToggle /> : null}
        <button
          type="button"
          data-top-search
          aria-label="Find a task or run a command"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={openCommandPalette}
          className={cn(
            "flex h-control-md items-center gap-2 rounded-lg border bg-surface-sunken pointer-coarse:h-11",
            // Below 1024px the top bar has no room for a field: it is a square icon button,
            // named the same, with the shortcut in its tooltip-free accessible name.
            "w-control-md justify-center px-0 pointer-coarse:w-11 lg:w-[clamp(14rem,20vw,20rem)] lg:justify-start lg:pr-1.5 lg:pl-2.5",
            "text-body text-text-tertiary transition-colors hover:border-border-strong hover:text-text-secondary focus-ring",
          )}
        >
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left max-lg:hidden">Find a task or command</span>
          <kbd className="shrink-0 max-lg:hidden rounded-md border bg-surface-raised px-1.5 font-sans text-caption leading-5 text-text-tertiary">
            {paletteKeys()}
          </kbd>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button data-top-new-task onClick={() => openCreateIssue()} className="h-control-md gap-1.5 rounded-lg px-3 text-body pointer-coarse:h-11">
              <Plus aria-hidden className="size-4" />
              New task
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Create a task<span className="ml-1.5 font-mono text-caption opacity-70">C</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
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
  // The phone's menu drawer: Back closes it (lib/back-to-close.ts).
  useBackToClose(!wide && overlayOpen, closeOverlay);

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
  const controls = viewControls(session.view);
  const filterable = controls.filter;
  const hasHeaderControls = controls.arrange || controls.filter || controls.done;

  return (
    /*
      THE FRAME. The whole page is the desk (the sidebar tint); the rail sits on it with no
      border of its own, and the content is a CARD laid on it — one hairline, 8px of desk
      showing round it (`--shell-gutter`), rounded corners — so the pane reads as a sheet on
      the desk rather than a region ruled off it. Below 768px the gutter and the radius go:
      a phone has no desk to show. `h-dvh`: the frame is the DYNAMIC viewport, so a
      collapsing browser toolbar never hides the foot.
    */
    <div className="flex h-dvh bg-sidebar text-foreground" data-shell={wide ? "wide" : "phone"}>
      {wide && railVisible ? <NavRail onHide={toggleRail} /> : null}

      {!wide && overlayOpen ? (
        <div className="fixed inset-0 z-40 flex" data-nav-overlay>
          <div
            aria-hidden
            className="absolute inset-0 bg-scrim backdrop-blur-[2px]"
            onClick={closeOverlay}
          />
          <div className="relative h-full max-w-[85vw] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-sidebar shadow-lg">
            <NavRail onHide={closeOverlay} onNavigate={closeOverlay} />
          </div>
        </div>
      ) : null}

      <div
        data-content-frame
        className={cn(
          "flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:my-gutter md:mr-gutter md:rounded-xl md:border md:shadow-xs",
          wide && !railVisible && "md:ml-gutter",
        )}
      >
        {wide ? (
          <>
            {/* ── the desk: where you are and the primary action; then which tasks and how ── */}
            <TopBar railVisible={railVisible} onShowRail={toggleRail} cloud={cloud} hubCloud={hubCloud} />
            <Toolbar />
          </>
        ) : (
          <>
            {/* ── the phone's top bar: menu, where you are, and the three global verbs ── */}
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
              <BarButton label="New task" onClick={() => openCreateIssue()} data-bar-new-task>
                <SquarePen aria-hidden />
              </BarButton>
            </div>

            {/* ── the phone's content header: what the view is, and its controls ── */}
            <header className="shrink-0 border-b">
              <div className="relative flex min-h-13 items-center gap-1 pr-2 pl-4">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h1 className="truncate text-[20px] font-semibold tracking-tight">{title}</h1>
                </div>
                {/* `FilterBar` owns its own `ml-auto`, so this row says nothing about its right. */}
                {hasHeaderControls ? <FilterBar /> : null}
              </div>
            </header>

            {/* The quick-filter strip, directly under the header. See FilterChips. */}
            {filterable ? <FilterChips /> : null}
          </>
        )}

        {/*
          `relative` so anything that wants to anchor to the content area rather than the
          viewport has something to anchor to. `overflow-hidden` and NOT `overflow-y-auto`:
          the shell does not scroll its child. Each view owns its own scroll container,
          which is what lets the tree put sticky group headers at the top of the list and
          lets the graph canvas fill the box instead of computing its height from the
          viewport minus a guess at this header's size.
        */}
        <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>

        {/*
          The phone's run banner: the rail is a closed drawer here, so a live autopilot run is
          one line and a Stop above the tab bar, on every view (components/autopilot).
        */}
        {/* A run that ended: a notice naming why and what needs a person, on every view. */}
        <RunStopNotices placement={wide ? "corner" : "strip"} />
        {wide ? null : <RunStrip />}
        {wide ? null : <ViewTabBar />}
      </div>
    </div>
  );
}
