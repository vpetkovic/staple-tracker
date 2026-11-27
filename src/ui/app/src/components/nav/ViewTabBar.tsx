/**
 * THE PHONE'S VIEW SWITCHER — a bottom tab bar of five: Inbox, Autopilot, Tasks, Queue, More.
 *
 * Why a tab bar: a phone's bottom edge is where the thumb already is, and a tab bar keeps the
 * top destinations one tap away and always visible, and says where you are without reading a
 * header. It is the pattern both iOS (UITabBar) and Android (Material navigation bar) teach
 * for this job, and both cap it at five: past five, each tab is too narrow to name and to hit.
 *
 * Why these four (`TAB_VIEWS` in lib/session.ts): the Inbox is what waits on a person and
 * Autopilot is what agents are doing, the two things a phone is opened to check, so they lead
 * and wear their marks (what waits, a dot while a run is live). Tasks and Queue are the work
 * itself. The fifth tab is More, a sheet listing every other view (Graph, Milestones, Plan
 * with planning on, Estimates, and This computer's Usage), so every view stays one or two taps
 * away and the bar never scrolls. More is drawn as current while one of those is on screen.
 *
 * The bar sits on the home-indicator safe area and never covers content: it is a flex item
 * below `<main>`, not an overlay, so every view's own scroll container ends above it.
 */
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useInboxBadge } from "@/lib/attention";
import { useBackToClose } from "@/lib/back-to-close";
import { useRuns } from "@/lib/runs";
import { TAB_VIEWS, VIEW_LABELS, VIEW_SHORT_LABELS, navigateTo, useSession, type ViewName } from "@/lib/session";
import { cn } from "@/lib/utils";
import { BottomSheet } from "./BottomSheet";
import { viewIcon } from "./nav-model";
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
        className={cn("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors", current && "bg-surface-selected")}
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
  live,
  liveTone,
  moreOpen,
  onSelect,
  onMore,
}: {
  view: ViewName;
  waiting: number;
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
      className="flex shrink-0 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/85"
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
              className="absolute -top-0.5 left-[1.6875rem] flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] leading-none font-semibold text-background tabular-nums ring-2 ring-card"
            >
              {badge}
            </span>
          ) : null;
        } else if (tab === "autopilot") {
          label = autopilotTabLabel(live);
          mark = liveTone ? (
            <span
              data-view-tab-live={liveTone}
              className="absolute top-0.5 left-[1.875rem] size-2 rounded-full ring-2 ring-card"
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

/** The More sheet's rows: every view not on the bar, 48px each, the machine's under "This computer". */
export function MoreSheetRows({
  view,
  planningEnabled,
  onChoose,
}: {
  view: ViewName;
  planningEnabled: boolean | undefined;
  onChoose: (view: ViewName) => void;
}) {
  const { views, machine } = moreSheetViews(planningEnabled);
  const row = (entry: ViewName) => {
    const Icon = viewIcon(entry);
    return (
      <li key={entry}>
        <button
          type="button"
          data-more-view={entry}
          aria-current={view === entry ? "page" : undefined}
          onClick={() => onChoose(entry)}
          className={cn(
            "flex h-12 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-[15px] text-foreground focus-ring-inset",
            "hover:bg-surface-hover active:bg-surface-hover aria-[current]:bg-surface-selected aria-[current]:font-medium",
          )}
        >
          <Icon aria-hidden className={cn("size-5 shrink-0", view === entry ? "text-foreground" : "text-text-tertiary")} />
          <span className="truncate">{VIEW_LABELS[entry]}</span>
        </button>
      </li>
    );
  };
  return (
    <div data-more-views>
      <ul role="list" className="flex flex-col">
        {views.map(row)}
      </ul>
      {machine.length > 0 ? (
        <section aria-labelledby="more-views-machine">
          <h3 id="more-views-machine" className="m-0 px-3 pt-3 pb-1 text-label font-normal text-text-tertiary">
            This computer
          </h3>
          <ul role="list" className="flex flex-col">
            {machine.map(row)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function ViewTabBar() {
  const session = useSession();
  const { waiting } = useInboxBadge();
  const { live } = useRuns();
  const [moreOpen, setMoreOpen] = useState(false);
  // Phone Back closes the sheet rather than leaving the page.
  useBackToClose(moreOpen, () => setMoreOpen(false));
  // The sheet has no trigger of its own to hand the focus back to: when it closes, the More tab takes it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !moreOpen) {
      const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-view-tab="more"]')?.focus());
      wasOpen.current = false;
      return () => cancelAnimationFrame(frame);
    }
    wasOpen.current = moreOpen;
  }, [moreOpen]);
  return (
    <>
      <ViewTabs
        view={session.view}
        waiting={waiting}
        live={live.length}
        liveTone={liveDotTone(live)}
        moreOpen={moreOpen}
        onSelect={(view) => navigateTo(session, view)}
        onMore={() => setMoreOpen(true)}
      />
      <BottomSheet open={moreOpen} onOpenChange={setMoreOpen} title="More" name="more-views">
        <MoreSheetRows
          view={session.view}
          planningEnabled={session.planningEnabled}
          onChoose={(view) => {
            setMoreOpen(false);
            navigateTo(session, view);
          }}
        />
      </BottomSheet>
    </>
  );
}
