/**
 * What Settings → Integrations decides without a DOM: the words on a connection row, the
 * command inside a fix, which sign-ins to offer, the order of workspace rows and what a
 * source chip and the source picker show. Pure, so the tests can pin each decision.
 */
import type { DetectedConnection, ContainerKind } from "../../../../../core/integrations/contracts";
import type { MappingTarget } from "../../../../../core/integrations/mapping";
import type { ConnectionView } from "@/integrations/connection-status";

export type MappedTarget = MappingTarget;
export interface WorkspaceMapping {
  workspace: string;
  targets: MappedTarget[];
}
/** One entry of a `containers` page. `key` is the mapping key, the same as a target's. */
export interface PickerItem {
  id: string;
  name: string;
  url: string;
  kind: ContainerKind;
  scopeId: string;
  key: string;
}
export interface PickerPage {
  items: PickerItem[];
  nextCursor: string | null;
}

/**
 * The command in a fix sentence: what follows "Run " up to a full stop, or to where the
 * server's sentence goes back to prose (", or …", " on the computer …").
 */
export function commandIn(action: string | null): string | null {
  const match = action ? /\bRun (.+?)(?:\.(?:\s|$)|,\s| on the |$)/.exec(action) : null;
  return match?.[1]?.trim() || null;
}

/** The one secondary line under a connection's provider name. Never an id. */
export function connectionMeta(connection: ConnectionView): string {
  if (connection.providerId === "linear")
    return [connection.health?.identity?.login ?? "Linear account", `API key in ${connection.credentialEnv}`].join(" · ");
  return [connection.account, connection.host === "github.com" ? null : connection.host, "through GitHub CLI"].filter(Boolean).join(" · ");
}

/** Sign-ins on this computer that no connection covers yet: each gets a "Connect as" row. */
export function offeredDetections(detected: readonly DetectedConnection[]): DetectedConnection[] {
  return detected.filter((d) => d.configuredConnectionId === null);
}

/** The rail's dot: some connection's last known health is a problem. Unknown is not one. */
export function needsAttention(connections: readonly Pick<ConnectionView, "health">[]): boolean {
  return connections.some((c) => c.health !== null && c.health !== undefined && c.health.state !== "ready");
}

/** The workspace the app is on first, then the rest alphabetically. */
export function orderWorkspaces<T extends { workspace: string }>(rows: readonly T[], current: string): T[] {
  return [...rows].sort((a, b) => Number(b.workspace === current) - Number(a.workspace === current) || a.workspace.localeCompare(b.workspace));
}

/** What a workspace with no sources searches, in the person's words. */
export function unmappedSentence(rows: readonly WorkspaceMapping[], workspace: string): string {
  return rows.some((r) => r.workspace !== workspace && r.targets.length > 0) ? "Searches everything chosen here" : "Nothing to search yet";
}

/** A chip's text and tooltip. A source never read on any computer is named by its kind, never by a piece of its id. */
export function chipLabel(target: MappedTarget): { text: string; title: string } {
  if (target.name) return { text: target.name, title: target.name };
  return { text: `Unnamed ${target.kind}`, title: "Name unavailable until this source is read again" };
}

const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What is wrong with the Linear form's two ids, before the server is asked; null while they are empty or right. */
export function linearIdProblem(organization: string, user: string): string | null {
  const wrong = (value: string) => value.trim() !== "" && !LINEAR_ID.test(value.trim());
  const field = wrong(organization) ? "Organization ID" : wrong(user) ? "Your user ID" : null;
  return field ? `${field} should be the 36-character id Linear shows, like 123e4567-e89b-12d3-a456-426614174000.` : null;
}

export interface PickerSection {
  kind: ContainerKind;
  /** "Teams" / "Projects" under a Linear connection; null for a GitHub connection's one list. */
  label: string | null;
  items: Array<PickerItem & { mapped: boolean }>;
  nextCursor: string | null;
}

/** One connection's group in the picker: its lists, each item marked when the workspace already has it. */
export function pickerSections(
  providerId: string,
  pages: Partial<Record<ContainerKind, PickerPage>>,
  targets: readonly MappedTarget[],
): PickerSection[] {
  const mapped = new Set(targets.map((t) => t.key));
  const kinds: Array<[ContainerKind, string | null]> = providerId === "linear" ? [["team", "Teams"], ["project", "Projects"]] : [["repository", null]];
  return kinds.flatMap(([kind, label]) => {
    const page = pages[kind];
    if (!page) return [];
    return [{ kind, label, items: page.items.map((item) => ({ ...item, mapped: mapped.has(item.key) })), nextCursor: page.nextCursor }];
  });
}
