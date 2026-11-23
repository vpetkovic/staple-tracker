import { useEffect, useState } from "react";
import { CircleDot, GitPullRequest, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { integrationRead, integrationWrite } from "@/lib/api";
import { openLinkExternal, openSettings } from "@/lib/shell-events";
import { useOptionalSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { freshness, groupLinks, type ExternalLink } from "@/integrations/model";
import type { ProviderConnection } from "../../../../../core/integrations/connections";
import type { TabProps } from "./registry";

export function ExternalLinksTab({ detail, workspace, refresh, onAuthError }: TabProps) {
  const session = useOptionalSession();
  const resource = useResource(
    () => integrationRead<ExternalLink[]>({ action: "list", ref: detail.issue.id }, workspace),
    [workspace, detail.issue.id, session?.version],
    onAuthError,
  );
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [connectionId, setConnection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    integrationRead<{ connections: ProviderConnection[] }>({ action: "connections" }, workspace)
      .then((r) => {
        if (active) setConnections(r.connections);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workspace]);
  async function write(command: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await integrationWrite(command, workspace);
      resource.reload();
      refresh();
      setNotice(
        command.action === "refresh"
          ? "Source context refreshed. Local task fields are unchanged."
          : "Link context updated.",
      );
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : String(e)}. Saved context is still available. Check the connection in Settings or retry.`,
      );
    } finally {
      setBusy(false);
    }
  }
  const links = resource.data ?? detail.externalLinks ?? [];
  return (
    <div className="space-y-5 min-w-0" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">External links</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Provider context alongside this ticket. Staple owns the execution workflow.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => openLinkExternal({ workspace, ref: detail.issue.id })}
        >
          <Link2 className="size-3.5" />
          Link issue or PR
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label>
          Refresh connection{" "}
          <select
            aria-label="Refresh connection"
            className="max-w-full rounded border bg-background p-1"
            value={connectionId}
            disabled={busy}
            onChange={(e) => setConnection(e.target.value)}
          >
            <option value="">
              {connections.length
                ? "Automatic by provider host"
                : "Cached-only · no local connection"}
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.account} · {c.host}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="underline"
          onClick={() => openSettings({ section: "integrations", workspace })}
        >
          Connection settings
        </button>
      </div>
      {resource.loading && !links.length ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading links…
        </p>
      ) : null}
      {error || resource.error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm wrap-anywhere"
        >
          {error ?? resource.error!.message}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {!resource.loading && !links.length ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <Link2 className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No external issues or PRs linked</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Link an existing source to keep its context close. Searching does not import work.
          </p>
        </div>
      ) : null}
      {groupLinks(links).map((group) => (
        <section key={group.key} className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground wrap-anywhere">
            {group.label}
          </h3>
          <div className="space-y-3">
            {group.links.map((link) => (
              <ExternalLinkCard
                key={link.id}
                link={link}
                busy={busy}
                canRefresh={connections.some(
                  (c) =>
                    c.providerId === link.resource.ref.providerId &&
                    c.host === link.resource.ref.host,
                )}
                onRefresh={() =>
                  void write({
                    action: "refresh",
                    resourceId: link.resource.id,
                    connectionId: connectionId || undefined,
                  })
                }
                onUnlink={() =>
                  void write({
                    action: "unlink",
                    ref: detail.issue.id,
                    resourceId: link.resource.id,
                  })
                }
                onShare={(enabled) =>
                  void write({ action: "share", resourceId: link.resource.id, enabled })
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
export function ExternalLinkCard({
  link,
  busy,
  canRefresh,
  onRefresh,
  onUnlink,
  onShare,
  children,
}: {
  link: ExternalLink;
  busy: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onUnlink: () => void;
  onShare: (enabled: boolean) => void;
  children?: React.ReactNode;
}) {
  const r = link.resource;
  const Icon = r.ref.kind === "issue" ? CircleDot : GitPullRequest;
  return (
    <article
      className="min-w-0 rounded-lg border bg-surface-raised p-3 space-y-2"
      data-external-resource={r.id}
    >
      <div className="flex items-start gap-2">
        <Icon className="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium wrap-anywhere hover:underline"
          >
            {r.title ?? r.key}
          </a>
          <p className="text-xs text-muted-foreground wrap-anywhere">
            {r.ref.kind === "issue" ? "Issue" : "PR reference"} · {r.key}
            {r.status ? ` · ${r.status.name}` : " · state unknown"}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground wrap-anywhere">
        {freshness(r)}
        {!canRefresh ? " · offline / cached-only on this machine" : ""}
      </p>
      {r.body ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Source context
          </summary>
          <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
            {r.body}
          </p>
        </details>
      ) : null}
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy || !canRefresh} onClick={onRefresh}>
          <RefreshCw className="size-3" />
          Refresh context
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink}>
          Unlink from this ticket
        </Button>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Context sharing · {r.contextShared ? "shared with workspace" : "only on this machine"}
        </summary>
        <p className="mt-2">
          Links sync with the workspace. Sharing also sends the cached source title, body and
          status. Turning sharing off clears the current shared copy; it cannot erase retained
          history or backups. This choice applies to this source across linked tickets.
        </p>
        <label className="mt-2 flex gap-2 items-start">
          <input
            type="checkbox"
            disabled={busy}
            checked={r.contextShared}
            onChange={(e) => onShare(e.target.checked)}
          />
          <span>Share cached source context with workspace</span>
        </label>
      </details>
    </article>
  );
}
