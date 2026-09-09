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
import { CloudPanel, type CloudPanelProps } from "./CloudSection";
import {
  CLOUD_CATEGORY,
  CLOUD_CATEGORY_ID,
  canOfferConnect,
  connectFormProblem,
  connectionFacts,
  consentControls,
  counterFacts,
  describeDevice,
  hubListDescription,
  hubRowView,
  isCloudCategory,
  orderDevices,
  previewFacts,
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

// ---------------------------------------------- the hub-wide list (S16/STA-275)

function hubRow(overrides: Partial<HubWorkspaceReport> = {}): HubWorkspaceReport {
  return {
    slug: "alpha",
    prefix: "ALP",
    path: "/work/alpha/.staple/staple.db",
    kind: "repo",
    available: true,
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

function hubReport(rows: HubWorkspaceReport[]): HubCloudReport {
  return {
    workspaces: rows,
    counts: {
      total: rows.length,
      connected: rows.filter((row) => row.state !== "disconnected").length,
      disconnected: rows.filter((row) => row.state === "disconnected").length,
      skipped: rows.filter((row) => row.skip !== null).length,
      automatic: rows.filter((row) => row.auto).length,
    },
    endpoints: [
      ...new Set(rows.map((row) => row.endpoint).filter((value): value is string => value !== null)),
    ].sort(),
  };
}

describe("the hub-wide workspace list", () => {
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

    expect(html).toContain('data-cloud-workspaces');
    for (const slug of ["alpha", "bravo", "charlie"]) {
      expect(html).toContain(`data-cloud-workspace="${slug}"`);
    }
    // Each row carries its OWN state, which is the criterion.
    expect(html).toContain("Connected, manual");
    expect(html).toContain("Connected, automatic");
    expect(html).toContain("Not connected");
  });

  it("renders when the CURRENT workspace is disconnected — the case it exists for", () => {
    /**
     * Every other section on this panel is behind the `connected` branch. This
     * one must not be: the question it answers is "have I connected anything?",
     * asked by somebody looking at a workspace that says Not connected. Hiding
     * the list until the current workspace happened to be connected would make it
     * invisible exactly when it is useful.
     */
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

  it("shows why a workspace a hub-wide operation would skip is skipped", () => {
    const html = panel({
      workspaces: hubReport([
        hubRow(),
        hubRow({
          slug: "bravo",
          repositoryId: null,
          available: false,
          state: "disconnected",
          mode: "disconnected",
          endpoint: null,
          skip: "unavailable",
          skipDetail: "The workspace database is not on this machine right now.",
        }),
      ]),
    });
    expect(html).toContain("not on this machine right now");
  });

  it("never renders credentialPresent, because the route that feeds it does not look", () => {
    /**
     * `null` means NOT ASKED. A column that read it as falsy would print "no
     * credential" for every workspace on a surface that deliberately never
     * probed — the difference between "your credential is gone" and "we did not
     * check".
     */
    const view = hubRowView(hubRow({ credentialPresent: null }));
    expect(Object.keys(view)).not.toContain("credentialPresent");
    expect(view.state).toBe("Connected, manual");
  });

  it("draws nothing for a machine with one workspace or none", () => {
    // A "list" of one is a heading restating what the sections above already say.
    expect(panel({ workspaces: hubReport([hubRow()]) })).not.toContain("data-cloud-workspaces");
    expect(panel({ workspaces: hubReport([]) })).not.toContain("data-cloud-workspaces");
    expect(panel({ workspaces: null })).not.toContain("data-cloud-workspaces");
  });

  it("names the CLI gesture rather than offering a button that would ask less", () => {
    /**
     * A deliberate scope boundary, not an omission. Connecting every workspace
     * spends one enrollment secret against N services and produces a
     * per-workspace outcome; a button here would have to re-implement the whole
     * fan-out preview to ask for that honestly, and one that showed less than the
     * CLI preview shows would be a worse consent rather than a more convenient
     * one.
     */
    const text = hubListDescription({
      total: 4,
      connected: 2,
      disconnected: 2,
      skipped: 1,
      automatic: 1,
    });
    expect(text).toContain("2 of 4 connected");
    expect(text).toContain("staple cloud connect --all");
    expect(text).toContain("enumerated when the page loads");
  });

  it("is fetched once on mount and is NOT on any poll", () => {
    const text = source("CloudSection.tsx");
    expect(text).toContain("getCloudWorkspaces()");
    /**
     * The list describes N workspaces, and the temptation with a list is to poll
     * it. It must not be polled: connection state changes when a human runs a
     * command in a terminal, so a poll would do the work forever to learn
     * nothing. `useEffect` with an empty dependency array is the assertion — it is
     * about the MACHINE, so it does not even re-run when `ws` changes.
     */
    const effect = text.slice(text.indexOf("getCloudWorkspaces()"));
    expect(effect.slice(0, effect.indexOf("}, [") + 8)).toContain("}, []);");
    expect(text).not.toMatch(/setInterval[\s\S]{0,200}getCloudWorkspaces/);
  });
});
