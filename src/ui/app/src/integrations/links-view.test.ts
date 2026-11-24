import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../../../../core/integrations/contracts";
import type { ConnectionView } from "./connection-status";
import {
  connectionNotices,
  countWords,
  filterCounts,
  isRefreshable,
  oldestRefresh,
  openLabel,
  refreshFailure,
  stackIndent,
} from "./links-view";
import type { ExternalLink } from "./model";

function link(n: number, kind: "issue" | "pull_request" = "pull_request", provider: "github" | "linear" = "github", fetchedAt: string | null = "2026-11-24T10:00:00Z"): ExternalLink {
  const github = provider === "github";
  return {
    id: `link-${n}`,
    issueId: "local",
    parentResourceId: null,
    parentMissing: false,
    position: 0,
    createdBy: "tester",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    resource: {
      id: `resource-${n}`,
      ref: {
        providerId: provider,
        host: github ? "github.com" : "linear.app",
        scopeId: github ? "host" : "org-1",
        containerId: github ? "42" : "team-uuid",
        id: String(n),
        kind,
      },
      key: github ? `team/repo#${n}` : `ENG-${n}`,
      url: "https://example.test",
      title: `Source ${n}`,
      body: null,
      status: { id: "open", name: "Open" },
      fetchedAt,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      contextShared: false,
    },
  };
}

function connection(provider: "github" | "linear", state: ConnectionState | null, message: string | null = null): ConnectionView {
  const base = provider === "github"
    ? { id: "gh", providerId: "github" as const, mode: "cli" as const, host: "github.com", account: "octo" }
    : { id: "lin", providerId: "linear" as const, mode: "api" as const, host: "linear.app" as const, account: "a", scopeId: "org-1", credentialEnv: "LINEAR_KEY" };
  return {
    ...base,
    health: state
      ? { connectionId: base.id, state, message, action: null, identity: null, checkedAt: "2026-11-24T10:00:00Z", retryAfterSeconds: null }
      : null,
  } as ConnectionView;
}

describe("links tab view logic", () => {
  it("counts all, issues and pull requests for the filter", () => {
    const links = [link(1, "issue"), link(2, "issue"), ...[3, 4, 5, 6, 7, 8].map((n) => link(n))];
    expect(filterCounts(links)).toEqual({ all: 8, issue: 2, pull_request: 6 });
  });

  it("says a group's count in words", () => {
    expect(countWords([link(1), link(2), link(3), link(4), link(5), link(6)])).toBe("6 pull requests");
    expect(countWords([link(1, "issue")])).toBe("1 issue");
    expect(countWords([link(1, "issue"), link(2, "issue"), link(3), link(4), link(5)])).toBe("2 issues, 3 pull requests");
    expect(countWords([link(1)])).toBe("1 pull request");
  });

  it("refreshes a link only through a ready connection for its provider, host and Linear scope", () => {
    expect(isRefreshable(link(1), [connection("github", "ready")])).toBe(true);
    expect(isRefreshable(link(1), [connection("github", "unauthenticated")])).toBe(false);
    expect(isRefreshable(link(1), [connection("github", null)])).toBe(false);
    expect(isRefreshable(link(1), [connection("linear", "ready")])).toBe(false);
    expect(isRefreshable(link(1, "issue", "linear"), [connection("linear", "ready")])).toBe(true);
    const otherOrg = { ...connection("linear", "ready"), scopeId: "org-2" } as ConnectionView;
    expect(isRefreshable(link(1, "issue", "linear"), [otherOrg])).toBe(false);
  });

  it("words one notice per provider and host that cannot refresh, from the connection's state", () => {
    const links = [link(1), link(2), link(3, "issue", "linear")];
    expect(connectionNotices(links, [])).toEqual([
      { key: "github github.com", providerId: "github", text: "GitHub isn't connected on this computer." },
      { key: "linear linear.app", providerId: "linear", text: "Linear isn't connected on this computer." },
    ]);
    expect(connectionNotices(links, [connection("github", "unauthenticated", "GitHub needs sign-in on this computer."), connection("linear", "ready")])).toEqual([
      { key: "github github.com", providerId: "github", text: "GitHub needs sign-in on this computer." },
    ]);
    expect(connectionNotices([link(1)], [connection("github", "forbidden")])[0]?.text).toBe("GitHub: No access.");
    expect(connectionNotices([link(1)], [connection("github", "unavailable", "Set the API key on this machine")])[0]?.text).toBe("Set the API key on this machine.");
    expect(connectionNotices(links, [connection("github", "ready"), connection("linear", "ready")])).toEqual([]);
  });

  it("dates the toolbar by the oldest saved copy among refreshable links", () => {
    const links = [
      link(1, "pull_request", "github", "2026-11-24T10:00:00Z"),
      link(2, "pull_request", "github", "2026-11-24T09:00:00Z"),
      link(3, "issue", "linear", "2026-11-01T00:00:00Z"),
      link(4, "pull_request", "github", null),
    ];
    expect(oldestRefresh(links, [connection("github", "ready")])?.resource.fetchedAt).toBe("2026-11-24T09:00:00Z");
    expect(oldestRefresh(links, [])).toBeNull();
    expect(oldestRefresh([link(4, "pull_request", "github", null)], [connection("github", "ready")])).toBeNull();
  });

  it("reports a refresh-all failure in one line", () => {
    expect(refreshFailure([], 8)).toBeNull();
    expect(refreshFailure(["rate limited", "gone"], 8)).toBe("2 of 8 could not be refreshed: rate limited");
  });

  it("names the way out to the provider", () => {
    expect(openLabel("github")).toBe("Open on GitHub");
    expect(openLabel("linear")).toBe("Open in Linear");
  });

  it("indents a stack by depth, capped at three levels", () => {
    expect([0, 1, 2, 3, 4, 7].map(stackIndent)).toEqual([0, 1, 2, 3, 3, 3]);
  });
});
