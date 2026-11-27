/**
 * The chrome. Everything true of the page regardless of which view is showing.
 *
 * ── On a desk: a rail, a top bar, one toolbar, the view ─────────────────────────────────
 *
 *   THE RAIL — `components/nav/NavRail.tsx`. Where you are: the scope at its head (the
 *     workspace switcher), the views in that scope, and at the foot what belongs to this
 *     computer. Always there on a desk, at one of two widths: full (w-rail: 240px, 264px
 *     from 1680px) or narrow (w-rail-narrow: icons only). `[` or cmd-\ switches between
 *     them, and each desk size remembers its own choice (`components/nav/rail-mode.ts`).
 *   THE TOP BAR (h-topbar: 52px) — `TopBar` below. The rail's toggle, then the page's name
 *     ("All workspaces › Tasks" while the rail is narrow, the scope being the switcher), the
 *     sync pill, then on the right find anything (the palette, cmd-K) and the page's one
 *     primary action, New task.
 *   THE TOOLBAR (h-toolbar: 44px) — `components/filters/Toolbar.tsx`. Which tasks (Filter,
 *     the quick filters beside it, the filters that are on, search) and how they look
 *     (Group, Sort, Done). Only on the views that honour them (`viewControls`); a report
 *     page has no toolbar at all rather than a row of controls that do nothing.
 *
 * The content is a card on the desk (`--shell-gutter` of the sidebar tint round it). Every
 * size, surface and ring here is a token from styles/system-tokens.css.
 *
 * ── On a phone it is an app, not a squeezed desktop ───────────────────────────────────
 *
 * Below 768px the shell takes the shape every phone app has:
 *
 *   A TOP BAR — the workspace switcher as a 32px pill with the name (one tap opens it as a
 *     bottom sheet), the sync state as one icon, search, and New task. It sits under the
 *     status bar's safe area. There is no menu button and no drawer.
 *   THE CONTENT HEADER — the view's name, large, and its controls as 44px icon buttons.
 *   THE QUICK FILTERS — one sideways-scrolling row (FilterChips).
 *   A BOTTOM TAB BAR — Inbox, Autopilot, Queue, Tasks, and More: a sheet with the rest of
 *     the rail (the other views, the projects, this computer). It is the phone's one menu,
 *     on the home-indicator safe area (`components/nav/ViewTabBar.tsx` argues the pattern).
 *
 * The frame is `100dvh`, so the browser's collapsing toolbars never hide the tab bar, and
 * nothing in the chrome is wider than the screen (the sync state is a pill, CloudStrip).
 *
 * ── Controls keep their size under a finger ───────────────────────────────────────────
 *
 * A touch screen needs 44px to hit, not 44px drawn. The pill, the narrow rail's buttons and
 * the top bar's search and New task keep the size they have on a desk and get the rest from
 * an invisible `::before` hit area (7px round a bordered control, whose absolute box is
 * measured from inside its border).
 *
 * ── The scope is always named ─────────────────────────────────────────────────────────
 *
 * Every screen says which workspace the page is on, the workspace's name or "All
 * workspaces" (`scopeName` in lib/session.ts), so none implies a workspace the person did
 * not pick. On a desk with the rail full, the rail's head says it, and the top bar says only
 * the page; with the rail narrow the top bar says "scope › page". On a phone the pill says it.
 *
 * ── Why the view rows are buttons and not the Tabs primitive ──────────────────────────
 *
 * They switch what the whole page is, and they control no `TabsContent` — App.tsx swaps
 * the view. `aria-current="page"` on a button is what this actually is.
 */
import { ChevronRight, Monitor, PanelLeft, Plus, Search, SquarePen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CloudStrip } from "@/components/CloudStrip";
import { JoinRequestWatcher } from "@/components/join/JoinRequestToast";
import { SharedBadge } from "@/components/SharedBadge";
import { refreshSharedWorkspaces } from "@/lib/shared-workspaces";
import { RunStopNotices } from "@/components/autopilot/RunStopNotices";
import { getCloudStatus, getCloudWorkspaces } from "@/lib/api";
import type { CloudSurfaceReport, HubCloudReport } from "@/lib/types";
import { FilterBar } from "@/components/filters/FilterBar";
import { FilterChips } from "@/components/filters/FilterChips";
import { DoneToggle, Toolbar, doneLivesInTopBar } from "@/components/filters/Toolbar";
import { NavRail } from "@/components/nav/NavRail";
import { ViewTabBar } from "@/components/nav/ViewTabBar";
import { WorkspaceSwitcher } from "@/components/nav/WorkspaceSwitcher";
import { railKeyAction } from "@/components/nav/nav-model";
import { useRailMode, type RailMode } from "@/components/nav/rail-mode";
import { Button } from "@/components/ui/button";
import { floatingSurfaceIsOpen, isTyping } from "@/lib/keyboard";
import { openCommandPalette, openCreateIssue } from "@/lib/shell-events";
import { currentWorkspace, isAllWorkspaces, isMachineView, scopeName, useSession, viewControls, viewLabel } from "@/lib/session";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useIsDesk } from "@/lib/use-media";

/** Is the viewport wide enough for the rail to be a column? The one breakpoint (lib/use-media). */
const useWideViewport = useIsDesk;

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
 * Left: the rail's toggle, in one place whichever width the rail is. Then the page's name.
 * While the rail is full its head already names the scope, a hand's width away, so the bar
 * says only the page. While the rail is narrow the head is a letter, so the bar says the
 * scope and the page, "All workspaces › Tasks", and the scope is itself the switcher (a click
 * opens the workspace list). A view about this computer (Usage) says "This computer › Usage"
 * at either width, because the page is in no workspace and the rail's head does not say
 * that. Then the sync state, as one pill.
 *
 * Right: find anything (the command palette, as a field-shaped button that shows its
 * shortcut) and the page's PRIMARY action, New task — the one filled button in the chrome.
 */
export function TopBar({
  railMode,
  onToggleRail,
  cloud,
  hubCloud,
}: {
  railMode: RailMode;
  onToggleRail: () => void;
  cloud: CloudSurfaceReport | null;
  hubCloud: HubCloudReport | null;
}) {
  const session = useSession();
  const title = viewLabel(session.view);
  const machine = isMachineView(session.view);
  const toggleLabel = railMode === "full" ? "Collapse navigation" : "Expand navigation";
  const crumb = machine || railMode === "narrow";
  return (
    <header data-top-bar className="flex h-topbar shrink-0 items-center gap-3 border-b px-page">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={toggleLabel}
            aria-expanded={railMode === "full"}
            aria-keyshortcuts="["
            data-nav-toggle
            onClick={onToggleRail}
            className="relative -ml-2 shrink-0 rounded-lg text-text-tertiary hover:text-foreground pointer-coarse:before:absolute pointer-coarse:before:-inset-1.5 pointer-coarse:before:content-['']"
          >
            <PanelLeft className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {toggleLabel}
          <span className="ml-1.5 font-mono text-caption opacity-70">[</span>
        </TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 items-center gap-1" data-top-bar-title>
        {machine ? (
          <span data-scope-name className="flex shrink-0 items-center gap-1.5 text-body text-text-secondary">
            <Monitor aria-hidden className="size-3.5 text-text-tertiary" />
            This computer
          </span>
        ) : !crumb ? null : session.mode === "hub" ? (
          <WorkspaceSwitcher variant="crumb" />
        ) : (
          // One workspace, nothing to switch to: its name, as words, not a menu of one.
          <span data-scope-name className="truncate text-body text-text-secondary">
            {scopeName(session)}
          </span>
        )}
        {crumb ? <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" /> : null}
        <h1 className={cn("truncate text-heading font-semibold", crumb && "pl-0.5")}>{title}</h1>
      </div>
      {machine ? null : <SharedBadge slug={currentWorkspace(session)?.slug ?? ""} report={cloud} />}
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
            // Under a finger it keeps its size; the 44px is an invisible hit area round it (7px,
            // because an absolute box is measured from inside the 1px border).
            "relative flex h-control-md items-center gap-2 rounded-lg border bg-surface-sunken",
            "pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-[7px] pointer-coarse:before:content-['']",
            // Below 1024px the top bar has no room for a field: it is a square icon button,
            // named the same, with the shortcut in its tooltip-free accessible name.
            "w-control-md justify-center px-0 lg:w-[clamp(14rem,20vw,20rem)] lg:justify-start lg:pr-1.5 lg:pl-2.5",
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
            <Button
              data-top-new-task
              onClick={() => openCreateIssue()}
              className="relative h-control-md gap-1.5 rounded-lg px-3 text-body pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-1.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']"
            >
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

  useEffect(() => {
    void refreshSharedWorkspaces();
  }, [session.version, ws]);

  const { mode: railMode, toggle: toggleRail } = useRailMode();

  /**
   * The keyboard, decided in `railKeyAction` (nav-model.ts) from the facts this listener reads
   * off the DOM: an open dialog, menu or listbox owns the key, so `[` cannot switch the rail
   * under the open workspace switcher; otherwise the shortcut toggles, unless `[` was typed
   * into a field. A phone has no rail, so there the keys are nobody's.
   */
  useEffect(() => {
    if (!wide) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = railKeyAction(event, { surfaceOpen: floatingSurfaceIsOpen(), typing: isTyping(event.target) });
      if (action !== "toggle") return;
      event.preventDefault();
      toggleRail();
    };
    // CAPTURE phase, like the palette's cmd-K listener: Radix dismisses a dialog on a
    // document-capture keydown and React has unmounted it by the time a bubble listener
    // runs, so "is a dialog open" would already answer no. Window capture runs before
    // document capture.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [wide, toggleRail]);

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
      {wide ? <NavRail mode={railMode} /> : null}

      <div
        data-content-frame
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-card md:my-gutter md:mr-gutter md:rounded-xl md:border md:shadow-xs"
      >
        {wide ? (
          <>
            {/* ── the desk: where you are and the primary action; then which tasks and how ── */}
            <TopBar railMode={railMode} onToggleRail={toggleRail} cloud={cloud} hubCloud={hubCloud} />
            <Toolbar />
          </>
        ) : (
          <>
            {/* ── the phone's top bar: where you are, and the three global verbs ── */}
            <div
              data-app-bar
              className="flex shrink-0 items-center gap-1 border-b bg-card px-1.5 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1"
            >
              <div className="flex min-w-0 flex-1 justify-start pl-2">
                <WorkspaceSwitcher variant="bar" />
              </div>
              {all ? null : <SharedBadge slug={currentWorkspace(session)?.slug ?? ""} report={cloud} compact />}
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
                {/*
                  A view's own controls beside its name, where the row has room: the view portals
                  them in (the Plan lenses do). Empty, it is not drawn, so every other row is as it was.
                */}
                <div data-phone-header-slot className="flex min-w-0 flex-1 items-center justify-end empty:hidden" />
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

        {/* A run that ended: a notice naming why and what needs a person, on every view. */}
        <RunStopNotices placement={wide ? "corner" : "strip"} />
        {/* a join request toast, polled only with automatic sync on (JoinRequestToast). */}
        {all ? null : <JoinRequestWatcher report={cloud} slug={currentWorkspace(session)?.slug ?? ""} />}
        {wide ? null : <ViewTabBar />}
      </div>
    </div>
  );
}
