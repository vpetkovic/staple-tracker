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
import { CloudStrip } from "./CloudStrip";
import type { CloudSurfaceReport } from "@/lib/types";

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

describe("a connected workspace reports the values, and only the values", () => {
  it("names the mode, and the device by its human label when it has one", () => {
    const rendered = html(connected());
    expect(rendered).toContain("manual");
    expect(rendered).toContain("laptop");
  });

  /**
   * The label is what a human chose to call this machine, so it wins — but it is
   * optional, and falling back to the opaque id is better than a device row that
   * silently disappears on a connection made without `--label`.
   */
  it("falls back to the device id when no label was given", () => {
    const rendered = html(connected({ label: null }));
    expect(rendered).toContain("device-here");
  });

  it("reports pending, cursor and epoch when there is something to report", () => {
    const rendered = html(connected({ pending: 4, cursor: "cur-9", epoch: 2 }));
    expect(rendered).toContain("4");
    expect(rendered).toContain("cur-9");
  });

  it("automatic mode says automatic, because the two consents are different things", () => {
    expect(html(connected({ state: "automatic", mode: "automatic", auto: true }))).toContain(
      "automatic",
    );
  });

  /**
   * An actionable failure is the one thing that may be loud, and it must carry
   * its remedy — a surface that reported "revoked" without saying what to do
   * would be strictly worse than the silence above.
   */
  it("shows a failure with its remedy", () => {
    const rendered = html(
      connected({
        state: "revoked",
        failure: {
          code: "revoked",
          summary: "The service says this device was revoked.",
          remedy: "Re-enrol this machine with `staple cloud connect`.",
        },
      }),
    );
    expect(rendered).toContain("revoked");
    expect(rendered).toContain("Re-enrol");
  });

  /**
   * Offline is a status, not an emergency. A page that showed an error banner
   * for a train journey would train its reader to ignore the banner.
   */
  it("reports offline without claiming local work is affected", () => {
    const rendered = html(
      connected({
        state: "offline",
        failure: {
          code: "offline",
          summary: "The endpoint could not be reached. Local work is unaffected.",
          remedy: "Run `staple cloud sync` again once this machine has a network.",
        },
      }),
    );
    expect(rendered).toContain("Local work is unaffected");
  });

  it("surfaces open conflicts once connected", () => {
    expect(html(connected({ conflicts: { open: 2, resolved: 0 } }))).toContain("2");
  });
});
