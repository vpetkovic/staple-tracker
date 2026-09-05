/**
 * The group-by control — R1 (STA-100).
 *
 * ── WHY IT SITS BESIDE FILTER AND NOT INSIDE IT ───────────────────────────────────────
 *
 * Filtering answers "which rows are on the page"; grouping answers "how are they
 * arranged". They are neighbours because they are both view scoping and they belong on the
 * same row, and they are not the same control because a user who has narrowed the list has
 * not asked for it to be re-arranged. That distinction is also why grouping is stored under
 * its own key rather than on the filter envelope — the argument is in lib/view-prefs.ts.
 *
 * ── NO COUNT BADGE ────────────────────────────────────────────────────────────────────
 *
 * The Filter button carries one because "the page is filtered" is a fact you can forget and
 * then be misled by. Grouping is not that: the group headers ARE the indicator, they are on
 * screen, and a badge saying "1" beside a list that visibly has headers would be furniture.
 * What the trigger does instead is name the active dimension, which is the same "say what is
 * true, quietly" rule the Done toggle follows.
 *
 * The options come from `GROUP_BY_OPTIONS`, so a third dimension is one registry entry and
 * no edit here.
 */
import { Check, Rows3 } from "lucide-react";
import { useState } from "react";
import { HeaderButton } from "@/components/filters/HeaderButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSession } from "@/lib/session";
// `Button` left with the trigger: the recipe is HeaderButton's now, shared with the row.
import { GROUP_BY_OPTIONS, type GroupBy } from "@/lib/view-prefs";
import { cn } from "@/lib/utils";

export function GroupByMenu({ compact = false }: { compact?: boolean } = {}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const grouped = session.groupBy !== "none";
  // "Group" when off, "Group: Status" when on — the label carries the state, so nothing
  // has to be inferred from a highlight.
  const label = grouped ? `Group: ${GROUP_BY_OPTIONS.find((o) => o.id === session.groupBy)?.label}` : "Group";

  const choose = (next: GroupBy) => {
    session.setGroupBy(next);
    // One choice, one menu. Unlike the filter value page, grouping is single-select and
    // there is never a second thing to pick, so staying open would just be a click to close.
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <HeaderButton
          icon={<Rows3 aria-hidden />}
          label={label}
          aria-label="Group tasks"
          hint={compact ? label : undefined}
          compact={compact}
          active={grouped}
          data-group-by={session.groupBy}
        />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-1">
        <div role="radiogroup" aria-label="Group tasks by">
          {GROUP_BY_OPTIONS.map((option) => {
            const active = session.groupBy === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                data-group-option={option.id}
                onClick={() => choose(option.id)}
                className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-3.5 shrink-0 items-center justify-center",
                    active ? "text-foreground" : "text-transparent",
                  )}
                  aria-hidden
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px]">{option.label}</span>
                  {/* The hint is the difference between a menu of nouns and a menu that
                      tells you what you are choosing. Both options here have a real
                      behavioural consequence — one of them splits parents from children. */}
                  <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
