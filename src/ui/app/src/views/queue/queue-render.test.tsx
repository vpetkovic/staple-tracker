/**
 * The Queue page as markup: one section's rows (the pinned next row, the plan entries with the
 * number as the drag handle, a container's paged tasks under an epic caption, the band after
 * the plan), the state column's words, the conflict banner, the headers and the skeleton.
 * Rendered with `react-dom/server`, no DOM, the way the Inbox's render test does.
 *
 * The `data-queue-*` hooks the reliability track's browser tests key on are asserted here
 * on the elements that now carry them.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reorderQueue } from "@/lib/api";
import type { IssueRow, QueueView as QueueViewData } from "@/lib/types";
import { row } from "@/components/task-list/fixtures";
import { describeRefusal } from "@/lib/refusal";
import { effective, entry, queue, workedExample } from "./fixtures";
import { planRows, nextEligible, skippedBefore } from "./queue-model";
import { NO_FOLDS, sectionLayout, type SectionFolds } from "./queue-lines";
import { queueSummary } from "./queue-summary";
import { whyNext } from "./queue-words";
import { BandHead, ConflictBanner, NextRow, PageStrip, PolicyTag, QueueSkeleton, SectionHeader, Standing, type NextState } from "./QueueParts";
import { SectionBody, type SectionBodyProps } from "./QueueSection";
import { Meter } from "./QueueRow";
import { PROGRESS_COLOR } from "@/views/progress-palette";
import type { QueueWriteFailure } from "./use-workspace-queue";

const noop = () => {};

function nextOf(view: QueueViewData): NextState {
  const next = nextEligible(view.effective);
  return next ? { kind: "pick", row: next, why: whyNext(next, skippedBefore(view.effective, next), view.entries.length > 0) } : { kind: "empty" };
}

function renderSection(
  view: QueueViewData = workedExample(),
  over: Partial<SectionBodyProps> = {},
  folds: SectionFolds = NO_FOLDS,
  known: ReadonlyMap<string, IssueRow> = new Map(),
): string {
  const rows = planRows(view, [], "staple");
  const next = nextEligible(view.effective);
  const layout = sectionLayout({ workspace: "staple", view, rows, unqueued: view.effective.filter((row) => row.unqueued), next, known }, folds);
  return renderToStaticMarkup(
    <SectionBody
      workspace="staple"
      layout={layout}
      next={nextOf(view)}
      folded={false}
      hasPlan={view.entries.length > 0}
      busy={false}
      pending={null}
      failure={null}
      activeKey={layout.keys[0] ?? null}
      onOpen={noop}
      onShow={noop}
      onToggle={noop}
      onWhole={noop}
      onBand={noop}
      onBandWhole={noop}
      onAdd={noop}
      onRetry={noop}
      onDismiss={noop}
      menu={(_place, _identifier, trigger: ReactNode) => trigger}
      {...over}
    />,
  );
}

describe("a plan entry", () => {
  const html = renderSection();

  it("lists the plan in plan order, keeping the hooks the browser tests key on", () => {
    for (const id of ["STA-31", "STA-66", "STA-146"]) expect(html).toContain(`data-queue-entry="${id}"`);
    expect(html.indexOf('data-queue-entry="STA-31"')).toBeLessThan(html.indexOf('data-queue-entry="STA-66"'));
    expect(html.indexOf('data-queue-entry="STA-66"')).toBeLessThan(html.indexOf('data-queue-entry="STA-146"'));
    expect(html).toContain('data-identifier="STA-146"');
    expect(html).toMatch(/role="list"[^>]*aria-label="staple&#x27;s plan"/);
    expect(html).toMatch(/role="listitem"[^>]*data-queue-entry="STA-146"/);
  });

  it("makes the plan number the drag handle, named with the reference, its place and how to move it", () => {
    expect(html).toContain('aria-label="Move STA-146, now 3 of 3. Drag, or press Alt and an arrow key"');
    expect(html).toMatch(/data-queue-handle="STA-146"[^>]*><svg[^>]*q-grip[\s\S]*?<span class="q-n">3<\/span>/);
    // The arrow buttons are gone at every width.
    expect(html).not.toContain("data-reorder-control");
    expect(html).not.toContain('aria-label="Move STA-146 up"');
  });

  it("gives the list one tab stop: only the first row and its own controls are tabbable", () => {
    const stops = [...html.matchAll(/data-queue-row="([^"]+)"/g)].map((m) => m[1]!);
    expect(stops.length).toBeGreaterThan(3);
    expect(html.match(/role="listitem" tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/role="listitem" tabindex="0"[^>]*data-queue-entry="STA-31"/);
  });

  it("dims a resolved entry and strikes it through, keeping its number and saying Done", () => {
    expect(html).toMatch(/data-queue-entry="STA-31"[^>]*data-queue-resolved="true"/);
    expect(html).toMatch(/data-queue-handle="STA-31"[\s\S]*?<span class="q-n">1<\/span>/);
    expect(html).toMatch(/data-queue-entry="STA-31"[\s\S]*?q-tone-done[\s\S]*?Done/);
  });

  it("rolls a container up into a meter and counts, with a fold arrow that says it is open", () => {
    expect(html).toMatch(/aria-label="Fold STA-66" aria-expanded="true"/);
    // The fold arrow says it, not the list item: a listitem takes no aria-expanded.
    expect(html).not.toMatch(/role="listitem"[^>]*aria-expanded/);
    expect(html).toContain("3 tasks</span><span> · <b>1</b> ready");
    expect(html).toMatch(/class="q-meter q-meter-sm" role="img" aria-label="1 ready, 2 waiting"/);
  });

  it("draws the meter's waiting segment neutral grey, not the shared palette's alarm red", () => {
    const meter = renderToStaticMarkup(<Meter counts={{ done: 1, active: 1, ready: 1, waiting: 1 }} />);
    expect(meter).toContain('data-segment="waiting" style="flex-grow:1;background:var(--ds-gray-600)"');
    expect(meter).not.toContain(PROGRESS_COLOR.waiting);
    for (const bucket of ["done", "active", "ready"] as const) expect(meter).toContain(`data-segment="${bucket}" style="flex-grow:1;background:${PROGRESS_COLOR[bucket]}"`);
  });

  it("carries the entry's note under its row", () => {
    const view = queue({ entries: [entry({ identifier: "STA-5", note: "do this before the release" })], effective: [effective({ identifier: "STA-5" })] });
    expect(renderSection(view)).toMatch(/data-queue-note="true" class="q-note">do this before the release</);
  });

  it("marks the entry being written, not the whole list", () => {
    const pending = renderSection(workedExample(), { pending: "STA-146" });
    expect(pending).toMatch(/aria-busy="true"[^>]*data-queue-entry="STA-146"/);
    expect(pending.match(/aria-busy="true"/g)).toHaveLength(1);
  });

  it("makes the handles inert while a write is in flight", () => {
    expect(renderSection(workedExample(), { busy: true })).toMatch(/aria-disabled="true"[^>]*data-queue-handle="STA-146"/);
  });
});

/** Element nodes of static markup: enough of a parser for what react-dom/server writes. */
interface Node {
  tag: string;
  attrs: string;
  children: Array<Node | string>;
}

function parse(html: string): Node {
  const root: Node = { tag: "#root", attrs: "", children: [] };
  const stack = [root];
  const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
  for (const token of html.split(/(<[^>]+>)/)) {
    if (token === "") continue;
    const top = stack.at(-1)!;
    const tag = /^<(\/?)([a-zA-Z][\w-]*)([^>]*)>$/.exec(token);
    if (!tag) {
      top.children.push(token);
      continue;
    }
    if (tag[1]) {
      stack.pop();
      continue;
    }
    const node: Node = { tag: tag[2]!, attrs: tag[3]!, children: [] };
    top.children.push(node);
    if (!VOID.has(node.tag) && !tag[3]!.endsWith("/")) stack.push(node);
  }
  return root;
}

const attr = (node: Node, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(node.attrs)?.[1];

/** Every role="list" in the markup, and what it holds that is not a list item. */
function strayListChildren(html: string): string[] {
  const stray: string[] = [];
  const check = (child: Node | string, list: Node) => {
    if (typeof child === "string") {
      if (child.trim()) stray.push(`text "${child.trim()}" in ${attr(list, "aria-label")}`);
      return;
    }
    if (attr(child, "aria-hidden") === "true" || attr(child, "role") === "listitem") return;
    if (["none", "presentation"].includes(attr(child, "role") ?? "")) {
      for (const inner of child.children) check(inner, list);
      return;
    }
    stray.push(`<${child.tag}${child.attrs}>`);
  };
  const walk = (node: Node) => {
    if (attr(node, "role") === "list") for (const child of node.children) check(child, node);
    for (const child of node.children) if (typeof child !== "string") walk(child);
  };
  walk(parse(html));
  return stray;
}

describe("the list's structure", () => {
  it("holds only list items, with the wrappers and the drop line out of the way", () => {
    const view = workedExample();
    view.entries[1] = { ...view.entries[1]!, note: "do this before the release" };
    const many = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone", note: "the release" })],
      effective: Array.from({ length: 8 }, (_, i) => effective({ identifier: `EXE-${300 + i}`, position: i + 1, via: "EXE-234", milestonePath: ["EXE-234"], epicPath: ["EXE-299"] })),
    });
    const drag = { from: 0, lineTop: 40, handleProps: () => ({ onPointerDown: noop, onPointerMove: noop, onPointerUp: noop, onPointerCancel: noop }) };
    const caption = new Map([["EXE-299", row({ identifier: "EXE-299", title: "Payments", kind: "epic" })]]);
    for (const html of [renderSection(view, { drag }), renderSection(many, { drag }, NO_FOLDS, caption)]) {
      expect(html).toContain("q-dropline");
      expect(strayListChildren(html)).toEqual([]);
    }
    const band = queue({ entries: [], effective: Array.from({ length: 12 }, (_, i) => effective({ identifier: `STA-${50 + i}`, position: 1 + i, unqueued: true })) });
    expect(strayListChildren(renderSection(band, {}, { ...NO_FOLDS, bandOpen: true }))).toEqual([]);
    expect(renderSection(many)).toMatch(/role="listitem"[^>]*class="q-moreline"|class="q-moreline"[^>]*role="listitem"/);
  });
});

describe("what a screen reader hears for a row", () => {
  const html = renderSection();
  const label = (marker: string, id: string) => new RegExp(`aria-label="([^"]*)"[^>]*${marker}="${id}"`).exec(html)?.[1]?.replace(/&#x27;/g, "'");

  it("says a plan entry's state after its number, reference and title", () => {
    expect(label("data-queue-entry", "STA-31")).toBe("1. STA-31 A1: characterize current product contracts, Done");
    expect(label("data-queue-entry", "STA-146")).toBe("3. STA-146 Flaky under full-suite load, Ready");
  });

  it("gives a container its roll-up", () => {
    expect(label("data-queue-entry", "STA-66")).toBe("2. STA-66 S: opt-in cloud continuity, 3 tasks, 1 ready");
  });

  it("says what a task under an entry waits on, and which row is the next pick", () => {
    expect(label("data-queue-tree-row", "STA-68")).toBe("#3 STA-68 S2: add clone-safe repository identity, Waiting on STA-35, STA-67");
    expect(label("data-queue-tree-row", "STA-67")).toBe("#2 STA-67 S1: specify the local-first sync, Ready, next pick");
  });

  it("says who works a claimed task", () => {
    const held = queue({
      entries: [entry({ identifier: "STA-1", kind: "epic" })],
      effective: [effective({ identifier: "STA-2", via: "STA-1", status: "in_progress", eligibility: "claimed", detail: { heldBy: "codex-1", idleSeconds: 240 } })],
    });
    expect(renderSection(held)).toContain('aria-label="#1 STA-2 STA-2 title, Working, codex-1"');
  });

  it("calls a plan entry that is the next pick by that name", () => {
    const one = queue({ entries: [entry({ identifier: "STA-5" })], effective: [effective({ identifier: "STA-5" })] });
    expect(renderSection(one)).toContain('aria-label="1. STA-5 STA-5 title, Ready, next pick"');
  });

  it("says where the order already reached an entry", () => {
    const view = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone", planPosition: 1 }), entry({ identifier: "EXE-96", planPosition: 2 })],
      effective: [effective({ identifier: "EXE-96", position: 76, via: "EXE-234", milestonePath: ["EXE-234"] })],
    });
    expect(renderSection(view, {}, { ...NO_FOLDS, containersOpen: false })).toContain('aria-label="2. EXE-96 EXE-96 title, Already in the order at #76, inside EXE-234"');
  });
});

describe("the links in the state column", () => {
  it("are in the tab order on the row that holds the tab stop, and out of it elsewhere", () => {
    const idle = renderSection();
    expect(idle).toMatch(/tabindex="-1" data-queue-jump="STA-35"/);
    expect(idle).not.toMatch(/tabindex="0" data-queue-jump=/);
    const active = renderSection(workedExample(), { activeKey: "staple|nested|STA-68" });
    expect(active).toMatch(/tabindex="0" data-queue-jump="STA-35"/);
    expect(active).toMatch(/tabindex="0" data-queue-jump="STA-67"/);
  });

  it("follow the tab stop to an entry the order already reached", () => {
    const view = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone", planPosition: 1 }), entry({ identifier: "EXE-96", planPosition: 2 })],
      effective: [effective({ identifier: "EXE-96", position: 76, via: "EXE-234", milestonePath: ["EXE-234"] })],
    });
    const folds = { ...NO_FOLDS, containersOpen: false };
    expect(renderSection(view, {}, folds)).toMatch(/tabindex="-1"[^>]*data-queue-jump="EXE-96"/);
    expect(renderSection(view, { activeKey: "staple|entry|EXE-96" }, folds)).toMatch(/tabindex="0"[^>]*data-queue-jump="EXE-96"/);
  });
});

describe("what a container expands to", () => {
  const html = renderSection();

  it("draws the tasks under the entry in effective order, each with its turn number", () => {
    const at = html.indexOf('data-queue-expansion="STA-66"');
    const block = html.slice(at, html.indexOf('data-queue-entry="STA-146"'));
    expect(block.indexOf('data-queue-tree-row="STA-67"')).toBeLessThan(block.indexOf('data-queue-tree-row="STA-68"'));
    expect(block).toMatch(/data-queue-tree-row="STA-68"[\s\S]*?class="q-ord">#3</);
  });

  it("names the blockers as links and the ready row as Ready", () => {
    expect(html).toMatch(/data-queue-tree-row="STA-68"[\s\S]*?Waiting on[\s\S]*?data-queue-jump="STA-35"[^>]*>STA-35<[\s\S]*?data-queue-jump="STA-67"/);
    expect(html).toMatch(/data-queue-tree-row="STA-67"[\s\S]*?q-tone-ready[\s\S]*?Ready/);
  });

  it("pages a long container: five, then how many more and a way to see them all", () => {
    const many = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone" })],
      effective: Array.from({ length: 8 }, (_, i) => effective({ identifier: `EXE-${300 + i}`, position: i + 1, via: "EXE-234", milestonePath: ["EXE-234"] })),
    });
    const paged = renderSection(many);
    expect(paged.match(/data-queue-tree-row=/g)).toHaveLength(5);
    expect(paged).toContain('data-queue-expansion-more="EXE-234"');
    expect(paged).toContain("3 more in EXE-234");
    expect(paged).toContain("Show all 8");
    const whole = renderSection(many, {}, { ...NO_FOLDS, whole: new Set(["EXE-234"]) });
    expect(whole.match(/data-queue-tree-row=/g)).toHaveLength(8);
    expect(whole).toContain("Show the first 5 only");
  });

  it("gives the more line the next pick's edge when the pick is among the tasks it hides", () => {
    const many = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone" })],
      effective: Array.from({ length: 8 }, (_, i) =>
        effective({ identifier: `EXE-${300 + i}`, position: i + 1, via: "EXE-234", milestonePath: ["EXE-234"], eligibility: i === 6 ? "eligible" : "blocked" }),
      ),
    });
    expect(renderSection(many)).toMatch(/class="q-moreline"[^>]*data-next-inside=""/);
    expect(renderSection(many, {}, { ...NO_FOLDS, whole: new Set(["EXE-234"]) })).not.toContain("data-next-inside");
  });

  it("marks a claimed task in flight and dims its number", () => {
    const held = queue({
      entries: [entry({ identifier: "STA-1", kind: "epic" })],
      effective: [effective({ identifier: "STA-2", via: "STA-1", status: "in_progress", eligibility: "claimed", detail: { heldBy: "codex-1", idleSeconds: 240 } })],
    });
    const out = renderSection(held);
    expect(out).toMatch(/data-queue-tree-row="STA-2"[^>]*data-queue-inflight="true"/);
    expect(out).toContain('class="q-ord q-taken"');
    expect(out).toContain("Working · codex-1");
    expect(out).toMatch(/class="q-who"[^>]*>C1</);
  });
});

describe("an entry the order already reached", () => {
  it("says where and through which entry, as a link", () => {
    const view = queue({
      entries: [entry({ identifier: "EXE-234", kind: "milestone", planPosition: 1 }), entry({ identifier: "EXE-96", planPosition: 2 })],
      effective: [effective({ identifier: "EXE-96", position: 76, via: "EXE-234", milestonePath: ["EXE-234"] })],
    });
    const html = renderSection(view, {}, { ...NO_FOLDS, containersOpen: false });
    expect(html).toMatch(/data-queue-entry="EXE-96"[\s\S]*?Already in the order at #76, inside <button[^>]*data-queue-jump="EXE-96"[^>]*>EXE-234</);
  });
});

describe("the pinned next row", () => {
  it("names the pick, its place and what is ahead, with Open", () => {
    const html = renderSection();
    expect(html).toMatch(/data-queue-next-up="true" data-queue-next="eligible"/);
    expect(html).toMatch(/data-queue-next-ref="true">STA-67</);
    // Only a finished row is ahead of it, so it is first in the order.
    expect(html).toMatch(/class="q-why"><span class="q-wide">First in the order</);
    expect(html).toContain("data-queue-next-open");
    // The pick's own row in the list wears the same tint, without a second label.
    expect(html).toMatch(/data-next=""[^>]*class="q-row q-task"|data-queue-tree-row="STA-67"[^>]*data-next=""/);
  });

  it("is the only place the word Next appears", () => {
    const html = renderSection();
    expect(html.match(/>Next</g)).toHaveLength(1);
    expect(html).not.toMatch(/Next up/i);
  });

  it("says nothing can be picked up, and why, in its amber variant", () => {
    const html = renderToStaticMarkup(<NextRow state={{ kind: "none", text: "2 waiting. Agents asking for work get none." }} onOpen={noop} onShow={noop} />);
    expect(html).toContain('class="q-next q-next-none"');
    expect(html).toContain("Nothing can be picked up right now");
    expect(html).toContain("2 waiting. Agents asking for work get none.");
  });

  it("says No open work when there is none", () => {
    expect(renderToStaticMarkup(<NextRow state={{ kind: "empty" }} onOpen={noop} onShow={noop} />)).toContain("No open work");
  });
});

describe("the band after the plan", () => {
  const view = queue({
    entries: [entry({ identifier: "STA-1" })],
    effective: [
      effective({ identifier: "STA-1", eligibility: "blocked", detail: { blockers: ["STA-9"] } }),
      ...Array.from({ length: 12 }, (_, i) => effective({ identifier: `STA-${50 + i}`, position: 2 + i, unqueued: true })),
    ],
  });

  it("is one folded line that counts itself", () => {
    const html = renderSection(view);
    expect(html).toMatch(/data-queue-unqueued-toggle="true" aria-expanded="false"/);
    expect(html).toContain("After the plan");
    expect(html).toMatch(/data-queue-unqueued-count="true">12 open tasks/);
    expect(html).not.toContain("data-queue-unqueued=");
  });

  it("opens into rows without numbers, each with an Add, ten first", () => {
    const html = renderSection(view, {}, { ...NO_FOLDS, bandOpen: true });
    expect(html).toContain('data-queue-unqueued="true"');
    expect(html.match(/data-queue-band-add=/g)).toHaveLength(10);
    expect(html).toMatch(/data-queue-tree-row="STA-50"[^>]*>[\s\S]*?class="q-ord"[^>]*aria-hidden="true"><\/span>/);
    expect(html).toContain("data-queue-unqueued-more");
    expect(html).toContain("Show all 12");
  });

  it("is called Open work when there is no plan", () => {
    expect(renderToStaticMarkup(<BandHead count={1} hasPlan={false} open onToggle={noop} />)).toContain("Open work");
  });
});

describe("a write that went wrong", () => {
  const conflict: QueueWriteFailure = {
    kind: "conflict",
    refusal: describeRefusal(new Error("revision_conflict")),
    intended: ["STA-146", "STA-31", "STA-66"],
  };

  it("puts the conflict under the header with a way to apply the move again and to dismiss", () => {
    const html = renderSection(workedExample(), { failure: conflict });
    expect(html).toMatch(/role="alert" data-queue-conflict="true"/);
    expect(html).toContain("The plan changed somewhere else, so your move was not saved.");
    expect(html).toContain("Apply my move again");
    expect(html).toContain("Dismiss");
    expect(html.indexOf("data-queue-conflict")).toBeLessThan(html.indexOf("data-queue-next-up"));
  });

  it("offers no retry for a write with no order to apply", () => {
    expect(renderToStaticMarkup(<ConflictBanner canRetry={false} busy={false} onRetry={noop} onDismiss={noop} />)).not.toContain("Apply my move again");
    const html = renderSection(workedExample(), { failure: { ...conflict, intended: null } });
    expect(html).toContain("data-queue-conflict");
    expect(html).not.toContain("Apply my move again");
  });

  it("shows any other refusal as the store's own sentence", () => {
    const html = renderSection(workedExample(), { failure: { kind: "refusal", refusal: describeRefusal(new Error("nope")), intended: null } });
    expect(html).not.toContain("data-queue-conflict");
    expect(html).toContain("nope");
  });
});

describe("the headers", () => {
  const summary = queueSummary(workedExample().effective);

  it("counts the plan in words and offers to clear what is finished", () => {
    const html = renderToStaticMarkup(<Standing summary={summary} finished={1} busy={false} onPrune={noop} />);
    expect(html).toContain("<b>5</b> in the plan:");
    expect(html).toMatch(/<b>2<\/b> <span class="q-wide">ready<\/span>/);
    expect(html).toContain('aria-label="Clear 1 finished"');
    expect(renderToStaticMarkup(<Standing summary={summary} finished={0} busy={false} onPrune={noop} />)).not.toContain("Clear");
  });

  it("names the policy as words, and strict with a lock", () => {
    expect(renderToStaticMarkup(<PolicyTag policy="advisory" workspace="staple" onOpenSettings={noop} />)).toContain("Advisory order");
    const strict = renderToStaticMarkup(<PolicyTag policy="strict" workspace="staple" onOpenSettings={noop} />);
    expect(strict).toContain("q-tag-strict");
    expect(strict).toContain("Strict order");
  });

  it("folds a workspace's section from its header", () => {
    const html = renderToStaticMarkup(<SectionHeader workspace="fds" prefix="FDS" folded onToggle={noop} policy={null} standing={null} add={null} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Open fds"');
    expect(html).toMatch(/class="q-tile"[^>]*>F</);
  });

  it("draws the strip without an Add when the phone title line carries it", () => {
    expect(renderToStaticMarkup(<PageStrip policy={null} standing={null} add={null} />)).toContain('class="q-strip-add"></span>');
  });

  it("loads in the list's own shape", () => {
    const html = renderToStaticMarkup(<QueueSkeleton />);
    expect(html).toMatch(/role="status" aria-busy="true"/);
    expect(html.match(/q-row q-skel/g)).toHaveLength(7);
  });
});

/**
 * The worked example through the real client with a stubbed `fetch`: the order a drag or a key
 * produces goes out as one reorder with the base revision, and the answer renders in that order.
 */
describe("arranging STA-31, STA-66 and STA-146 in that plan order", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends one reorder and renders the plan the server answers with", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return { ok: true, status: 200, statusText: "OK", json: async () => workedExample() } as Response;
    });
    const view = await reorderQueue({ order: ["STA-31", "STA-66", "STA-146"], baseRevision: 6 });
    expect(calls).toEqual([{ url: "/api/queue/reorder", body: { actor: "ui", order: ["STA-31", "STA-66", "STA-146"], baseRevision: 6 } }]);
    const html = renderSection(view);
    const positions = ["STA-31", "STA-66", "STA-146"].map((id) => html.indexOf(`data-queue-entry="${id}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const expansion = html.indexOf('data-queue-expansion="STA-66"');
    expect(expansion).toBeGreaterThan(positions[1]!);
    expect(expansion).toBeLessThan(positions[2]!);
  });
});
