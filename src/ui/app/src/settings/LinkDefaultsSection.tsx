import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Section } from "./form/primitives";
import { containerPrefix, loadLinkDefaults, resolveLinkDefaults, saveLinkDefaults, type LinkDefaults } from "@/integrations/link-defaults";
import type { ProviderConnection } from "../../../../core/integrations/connections";

export function LinkDefaultsSection({ ws, connections, repositories, onDirtyChange }: {
  ws: string; connections: ProviderConnection[]; repositories: string[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState(() => loadLinkDefaults(ws));
  const [edited, setDraft] = useState<LinkDefaults | null>(null);
  const baseline = resolveLinkDefaults(saved, connections, repositories);
  const draft = edited ?? baseline;
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(baseline) !== JSON.stringify(draft);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const valid = resolveLinkDefaults(draft, connections, repositories);
  const connection = connections.find(c => c.id === valid.connectionId);
  return <Section title="Link dialog defaults" error={error}
    description="Start the Link issue or PR dialog with these selections. Saved in this browser for this workspace. The Link issue and Link PR shortcuts always choose their own type.">
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm"><span>Default connection</span>
        <select aria-label="Default connection" className="block w-full min-w-0 rounded-md border bg-background p-2" value={valid.connectionId}
          onChange={e => { setDraft({ ...draft, connectionId: e.target.value, repository: "" }); setMessage(""); }}>
          <option value="">Cached context only</option>
          {connections.map(c => <option key={c.id} value={c.id}>{c.account} · {c.host}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm"><span>Default container</span>
        <select aria-label="Default container" className="block w-full min-w-0 rounded-md border bg-background p-2" value={valid.repository} disabled={!connection}
          onChange={e => { setDraft({ ...draft, repository: e.target.value }); setMessage(""); }}>
          <option value="">All accessible repositories / teams</option>
          {repositories.filter(r => connection && r.startsWith(containerPrefix(connection))).map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm"><span>Default resource type</span>
        <select aria-label="Default resource type" className="block w-full rounded-md border bg-background p-2" value={valid.kind}
          onChange={e => { setDraft({ ...draft, kind: e.target.value as typeof draft.kind }); setMessage(""); }}>
          <option value="issue">Issues</option><option value="pull_request" disabled={connection?.providerId === "linear"}>Pull requests</option>
        </select>
      </label>
    </div>
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={draft.rememberLastUsed === true}
        onChange={e => { setDraft({ ...draft, rememberLastUsed: e.target.checked || undefined }); setMessage(""); }} />
      <span>Remember last-used selections<span className="mt-1 block text-xs text-muted-foreground">
        Reuse the latest connection, container and type from this dialog. Saved defaults apply until the first use. Turn this off to always use saved defaults.
      </span></span>
    </label>
    <div className="flex gap-2">
      <Button size="sm" disabled={!dirty} onClick={() => {
        setError(null);
        if (!saveLinkDefaults(ws, valid)) { setError("Browser storage is unavailable. Defaults could not be saved."); return; }
        setSaved(valid); setDraft(null); setMessage("Link dialog defaults saved.");
      }}>Save defaults</Button>
      <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => { setDraft(null); setError(null); setMessage(""); }}>Cancel</Button>
    </div>
    {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
  </Section>;
}
