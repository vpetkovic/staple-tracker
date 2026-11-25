/**
 * What Settings → Integrations decides without a DOM: the words on a connection row, the
 * command inside a fix, which sign-ins to offer, the order of workspace rows and what a
 * source chip and the source picker show. Pure, so the tests can pin each decision.
 */
import type { DetectedConnection, ContainerKind } from "../../../../../core/integrations/contracts";
import type { MappingTarget } from "../../../../../core/integrations/mapping";
import { isServices, placeProblem, SERVICES_HOST } from "../../../../../core/integrations/azure-devops-url";
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
 * What Add connection lists. The planned providers are shown so the list reads as a roadmap,
 * and cannot be chosen until their adapter exists.
 */
export const CONNECTION_CHOICES: ReadonlyArray<{ providerId: string; label: string; available: boolean }> = [
  { providerId: "github", label: "GitHub account or Enterprise host", available: true },
  { providerId: "linear", label: "Linear workspace", available: true },
  { providerId: "azure_devops", label: "Azure DevOps organization", available: true },
  { providerId: "clickup", label: "ClickUp", available: false },
];

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
    return [connection.health?.identity?.login ?? "Linear account", connection.health?.identity?.organization, `API key in ${connection.credentialEnv}`].filter(Boolean).join(" · ");
  if (connection.providerId === "azure_devops")
    return [connection.health?.identity?.login ?? "Azure DevOps account", azurePlaceName(connection), `token in ${connection.credentialEnv}`].filter(Boolean).join(" · ");
  return [connection.account, connection.host === "github.com" ? null : connection.host, "through GitHub CLI"].filter(Boolean).join(" · ");
}

/** An Azure DevOps connection's place: its organization, or a Server's host and collection. */
export function azurePlaceName(connection: { host: string; organization: string }): string {
  return isServices(connection.host) ? connection.organization : `${connection.host}/${connection.organization}`;
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

/**
 * What is wrong with the Azure DevOps form before the server is asked: the optional Server host,
 * then the organization (or collection). Null while the fields are empty or right.
 */
export function azureOrganizationProblem(organization: string, server = ""): string | null {
  const host = server.trim().toLowerCase() || SERVICES_HOST;
  if (!isServices(host)) {
    const hostProblem = placeProblem({ host, organization: "DefaultCollection" });
    if (hostProblem) return hostProblem;
  }
  return organization.trim() === "" ? null : placeProblem({ host, organization: organization.trim() });
}

/** The hint under the Azure DevOps organization field, from what listing the token's organizations found. */
export function azureOrganizationHint(found: readonly { name: string }[] | null, finding: boolean, server: string): string {
  const noun = server.trim() && !isServices(server.trim()) ? "collection" : "organization";
  if (finding) return `Looking for the ${noun}s this token reaches…`;
  if (found === null) return `Staple reads your user and ${noun} from the token when you save.`;
  if (found.length > 1) return `Choose one of the ${noun}s this token reaches, or type another. Add a connection for each ${noun} you want.`;
  if (found.length === 1) return `This token reaches ${found[0]!.name}.`;
  return `Type the ${noun} name. This token doesn't list ${noun}s, usually because it was made for one ${noun}.`;
}

/** The kinds of source a connection offers, in picker order. */
export function containerKinds(providerId: string): ContainerKind[] {
  return providerId === "linear" ? ["team", "project"] : providerId === "azure_devops" ? ["project"] : ["repository"];
}

export interface PickerSection {
  kind: ContainerKind;
  /** "Teams" / "Projects" under a Linear connection; null for a connection's one list. */
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
  const kinds: Array<[ContainerKind, string | null]> = providerId === "linear" ? [["team", "Teams"], ["project", "Projects"]] : containerKinds(providerId).map((kind) => [kind, null]);
  return kinds.flatMap(([kind, label]) => {
    const page = pages[kind];
    if (!page) return [];
    return [{ kind, label, items: page.items.map((item) => ({ ...item, mapped: mapped.has(item.key) })), nextCursor: page.nextCursor }];
  });
}
