/**
 * Mine / All, for a shared workspace's task list.
 *
 * Mine is everything not assigned to ANOTHER member: this machine's member's own work,
 * unassigned work, and work an agent's free-text handle holds. It is the same rule
 * `staple ls --mine` and `queue next` follow on this machine, so the list a person reads
 * and the work their agents pick up agree. What Mine hides is said, never silent:
 * "4 assigned to marko hidden · show".
 *
 * Drawn only when the workspace has a member list on this machine; without one the list
 * is the single-person list it always was.
 */
import { cn } from "@/detail/parts/cn";

export function MineToggle({
  mine,
  onChange,
  hidden,
}: {
  mine: boolean;
  onChange: (mine: boolean) => void;
  /** What Mine left out, per other member. Empty under All. */
  hidden: ReadonlyArray<{ memberId: string; name: string; count: number }>;
}) {
  const options = [
    { value: true, label: "Mine" },
    { value: false, label: "All" },
  ] as const;
  return (
    <div data-mine-toggle={mine ? "mine" : "all"} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-3">
      <div role="group" aria-label="Whose work" className="inline-flex shrink-0 rounded-lg bg-surface-sunken p-0.5">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={mine === option.value}
            data-mine-option={option.label.toLowerCase()}
            onClick={() => onChange(option.value)}
            className={cn(
              "text-body focus-ring inline-flex h-8 items-center rounded-md px-3 transition-colors duration-150 max-sm:h-9",
              mine === option.value
                ? "bg-surface-raised text-foreground shadow-[0_0_0_1px_var(--border)]"
                : "text-text-secondary hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {mine && hidden.length > 0 ? (
        <p data-mine-hidden="" className="text-body text-text-secondary">
          {hidden.map((entry) => `${entry.count} assigned to ${entry.name}`).join(", ")} hidden ·{" "}
          <button type="button" className="focus-ring rounded-sm text-foreground underline underline-offset-2" onClick={() => onChange(false)}>
            show
          </button>
        </p>
      ) : null}
    </div>
  );
}
