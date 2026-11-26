import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionState } from "../../../../core/integrations/contracts";
import { ExternalLinksView, type ExternalLinksViewProps } from "@/detail/tabs/ExternalLinksTab";
import type { ConnectionView } from "./connection-status";
import { LinkRow } from "./LinkList";
import type { ExternalLink } from "./model";
import { TABS } from "@/detail/tabs/registry";
import { detail } from "@/detail/detail-fixture";
import { descendantEntries, subtreeEntry } from "./pull-requests";
import { prLink, prTicket, subtreePr } from "./pull-request-fixture";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const TEAM_UUID = "0f9c3a52-6d1e-4c1b-9b7e-2a4c8e1d3f55";
const REPO_ID = "987654321";

function link(
  n: number,
  {
    kind = "pull_request",
    provider = "github",
    parent = null,
    fetchedAt = "2026-11-24T11:58:00Z",
    body = null,
    repo = "vpetkovic/staple-tracker",
  }: {
    kind?: "issue" | "pull_request";
    provider?: "github" | "linear";
    parent?: string | null;
    fetchedAt?: string | null;
    body?: string | null;
    repo?: string;
  } = {},
): ExternalLink {
  const github = provider === "github";
  return {
    id: `link-${n}`,
    issueId: "local",
    parentResourceId: parent,
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
        containerId: github ? `${REPO_ID}-${repo}` : TEAM_UUID,
        id: String(n),
        kind,
      },
      key: github ? `${repo}#${n}` : `ENG-${n}`,
      url: github ? `https://github.com/${repo}/pull/${n}` : `https://linear.app/team/issue/ENG-${n}`,
      title: `Source ${n}`,
      body,
      status: { id: "open", name: "Open" },
      fetchedAt,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      contextShared: false,
    },
  };
}

function connection(provider: "github" | "linear", state: ConnectionState | null, message: string | null = null): ConnectionView {
  const base =
    provider === "github"
      ? { id: "gh", providerId: "github" as const, mode: "cli" as const, host: "github.com", account: "octo" }
      : { id: "lin", providerId: "linear" as const, mode: "api" as const, host: "linear.app" as const, account: "a", scopeId: "org-1", credentialEnv: "LINEAR_KEY" };
  return {
    ...base,
    health: state
      ? { connectionId: base.id, state, message, action: null, identity: null, checkedAt: "2026-11-24T10:00:00Z", retryAfterSeconds: null }
      : null,
  } as ConnectionView;
}

const READY = [connection("github", "ready")];

function view(props: Partial<ExternalLinksViewProps> = {}): string {
  return renderToStaticMarkup(
    <ExternalLinksView
      links={[]}
      loading={false}
      loadError={null}
      connections={READY}
      section="all"
      onSection={() => {}}
      onLink={() => {}}
      onOpenSettings={() => {}}
      onWrite={async () => {}}
      refreshAll={{ running: false, error: null, run: () => {} }}
      now={NOW}
      {...props}
    />,
  );
}

function row(target: ExternalLink, props: Partial<Parameters<typeof LinkRow>[0]> = {}): string {
  return renderToStaticMarkup(
    <ul>
      <LinkRow
        link={target}
        peers={[target]}
        links={[target]}
        depth={0}
        guides={[]}
        hasChildren={false}
        refreshWith="gh"
        open={false}
        onOpenChange={() => {}}
        onWrite={async () => {}}
        now={NOW}
        {...props}
      />
    </ul>,
  );
}

/** Text a person can read or hear: content, titles and ARIA names. */
function readable(html: string): string {
  const named = [...html.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]);
  return `${html.replace(/<[^>]*>/g, " ")} ${named.join(" ")}`;
}

const eight = [link(1, { kind: "issue" }), link(2, { kind: "issue" }), ...[3, 4, 5, 6, 7, 8].map((n) => link(n))];

describe("External links tab", () => {
  it("offers a three-way filter with counts that drives which links show", () => {
    const html = view({ links: eight });
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*aria-label="All, 8"/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*aria-label="Issues, 2"/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*aria-label="Pull requests, 6"/);
    // The filter is as wide as its words, never a second tab strip across the panel.
    const filter = /<div[^>]*role="group"[^>]*aria-label="Show"[^>]*>/.exec(html)![0];
    expect(filter).not.toMatch(/\bw-full\b/);
    expect(filter).not.toMatch(/\bflex-1\b/);

    const split = [link(1, { kind: "issue", repo: "acme/docs" }), link(2, { repo: "acme/api" })];
    const issues = view({ links: split, section: "issue" });
    expect(issues).toContain("acme/docs");
    expect(issues).not.toContain("acme/api");
    expect(issues).toMatch(/aria-pressed="true"[^>]*aria-label="Issues, 1"/);
  });

  it("names groups for the repository or team, with no UUID or numeric id on screen", () => {
    const linear = { ...link(30, { kind: "issue", provider: "linear" }) };
    linear.resource = { ...linear.resource, id: TEAM_UUID.replace("0f9c", "1a2b") };
    const html = view({ links: [...[3, 4, 5, 6, 7, 8].map((n) => link(n)), linear] });
    expect(html).toMatch(/>vpetkovic\/staple-tracker<\/span>/);
    expect(html).toContain("6 pull requests");
    expect(html).toMatch(/>ENG<\/span>/);
    expect(html).toMatch(/>Linear<\/span>/);
    expect(html).toContain("1 issue");
    expect(html).not.toContain(TEAM_UUID);
    expect(html).not.toContain(REPO_ID);
    const screen = readable(html.replace(/data-external-resource="[^"]*"/g, ""));
    expect(screen).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(screen).not.toMatch(/\bgithub\.com\b|\blinear\.app\b|\bgithub ·/);
  });

  it("draws a row with its title, short key, state, age and named actions", () => {
    const target = link(218);
    const html = view({ links: [target, link(219)] });
    expect(html).toContain('data-external-resource="resource-218"');
    expect(html).toContain('title="Source 218"');
    expect(html).toMatch(/>#218</);
    expect(html).toMatch(/data-link-state="open"[^>]*>Open</);
    expect(html).toMatch(/>2 min</);
    expect(html).toContain('aria-label="Refresh vpetkovic/staple-tracker#218"');
    expect(html).toContain('aria-label="Open vpetkovic/staple-tracker#218 on GitHub"');
    expect(html).toContain('href="https://github.com/vpetkovic/staple-tracker/pull/218"');
    expect(html).toContain('aria-label="More actions for vpetkovic/staple-tracker#218"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);

    const offline = view({ links: [target], connections: [connection("github", "unauthenticated")] });
    expect(offline).not.toContain("Refresh vpetkovic/staple-tracker#218");
    expect(offline).toContain('aria-label="More actions for vpetkovic/staple-tracker#218"');
  });

  it("shows a never-read link with an em dash and a stale one in amber with its sentence", () => {
    const html = view({ links: [link(1, { fetchedAt: null }), link(2, { fetchedAt: "2026-11-20T12:00:00Z" })] });
    expect(html).toMatch(/data-saved-age="none"[^>]*>—</);
    expect(html).toMatch(/data-saved-age="stale"[^>]*title="Saved copy from 4 d ago"[^>]*>4 d</);
  });

  it("renders stacks as indented rows in the same list, capped at three indent levels", () => {
    const chain = [link(1), link(2, { parent: "resource-1" }), link(3, { parent: "resource-2" }), link(4, { parent: "resource-3" }), link(5, { parent: "resource-4" })];
    const html = view({ links: [...chain, link(9)] });
    const depths = [...html.matchAll(/data-pr-depth="(\d)" data-indent="(\d)"/g)].map((m) => [m[1], m[2]]);
    expect(depths).toEqual([
      ["0", "0"],
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["4", "3"],
      ["0", "0"],
    ]);
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html).not.toMatch(/without a recorded parent|Stack ·/i);
    expect(html).toContain('data-guide="elbow"');
  });

  it("puts issues first within a group", () => {
    const html = view({ links: [link(5), link(1, { kind: "issue" })] });
    expect(html.indexOf("resource-1")).toBeLessThan(html.indexOf("resource-5"));
  });

  it("raises one notice per provider that cannot refresh, and none while connections load", () => {
    const links = [link(1), link(2, { kind: "issue", provider: "linear" })];
    const missing = view({ links, connections: [connection("linear", "ready")] });
    expect(missing).toContain("GitHub isn&#x27;t connected on this computer.");
    expect(missing).toContain("These are saved copies and can&#x27;t be refreshed until it is fixed.");
    expect(missing).toMatch(/<button[^>]*>Open Integrations<\/button>/);
    expect(missing.match(/data-connection-notice/g)).toHaveLength(1);

    const signIn = view({ links, connections: [connection("github", "unauthenticated", "GitHub needs sign-in on this computer."), connection("linear", "ready")] });
    expect(signIn).toContain("GitHub needs sign-in on this computer.");

    expect(view({ links, connections: [connection("github", "ready"), connection("linear", "ready")] })).not.toContain("data-connection-notice");
    expect(view({ links, connections: null })).not.toContain("data-connection-notice");
  });

  it("dates the toolbar by the oldest refreshable saved copy and offers Refresh all and Link", () => {
    const html = view({ links: [link(1), link(2, { fetchedAt: "2026-11-24T11:00:00Z" })] });
    // One control says when the copies were read and reads them again: the age is the button's own text.
    expect(html).toMatch(/<button[^>]*aria-label="Refresh all\. Refreshed 1 hr ago"[^>]*>(?:(?!<\/button>).)*Refreshed 1 hr ago(?:(?!<\/button>).)*<\/button>/);
    expect(html).toMatch(/<button[^>]*>.*Link<\/button>/);
    const unread = view({ links: [link(1, { fetchedAt: null })] });
    expect(unread).not.toContain("Refreshed");
    expect(unread).toContain('aria-label="Refresh all"');
    const running = view({ links: [link(1)], refreshAll: { running: true, error: null, run: () => {} } });
    expect(running).toContain("Refreshing…");
    const failed = view({ links: [link(1)], refreshAll: { running: false, error: "2 of 8 could not be refreshed: gone", run: () => {} } });
    expect(failed).toContain("2 of 8 could not be refreshed: gone");
  });

  it("uses no native select, details or checkbox", () => {
    const html = view({ links: eight }) + row(link(1, { kind: "issue", body: "Body" }), { open: true });
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<details");
    expect(html).not.toContain('type="checkbox"');
  });

  it("shows skeleton rows while loading, an empty frame with Link, and filtered-empty words", () => {
    const loading = view({ loading: true });
    expect(loading).toContain('data-slot="skeleton"');
    expect(loading).not.toContain("Loading");
    const empty = view();
    expect(empty).toContain("Nothing linked yet. Link an issue or pull request to keep it beside this task.");
    expect(empty).toContain("border-dashed");
    expect(view({ links: [link(1)], section: "issue" })).toContain("No linked issues");
    expect(view({ links: [link(1, { kind: "issue" })], section: "pull_request" })).toContain("No linked pull requests");
  });
});

describe("a parent's External links tab", () => {
  const P = prTicket("ACME-P", null);
  const A = prTicket("ACME-A", "id-ACME-A");
  const B = prTicket("ACME-B", "id-ACME-B");
  const B1 = prTicket("ACME-B1", "id-ACME-B");
  const set = [
    subtreePr(218, { repo: "vpetkovic/staple-tracker", own: true, tickets: [P, A] }),
    subtreePr(1, { state: "merged", tickets: [A] }),
    subtreePr(2, { tickets: [B, B1] }),
    subtreePr(3, { state: "draft", tickets: [B1] }),
    subtreePr(88, { repo: "acme/admin", checks: "failing", failing: ["unit"], tickets: [A, B, B1, prTicket("ACME-C", "id-ACME-C")] }),
  ];
  const inside = descendantEntries(set.map(subtreeEntry));
  const subtree = { entries: inside, workspace: "w", shownId: "id-ACME-P" };
  const rows = (html: string) => [...html.matchAll(/data-subtree-link="([^"]*)"/g)].map((m) => m[1]);

  it("lists the descendants' pull requests after its own links, the ones that need a person first", () => {
    const html = view({ links: [link(218), link(5, { kind: "issue" })], subtree });
    expect(html.match(/data-subtree-links=""/g)).toHaveLength(1);
    expect(html.indexOf("resource-218")).toBeLessThan(html.indexOf("data-subtree-links"));
    expect(rows(html)).toEqual(["acme/admin#88", "acme/shop#2", "acme/shop#3", "acme/shop#1"]);
    expect(html).toMatch(/<section[^>]*aria-label="In tasks inside: 4 pull requests: 1 with failing checks, 2 open, 1 draft, 1 merged"/);
    expect(html).toMatch(/<h3[^>]*>.*?In tasks inside.*?data-pr-tally="".*?4 pull requests<\/span><\/h3>/);
    // The parent's own pull request is drawn among its links, never again in the section.
    expect(rows(html)).not.toContain("vpetkovic/staple-tracker#218");
  });

  it("gives each row its checks, its state and its tickets as buttons, never the parent", () => {
    const html = view({ links: [], subtree });
    const row = (key: string) => new RegExp(`data-subtree-link="${key.replace(/[/#]/g, "\\$&")}".*?</li>`).exec(html)![0];
    expect(row("acme/admin#88")).toContain('aria-label="Open acme/admin#88, Change 88, open, checks failing: unit"');
    expect(row("acme/admin#88")).toContain('data-checks="failing"');
    // Three tickets are named, the fourth counted.
    expect([...row("acme/admin#88").matchAll(/data-pr-ticket="([^"]*)"/g)].map((m) => m[1])).toEqual(["ACME-A", "ACME-B", "ACME-B1"]);
    expect(row("acme/admin#88")).toMatch(/title="ACME-C"[^>]*>\+1</);
    expect(row("acme/shop#2")).toContain('data-pr-ticket="ACME-B"');
    expect(html).not.toContain('data-pr-ticket="ACME-P"');
    expect(row("acme/shop#1")).toMatch(/data-link-state="merged"/);
    // The repository most are in goes unsaid; the stray keeps its repository.
    expect(row("acme/shop#2")).toMatch(/tabular-nums[^"]*">#2</);
    expect(row("acme/admin#88")).toMatch(/tabular-nums[^"]*">admin#88</);
  });

  it("counts the descendants' pull requests under All and Pull requests, and not under Issues", () => {
    const html = view({ links: [link(218), link(5, { kind: "issue" })], subtree });
    expect(html).toMatch(/aria-label="All, 6"/);
    expect(html).toMatch(/aria-label="Issues, 1"/);
    expect(html).toMatch(/aria-label="Pull requests, 5"/);
  });

  it("keeps the section under Pull requests and hides it under Issues", () => {
    const prs = view({ links: [link(218), link(5, { kind: "issue" })], subtree, section: "pull_request" });
    expect(prs).toContain("data-subtree-links");
    expect(prs).not.toContain("resource-5");
    const issues = view({ links: [link(218), link(5, { kind: "issue" })], subtree, section: "issue" });
    expect(issues).not.toContain("data-subtree-links");
    expect(issues).toContain("resource-5");
    const noIssues = view({ links: [link(218)], subtree, section: "issue" });
    expect(noIssues).toContain("No linked issues");
    expect(view({ links: [], subtree, section: "issue" })).toContain("No linked issues");
  });

  it("shows the empty state only with neither own links nor descendants'", () => {
    const onlyInside = view({ links: [], subtree });
    expect(onlyInside).not.toContain("Nothing linked yet");
    expect(onlyInside).toContain("data-subtree-links");
    expect(onlyInside).not.toContain("No linked");
    expect(view({ links: [], subtree: { ...subtree, entries: [] } })).toContain("Nothing linked yet");
  });

  it("counts own links plus descendant-only pull requests on the tab in the strip", () => {
    const count = TABS.find((tab) => tab.id === "external-links")!.count!;
    expect(count(detail({ externalLinks: [link(218), link(5, { kind: "issue" })], subtreePullRequests: set }))).toBe(6);
    expect(count(detail({ externalLinks: [], subtreePullRequests: set }))).toBe(4);
    expect(count(detail({ externalLinks: [link(218)] }))).toBe(1);
    expect(count(detail({ externalLinks: [] }))).toBeNull();
  });
});

describe("an open link row", () => {
  it("shows the description, the sharing switch, the saved copy age, Unlink and the way out", () => {
    const html = row(link(1, { kind: "issue", body: "## Summary\n\n- Line one\n- Line two" }), { open: true });
    expect(html).toMatch(/aria-expanded="true"/);
    // The description is the provider's markdown, read as markdown: no literal "##" or "- ".
    expect(html).toMatch(/<p class="[^"]*font-semibold[^"]*">Summary<\/p>/);
    expect(html).toMatch(/<li[^>]*><span[^>]*>Line one<\/span><\/li>/);
    expect(html).not.toContain("## Summary");
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"/);
    expect(html).toContain("Links always sync. Sharing also sends this title, description and state to everyone in the workspace.");
    expect(html).toMatch(/>2 min ago</);
    expect(html).toMatch(/>Unlink<\/button>/);
    expect(html).toMatch(/<a[^>]*>.*Open on GitHub<\/a>/);
    expect(html).not.toContain("Stacked on");
  });

  it("says when there is no description and when the link was never read", () => {
    expect(row(link(1), { open: true })).toContain("No description");
    expect(row(link(1, { fetchedAt: null }), { open: true })).toContain("Not read yet. Refresh to load it.");
  });

  it("marks a pull request's failing or pending checks on its row and names them when opened", () => {
    const failing = prLink(7, { checks: "failing", failing: ["unit", "lint"] });
    const closed = row(failing);
    expect(closed).toContain('data-checks="failing"');
    expect(closed).toContain('<span class="sr-only">checks failing: unit, lint</span>');
    expect(closed).not.toContain("data-link-checks");
    const opened = row(failing, { open: true });
    expect(opened).toMatch(/>Checks<[\s\S]*data-link-checks="failing"[^>]*>.*?Failing: unit, lint<\/span>/);

    const pending = row(prLink(8, { checks: "pending" }), { open: true });
    expect(pending).toContain('data-checks="pending"');
    expect(pending).toMatch(/data-link-checks="pending"[^>]*>.*?Pending<\/span>/);
  });

  it("keeps a row quiet for passing checks, and says them only when opened", () => {
    const passing = prLink(9, { checks: "passing" });
    const closed = row(passing);
    expect(closed).not.toContain("data-checks");
    expect(closed).not.toContain("sr-only\">checks");
    expect(row(passing, { open: true })).toMatch(/data-link-checks="passing"[^>]*>.*?Passing<\/span>/);
    // Merged: the checks no longer say anything.
    const merged = row(prLink(10, { state: "merged", checks: "failing" }), { open: true });
    expect(merged).not.toContain("data-checks");
    expect(merged).not.toContain("data-link-checks");
    // An issue has no checks fact at all.
    expect(row(link(1, { kind: "issue" }), { open: true })).not.toContain("data-link-checks");
  });

  it("offers Stacked on for a pull request and names a parent that is not linked here", () => {
    const child = link(2, { parent: "resource-elsewhere" });
    const html = row(child, { open: true, links: [link(1), child] });
    expect(html).toContain("Stacked on");
    expect(html).toContain("Parent not linked here");
    const root = row(link(1), { open: true });
    expect(root).toMatch(/Stacked on[\s\S]*Nothing/);
  });
});
