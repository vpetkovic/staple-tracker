/**
 * An idea as a plan (design/plan.md, "Plan sections"): the sections an agent needs to build from
 * it, how each is stored, the shaped gate, and the importer for a plan written as markdown.
 *
 * Text and list sections are revisioned documents on the idea, versioned and synchronized as
 * documents already are. Text sections hold markdown; list sections hold one `- item` per line.
 * The task breakdown is structured: one row per proposed task, each with a stable id, stored and
 * synchronized one row at a time (`plan-rows.ts`), because a row's estimate, dependencies and
 * acceptance become a task's fields when the idea is scaffolded. Pure: no store.
 */
import { StapleError } from "./types.js";

/** One proposed task. `key` is how other rows depend on it (`42.1`); `id` is what never changes. */
export interface BreakdownRow {
  /** Stable for the row's life: a renamed key keeps it, and Scaffold names the row's task by it. */
  id: string;
  key: string;
  title: string;
  /** As written (`3h`, `1.5h`, `30 mins`, `2 days`, `2h30m`); `estimateSeconds` reads it. */
  estimate: string | null;
  /** Keys of other rows, or anything else it waits on (another plan, an outside event). */
  dependsOn: string[];
  /** Its own "done when"; null inherits the plan's acceptance criteria. */
  acceptance: string | null;
  owner: string | null;
  notes: string | null;
}

/** A row as any surface may send it: no id yet for a new row, fields left out read as empty. */
export type BreakdownRowInput = Partial<Omit<BreakdownRow, "dependsOn">> & { dependsOn?: string[] | string | null };

export interface PlanSections {
  goal: string | null;
  context: string | null;
  breakdown: BreakdownRow[];
  acceptance: string[];
  dependencies: string[];
  outOfScope: string | null;
  risks: string | null;
  sources: string[];
}

/** Sections to write: each given replaces that section whole; breakdown rows may lack an id. */
export type PlanPatch = Partial<Omit<PlanSections, "breakdown">> & { breakdown?: BreakdownRowInput[] };

/** The document key each document section is stored under. The breakdown is rows, not a document. */
export const SECTION_KEYS = {
  goal: "goal",
  context: "context",
  acceptance: "acceptance",
  dependencies: "dependencies",
  outOfScope: "out-of-scope",
  risks: "risks",
  sources: "sources",
} as const satisfies Record<Exclude<keyof PlanSections, "breakdown">, string>;

export type SectionName = keyof PlanSections;
export type DocumentSection = keyof typeof SECTION_KEYS;
export const DOCUMENT_SECTIONS = Object.keys(SECTION_KEYS) as DocumentSection[];
export const SECTION_NAMES: SectionName[] = ["goal", "context", "breakdown", "acceptance", "dependencies", "outOfScope", "risks", "sources"];
/** The key a raw document write must not use on a plan record: the breakdown lives in rows. */
export const BREAKDOWN_KEY = "breakdown";
/** Document keys whose body is a list, one `- item` per line. */
export const LIST_KEYS: ReadonlySet<string> = new Set([SECTION_KEYS.acceptance, SECTION_KEYS.dependencies, SECTION_KEYS.sources]);

/** The sections the shaped gate requires, in the order a person reads them. */
export const STARRED: readonly SectionName[] = ["goal", "breakdown", "acceptance"];

export function emptySections(): PlanSections {
  return { goal: null, context: null, breakdown: [], acceptance: [], dependencies: [], outOfScope: null, risks: null, sources: [] };
}

// ---------- storage ----------

const text = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null);
const LIST_ITEM = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/;

function readList(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => LIST_ITEM.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line.length > 0);
}

function writeList(items: readonly string[]): string {
  return items.length === 0 ? "" : items.map((item) => `- ${item}`).join("\n") + "\n";
}

/**
 * A list document's body, checked before it is written by a raw document write: every line that
 * is not blank is one `- item`. A body that is not a list would read as fewer items than it holds.
 */
export function assertListBody(key: string, body: string): void {
  const stray = body.split("\n").find((line) => line.trim() !== "" && !LIST_ITEM.test(line));
  if (stray !== undefined) {
    throw new StapleError("validation", `The ${key} section is a list, one "- item" per line; this line is not one: ${stray.trim().slice(0, 80)}`, { key });
  }
}

/** A row as stored and as accepted from any surface: trimmed, with a key and a title. Its id is kept when it has one. */
export function normalizeRow(raw: BreakdownRowInput | null | undefined): Omit<BreakdownRow, "id"> & { id: string | null } {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StapleError("validation", "A task breakdown row must be an object with at least a key or a title.");
  }
  const field = (name: string, value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" && typeof value !== "number") throw new StapleError("validation", `A task breakdown row's ${name} must be text.`);
    return text(String(value));
  };
  const key = field("key", raw.key) ?? "";
  const title = field("title", raw.title) ?? "";
  if (!key && !title) throw new StapleError("validation", "A task breakdown row needs a key or a title.");
  let dependsOn: string[];
  if (Array.isArray(raw.dependsOn)) {
    dependsOn = raw.dependsOn.map((item) => {
      if (typeof item !== "string" && typeof item !== "number") throw new StapleError("validation", "A task breakdown row's dependsOn must be a list of keys.");
      return String(item).trim();
    }).filter(Boolean);
  } else if (typeof raw.dependsOn === "string") {
    dependsOn = splitDepends(raw.dependsOn);
  } else if (raw.dependsOn === undefined || raw.dependsOn === null) {
    dependsOn = [];
  } else {
    throw new StapleError("validation", "A task breakdown row's dependsOn must be a list of keys.");
  }
  const id = raw.id === undefined || raw.id === null ? null : field("id", raw.id);
  return {
    id,
    key: key || title,
    title,
    estimate: field("estimate", raw.estimate),
    dependsOn,
    acceptance: field("acceptance", raw.acceptance),
    owner: field("owner", raw.owner),
    notes: field("notes", raw.notes),
  };
}

/** A document body for a document section, as stored. */
export function renderSection(name: DocumentSection, sections: PlanSections): string {
  switch (name) {
    case "acceptance":
    case "dependencies":
    case "sources":
      return writeList(sections[name]);
    default:
      return sections[name] ? `${sections[name]}\n` : "";
  }
}

/** A document section from its document body (null when the document does not exist). */
export function readSection<N extends DocumentSection>(name: N, body: string | null): PlanSections[N] {
  switch (name) {
    case "acceptance":
    case "dependencies":
    case "sources":
      return readList(body) as PlanSections[N];
    default:
      return text(body) as PlanSections[N];
  }
}

/**
 * A plan patch from any surface, checked whole before anything is written: each text section is
 * text or null, each list section a list of text, the breakdown a list of rows. A value of the
 * wrong shape is refused by name, never read as empty.
 */
export function checkPlanPatch(raw: unknown): PlanPatch {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new StapleError("validation", "plan must be an object of plan sections.");
  const input = raw as Record<string, unknown>;
  const known = new Set<string>(SECTION_NAMES);
  const unknown = Object.keys(input).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new StapleError("validation", `Unknown plan section${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. The sections are ${SECTION_NAMES.join(", ")}.`);
  const out: PlanPatch = {};
  for (const name of ["goal", "context", "outOfScope", "risks"] as const) {
    if (!(name in input)) continue;
    const value = input[name];
    if (value !== null && typeof value !== "string") throw new StapleError("validation", `plan.${name} must be text or null.`);
    out[name] = value as string | null;
  }
  for (const name of ["acceptance", "dependencies", "sources"] as const) {
    if (!(name in input)) continue;
    const value = input[name];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new StapleError("validation", `plan.${name} must be a list of text.`);
    out[name] = value as string[];
  }
  if ("breakdown" in input) {
    const value = input.breakdown;
    if (!Array.isArray(value)) throw new StapleError("validation", "plan.breakdown must be a list of rows {key, title, estimate, dependsOn, acceptance, owner, notes}.");
    for (const row of value) normalizeRow(row as BreakdownRowInput);
    out.breakdown = value as BreakdownRowInput[];
  }
  return out;
}

// ---------- the shaped gate ----------

export interface GateQuestion {
  text: string;
  resolved: boolean;
  deferred?: boolean;
}

/** The part of a key other rows of the same plan share: `42.` of `42.1`, nothing of `3`. */
const familyOf = (key: string): string => key.replace(/[0-9A-Za-z]+$/, "");
const KEYLIKE = /^[\w.-]{1,16}$/;

/**
 * A depends-on entry that names a row of this breakdown by its shape but matches none: a typo
 * of a key, not something outside the plan. `42.9` in a plan of `42.x` rows, `7` in a plan of
 * numbered rows. `PLAN-3` or `39.4` (another plan's) wait outside it.
 */
export function unknownKeys(rows: readonly Pick<BreakdownRow, "key" | "dependsOn">[]): Array<{ key: string; dep: string }> {
  const keys = new Set(rows.map((row) => row.key));
  const families = new Set(rows.map((row) => familyOf(row.key)));
  const out: Array<{ key: string; dep: string }> = [];
  for (const row of rows) {
    for (const dep of row.dependsOn) {
      if (keys.has(dep) || !KEYLIKE.test(dep)) continue;
      const family = familyOf(dep);
      if (family === dep) continue;
      if (families.has(family) && (family !== "" || /^\d+$/.test(dep))) out.push({ key: row.key, dep });
    }
  }
  return out;
}

/** Each depends-on cycle among the rows, as the keys around it (`["1", "2", "1"]`). A row waiting on itself is one. */
export function dependencyCycles(rows: readonly Pick<BreakdownRow, "key" | "dependsOn">[]): string[][] {
  const keys = new Set(rows.map((row) => row.key));
  const edges = new Map<string, string[]>();
  for (const row of rows) edges.set(row.key, [...new Set([...(edges.get(row.key) ?? []), ...row.dependsOn.filter((dep) => keys.has(dep))])]);
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (seen.has(key)) {
      const from = path.indexOf(key);
      cycles.push([...path.slice(from), key]);
      return;
    }
    seen.add(key);
    path.push(key);
    for (const next of edges.get(key) ?? []) visit(next);
    path.pop();
    done.add(key);
  };
  for (const row of rows) visit(row.key);
  return cycles;
}

/** The breakdown's rows in an order where every row comes after the rows it waits on (cycles refused first). */
export function dependencyOrder<R extends Pick<BreakdownRow, "key" | "dependsOn">>(rows: readonly R[]): R[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const out: R[] = [];
  const placed = new Set<R>();
  const place = (row: R, depth = 0): void => {
    if (placed.has(row) || depth > rows.length) return;
    for (const dep of row.dependsOn) {
      const before = byKey.get(dep);
      if (before && before !== row) place(before, depth + 1);
    }
    if (!placed.has(row)) {
      placed.add(row);
      out.push(row);
    }
  };
  for (const row of rows) place(row);
  return out;
}

/**
 * What an idea's plan lacks before it is shaped, or before a shaped idea may be scaffolded or
 * promoted: a goal; a task breakdown of at least one row, every row titled, no two rows on one
 * key, no row waiting on a key the breakdown does not hold, no depends-on cycle; acceptance
 * criteria; and no open question that is not explicitly deferred. A row without its own "done
 * when" inherits the plan's acceptance criteria, so it needs none. An umbrella, a record with a
 * sub-idea that is not dropped, needs no rows of its own: its sub-ideas are its breakdown. Empty
 * when it passes.
 */
export function shapedGate(sections: PlanSections, questions: readonly GateQuestion[], record: { subIdea?: boolean } = {}): string[] {
  const missing: string[] = [];
  if (!sections.goal) missing.push("a goal");
  if (sections.breakdown.length === 0 && !record.subIdea) missing.push("a task breakdown");
  const counts = new Map<string, number>();
  for (const row of sections.breakdown) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  for (const [key, count] of counts) if (count > 1) missing.push(`one key per task (${count} tasks share ${key})`);
  for (const row of sections.breakdown) if (!row.title) missing.push(`a title on task ${row.key}`);
  for (const { key, dep } of unknownKeys(sections.breakdown)) missing.push(`task ${key} to wait on a task that exists (${dep} is not in the breakdown)`);
  for (const cycle of dependencyCycles(sections.breakdown)) missing.push(`no depends-on cycle (${cycle.join(" → ")})`);
  if (sections.acceptance.length === 0) missing.push("acceptance criteria");
  const open = questions.filter((q) => !q.resolved && !q.deferred).length;
  if (open > 0) missing.push(`${open} open question${open === 1 ? "" : "s"} answered or deferred`);
  return missing;
}

/** The gate's refusal sentence, listing at most a few of what is missing. */
export function gateSentence(missing: readonly string[]): string {
  const shown = missing.slice(0, 4);
  const rest = missing.length - shown.length;
  const listed = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown.join("");
  return `it needs ${listed} before it is shaped`;
}

/** What the plan holds that is worth a look but does not stop it: estimates that are not durations. */
export function planWarnings(sections: PlanSections): string[] {
  const out: string[] = [];
  for (const row of sections.breakdown) {
    const problem = estimateProblem(row.estimate);
    if (problem) out.push(`task ${row.key}: ${problem}`);
  }
  return out;
}

/** How much of the plan is written: the three starred sections, and all ten sections. */
export function completeness(sections: PlanSections, questions: readonly GateQuestion[], decisions: readonly string[]): { starred: number; starredTotal: number; filled: number; total: number } {
  const has: Record<string, boolean> = {
    goal: Boolean(sections.goal),
    context: Boolean(sections.context),
    decisions: decisions.length > 0,
    questions: questions.length > 0,
    breakdown: sections.breakdown.length > 0,
    acceptance: sections.acceptance.length > 0,
    dependencies: sections.dependencies.length > 0,
    outOfScope: Boolean(sections.outOfScope),
    risks: Boolean(sections.risks),
    sources: sections.sources.length > 0,
  };
  return {
    starred: STARRED.filter((name) => has[name]).length,
    starredTotal: STARRED.length,
    filled: Object.values(has).filter(Boolean).length,
    total: Object.keys(has).length,
  };
}

// ---------- estimates and dependencies ----------

/** A plan's working day and week: an estimate is effort, so `1d` is eight hours and `1w` five days. */
const UNIT_SECONDS: Array<[RegExp, number]> = [
  [/^(w|wks?|weeks?)$/, 5 * 8 * 3600],
  [/^(d|days?)$/, 8 * 3600],
  [/^(h|hrs?|hours?)$/, 3600],
  [/^(m|mins?|minutes?)$/, 60],
  [/^(s|secs?|seconds?)$/, 1],
];
const MAX_ESTIMATE = 365 * 86400;
const PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/y;

function readDuration(source: string): number | null {
  const clean = source.toLowerCase().replace(/^[~≈]\s*/, "").trim();
  // A range (`2-3h`, `2 to 3 hours`) is planned at its top.
  const range = /^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?\s*[a-z].*)$/.exec(clean);
  if (range) return readDuration(range[2]!);
  let total = 0;
  let at = 0;
  let parts = 0;
  while (at < clean.length) {
    PART.lastIndex = at;
    const match = PART.exec(clean);
    if (!match) break;
    const unit = UNIT_SECONDS.find(([pattern]) => pattern.test(match[2]!));
    if (!unit) break;
    total += Number(match[1]) * unit[1];
    parts += 1;
    at = PART.lastIndex;
    while (clean[at] === " " || clean[at] === ",") at += 1;
    if (clean.startsWith("and ", at)) at += 4;
  }
  if (parts === 0) return null;
  // What follows the duration is a note (`3h (incl. review)`); a word glued to it is not a unit.
  const rest = clean.slice(at);
  if (rest !== "" && clean[at - 1] !== " " && !/^[(;:,]/.test(rest)) return null;
  return Math.round(total);
}

/**
 * An estimate as written into seconds: `3h`, `3 hours`, `3hrs`, `30m`, `30 mins`, `90s`,
 * `2h30m`, `1.5d`, `2 days`, `1w`, `~4h`, `2-3h` (its top). Null when it is not a duration, or
 * none was written; `estimateProblem` says which.
 */
export function estimateSeconds(estimate: string | null): number | null {
  if (!estimate || !estimate.trim()) return null;
  const seconds = readDuration(estimate.trim());
  return seconds !== null && seconds > 0 && seconds <= MAX_ESTIMATE ? seconds : null;
}

/** Why an estimate that was written reads as no estimate; null when it reads, or none was written. */
export function estimateProblem(estimate: string | null): string | null {
  if (!estimate || !estimate.trim()) return null;
  const seconds = readDuration(estimate.trim());
  if (seconds === null) {
    return /^\d+(\.\d+)?$/.test(estimate.trim())
      ? `the estimate "${estimate}" has no unit (write 3h, 30m, 2d or 1w)`
      : `the estimate "${estimate}" is not a duration (write 3h, 30m, 2d or 1w)`;
  }
  if (seconds <= 0) return `the estimate "${estimate}" is zero`;
  if (seconds > MAX_ESTIMATE) return `the estimate "${estimate}" is more than a year`;
  return null;
}

/** A depends-on cell (`40.6, 40.7`, `—`, `none`) as its items. */
export function splitDepends(cell: string): string[] {
  const clean = cell.replace(/\*\*/g, "").trim();
  if (!clean || /^(—|-|–|none|n\/a)$/i.test(clean)) return [];
  return clean
    .split(/\s*[,;]\s*|\s+and\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !/^(—|-|–)$/.test(item));
}

// ---------- import ----------

export interface ImportedRow extends Omit<BreakdownRow, "id"> {}

export interface ImportResult {
  title: string;
  brief: string | null;
  sections: Omit<PlanSections, "breakdown"> & { breakdown: ImportedRow[] };
  questions: GateQuestion[];
  decisions: string[];
  /** What the importer could not place where it belongs, and where it kept it instead. Empty when everything was placed. */
  warnings: string[];
}

type Target = SectionName | "questions" | "decisions";

/** Which section a heading's words belong to; null for anything else (it lands in Context). */
export function sectionOfHeading(heading: string): Target | null {
  const words = heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/^[\d.\s]+/, "")
    .trim();
  if (/^goals?\b/.test(words)) return "goal";
  if (/\b(task|step|work)\s+breakdown\b|^breakdown\b|^tasks\b/.test(words)) return "breakdown";
  if (/acceptance/.test(words)) return "acceptance";
  if (/out of scope/.test(words)) return "outOfScope";
  if (/\brisks?\b/.test(words)) return "risks";
  if (/\bopen questions?\b|^questions\b/.test(words)) return "questions";
  if (/\bdependenc/.test(words)) return "dependencies";
  if (/\bdecisions?\b|\bruling\b/.test(words)) return "decisions";
  if (/^sources?\b|^references?\b/.test(words)) return "sources";
  return null;
}

/** The cells of a markdown table row, or null when the line is not one. `\|` is a pipe inside a cell. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const out: string[] = [];
  let cell = "";
  for (let at = 1; at < trimmed.length; at += 1) {
    const char = trimmed[at]!;
    if (char === "\\" && trimmed[at + 1] === "|") {
      cell += "|";
      at += 1;
    } else if (char === "|") {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.trim() !== "") out.push(cell.trim());
  return out;
}

const isDivider = (row: string[]) => row.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === "");

/** Which column of a breakdown table holds what, from its header row. */
function columnsOf(header: string[]): Record<"key" | "title" | "estimate" | "depends" | "acceptance" | "owner" | "notes", number> {
  const find = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell.toLowerCase().replace(/[*`]/g, "")));
  const key = find(/^(#|id|key|step)$/);
  const title = find(/^(task|title|step|what|work)\b/);
  return {
    key: key >= 0 ? key : 0,
    title: title >= 0 && title !== key ? title : key >= 0 ? key + 1 : 1,
    estimate: find(/^(est|estimate|effort|size)/),
    depends: find(/^(depend|blocked|after|needs)/),
    acceptance: find(/^(accept|done when|definition)/),
    owner: find(/^(owner|who|agent|assignee)/),
    notes: find(/^(notes?|comment|remarks?)/),
  };
}

const unmark = (cell: string | undefined): string => (cell ?? "").replace(/\*\*(.*?)\*\*/g, "$1").trim();
const cellOrNull = (cell: string | undefined): string | null => {
  const value = unmark(cell);
  return value && !/^(—|-|–)$/.test(value) ? value : null;
};

const FENCE = /^\s*(```|~~~)/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX~])\]\s+)?(.*)$/;

interface ListRead {
  items: Array<{ checked: string | undefined; text: string }>;
  /** Lines that are neither an item nor part of one: prose under a list heading. */
  prose: string[];
}

/**
 * The items of a list section. A wrapped line continues the item above it; a nested item is
 * folded into its parent (`parent; nested`), so nothing is lost and each item stays one line.
 * Anything before the first item, or after a blank line and not indented, is prose.
 */
function readItems(block: readonly string[]): ListRead {
  const items: ListRead["items"] = [];
  const prose: string[] = [];
  let top: number | null = null;
  let current: ListRead["items"][number] | null = null;
  let blank = false;
  let fenced = false;
  for (const line of block) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line)) {
      prose.push(line);
      current = null;
      continue;
    }
    if (line.trim() === "") {
      blank = true;
      continue;
    }
    const item = ITEM.exec(line);
    const indent = line.length - line.trimStart().length;
    if (item) {
      if (top === null) top = item[1]!.length;
      if (item[1]!.length > top && current) {
        current.text = `${current.text}; ${item[3]!.trim()}`;
      } else {
        current = { checked: item[2], text: item[3]!.trim() };
        items.push(current);
      }
      blank = false;
      continue;
    }
    if (current && (!blank || indent > (top ?? 0))) {
      current.text = `${current.text} ${line.trim()}`;
      blank = false;
      continue;
    }
    prose.push(line);
    current = null;
    blank = false;
  }
  return { items: items.filter((item) => item.text.length > 0), prose };
}

/**
 * A plan file into an idea's sections. Headings decide the section (Goal, Task breakdown,
 * Acceptance criteria, Out of scope, Risk, Open questions, Dependencies, Decisions, Sources);
 * every other heading's text lands in Context under its own heading. Anything a section cannot
 * hold (prose under a list heading, a table row without a key, a key a table already gave) is
 * kept in Context too and named in `warnings`, so nothing is dropped. Breakdown tables are read
 * by their header row; a numbered list like `42.1 — Title` works too. Code fences are text, never
 * headings. Front matter is kept in Context; the first `#` heading is the title.
 */
export function parsePlanMarkdown(markdown: string, fallbackTitle = "Imported plan"): ImportResult {
  const warnings: string[] = [];
  let body = markdown.replace(/\r\n?/g, "\n");
  const context: string[] = [];
  const front = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (front) {
    body = body.slice(front[0].length);
    if (front[1]!.trim()) context.push(`## Front matter\n\n\`\`\`yaml\n${front[1]!.trim()}\n\`\`\``);
  }
  const lines = body.split("\n");

  let title: string | null = null;
  const preamble: string[] = [];
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  let fenced = false;
  for (const line of lines) {
    const fence = FENCE.test(line);
    const heading = fenced || fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (fence) fenced = !fenced;
    if (heading && heading[1]!.length === 1 && title === null) {
      title = heading[2]!.trim();
      continue;
    }
    if (heading && heading[1]!.length === 2) {
      blocks.push({ heading: heading[2]!.trim(), lines: [] });
      continue;
    }
    if (blocks.length === 0) preamble.push(line);
    else blocks.at(-1)!.lines.push(line);
  }

  const sections: ImportResult["sections"] = { ...emptySections(), breakdown: [] };
  const questions: GateQuestion[] = [];
  const decisions: string[] = [];
  const brief = preamble.join("\n").trim() || null;
  const keep = (heading: string, lines: readonly string[], why: string | null) => {
    const kept = lines.join("\n").trim();
    if (!kept) return;
    context.push(`## ${heading}\n\n${kept}`);
    if (why) warnings.push(`"${heading}": ${why}; kept in Context`);
  };
  const listOf = (block: { heading: string; lines: string[] }, what: string): string[] => {
    const read = readItems(block.lines);
    keep(block.heading, read.prose, read.items.length === 0 ? `not a list of ${what}` : `prose beside its ${what}`);
    return read.items.map((item) => item.text);
  };

  for (const block of blocks) {
    const target = sectionOfHeading(block.heading);
    const raw = block.lines.join("\n").trim();
    switch (target) {
      case "goal":
        sections.goal = [sections.goal, raw].filter(Boolean).join("\n\n") || null;
        break;
      case "outOfScope":
        sections.outOfScope = [sections.outOfScope, raw].filter(Boolean).join("\n\n") || null;
        break;
      case "risks":
        sections.risks = [sections.risks, raw].filter(Boolean).join("\n\n") || null;
        break;
      case "acceptance":
        sections.acceptance.push(...listOf(block, "criteria"));
        break;
      case "dependencies":
        sections.dependencies.push(...listOf(block, "dependencies"));
        break;
      case "sources":
        sections.sources.push(...listOf(block, "sources"));
        break;
      case "questions": {
        const read = readItems(block.lines);
        for (const item of read.items) questions.push({ text: item.text, resolved: item.checked === "x" || item.checked === "X", deferred: item.checked === "~" });
        keep(block.heading, read.prose, read.items.length === 0 ? "not a list of questions" : "prose beside its questions");
        break;
      }
      case "decisions": {
        // A decision section is prose: kept whole in Context; each subsection heading, or each top-level item, is a decision.
        let inFence = false;
        for (const line of block.lines) {
          if (FENCE.test(line)) inFence = !inFence;
          if (inFence) continue;
          const sub = /^###\s+(.*)$/.exec(line);
          if (sub) decisions.push(sub[1]!.replace(/^[\d.\s]+/, "").trim());
        }
        if (decisions.length === 0) decisions.push(...readItems(block.lines).items.map((item) => item.text));
        if (raw) context.push(`## ${block.heading}\n\n${raw}`);
        break;
      }
      case "breakdown": {
        const before = sections.breakdown.length;
        const unplaced = parseBreakdown(block.lines, sections.breakdown, warnings);
        const prose = block.lines.filter((line) => !line.trim().startsWith("|")).join("\n").trim();
        const notes = [prose, ...unplaced].filter(Boolean).join("\n\n");
        if (notes) context.push(`## ${block.heading} (notes)\n\n${notes}`);
        if (sections.breakdown.length === before) warnings.push(`"${block.heading}" holds no task rows; kept in Context`);
        break;
      }
      default:
        if (raw) context.push(`## ${block.heading}\n\n${raw}`);
    }
  }
  sections.context = context.join("\n\n") || null;
  // Rows that wait on something outside the plan: the plan's dependencies, once each.
  const keys = new Set(sections.breakdown.map((row) => row.key));
  const typos = new Set(unknownKeys(sections.breakdown).map((entry) => entry.dep));
  for (const row of sections.breakdown) {
    for (const dep of row.dependsOn) if (!keys.has(dep) && !typos.has(dep) && !sections.dependencies.includes(dep)) sections.dependencies.push(dep);
  }
  for (const { key, dep } of unknownKeys(sections.breakdown)) warnings.push(`task ${key} waits on ${dep}, which is not in the breakdown`);
  for (const row of sections.breakdown) {
    const problem = estimateProblem(row.estimate);
    if (problem) warnings.push(`task ${row.key}: ${problem}`);
  }
  return { title: title ?? fallbackTitle, brief, sections, questions, decisions, warnings };
}

/** Breakdown rows into `rows`; answers the table lines it could not place, to keep in Context. */
function parseBreakdown(lines: readonly string[], rows: ImportedRow[], warnings: string[]): string[] {
  const unplaced: string[] = [];
  let header: ReturnType<typeof columnsOf> | null = null;
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const row = fenced ? null : cells(line);
    if (row === null) {
      header = null;
      if (fenced) continue;
      const listed = /^\s*(?:[-*]\s+)?\*{0,2}(\d+\.\d+[a-z]?)\*{0,2}\s*[—–:-]\s+(.*)$/.exec(line);
      // A list-style row. A key a table already gave is a note about that row; the line stays in the notes.
      if (listed && !rows.some((existing) => existing.key === listed[1])) {
        rows.push({ key: listed[1]!, title: unmark(listed[2]), estimate: null, dependsOn: [], acceptance: null, owner: null, notes: null });
      }
      continue;
    }
    if (isDivider(row)) continue;
    if (header === null) {
      header = columnsOf(row);
      continue;
    }
    const key = cellOrNull(row[header.key]);
    const title = cellOrNull(row[header.title]);
    if (!key || !title) {
      warnings.push(`a breakdown row without ${!key ? "a key" : "a title"}; kept in Context: ${line.trim().slice(0, 80)}`);
      unplaced.push(line.trim());
      continue;
    }
    if (rows.some((existing) => existing.key === key)) {
      warnings.push(`task ${key} appears twice; the first is the task, the second is kept in Context`);
      unplaced.push(line.trim());
      continue;
    }
    const at = (index: number) => (index >= 0 ? cellOrNull(row[index]) : null);
    const columns = new Set(Object.values(header));
    rows.push({
      key,
      title,
      estimate: at(header.estimate),
      dependsOn: header.depends >= 0 ? splitDepends(unmark(row[header.depends])) : [],
      acceptance: at(header.acceptance),
      owner: at(header.owner),
      notes: [at(header.notes), ...row.map((_, index) => index).filter((index) => !columns.has(index)).map(at)].filter(Boolean).join(" · ") || null,
    });
  }
  return unplaced;
}

// ---------- dependencies between records ----------

/** A reference key: capitals with a number, as plans name their parts (`C2`, `R4`, `EPIC-40`, `TST-12`). */
const REF_KEY = /^[A-Z]{1,8}-?\d+(?:\.\d+)*$/;
/** A breakdown row's key, as another plan's depends-on cell names it (`42.1`). */
const ROW_KEY = /^\d+(?:\.\d+)+$/;

function tokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9.-]+/).map((token) => token.replace(/^[.-]+|[.-]+$/g, "")).filter(Boolean);
}

/** The references a text leads with: its first words while each is a key. "C2 and C3 land first" leads with C2 only. */
function leadingKeys(text: string, keyShape: (token: string) => boolean): string[] {
  const out: string[] = [];
  for (const token of tokens(text)) {
    if (!keyShape(token)) break;
    out.push(token);
  }
  return out;
}

const isReference = (token: string) => REF_KEY.test(token) || ROW_KEY.test(token);

/** A record as dependencies name it: its ticket number, its title, its own breakdown rows' keys, and the record above it. */
export interface DependencyRecord {
  id: string;
  identifier: string | null;
  title: string;
  rowKeys?: readonly string[];
  parentId?: string | null;
}

/**
 * The names a plan uses for a record: its ticket number once it has one, and the keys its title
 * leads with (`C2 Checkout API` is C2, `R2 · EPIC-40 — Exercise API` is R2 and EPIC-40). A word
 * further into a title, or one that is not a key (`OAuth2`), names nothing.
 */
export function recordKeys(record: Pick<DependencyRecord, "identifier" | "title">): string[] {
  const keys = new Set<string>();
  if (record.identifier) keys.add(record.identifier);
  for (const key of leadingKeys(record.title, (token) => REF_KEY.test(token))) keys.add(key);
  return [...keys];
}

/**
 * Which records a record waits on. Only an explicit reference counts: a dependency line, or a
 * depends-on cell naming something outside its own breakdown, that LEADS with a record's ticket
 * number, a key its title leads with, or the key of a row in exactly one other record's
 * breakdown. Anything else is prose, whatever words with digits it holds. A key two records share
 * names neither, with one exception: a key that names one record by its title and otherwise only
 * rows of that record's own ancestors names the record (an umbrella keys its rows like its
 * sub-ideas, and the sub-idea is the one meant). A record never waits on itself, its ancestors or
 * its descendants: a parent's work holds its sub-ideas', so either wait is a cycle, and its own
 * rows' keys in its own text name its own rows.
 */
export function resolveDependencies(self: string, sections: Pick<PlanSections, "dependencies" | "breakdown">, records: ReadonlyArray<DependencyRecord>): string[] {
  return dependencyResolver(records)(self, sections);
}

/** The same resolution with the records' keys indexed once, for a view that resolves every record. */
export function dependencyResolver(records: ReadonlyArray<DependencyRecord>): (self: string, sections: Pick<PlanSections, "dependencies" | "breakdown">) => string[] {
  const named = new Map<string, Set<string>>();
  const rows = new Map<string, Set<string>>();
  const own = (index: Map<string, Set<string>>, key: string, id: string) => {
    const set = index.get(key) ?? new Set<string>();
    set.add(id);
    index.set(key, set);
  };
  for (const record of records) {
    for (const key of recordKeys(record)) own(named, key, record.id);
    for (const key of record.rowKeys ?? []) own(rows, key, record.id);
  }
  const parentOf = new Map(records.map((record) => [record.id, record.parentId ?? null]));
  const isAncestor = (ancestor: string, of: string): boolean => {
    const seen = new Set<string>();
    for (let at = parentOf.get(of) ?? null; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
      if (at === ancestor) return true;
      seen.add(at);
    }
    return false;
  };
  const owners = new Map<string, string>();
  for (const key of new Set([...named.keys(), ...rows.keys()])) {
    const byTitle = [...(named.get(key) ?? [])];
    const byRow = [...(rows.get(key) ?? [])];
    const all = new Set([...byTitle, ...byRow]);
    if (all.size === 1) owners.set(key, [...all][0]!);
    else if (byTitle.length === 1 && byRow.every((id) => isAncestor(id, byTitle[0]!))) owners.set(key, byTitle[0]!);
  }
  const related = (a: string, b: string) => a === b || isAncestor(a, b) || isAncestor(b, a);
  return (self, sections) => resolveWith(owners, related, self, sections);
}

function resolveWith(
  owners: ReadonlyMap<string, string>,
  related: (a: string, b: string) => boolean,
  self: string,
  sections: Pick<PlanSections, "dependencies" | "breakdown">,
): string[] {
  const rowKeys = new Set(sections.breakdown.map((row) => row.key));
  const texts = [...sections.dependencies, ...sections.breakdown.flatMap((row) => row.dependsOn.filter((dep) => !rowKeys.has(dep)))];
  const out: string[] = [];
  for (const text of texts) {
    for (const key of leadingKeys(text, isReference)) {
      const id = owners.get(key);
      if (id !== undefined && !related(id, self) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}
