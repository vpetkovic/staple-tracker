/**
 * The navigation rail — the left column of the shell.
 *
 * ── THREE PLAIN GROUPS, TOP TO BOTTOM ─────────────────────────────────────────────────
 *
 *   WORKSPACES   every workspace, listed — All workspaces first — so what the page is
 *                scoped to, and the way to change it, are on screen without opening a menu.
 *                One click switches. Past `RAIL_WORKSPACE_LIMIT` the rest sit behind "More
 *                workspaces", which opens the searchable switcher.
 *   VIEWS        what you can look at in that scope: Tasks (with its projects under it),
 *                Queue, Graph, Milestones, Estimates.
 *   THIS COMPUTER  at the foot, apart from the workspace's views, because it reads the same
 *                whichever workspace is chosen: Usage. Under it, Settings and the theme.
 *
 * The global verbs — find anything, New task — moved to the top bar, where the page's
 * primary action belongs (see AppShell). The rail is only where you are.
 *
 * ── THE REGISTER ──────────────────────────────────────────────────────────────────────
 *
 * Rows are 32px (text-body, 13px), 8px corners, an icon or a letter tile in the tertiary
 * tone. The ACTIVE row is unmistakable: a filled surface, medium weight, foreground icon.
 * Group labels are text-label, sentence case, tertiary. Every control has the one focus
 * ring (`focus-ring-inset`, inside the row so the rail's edge never clips it).
 *
 * ── ROWS ARE BUTTONS, GROUPS ARE SECTIONS ─────────────────────────────────────────────
 *
 * A view row is a `<button>` with `aria-current="page"`; a workspace row carries
 * `aria-current="true"` (it is a place, not the page). A group is a `<section>` headed by a
 * real disclosure button (`aria-expanded`), so a folded group is a fact a screen reader
 * hears. Projects hang off Tasks exactly as before: the `+` makes one, each project row
 * narrows Tasks to it, and its gear opens its settings.
 *
 * ── ON A PHONE ────────────────────────────────────────────────────────────────────────
 *
 * The same component is the phone's menu drawer, and there it keeps its phone shape: no
 * workspace list (the top bar's switcher pill is the phone's), 44px rows, and a close
 * button in place of the collapse control.
 */
import {
  ChevronDown,
  Cog,
  FolderKanban,
  LayoutGrid,
  Moon,
  PanelLeftClose,
  Plus,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useCompactHeader } from "@/components/filters/useCompactHeader";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projectsForWorkspace } from "@/lib/projects";
import { isResolvedStatus } from "@/lib/settings";
import { openProjectDialog, openSettings } from "@/lib/shell-events";
import { scopeName, useSession, type ViewName } from "@/lib/session";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, chooseRailWorkspace, projectCaption, railWorkspaces, type NavGroup, type NavItem } from "./nav-model";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const THEME_KEY = "staple:theme";

/**
 * One rail row. The active row is marked with `aria-current` and the styling reads that
 * attribute rather than a prop, so the DOM and the paint cannot disagree.
 */
export const RAIL_ROW_CLASS = cn(
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-body font-normal focus-ring-inset",
  // In the phone's drawer every row is a 44px target at a readable size; under a finger on a
  // desk-width tablet it is a 44px target too.
  "max-md:h-11 max-md:gap-3 max-md:text-[15px] pointer-coarse:h-11",
  "text-sidebar-foreground/85 transition-colors duration-(--motion-duration-fast) hover:bg-surface-hover hover:text-foreground",
  "aria-[current]:bg-surface-selected aria-[current]:font-medium aria-[current]:text-foreground",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-tertiary hover:[&_svg]:text-foreground aria-[current]:[&_svg]:text-foreground",
);

/** A group's label: sentence case, tertiary, and a real disclosure button. */
const GROUP_LABEL_CLASS =
  "group flex h-7 w-full items-center gap-1 rounded-md px-2 text-label font-medium text-text-tertiary hover:text-foreground focus-ring-inset max-md:h-11 max-md:text-[13px] pointer-coarse:h-11";

/**
 * An icon button that sits on a row's right edge: invisible until the row is hovered or
 * the button is focused, but always in the tab order — a control that only a mouse can
 * find is not a control.
 */
const ROW_ACTION_CLASS = cn(
  "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
  "text-text-tertiary opacity-0 transition-opacity focus-ring-inset",
  "group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-surface-active hover:text-foreground",
  // A touch screen has no hover: the action is simply always there, at thumb size.
  "[@media(hover:none)]:opacity-100 max-md:right-0 max-md:size-11 pointer-coarse:right-0 pointer-coarse:size-11",
);

/** A control's tooltip: the words, then the shortcut in mono. */
function Hint({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {keys ? <span className="ml-1.5 font-mono text-caption opacity-70">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The app's mark: a half-filled circle on an ink tile. */
export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-foreground leading-none text-background",
        large ? "size-6 text-[14px]" : "size-5 text-[12px]",
      )}
    >
      &#9680;
    </span>
  );
}

/**
 * The tracked projects, one sub-row each, under the row that hosts them.
 *
 * A row is ACTIVE when Tasks is on screen filtered to exactly that project — the state
 * a click on it produces — and says so with `aria-current="true"` (not `page`: the page
 * is Tasks, this is a place within it). The count is the project's OPEN issues from the
 * rows the page already holds — no second fetch — and gives way to the gear on hover.
 * Nothing renders while the list is empty: the `+` on the host row is the affordance.
 */
function ProjectSubItems({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession();
  // The page's list is every workspace's (see lib/projects.ts); the rail shows the ones
  // the page is on — all of them on "All workspaces", one workspace's otherwise.
  const rows = useMemo(
    () => projectsForWorkspace(session.projects.data ?? [], session.ws),
    [session.projects.data, session.ws],
  );
  const workspaces = useMemo(() => new Set(rows.map((row) => row.workspace)), [rows]);
  const openCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of session.issues.data ?? []) {
      const id = row.issue.projectId;
      if (!id || isResolvedStatus(row.issue.status)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [session.issues.data]);
  const selected = session.filters.dims.project ?? [];
  const activeId = session.view === "tree" && selected.length === 1 ? selected[0] : null;
  if (rows.length === 0) return null;
  return (
    <ul role="list" data-nav-projects>
      {rows.map((row) => {
        const { project } = row;
        const caption = projectCaption(row.workspace, workspaces);
        const open = openCounts.get(project.id) ?? 0;
        return (
          <li key={`${row.workspace}/${project.id}`} className="group/row relative">
            <button
              type="button"
              data-nav-project={project.id}
              aria-current={activeId === project.id ? "true" : undefined}
              title={caption ? `${project.name} · ${row.workspace}` : project.name}
              onClick={() => {
                session.focusProject(project.id);
                onNavigate?.();
              }}
              // One indent step: the glyph lands at the parent's icon x plus 16px.
              className={cn(RAIL_ROW_CLASS, "pr-8 pl-7 max-md:pr-12")}
            >
              <FolderKanban aria-hidden />
              <span className="truncate">{project.name}</span>
              {caption ? (
                <span className="ml-auto shrink-0 text-caption text-text-tertiary">{caption}</span>
              ) : null}
              <span
                data-nav-project-count
                aria-label={`${open} open`}
                className={cn(
                  "shrink-0 text-caption font-normal text-text-tertiary tabular-nums transition-opacity",
                  !caption && "ml-auto",
                  "group-hover/row:opacity-0 group-focus-within/row:opacity-0 [@media(hover:none)]:opacity-100",
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
              onClick={() => {
                // The sheet closes BEFORE the dialog opens, so a dialog never stacks on
                // it and Escape in the dialog closes the dialog alone.
                onNavigate?.();
                openProjectDialog({ mode: "edit", row });
              }}
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

function NavItemRow({
  entry,
  view,
  onSelect,
  onNavigate,
}: {
  entry: NavItem;
  view: ViewName;
  onSelect: (view: ViewName) => void;
  onNavigate?: () => void;
}) {
  const session = useSession();
  const Icon = entry.icon;
  const active = entry.view === view;
  return (
    <li>
      <div className="group/row relative">
        <button
          type="button"
          data-nav-item={entry.id}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(entry.view)}
          className={cn(RAIL_ROW_CLASS, entry.action && "pr-8 max-md:pr-12 pointer-coarse:pr-12")}
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
            onClick={() => {
              // Sheet first, dialog second — see the gear in ProjectSubItems for why.
              onNavigate?.();
              openProjectDialog({ mode: "create", workspace: session.ws || undefined });
            }}
            className={ROW_ACTION_CLASS}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {entry.subItems === "projects" ? <ProjectSubItems onNavigate={onNavigate} /> : null}
    </li>
  );
}

/** A labelled, foldable group of rows. */
function RailSection({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const headingId = `nav-group-${id}`;
  const listId = `nav-group-${id}-items`;
  return (
    <section aria-labelledby={headingId} data-nav-group={id} className={cn("mt-5 first:mt-0", className)}>
      <button
        type="button"
        id={headingId}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        data-nav-group-label
        className={GROUP_LABEL_CLASS}
      >
        <span data-nav-group-name className="truncate">
          {label}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-visible:opacity-100",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? (
        <ul id={listId} role="list" className="flex flex-col gap-px">
          {children}
        </ul>
      ) : null}
    </section>
  );
}

function NavGroupSection({
  group,
  label,
  view,
  onSelect,
  onNavigate,
  className,
}: {
  group: NavGroup;
  label: string;
  view: ViewName;
  onSelect: (view: ViewName) => void;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <RailSection id={group.id} label={label} className={className}>
      {group.items.map((entry) => (
        <NavItemRow key={entry.id} entry={entry} view={view} onSelect={onSelect} onNavigate={onNavigate} />
      ))}
    </RailSection>
  );
}

/**
 * Every workspace, one click each — the scope, visible and changeable without a menu.
 * A workspace row is marked `aria-current="true"` when it is the one the page shows.
 */
function WorkspaceRows() {
  const session = useSession();
  const { rows, hidden } = railWorkspaces(session);
  const hub = session.mode === "hub";
  if (rows.length === 0) return null;
  return (
    <RailSection id="workspaces" label={hub ? "Workspaces" : "Workspace"}>
      {rows.map((row) => (
        <li key={row.value || "__all__"}>
          <button
            type="button"
            data-nav-workspace={row.value}
            aria-current={row.current ? "true" : undefined}
            title={row.value ? `Show ${row.name}` : "Show every workspace together"}
            onClick={() => chooseRailWorkspace(session, row)}
            className={RAIL_ROW_CLASS}
          >
            {row.value === "" ? (
              <LayoutGrid aria-hidden />
            ) : (
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-[5px] text-[10px] leading-none font-semibold",
                  row.current ? "bg-foreground text-background" : "bg-surface-active text-text-secondary",
                )}
              >
                {row.initials}
              </span>
            )}
            <span className="truncate">{row.name}</span>
          </button>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <WorkspaceSwitcher variant="more" moreCount={hidden} />
        </li>
      ) : null}
    </RailSection>
  );
}

/** The theme, as a switch: a row on the phone, an icon beside Settings on a desk. */
function ThemeToggle({ asRow }: { asRow: boolean }) {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      /* private mode: the choice lasts for this page load */
    }
  }, [dark]);
  const props = {
    type: "button" as const,
    role: "switch",
    "aria-checked": dark,
    "aria-label": "Dark mode",
    "data-nav-theme": "",
    onClick: () => setDark((d) => !d),
  };
  if (asRow) {
    return (
      <button {...props} className={RAIL_ROW_CLASS}>
        {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
        Dark mode
      </button>
    );
  }
  return (
    <Hint label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      <button
        {...props}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-hover hover:text-foreground focus-ring-inset pointer-coarse:size-11"
      >
        {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      </button>
    </Hint>
  );
}

export function NavRail({
  onHide,
  onNavigate,
}: {
  /** Collapse the rail (desktop) or close the overlay (narrow). */
  onHide: () => void;
  /** Called after any row is chosen — the overlay uses it to close itself. */
  onNavigate?: () => void;
}) {
  const session = useSession();
  const phone = useCompactHeader();
  const select = (view: ViewName) => {
    session.setView(view);
    onNavigate?.();
  };
  const [views, machine] = NAV_GROUPS;

  return (
    <nav
      aria-label="Primary"
      data-nav-rail
      className="flex h-full w-rail shrink-0 flex-col bg-sidebar text-sidebar-foreground max-md:w-[min(18rem,85vw)]"
    >
      {/* ── the mark, and the way to put the rail away. Level with the top bar. ── */}
      {/* The content card starts one gutter down, so this row does too: the two centres line up. */}
      <div className="flex h-topbar shrink-0 items-center gap-2 pr-2 pl-4 md:mt-gutter max-md:h-auto max-md:min-h-14 max-md:pl-3">
        {phone ? (
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher />
          </div>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2" data-nav-brand>
            <BrandMark />
            <span className="truncate text-body font-semibold tracking-[var(--tracking-heading)]">staple</span>
          </span>
        )}
        {/*
          A desk collapses the rail; a phone's drawer has nothing to collapse, so it offers a
          plain close instead (the scrim and the system Back close it too).
        */}
        <Hint label="Hide navigation" keys="[">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Hide navigation"
            onClick={onHide}
            // A tablet is a desk layout under a finger: its controls are 44px there too.
            className="size-8 rounded-lg text-text-tertiary hover:text-foreground max-md:hidden pointer-coarse:size-11"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </Hint>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close menu"
          data-nav-close
          onClick={onHide}
          className="size-11 text-text-tertiary hover:text-foreground md:hidden"
        >
          <X className="size-5" />
        </Button>
      </div>

      {/* ── where you are: the workspace, then what you can look at in it ── */}
      <div className="staple-momentum flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-3 max-md:px-2.5">
        {phone ? null : <WorkspaceRows />}
        <NavGroupSection
          group={views!}
          // A phone has no workspace list above, so its views group is named for the scope.
          label={phone ? scopeName(session) : views!.label}
          view={session.view}
          onSelect={select}
          onNavigate={onNavigate}
        />
        <NavGroupSection
          group={machine!}
          label={machine!.label}
          view={session.view}
          onSelect={select}
          onNavigate={onNavigate}
          // Pushed to the foot on a desk: it is about the computer, not the workspace above.
          className="md:mt-auto md:pt-5"
        />
      </div>

      {/* ── the foot: Settings, and the theme ── */}
      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border/70 px-3 py-2 max-md:block max-md:px-2.5">
        <button
          type="button"
          aria-label="Settings"
          title="Settings — this computer and every workspace"
          data-nav-settings
          onClick={() => {
            openSettings();
            onNavigate?.();
          }}
          className={RAIL_ROW_CLASS}
        >
          <Settings aria-hidden />
          Settings
        </button>
        <ThemeToggle asRow={phone} />
      </div>
    </nav>
  );
}
