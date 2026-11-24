import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionHealthSnapshot } from "../../../../core/integrations/contracts";
import { checkedAgo, connectionStatus, mergeHealth, oldestCheck, type ConnectionView } from "./connection-status";
import { containerLabel, leadingTone, linkTone, savedAge, shortKey, stateLabel } from "./link-state";
import type { ExternalResource } from "./model";
import { ConnectionStatusPill, ItemGlyph, LinkStatePill, ProviderMark } from "./parts";

function resource(over: Partial<ExternalResource> & { kind?: "issue" | "pull_request"; providerId?: string } = {}): ExternalResource {
  const { kind = "pull_request", providerId = "github", ...rest } = over;
  return {
    id: "r1",
    ref: { providerId, host: providerId === "github" ? "github.com" : "linear.app", scopeId: "host", containerId: "42", id: "218", kind },
    key: "team/repo#218",
    url: "https://github.com/team/repo/pull/218",
    title: "A change",
    body: null,
    status: { id: "open", name: "open" },
    fetchedAt: "2026-11-24T12:00:00Z",
    createdAt: "2026-11-24T12:00:00Z",
    updatedAt: "2026-11-24T12:00:00Z",
    contextShared: false,
    ...rest,
  };
}
const NOW = Date.parse("2026-11-24T12:02:30Z");

describe("how a link reads", () => {
  it("gives GitHub states their own tone and leaves an unknown provider state neutral", () => {
    expect(linkTone(resource())).toBe("open");
    expect(linkTone(resource({ status: { id: "merged", name: "merged" } }))).toBe("merged");
    expect(linkTone(resource({ status: { id: "closed", name: "closed" } }))).toBe("closed");
    expect(linkTone(resource({ status: null }))).toBe("neutral");
    expect(linkTone(resource({ providerId: "linear", status: { id: "abc", name: "In Progress" } }))).toBe("neutral");
  });
  it("uses a provider's workflow category when the server sends one", () => {
    const started = { id: "abc", name: "In Progress", category: "started" } as ExternalResource["status"];
    expect(linkTone(resource({ providerId: "linear", status: started }))).toBe("active");
  });
  it("keeps the provider's word and only capitalises it", () => {
    expect(stateLabel(resource({ status: { id: "merged", name: "merged" } }))).toBe("Merged");
    expect(stateLabel(resource({ status: { id: "x", name: "In Progress" } }))).toBe("In Progress");
    expect(stateLabel(resource({ status: null }))).toBeNull();
  });
  it("shortens a key only as far as it stays unambiguous", () => {
    const a = resource({ key: "team/repo#218" });
    const b = resource({ key: "team/repo#219" });
    const other = resource({ key: "cli/cli#1000" });
    const clash = resource({ key: "fork/repo#7" });
    expect(shortKey(a, [a, b])).toBe("#218");
    expect(shortKey(a, [a, other])).toBe("repo#218");
    expect(shortKey(a, [a, clash])).toBe("team/repo#218");
    expect(shortKey(resource({ key: "ENG-4" }), [a])).toBe("ENG-4");
  });
  it("names the repository or the team key", () => {
    expect(containerLabel(resource())).toBe("team/repo");
    expect(containerLabel(resource({ key: "ENG-4" }))).toBe("ENG");
  });
  it("says how old the saved copy is and flags one older than a day", () => {
    expect(savedAge(resource(), NOW)).toEqual({ short: "2 min", sentence: "Saved copy from 2 min ago", stale: false });
    expect(savedAge(resource({ fetchedAt: "2026-11-22T12:00:00Z" }), NOW)).toMatchObject({ short: "2 d", stale: true });
    expect(savedAge(resource({ fetchedAt: null }), NOW)).toBeNull();
  });
  it("lets a badge wear the tone of its most active link", () => {
    expect(leadingTone(["merged", "closed", "open"])).toBe("open");
    expect(leadingTone(["merged", "closed"])).toBe("merged");
    expect(leadingTone([])).toBe("neutral");
  });
});

const snapshot = (over: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  connectionId: "github", state: "ready", message: null, action: null, identity: { login: "octo" },
  checkedAt: "2026-11-24T12:02:00Z", retryAfterSeconds: null, ...over,
});
const connection = (id: string, health: ConnectionHealthSnapshot | null): ConnectionView =>
  ({ id, providerId: "github", mode: "cli", host: "github.com", account: "octo", health }) as ConnectionView;

describe("how a connection reads", () => {
  it("has a plain phrase for every state, including one nobody has checked", () => {
    expect(connectionStatus(null)).toEqual({ label: "Not checked yet", tone: "idle" });
    expect(connectionStatus(snapshot())).toEqual({ label: "Connected", tone: "ok" });
    expect(connectionStatus(snapshot({ state: "account_mismatch" }))).toEqual({ label: "Wrong account", tone: "bad" });
    expect(connectionStatus(snapshot({ state: "unauthenticated" })).label).toBe("Sign-in needed");
  });
  it("counts a rate limit down in minutes and drops the count once it has passed", () => {
    const limited = snapshot({ state: "rate_limited", retryAfterSeconds: 240 });
    expect(connectionStatus(limited, NOW).label).toBe("Rate limited · 4 min");
    expect(connectionStatus(limited, NOW + 600_000).label).toBe("Rate limited");
  });
  it("folds fresh snapshots in without losing the ones it did not get", () => {
    const held = [connection("github", snapshot()), connection("linear", null)];
    const merged = mergeHealth(held, [snapshot({ connectionId: "linear", state: "offline" })]);
    expect(merged.map((c) => c.health?.state)).toEqual(["ready", "offline"]);
  });
  it("reports the oldest check, and nothing while any connection is unchecked", () => {
    const older = snapshot({ connectionId: "linear", checkedAt: "2026-11-24T12:00:00Z" });
    expect(oldestCheck([connection("github", snapshot()), connection("linear", older)])).toBe("2026-11-24T12:00:00Z");
    expect(oldestCheck([connection("github", snapshot()), connection("linear", null)])).toBeNull();
    expect(checkedAgo("2026-11-24T12:02:00Z", NOW)).toBe("30 s ago");
    expect(checkedAgo("2026-11-24T12:02:28Z", NOW)).toBe("just now");
  });
});

describe("the shared parts", () => {
  it("draws a different shape per state so colour is never the only signal", () => {
    const merged = renderToStaticMarkup(<ItemGlyph item={resource({ status: { id: "merged", name: "merged" } })} />);
    const open = renderToStaticMarkup(<ItemGlyph item={resource()} />);
    expect(merged).toContain('data-link-tone="merged"');
    expect(merged).toContain("lucide-git-merge");
    expect(open).toContain("lucide-git-pull-request");
    expect(renderToStaticMarkup(<ItemGlyph item={resource({ kind: "issue", status: { id: "closed", name: "closed" } })} />)).toContain("lucide-circle-check");
  });
  it("prints the state word in a pill and nothing when there is no state", () => {
    expect(renderToStaticMarkup(<LinkStatePill item={resource({ status: { id: "merged", name: "merged" } })} />)).toContain(">Merged<");
    expect(renderToStaticMarkup(<LinkStatePill item={resource({ status: null })} />)).toBe("");
  });
  it("announces connection status as a status with its word", () => {
    const html = renderToStaticMarkup(<ConnectionStatusPill health={snapshot({ state: "offline" })} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-connection-state="offline"');
    expect(html).toContain("Offline");
  });
  it("marks known providers and falls back to a letter", () => {
    expect(renderToStaticMarkup(<ProviderMark providerId="github" />)).toContain('data-provider="github"');
    expect(renderToStaticMarkup(<ProviderMark providerId="jira" />)).toContain(">j<");
  });
});
