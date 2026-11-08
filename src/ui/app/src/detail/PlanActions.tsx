import { PlannedIdeaLinks } from "./PlannedIdeaLinks";
import { planCounts, countWord } from "@/views/plan/plan-counts";
/**
 * The plan's controls in the shared drawer: an idea's status line and actions, and a horizon's
 * section. Every button and menu item is an item from `plain-actions.ts` (`planActionItems`,
 * `horizonActionItems`), which turns exactly the actions the record's lifecycle state offers
 * (the core table, through the payload) into writes. The writes run through the drawer's own
 * controller, so a refusal lands in the same place every other action's does.
 */
import { ChevronRight, Ellipsis } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { HorizonData, IdeaData, IdeaDetailData } from "@/lib/plan-types";
import { useSession } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { Chip, Progress } from "@/views/plan/PlanBoards";
import { dayLabel, horizonDone } from "@/views/plan/plan-model";
import type { IssueActionsController } from "./IssueActions";
import { cn } from "./parts/cn";
import { RunSettingDialog, runSettingLabel } from "@/views/plan/RunSetting";
import { horizonActionItems, planActionItems, planPrimary, type PlanItem } from "./plain-actions";
import { ShippedCheck, ShippedMark } from "./ShippedMark";
import { STATE_WORDS, requestScaffold } from "./plan-record";
import { openDetailTab } from "./tabs/registry";

/** What a plan item does when chosen: its write, or opening the epic the record became. */
function useChoose(workspace: string, controller: IssueActionsController, epicRef: string | null) {
  const session = useSession();
  return (item: PlanItem) => {
    if (item.opens === "epic") {
      if (epicRef) session.open(workspace, epicRef);
      return;
    }
    if (item.opens === "scaffold") {
      openDetailTab("plan");
      // The tab mounts on the switch; ask once it is there.
      window.setTimeout(requestScaffold, 0);
      return;
    }
    if (item.call) void controller.run(item.call);
  };
}

/** The idea's status line: what it is and where it stands, in words, never a ticket number. */
export function IdeaStatusLine({ record, className, children }: { record: IdeaDetailData; className?: string; children?: React.ReactNode }) {
  const { idea } = record;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)} data-status-line="" data-idea-status={idea.state}>
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-surface-raised px-2.5 text-label font-medium" data-idea-state-chip={idea.state}>
        {idea.state === "shipped" ? <ShippedCheck label="" className="size-3.5 [&_svg]:size-2.5" /> : null}
        Idea · {STATE_WORDS[idea.state]}
        {idea.planIncomplete.length > 0 ? " · plan incomplete" : ""}
      </span>
      <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-body text-text-secondary" data-status-sentence="">
        {idea.state === "shipped" ? <ShippedMark on={idea.actual.end} withYear /> : <span>{sentence(record)}</span>}
        {idea.late ? <Chip tone="red">late</Chip> : null}
        {idea.notStarted ? <Chip tone="amber">not started</Chip> : null}
      </p>
      {children}
    </div>
  );
}

function sentence(record: IdeaDetailData): string {
  const { idea, horizon } = record;
  const where = horizon ? `on ${horizon.name}${horizon.date ? ` (${dayLabel(horizon.date, false)})` : ""}` : "not scheduled";
  switch (idea.state) {
    case "raw":
      return "Captured, not explored yet";
    case "exploring":
      return `Being explored, ${where}`;
    case "shaped":
      return `Ready to start, ${where}`;
    case "started":
      return `Underway, ${where}${idea.progress !== null ? ` · ${Math.round(idea.progress * 100)}% done` : ""}`;
    case "shipped":
      return `Shipped${idea.actual.end ? ` ${dayLabel(idea.actual.end)}` : ""}`;
    case "dropped":
      return "Dropped";
  }
}

/** The idea's one primary action (the step forward its state offers) as a button. */
export function PlanPrimary({ workspace, idea, controller, size = "sm", className }: { workspace: string; idea: IdeaData; controller: IssueActionsController; size?: "sm" | "lg"; className?: string }) {
  const choose = useChoose(workspace, controller, idea.identifier);
  const primary = planPrimary(planActionItems(workspace, idea));
  if (!primary) return null;
  return (
    <Button
      size={size}
      className={className}
      disabled={controller.busy || Boolean(primary.disabledReason)}
      title={primary.disabledReason}
      onClick={() => choose(primary)}
      data-plan-action={primary.id}
      data-plan-primary=""
    >
      {primary.label}
    </Button>
  );
}

/** Every other one-click action the idea's state offers, in ⋯. Absent when there are none. */
export function PlanOverflow({ workspace, idea, controller, triggerClassName }: { workspace: string; idea: IdeaData; controller: IssueActionsController; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const choose = useChoose(workspace, controller, idea.identifier);
  const items = planActionItems(workspace, idea);
  const primary = planPrimary(items);
  const rest = items.filter((item) => item.id !== primary?.id);
  if (rest.length === 0) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions" title="More actions" data-plan-overflow="" className={cn("focus-ring", triggerClassName)}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {rest.map((item) => (
          <DropdownMenuItem key={item.id} disabled={Boolean(item.disabledReason)} title={item.disabledReason} onSelect={() => choose(item)} data-plan-action={item.id} className="pointer-coarse:min-h-11">
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A horizon's plan side, on its milestone detail: its state, the actions that state offers
 * (queue it while it holds work, remove it while it holds none), and the ideas on it.
 */
export function HorizonSection({ detail, horizon, ideas, controller, className }: { detail: IssueDetail; horizon: HorizonData; ideas: IdeaData[]; controller: IssueActionsController; className?: string }) {
  const session = useSession();
  const [running, setRunning] = useState(false);
  const items = horizonActionItems(detail.workspace, horizon);
  const progress = horizon.progress;
  return (
    <section aria-label="Horizon" className={cn("rounded-lg border p-4", className)} data-horizon-section={horizon.id} data-horizon-state={horizon.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 items-center rounded-full border bg-surface-raised px-2.5 text-label font-medium" data-horizon-state-chip={horizon.state}>
          Horizon · {STATE_WORDS[horizon.state]}
        </span>
        {horizon.awaitingApproval ? <Chip tone="amber">Waiting for your approval</Chip> : null}
        {horizonDone(horizon) ? <ShippedMark className="text-label" /> : horizon.shippedCount > 0 ? <ShippedMark count={horizon.shippedCount} className="text-label" /> : null}
        {horizon.lateCount ? <Chip tone="red">{horizon.lateCount} late</Chip> : null}
        {horizon.notStartedCount ? <Chip tone="amber">{horizon.notStartedCount} not started</Chip> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {items.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={item.id === "queue" ? "default" : "outline"}
              disabled={controller.busy || Boolean(item.disabledReason)}
              title={item.disabledReason}
              onClick={() => (item.call ? void controller.run(item.call) : item.opens === "run" ? setRunning(true) : undefined)}
              data-horizon-action={item.id}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      {items
        .filter((item) => item.disabledReason)
        .map((item) => (
          <p key={item.id} className="m-0 mt-2 text-label text-text-secondary" data-horizon-held={item.id}>
            {item.label}: {item.disabledReason}
          </p>
        ))}
      {running ? (
        <RunSettingDialog
          horizon={horizon}
          onClose={() => setRunning(false)}
          write={async (verb, body) => {
            await controller.run({ route: "plan", ws: detail.workspace, verb, body, actor: { from: "person" } });
            return true;
          }}
        />
      ) : null}
      <div className="mt-3 text-label" data-horizon-run-setting={horizon.runMode ?? "unset"}>
        <span className="font-medium">{runSettingLabel(horizon.runMode)}</span>
        {horizon.goal.length > 0 ? (
          <ul className="m-0 mt-1 list-disc space-y-0.5 pl-5 text-text-secondary" data-horizon-goal>
            {horizon.goal.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mt-1 text-text-secondary">No goal yet. Set it with how agents run it.</p>
        )}
      </div>
      {progress !== null ? (
        <div className="mt-3">
          <Progress value={progress} />
        </div>
      ) : null}
      <p className="mt-3 text-caption text-text-tertiary">{planCounts(horizon.ideaCount, horizon.memberCount)}</p>
      <h3 className="mt-4 mb-1.5 text-caption font-semibold tracking-wide text-text-tertiary uppercase">Ideas on it ({horizon.ideaCount})</h3>
      {ideas.length === 0 ? (
        <p className="m-0 text-label text-text-secondary">No ideas are scheduled on it yet.</p>
      ) : (
        <PlannedIdeaLinks workspace={detail.workspace} ideas={ideas} />
      )}
    </section>
  );
}
