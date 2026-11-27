/**
 * The navigation rail: the desk's left column. (A phone has no rail: its tab bar and More
 * sheet, `ViewTabBar.tsx`, carry the same places.)
 *
 * The head is the scope, everything under it is in that scope, the foot is the computer, and
 * exactly one row is ever highlighted.
 *
 * ── TOP TO BOTTOM ─────────────────────────────────────────────────────────────────────
 *
 *   HEAD     the scope: its tile and its name ("All workspaces", "staple"). In hub mode it is
 *            the workspace switcher (`WorkspaceSwitcher variant="head"`); with one workspace
 *            it is the name as words. On a view about this computer it steps back to the
 *            secondary tone, because the page is not in the scope.
 *   NOW      Inbox (how much waits on a person, a dot when some is new), Autopilot (how many
 *            runs are live, then a line per live run that leads to it) and Queue (what agents
 *            take next). The Inbox count is every workspace's; the runs are the ones the
 *            Autopilot page lists, which follows the scope.
 *   RECORDS  12px below: the scope's work by shape. Tasks (with the scope's projects under
 *            it, and a `+` for a new one), Graph, Milestones, Plan (planning on), Estimates.
 *   FOOT     above a hairline, at the bottom: what reads the same whichever workspace is
 *            chosen. Usage, Integrations, Settings and the theme.
 *
 * The zones are `NAV_GROUPS` (nav-model.ts) and are set apart by space, with no labels and
 * nothing to fold: with eleven rows there is nothing to put away. The global verbs (find
 * anything, New task) and the rail's own toggle are in the top bar (see AppShell).
 *
 * ── TWO WIDTHS ────────────────────────────────────────────────────────────────────────
 *
 * `full` (w-rail) is rows with names and marks. `narrow` (w-rail-narrow, 52px) is icons only,
 * each a 36px button named for its row, with a tooltip that says the name and the mark in
 * words; the Inbox count and the live dot stay on the icon, so the two signals that matter
 * most are on screen at both widths. Sub-rows are the full rail's alone. Both widths draw the
 * same reads, made once here (`useRailReads`).
 *
 * ── ONE HIGHLIGHT ─────────────────────────────────────────────────────────────────────
 *
 * A view row is a `<button>` with `aria-current="page"`, and the styling reads that attribute,
 * so the DOM and the paint cannot disagree. When a child is the place (Tasks narrowed to one
 * project, a live run open on the Autopilot page) the child fills and carries
 * `aria-current="true"`; the parent keeps `aria-current="page"` and is marked
 * `data-child-current`, which draws it in the foreground tone without the fill.
 *
 * ── SUB-ROWS AND MARKS ────────────────────────────────────────────────────────────────
 *
 * The live runs and the projects share one shape: 28px rows on a hairline spine that drops
 * from the parent's icon, a 14px leading slot (the run's state dot, a folder), the name, then
 * what sits on the right. Marks share one register (`MARK_CLASS`): a count is a tertiary
 * number, "new" is a 6px accent dot before it, live is the run's state dot before "n live".
 * Row actions (the `+`, a project's gear) appear on hover and focus, are always in the tab
 * order, and are always visible on a touch screen. Every control has the one focus ring,
 * drawn inside (`focus-ring-inset`) so the rail's edge never clips it.
 */
import { Cog, FolderKanban, Moon, Plus, Plug, Settings, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useInboxBadge, type InboxBadge } from "@/lib/attention";
import { usePendingJoinRequests } from "@/lib/pending-requests";
import { bannerLine, liveStateText } from "@/lib/run-text";
import { useRuns } from "@/lib/runs";
import { useConnection, type Connection } from "@/lib/useStaple";
import { isAllWorkspaces, navigateTo, useSession, type ViewName } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { runHref } from "@/lib/session-url";
import { openProjectDialog, openSettings } from "@/lib/shell-events";
import type { RunEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ConnectionView } from "@/integrations/connection-status";
import { needsAttention } from "@/settings/integrations/integrations-model";
import { navGroup, projectCaption, type NavItem } from "./nav-model";
import {
  AccentDot,
  AttentionMark,
  ConnectionDot,
  STALE_MARKS_CLASS,
  countBadgeClass,
  MARK_CLASS,
  PendingMark,
  pendingWords,
  useConnections,
  useScopeProjects,
  type ScopeProjects,
} from "./nav-shared";
import type { RailMode } from "./rail-mode";
import {
  autopilotLiveText,
  currentTopRow,
  inboxMarkWords,
  inboxRowMark,
  liveDotTone,
  openRunOnPlainClick,
  runSubRowAside,
  runSubRowLabel,
  runSubRows,
  tabBadgeText,
} from "./top-nav-model";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/**
 * One full-rail row: 32px, 13px, 8px corners, a 16px icon. The ACTIVE row is filled, medium
 * weight, foreground icon; a parent whose child is the place keeps the weight and the tone
 * but not the fill (`data-child-current`).
 */
export const RAIL_ROW_CLASS = cn(
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-body font-normal focus-ring-inset pointer-coarse:h-11",
  "text-sidebar-foreground/85 transition-colors duration-(--motion-duration-fast) hover:bg-surface-hover hover:text-foreground",
  "aria-[current]:font-medium aria-[current]:text-foreground [&[aria-current]:not([data-child-current])]:bg-surface-selected",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-tertiary hover:[&_svg]:text-foreground aria-[current]:[&_svg]:text-foreground",
);

/** A sub-row under a full-rail row: a live run or a project. 28px, 6px corners. */
const SUBROW_CLASS = cn(
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left font-normal focus-ring-inset pointer-coarse:h-11",
  "text-sidebar-foreground/85 transition-colors duration-(--motion-duration-fast) hover:bg-surface-hover hover:text-foreground",
  "aria-[current]:bg-surface-selected aria-[current]:text-foreground",
  "[&_svg]:text-text-tertiary hover:[&_svg]:text-foreground aria-[current]:[&_svg]:text-foreground",
);

/** The list a parent's sub-rows hang in: a hairline spine dropping from the parent icon's centre. */
const SPINE_CLASS = "mt-px ml-4 flex flex-col gap-px border-l border-sidebar-border pl-1.5";

/** The 14px slot that leads a sub-row, so a dot and a folder sit on one line. `mark`: what it holds is a mark (a run's state). */
function LeadSlot({ children, mark = false }: { children?: ReactNode; mark?: boolean }) {
  return (
    <span data-nav-mark={mark || undefined} className="flex size-3.5 shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

/**
 * An icon button on a row's right edge: invisible until the row is hovered or the button is
 * focused, but always in the tab order; a control only a mouse can find is not a control.
 */
const ROW_ACTION_CLASS = cn(
  "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
  "text-text-tertiary opacity-0 transition-opacity focus-ring-inset",
  "group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-surface-active hover:text-foreground",
  // A touch screen has no hover: the action is simply always there, at thumb size.
  "[@media(hover:none)]:opacity-100 pointer-coarse:right-0 pointer-coarse:size-11",
);

/**
 * One narrow-rail button: a 36px square, an 18px icon, the same hover and active treatment.
 * Under a finger it keeps its size and look; the 44px it needs is an invisible hit area round
 * it, and the buttons stand 8px apart so those areas meet without overlapping.
 */
const ICON_BUTTON_CLASS = cn(
  "relative flex size-9 shrink-0 items-center justify-center rounded-lg focus-ring-inset",
  "pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:content-['']",
  "text-text-tertiary transition-colors duration-(--motion-duration-fast) hover:bg-surface-hover hover:text-foreground",
  "aria-[current]:bg-surface-selected aria-[current]:text-foreground",
  "[&_svg]:size-[18px] [&_svg]:shrink-0",
);

/** A run's state as a dot: its tone's colour, breathing only while it works, never under reduced motion. */
function RunDot({ tone }: { tone: ReturnType<typeof liveStateText>["tone"] }) {
  return (
    <span
      aria-hidden
      data-run-dot={tone}
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" && "motion-safe:animate-[staple-breathe_var(--motion-working-pulse)_var(--motion-ease-standard)_infinite]",
      )}
      style={{ backgroundColor: `var(--plain-${tone}-fg)` }}
    />
  );
}

/**
 * RECONNECTING, said once, quietly: a row-shaped status at the bottom of the rail's body, just
 * above the foot, while the server is not answering the page's polls. Not a control. The live
 * region is always there and empty while the page is live, so a screen reader hears the change
 * when it comes. The full rail says the word; the narrow rail shows the dot, named and with a
 * tooltip.
 */
function ConnectionStatus({ connection, narrow }: { connection: Connection; narrow: boolean }) {
  return (
    <div role="status" aria-live="polite" className="mt-auto">
      {connection !== "reconnecting" ? null : narrow ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div data-nav-connection="reconnecting" aria-label="Reconnecting" className="mt-3 flex size-9 items-center justify-center">
              <ConnectionDot />
              <span className="sr-only">Reconnecting</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">Reconnecting</TooltipContent>
        </Tooltip>
      ) : (
        // The 14px slot starts 9px in, so the dot's centre is on the row icons' centre line,
        // and the word starts where the row labels do.
        <div data-nav-connection="reconnecting" className="mt-3 flex h-7 items-center gap-[11px] pl-[9px] text-label text-text-tertiary">
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <ConnectionDot />
          </span>
          Reconnecting
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the reads, once

interface RailReads {
  connection: Connection;
  badge: InboxBadge;
  live: readonly RunEntry[];
  pending: number;
  connections: ReadonlyArray<Pick<ConnectionView, "health">>;
  projects: ScopeProjects;
}

function useRailReads(): RailReads {
  return {
    connection: useConnection(),
    badge: useInboxBadge(),
    live: useRuns().live,
    pending: usePendingJoinRequests(),
    connections: useConnections(),
    projects: useScopeProjects(),
  };
}

/** The rail's rows of a zone, Plan only while planning is on. */
function zoneItems(id: "views" | "machine", planningEnabled: boolean | undefined): readonly NavItem[] {
  return navGroup(id).items.filter((entry) => entry.view !== "plan" || planningEnabled === true);
}

export function NavRail({ mode }: { mode: RailMode }) {
  const reads = useRailReads();
  const width = mode === "full" ? "w-rail" : "w-rail-narrow";
  return (
    <nav
      aria-label="Primary"
      data-nav-rail
      data-rail-mode={mode}
      data-stale={reads.connection === "reconnecting" ? "" : undefined}
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
        STALE_MARKS_CLASS,
        // The width eases between the two (never under reduced motion). The rows inside switch at
        // once and keep their own width, so the moving edge reveals or covers them like a curtain
        // instead of squeezing them through every width in between.
        "transition-[width] duration-(--motion-duration-base) ease-(--motion-ease-out) motion-reduce:transition-none",
        width,
      )}
    >
      <div className={cn("flex h-full shrink-0 flex-col", width)}>
        {mode === "full" ? <FullRail reads={reads} /> : <NarrowRail reads={reads} />}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- the full rail

function FullRail({ reads }: { reads: RailReads }) {
  const session = useSession();
  return (
    <>
      {/* The head is level with the top bar: the content card starts one gutter down, so this row does too. */}
      <div className="mt-gutter flex h-topbar shrink-0 items-center px-3">
        <WorkspaceSwitcher variant="head" />
      </div>

      <div className="staple-momentum flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-3">
        <TopRows badge={reads.badge} live={reads.live} />
        <ul role="list" data-nav-group="views" aria-label="Records" className="mt-3 flex flex-col gap-px">
          {zoneItems("views", session.planningEnabled).map((entry) => (
            <NavItemRow key={entry.id} entry={entry} projects={reads.projects} />
          ))}
        </ul>
        <ConnectionStatus connection={reads.connection} narrow={false} />
      </div>

      {/* ── the foot: this computer ── */}
      <div className="shrink-0 border-t border-sidebar-border/70 px-3 py-2">
        <ul role="list" data-nav-group="machine" aria-label="This computer" className="flex flex-col gap-px">
          {zoneItems("machine", session.planningEnabled).map((entry) => (
            <NavItemRow key={entry.id} entry={entry} projects={reads.projects} />
          ))}
          <li>
            <IntegrationsRailRow connections={reads.connections} onClick={() => openSettings({ section: "integrations" })} />
          </li>
          <li className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Settings"
              title="Settings — this computer and every workspace"
              data-nav-settings
              onClick={() => openSettings()}
              className={RAIL_ROW_CLASS}
            >
              <Settings aria-hidden />
              Settings
              {/* join requests this page has heard of. Reading the count asks nobody. */}
              <PendingMark pending={reads.pending} />
            </button>
            <ThemeButton />
          </li>
        </ul>
      </div>
    </>
  );
}

/**
 * The scope's projects, one sub-row each, under Tasks. A row is the place when Tasks is on
 * screen filtered to exactly that project (the state a click on it produces) and says so with
 * `aria-current="true"`: the page is Tasks, this is a place within it. The count is the
 * project's open issues and gives way to the gear on hover and focus. Nothing renders while
 * the list is empty: the `+` on Tasks is the affordance.
 */
function ProjectSubItems({ projects }: { projects: ScopeProjects }) {
  const session = useSession();
  if (projects.rows.length === 0) return null;
  return (
    <ul role="list" data-nav-projects className={SPINE_CLASS}>
      {projects.rows.map((row) => {
        const { project } = row;
        const caption = projectCaption(row.workspace, projects.workspaces);
        const open = projects.openCounts.get(project.id) ?? 0;
        return (
          <li key={`${row.workspace}/${project.id}`} className="group/row relative">
            <button
              type="button"
              data-nav-project={project.id}
              aria-current={projects.activeId === project.id ? "true" : undefined}
              title={caption ? `${project.name} · ${row.workspace}` : project.name}
              onClick={() => session.focusProject(project.id)}
              // The count sits in the marks' column and gives way to the gear in the same spot; on a
              // touch screen both are always there, so the row leaves the gear its own room.
              className={cn(SUBROW_CLASS, "text-body [@media(hover:none)]:pr-12")}
            >
              <LeadSlot>
                <FolderKanban aria-hidden className="size-3.5" />
              </LeadSlot>
              <span className="truncate">{project.name}</span>
              {caption ? <span className="ml-auto shrink-0 text-caption text-text-tertiary">{caption}</span> : null}
              <span
                data-nav-project-count
                data-nav-mark
                aria-label={`${open} open`}
                className={cn(
                  MARK_CLASS,
                  caption && "ml-0",
                  "transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0 [@media(hover:none)]:opacity-100",
                )}
              >
                {open}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Project settings: ${project.name}`}
              title="Project settings"
              data-nav-project-settings={project.id}
              onClick={() => openProjectDialog({ mode: "edit", row })}
              className={ROW_ACTION_CLASS}
            >
              <Cog className="size-3.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NavItemRow({ entry, projects }: { entry: NavItem; projects: ScopeProjects }) {
  const session = useSession();
  const Icon = entry.icon;
  const active = entry.view === session.view;
  const hostsProjects = entry.subItems === "projects";
  return (
    <li>
      <div className="group/row relative">
        <button
          type="button"
          data-nav-item={entry.id}
          aria-current={active ? "page" : undefined}
          data-child-current={active && hostsProjects && projects.activeId !== null ? "" : undefined}
          onClick={() => navigateTo(session, entry.view)}
          className={cn(RAIL_ROW_CLASS, entry.action && "pr-8 pointer-coarse:pr-12")}
        >
          <Icon aria-hidden />
          <span className="truncate">{entry.label}</span>
        </button>
        {entry.action ? (
          <button
            type="button"
            aria-label={entry.action.label}
            title={entry.action.label}
            data-nav-action={entry.action.id}
            onClick={() => openProjectDialog({ mode: "create", workspace: session.ws || undefined })}
            className={ROW_ACTION_CLASS}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {hostsProjects ? <ProjectSubItems projects={projects} /> : null}
    </li>
  );
}

/**
 * NOW: Inbox, Autopilot and Queue, the full rail's first rows, a plain list with no heading.
 * Presentational: everything it shows arrives as props, so a test renders it to markup.
 *
 * The Inbox row says how much waits on a person in every workspace, with a dot when some of it
 * is new to this browser. The Autopilot row says how many runs are live, and under it each live
 * run is a sub-row that leads to that run (a real link: a plain click navigates in the page). A
 * fifth live run and later fold into one "n more" that opens the run list.
 */
export function RailTopRows({
  view,
  run,
  badge,
  live,
  showWorkspace,
  hrefFor,
  onSelect,
  onOpenRun,
}: {
  view: ViewName;
  run: string | null;
  badge: InboxBadge;
  live: readonly RunEntry[];
  showWorkspace: boolean;
  hrefFor: (runId: string) => string;
  onSelect: (view: ViewName) => void;
  onOpenRun: (runId: string | null) => void;
}) {
  const [inbox, autopilot, queue] = navGroup("top").items as [NavItem, NavItem, NavItem];
  const { shown, more } = runSubRows(live);
  const current = currentTopRow(view, run, shown.map((entry) => entry.run.id));
  const mark = inboxRowMark(badge);
  const liveText = autopilotLiveText(live.length);
  const liveTone = liveDotTone(live);
  const runIsCurrent = current?.startsWith("run:") ?? false;
  const InboxIcon = inbox.icon;
  const AutopilotIcon = autopilot.icon;
  const QueueIcon = queue.icon;
  return (
    <ul role="list" data-nav-group="top" aria-label="Inbox, Autopilot and Queue" className="flex flex-col gap-px">
      <li>
        <button
          type="button"
          data-nav-item={inbox.id}
          aria-current={current === inbox.id ? "page" : undefined}
          onClick={() => onSelect(inbox.view)}
          className={RAIL_ROW_CLASS}
        >
          <InboxIcon aria-hidden />
          <span className="truncate">{inbox.label}</span>
          {mark.count ? (
            <span data-nav-mark className={MARK_CLASS}>
              {mark.fresh ? <AccentDot data-nav-inbox-new /> : null}
              <span aria-hidden data-nav-inbox-count>
                {mark.count}
              </span>
            </span>
          ) : null}
          {mark.spoken ? <span className="sr-only">{mark.spoken}</span> : null}
        </button>
      </li>
      <li>
        <button
          type="button"
          data-nav-item={autopilot.id}
          // The run list, or a run open on it: the page is Autopilot either way. When the run is one
          // of the lines below, that line is the place and fills; this row only keeps its tone.
          aria-current={view === autopilot.view ? "page" : undefined}
          data-child-current={runIsCurrent ? "" : undefined}
          onClick={() => onSelect(autopilot.view)}
          className={RAIL_ROW_CLASS}
        >
          <AutopilotIcon aria-hidden />
          <span className="truncate">{autopilot.label}</span>
          {liveText ? (
            <span data-nav-autopilot-live data-nav-mark className={MARK_CLASS}>
              {liveTone ? <RunDot tone={liveTone} /> : null}
              {liveText}
            </span>
          ) : null}
        </button>
        {shown.length > 0 ? (
          <ul role="list" aria-label="Live runs" className={SPINE_CLASS}>
            {shown.map((entry) => {
              const id = entry.run.id;
              const state = liveStateText(entry);
              return (
                <li key={`${entry.workspace}/${id}`}>
                  <a
                    href={hrefFor(id)}
                    data-nav-run={id}
                    aria-current={current === `run:${id}` ? "true" : undefined}
                    aria-label={runSubRowLabel(entry, showWorkspace)}
                    title={bannerLine(entry)}
                    onClick={(event) => openRunOnPlainClick(event, () => onOpenRun(id))}
                    className={cn(SUBROW_CLASS, "text-label")}
                  >
                    <LeadSlot mark>
                      <RunDot tone={state.tone} />
                    </LeadSlot>
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    <span data-nav-mark className="max-w-[45%] shrink-0 truncate text-caption text-text-tertiary">{runSubRowAside(entry)}</span>
                  </a>
                </li>
              );
            })}
            {more > 0 ? (
              <li>
                <button type="button" data-nav-run-more onClick={() => onOpenRun(null)} className={cn(SUBROW_CLASS, "text-label")}>
                  <LeadSlot />
                  <span className="truncate">{more} more</span>
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
      <li>
        <button
          type="button"
          data-nav-item={queue.id}
          aria-current={view === queue.view ? "page" : undefined}
          onClick={() => onSelect(queue.view)}
          className={RAIL_ROW_CLASS}
        >
          <QueueIcon aria-hidden />
          <span className="truncate">{queue.label}</span>
        </button>
      </li>
    </ul>
  );
}

/** The top rows from the page's reads: the Inbox badge, the live runs, and where the page is. */
function TopRows({ badge, live }: { badge: InboxBadge; live: readonly RunEntry[] }) {
  const session = useSession();
  return (
    <RailTopRows
      view={session.view}
      run={session.run}
      badge={badge}
      live={live}
      showWorkspace={isAllWorkspaces(session)}
      hrefFor={(runId) => runHref(window.location.href, runId)}
      onSelect={(view) => navigateTo(session, view)}
      onOpenRun={session.openRun}
    />
  );
}

/** Integrations, with a dot when a connection needs attention. */
export function IntegrationsRailRow({ connections, onClick }: { connections: ReadonlyArray<Pick<ConnectionView, "health">>; onClick: () => void }) {
  return (
    <button type="button" title="Configure integrations" data-nav-integrations className={RAIL_ROW_CLASS} onClick={onClick}>
      <Plug aria-hidden />
      Integrations
      {needsAttention(connections) ? <AttentionMark /> : null}
    </button>
  );
}

/** The theme switch beside Settings: a 32px icon button (44px under a finger); 36px on the narrow rail. */
function ThemeButton({ narrow = false }: { narrow?: boolean }) {
  // A pure control over the page's theme (lib/theme.ts): it reads the one state and records a pick.
  const [dark, choose] = useTheme();
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="switch"
          aria-checked={dark}
          aria-label="Dark mode"
          data-nav-theme=""
          onClick={() => choose(!dark)}
          className={cn(
            "relative flex shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-hover hover:text-foreground focus-ring-inset",
            "pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:content-['']",
            narrow ? "pointer-coarse:before:-inset-1" : "pointer-coarse:before:-inset-1.5",
            narrow ? "size-9 [&_svg]:size-[18px]" : "size-8 [&_svg]:size-4",
          )}
        >
          {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </button>
      </TooltipTrigger>
      <TooltipContent side={narrow ? "right" : "bottom"}>{label}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------- the narrow rail

/** The badge a narrow icon wears at its top right: a count, "99+" past 99, in the accent only when some is new. */
function CountBadge({ text, fresh = false, ...rest }: { text: string; fresh?: boolean } & Record<`data-${string}`, string | boolean>) {
  return (
    <span aria-hidden data-nav-mark className={cn("absolute -top-2 left-2", countBadgeClass(fresh, "sidebar"))} {...rest}>
      {text}
    </span>
  );
}

/** The dot a narrow icon wears at its top right: a run is live, or a connection needs attention. */
function CornerDot({ color, ...rest }: { color: string } & Record<`data-${string}`, string | boolean>) {
  return (
    <span
      aria-hidden
      data-nav-mark
      className="absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-sidebar"
      style={{ backgroundColor: color }}
      {...rest}
    />
  );
}

/**
 * One narrow-rail control: an icon button named for its row and, when it has one, the mark in
 * words (`hint`: "Inbox, 23 waiting, 4 new"), with a tooltip on the right that says the same.
 */
function IconRow({
  icon: Icon,
  label,
  hint,
  current,
  corner,
  onClick,
  ...rest
}: {
  icon: LucideIcon;
  label: string;
  hint?: string | null;
  current?: boolean;
  corner?: ReactNode;
  onClick: () => void;
} & Record<`data-${string}`, string | boolean>) {
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={hint ? `${label}, ${hint}` : label}
            aria-current={current ? "page" : undefined}
            onClick={onClick}
            className={ICON_BUTTON_CLASS}
            {...rest}
          >
            <span className="relative flex">
              <Icon aria-hidden />
              {corner}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{hint ? `${label} · ${hint}` : label}</TooltipContent>
      </Tooltip>
    </li>
  );
}

function NarrowRail({ reads }: { reads: RailReads }) {
  const session = useSession();
  const [inbox, autopilot, queue] = navGroup("top").items as [NavItem, NavItem, NavItem];
  const badgeText = tabBadgeText(reads.badge.waiting);
  const liveText = autopilotLiveText(reads.live.length);
  const liveTone = liveDotTone(reads.live);
  const pending = pendingWords(reads.pending);
  const pendingText = tabBadgeText(reads.pending);
  const attention = needsAttention(reads.connections);
  const viewRow = (entry: NavItem) => (
    <IconRow
      key={entry.id}
      icon={entry.icon}
      label={entry.label}
      current={session.view === entry.view}
      onClick={() => navigateTo(session, entry.view)}
      data-nav-item={entry.id}
    />
  );
  return (
    <>
      <div className="mt-gutter flex h-topbar shrink-0 items-center justify-center">
        <WorkspaceSwitcher variant="head" compact />
      </div>

      <div className="staple-momentum flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-2 pb-3">
        <ul role="list" data-nav-group="top" aria-label="Inbox, Autopilot and Queue" className="flex flex-col items-center gap-1 pointer-coarse:gap-2">
          <IconRow
            icon={inbox.icon}
            label={inbox.label}
            hint={inboxMarkWords(reads.badge)}
            current={session.view === inbox.view}
            corner={badgeText ? <CountBadge text={badgeText} fresh={reads.badge.unseen > 0} data-nav-inbox-count /> : null}
            onClick={() => navigateTo(session, inbox.view)}
            data-nav-item={inbox.id}
          />
          <IconRow
            icon={autopilot.icon}
            label={autopilot.label}
            hint={liveText}
            current={session.view === autopilot.view}
            corner={liveTone ? <CornerDot color={`var(--plain-${liveTone}-fg)`} data-nav-autopilot-live={liveTone} /> : null}
            onClick={() => navigateTo(session, autopilot.view)}
            data-nav-item={autopilot.id}
          />
          {viewRow(queue)}
        </ul>
        <ul role="list" data-nav-group="views" aria-label="Records" className="mt-3 flex flex-col items-center gap-1 pointer-coarse:gap-2">
          {zoneItems("views", session.planningEnabled).map(viewRow)}
        </ul>
        <ConnectionStatus connection={reads.connection} narrow />
      </div>

      <div className="flex shrink-0 justify-center border-t border-sidebar-border/70 py-2">
        <ul role="list" data-nav-group="machine" aria-label="This computer" className="flex flex-col items-center gap-1 pointer-coarse:gap-2">
          {zoneItems("machine", session.planningEnabled).map(viewRow)}
          <IconRow
            icon={Plug}
            label="Integrations"
            hint={attention ? "needs attention" : null}
            corner={attention ? <CornerDot color="var(--status-task-todo)" data-integrations-attention /> : null}
            onClick={() => openSettings({ section: "integrations" })}
            data-nav-integrations
          />
          <IconRow
            icon={Settings}
            label="Settings"
            hint={pending}
            corner={pendingText ? <CountBadge text={pendingText} data-settings-badge={String(reads.pending)} /> : null}
            onClick={() => openSettings()}
            data-nav-settings
          />
          <li>
            <ThemeButton narrow />
          </li>
        </ul>
      </div>
    </>
  );
}
