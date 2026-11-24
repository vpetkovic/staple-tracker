import { LinkDefaultsSection } from "./LinkDefaultsSection";
import { useEffect, useState } from "react";
import { Plug, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { integrationConfigure, integrationRead, integrationWrite } from "@/lib/api";
import type { WorkspaceSettingsEnvelope } from "@/lib/settings";
import type { ApplyTo } from "./CategoryContent";
import { Section } from "./form/primitives";
import type { ProviderConnection } from "../../../../core/integrations/connections";
import type { ConnectionHealthSnapshot, DetectedConnection, ExternalContainer, ExternalPage } from "../../../../core/integrations/contracts";

type Listed = { connections: Array<ProviderConnection & { health?: ConnectionHealthSnapshot | null }>; detected?: DetectedConnection[] };
type HealthRead = { health: ConnectionHealthSnapshot[] };
type Mapped = { key: string; name: string | null; kind: string; connectionId: string | null };
type MappingRead = { workspaces: Array<{ workspace: string; targets: Mapped[] }> };
type Found = ExternalContainer & { key: string; kind: "repository" | "team" | "project" };
export function IntegrationsSection({ ws, onDirtyChange }: {
  ws?: string; settings: WorkspaceSettingsEnvelope; applyTo: ApplyTo; onDirtyChange: (dirty: boolean) => void;
}) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [health, setHealth] = useState<Record<string, ConnectionHealthSnapshot>>({});
  const [detected, setDetected] = useState<DetectedConnection[]>([]);
  const remember = (read: HealthRead) => setHealth(old => ({ ...old, ...Object.fromEntries(read.health.map(h => [h.connectionId, h])) }));
  const [repos, setRepos] = useState<Record<string, Found & { connectionId: string }>>({});
  const [cursor, setCursor] = useState<Record<string, string | null>>({});
  const [mapping, setMapping] = useState<MappingRead["workspaces"]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState<"github" | "linear">("github");
  const [scopeId, setScope] = useState("");
  const [credentialEnv, setCredentialEnv] = useState("STAPLE_LINEAR_API_KEY");
  const [host, setHost] = useState("github.com");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [defaultsDirty, setDefaultsDirty] = useState(false);
  const dirty = defaultsDirty || account !== "" || scopeId !== "" || credentialEnv !== "STAPLE_LINEAR_API_KEY" || host !== "github.com";
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let active = true;
    integrationRead<MappingRead>({action: "mapping", allWorkspaces: true}, ws).then(r => { if (active) setMapping(r.workspaces); }).catch(() => {});
    return () => { active = false; };
  }, [ws]);
  useEffect(() => {
    let active = true;
    integrationRead<Listed>({action: "connections"}, ws)
      .then(r => {
        if(!active) return;
        setConnections(r.connections); setDetected(r.detected ?? []);
        setHealth(Object.fromEntries(r.connections.flatMap(c => c.health ? [[c.id, c.health]] : [])));
        // Show real status on arrival; the server answers from its cache unless the last check is old.
        if (r.connections.length) void integrationRead<HealthRead>({action: "health"}, ws).then(h => { if(active) remember(h); }).catch(() => {});
      })
      .catch(e => { if(active) setError(String(e.message)); }).finally(() => { if(active) setLoaded(true); });
    return () => { active = false; };
  }, [ws]);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setNotice("");
    try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <div className="space-y-7" aria-busy={busy}>
    <Section title="Provider connections · this machine" error={error}
      description="GitHub uses gh authentication on the computer running Staple. Linear uses a personal API key from that computer’s environment. Your browser never receives a key; connections do not sync to other machines.">
      {!loaded ? <p role="status" className="text-sm text-muted-foreground">Loading connections…</p> : connections.length === 0 ?
        <div className="rounded-lg border border-dashed p-4 text-sm"><p className="font-medium">Cached-only until connected</p><p className="mt-1 text-muted-foreground">Existing links and saved context remain available. Add a connection for live provider reads.</p></div> : null}
      {connections.map(c => <div key={c.id} className="rounded-lg border p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><Plug className="size-4" aria-hidden /><span className="font-medium wrap-anywhere">{c.account} · {c.host}</span><span className="text-xs text-muted-foreground">{c.mode.toUpperCase()}</span></div>
        <div role="status" className="text-xs text-muted-foreground wrap-anywhere">{health[c.id] ? <>
          <span className="font-medium text-foreground">{health[c.id]!.state.replaceAll("_", " ")}</span>
          {health[c.id]!.state !== "ready" ? ` · ${health[c.id]!.message}` : ` · Connected for read-only access${health[c.id]!.identity ? ` as ${health[c.id]!.identity!.login}` : ""}`}
          {health[c.id]!.action ? <span className="block mt-1">{health[c.id]!.action}</span> : null}
          <span className="block mt-1">Checked {new Date(health[c.id]!.checkedAt).toLocaleString()}</span>
        </> : "Checking…"}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { remember(await integrationRead<HealthRead>({action:"health",connectionId:c.id,force:true},ws)); })}><RefreshCw className="size-3" />Check connection</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            const page = await integrationRead<ExternalPage<Found>>({action:"containers",connectionId:c.id,cursor:cursor[c.id] ?? undefined},ws);
            setRepos(old => ({...old,...Object.fromEntries(page.items.map(repo => [repo.key,{...repo,connectionId:c.id}]))}));
            setCursor(old => ({...old,[c.id]:page.nextCursor}));
          })}>{c.providerId === "linear" ? cursor[c.id] ? "More teams" : "Find teams" : cursor[c.id] ? "More repositories" : "Find repositories"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await integrationConfigure({action:"remove",connectionId:c.id},ws); setConnections(old => old.filter(x=>x.id!==c.id)); setNotice("Connection removed from this machine. Existing links are preserved."); })}><Trash2 className="size-3" />Remove</Button>
        </div>
      </div>)}
      {detected.filter(d => !d.configuredConnectionId).map(d => <div key={`${d.host}:${d.login}`} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
        <span className="wrap-anywhere">GitHub CLI on this machine is signed in as <span className="font-medium">{d.login}</span> · {d.host}</span>
        <Button size="sm" disabled={busy} onClick={() => void run(async () => {
          const c = await integrationConfigure<ProviderConnection>({action:"configure",host:d.host,account:d.login},ws);
          setConnections(old => [...old,c]); setDetected(old => old.map(x => x === d ? {...x, configuredConnectionId: c.id} : x));
          remember(await integrationRead<HealthRead>({action:"health",connectionId:c.id},ws));
        })}>Connect as {d.login}</Button>
      </div>)}
      <form className="space-y-3 rounded-lg bg-surface-sunken p-3" onSubmit={e => { e.preventDefault(); void run(async () => {
        const c = await integrationConfigure<ProviderConnection>(provider === "linear"
          ? {action:"configure",providerId:provider,account,scopeId,credentialEnv}
          : {action:"configure",host,account},ws);
        setConnections(old => [...old,c]); setAccount(""); setScope(""); setCredentialEnv("STAPLE_LINEAR_API_KEY"); setHost("github.com"); setNotice("Connection saved. Check it to verify access.");
      }); }}>
        <label className="block space-y-1 text-sm"><span>Provider</span>
          <select aria-label="Connection provider" className="block w-full rounded-md border bg-background p-2" value={provider}
            onChange={e => { setProvider(e.target.value as typeof provider); setAccount(""); setScope(""); }}>
            <option value="github">GitHub CLI</option><option value="linear">Linear API</option>
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {provider === "github" ? <div className="space-y-1"><Label htmlFor="integration-host">GitHub host</Label><Input id="integration-host" value={host} onChange={e=>setHost(e.target.value)} required /></div>
            : <div className="space-y-1"><Label htmlFor="integration-scope">Linear organization UUID</Label><Input id="integration-scope" value={scopeId} onChange={e=>setScope(e.target.value)} required /></div>}
          <div className="space-y-1"><Label htmlFor="integration-account">{provider === "linear" ? "Expected Linear user UUID" : "Expected GitHub account"}</Label><Input id="integration-account" value={account} onChange={e=>setAccount(e.target.value)} placeholder={provider === "linear" ? "User UUID" : "Your gh account"} required /></div>
        </div>
        {provider === "linear" ? <div className="space-y-1"><Label htmlFor="integration-credential">API key environment variable name</Label><Input id="integration-credential" value={credentialEnv} onChange={e=>setCredentialEnv(e.target.value)} required autoComplete="off" />
          <p className="text-xs text-muted-foreground">Enter the variable name only. Set a read-only personal API key in the environment of the Staple process, then restart it. Use Linear’s GraphQL viewer and organization queries to find the UUIDs.</p></div> : null}
        <Button size="sm" disabled={busy || !account.trim() || (provider === "linear" && (!scopeId.trim() || !credentialEnv.trim()))} type="submit">Add connection</Button>
      </form>
    </Section>
    <Section title="What each workspace searches" description="Map GitHub repositories and Linear teams to a workspace; search and linking in that workspace stay inside them. A workspace with no mapping searches everything mapped on this computer. Mappings sync with each workspace.">
      {mapping.map(row => {
        const options = Object.values(repos).filter(r => !row.targets.some(t => t.key === r.key));
        return <div key={row.workspace} className="rounded-lg border p-3 space-y-2 text-sm">
          <p className="font-medium">{row.workspace}</p>
          {row.targets.length === 0 ? <p className="text-xs text-muted-foreground">No mapping: searches every mapped repository and team.</p> : null}
          {row.targets.map(t => <div key={t.key} className="flex flex-wrap items-center gap-2"><span className="wrap-anywhere">{t.name ?? t.key}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
              const r = await integrationWrite<{ targets: Mapped[] }>({action: "unmap", targetKey: t.key}, row.workspace);
              setMapping(old => old.map(m => m.workspace === row.workspace ? {...m, targets: r.targets} : m));
            })}>Unmap</Button></div>)}
          {options.length ? <div className="flex flex-wrap gap-2">
            <select aria-label={`Repository or team to map to ${row.workspace}`} className="min-w-0 rounded-md border bg-background p-1" value={choice[row.workspace] ?? ""} onChange={e => setChoice(old => ({...old, [row.workspace]: e.target.value}))}>
              <option value="">Choose a repository or team</option>
              {options.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
            </select>
            <Button size="sm" disabled={busy || !choice[row.workspace]} onClick={() => void run(async () => {
              const found = repos[choice[row.workspace]!]!;
              const r = await integrationWrite<{ targets: Mapped[] }>({action: "map", connectionId: found.connectionId, containerId: found.id, containerKind: found.kind}, row.workspace);
              setMapping(old => old.map(m => m.workspace === row.workspace ? {...m, targets: r.targets} : m));
              setChoice(old => ({...old, [row.workspace]: ""}));
            })}>Map</Button>
          </div> : null}
        </div>;
      })}
      {Object.keys(repos).length === 0 ? <p className="text-xs text-muted-foreground">Use Find repositories or Find teams above to list what you can map.</p> : null}
    </Section>
    {ws && loaded ? <LinkDefaultsSection key={ws} ws={ws} connections={connections}
      repositories={(mapping.find(m => m.workspace === ws)?.targets ?? []).map(t => t.key)} onDirtyChange={setDefaultsDirty} /> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <p className="text-xs text-muted-foreground">Cloud-only sessions show synced links and shared cached context. Live reads require a configured connection on the machine running Staple.</p>
  </div>;
}
