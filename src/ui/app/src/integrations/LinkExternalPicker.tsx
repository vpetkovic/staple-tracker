import { loadPickerDefaults, rememberLinkChoices } from "./link-defaults";
import { useEffect, useRef, useState } from "react";
import { CircleDot, GitPullRequest, Link2, Search, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getIssues, getSettings, integrationRead, integrationWrite } from "@/lib/api";
import { useSession } from "@/lib/session";
import { openSettings } from "@/lib/shell-events";
import type { IssueRow, Issue } from "@/lib/types";
import type { ProviderConnection } from "../../../../core/integrations/connections";
import {
  freshness,
  resourceKey,
  sourceInput,
  uniqueHits,
  type MixedResults,
  type MatchPreview,
} from "./model";

export function LinkExternalPicker({
  initialWorkspace,
  initialRef,
  initialKind,
  onClose,
}: {
  initialWorkspace: string;
  initialRef?: string;
  initialKind?: "issue" | "pull_request";
  onClose: () => void;
}) {
  const session = useSession();
  const [ws, setWs] = useState(initialWorkspace);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90dvh] overflow-y-auto max-w-[calc(100vw-1rem)]">
        <DialogHeader>
          <DialogTitle>Link issue or PR</DialogTitle>
          <DialogDescription>
            Search local work and provider context, or paste an exact source URL.
          </DialogDescription>
        </DialogHeader>
        {session.workspaces.length > 1 || !ws ? (
          <label className="text-sm space-y-1">
            Workspace
            <select
              className="block w-full rounded-md border bg-background p-2"
              value={ws}
              onChange={(e) => setWs(e.target.value)}
            >
              <option value="">Choose workspace</option>
              {session.workspaces.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.slug}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {ws ? (
          <PickerBody
            key={ws}
            ws={ws}
            initialRef={ws === initialWorkspace ? initialRef : undefined}
            initialKind={initialKind}
            onClose={onClose}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose the workspace to search and link into.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
function PickerBody({
  ws,
  initialRef,
  initialKind,
  onClose,
}: {
  ws: string;
  initialRef?: string;
  initialKind?: "issue" | "pull_request";
  onClose: () => void;
}) {
  const session = useSession();
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [connectionId, setConnection] = useState("");
  const [repositories, setRepositories] = useState<string[]>([]);
  const [containerId, setContainer] = useState("");
  const [kind, setKind] = useState<"issue" | "pull_request">(initialKind ?? "issue");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<IssueRow[]>([]);
  const [target, setTarget] = useState(initialRef ?? "");
  const [results, setResults] = useState<MixedResults | null>(null);
  const [preview, setPreview] = useState<MatchPreview | null>(null);
  const [source, setSource] = useState("all");
  const [linked, setLinked] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [additional, setAdditional] = useState(false);
  const requestKey = useRef(crypto.randomUUID());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([
      integrationRead<{ connections: ProviderConnection[] }>({ action: "connections" }, ws),
      getIssues({ ws }),
      getSettings({ ws }),
    ])
      .then(([c, issues, settings]) => {
        if (!active) return;
        setConnections(c.connections);

        setRows(issues);
        const repos = String(settings.values["integrations.repositories"]?.value ?? "")
          .split(",").filter(Boolean);
        setRepositories(repos);
        const defaults = loadPickerDefaults(ws, c.connections, repos);
        setConnection(defaults.connectionId);
        setContainer(defaults.repository.slice(defaults.repository.lastIndexOf("/") + 1));
        setKind(initialKind ?? defaults.kind);
        setDefaultsLoaded(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [ws, initialKind]);
  useEffect(() => {
    if (!defaultsLoaded) return;
    const connection = connections.find(c => c.id === connectionId);
    rememberLinkChoices(ws, {
      connectionId,
      repository: connection && containerId ? `${connection.host}/${containerId}` : "",
      kind,
    });
  }, [ws, defaultsLoaded, connections, connectionId, containerId, kind]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const connection = connections.find((c) => c.id === connectionId);
  function changed() {
    setPreview(null);
    setResults(null);
    setAdditional(false);
  }
  async function search(cursor?: string) {
    if (/^https:\/\//i.test(text.trim())) {
      await inspect({ url: text.trim(), connectionId: connectionId || undefined });
      return;
    }
    const cached = await integrationRead<MixedResults>({ action: "search", text, kind }, ws);
    if (!alive.current) return;
    setResults(cached);
    setPreview(null);
    if (connectionId) {
      const r = await integrationRead<MixedResults>(
        {
          action: "search",
          text,
          kind,
          containerId: containerId || undefined,
          connectionId,
          cursor,
        },
        ws,
      );
      if (alive.current)
        setResults((old) =>
          cursor && old ? { ...r, remote: uniqueHits(old.remote, r.remote) } : r,
        );
    }
  }
  async function inspect(input: Record<string, unknown>) {
    const p = await integrationRead<MatchPreview>({ action: "preview", ...input }, ws);
    if (alive.current) {
      setPreview(p);
      setAdditional(false);
      requestKey.current = crypto.randomUUID();
    }
  }
  function open(issue: Issue) {
    session.open(ws, issue.id);
    onClose();
  }
  const hits = results
    ? uniqueHits(results.cached, results.remote).filter(
        (h) =>
          linked === "all" ||
          (linked === "linked" ? h.associations.length > 0 : h.associations.length === 0),
      )
    : [];
  return (
    <div className="space-y-4 min-w-0" aria-busy={busy}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => search());
        }}
      >
        <div className="flex gap-2">
          <Input
            aria-label="Issue URL or search"
            placeholder="Paste an issue / PR URL or search…"
            value={text}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value);
              changed();
            }}
          />
          <Button disabled={busy} type="submit">
            <Search className="size-4" />
            <span className="sr-only sm:not-sr-only">{busy ? "Searching…" : "Search"}</span>
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <select
            aria-label="Provider connection"
            className="min-w-0 rounded-md border bg-background p-2"
            value={connectionId}
            disabled={busy}
            onChange={(e) => {
              setConnection(e.target.value);
              setContainer("");
              changed();
            }}
          >
            <option value="">Cached context only</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.account} · {c.host} (CLI)
              </option>
            ))}
          </select>
          <select
            aria-label="Resource type"
            className="rounded-md border bg-background p-2"
            value={kind}
            disabled={busy}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              changed();
            }}
          >
            <option value="issue">Issues</option>
            <option value="pull_request">Pull requests</option>
          </select>
          <select
            aria-label="Repository scope"
            className="min-w-0 rounded-md border bg-background p-2"
            value={containerId}
            disabled={busy || !connection}
            onChange={(e) => {
              setContainer(e.target.value);
              changed();
            }}
          >
            <option value="">All accessible repositories</option>
            {repositories
              .filter((r) => r.startsWith(`${connection?.host}/`))
              .map((r) => (
                <option key={r} value={r.slice(r.lastIndexOf("/") + 1)}>
                  {r}
                </option>
              ))}
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {connection
            ? "Search uses this machine’s GitHub connection. Cached results remain available if it fails."
            : "Cached-only search. Configure a connection for live reads."}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              onClose();
              openSettings({ section: "integrations", workspace: ws });
            }}
          >
            Connection settings
          </button>
        </p>
      </form>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-2 text-sm wrap-anywhere"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {results && !preview ? (
        <>
          <div className="flex gap-2 text-xs">
            <select
              aria-label="Result source"
              className="rounded border bg-background p-1"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="all">All sources</option>
              <option value="local">Staple</option>
              <option value="provider">Provider context</option>
            </select>
            <select
              aria-label="Linkage"
              className="rounded border bg-background p-1"
              value={linked}
              onChange={(e) => setLinked(e.target.value)}
            >
              <option value="all">All associations</option>
              <option value="linked">Linked</option>
              <option value="unlinked">Not linked</option>
            </select>
          </div>
          {source !== "provider" ? (
            <section className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">
                Staple · executable work
              </h3>
              {results.local
                .filter(
                  (i) =>
                    linked === "all" ||
                    (linked === "linked" ? !!results.counts?.[i.id] : !results.counts?.[i.id]),
                )
                .map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    className="block w-full text-left rounded-md border p-2 text-sm hover:bg-accent wrap-anywhere"
                    onClick={() => open(i)}
                  >
                    {i.identifier} · {i.title}
                    {results.counts?.[i.id] ? (
                      <span className="block text-xs text-muted-foreground">
                        Provider links · {results.counts[i.id]!.issues} issues ·{" "}
                        {results.counts[i.id]!.pullRequests} PRs
                      </span>
                    ) : null}
                  </button>
                ))}
            </section>
          ) : null}
          {source !== "local" ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                Provider context ·{" "}
                {results.execution === "cached_only" ? "cached-only" : "live read and cache"}
              </h3>
              {hits.map((hit) => (
                <div
                  key={resourceKey(hit.item)}
                  className="rounded-md border p-3 text-sm space-y-1"
                >
                  <button
                    type="button"
                    disabled={busy}
                    className="flex w-full min-w-0 gap-2 text-left hover:underline"
                    onClick={() => void run(() => inspect(sourceInput(hit.item, connectionId)))}
                  >
                    {hit.item.ref.kind === "issue" ? (
                      <CircleDot className="size-4 shrink-0 mt-0.5" />
                    ) : (
                      <GitPullRequest className="size-4 shrink-0 mt-0.5" />
                    )}
                    <span className="wrap-anywhere">
                      {("title" in hit.item && hit.item.title) || hit.item.key}
                      <span className="block text-xs text-muted-foreground">
                        {hit.item.ref.providerId} · {hit.item.key}
                      </span>
                    </span>
                  </button>
                  <p className="text-xs text-muted-foreground">{freshness(hit.item)}</p>
                  <p className="text-xs">
                    {hit.associations.length
                      ? `Linked to ${hit.associations.length} Staple ticket${hit.associations.length === 1 ? "" : "s"}`
                      : "Not linked"}
                  </p>
                  {hit.associations.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      className="block text-xs underline wrap-anywhere"
                      onClick={() => open(i)}
                    >
                      {i.identifier} · {i.title}
                    </button>
                  ))}
                </div>
              ))}
              {hits.length === 0 ? (
                <p className="text-sm text-muted-foreground">No matching provider context.</p>
              ) : null}
              {results.nextCursor ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => search(results.nextCursor!))}
                >
                  More results
                </Button>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      {preview ? (
        <section className="rounded-lg border p-4 space-y-3 min-w-0">
          <div className="flex items-start gap-2">
            <Link2 className="size-4 shrink-0 mt-1" />
            <div className="min-w-0">
              <h3 className="font-medium wrap-anywhere">
                {("title" in preview.item && preview.item.title) || preview.item.key}
              </h3>
              <p className="text-xs text-muted-foreground wrap-anywhere">
                {preview.item.ref.providerId} ·{" "}
                {preview.item.ref.kind === "issue" ? "Issue" : "PR reference"} · {preview.item.key}
              </p>
            </div>
          </div>
          <a
            className="inline-flex gap-1 text-sm underline wrap-anywhere"
            href={preview.item.url}
            target="_blank"
            rel="noreferrer"
          >
            View source
            <ExternalLink className="size-3" />
          </a>
          <p className="text-xs text-muted-foreground">{freshness(preview.item)}</p>
          {"body" in preview.item && preview.item.body ? (
            <p className="max-h-36 overflow-y-auto text-sm whitespace-pre-wrap wrap-anywhere">
              {preview.item.body}
            </p>
          ) : null}
          <div className="space-y-1">
            <h4 className="text-xs font-medium">
              Existing associations and exact migration matches
            </h4>
            {preview.candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No exact matches found. Titles alone are never merged.
              </p>
            ) : (
              preview.candidates.map((c) => (
                <div key={c.issue.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    className="underline wrap-anywhere"
                    onClick={() => open(c.issue)}
                  >
                    {c.issue.identifier} · {c.issue.title}
                  </button>
                  <span className="text-muted-foreground">{c.reasons.join(", ")}</span>
                  <button
                    disabled={busy}
                    type="button"
                    className="underline"
                    onClick={() => setTarget(c.issue.id)}
                  >
                    Choose ticket
                  </button>
                </div>
              ))
            )}
            {preview.truncated ? (
              <p className="text-xs">
                More matches may exist; review before creating additional work.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="integration-local-target">Link to Staple ticket</Label>
            <SearchableSelect
              id="integration-local-target"
              name="integration-local-target"
              disabled={busy}
              options={rows.map((r) => ({
                value: r.issue.identifier,
                label: r.issue.identifier,
                hint: r.issue.title,
                status: r.issue.status,
              }))}
              selected={target ? [rows.find((r) => r.issue.id === target)?.issue.identifier ?? target] : []}
              onChange={(next) => setTarget(next[0] ?? "")}
              placeholder="Choose ticket"
              actionLabel="Change ticket"
              searchPlaceholder="Search Staple tickets…"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !target}
              onClick={() =>
                void run(async () => {
                  await integrationWrite(
                    {
                      action: "link",
                      ...sourceInput(preview.item, connectionId),
                      ref: target,
                      confirmed: true,
                    },
                    ws,
                  );
                  session.refresh();
                  setNotice("Source linked. Local execution fields are unchanged.");
                  await inspect(sourceInput(preview.item, connectionId));
                })
              }
            >
              Confirm link
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              Back to results
            </Button>
          </div>
          {preview.item.ref.kind === "issue" ? (
            <div className="border-t pt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Create a new Staple ticket by copying this issue once. It will not be added to the
                pickup queue.
              </p>
              {preview.candidates.length || preview.truncated ? (
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={additional}
                    onChange={(e) => setAdditional(e.target.checked)}
                  />
                  I reviewed the matches and want additional local work.
                </label>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy || ((preview.candidates.length > 0 || preview.truncated) && !additional)
                }
                onClick={() =>
                  void run(async () => {
                    const r = await integrationWrite<{ issue: Issue }>(
                      {
                        action: "create",
                        ...sourceInput(preview.item, connectionId),
                        requestKey: requestKey.current,
                        additionalWork: additional,
                      },
                      ws,
                    );
                    session.refresh();
                    open(r.issue);
                  })
                }
              >
                Create linked Staple ticket
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Pull requests are references only. Link this PR to existing work.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
