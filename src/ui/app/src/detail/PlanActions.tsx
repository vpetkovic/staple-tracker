/**
 * The plan's controls in the shared drawer: an idea's status line and actions, and a horizon's
 * section. Every button and menu item is an item from `plain-actions.ts` (`planActionItems`,
 * `horizonActionItems`), which turns exactly the actions the record's lifecycle state offers
 * (the core table, through the payload) into writes. The writes run through the drawer's own
 * controller, so a refusal lands in the same place every other action's does.
 */
import { Ellipsis } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { HorizonData, IdeaData, IdeaDetailData } from "@/lib/plan-types";
import { useSession } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { PlanTree } from "@/views/plan/PlanTree";
import { Amber, Flag, HorizonSummary, StateGlyph } from "@/views/plan/plan-parts";
import { planTree } from "@/views/plan/plan-tree";
import { dayLabel } from "@/views/plan/plan-model";
import type { IssueActionsController } from "./IssueActions";
import { cn } from "./parts/cn";
import { RunSettingDialog, runSettingLabel } from "@/views/plan/RunSetting";
import { horizonActionItems, planActionItems, planPrimary, type PlanItem } from "./plain-actions";
import { DeliveredMark } from "./ShippedMark";
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

/**
 * The idea's status line, one line: its state glyph and words (the percent once started, the
 * horizon it is aimed at or on, the planned window), then the flags. Never a ticket number.
 */
export function IdeaStatusLine({ record, className, children }: { record: IdeaDetailData; className?: string; children?: React.ReactNode }) {
  const { idea } = record;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)} data-status-line="" data-idea-status={idea.state}>
      {/* Inline, not flex: a long line wraps as words, with the glyph leading its first line. */}
      <p className="m-0 min-w-0 flex-[1_1_16rem] text-body text-text-secondary [&_[data-plan-flag]]:ml-2 [&_[data-plan-flag]]:align-[1px]" data-status-sentence="">
        {idea.state === "shipped" && idea.delivered ? (
          <DeliveredMark on={idea.delivered.on} className="align-middle" />
        ) : (
          <>
            <StateGlyph state={idea.state} percent={idea.percent} className="mr-2 size-4 align-[-3px] [&_[data-shipped-check]]:size-4" />
            <span data-idea-state-words="">{statusWords(record)}</span>
          </>
        )}
        {idea.planIncomplete.length > 0 ? (
          <>
            {" · "}
            <Amber data-idea-plan-incomplete="">plan incomplete</Amber>
          </>
        ) : null}
        {idea.late && idea.state !== "shipped" ? <Flag tone="late" /> : null}
        {idea.notStarted ? <Flag tone="notStarted" /> : null}
      </p>
      {children}
    </div>
  );
}

/** `Exploring · aimed at ◇ Post-MVP · planned Aug 12 – Apr 24, 2027`: what the state and the payload say, in words. */
function statusWords(record: IdeaDetailData): string {
  const { idea, horizon } = record;
  const state = idea.state === "shipped" && idea.actual.end ? `Shipped ${dayLabel(idea.actual.end)}` : (STATE_WORDS[idea.state] ?? idea.state);
  const words = [idea.state === "started" && idea.percent !== null ? `${state} · ${idea.percent}% done` : state];
  if (horizon) words.push(`${idea.state === "exploring" || idea.state === "raw" ? "aimed at" : "on"} ◇ ${horizon.name}${horizon.date ? ` (${dayLabel(horizon.date, false)})` : ""}`);
  else if (idea.state === "shaped" || idea.state === "started") words.push("not scheduled");
  if (idea.state !== "shipped" && idea.planned.start && idea.planned.target) words.push(`planned ${dayLabel(idea.planned.start, false)} – ${dayLabel(idea.planned.target)}`);
  return words.join(" · ");
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
 * A horizon's plan as the drawer and the Milestones view draw it: the horizon's summary (the
 * bar, the percent, "Needs you", its records and units; `risk` adds late, not started, approval
 * and shipped, for a surface that prints them nowhere else) and the same outline as the
 * Horizons lens, each record linking to its own drawer in Plan. The outline takes its compact or
 * wide form from its own width.
 */
export function HorizonPlanTree({ workspace, horizon, ideas, horizons, risk = false, className }: { workspace: string; horizon: HorizonData; ideas: IdeaData[]; horizons: Array<{ id: string; name: string }>; risk?: boolean; className?: string }) {
  const rows = planTree({ horizonId: horizon.id, ideas, horizons });
  return (
    <section aria-label="Planned ideas" className={className} data-horizon-plan-tree={horizon.id}>
      <HorizonSummary horizon={horizon} heading={null} risk={risk} className="px-4 pt-3 pb-3" />
      {rows.length === 0 ? <p className="m-0 border-t px-4 py-3 text-label text-text-secondary">No ideas are scheduled on it yet.</p> : <div className="border-t"><PlanTree rows={rows} opener={{ workspace }} label={`Ideas on ${horizon.name}`} /></div>}
    </section>
  );
}

/**
 * A horizon's plan side, on its milestone detail: its state, the actions that state offers
 * (queue it while it holds work, remove it while it holds none), its run setting, then its
 * summary and outline.
 */
export function HorizonSection({
  detail,
  horizon,
  ideas,
  horizons = [],
  controller,
  className,
}: {
  detail: IssueDetail;
  horizon: HorizonData;
  ideas: IdeaData[];
  /** Every horizon's name, so a sub-idea carried elsewhere says where. */
  horizons?: Array<{ id: string; name: string }>;
  controller: IssueActionsController;
  className?: string;
}) {
  const [running, setRunning] = useState(false);
  const items = horizonActionItems(detail.workspace, horizon);
  return (
    <section aria-label="Horizon" className={cn("overflow-hidden rounded-lg border", className)} data-horizon-section={horizon.id} data-horizon-state={horizon.state}>
      <div className="p-4 pb-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-7 items-center rounded-full border bg-surface-raised px-2.5 text-label font-medium" data-horizon-state-chip={horizon.state}>
            Horizon · {STATE_WORDS[horizon.state]}
          </span>
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
      </div>
      <HorizonPlanTree workspace={detail.workspace} horizon={horizon} ideas={ideas} horizons={horizons} risk className="mt-1" />
    </section>
  );
}
