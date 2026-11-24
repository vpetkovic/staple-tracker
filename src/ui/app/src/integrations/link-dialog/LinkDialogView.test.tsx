/**
 * The dialog's body rendered from injected state: what a person sees for each case, and the
 * absence of everything the old dialog had (native selects, checkboxes, storage jargon).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Issue } from "@/lib/types";
import type { MappingTarget, SearchHit, SearchScope } from "../model";
import { groupResults } from "./logic";
import { LinkDialogView, type LinkDialogState } from "./LinkDialogView";

const repo: MappingTarget = {
  key: "github.com/42", providerId: "github", host: "github.com", scopeId: "host", kind: "repository",
  containerId: "42", name: "vpetkovic/staple-tracker", url: null, connectionId: "gh",
};
const scope: SearchScope = { mode: "workspace", workspaces: ["staple"], targets: [repo] };
const target = { id: "t2", identifier: "INT-2", title: "Wire the integration", status: "in_progress" } as Issue;
const other = { id: "t3", identifier: "INT-3", title: "Another task", status: "todo" } as Issue;

function hit(id: string, kind: "issue" | "pull_request" = "issue", associations: Issue[] = []): SearchHit & { targetKey: string } {
  return {
    item: {
      ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id, kind },
      key: `vpetkovic/staple-tracker#${id}`,
      url: `https://github.com/vpetkovic/staple-tracker/${kind === "issue" ? "issues" : "pull"}/${id}`,
      title: `Result ${id}`,
      body: "First line\nSecond line",
      status: { id: "open", name: "open" },
      fetchedAt: new Date().toISOString(),
    },
    associations,
    targetKey: repo.key,
  };
}
const keyOf = (h: SearchHit) => JSON.stringify([h.item.ref.providerId, h.item.ref.host, h.item.ref.scopeId, h.item.ref.containerId, h.item.ref.kind, h.item.ref.id]);

function state(over: Partial<LinkDialogState> = {}, hits = [hit("1"), hit("2", "issue", [other])]): LinkDialogState {
  return {
    workspace: "staple",
    target,
    targetOptions: [],
    workspaceChoices: null,
    text: "",
    kind: "all",
    scope,
    containerKey: null,
    connections: [],
    failures: [],
    groups: groupResults([{ cached: [], remote: hits }], [repo]),
    pasted: false,
    searching: false,
    searchError: null,
    hasMore: false,
    selected: keyOf(hits[0]!),
    page: "results",
    linkedHere: new Set(),
    undoable: new Set(),
    linking: null,
    previewError: null,
    outside: null,
    create: null,
    linkedCount: 0,
    isMac: true,
    ...over,
  };
}
const noop = () => {};
const actions = new Proxy({}, { get: () => noop }) as never;
const render = (s: LinkDialogState) => renderToStaticMarkup(<LinkDialogView state={s} actions={actions} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("link dialog body", () => {
  it("shows the selected result's preview with a Link button naming the target task", () => {
    const html = render(state());
    expect(text(html)).toContain("Link to INT-2");
    expect(text(html)).toContain("Result 1");
    expect(text(html)).toContain("Create task from this");
    expect(html).toContain('href="https://github.com/vpetkovic/staple-tracker/issues/1"');
    expect(text(html)).toContain("Open on GitHub");
  });

  it("shows an item already linked here as Linked to INT-2 with Undo", () => {
    const first = hit("1");
    const html = render(state({ linkedHere: new Set([keyOf(first)]), undoable: new Set([keyOf(first)]) }));
    expect(text(html)).toContain("Linked to INT-2");
    expect(text(html)).toContain("Undo");
    expect(text(html)).toContain("Linked here");
    expect(text(html)).not.toContain("Create task from this");
  });

  it("tags a result linked to another task and lists that task in the preview", () => {
    const second = hit("2", "issue", [other]);
    const html = render(state({ selected: keyOf(second) }));
    expect(text(html)).toContain("Linked to INT-3");
    expect(text(html)).toContain("Also linked to");
    expect(text(html)).toContain("INT-3 · Another task");
  });

  it("offers no Create task for a pull request", () => {
    const pr = hit("5", "pull_request");
    const html = render(state({}, [pr]));
    expect(text(html)).toContain("Link to INT-2");
    expect(text(html)).not.toContain("Create task from this");
  });

  it("asks for a task before linking when there is none", () => {
    const html = render(state({ target: null }));
    expect(text(html)).toContain("Choose a task");
    expect(text(html)).toContain("Choose a task first");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Choose a task first/);
  });

  it("shows the empty state instead of results when nothing is mapped", () => {
    const html = render(state({ scope: { mode: "none", workspaces: [], targets: [] }, groups: [] }));
    expect(text(html)).toContain("Nothing is set up to search yet.");
    expect(text(html)).toContain("You can still paste a link.");
    expect(text(html)).toContain("Choose sources");
    expect(text(html)).toContain("Nothing to search");
  });

  it("shows no preview beside the empty state, even when saved copies matched", () => {
    const html = text(render(state({ scope: { mode: "none", workspaces: [], targets: [] } })));
    expect(html).toContain("Nothing is set up to search yet.");
    expect(html).not.toContain("Result 1");
    expect(html).not.toContain("Link to INT-2");
  });

  it("states the scope it searched", () => {
    expect(text(render(state()))).toContain("staple · 1 source");
  });

  it("heads an empty query's results Recently updated and a pasted link's Matched the pasted link", () => {
    expect(text(render(state()))).toContain("Recently updated");
    const pasted = text(render(state({ text: "https://github.com/vpetkovic/staple-tracker/issues/1", pasted: true })));
    expect(pasted).toContain("Matched the pasted link");
    expect(pasted).not.toContain("Recently updated");
  });

  it("says nothing matched, and how to link anyway", () => {
    const html = text(render(state({ text: "zzz", groups: [] })));
    expect(html).toContain("No issue or pull request matches “zzz”.");
    expect(html).toContain("Paste its URL to link it directly.");
  });

  it("reports a failed source in one line with a way to fix it, keeping the results", () => {
    const html = text(render(state({ failures: [{ connectionId: "gh", targetKeys: [repo.key], state: "unauthenticated", message: "x" }] })));
    expect(html).toContain("GitHub sign-in needed on this computer. Showing saved copies for vpetkovic/staple-tracker.");
    expect(html).toContain("Fix");
    expect(html).toContain("Result 1");
  });

  it("offers to add an outside source and link", () => {
    const html = text(render(state({ previewError: "outside", outside: { ...repo, name: "someone/else" } })));
    expect(html).toContain("someone/else isn't one of staple's sources.");
    expect(html).toContain("Add it and link");
  });

  it("asks before creating when a task may already exist", () => {
    const first = hit("1");
    const html = text(render(state({ create: { key: keyOf(first), phase: "candidates", candidates: [{ issue: other, reasons: ["source-url"] }], truncated: false } })));
    expect(html).toContain("A task for this may already exist:");
    expect(html).toContain("INT-3");
    expect(html).toContain("Create anyway");
    expect(html).toContain("Cancel");
  });

  it("is a listbox the field drives, with the selected option active", () => {
    const html = render(state());
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    const active = /aria-activedescendant="([^"]+)"/.exec(html)?.[1];
    expect(active).toBeTruthy();
    expect(html).toContain(`id="${active}" role="option" aria-selected="true"`);
    expect(html).toContain('placeholder="Search issues and pull requests, or paste a link"');
  });

  it("shows Linking… while a link is in flight and a session count in the footer", () => {
    const first = hit("1");
    const html = text(render(state({ linking: keyOf(first), linkedCount: 2 })));
    expect(html).toContain("Linking…");
    expect(html).toContain("2 linked");
  });

  it("offers more results when a source has another page", () => {
    expect(text(render(state({ hasMore: true })))).toContain("Show more");
    expect(text(render(state()))).not.toContain("Show more");
  });

  it("has no native select, details or checkbox and none of the old phrases", () => {
    for (const html of [render(state()), render(state({ target: null })), render(state({ scope: { mode: "none", workspaces: [], targets: [] }, groups: [] }))]) {
      expect(html).not.toContain("<select");
      expect(html).not.toContain("<details");
      expect(html).not.toContain('type="checkbox"');
      for (const phrase of ["Cached context only", "executable work", "Provider context"]) expect(html).not.toContain(phrase);
    }
  });
});

describe("link dialog refinements", () => {
  it("prints a row's key as short as its group allows, with the whole key one hover away", () => {
    const html = render(state());
    expect(html).toMatch(/title="vpetkovic\/staple-tracker#1">#1</);
    expect(html).not.toMatch(/>vpetkovic\/staple-tracker#1</);
  });
  it("reads the selected result's description as markdown", () => {
    const one = hit("1");
    (one.item as { body: string }).body = "## Summary\n\n- First change";
    const html = render(state({}, [one]));
    expect(html).toMatch(/<p class="[^"]*font-semibold[^"]*">Summary<\/p>/);
    expect(html).not.toContain("## Summary");
  });
  it("says what to do about a source that failed, when the server knows", () => {
    const failure = { connectionId: "gh", targetKeys: [repo.key], state: "unauthenticated" as const, message: "x", action: "Run gh auth login --hostname github.com on the computer running Staple." };
    expect(text(render(state({ failures: [failure] })))).toContain("Run gh auth login --hostname github.com on the computer running Staple.");
  });
});
