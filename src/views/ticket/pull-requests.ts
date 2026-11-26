/**
 * The card's pull requests: a heading with a tally, then the pull requests that need a person
 * first, each a row that asks the host to open it.
 *
 * A parent's card carries `subtreePullRequests` (its own and its descendants', each naming the
 * tickets it is on); a leaf's carries its own `pullRequests`. Both are read defensively: the
 * card may come from an older server without them or a newer one with more, and the view
 * draws what it can read and never throws on the rest.
 */
import { h } from "../shared/runtime.js";

export type PullState = "open" | "draft" | "merged" | "closed" | "unknown";

export interface PullRequestRow {
  key: string;
  url: string | null;
  state: PullState;
  title: string | null;
  checks: { state: "passing" | "failing" | "pending"; failing: string[] } | null;
  /** The tickets it is on, by identifier; null on a leaf's own pull requests. */
  tickets: string[] | null;
  own: boolean;
}

const STATES: readonly PullState[] = ["open", "draft", "merged", "closed"];
const CHECK_STATES = ["passing", "failing", "pending"] as const;
/** Rows drawn before "and N more". */
const MAX_ROWS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function row(entry: unknown): PullRequestRow | null {
  if (!isRecord(entry) || typeof entry.key !== "string" || entry.key === "") return null;
  const checks = isRecord(entry.checks) && CHECK_STATES.includes(entry.checks.state as never) ? entry.checks : null;
  return {
    key: entry.key,
    url: typeof entry.url === "string" && entry.url !== "" ? entry.url : null,
    state: STATES.includes(entry.state as PullState) ? (entry.state as PullState) : "unknown",
    title: typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title : null,
    checks: checks ? { state: checks.state as (typeof CHECK_STATES)[number], failing: strings(checks.failing) } : null,
    tickets: Array.isArray(entry.tickets)
      ? entry.tickets.flatMap((ticket) => (isRecord(ticket) && typeof ticket.identifier === "string" ? [ticket.identifier] : []))
      : null,
    own: entry.own === true,
  };
}

/** The pull requests the card draws: the subtree set on a parent, else the ticket's own. */
export function pullRequestRows(ticket: { subtreePullRequests?: unknown; pullRequests?: unknown }): PullRequestRow[] {
  const set = [ticket.subtreePullRequests, ticket.pullRequests].find((value) => Array.isArray(value) && value.length > 0);
  return Array.isArray(set) ? set.flatMap((entry) => row(entry) ?? []) : [];
}

/** Checks a person has to act on: failing, on a pull request still open or in draft. */
function failingChecks(pr: PullRequestRow): boolean {
  return pr.checks?.state === "failing" && (pr.state === "open" || pr.state === "draft");
}

/** What needs a person first: failing checks, then open, draft, unknown, merged, closed. */
function rank(pr: PullRequestRow): number {
  if (failingChecks(pr)) return 0;
  return { open: 1, draft: 2, unknown: 3, merged: 4, closed: 5 }[pr.state];
}

/**
 * A key as the list shows it, by the web app's rule: the repository most of the pull requests
 * are in goes unsaid (`#405`), and one from another repository keeps the shortest name that
 * tells it apart (`api#4`, or whole when two owners share a repository name). One stray pull
 * request then never puts a prefix on every line. A key without `#` stays as it is.
 */
function shortKey(key: string, keys: readonly string[]): string {
  const container = (k: string) => (k.lastIndexOf("#") > 0 ? k.slice(0, k.lastIndexOf("#")) : k);
  const hash = key.lastIndexOf("#");
  if (hash <= 0) return key;
  const mine = key.slice(0, hash);
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(container(k), (counts.get(container(k)) ?? 0) + 1);
  let home = "";
  let most = 0;
  for (const [c, count] of counts) if (count > most) [home, most] = [c, count];
  if (mine === home) return key.slice(hash);
  const name = (c: string) => c.slice(c.lastIndexOf("/") + 1);
  const sharing = [...counts.keys()].filter((c) => name(c) === name(mine));
  return sharing.length === 1 ? `${name(mine)}${key.slice(hash)}` : key;
}

const SVG = "http://www.w3.org/2000/svg";

/** A lucide icon (24-unit viewBox, 2px stroke in currentColor), from its element list. */
function icon(name: string, parts: ReadonlyArray<[string, Record<string, string>]>, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const attributes: Record<string, string> = {
    class: className,
    "data-icon": name,
    viewBox: "0 0 24 24",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [attribute, value] of Object.entries(attributes)) svg.setAttribute(attribute, value);
  for (const [tag, values] of parts) {
    const element = document.createElementNS(SVG, tag);
    for (const [attribute, value] of Object.entries(values)) element.setAttribute(attribute, value);
    svg.append(element);
  }
  return svg;
}

const CIRCLE_TOP = ["circle", { cx: "6", cy: "6", r: "3" }] as [string, Record<string, string>];
const CIRCLE_BOTTOM = ["circle", { cx: "18", cy: "18", r: "3" }] as [string, Record<string, string>];

/** The shapes the web app draws (lucide-react), so a pull request looks the same in both. */
const GLYPHS: Record<PullState | "failing" | "pending", [string, Array<[string, Record<string, string>]>]> = {
  open: ["git-pull-request", [CIRCLE_BOTTOM, CIRCLE_TOP, ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["line", { x1: "6", x2: "6", y1: "9", y2: "21" }]]],
  // Unread state: the web app's neutral tone draws the open shape, muted.
  unknown: ["git-pull-request", [CIRCLE_BOTTOM, CIRCLE_TOP, ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }], ["line", { x1: "6", x2: "6", y1: "9", y2: "21" }]]],
  draft: [
    "git-pull-request-draft",
    [CIRCLE_BOTTOM, CIRCLE_TOP, ["path", { d: "M18 6V5" }], ["path", { d: "M18 11v-1" }], ["line", { x1: "6", x2: "6", y1: "9", y2: "21" }]],
  ],
  merged: ["git-merge", [CIRCLE_BOTTOM, CIRCLE_TOP, ["path", { d: "M6 21V9a9 9 0 0 0 9 9" }]]],
  closed: [
    "git-pull-request-closed",
    [
      ["path", { d: "m15.5 3.5 5 5" }],
      ["path", { d: "m15.5 8.5 5-5" }],
      ["path", { d: "M18 11.62V15" }],
      ["path", { d: "M6 9v12" }],
      CIRCLE_BOTTOM,
      CIRCLE_TOP,
    ],
  ],
  failing: ["circle-x", [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m15 9-6 6" }], ["path", { d: "m9 9 6 6" }]]],
  pending: [
    "circle-dashed",
    [
      ["path", { d: "M10.1 2.182a10 10 0 0 1 3.8 0" }],
      ["path", { d: "M13.9 21.818a10 10 0 0 1-3.8 0" }],
      ["path", { d: "M17.609 3.721a10 10 0 0 1 2.69 2.7" }],
      ["path", { d: "M2.182 13.9a10 10 0 0 1 0-3.8" }],
      ["path", { d: "M20.279 17.609a10 10 0 0 1-2.7 2.69" }],
      ["path", { d: "M21.818 10.1a10 10 0 0 1 0 3.8" }],
      ["path", { d: "M3.721 6.391a10 10 0 0 1 2.7-2.69" }],
      ["path", { d: "M6.391 20.279a10 10 0 0 1-2.69-2.7" }],
    ],
  ],
};

function glyph(kind: keyof typeof GLYPHS, className: string): SVGSVGElement {
  const [name, parts] = GLYPHS[kind];
  const svg = icon(name, parts, className);
  svg.setAttribute("data-tone", kind);
  return svg;
}

const STATE_WORDS: Record<PullState, string> = { open: "open", draft: "draft", merged: "merged", closed: "closed", unknown: "state unknown" };

/** `checks failing: unit, typecheck, lint and 2 more`, `checks pending`; null when there is nothing to mark. */
function checksWords(pr: PullRequestRow): string | null {
  if (!pr.checks || (pr.state !== "open" && pr.state !== "draft")) return null;
  if (pr.checks.state === "pending") return "checks pending";
  if (pr.checks.state !== "failing") return null;
  const names = pr.checks.failing;
  if (names.length === 0) return "checks failing";
  const listed = names.slice(0, 3).join(", ");
  return `checks failing: ${listed}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

function tally(prs: readonly PullRequestRow[]): HTMLElement {
  const count = (test: (pr: PullRequestRow) => boolean) => prs.filter(test).length;
  const segments: Array<{ kind: "failing" | PullState; count: number; words: string }> = [
    { kind: "failing" as const, count: count(failingChecks), words: "with failing checks" },
    ...(["open", "draft", "merged", "closed", "unknown"] as const).map((state) => ({
      kind: state,
      count: count((pr) => pr.state === state),
      words: STATE_WORDS[state],
    })),
  ]
    .filter((segment) => segment.count > 0)
    .map((segment) => ({ ...segment, words: `${segment.count} ${segment.words}` }));
  const sentence = `${prs.length} pull request${prs.length === 1 ? "" : "s"}: ${segments.map((segment) => segment.words).join(", ")}`;
  return h(
    "span",
    { class: "view-muted ticket-count ticket-pr-tally", role: "img", "aria-label": sentence, title: sentence, "data-pr-tally": "" },
    ...segments.map((segment) => {
      const item = h("span", { class: "ticket-pr-segment", role: "img", "aria-label": segment.words, "data-tally": segment.kind }, String(segment.count));
      item.prepend(glyph(segment.kind, "ticket-pr-icon"));
      return item;
    }),
  );
}

/** The tickets a pull request is on, without the card's own: `APP-2, APP-4`, or `also APP-3` when it is on the card's ticket too. */
function ticketsLine(pr: PullRequestRow, identifier: string): string | null {
  if (!pr.tickets) return null;
  const others = pr.tickets.filter((ticket) => ticket !== identifier);
  if (others.length === 0) return null;
  const onThisOne = pr.own || others.length < pr.tickets.length;
  return `${onThisOne ? "also " : ""}${others.join(", ")}`;
}

/** The section, or null when the card has no pull requests to draw. `open` asks the host to open a URL. */
export function pullRequestsSection(ticket: { identifier: string; subtreePullRequests?: unknown; pullRequests?: unknown }, open: (url: string) => void): HTMLElement | null {
  const prs = pullRequestRows(ticket);
  if (prs.length === 0) return null;
  const keys = prs.map((pr) => pr.key);
  const sorted = prs.map((pr, index) => ({ pr, index })).sort((a, b) => rank(a.pr) - rank(b.pr) || a.index - b.index);
  const shown = sorted.slice(0, MAX_ROWS).map(({ pr }) => pr);
  const more = prs.length - shown.length;
  return h(
    "section",
    { class: "ticket-section ticket-prs", "aria-label": "Pull requests", "data-pull-requests": "" },
    h("h2", { class: "ticket-heading" }, "Pull requests", tally(prs)),
    h(
      "ul",
      { class: "ticket-pr-list" },
      ...shown.map((pr) => {
        const checks = checksWords(pr);
        const tickets = ticketsLine(pr, ticket.identifier);
        const label = ["Open " + pr.key, pr.title, STATE_WORDS[pr.state], checks].filter(Boolean).join(", ");
        const button = h(
          "button",
          {
            class: "ticket-pr",
            type: "button",
            "data-pr": pr.key,
            "data-pr-state": pr.state,
            "aria-label": label,
            title: pr.title ?? pr.key,
          },
          h("span", { class: "ticket-pr-ref view-mono" }, shortKey(pr.key, keys)),
          h("span", { class: "ticket-pr-title" }, pr.title ?? pr.key),
          checks
            ? h("span", { class: "ticket-pr-checks", "data-pr-checks": pr.checks!.state, role: "img", "aria-label": checks, title: checks })
            : null,
          tickets ? h("span", { class: "ticket-pr-tickets view-mono view-muted" }, tickets) : null,
        );
        button.prepend(glyph(pr.state, "ticket-pr-glyph"));
        button.querySelector("[data-pr-checks]")?.append(glyph(pr.checks!.state as "failing" | "pending", "ticket-pr-icon"));
        if (pr.url) {
          const url = pr.url;
          button.addEventListener("click", () => open(url));
        } else {
          button.disabled = true;
        }
        return h("li", {}, button);
      }),
    ),
    more > 0 ? h("p", { class: "ticket-pr-more view-muted", "data-pr-more": "" }, `and ${more} more`) : null,
  );
}
