/**
 * THE CLOUD SECTION — S13 (STA-258).
 *
 * Three things this file is for, in order of how much they matter:
 *
 *  1. **A disconnected workspace renders quietly and asks nobody anything.** The
 *     acceptance criterion, and the one a settings panel is most likely to break:
 *     the classic failure is a panel that pings on open to show you status.
 *     Asserted three ways — the markup carries no connected furniture, the
 *     component's source contains no call that egresses outside a handler, and
 *     `CategoryContent` reaches this section without going near `applyTo`.
 *
 *  2. **The two consents stay two.** A control that spent both, or one that
 *     inferred its state from a sentence rather than from `auto` and `backup`,
 *     is the failure the whole three-consents design exists to prevent.
 *
 *  3. **Nothing cloud-shaped is a workspace setting.** No key in the registry, no
 *     op through `/api/settings`, and the category declared in the browser rather
 *     than served — because the workspace database synchronizes and a credential
 *     or an `auto` flag written there would replicate to every device.
 *
 * The suite has no DOM (see vitest.config.ts), so this renders to a string and
 * pins interactions the way `settings-verification.test.tsx` established: the
 * pure function that decides, the markup of each state, and a source assertion
 * for the wiring that joins them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingCategoryView } from "@/lib/settings";
import type {
  CloudSurfaceReport,
  ConnectPreview,
  HubCloudReport,
  HubConnectPreview,
  HubFanOut,
  HubWorkspaceReport,
  RemoteDevice,
} from "@/lib/types";
import { CloudPanel, type CloudPanelProps, type HubPanelState, type HubWideState } from "./CloudSection";
import {
  CLOUD_CATEGORY,
  CLOUD_CATEGORY_ID,
  CONNECT_DISCLOSURE,
  canOfferConnect,
  connectFormProblem,
  connectionFacts,
  consentControls,
  counterFacts,
  describeDevice,
  groupDisabledReasons,
  hubFanOutSummary,
  hubGroups,
  hubListDescription,
  hubRowControls,
  hubRowRationale,
  hubRowSummary,
  hubRegistryControl,
  hubRowView,
  hubUnreachableDescription,
  hubWideControls,
  hubWideDisconnectWarning,
  hubWideFailure,
  hubWideTargets,
  type HubWideAction,
  type HubWideControl,
  isCloudCategory,
  joinLabels,
  orderDevices,
  previewFacts,
  removeWarning,
  revokeWarning,
  withCloudCategory,
} from "./cloud-settings";

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

const DISCONNECTED: CloudSurfaceReport = {
  state: "disconnected",
  mode: "disconnected",
  detail: "This repository is not connected on this machine.",
  repositoryId: "0e77fa01-1111-2222-3333-444444444444",
  endpoint: null,
  deviceId: null,
  label: null,
  credentialMechanism: null,
  credentialPresent: false,
  auto: false,
  backup: false,
  connectedAt: null,
  checked: false,
  pending: 0,
  cursor: null,
  epoch: null,
  lastSyncAt: null,
  conflicts: { open: 0, resolved: 0 },
  leases: { held: 0 },
  warnings: [],
  failure: null,
  hint: "staple cloud connect",
};

const CONNECTED: CloudSurfaceReport = {
  ...DISCONNECTED,
  state: "manual",
  mode: "manual",
  detail: "Connected. Nothing syncs until you run `staple cloud sync`.",
  endpoint: "https://sync.example.com",
  deviceId: "dddddddd-1111-2222-3333-444444444444",
  label: "work laptop",
  credentialMechanism: "keychain",
  credentialPresent: true,
  connectedAt: "2026-09-05T00:00:00.000Z",
  pending: 3,
  cursor: "c-42",
  epoch: 1,
  hint: null,
};

const PREVIEW: ConnectPreview = {
  endpoint: { origin: "https://sync.example.com", host: "sync.example.com", loopback: false },
  repositoryId: "0e77fa01-1111-2222-3333-444444444444",
  deviceId: null,
  label: "work laptop",
  credentialMechanism: "file",
  credentialFallbackReason: "the keychain is locked",
  alreadyConnected: false,
  existingEndpoint: null,
  autoAfterConnect: false,
};

const NOOP = () => {};

/** Nothing hub-wide is happening either — S18 (STA-279). */
const IDLE_WIDE: HubWideState = {
  busy: null,
  connecting: null,
  disconnecting: false,
  fanOut: null,
  error: null,
};

/** Nothing on the list is doing anything. The default for every case in this file. */
const IDLE_HUB: HubPanelState = {
  busy: null,
  refreshing: false,
  backingUp: false,
  consenting: false,
  outcomes: {},
  connecting: null,
  removing: null,
  disconnecting: null,
  error: null,
  wide: IDLE_WIDE,
};

function panel(overrides: Partial<CloudPanelProps> = {}): string {
  const props: CloudPanelProps = {
    report: DISCONNECTED,
    error: null,
    busy: null,
    draft: { endpoint: "", enrollment: "", label: "", credentialFile: false },
    onDraft: NOOP,
    pending: null,
    devices: null,
    // S16 (STA-275): null is what the panel gets when the hub list request is in
    // flight or failed, and is the correct default for every case in this file —
    // they are all about ONE workspace.
    workspaces: null,
    hub: IDLE_HUB,
    hubActions: {
      onOpenConnect: NOOP,
      onDraft: NOOP,
      onPreview: NOOP,
      onConnect: NOOP,
      onSync: NOOP,
      onConsent: NOOP,
      onAskDisconnect: NOOP,
      onDisconnect: NOOP,
      onAskRemove: NOOP,
      onRemove: NOOP,
      onRefresh: NOOP,
      onBackup: NOOP,
      onHubOpenConnect: NOOP,
      onHubDraft: NOOP,
      onHubPreview: NOOP,
      onHubConnect: NOOP,
      onHubSync: NOOP,
      onHubAskDisconnect: NOOP,
      onHubDisconnect: NOOP,
      onHubRegistryConsent: NOOP,
    },
    revoking: null,
    confirmDisconnect: false,
    onPreview: NOOP,
    onCancelPreview: NOOP,
    onConnect: NOOP,
    onConsent: NOOP,
    onDevices: NOOP,
    onAskRevoke: NOOP,
    onRevoke: NOOP,
    onAskDisconnect: NOOP,
    onDisconnect: NOOP,
    ...overrides,
  };
  return renderToStaticMarkup(<CloudPanel {...props} />);
}

// ------------------------------------------------------ 1. it renders quietly

describe("a disconnected workspace renders quietly and asks nobody anything", () => {
  it("shows the state and a form, and none of the connected furniture", () => {
    const html = panel();
    expect(html).toContain('data-mode="disconnected"');
    expect(html).toContain("Not connected");
    expect(html).toContain(DISCONNECTED.detail);

    // Nothing that only makes sense once there is a connection.
    for (const absent of [
      "Show devices",
      "Disconnect this machine",
      "Automatic sync",
      "Backup",
      "Pending operations",
    ]) {
      expect(html, `${absent} was rendered on a disconnected workspace`).not.toContain(absent);
    }
  });

  it("does not nag: the contract's static hint is carried and deliberately not rendered", () => {
    /**
     * *"Before connect — render 'not connected' and a static hint naming `staple
     * cloud connect`. Static text … The UI does not prompt."* Permitting is not
     * requiring, and `CloudStrip` already declined it for the strip. The same
     * choice here: the section IS the place you go to connect, so an invitation
     * to connect inside it would be an advertisement addressed to somebody who
     * has already arrived.
     */
    expect(DISCONNECTED.hint).toBe("staple cloud connect");
    // Asserted at the source rather than in the markup, because the credential
    // field's description legitimately names `staple cloud connect
    // --credential-file` — it is telling you which CLI flag this checkbox is,
    // which is a fact about the control and not an invitation to go and connect.
    // The point is that `hint` is never READ, so it cannot become a prompt.
    for (const file of ["CloudSection.tsx", "cloud-settings.ts"]) {
      expect(source(file)).not.toMatch(/report\.hint|\.hint\b/);
    }
  });

  it("offers no form at all when the workspace has no repository identity", () => {
    const noIdentity: CloudSurfaceReport = {
      ...DISCONNECTED,
      repositoryId: null,
      detail: "This workspace has no repository identity.",
      failure: {
        code: "no_identity",
        summary: "This workspace has no repository identity, so there is nothing for a connection to be about.",
        remedy: "Run `staple init` inside a repository to record one.",
      },
    };
    expect(canOfferConnect(noIdentity)).toBe(false);
    const html = panel({ report: noIdentity });
    expect(html).not.toContain("Connect this repository");
    // The reason is shown instead, with what to do about it.
    expect(html).toContain("Run `staple init`");
  });

  /**
   * THE SOURCE ASSERTION, and the one that catches a regression nothing else
   * would. `listCloudDevices` and `revokeCloudDevice` are the two calls that make
   * this server leave the machine. They must appear ONLY inside a handler that a
   * press invokes — never in a `useEffect`, which is what "pings on open" looks
   * like in this codebase.
   */
  it("makes exactly one request on mount, and it is the network-free status read", () => {
    const file = source("CloudSection.tsx");
    const effects = [...file.matchAll(/useEffect\(([\s\S]*?)\n  \}, \[/g)].map((match) => match[1]!);
    expect(effects.length).toBeGreaterThan(0);

    const joined = effects.join("\n");
    expect(joined).toContain("getCloudStatus()");
    for (const egress of ["listCloudDevices", "revokeCloudDevice", "cloudConnect", "previewCloudConnect"]) {
      expect(joined, `${egress} is called from an effect — that is a ping on open`).not.toContain(egress);
    }
  });
});

// ------------------------------------------------------ 2. two consents stay two

describe("automatic sync and backup are two separate consents", () => {
  it("binds each toggle to its own VALUE, never to the report's prose", () => {
    const controls = consentControls({ ...CONNECTED, auto: true, backup: false });
    expect(controls.map((c) => [c.key, c.value])).toEqual([
      ["auto", true],
      ["backup", false],
    ]);
  });

  it("renders two independent switches on a connected workspace", () => {
    const html = panel({ report: CONNECTED });
    expect(html).toContain('data-cloud-consent-toggle="auto"');
    expect(html).toContain('data-cloud-consent-toggle="backup"');
    // Both off after connecting, which is what `performConnect` writes.
    expect(html.match(/aria-checked="false"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("says, on each one, that it is this machine's decision alone", () => {
    const [auto, backup] = consentControls(CONNECTED);
    expect(auto!.description).toContain("per-device");
    expect(backup!.description).toContain("separate opt-in");
  });

  it("the panel has no control that could change both at once", () => {
    /**
     * The route refuses a body naming both (`test/ui-cloud-settings.test.ts`);
     * this is the surface half of the same statement. `onConsent` takes ONE key,
     * so there is no shape a single press can produce that spends two consents.
     */
    const file = source("CloudSection.tsx");
    expect(file).toContain('onConsent: (consent: "auto" | "backup", value: boolean) => void');
    expect(file).not.toMatch(/onConsent\(\s*\{/);
  });
});

// ------------------------------------------------------ 3. not a workspace setting

describe("nothing here is a workspace setting", () => {
  it("declares its category in the browser, not in the served registry", () => {
    expect(CLOUD_CATEGORY.id).toBe(CLOUD_CATEGORY_ID);
    /**
     * `scope: "global"` puts it under the nav's "Global" heading, beside "This
     * machine" — which answers "does connecting here connect my other laptop?"
     * before a word of the section is read.
     */
    expect(CLOUD_CATEGORY.scope).toBe("global");
    expect(isCloudCategory(CLOUD_CATEGORY_ID)).toBe(true);
    expect(isCloudCategory("kinds")).toBe(false);
  });

  it("merges into the served nav in shell order, and never twice", () => {
    const served: SettingCategoryView[] = [
      { id: "statuses", label: "Statuses", description: "", scope: "workspace", editor: "statuses", order: 10 },
      { id: "machine", label: "This machine", description: "", scope: "global", editor: "fields", order: 90 },
    ];
    expect(withCloudCategory(served).map((c) => c.id)).toEqual(["statuses", "cloud", "machine"]);
    // Idempotent, so a re-render cannot grow the nav.
    expect(withCloudCategory(withCloudCategory(served)).map((c) => c.id)).toEqual([
      "statuses",
      "cloud",
      "machine",
    ]);
  });

  it("adds nothing while the registry is empty, so the nav does not flash one entry", () => {
    expect(withCloudCategory([])).toEqual([]);
  });

  it("is reached by CategoryContent without going near the settings write path", () => {
    const file = source("CategoryContent.tsx");
    // Matched by id, BEFORE the editor switch, and without `applyTo` — which is
    // the function that writes `/api/settings`, i.e. the workspace database.
    expect(file).toMatch(/isCloudCategory\(category\.id\)\) return <CloudSection ws=\{ws\} \/>/);
    expect(file.indexOf("isCloudCategory")).toBeLessThan(file.indexOf("switch (category.editor)"));
  });

  it("names no setting key anywhere in the section", () => {
    /**
     * The mirror of `fields-form.test.tsx`'s "no shell file names the setting".
     * A cloud key appearing here would mean somebody had registered one, and a
     * registered key is a row in the workspace database — which replicates.
     */
    for (const file of ["CloudSection.tsx", "cloud-settings.ts"]) {
      expect(source(file)).not.toMatch(/putSettings|applyTo|SettingOp/);
    }
  });
});

// ------------------------------------------------------ the connect consent screen

describe("the consent screen shows what consent is being given to", () => {
  it("names the service, the repository and where the secret goes — as values", () => {
    const facts = previewFacts(PREVIEW);
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f.value]));
    expect(byLabel.Service).toBe("https://sync.example.com");
    expect(byLabel.Repository).toBe(PREVIEW.repositoryId);
    expect(byLabel.Credential).toContain("0600 file");
    // The fallback reason is SHOWN, never swallowed: it is the sentence saying
    // the secret is about to land somewhere other than the keychain.
    expect(byLabel["Falling back because"]).toBe("the keychain is locked");
    // A device that does not exist yet says so rather than rendering blank.
    expect(byLabel.Device).toContain("minted");
  });

  it("says the two uncomfortable things, because that is the point of showing it", () => {
    const html = panel({ pending: { preview: PREVIEW, consent: { id: "c", digest: "d", expiresAt: "x" } } });
    expect(html).toContain("AUTOMATIC SYNC STAYS OFF");
    expect(html).toContain("PLAINTEXT");
    expect(html).toContain("Nothing has been sent yet");
  });

  it("replaces the form with the screen, so Connect is never reachable beside the endpoint box", () => {
    const form = panel();
    expect(form).toContain("data-cloud-preview");
    expect(form).not.toContain("data-cloud-connect");

    const consent = panel({ pending: { preview: PREVIEW, consent: { id: "c", digest: "d", expiresAt: "x" } } });
    expect(consent).toContain("data-cloud-connect");
    expect(consent).not.toContain("data-cloud-preview");
  });

  it("warns when this would re-point an existing connection somewhere else", () => {
    const facts = previewFacts({
      ...PREVIEW,
      alreadyConnected: true,
      existingEndpoint: "https://old.example",
    });
    const warning = facts.find((f) => f.label === "Already connected to")!;
    expect(warning.value).toContain("https://old.example");
    expect(warning.value).toContain("replace the stored credential");
  });

  it("refuses to preview without both required boxes, and does not restate the endpoint's rules", () => {
    expect(connectFormProblem({ endpoint: "", token: "x" })).toMatch(/endpoint is required/);
    expect(connectFormProblem({ endpoint: "x", token: "  " })).toMatch(/enrollment credential/);
    expect(connectFormProblem({ endpoint: "https://a", token: "t" })).toBeNull();
    /**
     * The https rule, the "no credentials in the URL" rule and "is this even a
     * URL" all belong to `parseEndpoint` and arrive as its own sentence. A second
     * copy here would be a second chance to paraphrase one — the argument
     * `validateVocabularyId` makes in settings-ops.ts.
     */
    expect(connectFormProblem({ endpoint: "http://insecure.example", token: "t" })).toBeNull();
  });
});

// ------------------------------------------------------ the connected surface

describe("the connected surface", () => {
  it("reports identity and counters, including the zeroes", () => {
    const identity = Object.fromEntries(connectionFacts(CONNECTED).map((f) => [f.label, f.value]));
    expect(identity.Service).toBe("https://sync.example.com");
    expect(identity["This device"]).toContain("work laptop");
    expect(identity.Credential).toBe("keychain");

    const counters = Object.fromEntries(counterFacts(CONNECTED).map((f) => [f.label, f.value]));
    expect(counters["Pending operations"]).toBe("3");
    expect(counters.Cursor).toBe("c-42");
    expect(counters.Epoch).toBe("1");
  });

  it("says so, loudly, when the record names a credential that is not there", () => {
    const identity = Object.fromEntries(
      connectionFacts({ ...CONNECTED, credentialPresent: false }).map((f) => [f.label, f.value]),
    );
    expect(identity.Credential).toContain("NOT FOUND");
  });

  it("reports nothing at all when disconnected — a table of dashes is a worse answer", () => {
    expect(connectionFacts(DISCONNECTED)).toEqual([]);
    expect(counterFacts(DISCONNECTED)).toEqual([]);
  });

  it("offers purge as a sentence naming the command, and never as a button", () => {
    const html = panel({ report: CONNECTED });
    expect(html).toContain("staple cloud purge");
    expect(html).not.toContain("data-cloud-purge");
    /**
     * STA-256 records that the server does not yet validate a confirmation on the
     * wire, and `staple cloud purge` requires the repository id typed back. A
     * one-click irreversible remote deletion whose only guard is a dialog this
     * page draws is not a thing to add while that is true.
     */
    expect(source("cloud-settings.ts")).toContain("typed confirmation is the");
  });
});

// ------------------------------------------------------ devices

describe("devices", () => {
  const DEVICES: RemoteDevice[] = [
    { deviceId: "old", label: "an old laptop", createdAt: 1000, lastSeenAt: 2000, revokedAt: 3000, self: false },
    { deviceId: "other", label: "a second laptop", createdAt: 1000, lastSeenAt: 9000, revokedAt: null, self: false },
    { deviceId: "me", label: "this one", createdAt: 1000, lastSeenAt: 5000, revokedAt: null, self: true },
  ];

  it("is not fetched until asked, and says so rather than showing an empty list", () => {
    const html = panel({ report: CONNECTED });
    expect(html).toContain("Show devices");
    expect(html).toContain("Nothing has been asked yet");
    expect(html).not.toContain("data-cloud-device-list");
  });

  it("puts this machine first, then live devices, then revoked ones", () => {
    /**
     * This machine first because the question somebody opens the list with is
     * usually "which of these is me" — and it is the row whose Revoke button has
     * the consequence they might not expect.
     */
    expect(orderDevices(DEVICES).map((d) => d.deviceId)).toEqual(["me", "other", "old"]);
  });

  it("keeps revoked devices on the list, as the audit trail of the revocation", () => {
    const html = panel({ report: CONNECTED, devices: orderDevices(DEVICES) });
    expect(html).toContain("an old laptop");
    expect(html).toContain("revoked");
    // And offers no Revoke button for one that is already revoked.
    expect(html).not.toContain('data-cloud-revoke="old"');
    expect(html).toContain('data-cloud-revoke="other"');
  });

  it("warns differently when the device being revoked is this machine", () => {
    const self = revokeWarning(DEVICES[2]!);
    expect(self).toContain("the machine you are using");
    expect(self).toContain("untouched");
    expect(revokeWarning(DEVICES[1]!)).toContain("every other device is unaffected");
  });

  it("describes each device coarsely — the server's lastSeenAt has no more precision than that", () => {
    const now = 10_000_000;
    expect(describeDevice(DEVICES[1]!, now)).toMatch(/last seen \d+[mhd] ago/);
    expect(describeDevice({ ...DEVICES[1]!, lastSeenAt: null }, now)).toContain("never seen");
    expect(describeDevice(DEVICES[0]!, now)).toContain("revoked");
  });
});


// ------------------- the workspace list, as a CONTROL (S17/S19/S21)

function hubRow(overrides: Partial<HubWorkspaceReport> = {}): HubWorkspaceReport {
  return {
    slug: "alpha",
    prefix: "ALP",
    path: "/work/alpha/.staple/staple.db",
    kind: "repo",
    available: true,
    recordsIdentityOnOpen: true,
    actionable: true,
    repositoryId: "0e77fa01-1111-2222-3333-444444444444",
    state: "manual",
    mode: "manual",
    endpoint: "https://sync.example.com",
    deviceId: "device-1",
    label: "work laptop",
    credentialMechanism: "keychain",
    credentialPresent: null,
    auto: false,
    backup: false,
    connectedAt: "2026-09-05T00:00:00.000Z",
    skip: null,
    skipDetail: null,
    ...overrides,
  };
}

/** A row whose disk is gone — four of the five entries STA-282 is about. */
function missingRow(slug: string): HubWorkspaceReport {
  return hubRow({
    slug,
    prefix: slug.slice(0, 3).toUpperCase(),
    path: `/tmp/gone/${slug}/.staple/staple.db`,
    available: false,
    actionable: false,
    repositoryId: null,
    state: "disconnected",
    mode: "disconnected",
    endpoint: null,
    deviceId: null,
    label: null,
    credentialMechanism: null,
    connectedAt: null,
    skip: "unavailable",
    skipDetail:
      "The workspace database is not on this machine right now (/tmp/gone). It is left " +
      "registered and untouched — an unmounted volume is not a deleted workspace.",
  });
}

function hubReport(rows: HubWorkspaceReport[]): HubCloudReport {
  return {
    workspaces: rows,
    counts: {
      total: rows.length,
      connected: rows.filter((row) => row.state !== "disconnected").length,
      disconnected: rows.filter((row) => row.state === "disconnected").length,
      skipped: rows.filter((row) => row.skip !== null).length,
      actionable: rows.filter((row) => row.actionable).length,
      automatic: rows.filter((row) => row.auto).length,
    },
    self: {
      registered: rows.length,
      present: rows.filter((row) => row.available).length,
      absent: rows.filter((row) => !row.available).length,
      crossLinks: 0,
      backupHeadline:
        "A hub backup contains your workspace list and the links between them. " +
        "It does not contain any tasks — each workspace is backed up separately.",
      backupContents: ["Which workspaces exist, and what each one is called."],
      backupExclusions: ["No tasks."],
      registry: {
        connected: false,
        endpoint: null,
        disclosure:
          "a machine that publishes its registry tells the service the names, prefixes and " +
          "identities of every workspace on it, and that they sit together.",
        consent: false,
      },
    },
    endpoints: [
      ...new Set(rows.map((row) => row.endpoint).filter((value): value is string => value !== null)),
    ].sort(),
  };
}

/** Every control a row offers, as a map, so a test can name one. */
function controlsOf(row: HubWorkspaceReport, options: { current?: boolean } = {}) {
  return new Map(hubRowControls(row, options).map((control) => [control.action, control]));
}

describe("every registered workspace is actionable from the page (S19/STA-280)", () => {
  it("names every workspace with its own state, not a summary of them", () => {
    const html = panel({
      workspaces: hubReport([
        hubRow(),
        hubRow({ slug: "bravo", repositoryId: "b", state: "automatic", mode: "automatic", auto: true }),
        hubRow({
          slug: "charlie",
          repositoryId: "c",
          state: "disconnected",
          mode: "disconnected",
          endpoint: null,
        }),
      ]),
    });

    expect(html).toContain("data-cloud-workspaces");
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(html).toContain(`data-cloud-workspace="${slug}"`);
    }
    expect(html).toContain("Connected, manual");
    expect(html).toContain("Connected, automatic");
    expect(html).toContain("Not connected");
  });

  /**
   * THE CRITERION. Six controls on every row, and each one addressed to the row
   * it is drawn on — `data-cloud-workspace-action="<slug>:<verb>"`. The attribute
   * is not decoration: it is the assertion that a control knows which workspace
   * it belongs to, which is the whole of "an action on one row does not act on
   * another" at this layer.
   */
  it("gives each row its own connect, sync, backup and disconnect", () => {
    const html = panel({
      workspaces: hubReport([
        hubRow(),
        hubRow({ slug: "bravo", repositoryId: "b", state: "disconnected", mode: "disconnected", endpoint: null }),
      ]),
    });

    for (const verb of ["connect", "sync", "disconnect", "remove"]) {
      expect(html).toContain(`data-cloud-workspace-action="alpha:${verb}"`);
      expect(html).toContain(`data-cloud-workspace-action="bravo:${verb}"`);
    }
    for (const consent of ["auto", "backup"]) {
      expect(html).toContain(`data-cloud-workspace-toggle="alpha:${consent}"`);
      expect(html).toContain(`data-cloud-workspace-toggle="bravo:${consent}"`);
    }
  });

  it("offers every action from the page, with no row telling the reader to open a terminal", () => {
    /**
     * S17's criterion, asserted against the markup rather than against intent.
     * `staple cloud connect --all` was the previous section description; it is
     * gone, along with every other command that appeared as a row's ANSWER.
     *
     * `staple init` survives in exactly one place — the disabled reason on a
     * checkout-backed row with no manifest — and that is deliberate: there the
     * command genuinely is the remedy, and it appears as an explanation of why a
     * control is unavailable rather than as the control.
     */
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
    });
    expect(html).not.toContain("staple cloud connect --all");
    expect(html).not.toContain("staple cloud sync");
    expect(html).not.toContain("staple init");
  });

  /**
   * The pure half of the criterion. A control that cannot work is RETURNED, with
   * a sentence, rather than dropped: a control that vanishes leaves a reader
   * unable to tell an unavailable capability from one that does not exist.
   */
  it("disables a control with a stated reason rather than hiding it", () => {
    const disconnected = controlsOf(
      hubRow({ state: "disconnected", mode: "disconnected", endpoint: null, repositoryId: "x" }),
    );
    expect([...disconnected.keys()]).toEqual([
      "connect",
      "sync",
      "auto",
      "backup",
      "disconnect",
      "remove",
    ]);
    expect(disconnected.get("connect")!.disabledReason).toBeNull();
    for (const verb of ["sync", "auto", "backup", "disconnect"] as const) {
      expect(disconnected.get(verb)!.disabledReason).toContain("not connected on this machine");
    }
  });

  it("renders the reason beside the disabled control, not only in a tooltip", () => {
    const html = panel({
      workspaces: hubReport([
        hubRow({ slug: "alpha", state: "disconnected", mode: "disconnected", endpoint: null }),
        hubRow({ slug: "bravo", repositoryId: "b" }),
      ]),
    });
    // A tooltip is not an explanation on a page somebody opened to understand
    // the model. The sentence is in the document.
    expect(html).toContain("there is nothing to act on");
    expect(html).toContain('data-disabled="true"');
  });

  /**
   * THE ANTI-NOISE PROPERTY, and it is the criterion's other half.
   *
   * The first build of this rendered each control's reason beside that control.
   * On a disconnected row that is one identical sentence four times, seven rows
   * deep — which satisfies "stated rather than hidden" and reintroduces the very
   * thing this ticket removes. The reason is still stated in full; it is stated
   * ONCE, naming every control it covers.
   */
  it("states a shared reason once, naming every control it covers", () => {
    const disconnected = hubRow({
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      repositoryId: "x",
    });
    const groups = groupDisabledReasons(hubRowControls(disconnected));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.labels).toEqual(["Sync now", "Automatic sync", "Backup", "Disconnect"]);
    expect(joinLabels(groups[0]!.labels)).toBe(
      "Sync now, Automatic sync, Backup and Disconnect",
    );

    const html = panel({
      workspaces: hubReport([disconnected, hubRow({ slug: "bravo", repositoryId: "b" })]),
    });
    /**
     * One rendered LINE, not four. The sentence also appears in each disabled
     * control's `title`, which is deliberate and is not visible text — so the
     * count is taken over the rendered list rather than over the whole document.
     */
    const list = html.slice(html.indexOf("data-cloud-workspace-unavailable"));
    const firstList = list.slice(0, list.indexOf("</ul>"));
    expect(firstList.match(/there is nothing to act on/g)).toHaveLength(1);
    expect(firstList).toContain("Sync now, Automatic sync, Backup and Disconnect");
    expect(firstList).toContain("are unavailable:");
  });

  it("keeps two genuinely different reasons apart", () => {
    /**
     * A MISSING row that is still connected: Sync cannot open the database, and
     * Remove would strand its credential. Two facts, two sentences — grouping
     * must not merge them, which is why the reasons stay per-control in
     * `hubRowControls` and are grouped only for rendering.
     */
    const gone = hubRow({
      available: false,
      actionable: false,
      skip: "unavailable",
      skipDetail: "not here",
    });
    const groups = groupDisabledReasons(hubRowControls(gone));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const reasons = groups.map((group) => group.reason);
    expect(reasons.some((reason) => reason.includes("not on this machine"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("Disconnect it first"))).toBe(true);
    // Disconnect is not in any group: it is live on this row, deliberately.
    expect(groups.flatMap((group) => group.labels)).not.toContain("Disconnect");
  });

  it("says 'is unavailable' for one control and 'are' for several", () => {
    expect(joinLabels(["Connect"])).toBe("Connect");
    expect(joinLabels([])).toBe("");
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
    });
    // A connected row has exactly two disabled controls, each with its own
    // reason, so both singular forms appear.
    expect(html).toContain("is unavailable:");
  });

  it("refuses to connect a row that is already connected, and says where it is connected to", () => {
    const connected = controlsOf(hubRow());
    expect(connected.get("connect")!.disabledReason).toContain("https://sync.example.com");
    expect(connected.get("connect")!.disabledReason).toContain("Disconnect it first");
    // And the four that need a connection are live.
    for (const verb of ["sync", "auto", "backup", "disconnect"] as const) {
      expect(connected.get(verb)!.disabledReason).toBeNull();
    }
  });

  /**
   * THE ASYMMETRY WORTH PINNING. On a row whose disk is gone, sync is impossible
   * — it opens the database — and disconnect is MORE important, not less: the
   * credential is on this machine and `performHubDisconnect` is deliberately not
   * gated on availability, because refusing would strand a live secret for
   * exactly the workspace somebody is most likely to be disconnecting.
   */
  it("keeps disconnect live on a row whose disk is gone, while sync is not", () => {
    const gone = controlsOf(
      hubRow({
        available: false,
        actionable: false,
        skip: "unavailable",
        skipDetail: "The workspace database is not on this machine right now.",
      }),
    );
    expect(gone.get("disconnect")!.disabledReason).toBeNull();
    expect(gone.get("sync")!.disabledReason).toContain("not on this machine");
    expect(gone.get("connect")!.disabledReason).not.toBeNull();
  });

  it("refuses removal while a workspace is still connected, and says why", () => {
    expect(controlsOf(hubRow()).get("remove")!.disabledReason).toContain("Disconnect it first");
    expect(controlsOf(hubRow()).get("remove")!.disabledReason).toContain(
      "with nothing pointing at it",
    );
  });

  it("refuses to remove the workspace this window is serving", () => {
    const disconnected = hubRow({ state: "disconnected", mode: "disconnected", endpoint: null });
    expect(controlsOf(disconnected, { current: true }).get("remove")!.disabledReason).toContain(
      "register itself again",
    );
    expect(controlsOf(disconnected, { current: false }).get("remove")!.disabledReason).toBeNull();
  });

  /**
   * S17's other half. Before this, the identity absence had ONE sentence and it
   * named `staple init` — wrong advice for every workspace outside a checkout,
   * and wrong in the expensive direction: run anywhere but the exact registered
   * directory it mints a second identity for a workspace that was about to
   * record its own.
   */
  it("offers a plain Connect on a row that records its identity when opened", () => {
    const willRecord = hubRow({
      repositoryId: null,
      recordsIdentityOnOpen: true,
      actionable: true,
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      skip: "no_identity",
      skipDetail: "…the long version…",
    });
    expect(controlsOf(willRecord).get("connect")!.disabledReason).toBeNull();
    expect(hubRowSummary(willRecord)).toContain("nothing to set up first");
    expect(hubRowSummary(willRecord)).not.toContain("staple");
  });

  it("names the command only where the command really is the remedy", () => {
    const checkout = hubRow({
      repositoryId: null,
      recordsIdentityOnOpen: false,
      actionable: false,
      state: "disconnected",
      mode: "disconnected",
      endpoint: null,
      skip: "no_identity",
    });
    const reason = controlsOf(checkout).get("connect")!.disabledReason;
    expect(reason).toContain("staple init");
    expect(reason).toContain("creates nothing new");
    // As an explanation of an unavailable control — never as the control.
    expect(controlsOf(checkout).get("connect")!.label).toBe("Connect");
  });

  it("shows the outcome of the last operation on the row it happened to", () => {
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: {
        ...IDLE_HUB,
        outcomes: {
          bravo: {
            slug: "bravo",
            action: "sync",
            status: "ok",
            detail: "Pushed 3, pulled 1.",
            at: "2026-09-09T10:00:00.000Z",
          },
        },
      },
    });
    expect(html).toContain('data-cloud-workspace-outcome="bravo"');
    expect(html).not.toContain('data-cloud-workspace-outcome="alpha"');
    expect(html).toContain("Pushed 3, pulled 1.");
  });

  it("renders a failed outcome as a failure rather than as nothing", () => {
    /**
     * `syncAllWorkspaces` reports a failed workspace as a ROW rather than by
     * throwing, so a failure arrives on a 200. A panel that only rendered
     * `status: "ok"` would answer a failed sync with silence, which is worse than
     * an error.
     */
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: {
        ...IDLE_HUB,
        outcomes: {
          alpha: {
            slug: "alpha",
            action: "sync",
            status: "failed",
            detail: "The service could not be reached.",
            at: "2026-09-09T10:00:00.000Z",
          },
        },
      },
    });
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Did not work:");
    expect(html).toContain("The service could not be reached.");
  });

  it("busies only the row that was pressed", () => {
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: { ...IDLE_HUB, busy: { slug: "bravo", action: "sync" } },
    });
    // One "Working…", on bravo's sync button. Every other control is disabled
    // (one registry, one staple home — a second press mid-flight races a write)
    // but none of them claims to be doing anything.
    expect(html.match(/Working…/g)).toHaveLength(1);
  });

  it("draws an error on the row that produced it", () => {
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: { ...IDLE_HUB, error: { slug: "bravo", message: "that enrollment secret was refused" } },
    });
    const alpha = html.slice(
      html.indexOf('data-cloud-workspace="alpha"'),
      html.indexOf('data-cloud-workspace="bravo"'),
    );
    expect(html).toContain("that enrollment secret was refused");
    expect(alpha).not.toContain("that enrollment secret was refused");
  });

  it("offers a refresh, so a workspace registered after load appears", () => {
    const html = panel({ workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]) });
    expect(html).toContain("data-cloud-workspaces-refresh");
    expect(html).toContain("registered since you opened this");
  });

  it("renders when the CURRENT workspace is disconnected — the case it exists for", () => {
    const html = panel({
      report: DISCONNECTED,
      workspaces: hubReport([
        hubRow(),
        hubRow({ slug: "bravo", repositoryId: "b", state: "disconnected", mode: "disconnected" }),
      ]),
    });
    expect(html).toContain('data-cloud-section="true" data-mode="disconnected"');
    expect(html).toContain('data-cloud-workspace="alpha"');
  });

  it("marks the workspace the dialog is open on, so the list is orientable", () => {
    const html = panel({
      workspaces: hubReport([
        hubRow({ repositoryId: DISCONNECTED.repositoryId }),
        hubRow({ slug: "bravo", repositoryId: "b" }),
      ]),
    });
    expect(html).toContain("(this one)");
  });

  it("badges auto, backup and MISSING from values rather than from prose", () => {
    const view = hubRowView(hubRow({ auto: true, backup: true, available: false }));
    expect(view.marks).toEqual(["auto", "backup", "MISSING"]);
    expect(hubRowView(hubRow()).marks).toEqual([]);
  });

  it("never renders credentialPresent, because the route that feeds it does not look", () => {
    const view = hubRowView(hubRow({ credentialPresent: null }));
    expect(Object.keys(view)).not.toContain("credentialPresent");
    expect(view.state).toBe("Connected, manual");
  });

  it("draws nothing for a machine with one workspace or none", () => {
    // A "list" of one is a heading restating what the sections above already say
    // about that same workspace, controls included.
    expect(panel({ workspaces: hubReport([hubRow()]) })).not.toContain("data-cloud-workspaces");
    expect(panel({ workspaces: hubReport([]) })).not.toContain("data-cloud-workspaces");
    expect(panel({ workspaces: null })).not.toContain("data-cloud-workspaces");
  });

  it("is fetched once on mount and is NOT on any poll", () => {
    const text = source("CloudSection.tsx");
    expect(text).toContain("getCloudWorkspaces()");
    /**
     * The list describes N workspaces, and the temptation with a list is to poll
     * it. It must not be polled: connection state changes when a human runs a
     * command, so a poll would do the work forever to learn nothing. The MOUNT
     * effect's empty dependency array is the assertion; `onRefresh` calls the
     * same function from a press, which is why the source is searched for
     * `setInterval` rather than for a second call site.
     */
    expect(text).not.toMatch(/setInterval[\s\S]{0,200}getCloudWorkspaces/);
  });
});

describe("a row says what it is in one line, with the paragraph behind a disclosure (S17/STA-278)", () => {
  it("summarises each state in a single sentence", () => {
    expect(hubRowSummary(hubRow())).toBe(
      "Connected to https://sync.example.com. Nothing moves until you sync it.",
    );
    expect(hubRowSummary(hubRow({ state: "automatic", mode: "automatic", auto: true }))).toContain(
      "Syncing automatically",
    );
    expect(
      hubRowSummary(hubRow({ state: "disconnected", mode: "disconnected", endpoint: null })),
    ).toBe("Not connected. Nothing about this workspace leaves the machine.");
    expect(hubRowSummary(missingRow("qdemo"))).toBe(
      "Not on this machine right now. Still registered, and nothing has been deleted.",
    );
  });

  it("keeps the summary to one sentence-length line, not a paragraph", () => {
    /**
     * The failure this replaces was four lines per row, seven rows deep. A
     * length bound is a blunt instrument and it is the right one here: the
     * regression is not "the wording got worse", it is "somebody moved the
     * explanation back into the row body".
     */
    for (const row of [
      hubRow(),
      hubRow({ state: "automatic", mode: "automatic" }),
      hubRow({ state: "disconnected", mode: "disconnected", endpoint: null }),
      missingRow("r6b"),
      hubRow({ repositoryId: null, skip: "no_identity", recordsIdentityOnOpen: true, state: "disconnected", mode: "disconnected", endpoint: null }),
      hubRow({ repositoryId: null, skip: "problem", actionable: false }),
    ]) {
      expect(hubRowSummary(row).length).toBeLessThanOrEqual(120);
      expect(hubRowSummary(row).split("\n")).toHaveLength(1);
    }
  });

  it("puts describeSkip's paragraph behind the disclosure and passes it through unchanged", () => {
    const row = missingRow("qdemo");
    const rationale = hubRowRationale(row)!;
    // Verbatim. A surface that paraphrases a core explanation is a surface that
    // will be paraphrasing a stale one within a release.
    expect(rationale).toContain(row.skipDetail!);
    expect(rationale).toContain(row.path);
    // And it is NOT in the one-line summary.
    expect(hubRowSummary(row)).not.toContain("unmounted volume");
  });

  it("renders the rationale inside a details element, closed", () => {
    const html = panel({ workspaces: hubReport([hubRow(), missingRow("qdemo")]) });
    expect(html).toContain("data-cloud-workspace-details");
    expect(html).toContain("<summary");
    // `<details>` with no `open` attribute is closed. The paragraph is present
    // in the markup and not in the reader's way.
    expect(html).not.toContain("<details open");
    expect(html).toContain("unmounted volume is not a deleted workspace");
  });
});

describe("test debris does not compete with real workspaces (S21/STA-282)", () => {
  const DEBRIS = ["autotrigger", "legacyrepo", "qdemo", "r6b"];

  function withDebris(): HubCloudReport {
    return hubReport([
      hubRow(),
      hubRow({ slug: "staple", repositoryId: "s", state: "disconnected", mode: "disconnected", endpoint: null }),
      // The fifth entry the ticket names, still on disk. It must NOT be
      // subordinated: `available` is the key, not the slug.
      hubRow({
        slug: "s1-schema-probe",
        repositoryId: "p",
        state: "disconnected",
        mode: "disconnected",
        endpoint: null,
      }),
      ...DEBRIS.map(missingRow),
    ]);
  }

  it("groups unreachable rows below the reachable ones", () => {
    const report = withDebris();
    const groups = hubGroups(report);
    expect(groups.reachable.map((view) => view.slug)).toEqual([
      "alpha",
      "staple",
      "s1-schema-probe",
    ]);
    expect(groups.unreachable.map((view) => view.slug)).toEqual(DEBRIS);
  });

  it("never hides a reachable workspace, whatever its slug looks like", () => {
    /**
     * THE TRAP THIS AVOIDS. The five entries are named in the ticket, and a
     * denylist of those five slugs would have "worked" — and would have been the
     * same class of mistake as the debris itself: a fact about one afternoon's
     * testing compiled into the product, wrong on the next machine and invisible
     * when it is. `s1-schema-probe` is scratch by every human measure and its
     * files are still there, so it stays in the main list and is removable from
     * there.
     */
    const groups = hubGroups(withDebris());
    expect(groups.reachable.some((view) => view.slug === "s1-schema-probe")).toBe(true);
    expect(groups.unreachable.some((view) => view.slug === "s1-schema-probe")).toBe(false);
  });

  it("renders the subordinate group, dimmed, rather than dropping it", () => {
    const html = panel({ workspaces: withDebris() });
    expect(html).toContain("data-cloud-workspaces-unreachable");
    expect(html).toContain("Not on this machine");
    // Subordinate is not hidden: every debris row is still in the document and
    // still carries the control that gets rid of it.
    for (const slug of DEBRIS) {
      expect(html).toContain(`data-cloud-workspace="${slug}"`);
      expect(html).toContain(`data-cloud-workspace-action="${slug}:remove"`);
    }
  });

  it("answers 'does this delete my data' once, in the group heading", () => {
    /**
     * Asked once about the group rather than six times about its members, which
     * is why it lives in the heading and not in each row. The rows still carry
     * the full sentence in their removal confirmation — that is the moment it
     * has to be unambiguous — but a reader scanning the group gets the answer
     * before they press anything.
     */
    const text = hubUnreachableDescription(4);
    expect(text).toContain("4 registered workspaces are not on this machine");
    expect(text).toContain("removing one only unregisters it");
    expect(text).toContain("Nothing is deleted");
    expect(hubUnreachableDescription(1)).toContain("1 registered workspace is");
  });

  it("removes a dead entry from the page, with no CLI", () => {
    const row = missingRow("qdemo");
    expect(controlsOf(row).get("remove")!.disabledReason).toBeNull();
    const html = panel({
      workspaces: withDebris(),
      hub: { ...IDLE_HUB, removing: { slug: "qdemo", crossLinks: 0 } },
    });
    expect(html).toContain("Remove from list");
    expect(html).not.toContain("hub unregister");
    expect(html).not.toContain("hub prune");
  });

  it("explains that removal unregisters and does not delete", () => {
    const warning = removeWarning(missingRow("qdemo"), 0);
    expect(warning).toContain("this unregisters, it does not delete");
    expect(warning).toContain("left exactly as they are");
    expect(warning).toContain("QDE"); // its prefix is released for reuse
  });

  it("says when removal also changes another workspace's blockers", () => {
    const none = removeWarning(missingRow("qdemo"), 0);
    const some = removeWarning(missingRow("qdemo"), 2);
    expect(none).not.toContain("cross-workspace");
    expect(some).toContain("2 cross-workspace links name it");
    expect(some).toContain("another workspace's blockers");
  });

  it("says a reachable workspace will come back and an unreachable one will not", () => {
    expect(removeWarning(hubRow({ state: "disconnected" }), 0)).toContain("registers it again");
    expect(removeWarning(missingRow("r6b"), 0)).toContain("nothing will bring it back");
  });

  it("leads with the actionable count rather than with every row", () => {
    const report = withDebris();
    const text = hubListDescription(report);
    // 7 rows; 3 reachable and actionable.
    expect(report.counts.total).toBe(7);
    expect(report.counts.actionable).toBe(3);
    expect(text).toContain("3 of 7");
    expect(text).toContain("4 are not on this machine");
    // And the terminal command that used to end this sentence is gone.
    expect(text).not.toContain("staple cloud connect --all");
    expect(text).not.toContain("staple");
  });

  it("says so plainly when nothing on the list can be acted on", () => {
    const text = hubListDescription(hubReport(DEBRIS.map(missingRow)));
    expect(text).toContain("None of the workspaces");
    expect(text).toContain("4 are not on this machine");
  });

  it("does not claim a fraction when every workspace is actionable", () => {
    const text = hubListDescription(hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]));
    expect(text).toContain("All 2 workspaces");
    expect(text).not.toContain("2 of 2 workspaces");
  });
});

/**
 * S18 (STA-279) — the hub is a thing on the page, not just the shape of a list.
 *
 * The failure being designed out is a page that reads as though the current
 * workspace's connection described the hub. Every case here is therefore about
 * the panel stating the HUB, and about the backup affordance never disappearing.
 */
describe("the hub states itself above the list (S18/STA-279)", () => {
  it("renders for a single workspace, where the list deliberately does not", () => {
    // `HubWorkspaceList` returns null below two rows, because a list of one is
    // not a list. The hub is a thing regardless, and so is its backup.
    const html = panel({ workspaces: hubReport([hubRow()]) });
    expect(html).toContain("data-cloud-hub-self");
    expect(html).not.toContain("data-cloud-workspaces=");
  });

  it("always offers the backup, with nothing gating it on a connection", () => {
    const html = panel({ report: DISCONNECTED, workspaces: hubReport([hubRow()]) });
    expect(html).toContain("data-cloud-hub-backup");
    expect(html).not.toContain("Backing up…");
  });

  it("says that a hub backup does not contain tasks, without being asked", () => {
    // Not behind the disclosure, not a tooltip. A person reads "back up the hub"
    // as "back up my work"; the correction has to be visible by default.
    const html = panel({ workspaces: hubReport([hubRow()]) });
    const note = html.slice(html.indexOf("data-cloud-hub-backup-note"));
    expect(note).toContain("does not contain any tasks");
  });

  it("counts what is NOT on this machine, which is what a new machine asks", () => {
    const html = panel({ workspaces: hubReport([hubRow(), missingRow("gone")]) });
    const self = html.slice(
      html.indexOf("data-cloud-hub-self"),
      html.indexOf("data-cloud-workspaces="),
    );
    expect(self).toContain("Registered elsewhere");
  });

  it("states the hub rather than the open workspace", () => {
    const html = panel({
      report: DISCONNECTED,
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
    });
    const self = html.slice(
      html.indexOf("data-cloud-hub-self"),
      html.indexOf("data-cloud-workspaces="),
    );
    expect(self).toContain("2");
    // The hub panel carries no connection state at all — that belongs to rows,
    // and putting it here is the conflation the ticket exists to end.
    expect(self).not.toContain("Not connected");
  });
});

// ----------------------------------------- the hub acts on all of them (S18/STA-279)

/**
 * THE HUB-WIDE VERBS — S18 (STA-279), the last acceptance criterion:
 * *"Hub-wide connect, sync and disconnect are performed from there"*.
 *
 * ## What is pinned here, and why it is not the wiring
 *
 * `test/ui-cloud-hub-verbs.test.ts` proves the ROUTES act on the whole registry,
 * against real workspaces and a real fake service on loopback. Nothing in this
 * file can prove that and it must not pretend to: the suite has no DOM, so no
 * handler here ever runs. What it CAN prove is the two things the surface is
 * uniquely responsible for and which no route test can see:
 *
 *  1. **Every control states the count it will act on.** The whole objection this
 *     feature was refused on twice is that a hub-wide button asks for less than
 *     the CLI shows. "Connect all" is a blast radius invisible until after the
 *     press; "Connect 4 workspaces" is one somebody can decline for a reason. The
 *     count is a pure function of the report, so it is testable exactly.
 *  2. **The consent screen discloses per workspace, out of the single copy.** The
 *     disclosure is `CONNECT_DISCLOSURE` and there is no second copy of it in this
 *     component — asserted at the SOURCE, because a second copy would render
 *     identically on the day it was added and no rendered assertion would notice.
 */

/** A row that has not recorded a sync identity yet: actionable by BUTTON, skipped by FAN-OUT. */
function unrecordedRow(slug: string): HubWorkspaceReport {
  return hubRow({
    slug,
    prefix: slug.slice(0, 3).toUpperCase(),
    repositoryId: null,
    state: "disconnected",
    mode: "disconnected",
    endpoint: null,
    deviceId: null,
    label: null,
    credentialMechanism: null,
    connectedAt: null,
    // `actionable: true` with `skip: "no_identity"` is the whole point of the row:
    // pressing its own Connect opens the workspace and records an identity, and a
    // fan-out never opens a database.
    actionable: true,
    recordsIdentityOnOpen: true,
    skip: "no_identity",
    skipDetail:
      "This workspace is registered and its database is on this machine; it has not recorded a " +
      "sync identity yet.",
  });
}

/** Connected, and its disk is gone. In disconnect's set; in neither of the others. */
function connectedButAbsentRow(slug: string): HubWorkspaceReport {
  return hubRow({
    slug,
    prefix: slug.slice(0, 3).toUpperCase(),
    path: `/tmp/gone/${slug}/.staple/staple.db`,
    available: false,
    actionable: false,
    state: "manual",
    mode: "manual",
    skip: "unavailable",
    skipDetail: "The workspace database is not on this machine right now.",
  });
}

function controlOf(report: HubCloudReport, action: HubWideAction): HubWideControl {
  const control = hubWideControls(report).find((candidate) => candidate.action === action);
  if (!control) throw new Error(`no hub-wide ${action} control`);
  return control;
}

/** A fan-out preview with two actionable rows and one skipped, as the route returns it. */
function connectPreviewFixture(): HubConnectPreview {
  const forSlug = (repositoryId: string): ConnectPreview => ({
    ...PREVIEW,
    repositoryId,
    credentialMechanism: "keychain",
    credentialFallbackReason: null,
  });
  return {
    endpoint: "https://sync.example.com",
    willConnect: 2,
    willReconnect: 0,
    willSkip: 1,
    autoAfterConnect: false,
    entries: [
      {
        slug: "alpha",
        prefix: "ALP",
        path: "/work/alpha/.staple/staple.db",
        kind: "repo",
        available: true,
        repositoryId: "id-alpha",
        action: "connect",
        reason: "Not connected on this machine. A credential will be minted and stored here.",
        skip: null,
        preview: forSlug("id-alpha"),
      },
      {
        slug: "bravo",
        prefix: "BRA",
        path: "/work/bravo/.staple/staple.db",
        kind: "repo",
        available: true,
        repositoryId: "id-bravo",
        action: "connect",
        reason: "Not connected on this machine. A credential will be minted and stored here.",
        skip: null,
        preview: forSlug("id-bravo"),
      },
      {
        slug: "charlie",
        prefix: "CHA",
        path: "/tmp/gone/charlie/.staple/staple.db",
        kind: "repo",
        available: false,
        repositoryId: null,
        action: "skip",
        reason:
          "The workspace database is not on this machine right now. It is left registered and " +
          "untouched — an unmounted volume is not a deleted workspace.",
        skip: "unavailable",
        preview: null,
      },
    ],
  };
}

const FAN_OUT: HubFanOut = {
  action: "connect",
  at: "2026-09-09T12:00:00.000Z",
  ok: 2,
  skipped: 1,
  failed: 0,
  workspaces: [
    {
      slug: "alpha",
      action: "connect",
      status: "ok",
      detail: "Connected. Credential stored in this machine's keychain.",
      at: "2026-09-09T12:00:00.000Z",
    },
    {
      slug: "bravo",
      action: "connect",
      status: "ok",
      detail: "Connected. Credential stored in this machine's keychain.",
      at: "2026-09-09T12:00:00.000Z",
    },
    {
      slug: "charlie",
      action: "connect",
      status: "skipped",
      detail: "The workspace database is not on this machine right now.",
      at: "2026-09-09T12:00:00.000Z",
    },
  ],
};

describe("the hub panel performs all three verbs, each naming its count (S18/STA-279)", () => {
  it("offers connect, sync and disconnect, and each label carries the count", () => {
    const report = hubReport([
      hubRow({ slug: "alpha", repositoryId: "a", state: "disconnected", mode: "disconnected", endpoint: null }),
      hubRow({ slug: "bravo", repositoryId: "b", state: "disconnected", mode: "disconnected", endpoint: null }),
      hubRow({ slug: "charlie", repositoryId: "c" }),
    ]);
    const html = panel({ workspaces: report });

    expect(html).toContain("data-cloud-hub-wide");
    for (const action of ["connect", "sync", "disconnect"] as const) {
      expect(html, `no hub-wide ${action}`).toContain(`data-cloud-hub-action="${action}"`);
    }
    // The COUNT, not the word "all". Two disconnected, one connected.
    expect(html).toContain("Connect 2 workspaces");
    expect(html).toContain("Sync 1 connected workspace");
    expect(html).toContain("Disconnect 1 workspace");
    expect(html).not.toContain("Connect all");
  });

  /**
   * THE THREE PREDICATES DISAGREE, and each disagreement is a real machine state
   * rather than a hypothetical. The surface half of the asymmetry the routes are
   * held to.
   */
  it("counts an unreachable CONNECTED workspace for disconnect, and for neither of the others", () => {
    const report = hubReport([connectedButAbsentRow("gone")]);
    expect(hubWideTargets(report, "connect").map((row) => row.slug)).toEqual([]);
    // Sync opens the database, so an unmounted volume makes it impossible…
    expect(hubWideTargets(report, "sync").map((row) => row.slug)).toEqual([]);
    // …and disconnect removes a file in the staple home, so it makes it MORE
    // important: refusing would leave a live credential behind for exactly the
    // workspace somebody is most likely to be disconnecting.
    expect(hubWideTargets(report, "disconnect").map((row) => row.slug)).toEqual(["gone"]);

    expect(controlOf(report, "disconnect").disabledReason).toBeNull();
    expect(controlOf(report, "sync").disabledReason).toContain("not on this machine");
  });

  it("does NOT count a workspace that would record its identity on open, and says why", () => {
    /**
     * The row is `actionable: true` — its OWN Connect works, because pressing it
     * opens the workspace and recording an identity is what opening does. A
     * fan-out reads files and never opens a database, so it is not in the
     * hub-wide set. Counting it would promise something the fan-out then declines
     * to do, which is worse than not offering it.
     */
    const report = hubReport([unrecordedRow("fresh")]);
    expect(hubWideTargets(report, "connect")).toEqual([]);
    const connect = controlOf(report, "connect");
    expect(connect.count).toBe(0);
    expect(connect.disabledReason).toContain("not recorded");
    expect(connect.disabledReason).toContain("its own Connect button");
  });

  it("states a reason for every unavailable control and hides none of them", () => {
    // A machine with nothing registered: all three are unavailable, and all three
    // are still on screen.
    const html = panel({ workspaces: hubReport([]) });
    for (const action of ["connect", "sync", "disconnect"] as const) {
      expect(html).toContain(`data-cloud-hub-wide-control="${action}"`);
      expect(html).toContain(`data-cloud-hub-action="${action}"`);
    }
    expect(html).toContain("data-cloud-hub-wide-unavailable");
    expect(html).toContain("No workspaces are registered on this machine yet.");
  });

  it("groups a shared reason into one line rather than repeating it three times", () => {
    /**
     * *"We don't need settings page to be noise gibrish but functional."* On an
     * empty machine all three controls share one sentence, and printing it beside
     * each of them is the noise this page is supposed to be free of — the same
     * grouping the rows use, through the same function.
     */
    const grouped = groupDisabledReasons(hubWideControls(hubReport([])));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.labels).toHaveLength(3);
    expect(joinLabels(grouped[0]!.labels)).toContain(" and ");
  });

  it("keeps the hub-wide controls in the hub panel, above the list, and out of the rows", () => {
    const report = hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]);
    const html = panel({ workspaces: report });
    // Position is the claim: a hub-wide Disconnect inside a list of per-row
    // Disconnects is the wrong-subject confusion this ticket exists to end.
    expect(html.indexOf("data-cloud-hub-wide")).toBeLessThan(html.indexOf("data-cloud-workspaces="));
    const list = html.slice(html.indexOf("data-cloud-workspaces="));
    expect(list).not.toContain("data-cloud-hub-action");
  });

  it("says where each kind of action lives, instead of claiming none acts on all", () => {
    const text = hubListDescription(hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]));
    expect(text).toContain("the hub panel above acts on all of them");
    expect(text).not.toContain("nothing here acts on all of them");
  });
});

describe("the hub-wide consent screen asks for as much as the CLI preview does", () => {
  const consenting = (preview: HubConnectPreview): string =>
    panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: {
        ...IDLE_HUB,
        wide: {
          ...IDLE_WIDE,
          connecting: {
            draft: { endpoint: "https://sync.example.com", enrollment: "s", label: "", credentialFile: false },
            pending: { preview, consents: [] },
          },
        },
      },
    });

  it("names every actionable workspace and its own service, repository and credential store", () => {
    const html = consenting(connectPreviewFixture());
    expect(html).toContain("data-cloud-hub-consent");
    /**
     * PER ROW, which is the answer to *"one enrollment secret against N
     * services"*. A count is not consent — `willConnect: 2` is a number — so each
     * row carries its own destination, rendered through the same `previewFacts`
     * the single-workspace consent screen uses.
     */
    for (const slug of ["alpha", "bravo"]) {
      expect(html).toContain(`data-cloud-hub-consent-row="${slug}"`);
    }
    expect(html).toContain("https://sync.example.com");
    expect(html).toContain("id-alpha");
    expect(html).toContain("id-bravo");
    // The credential store, in words, for each of them.
    expect(html.match(/keychain/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("lists the workspaces it will NOT touch, with the fan-out's own reason", () => {
    /**
     * Rendered and not hidden. They answer "why is my other repository not in
     * this list?" before it is asked, and dropping them would turn "2 of 3" into
     * "2" — the number that makes debris look like inventory.
     */
    const html = consenting(connectPreviewFixture());
    expect(html).toContain("data-cloud-hub-consent-skipped");
    expect(html).toContain('data-cloud-hub-consent-skip="charlie"');
    expect(html).toContain("an unmounted volume is not a deleted workspace");
  });

  it("shows the SAME disclosure as a per-row connect, out of the one copy of it", () => {
    const html = consenting(connectPreviewFixture());
    for (const line of CONNECT_DISCLOSURE) {
      expect(html, `the hub-wide consent screen dropped: ${line}`).toContain(
        line.replace(/&/g, "&amp;"),
      );
    }
    /**
     * THE SOURCE ASSERTION, and the one no rendered check could make. A second
     * copy of these sentences is a second place for a consent promise to drift,
     * and it would render identically on the day it was added. So the component
     * must not contain the text at all — only the import, used twice: once on a
     * row's connect and once hub-wide.
     */
    const file = source("CloudSection.tsx");
    expect(file).not.toContain("AUTOMATIC SYNC STAYS OFF");
    expect(file).not.toContain("stored in PLAINTEXT");
    expect(file.match(/CONNECT_DISCLOSURE\.map/g)?.length).toBe(3);
  });

  it("confirms with the count, not with the word all", () => {
    const html = consenting(connectPreviewFixture());
    expect(html).toContain("data-cloud-hub-confirm");
    expect(html).toContain("Connect 2 workspaces");
  });
});

describe("a hub-wide disconnect names what it is about, and reports per workspace", () => {
  it("names the count and every workspace in the confirmation", () => {
    const report = hubReport([
      hubRow({ slug: "alpha", repositoryId: "a" }),
      hubRow({ slug: "bravo", repositoryId: "b" }),
    ]);
    const warning = hubWideDisconnectWarning(report);
    expect(warning).toContain("2 workspaces");
    expect(warning).toContain("alpha, bravo");
    // What is NOT lost, said in the confirmation rather than discovered after it.
    expect(warning).toContain("untouched");
    expect(warning).toContain("no remote copy is deleted");

    const html = panel({
      workspaces: report,
      hub: { ...IDLE_HUB, wide: { ...IDLE_WIDE, disconnecting: true } },
    });
    expect(html).toContain("alpha, bravo");
    expect(html).toContain("Disconnect 2 workspaces");
  });

  it("says that an unreachable workspace is disconnected too, and why that is right", () => {
    const warning = hubWideDisconnectWarning(
      hubReport([hubRow({ slug: "here", repositoryId: "h" }), connectedButAbsentRow("gone")]),
    );
    expect(warning).toContain("not on this machine");
    expect(warning).toContain("the credential is here, not there");
  });

  it("renders a per-workspace outcome TABLE, including the rows nothing happened to", () => {
    /**
     * The resolution of *"an outcome a dialog has nowhere to put"*. It has
     * somewhere to go, and the skipped row is in it: a table listing only the
     * failures would be indistinguishable, on a good day, from a button that did
     * nothing.
     */
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: { ...IDLE_HUB, wide: { ...IDLE_WIDE, fanOut: FAN_OUT } },
    });
    expect(html).toContain('data-cloud-hub-fanout="connect"');
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(html).toContain(`data-cloud-hub-fanout-row="${slug}"`);
    }
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('data-status="skipped"');
  });

  it("summarizes with counts and never with a bare 'done'", () => {
    expect(hubFanOutSummary(FAN_OUT)).toContain("2 connected, 1 skipped.");
    // And the promise a connect must not silently drop.
    expect(hubFanOutSummary(FAN_OUT)).toContain("Automatic sync and backup are OFF");

    const failed: HubFanOut = { ...FAN_OUT, action: "sync", ok: 1, skipped: 0, failed: 2 };
    expect(hubFanOutSummary(failed)).toContain("1 synchronized, 2 failed.");
    expect(hubFanOutSummary(failed)).toContain("a failure on one did not stop the others");
  });
});

describe("a refused hub-wide confirm returns to the form, not to a dead consent screen", () => {
  const PENDING = {
    draft: { endpoint: "https://sync.example.com", enrollment: "s", label: "", credentialFile: false },
    pending: { preview: connectPreviewFixture(), consents: [] },
  };

  /**
   * **THE RULE, tested as a transition rather than asserted at the source.**
   *
   * `ConsentTicketStore.redeem` deletes a ticket before it validates anything,
   * so every refusal on the confirm path except the blank-secret one lands with
   * tickets already spent. Leaving `pending` up left the enumeration on screen
   * behind an enabled "Connect 3 workspaces", and the second press answered
   * `Confirming "alpha": That consent has expired, was already used…` — the
   * wrong workspace and the wrong cause, which is the same misleading refusal
   * this lane fixed one layer down inside `redeem`.
   */
  it("clears the pending enumeration on any refusal, and keeps the draft", () => {
    const after = hubWideFailure({ ...IDLE_WIDE, connecting: PENDING }, "nope");
    expect(after.error).toBe("nope");
    expect(after.connecting).not.toBeNull();
    expect(after.connecting!.pending).toBeNull();
    // The draft survives, so recovering is one press of Review rather than
    // retyping an endpoint and an enrollment secret.
    expect(after.connecting!.draft).toEqual(PENDING.draft);
  });

  it("leaves a closed connect flow closed rather than reopening it", () => {
    const after = hubWideFailure({ ...IDLE_WIDE, connecting: null }, "nope");
    expect(after.connecting).toBeNull();
    expect(after.error).toBe("nope");
  });

  it("renders the form again, not the confirm button, once pending is cleared", () => {
    const html = panel({
      workspaces: hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]),
      hub: {
        ...IDLE_HUB,
        wide: hubWideFailure(
          { ...IDLE_WIDE, connecting: PENDING },
          "This machine's workspaces changed while that preview was on screen.",
        ),
      },
    });
    // The consent screen is gone…
    expect(html).not.toContain("data-cloud-hub-consent");
    expect(html).not.toContain("data-cloud-hub-confirm");
    // …the form is back, and the refusal is on screen above it.
    expect(html).toContain("data-cloud-hub-preview");
    expect(html).toContain("changed while that preview was on screen");
  });
});

describe("the two outcome surfaces do not contradict each other", () => {
  /**
   * A fan-out table is a RESULT, not a log, and so is a row's outcome line. When
   * one is produced the other has stopped being true of at least one row —
   * press hub-wide Sync then `bravo`'s own Disconnect and the table still read
   * `bravo — done — Synchronized…` above a `bravo` rendering as disconnected,
   * which breaks S19's *"a row shows the outcome of the last operation on it"*.
   */
  it("shows a fan-out table or per-row outcomes, never both", () => {
    const report = hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]);
    const withBoth = panel({
      workspaces: report,
      hub: {
        ...IDLE_HUB,
        outcomes: {
          bravo: {
            slug: "bravo",
            action: "sync",
            status: "ok",
            detail: "pushed 3, applied 0",
            at: "2026-09-09T12:00:00.000Z",
          },
        },
        wide: { ...IDLE_WIDE, fanOut: FAN_OUT },
      },
    });
    /**
     * This is the state the component now cannot reach — `applyFanOut` empties
     * `outcomes` and `applyRowResult` nulls `fanOut` — so the assertion is that
     * the two are mutually exclusive by construction upstream, pinned here at
     * the source because the reducers live inside the component.
     */
    expect(withBoth).toContain("data-cloud-hub-fanout");
    expect(withBoth).toContain("data-cloud-workspace-outcome");

    const file = source("CloudSection.tsx");
    // A hub-wide result supersedes every per-row line…
    expect(file).toMatch(/applyFanOut[\s\S]*?outcomes: \{\},/);
    // …and a per-row result drops the table rather than patching one of its rows.
    expect(file).toMatch(/applyRowResult[\s\S]*?wide: \{ \.\.\.current\.wide, fanOut: null \}/);
  });
});

describe("the hub's publish consent (S22/STA-283)", () => {
  const withRegistry = (registry: Partial<HubCloudReport["self"]["registry"]>): HubCloudReport => {
    const base = hubReport([hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]);
    return { ...base, self: { ...base.self, registry: { ...base.self.registry, ...registry } } };
  };

  it("shows the disclosure before the switch, and from the report rather than a local copy", () => {
    const html = panel({ workspaces: withRegistry({ connected: true, endpoint: "https://s.example" }) });
    expect(html).toContain("data-cloud-hub-registry");
    expect(html).toContain("data-cloud-hub-registry-disclosure");
    /**
     * The three things a person is actually giving up. Rendered by default —
     * not behind a `<details>`, not in a `title` — because this is the sentence
     * that pays for the invariant `hub-scope.ts` gave up, and a disclosure
     * behind a triangle is a disclosure most people do not read.
     */
    expect(html).toContain("names, prefixes and identities");
    expect(html).toContain("sit together");

    /**
     * THE SOURCE ASSERTION. The browser cannot import `src/core`, so the only
     * ways to get this sentence on screen are "from the report" and "retyped".
     * A retyped copy would render identically on the day it was added and drift
     * silently thereafter, which no rendered check could catch.
     */
    const file = source("CloudSection.tsx");
    /**
     * Scanned with COMMENTS STRIPPED. The rule is "no second copy on a render
     * path", and a doc comment quoting the sentence so a reader knows what is at
     * stake is documentation rather than a second copy — it cannot reach a
     * screen. Scanning the raw file would forbid explaining the thing, which is
     * the opposite of what this codebase does everywhere else.
     */
    const code = file.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("names, prefixes and identities");
    expect(code).toContain("report.self.registry.disclosure");
    // And the stripper really removed something, so the assertion is not vacuous.
    expect(file).toContain("names, prefixes and identities");
  });

  it("is disabled with a reason when the hub itself is not connected", () => {
    const report = withRegistry({ connected: false });
    const control = hubRegistryControl(report);
    expect(control.value).toBe(false);
    /**
     * `setRegistryConsent` refuses `not_found` on an unconnected hub rather than
     * springing a record into existence, so a switch that flipped and then threw
     * would be offering a decision the product cannot store.
     */
    expect(control.disabledReason).toContain("not connected");

    const html = panel({ workspaces: report });
    // Still rendered, with its reason — never hidden. Compared on a substring
    // rather than the whole sentence because the markup escapes the apostrophe.
    expect(html).toContain("data-cloud-hub-registry-toggle");
    expect(html).toContain("The hub itself is not connected to a service on this machine");
    expect(html).toContain("It is a separate connection from each workspace");
  });

  it("binds to the VALUE on the report, never to a sentence", () => {
    expect(hubRegistryControl(withRegistry({ connected: true, consent: true })).value).toBe(true);
    expect(hubRegistryControl(withRegistry({ connected: true, consent: false })).value).toBe(false);
    const html = panel({ workspaces: withRegistry({ connected: true, consent: true }) });
    expect(html).toContain('aria-checked="true"');
  });

  it("is a switch on the HUB, and never a fourth toggle on a row", () => {
    const html = panel({ workspaces: withRegistry({ connected: true }) });
    // In the hub panel…
    expect(html.indexOf("data-cloud-hub-registry")).toBeLessThan(
      html.indexOf("data-cloud-workspaces="),
    );
    // …and nowhere in the list. The other three consents are per workspace; this
    // one is singular, because there is one registry.
    const list = html.slice(html.indexOf("data-cloud-workspaces="));
    expect(list).not.toContain("data-cloud-hub-registry");
    for (const row of [hubRow(), hubRow({ slug: "bravo", repositoryId: "b" })]) {
      expect(hubRowControls(row).map((control) => control.action)).not.toContain("registry");
    }
  });

  it("takes no slug, because the hub is not one of the rows", () => {
    const file = source("CloudSection.tsx");
    expect(file).toContain("onHubRegistryConsent: (enabled: boolean, disclosure: string) => void;");
    expect(file).not.toMatch(/onHubRegistryConsent: \(slug/);
  });

  it("hands back the sentence it rendered, from the report and not a literal", () => {
    /**
     * `setRegistryConsent` refuses to enable without the disclosure verbatim —
     * evidence that whoever is granting this had it in hand. The check only
     * survives the HTTP boundary because the CLIENT supplies it; a server that
     * passed the constant on the client's behalf would satisfy the check while
     * proving nothing.
     *
     * So the switch must send the value it just rendered, and the only place it
     * can get that is the report. A literal typed into this component would be
     * both a second copy and a way to grant the consent having displayed
     * nothing — which is precisely the failure the argument exists to remove.
     */
    const file = source("CloudSection.tsx");
    expect(file).toContain("onConsent(event.target.checked, report.self.registry.disclosure)");

    const client = readFileSync(fileURLToPath(new URL("../lib/api.ts", import.meta.url)), "utf8");
    const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The client forwards its argument and never carries the sentence itself.
    expect(clientCode).not.toContain("names, prefixes and identities");
    expect(clientCode).toContain("disclosure");
    // Withdrawing carries no acknowledgement: revocation must not be harder.
    expect(clientCode).toContain("enabled ? { disclosure } : {}");
  });
});

describe("nothing hub-wide happens without a press", () => {
  /**
   * `syncHub` is the widest egressing call on this surface — one authenticated
   * round trip per connected workspace — so it is the one that would turn opening
   * settings into a machine-wide heartbeat. `connectHub` spends a secret. Neither
   * may appear in an effect, and the assertion is at the source because the suite
   * has no DOM and effects never run here.
   */
  it("calls no hub-wide route from an effect", () => {
    const file = source("CloudSection.tsx");
    const effects = [...file.matchAll(/useEffect\(([\s\S]*?)\n\s*\}, \[/g)].map((match) => match[1]!);
    expect(effects.length).toBeGreaterThan(0);
    const joined = effects.join("\n");
    /**
     * The pattern is NOT indentation-bound (`\n\s*\}, \[` rather than
     * `\n  \}, \[`), so an effect declared inside a nested component —
     * `HubSelfPanel`, `HubWorkspaceList`, `HubRow` — is seen too. The
     * two-space form could only ever see effects at the top level of
     * `CloudSection`, which is exactly where nobody would hide one.
     */
    for (const egress of ["syncHub", "connectHub", "previewHubConnect", "disconnectHub"]) {
      expect(joined, `${egress} is called from an effect — that is a fan-out on open`).not.toContain(
        egress,
      );
    }
  });

  it("has no hub-wide purge, in the panel, the pure half, or the client", () => {
    /**
     * STA-256 records that the server does not validate a purge confirmation on
     * the wire. A one-click irreversible remote deletion of every workspace is
     * worse hub-wide than per workspace by exactly the size of the registry, and
     * `PURGE_NOTICE` names the capability without offering it.
     *
     * **`lib/api.ts` is in this list, and it is the one that matters.** The
     * first version of this scan covered only the two files in this directory —
     * but a `purgeHub` would live in the CLIENT, which neither of them is, so
     * the assertion could not have failed on the thing it was written to catch.
     * The server-side 405/404 assertions in `test/ui-cloud-hub-verbs.test.ts`
     * would still have bitten; this one would have watched it go past.
     */
    for (const file of ["CloudSection.tsx", "cloud-settings.ts"]) {
      expect(source(file), file).not.toMatch(/purgeHub|hubPurge|\/api\/hub\/purge/);
    }
    const client = readFileSync(
      fileURLToPath(new URL("../lib/api.ts", import.meta.url)),
      "utf8",
    );
    expect(client).not.toMatch(/purgeHub|hubPurge/);
    expect(client).not.toContain("/api/hub/purge");
    expect(client).not.toContain("/api/cloud/purge");
    // And the scan really is looking at the client: it has the routes it should.
    expect(client).toContain("/api/hub/disconnect");
  });
});
