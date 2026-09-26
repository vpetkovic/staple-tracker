/**
 * The disconnected page is BYTE-IDENTICAL to a page with no cloud feature in it.
 *
 * This is the acceptance criterion *"Disconnected UI remains quiet and never
 * prompts connects or contacts the network"*, turned into something a machine
 * can check. `docs/sync.md` is unusually specific about it: *"render 'not
 * connected' and a static hint naming `staple cloud connect`. Static text. No
 * probe, no reachability check, no 'we noticed you might want to connect'. **The
 * UI does not prompt.**"*
 *
 * Note what the contract permits and this component still declines. A static
 * hint before connect is ALLOWED. It is not rendered anyway, because "allowed"
 * and "wanted" are different, and every unconnected workspace — which is all of
 * them until somebody types a command — would carry a permanent advertisement
 * for a feature the user has not asked for. The empty-string assertion below is
 * the strongest available statement of that, and it is deliberately stronger
 * than the contract's floor.
 *
 * The network half of the invariant is proved separately and at a different
 * level: `test/network-silence.test.ts` boots the real server under a spy. A
 * component test cannot prove absence of egress, so it does not pretend to.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudStrip, hubSyncSummary, syncSummary, syncedAgo } from "./CloudStrip";
import type { CloudSurfaceReport, HubCloudReport } from "@/lib/types";

function report(over: Partial<CloudSurfaceReport> = {}): CloudSurfaceReport {
  return {
    state: "disconnected",
    mode: "disconnected",
    detail: "not connected — no credential, no endpoint and no cloud state on this machine",
    repositoryId: null,
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
    quarantined: 0,
    leases: { held: 0 },
    warnings: [],
    failure: null,
    hint: "staple cloud connect",
    ...over,
  };
}

const connected = (over: Partial<CloudSurfaceReport> = {}) =>
  report({
    state: "manual",
    mode: "manual",
    detail: "connected, manual — nothing synchronizes until you run `staple cloud sync`",
    repositoryId: "repo-1",
    endpoint: "https://sync.example.workers.dev",
    deviceId: "device-here",
    label: "laptop",
    credentialMechanism: "file",
    credentialPresent: true,
    connectedAt: "2026-09-05T00:00:00.000Z",
    hint: null,
    ...over,
  });

const html = (r: CloudSurfaceReport | null) => renderToStaticMarkup(<CloudStrip report={r} />);

// ------------------------------------------------------------------- silence

describe("a disconnected workspace gets no cloud furniture at all", () => {
  /**
   * The whole invariant in one line. Not "renders a muted hint", not "renders a
   * collapsed strip" — nothing. A zero-height element still changes layout, and
   * "looks exactly as it did before this epic existed" is only checkable if the
   * answer is the empty string.
   */
  it("renders literally nothing when disconnected", () => {
    expect(html(report())).toBe("");
  });

  /**
   * The state before the first `/api/cloud/status` answer arrives. A component
   * that rendered a skeleton here would flash cloud furniture onto every page
   * load on a machine that has never been connected — the nag, arriving by way
   * of a loading state.
   */
  it("renders nothing before the status has loaded", () => {
    expect(html(null)).toBe("");
  });

  /** A workspace with no sync identity at all is quieter still, not louder. */
  it("renders nothing for a workspace that has no repository identity", () => {
    expect(
      html(
        report({
          failure: {
            code: "no_identity",
            summary: "This workspace has no repository identity.",
            remedy: "Run `staple init` inside a repository to record one.",
          },
        }),
      ),
    ).toBe("");
  });

  /**
   * The regression this file exists to catch, stated as vocabulary rather than
   * as markup: the failure mode is not "someone renders the wrong element", it
   * is "someone adds a helpful call to action". Naming the words makes the test
   * survive a redesign that changes every class name.
   */
  it("says none of the words a prompt would need", () => {
    const rendered = html(report()).toLowerCase();
    for (const word of ["connect", "cloud", "sync", "backup", "enable", "get started"]) {
      expect(rendered).not.toContain(word);
    }
  });

  /**
   * Unresolved conflicts are real, local, and worth surfacing — but not at the
   * cost of the invariant. A disconnected repository that once synced can still
   * hold conflicts, and this component is not where they get shown; the CLI and
   * `/api/cloud/conflicts` are, in every state. Showing them here would put
   * cloud furniture on a disconnected page through the back door.
   */
  it("stays silent even when a disconnected workspace still holds conflicts", () => {
    expect(html(report({ conflicts: { open: 3, resolved: 1 } }))).toBe("");
  });
});

// -------------------------------------------------------- connected rendering

/**
 * DELIBERATELY CHANGED. The strip of field names (`sync automatic  device laptop  cursor
 * cur-9  epoch 2`) is now a status pill whose card says the state in plain words, keeps the
 * facts a person acts on, and puts the technical values behind "Show details". The pill is
 * what renders in the page; the card's words come from `syncSummary`, asserted directly
 * because Radix renders a closed popover's content nowhere a string render can see.
 */
const everything = (summary: ReturnType<typeof syncSummary>) =>
  summary ? [summary.pill, summary.headline, ...[...summary.facts, ...summary.details].flatMap((f) => [f.label, f.value])].join(" | ") : "";

describe("a connected workspace shows one pill, and its card keeps every value", () => {
  it("renders a single pill button, no strip of labelled fields", () => {
    const rendered = html(connected());
    expect(rendered).toContain("data-cloud-strip");
    expect(rendered).toMatch(/^<button/);
    for (const field of [">sync<", ">device<", ">cursor<", ">epoch<"]) expect(rendered).not.toContain(field);
  });

  it("names the mode in words, and the device by its human label when it has one", () => {
    const summary = syncSummary(connected());
    expect(summary?.pill).toBe("Manual sync");
    expect(summary?.headline).toContain("only when you ask");
    expect(summary?.facts).toContainEqual({ label: "This device", value: "laptop" });
    expect(html(connected())).toContain("Manual sync");
  });

  it("falls back to the device id when no label was given", () => {
    expect(syncSummary(connected({ label: null }))?.facts).toContainEqual({ label: "This device", value: "device-here" });
  });

  it("keeps pending, the cursor and the epoch — the technical two behind Show details", () => {
    const summary = syncSummary(connected({ pending: 4, cursor: "cur-9", epoch: 2 }))!;
    expect(summary.pill).toBe("4 waiting to send");
    expect(summary.facts).toContainEqual({ label: "Changes waiting to send", value: "4" });
    expect(summary.details).toContainEqual({ label: "Position in the shared history", value: "cur-9" });
    expect(summary.details).toContainEqual({ label: "History generation", value: "2" });
    expect(summary.facts.map((f) => f.value)).not.toContain("cur-9");
  });

  it("automatic mode says it syncs automatically, because the two consents are different things", () => {
    const summary = syncSummary(connected({ state: "automatic", mode: "automatic", auto: true }))!;
    expect(summary.pill).toBe("Synced");
    expect(summary.tone).toBe("on_track");
    expect(summary.headline).toContain("automatically");
    expect(summary.details).toContainEqual({ label: "Sync mode", value: "automatic" });
  });

  it("shows a failure with its remedy", () => {
    const summary = syncSummary(
      connected({
        state: "revoked",
        failure: {
          code: "revoked",
          summary: "The service says this device was revoked.",
          remedy: "Re-enrol this machine with `staple cloud connect`.",
        },
      }),
    )!;
    expect(summary.pill).toBe("Sync stopped");
    expect(summary.tone).toBe("at_risk");
    expect(summary.headline).toContain("revoked");
    expect(summary.headline).toContain("Re-enrol");
  });

  it("reports offline without claiming local work is affected", () => {
    const summary = syncSummary(
      connected({
        state: "offline",
        failure: {
          code: "offline",
          summary: "The endpoint could not be reached. Local work is unaffected.",
          remedy: "Run `staple cloud sync` again once this machine has a network.",
        },
      }),
    )!;
    expect(summary.pill).toBe("Offline");
    expect(summary.tone).toBe("tight");
    expect(everything(summary)).toContain("Local work is unaffected");
  });

  it("surfaces open conflicts once connected", () => {
    const summary = syncSummary(connected({ conflicts: { open: 2, resolved: 0 } }))!;
    expect(summary.pill).toBe("2 conflicts");
    expect(summary.facts).toContainEqual({ label: "Conflicts to resolve", value: "2" });
  });

  it("on a phone the pill is a 44px icon whose words are its accessible name", () => {
    const rendered = renderToStaticMarkup(<CloudStrip report={connected()} compact />);
    expect(rendered).toContain('aria-label="Sync: Manual sync. Show sync details"');
    expect(rendered).toContain("size-11");
    expect(rendered).not.toContain(">Manual sync<");
  });
});

describe("All workspaces counts the workspaces that sync, and says nothing when none do", () => {
  const hub = (connected: number, total: number): HubCloudReport =>
    ({ workspaces: [], counts: { total, connected, disconnected: total - connected, skipped: 0, actionable: total, automatic: connected } }) as unknown as HubCloudReport;

  it("renders nothing for a hub with no connected workspace", () => {
    expect(hubSyncSummary(hub(0, 8))).toBeNull();
    expect(renderToStaticMarkup(<CloudStrip report={null} hub={hub(0, 8)} />)).toBe("");
  });

  it("counts, and never presents one workspace's state as the hub's", () => {
    const summary = hubSyncSummary(hub(3, 8))!;
    expect(summary.pill).toBe("3 of 8 syncing");
    expect(summary.headline).toContain("Pick a workspace");
    // A per-workspace report always wins over the hub summary.
    expect(renderToStaticMarkup(<CloudStrip report={connected()} hub={hub(3, 8)} />)).toContain("Manual sync");
  });
});

describe("the last sync is said the way a person says it", () => {
  const NOW = Date.parse("2026-09-26T12:00:00Z");

  it("reads '5 min ago' in the card, and keeps the exact time under Show details", () => {
    const summary = syncSummary(connected({ lastSyncAt: "2026-09-26T11:55:00Z" }), NOW)!;
    expect(summary.facts).toContainEqual({ label: "Last synced", value: "5 min ago" });
    expect(summary.details).toContainEqual({ label: "Last synced at", value: "2026-09-26T11:55:00Z" });
    // Never the raw timestamp among the facts a person acts on.
    expect(summary.facts.some((fact) => fact.value.includes("2026-"))).toBe(false);
  });

  it("says hours and days, and 'Just now' for a sync seconds ago", () => {
    expect(syncedAgo("2026-09-26T09:00:00Z", NOW)).toBe("3h ago");
    expect(syncedAgo("2026-09-24T12:00:00Z", NOW)).toBe("2 days ago");
    expect(syncedAgo("2026-09-26T11:59:40Z", NOW)).toBe("Just now");
    expect(syncedAgo("not a time", NOW)).toBeNull();
  });
});
