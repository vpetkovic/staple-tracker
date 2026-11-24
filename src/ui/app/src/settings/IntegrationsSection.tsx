import { containerPrefix } from "@/integrations/link-defaults";
import { LinkDefaultsSection } from "./LinkDefaultsSection";
import { useEffect, useState } from "react";
import { Plug, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { integrationConfigure, integrationRead } from "@/lib/api";
import type { WorkspaceSettingsEnvelope } from "@/lib/settings";
import type { ApplyTo } from "./CategoryContent";
import { Section } from "./form/primitives";
import type { ProviderConnection } from "../../../../core/integrations/connections";
import type { ConnectionHealth, ExternalContainer, ExternalPage } from "../../../../core/integrations/contracts";

type Health = ConnectionHealth & { checkedAt: string };
export function IntegrationsSection({ ws, settings, applyTo, onDirtyChange }: {
  ws?: string; settings: WorkspaceSettingsEnvelope; applyTo: ApplyTo; onDirtyChange: (dirty: boolean) => void;
}) {
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [repos, setRepos] = useState<Record<string, ExternalContainer>>({});
  const [cursor, setCursor] = useState<Record<string, string | null>>({});
  const stored = String(settings.values["integrations.repositories"]?.value ?? "");
  const [selected, setSelected] = useState(stored);
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
  const dirty = defaultsDirty || selected !== stored || account !== "" || scopeId !== "" || credentialEnv !== "STAPLE_LINEAR_API_KEY" || host !== "github.com";
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { setSelected(stored); }, [stored]);
  useEffect(() => {
    let active = true;
    integrationRead<{connections: ProviderConnection[]}>({action: "connections"}, ws)
      .then(r => { if(active) setConnections(r.connections); })
      .catch(e => { if(active) setError(String(e.message)); }).finally(() => { if(active) setLoaded(true); });
    return () => { active = false; };
  }, [ws]);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setNotice("");
    try { await fn(); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const ids = selected ? selected.split(",") : [];
  return <div className="space-y-7" aria-busy={busy}>
    <Section title="Provider connections · this machine" error={error}
      description="GitHub uses gh authentication on the computer running Staple. Linear uses a personal API key from that computer’s environment. Your browser never receives a key; connections do not sync to other machines.">
      {!loaded ? <p role="status" className="text-sm text-muted-foreground">Loading connections…</p> : connections.length === 0 ?
        <div className="rounded-lg border border-dashed p-4 text-sm"><p className="font-medium">Cached-only until connected</p><p className="mt-1 text-muted-foreground">Existing links and saved context remain available. Add a connection for live provider reads.</p></div> : null}
      {connections.map(c => <div key={c.id} className="rounded-lg border p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm"><Plug className="size-4" aria-hidden /><span className="font-medium wrap-anywhere">{c.account} · {c.host}</span><span className="text-xs text-muted-foreground">{c.mode.toUpperCase()}</span></div>
        <div role="status" className="text-xs text-muted-foreground wrap-anywhere">{health[c.id] ? <>
          <span className="font-medium text-foreground">{health[c.id]!.state.replaceAll("_", " ")}</span>
          {health[c.id]!.state !== "ready" ? ` · ${(health[c.id] as Exclude<Health, {state: "ready"}>).message}` : " · Connected for read-only access"}
          <span className="block mt-1">Checked {new Date(health[c.id]!.checkedAt).toLocaleString()}</span>
        </> : "Not checked on this visit"}</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { const h = await integrationRead<Health>({action:"health",connectionId:c.id},ws); setHealth(old => ({...old,[c.id]:h})); })}><RefreshCw className="size-3" />Check connection</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            const page = await integrationRead<ExternalPage<ExternalContainer>>({action:"containers",connectionId:c.id,cursor:cursor[c.id] ?? undefined},ws);
            setRepos(old => ({...old,...Object.fromEntries(page.items.map(repo => [`${containerPrefix(c)}${repo.id}`,repo]))}));
            setCursor(old => ({...old,[c.id]:page.nextCursor}));
          })}>{c.providerId === "linear" ? cursor[c.id] ? "More teams" : "Find teams" : cursor[c.id] ? "More repositories" : "Find repositories"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await integrationConfigure({action:"remove",connectionId:c.id},ws); setConnections(old => old.filter(x=>x.id!==c.id)); setNotice("Connection removed from this machine. Existing links are preserved."); })}><Trash2 className="size-3" />Remove</Button>
        </div>
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
    <Section title="Workspace repositories and teams" description="Choose repositories and Linear teams to offer in search. These preferences sync with the workspace; each machine needs its own connection to read them. You can always link an exact accessible URL.">
      {Object.keys(repos).length === 0 && ids.length === 0 ? <p className="text-sm text-muted-foreground">Use Find repositories or Find teams above to choose search scopes.</p> : null}
      <div className="max-h-64 overflow-y-auto space-y-2">
        {[...new Set([...ids,...Object.keys(repos)])].map(id => <label key={id} className="flex items-start gap-2 text-sm min-w-0"><input type="checkbox" className="mt-1" checked={ids.includes(id)} disabled={busy} onChange={e=>setSelected((e.target.checked ? [...ids,id] : ids.filter(x=>x!==id)).sort().join(","))} /><span className="wrap-anywhere">{repos[id]?.name ?? id}</span></label>)}
      </div>
      <div className="flex gap-2"><Button size="sm" disabled={busy || selected===stored} onClick={() => void run(async () => {
        const refusal=await applyTo("settings",[{op:"set",key:"integrations.repositories",value:selected}]);
        if(refusal) throw new Error(refusal.message); setNotice("Workspace container preferences saved.");
      })}>Save containers</Button><Button size="sm" variant="ghost" disabled={busy || selected===stored} onClick={()=>setSelected(stored)}>Cancel</Button></div>
    </Section>
    {ws && loaded ? <LinkDefaultsSection key={ws} ws={ws} connections={connections}
      repositories={stored.split(",").filter(Boolean)} onDirtyChange={setDefaultsDirty} /> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <p className="text-xs text-muted-foreground">Cloud-only sessions show synced links and shared cached context. Live reads require a configured connection on the machine running Staple.</p>
  </div>;
}
