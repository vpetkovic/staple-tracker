/**
 * The detail panel: header, actions, and a tab slot.
 *
 * This file knows *nothing* about any individual tab. It reads detail/tabs/registry.ts,
 * renders whatever is in it, and passes every tab the same props. That is the whole
 * point of the layout — U2, U3, and U4 each add a file and a registry line without ever
 * opening this one, so three agents working in parallel cannot collide here.
 *
 * The panel owns the fetch, so a tab always gets a loaded `IssueDetail` and never has
 * to handle the "not loaded yet" case itself.
 */
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import { StaleClaimBadge } from "@/components/StaleClaimBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { isStaleClaim } from "@/lib/claim";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getIssue } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { useSession, type Selection } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { IssueActions } from "./IssueActions";
import { InlineLabels, InlinePriority, InlineTitle } from "./InlineProperties";
import { visibleTabs } from "./tabs/registry";

export function IssueDetailPanel({
  selection,
  onAuthError,
}: {
  selection: Selection;
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  const [tab, setTab] = useState("overview");

  const load = useCallback(
    () => getIssue({ ws: selection.workspace, ref: selection.ref }),
    [selection.workspace, selection.ref],
  );
  const resource = useResource(load, [selection.workspace, selection.ref, session.version], onAuthError);

  return (
    <aside
      aria-label="Issue detail"
      className="flex h-full min-h-0 flex-col overflow-hidden border-l bg-card"
    >
      {/* A fixed 40px header bar rather than padding-derived height: this bar and
          the app header are the two pieces of persistent chrome on the page, and
          when their heights are computed from different padding they never quite
          line up across a viewport resize. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-mono text-[11px] text-text-tertiary">{selection.ref}</span>
        {resource.data ? <StatusBadge status={resource.data.issue.status} /> : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close detail"
          className="ml-auto"
          onClick={session.close}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {resource.error ? <ErrorState error={resource.error} /> : null}
        {!resource.data && resource.loading ? <LoadingState rows={3} /> : null}

        {resource.data ? (
          (() => {
            const detail = resource.data;
            const { issue } = detail;
            // C3: `claim` is a server reading, refreshed by the same poll that refreshes
            // everything else on this panel. Nothing here counts it up locally.
            const stale = isStaleClaim(detail.claim);
            const path = [...detail.ancestors.map((a) => a.identifier), issue.identifier].join(" › ");
            const tabs = visibleTabs(detail);
            const active = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "overview");

            return (
              <>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {/* U5: the three editable properties are the same elements that
                      displayed them — clicking the value is the edit affordance. */}
                  <InlinePriority issue={issue} workspace={detail.workspace} refresh={session.refresh} />
                  {issue.assignee ? <span>@{issue.assignee}</span> : null}
                  {/* Same rule as the card: past the threshold the badge stands in for
                      the plain "held by X", because it already says who and adds why
                      you should care. Under it, nothing about this line changes. */}
                  {stale && detail.claim ? (
                    <StaleClaimBadge claim={detail.claim} variant="detail" />
                  ) : issue.checkoutAgent ? (
                    <span>held by {issue.checkoutAgent}</span>
                  ) : null}
                  {session.mode === "hub" ? <span className="font-mono">{detail.workspace}</span> : null}
                </div>
                {/* The ancestry path is orientation, not content — tertiary, and
                    truncated rather than allowed to wrap into a paragraph that
                    pushes the title (the actual subject of the panel) below the
                    fold on a deep tree. */}
                <div className="mt-1 truncate font-mono text-[11px] text-text-tertiary" title={path}>
                  {path}
                </div>
                <InlineTitle issue={issue} workspace={detail.workspace} refresh={session.refresh} />
                <InlineLabels issue={issue} workspace={detail.workspace} refresh={session.refresh} />

                <div className="mt-3">
                  <IssueActions
                    issue={issue}
                    workspace={detail.workspace}
                    claim={detail.claim}
                    refresh={session.refresh}
                  />
                </div>

                <Separator className="my-3" />

                <Tabs value={active} onValueChange={setTab}>
                  <TabsList>
                    {tabs.map((definition) => (
                      <TabsTrigger key={definition.id} value={definition.id}>
                        {definition.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {tabs.map((definition) => {
                    const Tab = definition.component;
                    return (
                      <TabsContent key={definition.id} value={definition.id} className="mt-3">
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
              </>
            );
          })()
        ) : null}
      </div>
    </aside>
  );
}
