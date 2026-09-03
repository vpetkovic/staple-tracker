/**
 * THE REVIEW GATE BLOCK — Q4 (STA-147), rebuilt from Q2's first cut (STA-144).
 *
 * ══ WHY IT IS ITS OWN FILE NOW ═══════════════════════════════════════════════════════
 *
 * Q2 grew this inside `IssueActions.tsx`, next to the claim row, and that was right while
 * it was six lines. It is not six lines: it is a header, a grouped checklist, three verbs
 * and a disclosure, and it is the one block in the detail panel with a LAYOUT CONTRACT
 * (below) that a reviewer has to be able to read without scrolling past the takeover
 * buttons to find it. `IssueActions` keeps the verbs an agent performs on its own work;
 * this file is the verbs a named human performs on somebody else's.
 *
 * ══ THE LAYOUT CONTRACT — VP's review of Q2, 2026-09-02 ══════════════════════════════
 *
 * What VP saw: "the first one is a checkbox, then the task number split across two rows,
 * followed by the task title. The title overflows, requiring a horizontal scroll."
 *
 * Both halves had a specific cause, and both are now structurally impossible rather than
 * merely fixed:
 *
 *   THE IDENTIFIER WRAPPED because Q2's row was a `flex` whose identifier `<span>` had
 *   neither `flex-shrink: 0` nor `white-space: nowrap`. Flexbox shrinks an item to its
 *   min-content before it touches its siblings, and the min-content of `STA-147` is the
 *   width of `STA-` — so under any pressure at all the number went to line two and the
 *   row grew to twice the height of its neighbours. That is the "overlap".
 *
 *   THE DRAWER SCROLLED because the checklist was a bare `<fieldset>`. A fieldset carries
 *   a UA `min-inline-size: min-content` that no amount of `min-width: 0` on its
 *   DESCENDANTS can reach past, so it refused to shrink and pushed the whole action strip
 *   wider than the drawer that contains it.
 *
 * The row is now a GRID, not a flex, with four tracks that cannot renegotiate:
 *
 *     [check 16px] [identifier max-content] [status 16px] [title minmax(0, 1fr)]
 *
 * `minmax(0, 1fr)` on the title is the load-bearing half — a bare `1fr` keeps an auto
 * min-content floor and the title silently refuses to ellipsize. It is the same clause,
 * for the same reason, that `.staple-row` states in task-list.css, and it is the single
 * most common way a row like this gets built wrong.
 *
 * ── HOW THE FOUR COLUMNS ALIGN DOWN THE LIST WITHOUT `subgrid` ──────────────────────
 *
 * Each row is its own grid, so a `max-content` identifier track fed by the text alone
 * would be measured per row and `STA-9` would start its title several pixels left of
 * `STA-147`'s. The fix is one number measured once: `gateIdWidth()` returns the longest
 * identifier's length, the list sets it as `--gate-id-w: {n}ch`, and every identifier
 * takes that as an explicit width — so the `max-content` track, which takes an item's
 * specified width as its contribution, comes out identical on every row.
 *
 * The `ch` MUST land on the identifier and not on the row. An unregistered custom property
 * substitutes textually and `ch` means "the advance of a 0 in THIS element's font", so the
 * same `6ch` is 39.6px on the mono identifier and 63.6px on the sans row. detail.css has
 * the measured numbers; the first cut of this ticket put it on the row and spent 24px of
 * the title's track on nothing.
 *
 * Subgrid would also work and is one line shorter. It is not used because it puts the
 * alignment in a place no test can assert: `gateIdWidth` is a pure function with a unit
 * test, and a subgrid track is a fact only a browser knows.
 *
 * ══ WHY NOT `TaskRowLine` IN ITS `panel` PRESET ══════════════════════════════════════
 *
 * It was the first thing tried, and it CANNOT meet this ticket's first acceptance
 * criterion. `task-list.css` §14 contains
 *
 *     @media (max-width: 719px) { .staple-row { height: 56px; grid-template-rows: 28px 28px } }
 *
 * — a VIEWPORT query, not a container query. The drawer is `min(46rem, 94vw)`, so a
 * 420px-wide drawer only exists inside a ~447px viewport and a 560px drawer inside a
 * ~596px one. Both are below that breakpoint, so the shared row would deliberately
 * render as TWO LINES at exactly the two widths this ticket requires one. That is not a
 * bug in §14 — a tree row at 447px genuinely has more to say than one line holds — it is
 * a container whose rule does not fit this content.
 *
 * Three smaller reasons point the same way. The preset's select column is
 * `.staple-row-check`, which is `opacity: 0` until its row is hovered and `display: none`
 * below 719px — Q2 already wrote down why that is wrong for a checklist, where the boxes
 * ARE the content. The row is a click target carrying `role="row"` / `role="option"`, and
 * a checkbox label nested inside a selectable option is two controls fighting over one
 * click. And the preset renders priority, labels, the claim pill, the assignee avatar and
 * the dependency badges, which is a great deal of furniture for a four-item decision.
 *
 * So: a purpose-built list, on the SAME tokens, at the SAME 28px compact row height, with
 * the SAME `StatusIcon` component and the same title/`title=` bargain. What is shared is
 * shared; what differs, differs on purpose.
 */
import { useId, useState } from "react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatAgo } from "@/lib/claim";
import { impliedSelection, selectionRoots, subtreeOf } from "@/lib/derived-queued";
import type { GateQueueEntry, IssueGate } from "@/lib/types";

/**
 * ══ WHAT "SEND BACK" DOES, IN ONE SENTENCE ═══════════════════════════════════════════
 *
 * VP's review of Q4: "I do not know whether typing changes gets processed or is just a
 * comment." That is a fair reading of a button labelled "Request changes" above a box
 * labelled "What has to change?" — nothing on the screen said the note is stored, that
 * the parent moves, or what happens to the queue, and all three are consequences a
 * reviewer is entitled to know BEFORE they type.
 *
 * So the action is named for what it does to the ticket — it sends it back — and the
 * three consequences are printed above the box rather than discovered afterwards. The
 * SAME sentence is the CLI's `request-changes --help`, the MCP `request_changes`
 * description and the paragraph in docs/semantics.md. One wording, four surfaces: if the
 * behaviour ever changes, the grep that finds one finds them all.
 *
 * The COMMAND is still `request-changes` / `request_changes`. Renaming a shipped verb to
 * improve a button's label would break every script and agent that calls it, and the
 * label is the thing that was wrong.
 */
export function sendBackContract(identifier: string): string {
  return `Posts your note as a comment on ${identifier}, returns it to todo for the next agent, and keeps the queued children parked until you approve.`;
}

/**
 * The widest identifier in the list, in characters — the one number the four columns
 * align on. Never below `MIN_ID_CH`, so a workspace whose identifiers are all `WOR-1`
 * still gets a checkbox that is not jammed against a status icon; never above
 * `MAX_ID_CH`, because an identifier is not the content and a pathological prefix must
 * not be allowed to eat the title's track.
 *
 * Pure, and exported, because this IS the alignment: a test can assert it, whereas a
 * `subgrid` track is a fact only a browser knows.
 */
export const MIN_ID_CH = 6;
export const MAX_ID_CH = 12;

export function gateIdWidth(children: readonly { identifier: string }[]): number {
  let widest = MIN_ID_CH;
  for (const child of children) widest = Math.max(widest, child.identifier.length);
  return Math.min(widest, MAX_ID_CH);
}

/**
 * HOW FAR TO INDENT A ROW AT `depth` — Q5 (STA-154).
 *
 * The store's `depth` starts at 1 for a direct child of the gate holder, so the first
 * level is flush and each level below it steps in once.
 *
 * CLAMPED at `MAX_INDENT_STEPS`, and the clamp is not decoration. `depth` is bounded
 * only by the tree-depth cap, and the drawer is 420px wide at its narrowest; an
 * unclamped indent would spend the whole title track on whitespace long before it hit
 * that cap, leaving a column of ellipses that says nothing. Past four steps the reader
 * has the shape from the rows above anyway — the indent's job is to show WHICH SUBTREE a
 * row is in, and after four levels the identifier prefix and the run of rows do that
 * better than another 14px.
 *
 * Pure and exported for the same reason `gateIdWidth` is: a padding computed in a
 * template literal is a fact only a browser knows, and this one has an edge case.
 */
export const MAX_INDENT_STEPS = 4;

export function indentSteps(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  return Math.min(Math.max(Math.trunc(depth) - 1, 0), MAX_INDENT_STEPS);
}

/**
 * The quiet inline beside the eyebrow: who has to act, and how long they have had it.
 *
 * `changes_requested` is the interesting case and it must NOT read like a closed gate.
 * The children are still queued behind it — `ACTIVE_GATE_STATES` in derived-queued.ts
 * says so and the store agrees — so the sentence carries the objection AND the fact that
 * the queue is still standing. When the person who objected is the gate's owner (the
 * overwhelmingly common case) naming them twice is noise, so it says "still queued"
 * instead; when a second reviewer objected, the owner is named, because then it is a fact
 * the reader does not already have.
 *
 * The age is OMITTED rather than guessed when the stamp does not parse. `formatAgo` would
 * happily render "0s" from a `NaN`, and a gate that claims to have been opened this
 * second is worse than a gate that does not say.
 */
export function gateStateSummary(gate: IssueGate, now: Date): string {
  const age = (iso: string | null): string => {
    if (!iso) return "";
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    return ` · ${formatAgo((now.getTime() - at) / 1000)}`;
  };

  if (gate.state === "changes_requested") {
    const by = gate.resolvedBy ?? gate.owner;
    const since = age(gate.resolvedAt ?? gate.requestedAt);
    return by === gate.owner
      ? `changes requested by ${by}${since} — still queued`
      : `changes requested by ${by}${since} — still awaiting ${gate.owner}`;
  }
  return `awaiting ${gate.owner}${age(gate.requestedAt)}`;
}

/**
 * ── WHY "APPROVE SELECTED" IS A CHECKLIST AND NOT A SECOND BUTTON PER CHILD ──────────
 *
 * VP's decision is that approval is granular: release some children, keep the gate. The
 * natural-looking design is a "release" button on each child row, and it is wrong for
 * this task — a reviewer reading an epic decides about the SET, and per-row buttons make
 * that N separate writes, each of which the other agents see land separately. One
 * checklist and one write is both fewer round trips and a truer record of one decision.
 *
 * ── EVERY CONTROL IS A REAL CONTROL ──────────────────────────────────────────────────
 *
 * Real `<input type="checkbox">` inside a real `<label>`, so the whole 28px row is a
 * click target and the tab order is checkbox → checkbox → … → buttons with no roving
 * tabindex to get wrong. The group is a `<fieldset>` with a `<legend>`, which is what
 * makes "5 queued children" announceable rather than five unrelated boxes. No
 * `div role="checkbox"` anywhere: the native control already has the keyboard behaviour,
 * and the focus ring in detail.css is an ENHANCEMENT of the UA's, not a replacement.
 *
 * ── THE COMMENT BOX IS INLINE, CONDITIONAL, AND BELOW THE BUTTONS ────────────────────
 *
 * "Request changes" reveals a textarea and only then submits, rather than opening a
 * dialog or a `window.prompt`. The store REQUIRES a comment and refuses without one, so a
 * bare button would be a button that always fails on the first click. Revealing the box
 * IS the first click, and the submit is disabled until there is something in it — which
 * means the store's refusal is unreachable from this surface rather than merely unlikely.
 *
 * It is rendered AFTER the actions row in the DOM, which is the whole reason the list
 * does not move when it opens. A disclosure that pushes the thing you were just reading
 * off the screen is a disclosure people learn not to press.
 */
export function GateReview({
  identifier,
  gate,
  queue,
  busy,
  now = new Date(),
  onApproveAll,
  onApproveSelected,
  onRequestChanges,
}: {
  /** The gated issue itself — the "STA-N" in the Send back contract sentence. */
  identifier: string;
  gate: IssueGate;
  /**
   * `/api/issue`'s `childrenQueued`: the OPEN descendants this gate still holds, flat
   * and pre-ordered, with the depth to indent by. Already filtered by the store — see
   * `lib/derived-queued.ts` on why the browser does not re-derive eligibility.
   */
  queue: readonly GateQueueEntry[];
  busy: boolean;
  /** Injected so the header's age is a pure function of props in tests. */
  now?: Date;
  onApproveAll: (comment?: string) => void;
  onApproveSelected: (children: string[]) => void;
  onRequestChanges: (comment: string) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [objection, setObjection] = useState<string | null>(null);
  const listId = useId();
  const objectionId = useId();

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * THE SELECTION, NARROWED TO WHAT IS STILL THERE.
   *
   * `selected` is a set of identifiers and `queue` shrinks underneath it — after a
   * successful "Approve selected", after another agent approves the same child, or on any
   * 1.5s poll that lands between the two. Reading the raw set would leave the button
   * saying "Approve selected (1)" with nothing ticked on screen, and clicking it would
   * send a child the gate has already released.
   *
   * DERIVED AT RENDER rather than cleared in the success handler. Clearing on success
   * fixes the case this was found in and none of the others; intersecting is true no
   * matter WHY a child left the list, and it needs no effect to keep two pieces of state
   * in step. The stale identifiers stay in `selected` and are simply never read — the set
   * is not authoritative, `queue` is.
   */
  const ticked = new Set(queue.filter((row) => selected.has(row.identifier)).map((r) => r.identifier));
  /** Ticked plus everything underneath: what the click actually releases. */
  const releasing = impliedSelection(queue, ticked);
  /** What goes on the wire — the store propagates a release down a subtree by itself. */
  const roots = selectionRoots(queue, ticked);
  const count = queue.length;

  return (
    <section aria-label="Review gate" className="staple-gate">
      <div className="staple-gate-head">
        <span className="staple-gate-eyebrow">Review gate</span>
        <span className="staple-gate-state">{gateStateSummary(gate, now)}</span>
      </div>

      {count > 0 ? (
        <fieldset className="staple-gate-fieldset">
          <legend id={listId} className="staple-gate-legend">
            {count} queued {count === 1 ? "item" : "items"} — tick the ones to release
          </legend>
          {/*
            The width the four columns align on, set ONCE on the list rather than per row.
            See `gateIdWidth` above for why this is a `ch` on an element whose font is not
            the one it will be measured in.
          */}
          <div
            className="staple-gate-rows"
            style={{ ["--gate-id-w" as string]: `${gateIdWidth(queue)}ch` }}
          >
            {queue.map((row, index) => {
              const implied = !ticked.has(row.identifier) && releasing.has(row.identifier);
              const under = ticked.has(row.identifier) ? subtreeOf(queue, index).length : 0;
              return (
                <label
                  key={row.id}
                  className={implied ? "staple-gate-row staple-gate-row-implied" : "staple-gate-row"}
                  /*
                    THE INDENT. One custom property, consumed by `padding-inline-start` in
                    detail.css, and CLAMPED there is the wrong place — a clamp belongs
                    where the number is known, so it is applied here.

                    The four-track grid is untouched: indenting is padding on the row, so
                    the title's `minmax(0, 1fr)` still absorbs whatever is left and still
                    ellipsizes. That is why a deep tree cannot bring back the horizontal
                    scroll VP saw in Q2 — there is no track that can grow.
                  */
                  style={{ ["--gate-depth" as string]: String(indentSteps(row.depth)) }}
                >
                  <input
                    type="checkbox"
                    data-slot="checkbox"
                    // NOT `.staple-row-check` — that one hides until its row is hovered and
                    // vanishes below 719px. See the note on this class in detail.css.
                    className="staple-gate-check"
                    // The name a screen reader reads. Explicit rather than inherited from
                    // the label's text, because the label also contains the StatusIcon's
                    // own `role="img"` name, and "Release STA-13: … Status: Backlog" is a
                    // worse sentence than the two facts read separately.
                    aria-label={
                      implied
                        ? `${row.identifier}: ${row.title} — released with its parent`
                        : `Release ${row.identifier}: ${row.title}`
                    }
                    /*
                      An implied row is CHECKED AND DISABLED rather than merely checked.
                      Ticking a parent releases its subtree whether the children are ticked
                      or not, so leaving them clickable would offer a choice that does not
                      exist — and unticking one would silently do nothing.
                    */
                    checked={implied || ticked.has(row.identifier)}
                    disabled={busy || implied}
                    onChange={() => toggle(row.identifier)}
                  />
                  <span className="staple-gate-row-id">{row.identifier}</span>
                  <StatusIcon status={row.status} className="staple-gate-row-status" />
                  {/*
                    The title cell is a flex, not a fifth grid track: a track would take
                    its column gap on every row including the ones with no badge, and the
                    grid template is the layout contract this block is built on. `flex: none`
                    on the badge and `min-width: 0` on the title is what makes the TITLE
                    give way when the row is narrow, never the count.
                  */}
                  <span className="staple-gate-row-main">
                    {/* Truncated with the full text in `title` — the same bargain the shared
                        task row makes, and the price of a fixed 28px row. */}
                    <span className="staple-gate-row-title" title={row.title}>
                      {row.title}
                    </span>
                    {under > 0 ? (
                      <span
                        className="staple-gate-row-implies"
                        title={`Releases ${under} more underneath ${row.identifier}`}
                      >
                        +{under}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        /*
          THE EMPTY STATE — rule (d) of VP's review.

          Reached two ways that mean the same thing to the reviewer: everything queued has
          been released one by one, or there was never anything open under this parent to
          queue. Either way the only remaining decision is whether the gate stays open, so
          the block offers exactly that and nothing else. An "Approve all" beside "Nothing
          left to release" is a button whose noun is not on the screen.
        */
        <p className="staple-gate-empty">
          Nothing left to release — no open work is queued behind this gate.
        </p>
      )}

      <div className="staple-gate-actions">
        {/*
          "Approve all" ONLY while the list is non-empty. When it is empty the same store
          call is still the right one, but it is a different decision — closing the review
          rather than releasing a queue — so it says so.
        */}
        {count > 0 ? (
          <Button size="sm" disabled={busy} onClick={() => onApproveAll()}>
            Approve all
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => onApproveAll()}>
            Approve and close gate
          </Button>
        )}
        {/*
          Only rendered when there is something to select. A permanently dead
          "Approve selected (0)" beside the sentence "Nothing left to release" is furniture
          that says nothing the sentence has not already said.

          Disabled at zero ticked. Sending an empty list would mean "approve the whole
          gate" to the store — the same thing "Approve all" does — and a button that
          silently becomes a different, larger button is the worst way to find that out.

          The count is `releasing.size`, not the number of boxes the reviewer clicked: a
          tick on a parent releases its subtree, and a button that says "1" about five
          tickets understates the blast radius of its own click.
        */}
        {count > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || roots.length === 0}
            title={roots.length === 0 ? "Tick at least one queued item" : undefined}
            onClick={() => onApproveSelected(roots)}
          >
            Approve selected ({releasing.size})
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          // `aria-expanded` because this button controls the disclosure below it.
          aria-expanded={objection !== null}
          aria-controls={objectionId}
          // The contract rides on the button too, so a reviewer deciding whether to press
          // it can read the consequences without pressing it first.
          title={sendBackContract(identifier)}
          aria-description={sendBackContract(identifier)}
          onClick={() => setObjection((current) => (current === null ? "" : null))}
        >
          Send back
        </Button>
      </div>

      {objection !== null ? (
        <div id={objectionId} className="staple-gate-objection">
          {/*
            ABOVE the field, and rendered the moment the disclosure opens — before a single
            character is typed. That ordering is the whole fix: VP could not tell whether
            the note was processed or "just a comment", and the answer has to arrive before
            the decision to write one, not after.

            `aria-describedby` on the textarea rather than folding this into the label, so a
            screen reader announces the short label as the field's NAME and this as its
            description, in that order.
          */}
          <p id={`${objectionId}-help`} className="staple-gate-objection-help">
            {sendBackContract(identifier)}
          </p>
          <label htmlFor={`${objectionId}-input`} className="staple-gate-objection-label">
            Note to the agent
          </label>
          <Textarea
            id={`${objectionId}-input`}
            aria-describedby={`${objectionId}-help`}
            autoFocus
            rows={3}
            className="text-[12px]"
            value={objection}
            onChange={(event) => setObjection(event.target.value)}
          />
          <div className="staple-gate-actions">
            <Button
              size="sm"
              disabled={busy || objection.trim().length === 0}
              onClick={() => onRequestChanges(objection.trim())}
            >
              Send back with note
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setObjection(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
