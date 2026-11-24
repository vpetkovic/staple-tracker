/**
 * Settings → Integrations, rendered to a string from injected data (no DOM in this suite).
 * Each state of the screen is a value passed to the presentational halves; the fetching
 * container (`IntegrationsSection`) only wires `useConnections` and the mapping read to them.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionHealthSnapshot, ConnectionState, DetectedConnection } from "../../../../../core/integrations/contracts";
import type { Connections } from "@/integrations/useConnections";
import { connectionStatus, type ConnectionView } from "@/integrations/connection-status";
import { ConnectionForm, ConnectionsSection } from "./ConnectionsSection";
import { WorkspacesSection } from "./WorkspacesSection";
import type { MappedTarget, WorkspaceMapping } from "./integrations-model";

const GH_ID = "9f0c2a7e-1111-4111-8111-111111111111";
const LIN_ID = "7a6b5c4d-3333-4333-8333-333333333333";
const LIN_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const LIN_ORG = "22222222-2222-4222-8222-222222222222";
const noop = async () => {};

const health = (state: ConnectionState, over: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  connectionId: GH_ID,
  state,
  message: state === "ready" ? null : `Problem: ${state}.`,
  action: state === "ready" ? null : `Fix ${state}.`,
  identity: null,
  checkedAt: "2026-11-24T12:00:00Z",
  retryAfterSeconds: null,
  ...over,
});
const github = (h: ConnectionHealthSnapshot | null = null, over: Partial<ConnectionView> = {}): ConnectionView =>
  ({ id: GH_ID, providerId: "github", mode: "cli", host: "github.com", account: "octo", health: h, ...over }) as ConnectionView;
const linear = (h: ConnectionHealthSnapshot | null = null): ConnectionView =>
  ({ id: LIN_ID, providerId: "linear", mode: "api", host: "linear.app", account: LIN_ACCOUNT, scopeId: LIN_ORG, credentialEnv: "STAPLE_LINEAR_API_KEY", health: h }) as ConnectionView;

function state(over: Partial<Connections> = {}): Connections {
  return { connections: [], detected: [], loaded: true, checking: null, cachedOnly: false, error: null, refresh: noop, reload: noop, ...over };
}
const connections = (over: Partial<Connections> = {}) =>
  renderToStaticMarkup(<ConnectionsSection state={state(over)} onDirtyChange={() => {}} now={Date.parse("2026-11-24T12:00:40Z")} />);
const NO_NATIVE = /<select|<details|type="checkbox"/;

describe("connections", () => {
  it("renders each state's word on the pill", () => {
    const states: ConnectionState[] = ["ready", "missing_cli", "unsupported_version", "unauthenticated", "account_mismatch", "forbidden", "rate_limited", "offline", "unavailable"];
    for (const s of states) {
      const html = connections({ connections: [github(health(s))] });
      expect(html).toContain(connectionStatus(health(s)).label);
    }
    expect(connections({ connections: [github(null)] })).toContain("Not checked yet");
  });

  it("opens a fix under a failing connection with its message, its action and the command to copy", () => {
    const html = connections({
      connections: [github(health("unauthenticated", { message: "GitHub CLI is not signed in.", action: "Run gh auth login --hostname github.com on the computer running Staple." }))],
    });
    expect(html).toContain("data-connection-fix");
    expect(html).toContain("GitHub CLI is not signed in.");
    expect(html).toContain("Run gh auth login --hostname github.com on the computer running Staple.");
    expect(html).toMatch(/<code[^>]*>gh auth login --hostname github.com<\/code>/);
    expect(html).toContain('aria-label="Copy command"');
    expect(connections({ connections: [github(health("ready"))] })).not.toContain("data-connection-fix");
  });

  it("offers to switch to the signed-in account only when the mismatch knows it", () => {
    expect(connections({ connections: [github(health("account_mismatch", { identity: { login: "other" } }))] })).toContain("Use other instead");
    expect(connections({ connections: [github(health("account_mismatch"))] })).not.toContain("instead");
  });

  it("puts the header strip with its last check and Check now beside the title", () => {
    const html = connections({ connections: [github(health("ready"))] });
    expect(html).toContain("Checked 40 s ago");
    expect(html).toContain('title="Checks itself every 2 minutes while this page is open"');
    expect(connections({ connections: [github(health("ready"))], checking: "all" })).toContain("Checking…");
    expect(connections()).not.toContain("Check now");
  });

  it("offers a detected sign-in in one click, and not once a connection covers it", () => {
    const offered: DetectedConnection = { providerId: "github", host: "github.com", login: "octo", configuredConnectionId: null };
    const html = connections({ detected: [offered] });
    expect(html).toContain("Connect as octo");
    expect(html).toContain("GitHub CLI on this computer is signed in as <strong");
    expect(connections({ detected: [{ ...offered, host: "ghe.acme.io" }] })).toContain(" on ghe.acme.io");
    expect(connections({ connections: [github(health("ready"))], detected: [{ ...offered, configuredConnectionId: GH_ID }] })).not.toContain("Connect as");
  });

  it("renders a payload without detected", () => {
    expect(() => connections({ detected: undefined as unknown as DetectedConnection[] })).not.toThrow();
  });

  it("never prints a UUID, a connection id or an account id", () => {
    const html = connections({ connections: [github(health("ready")), linear(health("unauthenticated", { connectionId: LIN_ID }))] });
    for (const id of [GH_ID, LIN_ID, LIN_ACCOUNT, LIN_ORG]) expect(html).not.toContain(id);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(html).toContain("Linear account · API key in STAPLE_LINEAR_API_KEY");
    expect(html).toContain("octo · through GitHub CLI");
  });

  it("starts an empty computer with a GitHub row, a Linear set-up row and one hint", () => {
    const html = connections();
    expect(html).toContain("Add account");
    expect(html).toContain("Needs a read-only personal API key in this computer&#x27;s environment");
    expect(html).toContain("Set up");
    expect(html).toContain("Links already in your workspaces keep working from their saved copies. A connection adds search and refresh.");
    expect(html).toContain("Add connection");
  });

  it("hides Linear's set-up row once Linear is connected", () => {
    expect(connections({ connections: [linear(health("ready"))] })).not.toContain("Set up");
  });

  it("explains a session that cannot reach providers instead of listing", () => {
    const html = connections({ cachedOnly: true, connections: [github(null)] });
    expect(html).toContain("Connections are managed on the computer that runs Staple. This page can only show saved copies.");
    expect(html).not.toContain("Add connection");
    expect(html).not.toContain("data-connection-row");
  });

  it("shows two skeleton rows while loading and the error with Try again when the read failed", () => {
    expect(connections({ loaded: false }).match(/data-connection-skeleton/g)).toHaveLength(2);
    const failed = connections({ error: "Server unreachable" });
    expect(failed).toContain("Server unreachable");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("Add account");
  });

  it("uses no native select, disclosure or checkbox", () => {
    expect(connections({ connections: [github(health("account_mismatch", { identity: { login: "x" } })), linear(null)] })).not.toMatch(NO_NATIVE);
    expect(connections()).not.toMatch(NO_NATIVE);
  });
});

describe("connection forms", () => {
  const form = (provider: "github" | "linear") =>
    renderToStaticMarkup(<ConnectionForm provider={provider} onCancel={() => {}} onSaved={noop} onDirtyChange={() => {}} />);
  it("asks GitHub for a host and an account, with Save off until both are filled", () => {
    const html = form("github");
    expect(html).toContain(">Host<");
    expect(html).toContain('value="github.com"');
    expect(html).toContain('placeholder="The account gh is signed in as"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save/);
  });
  it("asks Linear for the key variable and the two ids, in plain words", () => {
    const html = form("linear");
    expect(html).toContain(">API key variable<");
    expect(html).toContain('value="STAPLE_LINEAR_API_KEY"');
    expect(html).toContain("Restart Staple after setting it.");
    expect(html).toContain(">Organization ID<");
    expect(html).toContain(">Your user ID<");
    expect(html).toContain("Both are in Linear under Settings → API.");
    expect(html).not.toContain("UUID");
    expect(html).not.toMatch(NO_NATIVE);
  });
});

const target = (over: Partial<MappedTarget> = {}): MappedTarget => ({
  key: "github.com/123456", providerId: "github", host: "github.com", scopeId: "host", kind: "repository",
  containerId: "123456", name: "octo/app", url: null, connectionId: GH_ID, ...over,
});
const workspaces = (rows: WorkspaceMapping[], current = "", cachedOnly = false) =>
  renderToStaticMarkup(
    <WorkspacesSection rows={rows} error={null} onRetry={() => {}} current={current} prefixes={{ alpha: "ALP", beta: "BET", gamma: "GAM" }}
      connections={[github(health("ready"))]} cachedOnly={cachedOnly} onRowChange={() => {}} />,
  );

describe("workspaces", () => {
  it("lists the current workspace first, then alphabetically", () => {
    const html = workspaces([{ workspace: "gamma", targets: [] }, { workspace: "alpha", targets: [] }, { workspace: "beta", targets: [] }], "gamma");
    const order = [...html.matchAll(/data-workspace-row="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["gamma", "alpha", "beta"]);
  });

  it("shows sources as named chips with a remove button each and an Add chip", () => {
    const html = workspaces([{ workspace: "alpha", targets: [target()] }]);
    expect(html).toContain(">octo/app<");
    expect(html).toContain('aria-label="Remove octo/app from alpha"');
    expect(html).toContain('aria-label="Add a source to alpha"');
    expect(html).not.toContain("123456");
  });

  it("falls back for a source with no name and for one no connection here reads", () => {
    const html = workspaces([{ workspace: "alpha", targets: [target({ name: null, key: "github.com/98765432109", connectionId: null })] }]);
    expect(html).toContain(">98765432<");
    expect(html).toContain("Name unavailable until this source is read again");
    expect(html).toContain("No connection on this computer reads this source");
  });

  it("prefixes a project with its kind only beside teams", () => {
    const team = target({ key: "linear.app/o/t", providerId: "linear", kind: "team", name: "Engineering" });
    const project = target({ key: "linear.app/o/project/p", providerId: "linear", kind: "project", name: "Launch" });
    expect(workspaces([{ workspace: "alpha", targets: [team, project] }])).toContain(">Project<");
    expect(workspaces([{ workspace: "alpha", targets: [project] }])).not.toContain(">Project<");
  });

  it("says what a workspace with nothing chosen searches", () => {
    expect(workspaces([{ workspace: "alpha", targets: [] }, { workspace: "beta", targets: [target()] }])).toContain("Searches everything chosen here");
    expect(workspaces([{ workspace: "alpha", targets: [] }])).toContain("Nothing to search yet");
  });

  it("offers no Add chip on a page that cannot read providers, and keeps removal", () => {
    const html = workspaces([{ workspace: "alpha", targets: [target()] }], "", true);
    expect(html).not.toContain("Add a source to alpha");
    expect(html).toContain("Remove octo/app from alpha");
  });

  it("uses no native select, disclosure or checkbox", () => {
    expect(workspaces([{ workspace: "alpha", targets: [target()] }, { workspace: "beta", targets: [] }])).not.toMatch(NO_NATIVE);
  });
});
