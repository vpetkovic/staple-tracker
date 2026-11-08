/**
 * A horizon's run setting (design/plan.md, "Lenses"): how far agents take the horizon when they
 * pick its work up, and its goal. A setting, like autopilot's: nothing runs from here. The person
 * sets it; every agent that takes the horizon's work reads it with its instructions, and a goal
 * run over the horizon is allowed only when it is set to run until its goal is met.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { HorizonData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { RUN_MODES, RUN_MODE_IDS, type RunMode } from "../../../../../core/plan-lifecycle-table";

/** What each setting means to the person who sets it; the agent's own wording is in the core table. */
const MEANS: Record<RunMode, string> = {
  work: "Agents take its work from the queue until every member has landed. It ships when the last one does.",
  goal: "Agents work toward the goal below, check each criterion with evidence, and may add the tickets it still needs. It then waits for your approval to close.",
  epic: "Agents finish one epic, then stop until you release the next.",
};

/** The header's words for the setting: `Agents: until its goal is met`. */
export function runSettingLabel(mode: RunMode | null): string {
  return mode === null ? "Agents: not set" : `Agents: ${RUN_MODES[mode].label.charAt(0).toLowerCase()}${RUN_MODES[mode].label.slice(1)}`;
}

export interface RunSettingDraft {
  mode: RunMode | null;
  goal: string[];
}

/** The dialog's content, a pure function of the horizon and the draft: what the tests render. */
export function RunSettingForm({
  horizon,
  busy,
  onSave,
  onClose,
}: {
  horizon: Pick<HorizonData, "name" | "identifier" | "runMode" | "goal">;
  busy: boolean;
  onSave: (draft: RunSettingDraft) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<RunMode | null>(horizon.runMode);
  const [goal, setGoal] = useState(horizon.goal.join("\n"));
  return (
    <div className="flex flex-col gap-4" data-run-setting={horizon.identifier}>
        <div role="radiogroup" aria-label="How far agents take it" className="flex flex-col gap-1.5">
          {RUN_MODE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              data-run-mode={id}
              onClick={() => setMode(id)}
              className={cn("flex min-h-11 flex-col items-start rounded-md border px-3 py-2 text-left", mode === id ? "border-ring bg-surface-selected" : "hover:bg-surface-hover")}
            >
              <span className="text-label font-medium">{RUN_MODES[id].label}</span>
              <span className="text-caption text-text-secondary">{MEANS[id]}</span>
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-label">
          <span className="font-medium">Goal</span>
          <span className="text-caption text-text-secondary">One criterion per line. What agents work toward, and what a goal run checks.</span>
          <Textarea value={goal} rows={4} onChange={(event) => setGoal(event.target.value)} data-run-goal-input placeholder="Checkout works end to end for a beta merchant" />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            data-run-setting-save
            onClick={() => onSave({ mode, goal: goal.split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean) })}
          >
            Save
          </Button>
        </div>
    </div>
  );
}

/** The run setting in its dialog. */
export function RunSettingDialogView(props: Parameters<typeof RunSettingForm>[0]) {
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))]">
        <DialogTitle>How agents run {props.horizon.name}</DialogTitle>
        <DialogDescription>A setting, not a start: agents read it whenever they pick this horizon&apos;s work up. Nothing runs from here.</DialogDescription>
        <RunSettingForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog wired to the plan's write: the person's, as every horizon setting is. */
export function RunSettingDialog({
  horizon,
  onClose,
  write,
}: {
  horizon: Pick<HorizonData, "id" | "name" | "identifier" | "runMode" | "goal">;
  onClose: () => void;
  write: (verb: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <RunSettingDialogView
      horizon={horizon}
      busy={busy}
      onClose={onClose}
      onSave={(draft) => {
        setBusy(true);
        void write("horizon-run", { ref: horizon.id, mode: draft.mode, goal: draft.goal }).then((ok) => {
          setBusy(false);
          if (ok) onClose();
        });
      }}
    />
  );
}
