/**
 * THE HUB REGISTRY PANEL — STA-289, the page half.
 *
 * `test/ui-hub-registry.test.ts` proves the routes act; this proves the panel offers
 * each act at the right moment, shows what it must before each yes, and renders what
 * came back. No DOM here (see vitest.config.ts): every state is a value passed to the
 * pure `HubRegistryPanel`, and the wiring is pinned at the source.
 *
 * The sentences that carry consent — the orphan notice, the restore disclosure, the
 * publish disclosure — reach this panel as values from the server. Each is asserted
 * rendered from the value and absent from the component's own source, because a copy
 * typed here would render identically today and drift silently afterwards.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AdoptionReport,
  ConnectPreview,
  HubCloudReport,
  HubRestoreReport,
  PublishReport,
  RemoteBackup,
} from "@/lib/types";
import {
  AdoptionView,
  HubRegistryPanel,
  IDLE_REGISTRY,
  PublishView,
  type HubRegistryActions,
  type HubRegistryState,
} from "./HubRegistryPanel";
import {
  adoptionChanges,
  applyLabel,
  hubRegistryBlocks,
  hubRegistryStage,
  publishGroups,
  restoreConfirmLabel,
} from "./hub-registry-settings";

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
const code = (file: string): string =>
  source(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const NOOP = () => {};
const ACTIONS: HubRegistryActions = {
  onConsent: NOOP,
  onMint: NOOP,
  onIdentityOpen: NOOP,
  onIdentityDraft: NOOP,
  onIdentitySubmit: NOOP,
  onIdentityConfirm: NOOP,
  onConnectDraft: NOOP,
  onConnectPreview: NOOP,
  onConnectCancel: NOOP,
  onConnect: NOOP,
  onAskDisconnect: NOOP,
  onDisconnect: NOOP,
  onPublish: NOOP,
  onBackupConsent: NOOP,
  onBackups: NOOP,
  onBackupCreate: NOOP,
  onAskRestore: NOOP,
  onRestore: NOOP,
  onAdoptPreview: NOOP,
  onApply: NOOP,
  onDismissAdoption: NOOP,
};

const HUB_ID = "8a7f2c10-4b5e-4f00-9e11-0000000000aa";
const DISCLOSURE =
  "a machine that publishes its registry tells the service the names, prefixes and " +
  "identities of every workspace on it, and that they sit together.";

function report(registry: Partial<HubCloudReport["self"]["registry"]> = {}): HubCloudReport {
  return {
    workspaces: [],
    counts: { total: 0, connected: 0, disconnected: 0, skipped: 0, actionable: 0, automatic: 0 },
    self: {
      registered: 0,
      present: 0,
      absent: 0,
      crossLinks: 0,
      backupHeadline: "headline",
      backupContents: [],
      backupExclusions: [],
      registry: {
        hubId: null,
        connected: false,
        endpoint: null,
        disclosure: DISCLOSURE,
        consent: false,
        backup: false,
        ...registry,
      },
    },
    endpoints: [],
  };
}

const CONNECTED = report({ hubId: HUB_ID, connected: true, endpoint: "https://sync.example.com" });
const PUBLISHING = report({ hubId: HUB_ID, connected: true, endpoint: "https://sync.example.com", consent: true });
const EVERYTHING_ON = report({
  hubId: HUB_ID,
  connected: true,
  endpoint: "https://sync.example.com",
  consent: true,
  backup: true,
});

function render(
  hub: HubCloudReport,
  state: Partial<HubRegistryState> = {},
  extra: { locked?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <HubRegistryPanel
      report={hub}
      state={{ ...IDLE_REGISTRY, ...state }}
      actions={ACTIONS}
      locked={extra.locked ?? false}
    />,
  );
}

/** The real `disabled` attribute — not `data-disabled="false"`, which contains the word. */
const DISABLED = /\sdisabled(=""|[\s>])/;

/** The `<button>` carrying a data attribute, as markup, so its `disabled` can be read. */
function button(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  expect(at, `${attribute} was not rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

const BACKUP: RemoteBackup = {
  backupId: "b1c2d3e4-5555-4666-8777-000000000001",
  epoch: 3,
  cutoffSeq: 12,
  entityCount: 7,
  opCount: 12,
  schemaVersion: 0,
  protocol: 2,
  kind: "manual",
  createdAt: Date.UTC(2026, 8, 10, 9, 30),
  createdByDevice: "device-a",
};
const UNDO: RemoteBackup = { ...BACKUP, backupId: "0ddba11a-5555-4666-8777-000000000002", kind: "pre-restore" };

function adoption(overrides: Partial<AdoptionReport> = {}): AdoptionReport {
  return {
    hubId: HUB_ID,
    capturedAt: "2026-09-10T00:00:00.000Z",
    decisions: [
      {
        entry: { repositoryId: "r-a", slug: "alpha", prefix: "ALP", kind: "repo", addedAt: "t" },
        outcome: "current",
        reason: "ALPHA-CURRENT-SENTENCE",
        localSlug: "alpha",
        conflict: null,
      },
      {
        entry: { repositoryId: "r-c", slug: "charlie", prefix: "CHA", kind: "repo", addedAt: "t" },
        outcome: "absent",
        reason: "CHARLIE-ABSENT-SENTENCE",
        localSlug: "charlie",
        conflict: null,
      },
      {
        entry: { repositoryId: "r-d", slug: "delta", prefix: "ALP", kind: "repo", addedAt: "t" },
        outcome: "conflict",
        reason: "DELTA-PARKED-SENTENCE",
        localSlug: null,
        conflict: { field: "prefix", value: "ALP", heldBySlug: "alpha", heldByRepositoryId: "r-a" },
      },
      {
        entry: { repositoryId: "r-e", slug: "echo", prefix: "ECH", kind: "repo", addedAt: "t" },
        outcome: "declined",
        reason: "ECHO-OPTED-OUT-SENTENCE",
        localSlug: null,
        conflict: null,
      },
    ],
    crossLinks: { added: 1, skipped: 0, current: 0, removed: 1, keptRemoved: 1, keptLinked: 0 },
    crossLinkDecisions: [
      {
        link: {
          blockerRepositoryId: "r-a",
          blockerWs: "alpha",
          blockerIdentifier: "ALP-1",
          blockedRepositoryId: "r-c",
          blockedWs: "charlie",
          blockedIdentifier: "CHA-2",
          type: "blocks",
        },
        outcome: "added",
        reason: "LINK-ADDED-SENTENCE",
      },
      {
        link: {
          blockerRepositoryId: "r-a",
          blockerWs: "alpha",
          blockerIdentifier: "ALP-3",
          blockedRepositoryId: "r-c",
          blockedWs: "charlie",
          blockedIdentifier: "CHA-4",
          type: "blocks",
        },
        outcome: "removed",
        reason: "LINK-REMOVED-SENTENCE",
      },
      {
        link: {
          blockerRepositoryId: "r-a",
          blockerWs: "alpha",
          blockerIdentifier: "ALP-5",
          blockedRepositoryId: "r-c",
          blockedWs: "charlie",
          blockedIdentifier: "CHA-6",
          type: "blocks",
        },
        outcome: "kept_removed",
        reason: "LINK-KEPT-REMOVED-SENTENCE",
      },
    ],
    dryRun: true,
    ...overrides,
  };
}

const LINK = { entityId: "e", blockerIdentifier: "ALP-1", blockedIdentifier: "CHA-2" };
/** Every list on a publish report populated, so a list the page drops is a failing key. */
const FULL_PUBLISH: PublishReport = {
  hubId: HUB_ID,
  endpoint: "https://sync.example.com",
  epoch: 2,
  published: 3,
  created: 2,
  updated: 1,
  batches: 1,
  applied: 3,
  deduplicated: 1,
  unpublishable: [
    { entry: { repositoryId: null, slug: "loose", prefix: "LOO", kind: "repo", addedAt: "t" }, reason: "NO-IDENTITY" },
  ],
  unpublishableLinks: [
    {
      link: {
        blockerRepositoryId: null,
        blockerWs: "loose",
        blockerIdentifier: "LOO-1",
        blockedRepositoryId: "r-a",
        blockedWs: "alpha",
        blockedIdentifier: "ALP-9",
        type: "blocks",
      },
      reason: "LINK-NO-IDENTITY",
    },
  ],
  retained: [{ entityId: "x", reason: "RETAINED-REASON" }],
  retracted: [LINK],
  relinked: [{ ...LINK, blockerIdentifier: "ALP-7" }],
  renamed: [
    {
      entityId: "r-a",
      local: "alpha-here",
      published: "alpha",
      localPrefix: "ALH",
      publishedPrefix: "ALP",
    },
  ],
  unadopted: { registrations: [{ entityId: "r-z", slug: "zulu" }], crossLinks: [LINK] },
  identities: {
    updated: [{ slug: "alpha", repositoryId: "r-a" }],
    problems: [{ slug: "broken", problem: "MANIFEST-PROBLEM" }],
    duplicates: [{ repositoryId: "r-dup", slugs: ["one", "two"] }],
  },
  upToDate: false,
};

// ----------------------------------------------------------------- identity

describe("identity", () => {
  it("says there is none, offers to mint or take one on, and blocks connecting", () => {
    const html = render(report());
    expect(hubRegistryStage(report())).toBe("no_identity");
    expect(html).toContain('data-stage="no_identity"');
    expect(html).toContain("None yet.");
    expect(html).not.toContain("data-hub-registry-id");
    expect(button(html, 'data-hub-registry-action="mint"')).not.toMatch(DISABLED);
    expect(button(html, 'data-hub-registry-action="identity"')).not.toMatch(DISABLED);
    // Connecting is offered, disabled, with its reason — never hidden — and the
    // reason is said once for everything that waits on an identity.
    expect(button(html, "data-hub-registry-connect-preview")).toMatch(DISABLED);
    expect(html).toContain("need a registry identity first");
    expect(html.match(/need a registry identity first/g)).toHaveLength(1);
    // The publish switch's own copy of that reason is not repeated underneath it.
    // (It stays in the switch's `title`, for a pointer; it is not a second paragraph.)
    expect(html).not.toMatch(/<p[^>]*>[^<]*no connection for this consent to be recorded against/);
  });

  it("shows the id it has, and offers no mint once there is one", () => {
    const html = render(report({ hubId: HUB_ID }));
    expect(html).toContain(HUB_ID);
    expect(html).not.toContain('data-hub-registry-action="mint"');
    expect(html).toContain("Take on another id");
  });

  it("refuses to take on another id while connected, with the reason", () => {
    const blocks = hubRegistryBlocks(CONNECTED);
    expect(blocks.identity).toContain("Disconnect the hub first");
    expect(button(render(CONNECTED), 'data-hub-registry-action="identity"')).toMatch(DISABLED);
  });

  it("shows the server's orphan notice before the yes, from the state and not a literal", () => {
    const notice = "ORPHAN-NOTICE-FROM-THE-SERVER naming the previous id";
    const html = render(report({ hubId: HUB_ID }), {
      identity: { open: true, draft: "other", confirm: { hubId: "other-id-123456", notice }, outcome: null },
    });
    expect(html).toContain("data-destructive-confirm");
    expect(html).toContain(notice);
    expect(html).toContain("Take on other-id");
  });

  it("states the orphan notice after a replacement whenever the server sent one", () => {
    const notice = "If anything was ever published under OLD, that registry stays on the service.";
    const replaced = render(report({ hubId: HUB_ID }), {
      identity: { ...IDLE_REGISTRY.identity, outcome: { kind: "adopted", hubId: HUB_ID, notice } },
    });
    expect(replaced).toContain("data-hub-registry-orphan-notice");
    expect(replaced).toContain(notice);
    const first = render(report({ hubId: HUB_ID }), {
      identity: { ...IDLE_REGISTRY.identity, outcome: { kind: "adopted", hubId: HUB_ID, notice: null } },
    });
    expect(first).not.toContain("data-hub-registry-orphan-notice");
  });

  it("never words the orphan notice itself", () => {
    // The sentence is `describeIdentityReplacement` on the server. A copy here would
    // be a second wording of the one disclosure the ticket insists is unconditional.
    for (const file of ["HubRegistryPanel.tsx", "hub-registry-settings.ts"]) {
      expect(code(file), file).not.toMatch(/stays on the service|re-adopting/i);
    }
    expect(code("HubRegistryPanel.tsx")).toContain("state.identity.confirm.notice");
    expect(code("HubRegistryPanel.tsx")).toContain("state.identity.outcome.notice");
  });
});

// ----------------------------------------------------------------- connect

const PREVIEW: ConnectPreview = {
  endpoint: { origin: "https://sync.example.com", host: "sync.example.com", loopback: false },
  repositoryId: HUB_ID,
  deviceId: null,
  label: "laptop",
  credentialMechanism: "file",
  credentialFallbackReason: null,
  alreadyConnected: false,
  existingEndpoint: null,
  autoAfterConnect: false,
};

describe("connect", () => {
  it("collapses the form behind a summary that keeps its triangle", () => {
    const html = render(report({ hubId: HUB_ID }));
    expect(html).toContain('data-hub-registry-disclosure="connect"');
    const summary = html.slice(html.indexOf("<summary", html.indexOf('data-hub-registry-disclosure="connect"')));
    const classes = summary.slice(summary.indexOf('class="') + 7, summary.indexOf('"', summary.indexOf('class="') + 7));
    for (const utility of ["flex", "inline-flex", "block", "inline-block", "grid", "hidden", "contents"]) {
      expect(classes.split(/\s+/)).not.toContain(utility);
    }
  });

  it("shows the hub's own preview before the yes, naming the hub id and the service", () => {
    const html = render(report({ hubId: HUB_ID }), {
      connectPending: { preview: PREVIEW, consent: { id: "c", digest: "d", expiresAt: "x" } },
    });
    expect(html).toContain("data-hub-registry-consent");
    expect(html).toContain("Hub id");
    expect(html).toContain(HUB_ID);
    expect(html).toContain("https://sync.example.com");
    expect(html).toContain("PUBLISHING STAYS OFF");
    // The form is gone while the consent screen is up; nothing is collapsed.
    expect(html).not.toContain('data-hub-registry-disclosure="connect"');
  });

  it("sends only the ticket and the secret to connect: no endpoint, no repository id", () => {
    const client = code("../lib/api.ts");
    const call = client.slice(
      client.indexOf("export const connectHubRegistry"),
      client.indexOf("export const disconnectHubRegistry"),
    );
    expect(call).toContain("consent: target.consent.id");
    expect(call).not.toMatch(/endpoint|repositoryId/);
  });

  it("offers disconnect once connected, behind a confirmation", () => {
    const asking = render(CONNECTED, { disconnecting: true });
    expect(asking).toContain("data-destructive-confirm");
    expect(asking).toContain("The published registry is not deleted");
  });
});

// ----------------------------------------------------------------- publish

describe("publish", () => {
  it("offers Publish now only once the hub is connected AND publishing is on", () => {
    expect(button(render(report({ hubId: HUB_ID })), 'data-hub-registry-action="publish"')).toMatch(DISABLED);
    const off = render(CONNECTED);
    expect(button(off, 'data-hub-registry-action="publish"')).toMatch(DISABLED);
    expect(off).toContain("Publishing is off. Turn it on above first.");
    expect(button(render(PUBLISHING), 'data-hub-registry-action="publish"')).not.toMatch(DISABLED);
  });

  it("keeps the publish switch, with the disclosure from the report, beside Publish now", () => {
    const html = render(CONNECTED);
    const block = html.slice(html.indexOf('data-hub-registry-block="publish"'));
    expect(block).toContain("data-cloud-hub-registry-toggle");
    expect(block.indexOf("names, prefixes and identities")).toBeLessThan(
      block.indexOf('data-hub-registry-action="publish"'),
    );
  });

  it("renders every list a publish report carries", () => {
    expect(publishGroups(FULL_PUBLISH).map((group) => group.key).sort()).toEqual(
      [
        "deduplicated",
        "identities",
        "relinked",
        "renamed",
        "retained",
        "retracted",
        "unadopted",
        "unpublishable",
        "unpublishableLinks",
      ].sort(),
    );
    const html = renderToStaticMarkup(<PublishView report={FULL_PUBLISH} />);
    for (const text of [
      "Published 3 changes in 1 batch",
      "zulu",
      "&quot;alpha-here&quot; here, &quot;alpha&quot; in the registry",
      "prefix ALH here, ALP in the registry",
      "RETAINED-REASON",
      "NO-IDENTITY",
      "LINK-NO-IDENTITY",
      "MANIFEST-PROBLEM",
      "one, two share the identity r-dup",
      "ALP-7 blocks CHA-2",
    ]) {
      expect(html, text).toContain(text);
    }
  });

  it("says nothing was sent when the service already held this machine's list", () => {
    const html = renderToStaticMarkup(
      <PublishView report={{ ...FULL_PUBLISH, upToDate: true, published: 0, deduplicated: 0 }} />,
    );
    expect(html).toContain("Nothing to send");
  });

  it("has no branch for the one-machine refusal, which no longer exists", () => {
    for (const file of ["HubRegistryPanel.tsx", "hub-registry-settings.ts"]) {
      expect(code(file), file).not.toMatch(/foreign/i);
    }
  });
});

// ----------------------------------------------------------------- backups and restore

const NOTICE = {
  headline: "NOTICE-HEADLINE-FROM-THE-SERVER",
  bullets: ["NOTICE-BULLET-ONE", "NOTICE-BULLET-TWO", "NOTICE-BULLET-THREE"],
};

describe("backups and restore", () => {
  it("gates the backup list on the backup consent, and restore on both consents", () => {
    expect(hubRegistryBlocks(PUBLISHING).backups).toBe("Hub backups are off.");
    expect(hubRegistryBlocks(report({ hubId: HUB_ID, connected: true, backup: true })).restore).toContain(
      "publishing on",
    );
    expect(hubRegistryBlocks(EVERYTHING_ON).restore).toBeNull();
    expect(button(render(EVERYTHING_ON), 'data-hub-registry-action="backups"')).not.toMatch(DISABLED);
  });

  it("asks the service for nothing until the list is asked for", () => {
    const html = render(EVERYTHING_ON);
    expect(html).toContain("Show backups");
    expect(html).not.toContain("data-hub-registry-backups");
  });

  it("confirms a restore over the enumeration, with the server's disclosure", () => {
    const html = render(EVERYTHING_ON, { backups: [BACKUP], restoreNotice: NOTICE, restoring: BACKUP });
    const confirm = html.slice(html.indexOf("data-hub-registry-restore-confirm"));
    expect(confirm).toContain(NOTICE.headline);
    for (const bullet of NOTICE.bullets) expect(confirm).toContain(bullet);
    // The button IS the enumeration: which backup, which epoch, how many entities.
    const label = restoreConfirmLabel(BACKUP);
    expect(label).toBe("Restore b1c2d3e4 · epoch 3 · 7 entities");
    expect(confirm).toContain(label);
    expect(confirm).toContain(BACKUP.backupId);
  });

  it("sends the three facts it showed, and the server checks them", () => {
    const client = code("../lib/api.ts");
    const call = client.slice(client.indexOf("export const restoreHubRegistry"), client.indexOf("export const adoptHubRegistry"));
    for (const field of ["backupId: backup.backupId", "epoch: backup.epoch", "entityCount: backup.entityCount", "confirm: true"]) {
      expect(call, field).toContain(field);
    }
  });

  it("never words the restore disclosure itself", () => {
    expect(code("HubRegistryPanel.tsx")).not.toMatch(/new epoch|every machine on this hub/i);
    expect(code("HubRegistryPanel.tsx")).toContain("state.restoreNotice.bullets");
  });

  it("names the undo after a restore, and marks it in the list", () => {
    const restored: HubRestoreReport = {
      hubId: HUB_ID,
      backupId: BACKUP.backupId,
      fromEpoch: 3,
      toEpoch: 4,
      entityCount: 7,
      preRestoreBackupId: UNDO.backupId,
      turns: 2,
      registry: { format: 1, hubId: HUB_ID, capturedAt: "t", workspaces: [], crossLinks: [] },
      adoption: adoption(),
    };
    const html = render(EVERYTHING_ON, {
      backups: [UNDO, BACKUP],
      restoreNotice: NOTICE,
      restored,
      adoption: { report: restored.adoption, digest: "d" },
    });
    expect(html).toContain("Restored on the service: epoch 3 → 4, 7 entities.");
    expect(html).toContain(`Undo: restore ${UNDO.backupId}`);
    const undoRow = html.slice(html.indexOf(`data-hub-registry-backup="${UNDO.backupId}"`));
    expect(undoRow.slice(0, undoRow.indexOf("</li>"))).toContain(">undo<");
    // And the adoption of what came back is waiting on its own apply.
    expect(html).toContain("data-hub-registry-apply");
    expect(html).toContain("unchanged until you apply the adoption below");
    // With nothing to apply, the line does not point at a button that is not there.
    const nothing = adoption({ decisions: [], crossLinks: { ...adoption().crossLinks, added: 0, removed: 0 } });
    const quiet = render(EVERYTHING_ON, {
      backups: [UNDO, BACKUP],
      restored: { ...restored, adoption: nothing },
      adoption: { report: nothing, digest: "d" },
    });
    expect(quiet).not.toContain("data-hub-registry-apply");
    expect(quiet).not.toContain("until you apply");
    expect(quiet).toContain("No workspace is removed from this machine&#x27;s list by a restore.");
  });
});

// ----------------------------------------------------------------- adopt

describe("adopt", () => {
  it("lists one decision per incoming workspace and per link, with the reasons that say something", () => {
    const html = renderToStaticMarkup(<AdoptionView report={adoption()} />);
    for (const slug of ["alpha", "charlie", "delta", "echo"]) {
      expect(html).toContain(`data-hub-registry-decision="${slug}"`);
    }
    expect(html).toContain('data-outcome="absent"');
    expect(html).toContain('data-outcome="conflict"');
    expect(html).toContain('data-outcome="declined"');
    expect(html).toContain("will be listed");
    expect(html).toContain("parked");
    expect(html).toContain("skipped: opted out");
    for (const reason of ["CHARLIE-ABSENT-SENTENCE", "DELTA-PARKED-SENTENCE", "ECHO-OPTED-OUT-SENTENCE"]) {
      expect(html).toContain(reason);
    }
    // "Already here, nothing to do" is the label's job; its sentence would be noise.
    expect(html).not.toContain("ALPHA-CURRENT-SENTENCE");
    expect(html).toContain('data-hub-registry-link="ALP-1&gt;CHA-2"');
    expect(html).toContain("will be linked");
    expect(html).toContain("will be removed");
    expect(html).toContain("kept removed");
    expect(html).toContain("LINK-KEPT-REMOVED-SENTENCE");
  });

  it("counts what applying would change, and offers nothing to apply when it would change nothing", () => {
    expect(adoptionChanges(adoption())).toBe(3);
    expect(applyLabel(adoption())).toBe("Apply 3 changes to this machine");
    const nothing = adoption({
      decisions: adoption().decisions.filter((decision) => decision.outcome !== "absent"),
      crossLinks: { added: 0, skipped: 0, current: 0, removed: 0, keptRemoved: 1, keptLinked: 0 },
    });
    expect(applyLabel(nothing)).toBeNull();
    const html = render(CONNECTED, { adoption: { report: nothing, digest: "d" } });
    expect(html).not.toContain("data-hub-registry-apply");
    expect(html).toContain("Nothing to apply");
  });

  it("applies with the preview's digest, and only that", () => {
    const panel = code("HubRegistryPanel.tsx");
    expect(panel).toContain("adoptHubRegistry(adoption.digest)");
    const client = code("../lib/api.ts");
    expect(client).toContain('digest ? { apply: true, digest } : {}');
  });

  it("speaks in the past tense once applied", () => {
    const html = renderToStaticMarkup(<AdoptionView report={adoption({ dryRun: false })} />);
    expect(html).toContain('data-hub-registry-adoption="applied"');
    expect(html).toContain(">listed<");
    expect(html).not.toContain("will be");
  });
});

// ----------------------------------------------------------------- the page

describe("on the page", () => {
  it("states the shared reason once while the hub is not connected", () => {
    const html = render(report({ hubId: HUB_ID }));
    expect(html.match(/data-hub-registry-shared-block/g)).toHaveLength(1);
    expect(html).not.toContain(">The hub is not connected to a service.<");
    for (const action of ["publish", "backups", "backupCreate", "adopt"]) {
      expect(button(html, `data-hub-registry-action="${action}"`)).toMatch(DISABLED);
    }
  });

  it("locks every press while another hub operation is in flight", () => {
    const html = render(EVERYTHING_ON, {}, { locked: true });
    for (const action of ["publish", "backups", "backupCreate", "adopt"]) {
      expect(button(html, `data-hub-registry-action="${action}"`), action).toMatch(DISABLED);
    }
  });

  it("calls nothing that reaches the service from an effect", () => {
    const file = source("HubRegistryPanel.tsx");
    const effects = [...file.matchAll(/useEffect\(([\s\S]*?)\n\s*\}, \[/g)].map((match) => match[1]!);
    const joined = effects.join("\n");
    for (const egress of [
      "connectHubRegistry",
      "publishHubRegistry",
      "setHubBackupConsent",
      "listHubBackups",
      "createHubBackup",
      "restoreHubRegistry",
      "adoptHubRegistry",
      "mintHubIdentity",
      "adoptHubIdentity",
    ]) {
      expect(joined, `${egress} is called from an effect`).not.toContain(egress);
    }
    // And the scan is looking at real code: the calls exist, in handlers.
    expect(file).toContain("await publishHubRegistry()");
  });
});
