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
  HubWorkspaceReport,
  RemoteDevice,
} from "@/lib/types";
import { CloudPanel, type CloudPanelProps, type HubPanelState } from "./CloudSection";
import {
  CLOUD_CATEGORY,
  CLOUD_CATEGORY_ID,
  canOfferConnect,
  connectFormProblem,
  connectionFacts,
  consentControls,
  counterFacts,
  describeDevice,
  groupDisabledReasons,
  hubGroups,
  hubListDescription,
  hubRowControls,
  hubRowRationale,
  hubRowSummary,
  hubRowView,
  hubUnreachableDescription,
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

/** Nothing on the list is doing anything. The default for every case in this file. */
const IDLE_HUB: HubPanelState = {
  busy: null,
  refreshing: false,
  backingUp: false,
  outcomes: {},
  connecting: null,
  removing: null,
  disconnecting: null,
  error: null,
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
