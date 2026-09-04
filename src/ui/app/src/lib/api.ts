export const getMilestones = (params: { ws?: string; all?: boolean } = {}) =>
  request<MilestoneListRow[]>(`/api/milestones${qs({ ws: params.ws, all: params.all ? "1" : undefined })}`);

export const getMilestone = (params: { ws?: string; ref: string }) =>
  request<MilestoneView>(`/api/milestone${qs(params)}`);

/**
 * Every write answers with the same `MilestoneView` a read does, and every membership
 * write carries `baseRevision` — the CAS the store checks before touching the order. A
 * stale base is `revision_conflict` (409) and the order is untouched.
 */
const milestoneWrite = (route: string, body: Record<string, unknown>) =>
  request<MilestoneView>(`/api/milestone/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

export const addMilestoneMember = (target: {
  ws?: string;
  milestone: string;
  ref: string;
  baseRevision: number;
  before?: string;
  after?: string;
  at?: number;
  note?: string;
}) => milestoneWrite("add", target);

export const removeMilestoneMember = (target: { ws?: string; milestone: string; ref: string; baseRevision: number }) =>
  milestoneWrite("remove", target);

export const reorderMilestoneMembers = (target: {
  ws?: string;
  milestone: string;
  order: readonly string[];
  baseRevision: number;
}) => milestoneWrite("reorder", target);

// ---------- the glyph sanitiser (R5d / STA-184) ----------

/**
 * Sanitise a custom SVG glyph. The store accepts an `svg` appearance ONLY as the
 * sanitiser's canonical output, and the sanitiser is core code the browser cannot
 * import — so the raw document goes here first, and what comes back is the only
 * thing the picker ever offers as a choice. A refusal is the sanitiser's own sentence
 * through the usual envelope, which `describeRefusal` renders. Same-origin POST, like
 * every write, although it writes nothing: it is a pure function over the body.
 */
export const sanitizeGlyphSvg = (input: { svg: string; label?: string }) =>
  request<{ svg: string; viewBox: string; label: string }>("/api/glyph/sanitize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

// ---------- the pickup queue (R2d / STA-169) ----------

/**
 * The plan and the effective order, in ONE payload — `{revision, entries, effective}`.
 * `all` includes resolved entries, the way `getMilestones({all})` includes resolved
 * milestones; the editor ties it to the page's "show done" so one switch governs both.
 */
export const getQueue = (params: { ws?: string; all?: boolean } = {}) =>
  request<QueueView>(`/api/queue${qs({ ws: params.ws, all: params.all ? "1" : undefined })}`);

/**
 * Every queue write answers with the same `QueueView` a read does, and every one of them
 * carries `baseRevision` — the CAS the store checks before touching the plan. A stale
 * base is `revision_conflict` (409, `detail.currentRevision`) and the plan is untouched,
 * which is what lets the editor restore the server order and offer a deliberate retry
 * rather than silently replaying a write against an order it has not seen.
 *
 * The route names are the HTTP spelling from docs/queue.md "Operations, by surface"
 * (`enqueue`/`remove`), NOT the CLI's shorter verbs (`add`/`rm`). `/api/queue/move` and
 * `/api/queue/next` have no function here because nothing calls them: the editor's every
 * move is a bulk `reorder` (see views/queue/QueueView.tsx), and with no actor the next
 * item is the first `eligible` row of the `effective` list the page already holds.
 */
const queueWrite = (route: string, body: Record<string, unknown>) =>
  request<QueueView>(`/api/queue/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "ui", ...body }),
  });

/** Put an issue, epic or milestone in the plan. `at` is a 1-based plan position. */
export const enqueueTask = (target: {
  ws?: string;
  ref: string;
  baseRevision: number;
  before?: string;
  after?: string;
  at?: number;
  note?: string;
}) => queueWrite("enqueue", target);

export const dequeueTask = (target: { ws?: string; ref: string; baseRevision: number }) =>
  queueWrite("remove", target);

/**
 * THE ONE ATOMIC REORDER. Drag and every keyboard move in the editor land here — one
 * call, one transaction, one revision bump — so the two input methods cannot drift into
 * two write paths that disagree about what a move is.
 */
export const reorderQueue = (target: { ws?: string; order: readonly string[]; baseRevision: number }) =>
  queueWrite("reorder", target);

/** Drop every resolved entry. `all` is not a thing here: prune takes the whole plan. */
export const pruneQueue = (target: { ws?: string; baseRevision: number }) => queueWrite("prune", target);
