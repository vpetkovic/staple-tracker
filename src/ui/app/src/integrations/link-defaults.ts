import type { ProviderConnection } from "../../../../core/integrations/connections";

export interface LinkDefaults {
  connectionId: string;
  repository: string;
  kind: "issue" | "pull_request";
  rememberLastUsed?: boolean;
}
const key = (ws: string) => `staple:link-defaults:v1:${ws}`;

export function loadLinkDefaults(ws: string): LinkDefaults | null {
  return readChoices(key(ws));
}

function readChoices(storageKey: string): LinkDefaults | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<LinkDefaults>;
    if (typeof v.connectionId !== "string" || typeof v.repository !== "string" ||
        (v.kind !== "issue" && v.kind !== "pull_request")) return null;
    return { connectionId: v.connectionId, repository: v.repository, kind: v.kind,
      ...(v.rememberLastUsed === true ? { rememberLastUsed: true } : {}) };
  } catch { return null; }
}

export function saveLinkDefaults(ws: string, defaults: LinkDefaults): boolean {
  return writeChoices(key(ws), defaults);
}

function writeChoices(storageKey: string, defaults: LinkDefaults): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      connectionId: defaults.connectionId, repository: defaults.repository, kind: defaults.kind,
      ...(defaults.rememberLastUsed ? { rememberLastUsed: true } : {}),
    }));
    return true;
  } catch { return false; }
}

/** A removed saved account falls back to cached-only, never another account. */
export function resolveLinkDefaults(
  saved: LinkDefaults | null, connections: ProviderConnection[], repositories: string[],
): LinkDefaults {
  const connectionId = saved
    ? connections.find(c => c.id === saved.connectionId)?.id ?? ""
    : connections.length === 1 ? connections[0]!.id : "";
  const connection = connections.find(c => c.id === connectionId);
  return {
    connectionId,
    repository: connection && saved?.repository.startsWith(containerPrefix(connection)) &&
      repositories.includes(saved.repository) ? saved.repository : "",
    kind: connection?.providerId === "linear" ? "issue" : saved?.kind ?? "issue",
    ...(saved?.rememberLastUsed ? { rememberLastUsed: true } : {}),
  };
}

const lastKey = (ws: string) => `staple:link-last-used:v1:${ws}`;

export function rememberLinkChoices(ws: string, choices: LinkDefaults): boolean {
  if (!loadLinkDefaults(ws)?.rememberLastUsed) return false;
  return writeChoices(lastKey(ws), choices);
}

export function loadPickerDefaults(ws: string, connections: ProviderConnection[], repositories: string[]): LinkDefaults {
  const saved = loadLinkDefaults(ws);
  const last = saved?.rememberLastUsed ? readChoices(lastKey(ws)) : null;
  return resolveLinkDefaults(last ?? saved, connections, repositories);
}

/** Keep existing GitHub choices readable; Linear teams are scoped to their organization. */
export function containerPrefix(connection: ProviderConnection): string {
  return connection.providerId === "linear" ? `${connection.host}/${connection.scopeId}/` : `${connection.host}/`;
}
