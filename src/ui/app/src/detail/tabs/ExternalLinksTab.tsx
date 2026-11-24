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
import type { TabProps } from "./registry";

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

export function ExternalLinksTab({ detail, workspace, refresh, onAuthError }: TabProps) {
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

  const write: WriteLink = async (command) => {
    try {
      await integrationWrite(command, workspace);
    } finally {
      resource.reload();
      refresh();
    }
  };
  async function refreshAll() {
    const targets = links.filter((l) => isRefreshable(l, connections));
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
      loading={resource.loading && !links.length}
      loadError={resource.error?.message ?? null}
      connections={loaded ? connections : null}
      section={section}
      onSection={setSection}
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

const FILTERS: Array<{ id: ExternalSection; label: string }> = [
  { id: "all", label: "All" },
  { id: "issue", label: "Issues" },
  { id: "pull_request", label: "Pull requests" },
];

export function ExternalLinksView({
  links,
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
  const counts = filterCounts(links);
  const shown = links.filter((l) => section === "all" || l.resource.ref.kind === section);
  const groups = new Map(groupLinks(links).flatMap((g) => g.links.map((l) => [l.id, g.links] as const)));
  const oldest = oldestRefresh(links, known);
  const refreshed = oldest ? savedAge(oldest.resource, now)?.sentence.replace(/^Saved copy from /, "") : null;
  const canRefresh = links.some((l) => isRefreshable(l, known));
  const notices = connections ? connectionNotices(links, connections) : [];

  if (!loading && !links.length && !loadError)
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label="Show"
          className="flex h-7 w-full rounded-md border p-0.5 pointer-coarse:h-auto @min-[520px]:w-auto"
        >
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={section === filter.id}
              onClick={() => onSection(filter.id)}
              className={cn(
                "focus-ring inline-flex flex-1 items-center justify-center gap-1.5 rounded-[4px] px-2.5 text-label whitespace-nowrap @min-[520px]:flex-none",
                section === filter.id
                  ? "bg-surface-selected font-medium text-foreground"
                  : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
              )}
            >
              {filter.label}<span className="font-normal text-text-tertiary tabular-nums">{counts[filter.id]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {refreshed ? (
            <span className="pr-1 text-label whitespace-nowrap text-text-tertiary">Refreshed {refreshed}</span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh all"
            title="Refresh all"
            disabled={!canRefresh || refreshAll.running}
            onClick={refreshAll.run}
            className="size-7 text-muted-foreground pointer-coarse:size-11"
          >
            <RefreshCw aria-hidden className={cn("size-3.5", refreshAll.running && "animate-spin")} />
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
      ) : links.length ? (
        <p className="py-6 text-center text-body text-text-tertiary">
          {section === "issue" ? "No linked issues" : "No linked pull requests"}
        </p>
      ) : null}
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
