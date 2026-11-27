/**
 * THE PHONE'S NAVIGATION: a bottom tab bar of five (Inbox, Autopilot, Queue, Tasks, More) and
 * the More sheet, which is the rest of the desk's rail. A phone has no rail and no drawer:
 * these two are its one menu.
 *
 * Why a tab bar: a phone's bottom edge is where the thumb already is, and a tab bar keeps the
 * top destinations one tap away and always visible, and says where you are without reading a
 * header. It is the pattern both iOS (UITabBar) and Android (Material navigation bar) teach
 * for this job, and both cap it at five: past five, each tab is too narrow to name and to hit.
 *
 * Why these four (`TAB_VIEWS` in lib/session.ts): the Inbox is what waits on a person and
 * Autopilot is what agents are doing, the two things a phone is opened to check, so they lead
 * and wear their marks (what waits, a dot while a run is live). Queue is what they take next,
 * and Tasks is the work itself.
 *
 * The fifth tab is More, a sheet in the rail's order: the scope's other views (Graph,
 * Milestones, Plan with planning on, Estimates); its projects (each narrows Tasks to itself,
 * each with its settings, then New project); and This computer (Usage, Integrations, Settings,
 * Dark mode). More is drawn as current while one of its views is on screen. The sheet closes
 * before any dialog it opens, so a dialog never stacks on it.
 *
 * The bar sits on the home-indicator safe area and never covers content: it is a flex item
 * below `<main>`, not an overlay, so every view's own scroll container ends above it.
 */
import { Cog, FolderKanban, Moon, MoreHorizontal, Plug, Plus, Settings, Sun } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useInboxBadge } from "@/lib/attention";
import { useBackToClose } from "@/lib/back-to-close";
import { usePendingJoinRequests } from "@/lib/pending-requests";
import { useRuns } from "@/lib/runs";
import { useConnection } from "@/lib/useStaple";
import { TAB_VIEWS, VIEW_LABELS, VIEW_SHORT_LABELS, navigateTo, useSession, type ViewName } from "@/lib/session";
import { useTheme } from "@/lib/theme";
import { openProjectDialog, openSettings } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { BottomSheet } from "./BottomSheet";
import { projectCaption, viewIcon } from "./nav-model";
import { AttentionMark, countBadgeClass, FORCED_CURRENT_CLASS, MARK_CLASS, STALE_MARKS_CLASS, PendingMark, useFocusOnClose, useIntegrationsAttention, useScopeProjects } from "./nav-shared";
import { autopilotTabLabel, inboxTabLabel, liveDotTone, moreIsCurrent, moreSheetViews, tabBadgeText } from "./top-nav-model";

const TAB_CLASS = cn(
  "flex min-h-[3.25rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 pt-1.5 pb-1 outline-none",
  "focus-ring-inset focus-visible:bg-surface-hover active:bg-surface-hover",
  "text-text-tertiary aria-[current]:text-foreground",
);

/** One tab: the icon in its pill (filled when current), a mark at the icon's top right, the name under it. */
function Tab({
  id,
  label,
  name,
  icon,
  current,
  mark,
  onClick,
  popup,
}: {
  id: string;
  label: string;
  name: string;
  icon: ReactNode;
  current: boolean;
  mark?: ReactNode;
  onClick: () => void;
  popup?: { expanded: boolean };
}) {
  return (
    <button
      type="button"
      data-view-tab={id}
      aria-current={current ? "page" : undefined}
      aria-label={label}
      aria-haspopup={popup ? "dialog" : undefined}
      aria-expanded={popup ? popup.expanded : undefined}
      onClick={onClick}
      className={TAB_CLASS}
    >
      <span
        aria-hidden
        className={cn(
          "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors",
          // Forced colours replace the fill: the current tab's pill is outlined in Highlight instead.
          current && "bg-surface-selected forced-colors:outline-2 forced-colors:outline-[Highlight] forced-colors:-outline-offset-2",
        )}
      >
        {icon}
        {mark}
      </span>
      <span className={cn("max-w-full truncate text-[10.5px] leading-tight", current && "font-semibold")}>{name}</span>
    </button>
  );
}

/**
 * The bar, from what it is given — presentational, so a test renders it to markup. `waiting`
 * is the Inbox badge's total, `live` how many runs are live and `liveTone` their dot's tone.
 */
export function ViewTabs({
  view,
  waiting,
  fresh = false,
  stale = false,
  live,
  liveTone,
  moreOpen,
  onSelect,
  onMore,
}: {
  view: ViewName;
  waiting: number;
  /** Some of what waits is new to this browser: the badge takes the accent. */
  fresh?: boolean;
  /** The server is not answering: the badge and the dot are the last ones heard, and dim. */
  stale?: boolean;
  live: number;
  liveTone: "ok" | "tight" | null;
  moreOpen: boolean;
  onSelect: (view: ViewName) => void;
  onMore: () => void;
}) {
  const badge = tabBadgeText(waiting);
  const more = moreIsCurrent(view);
  return (
    <nav
      aria-label="Views"
      data-view-tabs
      data-stale={stale ? "" : undefined}
      className={cn(STALE_MARKS_CLASS, "flex shrink-0 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/85")}
    >
      {TAB_VIEWS.map((tab) => {
        const Icon = viewIcon(tab);
        const current = view === tab;
        let mark: ReactNode = null;
        let label = VIEW_LABELS[tab];
        if (tab === "attention") {
          label = inboxTabLabel(waiting);
          mark = badge ? (
            <span
              data-view-tab-badge
              data-nav-mark
              className={cn("absolute -top-0.5 left-[1.6875rem]", countBadgeClass(fresh, "card"))}
            >
              {badge}
            </span>
          ) : null;
        } else if (tab === "autopilot") {
          label = autopilotTabLabel(live);
          mark = liveTone ? (
            <span
              data-view-tab-live={liveTone}
              data-nav-mark
              className="absolute top-0.5 left-[1.875rem] size-2 rounded-full ring-2 ring-card forced-color-adjust-none"
              style={{ backgroundColor: `var(--plain-${liveTone}-fg)` }}
            />
          ) : null;
        }
        return (
          <Tab
            key={tab}
            id={tab}
            label={label}
            name={VIEW_SHORT_LABELS[tab]}
            icon={<Icon className="size-[1.2rem]" strokeWidth={current ? 2.25 : 1.75} />}
            current={current}
            mark={mark}
            onClick={() => onSelect(tab)}
          />
        );
      })}
      <Tab
        id="more"
        label="More"
        name="More"
        icon={<MoreHorizontal className="size-[1.2rem]" strokeWidth={more ? 2.25 : 1.75} />}
        current={more}
        onClick={onMore}
        popup={{ expanded: moreOpen }}
      />
    </nav>
  );
}

/** One 48px sheet row's look; the current one is filled. */
const SHEET_ROW_CLASS = cn(
  "flex h-12 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-[15px] text-foreground focus-ring-inset",
  "hover:bg-surface-hover active:bg-surface-hover aria-[current]:bg-surface-selected aria-[current]:font-medium",
  "[&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-text-tertiary aria-[current]:[&_svg]:text-foreground",
  FORCED_CURRENT_CLASS,
);

/** A labelled group of the sheet. */
function SheetSection({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`more-${id}`} data-more-section={id}>
      <h3 id={`more-${id}`} className="m-0 px-3 pt-3 pb-1 text-label font-normal text-text-tertiary">
        {label}
      </h3>
      <ul role="list" className="flex flex-col">
        {children}
      </ul>
    </section>
  );
}

function ViewRow({ entry, view, onChoose }: { entry: ViewName; view: ViewName; onChoose: (view: ViewName) => void }) {
  const Icon = viewIcon(entry);
  return (
    <li>
      <button
        type="button"
        data-more-view={entry}
        aria-current={view === entry ? "page" : undefined}
        onClick={() => onChoose(entry)}
        className={SHEET_ROW_CLASS}
      >
        <Icon aria-hidden />
        <span className="truncate">{VIEW_LABELS[entry]}</span>
      </button>
    </li>
  );
}

/** The sheet's first group, with no label: the scope's views that are not on the bar. */
export function MoreSheetRows({
  view,
  planningEnabled,
  onChoose,
}: {
  view: ViewName;
  planningEnabled: boolean | undefined;
  onChoose: (view: ViewName) => void;
}) {
  const { views } = moreSheetViews(planningEnabled);
  return (
    <ul role="list" data-more-views className="flex flex-col">
      {views.map((entry) => (
        <ViewRow key={entry} entry={entry} view={view} onChoose={onChoose} />
      ))}
    </ul>
  );
}

/** The scope's projects: tap one to narrow Tasks to it, its gear for its settings, then New project. */
function MoreSheetProjects({ onClose, onCloseThen }: { onClose: () => void; onCloseThen: (open: () => void) => void }) {
  const session = useSession();
  const projects = useScopeProjects();
  return (
    <SheetSection id="projects" label="Projects">
      {projects.rows.map((row) => {
        const { project } = row;
        const caption = projectCaption(row.workspace, projects.workspaces);
        const open = projects.openCounts.get(project.id) ?? 0;
        return (
          <li key={`${row.workspace}/${project.id}`} className="flex items-center gap-1">
            <button
              type="button"
              data-more-project={project.id}
              aria-current={projects.activeId === project.id ? "true" : undefined}
              title={caption ? `${project.name} · ${row.workspace}` : project.name}
              onClick={() => {
                onClose();
                session.focusProject(project.id);
              }}
              className={SHEET_ROW_CLASS}
            >
              <FolderKanban aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{project.name}</span>
                {caption ? <span className="truncate text-label font-normal text-text-tertiary">{caption}</span> : null}
              </span>
              <span aria-label={`${open} open`} className={MARK_CLASS}>
                {open}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Project settings: ${project.name}`}
              data-more-project-settings={project.id}
              onClick={() => onCloseThen(() => openProjectDialog({ mode: "edit", row }))}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-hover hover:text-foreground focus-ring-inset"
            >
              <Cog aria-hidden className="size-5" />
            </button>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          data-more-new-project
          onClick={() => onCloseThen(() => openProjectDialog({ mode: "create", workspace: session.ws || undefined }))}
          className={SHEET_ROW_CLASS}
        >
          <Plus aria-hidden />
          <span className="truncate">New project</span>
        </button>
      </li>
    </SheetSection>
  );
}

/** This computer: Usage, Integrations, Analytics, Settings and the theme, the same whichever workspace is chosen. */
function MoreSheetMachine({
  machine,
  foot,
  view,
  onChoose,
  onCloseThen,
}: {
  machine: readonly ViewName[];
  /** The views listed under Integrations, as on the rail. */
  foot: readonly ViewName[];
  view: ViewName;
  onChoose: (view: ViewName) => void;
  onCloseThen: (open: () => void) => void;
}) {
  const attention = useIntegrationsAttention();
  const pending = usePendingJoinRequests();
  // A pure control over the page's theme (lib/theme.ts): it reads the one state and records a pick.
  const [dark, choose] = useTheme();
  return (
    <SheetSection id="machine" label="This computer">
      {machine.map((entry) => (
        <ViewRow key={entry} entry={entry} view={view} onChoose={onChoose} />
      ))}
      <li>
        <button
          type="button"
          data-more-integrations
          onClick={() => onCloseThen(() => openSettings({ section: "integrations" }))}
          className={SHEET_ROW_CLASS}
        >
          <Plug aria-hidden />
          <span className="truncate">Integrations</span>
          {attention ? <AttentionMark /> : null}
        </button>
      </li>
      {foot.map((entry) => (
        <ViewRow key={entry} entry={entry} view={view} onChoose={onChoose} />
      ))}
      <li>
        <button
          type="button"
          data-more-settings
          onClick={() => onCloseThen(() => openSettings())}
          className={SHEET_ROW_CLASS}
        >
          <Settings aria-hidden />
          <span className="truncate">Settings</span>
          <PendingMark pending={pending} />
        </button>
      </li>
      <li>
        <button
          type="button"
          role="switch"
          aria-checked={dark}
          data-more-theme
          onClick={() => choose(!dark)}
          className={SHEET_ROW_CLASS}
        >
          {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
          <span className="truncate">Dark mode</span>
          <span
            aria-hidden
            className={cn(
              "ml-auto flex h-5 w-8 shrink-0 items-center rounded-full p-0.5 transition-colors",
              dark ? "justify-end bg-foreground" : "justify-start bg-surface-active",
            )}
          >
            <span className="size-4 rounded-full bg-background shadow-xs" />
          </span>
        </button>
      </li>
    </SheetSection>
  );
}

/**
 * The sheet's three sections, from the page's session: other views, Projects, This computer.
 * `onCloseThen` closes the sheet and opens a dialog once the More tab has the focus back, so the
 * dialog returns the focus there when it closes.
 */
export function MoreSheetBody({
  onChoose,
  onClose,
  onCloseThen,
}: {
  onChoose: (view: ViewName) => void;
  onClose: () => void;
  onCloseThen: (open: () => void) => void;
}) {
  const session = useSession();
  const { machine, foot } = moreSheetViews(session.planningEnabled);
  return (
    <>
      <MoreSheetRows view={session.view} planningEnabled={session.planningEnabled} onChoose={onChoose} />
      <MoreSheetProjects onClose={onClose} onCloseThen={onCloseThen} />
      <MoreSheetMachine machine={machine} foot={foot} view={session.view} onChoose={onChoose} onCloseThen={onCloseThen} />
    </>
  );
}

export function ViewTabBar() {
  const session = useSession();
  const { waiting, unseen } = useInboxBadge();
  const connection = useConnection();
  const { live } = useRuns();
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = () => setMoreOpen(false);
  // A dialog the sheet opens waits for the sheet to go and the More tab to take the focus.
  const afterClose = useRef<(() => void) | null>(null);
  const closeMoreThen = (open: () => void) => {
    afterClose.current = open;
    closeMore();
  };
  // Phone Back closes the sheet rather than leaving the page.
  useBackToClose(moreOpen, closeMore);
  // When the sheet closes, the More tab takes the focus back.
  useFocusOnClose(moreOpen, () => document.querySelector<HTMLElement>('[data-view-tab="more"]'), true, afterClose);
  const choose = (view: ViewName) => {
    closeMore();
    navigateTo(session, view);
  };
  return (
    <>
      <ViewTabs
        view={session.view}
        waiting={waiting}
        fresh={unseen > 0}
        stale={connection === "reconnecting"}
        live={live.length}
        liveTone={liveDotTone(live)}
        moreOpen={moreOpen}
        onSelect={(view) => navigateTo(session, view)}
        onMore={() => setMoreOpen(true)}
      />
      <BottomSheet open={moreOpen} onOpenChange={setMoreOpen} title="More" name="more-views">
        <MoreSheetBody onChoose={choose} onClose={closeMore} onCloseThen={closeMoreThen} />
      </BottomSheet>
    </>
  );
}
