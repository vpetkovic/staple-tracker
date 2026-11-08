/**
 * An idea as a plan (design/plan.md, "Plan sections"): the sections an agent needs to build from
 * it, how each is stored, the shaped gate, and the importer for a plan written as markdown.
 *
 * Each section is a revisioned document on the idea, so it is versioned and synchronized as
 * documents already are. Text sections hold markdown; list sections hold one `- item` per line;
 * the task breakdown is structured, a JSON array of rows, because a row's estimate, dependencies
 * and acceptance become a task's fields when the idea is scaffolded. Pure: no store.
 */

/** One proposed task. `key` is how other rows depend on it (`42.1`). */
export interface BreakdownRow {
  key: string;
  title: string;
  /** As written (`3h`, `1.5h`, `30m`, `2d`); `estimateSeconds` reads it. */
  estimate: string | null;
  /** Keys of other rows, or anything else it waits on (another plan, an outside event). */
  dependsOn: string[];
  acceptance: string | null;
  owner: string | null;
  notes: string | null;
}

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

/** The document key each section is stored under. Questions, decisions and the brief keep theirs. */
export const SECTION_KEYS = {
  goal: "goal",
  context: "context",
  breakdown: "breakdown",
  acceptance: "acceptance",
  dependencies: "dependencies",
  outOfScope: "out-of-scope",
  risks: "risks",
  sources: "sources",
} as const satisfies Record<keyof PlanSections, string>;

export type SectionName = keyof PlanSections;
export const SECTION_NAMES = Object.keys(SECTION_KEYS) as SectionName[];

/** The sections the shaped gate requires, in the order a person reads them. */
export const STARRED: readonly SectionName[] = ["goal", "breakdown", "acceptance"];

export function emptySections(): PlanSections {
  return { goal: null, context: null, breakdown: [], acceptance: [], dependencies: [], outOfScope: null, risks: null, sources: [] };
}

// ---------- storage ----------

const text = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null);

function readList(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line.length > 0);
}

function writeList(items: readonly string[]): string {
  return items.length === 0 ? "" : items.map((item) => `- ${item}`).join("\n") + "\n";
}

function readRows(body: string | null): BreakdownRow[] {
  if (!body || !body.trim()) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw) => normalizeRow(raw as Partial<BreakdownRow>)).filter((row): row is BreakdownRow => row !== null);
  } catch {
    return [];
  }
}

/** A row as stored and as accepted from any surface: trimmed, with a key and a title. */
export function normalizeRow(raw: Partial<BreakdownRow> | null | undefined): BreakdownRow | null {
  if (!raw) return null;
  const key = String(raw.key ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!key && !title) return null;
  const list = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.map((item) => String(item).trim()).filter(Boolean)
    : typeof raw.dependsOn === "string"
      ? splitDepends(raw.dependsOn)
      : [];
  return {
    key: key || title,
    title,
    estimate: text(raw.estimate ?? null),
    dependsOn: list,
    acceptance: text(raw.acceptance ?? null),
    owner: text(raw.owner ?? null),
    notes: text(raw.notes ?? null),
  };
}

/** A document body for a section, as stored. */
export function renderSection(name: SectionName, sections: PlanSections): string {
  switch (name) {
    case "breakdown":
      return sections.breakdown.length === 0 ? "" : JSON.stringify(sections.breakdown, null, 2) + "\n";
    case "acceptance":
    case "dependencies":
    case "sources":
      return writeList(sections[name]);
    default:
      return sections[name] ? `${sections[name]}\n` : "";
  }
}

/** A section from its document body (null when the document does not exist). */
export function readSection<N extends SectionName>(name: N, body: string | null): PlanSections[N] {
  switch (name) {
    case "breakdown":
      return readRows(body) as PlanSections[N];
    case "acceptance":
    case "dependencies":
    case "sources":
      return readList(body) as PlanSections[N];
    default:
      return text(body) as PlanSections[N];
  }
}

// ---------- the shaped gate ----------

export interface GateQuestion {
  text: string;
  resolved: boolean;
  deferred?: boolean;
}

/**
 * What an idea still lacks before it may be marked shaped: a goal; a task breakdown of at least
 * one row, every row with a title and acceptance; acceptance criteria; and no open question
 * that is not explicitly deferred. Empty when it may be shaped. Each entry is one plain phrase.
 */
export function shapedGate(sections: PlanSections, questions: readonly GateQuestion[]): string[] {
  const missing: string[] = [];
  if (!sections.goal) missing.push("a goal");
  if (sections.breakdown.length === 0) missing.push("a task breakdown");
  for (const row of sections.breakdown) {
    if (!row.title) missing.push(`a title on task ${row.key}`);
    if (!row.acceptance) missing.push(`acceptance on task ${row.key}`);
  }
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

/** `3h`, `1.5h`, `30m`, `2d` (an 8-hour day), `~4h` → seconds; null when it is not a duration. */
export function estimateSeconds(estimate: string | null): number | null {
  if (!estimate) return null;
  const match = /^~?\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)\b/i.exec(estimate.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const seconds = unit.startsWith("m") ? value * 60 : unit === "d" ? value * 8 * 3600 : value * 3600;
  return Math.round(seconds);
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

export interface ImportResult {
  title: string;
  brief: string | null;
  sections: PlanSections;
  questions: GateQuestion[];
  decisions: string[];
  /** Lines the importer could not place, with why. Empty when nothing was lost. */
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

/** The cells of a markdown table row, or null when the line is not one. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
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

/**
 * A plan file into an idea's sections. Headings decide the section (Goal, Task breakdown,
 * Acceptance criteria, Out of scope, Risk, Open questions, Dependencies, Decisions, Sources);
 * every other heading's text lands in Context under its own heading, so nothing is dropped.
 * Breakdown tables are read by their header row; a numbered list like `42.1 — Title` works
 * too. Front matter is skipped; the first `#` heading is the title.
 */
export function parsePlanMarkdown(markdown: string, fallbackTitle = "Imported plan"): ImportResult {
  const warnings: string[] = [];
  let body = markdown.replace(/\r\n/g, "\n");
  const front = /^---\n[\s\S]*?\n---\n/.exec(body);
  if (front) body = body.slice(front[0].length);
  const lines = body.split("\n");

  let title: string | null = null;
  const preamble: string[] = [];
  const blocks: Array<{ heading: string; level: number; lines: string[] }> = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1]!.length === 1 && title === null) {
      title = heading[2]!.trim();
      continue;
    }
    if (heading && heading[1]!.length === 2) {
      blocks.push({ heading: heading[2]!.trim(), level: 2, lines: [] });
      continue;
    }
    if (blocks.length === 0) preamble.push(line);
    else blocks.at(-1)!.lines.push(line);
  }

  const sections = emptySections();
  const questions: GateQuestion[] = [];
  const decisions: string[] = [];
  const context: string[] = [];
  const brief = preamble.join("\n").trim() || null;

  const listItems = (block: string[]) =>
    block
      .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX~])\]\s+)?(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ checked: match[1], text: match[2]!.trim() }));

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
      case "acceptance": {
        const items = listItems(block.lines).map((item) => item.text);
        if (items.length === 0 && raw) warnings.push(`"${block.heading}" has no list items; kept in Context`);
        if (items.length === 0 && raw) context.push(`## ${block.heading}\n\n${raw}`);
        sections.acceptance.push(...items);
        break;
      }
      case "dependencies":
        sections.dependencies.push(...listItems(block.lines).map((item) => item.text));
        break;
      case "sources":
        sections.sources.push(...listItems(block.lines).map((item) => item.text));
        break;
      case "questions":
        for (const item of listItems(block.lines)) {
          questions.push({ text: item.text, resolved: item.checked === "x" || item.checked === "X", deferred: item.checked === "~" });
        }
        break;
      case "decisions":
        // A decision section is prose: kept whole in Context, and each subsection's heading is a decision.
        for (const line of block.lines) {
          const sub = /^###\s+(.*)$/.exec(line);
          if (sub) decisions.push(sub[1]!.replace(/^[\d.\s]+/, "").trim());
        }
        if (raw) context.push(`## ${block.heading}\n\n${raw}`);
        break;
      case "breakdown": {
        const before = sections.breakdown.length;
        parseBreakdown(block.lines, sections.breakdown, warnings);
        const prose = block.lines.filter((line) => !line.trim().startsWith("|")).join("\n").trim();
        if (prose) context.push(`## ${block.heading} (notes)\n\n${prose}`);
        if (sections.breakdown.length === before) warnings.push(`"${block.heading}" holds no task rows`);
        break;
      }
      default:
        if (raw) context.push(`## ${block.heading}\n\n${raw}`);
    }
  }
  sections.context = context.join("\n\n") || null;
  // Rows that wait on something outside the plan: the plan's dependencies, once each.
  const keys = new Set(sections.breakdown.map((row) => row.key));
  for (const row of sections.breakdown) {
    for (const dep of row.dependsOn) if (!keys.has(dep) && !sections.dependencies.includes(dep)) sections.dependencies.push(dep);
  }
  return { title: title ?? fallbackTitle, brief, sections, questions, decisions, warnings };
}

function parseBreakdown(lines: readonly string[], rows: BreakdownRow[], warnings: string[]): void {
  let header: ReturnType<typeof columnsOf> | null = null;
  for (const line of lines) {
    const row = cells(line);
    if (row === null) {
      header = null;
      const listed = /^\s*(?:[-*]\s+)?\*{0,2}(\d+\.\d+[a-z]?)\*{0,2}\s*[—–:-]\s+(.*)$/.exec(line);
      // A list-style row; a key a table already gave is a note about that row, not another task.
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
      warnings.push(`a breakdown row without ${!key ? "a key" : "a title"}: ${line.trim().slice(0, 80)}`);
      continue;
    }
    const at = (index: number) => (index >= 0 ? cellOrNull(row[index]) : null);
    rows.push({
      key,
      title,
      estimate: at(header.estimate),
      dependsOn: header.depends >= 0 ? splitDepends(unmark(row[header.depends])) : [],
      acceptance: at(header.acceptance),
      owner: at(header.owner),
      notes: [at(header.notes), ...row.map((_, index) => index).filter((index) => !Object.values(header!).includes(index)).map(at)].filter(Boolean).join(" · ") || null,
    });
  }
}
