import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionState } from "../../../../core/integrations/contracts";
import { ExternalLinksView, type ExternalLinksViewProps } from "@/detail/tabs/ExternalLinksTab";
import type { ConnectionView } from "./connection-status";
import { LinkRow } from "./LinkList";
import type { ExternalLink } from "./model";

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
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>All<span[^>]*>8<\/span><\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Issues<span[^>]*>2<\/span><\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Pull requests<span[^>]*>6<\/span><\/button>/);

    const split = [link(1, { kind: "issue", repo: "acme/docs" }), link(2, { repo: "acme/api" })];
    const issues = view({ links: split, section: "issue" });
    expect(issues).toContain("acme/docs");
    expect(issues).not.toContain("acme/api");
    expect(issues).toMatch(/aria-pressed="true"[^>]*>Issues/);
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
    expect(html).toContain("Refreshed 1 hr ago");
    expect(html).toContain('aria-label="Refresh all"');
    expect(html).toMatch(/<button[^>]*>.*Link<\/button>/);
    expect(view({ links: [link(1, { fetchedAt: null })] })).not.toContain("Refreshed");
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

  it("offers Stacked on for a pull request and names a parent that is not linked here", () => {
    const child = link(2, { parent: "resource-elsewhere" });
    const html = row(child, { open: true, links: [link(1), child] });
    expect(html).toContain("Stacked on");
    expect(html).toContain("Parent not linked here");
    const root = row(link(1), { open: true });
    expect(root).toMatch(/Stacked on[\s\S]*Nothing/);
  });
});
