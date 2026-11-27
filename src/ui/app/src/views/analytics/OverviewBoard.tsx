/**
 * LAYOUT B, "Board": the Overview as a dashboard. The five figures stay on top; under them one
 * topic at a time (Delivery, Capacity, Speed, Reliability) fills the screen as a dense grid with
 * no narrative, so a repeat visitor reaches one question's charts without scrolling.
 * The same widgets as the Brief, in a different composition.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  BurstsWidget,
  DoneTrend,
  EstimatesWidget,
  FeaturesWidget,
  HoursTrend,
  KpiRow,
  MethodNotes,
  MixWidget,
  ModelsWidget,
  OutcomesWidget,
  ParallelWidget,
  RecordWidget,
  RhythmWidget,
  SpeedByKindWidget,
  SpeedWidget,
  WorkspacesWidget,
  type OverviewProps,
} from "./overview-parts";

type Topic = "delivery" | "capacity" | "speed" | "reliability";
const TOPICS: readonly { id: Topic; label: string }[] = [
  { id: "delivery", label: "Delivery" },
  { id: "capacity", label: "Capacity" },
  { id: "speed", label: "Speed" },
  { id: "reliability", label: "Reliability" },
];

export function OverviewBoard({ report, returns, model, against, onOpenReturn, onOpenTicket }: OverviewProps) {
  const [topic, setTopic] = useState<Topic>("delivery");
  return (
    <div className="flex flex-col gap-3" data-overview="board">
      <KpiRow report={report} returns={returns} model={model} against={against} onOpenReturn={onOpenReturn} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-xl:[&>*:last-child]:col-span-2" />
      <div role="tablist" aria-label="Topic" className="flex gap-1 overflow-x-auto border-b [scrollbar-width:none]">
        {TOPICS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={topic === item.id}
            onClick={() => setTopic(item.id)}
            className={cn("focus-ring-inset -mb-px min-h-0 shrink-0 border-b-2 border-transparent px-3 py-2 text-body font-medium text-muted-foreground transition-colors hover:text-foreground", topic === item.id && "border-foreground text-foreground")}
          >
            {item.label}
          </button>
        ))}
      </div>
      {topic === "delivery" ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <DoneTrend report={report} className="lg:col-span-2" />
          <MixWidget report={report} />
          <FeaturesWidget report={report} onOpenTicket={onOpenTicket} limit={6} className="lg:col-span-2" />
          <RecordWidget report={report} />
          <BurstsWidget report={report} className="lg:col-span-3" />
        </div>
      ) : topic === "capacity" ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <HoursTrend report={report} className="lg:col-span-2" />
          <WorkspacesWidget report={report} />
          <ParallelWidget report={report} className="lg:col-span-2" />
          <EstimatesWidget report={report} />
        </div>
      ) : topic === "speed" ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <SpeedWidget report={report} className="lg:col-span-2" />
          <SpeedByKindWidget report={report} />
          <RhythmWidget report={report} className="lg:col-span-3" />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <OutcomesWidget report={report} />
          <ModelsWidget report={report} />
        </div>
      )}
      <MethodNotes report={report} />
    </div>
  );
}
