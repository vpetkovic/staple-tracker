/**
 * A type-to-filter select over a list you already have — R7 (STA-103).
 *
 * WHY THIS EXISTS AT ALL. Before R7 the create dialog asked for a parent by making you
 * type `STA-12` into a text box from memory. That is fine for the agent that wrote the
 * ref down a second ago and hostile to the human who did not, and it fails silently:
 * the store's `not_found` arrives after you have already filled in the rest of the form.
 * Every option here is a task that exists, so a ref cannot be wrong.
 *
 * WHY IT DOES ITS OWN FILTERING. cmdk filters for you, and `filters/FilterMenu.tsx`
 * lets it. This one passes `shouldFilter={false}` and hands cmdk a list that is already
 * narrowed, for two reasons that are both about being able to prove it works:
 *
 *   1. cmdk scores fuzzily and REORDERS. For a list of identifiers that is actively
 *      wrong — typing "STA-1" should not put "STA-118" above "STA-1" because the
 *      former scored better. `filterOptions` keeps the caller's order, always.
 *   2. `filterOptions` and `shouldOfferCreate` are pure and unit-tested next door.
 *      Filtering that lives inside cmdk is filtering no test can reach, and "the
 *      dropdown filters as you type" is precisely the claim R7 has to evidence.
 *
 * cmdk is still here, and still earning its place: arrow keys, wrap-around, the
 * highlighted-item-on-enter contract, and the aria plumbing are all things this file
 * would otherwise have to reimplement worse.
 *
 * THE CREATE OFFER IS LAST, not first, and that ordering is load-bearing. cmdk
 * highlights the top item, so with the offer last, enter on a query that matches an
 * existing value picks the EXISTING value; the offer is only ever what enter lands on
 * when genuinely nothing matched.
 *
 * SELECTIONS ARE CHIPS BELOW THE TRIGGER, in both single and multiple mode. Putting
 * them inside the trigger would nest a remove button inside a button, and keeping the
 * two modes structurally identical means the workspace pill has exactly one place to
 * live rather than two that can disagree.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
// Through the barrel, never from the file inside it — components/task-list/index.ts says
// what another domain may depend on, and the glyphs are r-rows' to own. A second set of
// status shapes in a dropdown is a second set to keep in step with the list.
import { StatusIcon } from "@/components/task-list";
import { cn } from "@/lib/utils";
import type { IssueStatus } from "@/lib/types";

export interface SelectOption {
  /** What ends up in the payload — an identifier, or a label. */
  value: string;
  /** The primary text. Usually the same as `value`. */
  label: string;
  /** Secondary text: an issue title. Searched as well as shown. */
  hint?: string;
  /** The workspace pill. Searched as well as shown; absent for things no workspace owns. */
  pill?: string;
  /** How many issues carry this value. Shown when present; never searched. */
  count?: number;
  /**
   * The issue's status, for the icon — R8 (STA-110).
   *
   * Absent on options that are not issues (a label has no status). Never searched: the
   * icon answers "is this thing done" at a glance, which is the question you have while
   * picking a blocker, but nobody types "in_progress" to filter a dropdown.
   */
  status?: IssueStatus;
}

/** Everything a query is matched against. Value first: it is what people paste. */
function haystack(option: SelectOption): string {
  return `${option.value} ${option.label} ${option.hint ?? ""} ${option.pill ?? ""}`.toLowerCase();
}

/**
 * Narrow by every whitespace-separated token, each of which may hit a different field.
 *
 * Tokens rather than one substring because "ship pinecone" is a title word plus a
 * workspace, and that string appears in no single field of the row it obviously means.
 * Order is the caller's — see the file header.
 */
export function filterOptions(
  options: readonly SelectOption[],
  query: string,
): SelectOption[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...options];
  return options.filter((option) => {
    const text = haystack(option);
    return tokens.every((token) => text.includes(token));
  });
}

/**
 * Should the list end with "create «query»"?
 *
 * Only when the query names something that is neither an existing option nor already
 * chipped. The second half matters more than it looks: a label created thirty seconds
 * ago is selected but is in no option list yet — those are derived from issues the
 * server has already stored — so without it the control offers to create it twice.
 *
 * Comparison is trimmed and case-insensitive. It is deliberately NOT the store's
 * `normalizeTitle`: this is an affordance, not a guard. If it guesses wrong the worst
 * case is an offer that dedupes into nothing, whereas the store's own rules stay the
 * only thing that decides what a label may be.
 */
export function shouldOfferCreate(
  query: string,
  options: readonly SelectOption[],
  selected: readonly string[],
): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return false;
  if (options.some((option) => option.value.trim().toLowerCase() === wanted)) return false;
  if (selected.some((value) => value.trim().toLowerCase() === wanted)) return false;
  return true;
}

/**
 * The values a paste should add: what `expand` found, kept only where it names a real
 * option.
 *
 * The intersection is the safety. `splitRefs("STA-13, oops")` is happy to hand back
 * `oops`, and a chip reading `oops` would ride all the way to a store refusal at submit
 * time. Silently dropping it leaves the user with the refs that exist and the query box
 * still holding what they pasted if nothing landed.
 */
export function resolvePaste(
  text: string,
  expand: (text: string) => string[],
  options: readonly SelectOption[],
): string[] {
  const known = new Set(options.map((option) => option.value.toLowerCase()));
  const byLower = new Map(options.map((option) => [option.value.toLowerCase(), option.value]));
  return expand(text)
    .filter((value) => known.has(value.toLowerCase()))
    .map((value) => byLower.get(value.toLowerCase())!);
}

/**
 * Split matches into one run per workspace, in the order they arrive.
 *
 * Exists because ordering the target workspace first — which is right, it keeps the
 * common case one glance away — pushed every FOREIGN option below the fold of a list
 * fifteen items long. That quietly undid the point of R8: cross-workspace picks were
 * allowed but invisible. A heading per workspace makes the structure legible before you
 * scroll, and tells you the other workspace is down there at all.
 *
 * `null` for options with no pill (labels), which is why the pill is the key rather than
 * a required field. A single group comes back unheaded — see the render.
 */
export function groupByPill(options: readonly SelectOption[]): Array<{
  pill: string | null;
  options: SelectOption[];
}> {
  const groups: Array<{ pill: string | null; options: SelectOption[] }> = [];
  for (const option of options) {
    const pill = option.pill ?? null;
    const last = groups[groups.length - 1];
    if (last && last.pill === pill) last.options.push(option);
    else groups.push({ pill, options: [option] });
  }
  return groups;
}

export interface SearchableSelectProps {
  /** Identifies the control in the DOM (`data-searchable-select`) and in evidence. */
  name: string;
  id?: string;
  options: readonly SelectOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Multiple appends and keeps the list open; single replaces and closes. */
  multiple?: boolean;
  /** Trigger text when nothing is chosen. */
  placeholder: string;
  /**
   * Trigger text once something IS chosen. Required, because the alternative is a
   * trigger reading "No parent" above a chip reading STA-11 — the control contradicting
   * itself in the one place a user looks to find out what it holds.
   */
  actionLabel: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /**
   * Turns on the create-on-enter offer. Returns the values to add — plural, because
   * typing "ui, api" into a label box means two labels and splitting it is the
   * caller's rule, not this control's.
   *
   * Only pass this where a value may be INVENTED. A relation field must not offer to
   * create `STA-999`: the store would refuse the ref, which is exactly the late,
   * silent failure this control exists to remove.
   */
  onCreate?: (query: string) => string[];
  /**
   * Turns on multi-paste. Expands pasted text into candidate values — and only those
   * that are already options are added, which is what makes it safe on a field with
   * no create offer: pasting a list of refs cannot invent one that does not exist.
   */
  expandPaste?: (text: string) => string[];
  /**
   * A footer inside the dropdown. Where a field says what it CANNOT do.
   *
   * In the list rather than under the trigger on purpose: the restriction only matters
   * while you are choosing, and three fields each carrying the same sentence under them
   * turns one caveat into a wall of repeated text in a dialog that is already tall.
   */
  note?: ReactNode;
  /**
   * Render values monospace. Right for identifiers, where the eye scans a column of
   * `STA-1` / `STA-15` and column alignment is the whole point — and wrong for a label,
   * which is prose and reads as code the moment you set it in a mono face.
   */
  mono?: boolean;
  disabled?: boolean;
}

export function SearchableSelect({
  name,
  id,
  options,
  selected,
  onChange,
  multiple = false,
  placeholder,
  actionLabel,
  searchPlaceholder,
  emptyText = "nothing matches",
  onCreate,
  expandPaste,
  note,
  mono = false,
  disabled = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Clear on every open rather than on close: a list that reopens still holding the
  // last query looks broken, and clearing on close is visible under the animation.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const matches = filterOptions(options, query);
  /**
   * Do the options span more than one workspace? Only then is a heading worth its line —
   * and only then does the per-row pill become noise the heading already carries.
   */
  const grouped = new Set(options.map((o) => o.pill).filter(Boolean)).size > 1;
  const offerCreate = onCreate !== undefined && shouldOfferCreate(query, options, selected);

  const add = (values: string[]) => {
    const next = multiple
      ? [...selected, ...values.filter((value) => !selected.includes(value))]
      : values.slice(0, 1);
    onChange(next);
    if (!multiple) setOpen(false);
    setQuery("");
  };

  const remove = (value: string) => onChange(selected.filter((entry) => entry !== value));

  const optionFor = (value: string) => options.find((option) => option.value === value);

  return (
    <div className="grid gap-1.5">
      {/* modal: the popover portals OUTSIDE the create dialog's content, so the dialog's
          scroll lock would otherwise swallow wheel/touch over the list — the "can't
          scroll the dropdown" bug. Modal popovers take over the lock while open. */}
      <Popover modal open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* No aria-label on purpose. `<button>` is a labelable element, so the field's
              own `<Label htmlFor>` names it — an aria-label here would OVERRIDE that and
              announce "Nothing blocking this" where the visible label says "Blocked by". */}
          <button
            type="button"
            id={id}
            disabled={disabled}
            data-searchable-select={name}
            data-open={open ? "" : undefined}
            className={cn(
              // Deliberately the Input recipe rather than the Button one: this is a
              // field, and a field that looks like a button reads as an action.
              "border-input bg-field flex h-9 w-full items-center gap-2 rounded-md border px-3 py-1",
              "text-left text-sm shadow-xs transition-(--tp-color-box-shadow) outline-none",
              "hover:border-border-strong",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
              "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {/* The trigger describes what it DOES, not what it holds — the chips below
                already say that, and a trigger repeating them would either duplicate or,
                worse, disagree. */}
            <span className="flex-1 truncate text-text-tertiary">
              {selected.length > 0 ? actionLabel : placeholder}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-(--radix-popover-trigger-width) min-w-96 p-0"
          data-select-list={name}
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? placeholder}
              data-select-search={name}
              onPaste={
                expandPaste === undefined
                  ? undefined
                  : (event) => {
                      const resolved = resolvePaste(
                        event.clipboardData.getData("text"),
                        expandPaste,
                        options,
                      );
                      // One value is indistinguishable from typing it, so let it through
                      // and search for it. Two or more is a list, and a list is a paste.
                      if (resolved.length < 2) return;
                      event.preventDefault();
                      add(resolved);
                    }
              }
            />
            <CommandList>
              {/* Only when there is genuinely nothing to show. With an offer pending the
                  list is not empty, and cmdk's empty slot would sit above it. */}
              {matches.length === 0 && !offerCreate ? <CommandEmpty>{emptyText}</CommandEmpty> : null}
              {/* One group per workspace, headed — unless everything is in one group, in
                  which case a heading would only repeat what the field already says. */}
              {groupByPill(matches).map((group, index) => {
                const headed = grouped && group.pill !== null;
                return (
                <CommandGroup
                  key={group.pill ?? `g${index}`}
                  heading={headed ? group.pill : undefined}
                  data-select-group={group.pill ?? undefined}
                >
                  {group.options.map((option) => {
                    const checked = selected.includes(option.value);
                    return (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        onSelect={() => (checked ? remove(option.value) : add([option.value]))}
                        data-select-option={option.value}
                        data-option-workspace={option.pill}
                        data-checked={checked ? "" : undefined}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong",
                          )}
                        >
                          {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                        </span>
                        {/* The same component the main list uses, so "done" looks like
                            done everywhere. Its own <title>/aria-label rides along, which
                            is also what the evidence asserts on. */}
                        {option.status ? (
                          <StatusIcon status={option.status} className="size-3.5 shrink-0" />
                        ) : null}
                        <span className={cn("shrink-0 text-[12px]", mono && "font-mono")}>
                          {option.label}
                        </span>
                        {option.hint ? (
                          <span className="flex-1 truncate text-text-tertiary">{option.hint}</span>
                        ) : (
                          <span className="flex-1" />
                        )}
                        {option.count !== undefined ? (
                          <span className="font-mono text-[11px] text-text-tertiary tabular-nums">
                            {option.count}
                          </span>
                        ) : null}
                        {/* The pill rides every option when the list is single-workspace,
                            because which project a ref belongs to is worth answering
                            before it is a problem. When the list IS grouped by workspace
                            the heading already says it, and repeating it on all fifteen
                            rows is noise. `data-option-workspace` is on the row either
                            way — the data does not depend on how it is drawn. */}
                        {option.pill && !grouped ? <WorkspacePill>{option.pill}</WorkspacePill> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                );
              })}
              {offerCreate ? (
                <CommandGroup>
                  <CommandItem
                    value={`__create__${query}`}
                    onSelect={() => add(onCreate!(query))}
                    data-select-create={query.trim()}
                  >
                    <Plus className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">
                      Create <span className="font-medium">“{query.trim()}”</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
            {note ? (
              <div className="text-text-tertiary border-t px-2.5 py-1.5 text-[11px]">{note}</div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1" data-select-chips={name}>
          {selected.map((value) => {
            const option = optionFor(value);
            const pill = option?.pill;
            return (
              <span
                key={value}
                data-select-chip={value}
                data-chip-workspace={pill}
                className="border-input bg-surface-hover flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 text-[12px]"
              >
                {pill ? <WorkspacePill>{pill}</WorkspacePill> : null}
                {/* Status rides onto the chip for the same reason the pill does: the
                    answer to "is this blocker finished" must survive the list closing. */}
                {option?.status ? (
                  <StatusIcon status={option.status} className="size-3.5 shrink-0" />
                ) : null}
                <span className={mono ? "font-mono" : undefined}>{value}</span>
                <button
                  type="button"
                  onClick={() => remove(value)}
                  aria-label={`Remove ${value}`}
                  data-select-chip-remove={value}
                  className={cn(
                    "flex size-4 items-center justify-center rounded-sm text-text-tertiary transition-colors",
                    "hover:bg-surface-hover hover:text-foreground",
                    "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

    </div>
  );
}

/** The workspace indication, in one place so the option and the chip cannot diverge. */
function WorkspacePill({ children }: { children: ReactNode }) {
  return (
    <span className="border-input text-text-tertiary shrink-0 rounded-sm border px-1 text-[10px] leading-4 tracking-wide uppercase">
      {children}
    </span>
  );
}
