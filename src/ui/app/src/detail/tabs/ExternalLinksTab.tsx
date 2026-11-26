import {
  onExternalSection,
  takeExternalSection,
  type ExternalSection,
} from "@/integrations/external-section";
import { useEffect, useState } from "react";
import { Link2, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { integrationRead, integrationWrite } from "@/lib/api";
import { openLinkExternal, openSettings } from "@/lib/shell-events";
import { useOptionalSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { useNow } from "@/detail/parts/RelativeTime";
import { InlineError } from "@/settings/form/primitives";
import type { ConnectionView } from "@/integrations/connection-status";
import { savedAge } from "@/integrations/link-state";
import { KindSegments } from "@/integrations/parts";
import { LinkGroups, LinkSkeleton, type WriteLink } from "@/integrations/LinkList";
import {
  connectionNotices,
  filterCounts,
  isRefreshable,
  refreshConnection,
  oldestRefresh,
  refreshFailure,
} from "@/integrations/links-view";
import { groupLinks, type ExternalLink } from "@/integrations/model";
import { useConnections } from "@/integrations/useConnections";
import { SubtreeLinkSection } from "@/integrations/SubtreeLinkSection";
import { descendantEntries, refreshTargets, subtreeEntries, type PullRequestEntry } from "@/integrations/pull-requests";
import type { TabProps } from "./registry";

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

export function ExternalLinksTab({ detail, workspace, refresh, onAuthError, holdScroll }: TabProps) {
  const session = useOptionalSession();
  const [section, setSection] = useState<ExternalSection>(() => takeExternalSection() ?? "all");
  useEffect(() => onExternalSection(setSection), []);
  const resource = useResource(
    () => integrationRead<ExternalLink[]>({ action: "list", ref: detail.issue.id }, workspace),
    [workspace, detail.issue.id, session?.version],
    onAuthError,
  );
  const { connections, loaded } = useConnections(workspace);
  const now = useNow().getTime();
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshAllError, setRefreshAllError] = useState<string | null>(null);
  const links = resource.data ?? detail.externalLinks ?? [];
  const inside = descendantEntries(subtreeEntries(detail));

  const write: WriteLink = async (command) => {
    try {
      await integrationWrite(command, workspace);
    } finally {
      resource.reload();
      refresh();
    }
  };
  async function refreshAll() {
    // Everything the tab lists: this ticket's links, and on a parent the pull requests of the tickets inside it.
    const targets = [...links, ...refreshTargets(inside)].filter((l) => isRefreshable(l, connections));
    setRefreshingAll(true);
    setRefreshAllError(null);
    const failures: string[] = [];
    for (const link of targets) {
      try {
        await integrationWrite({ action: "refresh", resourceId: link.resource.id, connectionId: refreshConnection(link, connections) ?? undefined }, workspace);
      } catch (caught) {
        failures.push(message(caught));
      }
    }
    setRefreshAllError(refreshFailure(failures, targets.length));
    setRefreshingAll(false);
    resource.reload();
    refresh();
  }

  return (
    <ExternalLinksView
      links={links}
      subtree={{ entries: inside, workspace, shownId: detail.issue.id }}
      loading={resource.loading && !links.length}
      loadError={resource.error?.message ?? null}
      connections={loaded ? connections : null}
      section={section}
      onSection={(next) => {
        // A shorter list must not pull the reader up the page.
        holdScroll?.();
        setSection(next);
      }}
      onLink={() => openLinkExternal({ workspace, ref: detail.issue.id })}
      onOpenSettings={() => openSettings({ section: "integrations", workspace })}
      onWrite={write}
      refreshAll={{ running: refreshingAll, error: refreshAllError, run: () => void refreshAll() }}
      now={now}
    />
  );
}

export interface ExternalLinksViewProps {
  links: ExternalLink[];
  /** On a parent: the pull requests only the tickets inside it carry, listed after its own links. */
  subtree?: { entries: PullRequestEntry[]; workspace: string; shownId: string };
  /** The first read is under way and nothing is known yet. */
  loading: boolean;
  loadError: string | null;
  /** Null until the connections on this computer have been read. */
  connections: readonly ConnectionView[] | null;
  section: ExternalSection;
  onSection: (section: ExternalSection) => void;
  onLink: () => void;
  onOpenSettings: () => void;
  onWrite: WriteLink;
  refreshAll: { running: boolean; error: string | null; run: () => void };
  now: number;
}

export function ExternalLinksView({
  links,
  subtree,
  loading,
  loadError,
  connections,
  section,
  onSection,
  onLink,
  onOpenSettings,
  onWrite,
  refreshAll,
  now,
}: ExternalLinksViewProps) {
  const known = connections ?? [];
  const inside = subtree?.entries ?? [];
  // The filter counts what the tab lists: a parent's descendants' pull requests are part of it.
  const own = filterCounts(links);
  const counts = { all: own.all + inside.length, issue: own.issue, pull_request: own.pull_request + inside.length };
  const showInside = inside.length > 0 && section !== "issue";
  const shown = links.filter((l) => section === "all" || l.resource.ref.kind === section);
  const groups = new Map(groupLinks(links).flatMap((g) => g.links.map((l) => [l.id, g.links] as const)));
  // Refreshing and the connection notice cover everything listed, the descendants' pull requests included.
  const listed = [...links, ...refreshTargets(inside)];
  const oldest = oldestRefresh(listed, known);
  const refreshed = oldest ? savedAge(oldest.resource as Parameters<typeof savedAge>[0], now)?.sentence.replace(/^Saved copy from /, "") : null;
  const canRefresh = listed.some((l) => isRefreshable(l, known));
  const notices = connections ? connectionNotices(listed, connections) : [];

  if (!loading && !links.length && !inside.length && !loadError)
    return (
      <div data-external-links className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed px-6 py-8 text-center">
        <Link2 aria-hidden className="size-5 text-text-tertiary" />
        <p className="max-w-80 text-body text-muted-foreground">
          Nothing linked yet. Link an issue or pull request to keep it beside this task.
        </p>
        <LinkButton onClick={onLink} />
      </div>
    );

  return (
    <div data-external-links className="@container min-w-0 space-y-3" aria-busy={refreshAll.running}>
      {/* One row: the filter at its own width on the left, the two actions on the right. It wraps only under about 330px. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <KindSegments value={section} onChange={onSection} counts={counts} />
        <div className="ml-auto flex items-center gap-1">
          {/* The age of the copies and the way to read them again are one control. Narrow, it is the icon alone. */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={refreshed ? `Refresh all. Refreshed ${refreshed}` : "Refresh all"}
            title="Refresh all"
            disabled={!canRefresh || refreshAll.running}
            onClick={refreshAll.run}
            className="h-7 gap-1.5 px-2 font-normal text-muted-foreground pointer-coarse:h-11 pointer-coarse:min-w-11"
          >
            <RefreshCw aria-hidden className={cn("size-3.5", refreshAll.running && "animate-spin")} />
            {refreshAll.running || refreshed ? (
              <span className="whitespace-nowrap @max-[519px]:hidden">{refreshAll.running ? "Refreshing…" : `Refreshed ${refreshed}`}</span>
            ) : null}
          </Button>
          <LinkButton onClick={onLink} />
        </div>
      </div>
      {refreshAll.error || loadError ? (
        <div className="space-y-1">
          {loadError ? <InlineError>{loadError}</InlineError> : null}
          {refreshAll.error ? <InlineError>{refreshAll.error}</InlineError> : null}
        </div>
      ) : null}
      {notices.map((notice) => (
        <div
          key={notice.key}
          data-connection-notice
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[color-mix(in_oklab,var(--status-task-todo)_40%,transparent)] bg-[color-mix(in_oklab,var(--status-task-todo)_8%,transparent)] px-3 py-2"
        >
          <p className="flex min-w-0 flex-1 basis-60 items-start gap-2 text-label text-foreground">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-[var(--status-task-icon-todo)]" />
            <span>
              {notice.text} These are saved copies and can&apos;t be refreshed until it is fixed.
            </span>
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onOpenSettings}
            className="ml-auto bg-background pointer-coarse:h-11 pointer-coarse:px-3"
          >
            Open Integrations
          </Button>
        </div>
      ))}
      {loading ? (
        <LinkSkeleton />
      ) : shown.length ? (
        <LinkGroups
          links={shown}
          groupOf={(link) => groups.get(link.id) ?? [link]}
          connections={known}
          onWrite={onWrite}
          now={now}
        />
      ) : links.length && !showInside ? (
        <p className="py-6 text-center text-body text-text-tertiary">
          {section === "issue" ? "No linked issues" : "No linked pull requests"}
        </p>
      ) : !links.length && !showInside && inside.length ? (
        <p className="py-6 text-center text-body text-text-tertiary">No linked issues</p>
      ) : null}
      {showInside ? <SubtreeLinkSection entries={inside} workspace={subtree!.workspace} shownId={subtree!.shownId} /> : null}
    </div>
  );
}

function LinkButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" size="xs" variant="outline" onClick={onClick} className="h-7 px-2.5 pointer-coarse:h-11 pointer-coarse:px-3">
      <Plus aria-hidden className="size-3.5" />
      Link
    </Button>
  );
}
