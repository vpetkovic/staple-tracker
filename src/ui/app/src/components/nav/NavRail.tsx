/**
 * The navigation rail — the left column of the shell.
 *
 * Top to bottom, Linear's order: the workspace switcher; New task, first and unmistakably
 * a button; the palette trigger; the grouped views from `nav-model.ts`; and at the foot,
 * where Linear keeps them, the workspace settings and the theme toggle. Everything the
 * old two-tier header held is here, and nothing here decides what the view shows — that
 * is the content header's job (see AppShell.tsx).
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
 * opens the project dialog, and lists every tracked project beneath itself. A project
 * row does one thing: `focusProject` — switch to Tasks and narrow it to that project. Its
 * gear opens the same dialog on that project. Which row does what is data in
 * `nav-model.ts` (`action`, `subItems`); the rail maps the ids to verbs and draws
 * whatever `NAV_GROUPS` says.
 */
import { ChevronDown, Cog, Moon, PanelLeftClose, Plus, Search, Settings, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { openCommandPalette, openCreateIssue, openProjectDialog, openSettings } from "@/lib/shell-events";
import { useSession, type ViewName } from "@/lib/session";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, projectCaption, type NavGroup, type NavItem } from "./nav-model";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const THEME_KEY = "staple:theme";

/**
 * One rail row. The active row is marked with `aria-current="page"`, and the styling
 * reads that attribute rather than a prop so the DOM and the paint cannot disagree.
 */
export const RAIL_ROW_CLASS = cn(
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none",
  "text-sidebar-foreground/85 transition-colors hover:bg-surface-hover hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
  "aria-[current]:bg-surface-active aria-[current]:font-medium aria-[current]:text-foreground",
);

/**
 * An icon button that sits on a row's right edge: invisible until the row is hovered or
 * the button is focused, but always in the tab order — a control that only a mouse can
 * find is not a control.
 */
const ROW_ACTION_CLASS = cn(
  "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
  "text-text-tertiary opacity-0 transition-opacity outline-none",
  "group-hover/row:opacity-100 focus-visible:opacity-100 hover:bg-surface-active hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
);

function ThemeToggle() {
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
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setDark((d) => !d)}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="pointer-events-none ml-auto font-sans text-[11px] tracking-[var(--tracking-label)] text-text-tertiary">
      {children}
    </kbd>
  );
}

/**
 * The tracked projects, one sub-row each, under the row that hosts them.
 *
 * A row is ACTIVE when Tasks is on screen filtered to exactly that project — the state
 * a click on it produces — and says so with `aria-current="true"` (not `page`: the page
 * is Tasks, this is a place within it). Nothing renders while the list is empty: the `+`
 * on the host row is the affordance, and an empty-state sentence under every fresh
 * workspace would be furniture.
 */
function ProjectSubItems({ onNavigate }: { onNavigate?: () => void }) {
  const session = useSession();
  const rows = session.projects.data ?? [];
  const workspaces = useMemo(() => new Set(rows.map((row) => row.workspace)), [rows]);
  const selected = session.filters.dims.project ?? [];
  const activeId = session.view === "tree" && selected.length === 1 ? selected[0] : null;
  if (rows.length === 0) return null;
  return (
    <ul role="list" data-nav-projects className="mt-px space-y-px">
      {rows.map((row) => {
        const { project } = row;
        const caption = projectCaption(row.workspace, workspaces);
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
              className={cn(RAIL_ROW_CLASS, "h-7 pr-8 pl-8 text-[12.5px]")}
            >
              <span className="truncate">{project.name}</span>
              {caption ? (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-text-tertiary">{caption}</span>
              ) : null}
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
          className={cn(RAIL_ROW_CLASS, entry.action && "pr-8")}
        >
          <Icon aria-hidden className="size-4 shrink-0 text-text-tertiary" />
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
    <section aria-labelledby={headingId} data-nav-group={group.id} className="mt-3 first:mt-0">
      <button
        type="button"
        id={headingId}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
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
        <ul id={listId} role="list" className="mt-0.5 space-y-px">
          {group.items.map((entry) => (
            <NavItemRow key={entry.id} entry={entry} view={view} onSelect={onSelect} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </section>
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
      className="flex h-full w-[232px] shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground"
    >
      {/* ── the switcher, and the way to put the rail away ── */}
      <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-2.5">
        <WorkspaceSwitcher />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide navigation"
          title="Hide navigation ([)"
          onClick={onHide}
          className="text-text-tertiary hover:text-foreground"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      {/* ── the two global verbs: make a task, find anything ── */}
      <div className="shrink-0 space-y-1 px-2 pb-2">
        {/*
          The primary action, and the one control in the rail that must not read as a
          row: full width, inverse of the page (`cta`), a leading `+`. The `c` shortcut
          still lives in CreateIssueMount; this is the visible way in.
        */}
        <Button
          variant="cta"
          size="sm"
          onClick={() => {
            openCreateIssue();
            onNavigate?.();
          }}
          title="New task (c)"
          data-nav-new-task
          className="w-full justify-start"
        >
          <Plus className="size-4" aria-hidden />
          New task
          <Kbd>
            <span className="text-background/70">C</span>
          </Kbd>
        </Button>
        <button
          type="button"
          aria-label="Open the command palette"
          title="Search and commands (cmd K)"
          onClick={() => {
            openCommandPalette();
            onNavigate?.();
          }}
          className={RAIL_ROW_CLASS}
        >
          <Search className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          Search
          <Kbd>&#8984;K</Kbd>
        </button>
      </div>

      {/* ── the views, grouped ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1">
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
      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-2">
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
          <Settings className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          Settings
        </button>
        <ThemeToggle />
      </div>
    </nav>
  );
}
