/**
 * The pieces every pull request surface shares: the checks mark, the tally, the list and its
 * card. Rendered to a string, so what is asserted is which elements exist and what their
 * accessible names say.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChecksMark, PullRequestCard, PullRequestList, PullRequestTally, TicketButtons } from "./PullRequestParts";
import { tallyOf, type PullRequestEntry } from "./pull-requests";
import { prTicket } from "./pull-request-fixture";

const entry = (n: number, patch: Partial<PullRequestEntry> = {}): PullRequestEntry => ({
  id: `e${n}`,
  key: `acme/shop#${n}`,
  url: `https://github.com/acme/shop/pull/${n}`,
  title: `Change ${n}`,
  state: "open",
  checks: null,
  failing: [],
  own: false,
  tickets: [],
  ...patch,
});

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const attrs = (html: string, name: string) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1]);

describe("ChecksMark", () => {
  it("draws a failing and a pending mark, decorative, and nothing for passing or unread", () => {
    const failing = render(<ChecksMark checks="failing" />);
    expect(failing).toContain('data-checks="failing"');
    expect(failing).toContain('aria-hidden="true"');
    expect(failing).toContain("lucide-circle-x");
    const pending = render(<ChecksMark checks="pending" />);
    expect(pending).toContain('data-checks="pending"');
    expect(pending).toContain("lucide-circle-dashed");
    for (const checks of ["passing", null, undefined] as const) expect(render(<ChecksMark checks={checks} />)).toBe("");
  });
});

describe("PullRequestTally", () => {
  const tally = tallyOf([
    entry(1, { state: "merged" }),
    entry(2, { checks: "failing" }),
    entry(3, { state: "draft" }),
    entry(4),
    entry(5, { state: "closed" }),
    entry(6, { state: "unknown" }),
  ]);

  it("draws one segment per state present, trouble first, each with its count and words", () => {
    const html = render(<PullRequestTally tally={tally} />);
    expect(html).toContain('data-pr-tally=""');
    expect(html).toMatch(/^<span aria-hidden="true"/);
    expect(attrs(html, "data-pr-segment")).toEqual(["failing", "open", "draft", "merged", "closed", "unknown"]);
    expect(attrs(html, "title")).toEqual(["1 with failing checks", "2 open", "1 draft", "1 merged", "1 closed", "1 state unknown"]);
    const counts = [...html.matchAll(/data-pr-segment="(\w+)"[^>]*>(?:(?!<\/span><\/span>).)*?<span>(\d+)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(counts).toEqual([
      ["failing", "1"],
      ["open", "2"],
      ["draft", "1"],
      ["merged", "1"],
      ["closed", "1"],
      ["unknown", "1"],
    ]);
  });

  it("leaves out a state with none", () => {
    const html = render(<PullRequestTally tally={tallyOf([entry(1), entry(2, { state: "merged" })])} />);
    expect(attrs(html, "data-pr-segment")).toEqual(["open", "merged"]);
  });

  it("folds to the leading state's glyph and the total, keeping the failing mark", () => {
    const folded = render(<PullRequestTally tally={tally} fold />);
    expect(folded).toContain('data-pr-tally="folded"');
    expect(folded).not.toContain("data-pr-segment");
    expect(folded).toContain("<span>6</span>");
    // The lead is the first state after failing: open, not the failing mark.
    expect(attrs(folded, "data-link-tone")).toEqual(["open"]);
    expect(folded).toContain("lucide-circle-x");

    const quiet = render(<PullRequestTally tally={tallyOf([entry(1, { state: "merged" }), entry(2, { state: "closed" })])} fold />);
    expect(attrs(quiet, "data-link-tone")).toEqual(["merged"]);
    expect(quiet).not.toContain("lucide-circle-x");
  });
});

describe("TicketButtons", () => {
  it("names each ticket as a button that opens it, and draws nothing for none", () => {
    const html = render(<TicketButtons workspace="w" tickets={[prTicket("ACME-2"), { id: "x", identifier: "ACME-3", title: "" }]} />);
    expect(attrs(html, "data-pr-ticket")).toEqual(["ACME-2", "ACME-3"]);
    expect(attrs(html, "aria-label")).toEqual(["Open ACME-2, Task ACME-2", "Open ACME-3"]);
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(render(<TicketButtons workspace="w" tickets={[]} />)).toBe("");
  });
});

describe("PullRequestList", () => {
  const P = prTicket("ACME-P", null);
  const A = prTicket("ACME-A", "id-ACME-A");
  const entries = [
    entry(1, { state: "merged", tickets: [A] }),
    entry(2, { tickets: [P, A] }),
    entry(88, { key: "acme/admin#88", url: "https://github.com/acme/admin/pull/88", checks: "failing", failing: ["unit"], tickets: [A] }),
    entry(3, { state: "draft", checks: "pending", title: null, tickets: [A] }),
  ];
  const html = render(<PullRequestList entries={entries} workspace="w" shownId="id-ACME-P" />);
  const rows = html.split("<li ").slice(1);

  it("lists the ones that need a person first", () => {
    expect(attrs(html, "data-pr-row")).toEqual(["acme/admin#88", "acme/shop#2", "acme/shop#3", "acme/shop#1"]);
    expect(attrs(html, "data-pr-state")).toEqual(["open", "open", "draft", "merged"]);
  });

  it("shows short keys: the repository most are in unsaid, a stray by its repository", () => {
    const keys = rows.map((row) => /tabular-nums">([^<]+)<\/span><\/a>/.exec(row)?.[1]);
    expect(keys).toEqual(["admin#88", "#2", "#3", "#1"]);
  });

  it("never names the ticket shown back to itself", () => {
    expect(rows[1]).toContain('data-pr-ticket="ACME-A"');
    expect(rows[1]).not.toContain('data-pr-ticket="ACME-P"');
    expect(html).not.toContain('data-pr-ticket="ACME-P"');
  });

  it("names each link by key, title, state and the checks that need a look", () => {
    const links = [...html.matchAll(/<a [^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(links).toEqual(["acme/admin#88, Change 88, open, checks failing: unit", "acme/shop#2, Change 2, open", "acme/shop#3, draft, checks pending", "acme/shop#1, Change 1, merged"]);
    expect(rows[0]).toContain('data-checks="failing"');
    expect(rows[2]).toContain('data-checks="pending"');
    expect(rows[2]).toMatch(/truncate">acme\/shop#3</);
    expect(html).toContain('href="https://github.com/acme/admin/pull/88"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe("PullRequestCard", () => {
  const entries = [entry(1, { state: "merged" }), entry(2, { checks: "failing" }), entry(3)];
  const html = render(<PullRequestCard heading="3 in tasks inside" entries={entries} workspace="w" shownId="p" onShowAll={() => {}} />);

  it("heads the list with what it is and the tally, read out in words", () => {
    expect(html).toContain('data-link-card="pull-requests"');
    expect(html).toMatch(/font-medium text-foreground">3 in tasks inside<\/span>/);
    expect(html).toContain('<span class="sr-only">3 pull requests: 1 with failing checks, 2 open, 1 merged</span>');
    expect(html).toContain('data-pr-tally=""');
  });

  it("lists every entry and offers the way to all of them", () => {
    expect(attrs(html, "data-pr-row")).toEqual(["acme/shop#2", "acme/shop#3", "acme/shop#1"]);
    expect(html).toMatch(/<button type="button"[^>]*>Show in External links<\/button>/);
  });
});
