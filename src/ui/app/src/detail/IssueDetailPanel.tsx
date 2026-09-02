/**
 * The detail panel's contents: chrome bar, title, actions, properties, tab slot.
 *
 * This file still knows *nothing* about any individual tab. It reads
 * detail/tabs/registry.ts, renders whatever is in it, and passes every tab the same
 * props — the seam that let U2/U3/U4 each add a file and a registry line without
 * opening this one. V3 rebuilt everything around that seam and did not touch it.
 *
 * The panel owns the fetch, so a tab always gets a loaded `IssueDetail` and never has
 * to handle the "not loaded yet" case itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * V3 (STA-88) — WHAT THE LAYOUT IS NOW, AND WHY
 *
 * The frame is IssueDetailMount's problem; this file is the ClickUp half of the
 * ticket. Four things were taken from ClickUp's task view, in the order they matter:
 *
 *  1. A CHROME BAR THAT IS NOT CONTENT. Identifier, status, ancestry, and the two
 *     controls that act on the frame rather than on the issue (expand, close). It is
 *     fixed height and never scrolls, so the two things you always need — "which
 *     ticket is this" and "how do I get out" — are never below the fold.
 *
 *  2. TITLE FIRST, AT A SIZE THAT ADMITS IT IS THE SUBJECT. The old panel set the
 *     title at 16px under a row of metadata chips, which is a caption. It is now the
 *     first thing in the reading column, and it grows when the panel does.
 *
 *  3. VERBS SEPARATED FROM FACTS. The status/claim/release controls sit in one
 *     bordered strip; everything the issue *is* sits below in an aligned label→value
 *     grid (PropertyGrid). The old panel interleaved them into a wrapping line of
 *     chips where "@vp" and a clickable priority dropdown looked identical.
 *
 *  4. SECTION RHYTHM. Eyebrow, hairline, content — the same three-part beat for
 *     properties and for the tab strip, so the panel has a pulse you can scan
 *     against instead of one continuous column of 11px text.
 *
 * The two modes share one scroll container and one DOM. Expanding does not swap
 * layouts; it moves the property grid from under the actions to a sticky right rail
 * — which is ClickUp's own move at width, and, more practically, the only difference
 * worth having. A second layout would be a second thing to keep correct.
 */
import { ChevronDown, ChevronRight, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { StaleClaimBadge } from "@/components/StaleClaimBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getIssue } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { isStaleClaim } from "@/lib/claim";
import { useSession, type Selection } from "@/lib/session";
import type { IssueDetail, UiMode } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import type { DetailMode } from "./drawer";
import type { NavState, NavTarget } from "./navigation";
import { IssueActions } from "./IssueActions";
import { InlineLabels, InlinePriority, InlineTitle } from "./InlineProperties";
import { FactRow, PropertyGrid, type PropertyLayout } from "./PropertyGrid";
import { detailFacts } from "./properties";
import { onOpenDetailTab, visibleTabs } from "./tabs/registry";

export function IssueDetailPanel({
  selection,
  mode,
  onToggleMode,
  nav,
  onNavigate,
  onClose,
  onAuthError,
}: {
  selection: Selection;
  mode: DetailMode;
  onToggleMode: () => void;
  nav: NavState;
  onNavigate: (target: NavTarget | null) => void;
  onClose: () => void;
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  const [tab, setTab] = useState("overview");
  const expanded = mode === "full";

  /**
   * A tab asking to hand the reader to another tab — W3 (STA-115). Overview's worklog
   * panel has a "Show all" that belongs on Documents, and this file still knows nothing
   * about either: it subscribes to a verb and sets its own state. See the comment on
   * `onOpenDetailTab` in tabs/registry.ts for why this is an event and not a prop.
   */
  useEffect(() => onOpenDetailTab(setTab), []);

  const load = useCallback(
    () => getIssue({ ws: selection.workspace, ref: selection.ref }),
    [selection.workspace, selection.ref],
  );
  const resource = useResource(load, [selection.workspace, selection.ref, session.version], onAuthError);

  const detail = resource.data;
  const issue = detail?.issue;
  const stale = isStaleClaim(detail?.claim);
  const tabs = detail ? visibleTabs(detail) : [];
  const active = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "overview");

  return (
    // `aria-label` and the `aside` role are kept from the pre-V3 panel on purpose:
    // they are what the evidence scripts select on, and there was no reason to break
    // them just because the element moved into a portal.
    <aside aria-label="Issue detail" className="flex h-full min-h-0 flex-col">
      {/* ── chrome ────────────────────────────────────────────────────────────
          A fixed 44px bar rather than padding-derived height: this and the app
          header are the persistent chrome on the page, and when their heights are
          computed from different padding they never quite line up across a resize. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 pr-2">
        <span className="font-mono text-[11px] text-text-tertiary">{selection.ref}</span>
        {issue ? <StatusBadge status={issue.status} /> : null}

        {/* Ancestry as a breadcrumb, and clickable — the old panel printed the same
            path as inert mono text two lines down, which is the one place in this
            app you most want to navigate FROM. Truncated rather than wrapped: the
            bar is fixed-height and a deep tree must not push the controls out. */}
        {detail && detail.ancestors.length > 0 ? (
          <nav aria-label="Ancestry" className="flex min-w-0 items-center gap-0.5 text-[11px]">
            <ChevronRight aria-hidden className="size-3 shrink-0 text-text-tertiary" />
            {detail.ancestors.map((ancestor, index) => (
              <span key={ancestor.id} className="flex min-w-0 items-center gap-0.5">
                {index > 0 ? (
                  <ChevronRight aria-hidden className="size-3 shrink-0 text-text-tertiary" />
                ) : null}
                <button
                  type="button"
                  title={ancestor.title}
                  onClick={() => session.open(detail.workspace, ancestor.identifier)}
                  className="hover:bg-surface-hover truncate rounded-sm px-1 py-0.5 font-mono text-text-tertiary hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
                >
                  {ancestor.identifier}
                </button>
              </span>
            ))}
          </nav>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {/* ── prev/next (R6 / STA-106) ─────────────────────────────────────
              Left of the frame controls, and separated from them by a hairline,
              because they are answering a different question. Expand and close act
              on this panel; these two act on WHICH ISSUE the panel is showing. Three
              same-sized ghost icon buttons in an undifferentiated row would be four
              controls that all look like chrome, and the one that navigates you away
              from the ticket you are reading is the one worth a beat of separation.

              Up is previous and down is next, matching the list they move through —
              not left/right, which would imply a sequence the list does not have. */}
          <NavButton
            direction="prev"
            target={nav.prev}
            nav={nav}
            onNavigate={onNavigate}
            icon={<ChevronUp className="size-4" />}
          />
          <NavButton
            direction="next"
            target={nav.next}
            nav={nav}
            onNavigate={onNavigate}
            icon={<ChevronDown className="size-4" />}
          />
          <span aria-hidden className="bg-border mx-1 h-4 w-px" />
          <Button
            variant="ghost"
            size="icon"
            aria-label={expanded ? "Collapse to drawer" : "Expand to full screen"}
            aria-pressed={expanded}
            title={expanded ? "Collapse to drawer" : "Expand to full screen"}
            onClick={onToggleMode}
          >
            {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Close detail" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* ── one scroll container, both modes ──────────────────────────────────
          Expanding changes where the property grid sits, not how many scroll
          regions there are. Two independently-scrolling columns is the ClickUp
          detail people complain about — you scroll the wrong one, twice, before
          you learn which is which. A sticky rail inside one scroll gets the same
          layout with one place for the scrollbar to be. */}
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
        {resource.error ? (
          <div className="px-5 py-4">
            <ErrorState error={resource.error} />
          </div>
        ) : null}
        {!detail && resource.loading ? (
          <div className="px-5 py-4">
            <LoadingState rows={4} />
          </div>
        ) : null}

        {detail && issue ? (
          <div
            className={cn(
              "flex w-full flex-col",
              expanded
                ? // R3 (STA-104) MOVED THE CAP IN HERE, and it is the same 86rem it
                  // always was. The panel used to be capped and the content used to
                  // fill it; the panel is now the whole viewport, so if nothing were
                  // capped, a 2560px display would give the description a ~200
                  // character line and strand the property rail a thousand pixels to
                  // its right — the exact "floating with dead space beside it" bug
                  // the first cut had, scaled up.
                  //
                  // Capping HERE rather than back on the panel is the difference
                  // between a page and a modal: the chrome bar, the surface and the
                  // background all still reach the edges; only the reading measure
                  // is bounded, centred by `mx-auto`. That is what Linear, GitHub and
                  // ClickUp's task page all do, for the same reason. Below 1376px —
                  // every laptop this runs on — the cap never engages and this is
                  // byte-identical to what shipped.
                  "mx-auto max-w-[86rem] gap-8 px-6 pt-6 pb-10 lg:flex-row lg:items-start lg:gap-10 lg:px-10"
                : "px-5 pt-5 pb-8 sm:px-6",
            )}
          >
            {/* The reading measure is capped again, INSIDE the 86rem row, and the rail
                is pushed to the row's edge with `ml-auto` to absorb what is left over.
                Two caps is not redundancy: 86rem bounds the SURFACE the content sits
                on (see the container above), and 56rem bounds the PROSE within it.
                Without the inner one, an 86rem column gives the description a
                ~140-character line and the activity timeline a row with the actor at
                one end and the timestamp 1300px away at the other — technically more
                room, and materially worse to read. 56rem is wide enough for the things
                that genuinely want width here (the revision diff, the agent payload, a
                table) and short enough that prose does not turn into a ribbon. */}
            <div className={cn("flex min-w-0 flex-1 flex-col", expanded && "lg:max-w-[56rem]")}>
              {/* Title. Bigger when the panel is bigger — the reading measure
                  roughly doubles on expand, and a 16px heading in an 80rem column
                  reads as a subtitle to nothing. */}
              <div className={cn(expanded && "[&_h2]:text-[22px] [&_h2]:leading-tight")}>
                <InlineTitle issue={issue} workspace={detail.workspace} refresh={session.refresh} />
              </div>

              {/* The stale-claim badge is the one piece of metadata loud enough to
                  belong above the fold rather than in the property grid. It only
                  ever renders past the silence threshold, so it is never furniture
                  — see StaleClaimBadge. Under the threshold, "held by" is a
                  perfectly ordinary fact and lives in the grid with the others. */}
              {stale && detail.claim ? (
                <div className="mt-3">
                  <StaleClaimBadge claim={detail.claim} variant="detail" />
                </div>
              ) : null}

              {/* ── verbs ──────────────────────────────────────────────────────
                  A bordered, inset strip. In dark mode `--field` sits BELOW the
                  panel surface and in light it sits above it, which is exactly the
                  relationship a control strip wants in each: this reads as a place
                  where things are done, distinct from the facts under it. */}
              {/* `w-fit`, not full width. A bordered strip stretched across a 56rem
                  column with four small controls huddled at its left end reads as an
                  empty box, and an empty box looks like something failed to load. It
                  grows on its own when it has more to say: a guard refusal renders
                  inside it, and `max-w-full` is what stops that growth at the column
                  edge instead of at the sentence's natural width. */}
              <div className="bg-field mt-4 w-fit max-w-full rounded-lg border p-2.5">
                <IssueActions
                  issue={issue}
                  workspace={detail.workspace}
                  claim={detail.claim}
                  refresh={session.refresh}
                />
              </div>

              {/* In the drawer, properties are a section here. Expanded, they are
                  the rail below — one `PropertyGrid`, rendered in one of two
                  places, never both. */}
              {!expanded ? (
                <Section title="Properties" className="mt-6">
                  <PropertiesBlock detail={detail} layout="inline" mode={session.mode} refresh={session.refresh} />
                </Section>
              ) : null}

              {/* ── tabs ───────────────────────────────────────────────────────
                  `variant="line"` — the underline strip, not the segmented pill.
                  A pill is a MODE switch for a whole surface (it is what the app
                  header uses for views, correctly). These four are sections of one
                  document, and ClickUp, Linear and GitHub all draw that as an
                  underlined strip on a rule. The strip is sticky so it is still
                  reachable a thousand rows into an activity timeline. */}
              <Tabs value={active} onValueChange={setTab} className="mt-7 gap-0">
                <div className="bg-card sticky top-0 z-10 -mt-1 border-b pt-1">
                  <TabsList variant="line" className="staple-detail-tabstrip w-full justify-start">
                    {tabs.map((definition) => (
                      <TabsTrigger key={definition.id} value={definition.id} className="flex-none">
                        {definition.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {tabs.map((definition) => {
                  const Tab = definition.component;
                  return (
                    <TabsContent key={definition.id} value={definition.id} className="pt-4">
                      <Tab
                        detail={detail}
                        workspace={detail.workspace}
                        onAuthError={onAuthError}
                        refresh={session.refresh}
                      />
                    </TabsContent>
                  );
                })}
              </Tabs>
            </div>

            {expanded ? (
              // `max-lg:order-first`: below the rail breakpoint the expanded view is
              // just a wide drawer, and properties belong above the content there —
              // not stranded under a thousand-row activity feed.
              //
              // `border-l` rather than relying on the gap. Whitespace alone did not
              // separate them: the rail read as a third column of the content rather
              // than as chrome about it, which is the exact confusion a hairline
              // costs one pixel to remove.
              //
              // `top-6` matches the container's own top padding, so the rail sticks
              // at the same offset it started at instead of jumping flush to the
              // header the moment you scroll.
              <aside className="w-full shrink-0 max-lg:order-first lg:sticky lg:top-6 lg:ml-auto lg:w-[16.5rem] lg:border-l lg:pl-8">
                <Section title="Properties">
                  <PropertiesBlock detail={detail} layout="rail" mode={session.mode} refresh={session.refresh} />
                </Section>
              </aside>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * One of the two navigation chevrons.
 *
 * The interesting part is the TITLE, which is why this is a component and not two
 * inline `<Button>`s. A disabled icon button with no explanation is the most
 * annoying control in any app — it has decided something about your situation and
 * will not say what — and this one has three genuinely different reasons to be off:
 *
 *   - you are at that end of the list (the ordinary one)
 *   - the panel is showing an issue the visible list does not contain, because you
 *     arrived here from a blocker chip or a breadcrumb past the filter
 *   - there is no list to move through at all — the graph view, or a filter that
 *     matched nothing
 *
 * The first is obvious from context; the second and third are not, and a user who
 * cannot tell them apart concludes the feature is broken. Enabled, the title names
 * the destination, so the arrow is never a leap of faith.
 *
 * `aria-label` stays constant ("Previous task" / "Next task") while the title
 * varies: the label is the control's identity and must not churn under a screen
 * reader every time the selection moves.
 */
function NavButton({
  direction,
  target,
  nav,
  onNavigate,
  icon,
}: {
  direction: "prev" | "next";
  target: NavTarget | null;
  nav: NavState;
  onNavigate: (target: NavTarget | null) => void;
  icon: ReactNode;
}) {
  const label = direction === "prev" ? "Previous task" : "Next task";
  const hint =
    direction === "prev" ? "K, or Alt+Up" : "J, or Alt+Down";

  let title: string;
  if (target) title = `${label} — ${target.ref}  (${hint})`;
  else if (nav.total === 0) title = `${label} — no list to move through in this view`;
  else if (nav.index < 0) title = `${label} — this issue is not in the current list`;
  else title = direction === "prev" ? "Already at the top of the list" : "Already at the end of the list";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={title}
      disabled={!target}
      onClick={() => onNavigate(target)}
    >
      {icon}
    </Button>
  );
}

/**
 * Eyebrow + hairline + content. The unit the panel's rhythm is made of, and the
 * reason it is a component rather than three classes: a section heading that is 11px
 * in one place and 12px in another is how a panel stops looking designed.
 */
function Section({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <h3 className="mb-2 border-b pb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The fact grid plus the one editable property that reads as a fact.
 *
 * Priority is a value you look up in a table of values — ClickUp puts it in the
 * property block and so does this — but unlike everything else in the grid it is
 * WRITABLE, and the writable thing has to be the same element that displayed it or
 * it is not inline editing (U5's rule). So it leads the block as a `FactRow` sharing
 * the grid's own tracks, rather than being passed through properties.ts, which
 * models facts and cannot model a control the store is allowed to refuse.
 */
function PropertiesBlock({
  detail,
  layout,
  mode,
  refresh,
}: {
  detail: IssueDetail;
  layout: PropertyLayout;
  mode: UiMode;
  refresh: () => void;
}) {
  return (
    <PropertyGrid
      facts={detailFacts(detail, mode)}
      layout={layout}
      trailing={
        // Labels take the rest of the row because they are the one property whose
        // value has no ceiling — six of them wrap, and wrapping inside a 1fr track
        // beside another pair would push that pair's baseline down the block.
        <FactRow label="Labels" layout={layout} span>
          <InlineLabels issue={detail.issue} workspace={detail.workspace} refresh={refresh} />
        </FactRow>
      }
    >
      <FactRow label="Priority" layout={layout}>
        <InlinePriority issue={detail.issue} workspace={detail.workspace} refresh={refresh} />
      </FactRow>
    </PropertyGrid>
  );
}
