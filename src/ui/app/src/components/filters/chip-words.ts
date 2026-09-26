/**
 * What an active filter SAYS — in words a person would use, not the name of the field it
 * filters.
 *
 * The chip strip used to print "Assignee vp", "Kind Bug", "Label ui": the dimension's
 * heading, then the value. Readable to whoever built the filter model, and a small puzzle
 * to anyone else. Each chip is now a phrase — "Assigned to vp", "Bugs", "Tagged “ui”" —
 * that reads correctly on its own, which also keeps the old guarantee the prefix existed
 * for: a label called `done` reads "Tagged “done”", never as a status.
 *
 * The filter menu's headings get the same treatment (`dimensionWords`), so "Claim",
 * "Handoff", "Gate" and "Pickup state" read as the questions they answer.
 */
import type { FilterChip } from "@/lib/filters";
import { UNASSIGNED } from "@/lib/filters";

/** The menu heading for each dimension, as a plain question-shaped phrase. */
const DIMENSION_WORDS: Record<string, string> = {
  status: "Status",
  kind: "Kind of task",
  assignee: "Assigned to",
  priority: "Priority",
  label: "Tags",
  claim: "Who is working on it",
  handoff: "Handoff notes",
  gate: "Approvals",
  pickup: "Ready for an agent",
  milestone: "Milestone",
  epic: "Part of a larger task",
  project: "Project",
};

export function dimensionWords(id: string, fallback: string): string {
  return DIMENSION_WORDS[id] ?? fallback;
}

/** "Bug" → "Bugs", "Investigation" → "Investigations"; an already-plural word is left alone. */
export function pluralKind(label: string): string {
  if (/s$/i.test(label)) return label;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/** Sentence case for a Title Case label: "In Progress" → "In progress". */
export function sentenceCase(label: string): string {
  const [first = "", ...rest] = label.split(" ");
  return [first, ...rest.map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))].join(" ");
}

/** The pickup states read as what they mean for the person looking, not as the resolver's word. */
const PICKUP_PHRASES: Record<string, string> = {
  pickable: "Ready to pick up",
  queued: "Queued for pickup",
  waiting: "Waiting on other work",
  gated: "Waiting for approval",
  in_flight: "Being worked on",
};

/** One active filter, as the phrase its chip shows. */
export function chipPhrase(chip: Pick<FilterChip, "dimension" | "value" | "label">): string {
  switch (chip.dimension) {
    case "status":
      return sentenceCase(chip.label);
    case "kind":
      return pluralKind(chip.label);
    case "assignee":
      return chip.value === UNASSIGNED ? "Unassigned" : `Assigned to ${chip.label}`;
    case "priority":
      return `${chip.label} priority`;
    case "label":
      return `Tagged “${chip.label}”`;
    case "milestone":
      return `In ${chip.label}`;
    case "epic":
      return `Part of ${chip.label}`;
    case "project":
      return `In project ${chip.label}`;
    case "pickup":
      return PICKUP_PHRASES[chip.value] ?? sentenceCase(chip.label);
    case "text":
      return `Matches ${chip.label.replace(/^"(.*)"$/, "“$1”")}`;
    default:
      return sentenceCase(chip.label);
  }
}
