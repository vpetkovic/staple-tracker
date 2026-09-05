/**
 * The navigation rail — the left column of the shell.
 *
 * Top to bottom, Linear's order: the workspace switcher; a bordered New task button
 * beside a bordered search button; the grouped views from `nav-model.ts`; and at the
 * foot, where Linear keeps them, Settings and Dark mode as ordinary rows above a
 * hairline. Everything the old two-tier header held is here, and nothing here decides
 * what the view shows — that is the content header's job (see AppShell.tsx).
 *
 * ── The register ──────────────────────────────────────────────────────────────────────
 *
 * Rows are 28px, 13px text, 6px corners, 8px of side padding, no gap between them.
 * Icons are 16px in the tertiary tone and take the foreground when the row is hovered or
 * active; the active row is a fill (`surface-selected`) and NOTHING ELSE — no weight
 * change, because a bold row in a 13px list reads as a heading, not a selection. The
 * group label is sentence case, 12px, muted, with its collapse chevron shown on hover
 * and focus only. Shortcuts live in tooltips, not in chips beside the words.
 *
 * ── Rows are buttons, groups are sections ─────────────────────────────────────────────
 *
 * A view row is a `<button>` with `aria-current="page"` when it is the view on screen. Not
 * a link — there is no URL per view — and not a Radix Tab, because the rows control no
 * `TabsContent`: App.tsx swaps the view. A group is a `<section>` headed by a real
 * disclosure button (`aria-expanded`), so a folded group is a fact a screen reader hears
 * rather than a row that went missing.
 *
 * ── Projects hang off Tasks ───────────────────────────────────────────────────────────
 *
 * The Tasks row carries a `+` (visible on hover and focus, always in the tab order) that
 * opens the project dialog, and lists every tracked project beneath itself, each with a
 * project glyph one indent step in, its open-task count on the right, and a gear on
 * hover that opens the same dialog on that project. A project row does one thing:
 * `focusProject` — switch to Tasks and narrow it to that project. Which row does what is
 * data in `nav-model.ts` (`action`, `subItems`); the rail maps the ids to verbs.
 */
import {
  ChevronDown,
  Cog,
  FolderKanban,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { projectsForWorkspace } from "@/lib/projects";
import { isResolvedStatus } from "@/lib/settings";
import { openCommandPalette, openCreateIssue, openProjectDialog, openSettings } from "@/lib/shell-events";
import { useSession, type ViewName } from "@/lib/session";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, projectCaption, type NavGroup, type NavItem } from "./nav-model";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const THEME_KEY = "staple:theme";

/**
 * One rail row. The active row is marked with `aria-current` and the styling reads
 * that attribute rather than a prop so the DOM and the paint cannot disagree. The icon
 * follows the row: tertiary at rest, foreground when hovered or current.
 */
export const RAIL_ROW_CLASS = cn(
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-normal outline-none",
  "text-sidebar-foreground/90 transition-colors hover:bg-surface-hover hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
  "aria-[current]:bg-surface-selected aria-[current]:text-foreground",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-tertiary hover:[&_svg]:text-foreground aria-[current]:[&_svg]:text-foreground",
);

/**
 * An icon button that sits on a row's right edge: invisible until the row is hovered or
 * the button is focused, but always in the tab order — a control that only a mouse can
 * find is not a control.
 */
const ROW_ACTION_CLASS = cn(
  "absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded",
  "text-text-tertiary opacity-0 transition-opacity outline-none",
  "group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:bg-surface-active hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
);

/** A control's tooltip: the words, then the shortcut in mono, the way Linear labels its buttons. */
function Hint({ label, keys, children }: { label: string; keys?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {keys ? <span className="ml-1.5 font-mono text-[11px] opacity-70">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
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
              className={cn(RAIL_ROW_CLASS, "pr-7 pl-6")}
            >
              <FolderKanban aria-hidden />
              <span className="truncate">{project.name}</span>
              {caption ? (
                <span className="ml-auto shrink-0 text-[11px] text-text-tertiary">{caption}</span>
              ) : null}
              <span
                data-nav-project-count
                aria-label={`${open} open`}
                className={cn(
                  "shrink-0 font-mono text-[11px] text-text-tertiary tabular-nums transition-opacity",
                  !caption && "ml-auto",
                  "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
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
          className={cn(RAIL_ROW_CLASS, entry.action && "pr-7")}
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

function NavGroupSection({
  group,
  view,
  onSelect,
  onNavigate,
}: {
  group: NavGroup;
  view: ViewName;
  onSelect: (view: ViewName) => void;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const headingId = `nav-group-${group.id}`;
  const listId = `nav-group-${group.id}-items`;
  return (
    <section aria-labelledby={headingId} data-nav-group={group.id} className="mt-4 first:mt-0">
      <button
        type="button"
        id={headingId}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        data-nav-group-label
        className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        {group.label}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 opacity-0 transition-[opacity,transform] group-hover:opacity-100 group-focus-visible:opacity-100",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? (
        <ul id={listId} role="list">
          {group.items.map((entry) => (
            <NavItemRow key={entry.id} entry={entry} view={view} onSelect={onSelect} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The theme, as an ordinary rail row rather than a lone icon. */
function ThemeRow() {
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      data-nav-theme
      onClick={() => setDark((d) => !d)}
      className={RAIL_ROW_CLASS}
    >
      {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
      Dark mode
    </button>
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
  const select = (view: ViewName) => {
    session.setView(view);
    onNavigate?.();
  };

  return (
    <nav
      aria-label="Primary"
      data-nav-rail
      className="flex h-full w-[232px] shrink-0 flex-col bg-sidebar text-sidebar-foreground"
    >
      {/* ── the switcher, and the way to put the rail away. 40px, level with the content header. ── */}
      <div className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-2.5">
        <WorkspaceSwitcher />
        <Hint label="Hide navigation" keys="[">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Hide navigation"
            onClick={onHide}
            className="size-7 text-text-tertiary hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
          </Button>
        </Hint>
      </div>

      {/* ── the two global verbs on one row: make a task, find anything ── */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2.5">
        <Hint label="New task" keys="C">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              openCreateIssue();
              onNavigate?.();
            }}
            data-nav-new-task
            className="h-7 flex-1 justify-start gap-2 px-2 text-[13px] font-normal"
          >
            <SquarePen className="size-4 text-text-tertiary" aria-hidden />
            New task
          </Button>
        </Hint>
        <Hint label="Search and commands" keys="⌘K">
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Open the command palette"
            data-nav-search
            onClick={() => {
              openCommandPalette();
              onNavigate?.();
            }}
            className="size-7 shrink-0 text-text-tertiary hover:text-foreground"
          >
            <Search className="size-4" aria-hidden />
          </Button>
        </Hint>
      </div>

      {/* ── the views, grouped ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-3">
        {NAV_GROUPS.map((group) => (
          <NavGroupSection
            key={group.id}
            group={group}
            view={session.view}
            onSelect={select}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      {/* ── the foot: what changes the workspace or the page, not the view ── */}
      <div className="shrink-0 border-t px-2.5 py-2">
        <button
          type="button"
          aria-label="Work Workspace Settings"
          title="Work Workspace Settings"
          onClick={() => {
            openSettings();
            onNavigate?.();
          }}
          className={RAIL_ROW_CLASS}
        >
          <Settings aria-hidden />
          Settings
        </button>
        <ThemeRow />
      </div>
    </nav>
  );
}
