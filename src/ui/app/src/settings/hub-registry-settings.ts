/**
 * THE HUB REGISTRY PANEL, AS PURE FUNCTIONS — STA-289.
 *
 * The decisions `HubRegistryPanel.tsx` draws from, kept out of the component for the
 * reason `cloud-settings.ts` is: the suite renders to a string and has no DOM, so a
 * rule that lives inside a component can only be tested by grepping its source.
 *
 * Every function here reads VALUES off a report — `hubId`, `connected`, `consent`,
 * `backup`, an outcome — and never parses a sentence. Sentences come from the server
 * (the orphan notice, the restore disclosure, every adoption reason) and are rendered,
 * never inspected.
 */
import type {
  AdoptionDecision,
  AdoptionReport,
  ConnectPreview,
  CrossLinkDecision,
  HubCloudReport,
  HubRestoreReport,
  PublishReport,
  RemoteBackup,
} from "@/lib/types";
import { previewFacts, type CloudFact } from "./cloud-settings";

/** Where the hub is on its way to a service. Each stage offers the next step. */
export type HubRegistryStage = "no_identity" | "not_connected" | "connected";

export function hubRegistryStage(report: HubCloudReport): HubRegistryStage {
  const { hubId, connected } = report.self.registry;
  if (hubId === null) return "no_identity";
  return connected ? "connected" : "not_connected";
}

/** Every press the panel offers. One at a time. */
export type HubRegistryAction =
  | "consent"
  | "mint"
  | "identity"
  | "connect"
  | "disconnect"
  | "publish"
  | "backupConsent"
  | "backups"
  | "backupCreate"
  | "restore"
  | "adopt"
  | "apply";

/**
 * Why each press is unavailable, or null when it works.
 *
 * **Never used to hide a control.** Same rule as every other control on this page: a
 * button that disappears teaches nobody it exists, and a reason stated once in a line
 * is cheaper than a person wondering where "restore" went.
 */
export function hubRegistryBlocks(report: HubCloudReport): Record<HubRegistryAction, string | null> {
  const { hubId, connected, consent, backup } = report.self.registry;
  const needIdentity = hubId === null ? "The hub has no registry identity yet." : null;
  const needConnection = needIdentity ?? (connected ? null : "The hub is not connected to a service.");
  return {
    consent: needConnection,
    mint: null,
    identity: connected
      ? "Disconnect the hub first: taking on another id while connected would leave what it " +
        "published with nothing on this machine pointing at it."
      : null,
    connect: needIdentity,
    disconnect: needConnection,
    publish: needConnection ?? (consent ? null : "Publishing is off. Turn it on above first."),
    backupConsent: needConnection,
    backups: needConnection ?? (backup ? null : "Hub backups are off."),
    backupCreate: needConnection ?? (backup ? null : "Hub backups are off."),
    restore:
      needConnection ??
      (!backup
        ? "Hub backups are off."
        : consent
          ? null
          : "A restore rewrites the published registry, so it needs publishing on too."),
    adopt: needConnection,
    apply: needConnection,
  };
}

/**
 * The hub connect preview's facts: the workspace connect's own renderer, with the one
 * label that would mislead renamed. The repository here IS the hub.
 */
export function hubPreviewFacts(preview: ConnectPreview): CloudFact[] {
  return previewFacts(preview).map((fact) =>
    fact.label === "Repository" ? { label: "Hub id", value: fact.value } : fact,
  );
}

/**
 * What connecting the hub does, in the CLI's terms (`runConnect` in
 * `src/commands/hub-registry.ts`). Not the workspace `CONNECT_DISCLOSURE`: a hub holds
 * no issues, so the plaintext sentence about issue contents is not true of it, and the
 * thing that stays off is publishing rather than automatic sync.
 */
export const HUB_CONNECT_DISCLOSURE: readonly string[] = [
  "This is the hub's own connection, not a workspace's. It lets this machine publish and restore its workspace list.",
  "The credential is stored on this machine only.",
  "PUBLISHING STAYS OFF. Nothing about your workspaces is uploaded until you turn it on — a separate decision.",
  "Nothing has been sent yet. Declining leaves no credential and no setting.",
];

/** What disconnecting the hub does, as `staple hub registry disconnect` prints it. */
export const HUB_DISCONNECT_WARNING =
  "The hub's credential is removed from this machine. The published registry is not deleted, " +
  "other machines are unaffected, and every workspace is untouched. Re-connecting needs the " +
  "enrollment secret again.";

/** A backup id is a UUID; eight characters is enough to tell two apart on a phone. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One backup, in a line: when, how big, which epoch. */
export function backupFacts(backup: RemoteBackup): string {
  const when = new Date(backup.createdAt).toISOString().slice(0, 16).replace("T", " ");
  return `${when} UTC · epoch ${backup.epoch} · ${plural(backup.entityCount, "entity", "entities")}`;
}

/**
 * The restore button's label, and it IS the enumeration: which backup, which epoch,
 * how many entities. Confirming a restore by pressing "Yes" would be agreeing to a
 * word; this names the three facts the server then checks against its own list.
 */
export function restoreConfirmLabel(backup: RemoteBackup): string {
  return (
    `Restore ${shortId(backup.backupId)} · epoch ${backup.epoch} · ` +
    plural(backup.entityCount, "entity", "entities")
  );
}

/** What the restore did on the service, in one line. */
export function restoreSummary(restore: HubRestoreReport): string {
  return (
    `Restored on the service: epoch ${restore.fromEpoch ?? "?"} → ${restore.toEpoch ?? "?"}, ` +
    `${plural(restore.entityCount, "entity", "entities")}.`
  );
}

// ------------------------------------------------------------------ adoption

/** A short label per workspace outcome, in the tense of the report. */
export function decisionLabel(decision: AdoptionDecision, dryRun: boolean): string {
  switch (decision.outcome) {
    case "current":
      return "already here";
    case "adopted":
      return "matched";
    case "absent":
      return dryRun ? "will be listed" : "listed";
    case "declined":
      return "skipped: opted out";
    case "conflict":
      return "parked";
    case "unmatchable":
      return "no identity";
  }
}

/** A short label per link outcome, in the tense of the report. */
export function linkLabel(decision: CrossLinkDecision, dryRun: boolean): string {
  switch (decision.outcome) {
    case "added":
      return dryRun ? "will be linked" : "linked";
    case "current":
      return "already linked";
    case "skipped":
      return "skipped";
    case "removed":
      return dryRun ? "will be removed" : "removed";
    case "kept_removed":
      return "kept removed";
    case "kept_linked":
      return "kept linked";
  }
}

/**
 * Whether a decision's sentence is worth a line. `current` says "already here,
 * nothing to do", which on a list of twelve workspaces is twelve lines of nothing;
 * its label says the same in two words. Every other outcome's sentence is the reason
 * or the remedy, and stays.
 */
export function showsReason(outcome: AdoptionDecision["outcome"] | CrossLinkDecision["outcome"]): boolean {
  return outcome !== "current";
}

/**
 * How many things applying this adoption would change on this machine.
 *
 * `retiring` is the server's list of identities whose stale opt-out applying clears
 * (`retiresOptOuts` on the adopt and restore answers). Those rows are `current` — the
 * outcome says "nothing to do" — and the apply still writes, so they count.
 */
export function adoptionChanges(report: AdoptionReport, retiring: readonly string[]): number {
  const listed = report.decisions.filter((decision) => decision.outcome === "absent").length;
  return listed + report.crossLinks.added + report.crossLinks.removed + retiring.length;
}

/** The adoption in one line: counts per outcome, in the report's own tense. */
export function adoptionSummary(report: AdoptionReport): string {
  const tally = new Map<string, number>();
  for (const decision of report.decisions) {
    const label = decisionLabel(decision, report.dryRun);
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const parts = [...tally].map(([label, count]) => `${count} ${label}`);
  const workspaces =
    report.decisions.length === 0
      ? "The service holds no workspaces"
      : `${plural(report.decisions.length, "workspace")}: ${parts.join(", ")}`;
  const linkTally = new Map<string, number>();
  for (const decision of report.crossLinkDecisions) {
    const label = linkLabel(decision, report.dryRun);
    linkTally.set(label, (linkTally.get(label) ?? 0) + 1);
  }
  const links =
    report.crossLinkDecisions.length === 0
      ? ""
      : ` ${plural(report.crossLinkDecisions.length, "link")}: ${[...linkTally]
          .map(([label, count]) => `${count} ${label}`)
          .join(", ")}.`;
  return `${workspaces}.${links}${report.dryRun ? " Nothing written yet." : ""}`;
}

/** The apply button: what it changes, counted, or null when there is nothing to apply. */
export function applyLabel(report: AdoptionReport, retiring: readonly string[]): string | null {
  const changes = adoptionChanges(report, retiring);
  return changes === 0 ? null : `Apply ${plural(changes, "change")} to this machine`;
}

// ------------------------------------------------------------------- publish

/** The publish in one line, from its counts. */
export function publishSummary(report: PublishReport): string {
  if (report.upToDate) {
    return `Nothing to send: the service already holds this machine's list (epoch ${report.epoch}).`;
  }
  return (
    `Published ${plural(report.published, "change")} in ${plural(report.batches, "batch", "batches")}: ` +
    `${report.created} new, ${report.updated} changed (epoch ${report.epoch}).`
  );
}

/** One titled group of lines under a publish report. Empty groups are not returned. */
export interface PublishGroup {
  key: string;
  title: string;
  lines: string[];
}

/**
 * Every list a publish report carries, as groups a person can scan.
 *
 * Each field of `PublishReport` that is a list appears here, so a field the page does
 * not render is a field missing from this function — which the app-side test checks
 * against a report with every list populated.
 */
export function publishGroups(report: PublishReport): PublishGroup[] {
  const link = (ref: { blockerIdentifier: string; blockedIdentifier: string }) =>
    `${ref.blockerIdentifier} blocks ${ref.blockedIdentifier}`;
  const groups: PublishGroup[] = [
    {
      key: "deduplicated",
      title: "Deduplicated by the service instead of applied — the service may not match this machine",
      lines: report.deduplicated > 0 ? [plural(report.deduplicated, "operation")] : [],
    },
    {
      key: "unadopted",
      title: "On the service but not on this machine — adopt to take them on",
      lines: [
        ...report.unadopted.registrations.map((entry) => entry.slug),
        ...report.unadopted.crossLinks.map(link),
      ],
    },
    {
      key: "renamed",
      title: "Named differently here than in the registry — nothing was renamed",
      lines: report.renamed.map((entry) => {
        const parts = [`"${entry.local}" here, "${entry.published}" in the registry`];
        if (entry.localPrefix !== undefined && entry.publishedPrefix !== undefined) {
          parts.push(`prefix ${entry.localPrefix} here, ${entry.publishedPrefix} in the registry`);
        }
        if (entry.localKind !== undefined && entry.publishedKind !== undefined) {
          parts.push(`kind ${entry.localKind} here, ${entry.publishedKind} in the registry`);
        }
        return parts.join("; ");
      }),
    },
    { key: "retracted", title: "Links removed from the registry", lines: report.retracted.map(link) },
    { key: "relinked", title: "Links put back in the registry", lines: report.relinked.map(link) },
    {
      key: "retained",
      title: "Left as they are on the service",
      lines: report.retained.map((edge) => edge.reason),
    },
    {
      key: "unpublishable",
      title: "Workspaces that could not be published",
      lines: report.unpublishable.map((item) => `${item.entry.slug}: ${item.reason}`),
    },
    {
      key: "unpublishableLinks",
      title: "Links that could not be published",
      lines: report.unpublishableLinks.map((item) => `${link(item.link)}: ${item.reason}`),
    },
    {
      key: "identities",
      title: "Workspace identities",
      lines: [
        ...report.identities.updated.map((row) => `${row.slug}: identity recorded from its manifest`),
        ...report.identities.problems.map((row) => `${row.slug}: ${row.problem}`),
        ...report.identities.duplicates.map(
          (row) => `${row.slugs.join(", ")} share the identity ${row.repositoryId}`,
        ),
      ],
    },
  ];
  return groups.filter((group) => group.lines.length > 0);
}
