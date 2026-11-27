/**
 * The Overview: five figures on top, then one topic at a time (Delivery, Capacity, Speed,
 * Reliability) as a dense grid of widgets, so one question's charts are on screen together.
 *
 * The topic tabs stick to the top of the page while it scrolls, so another topic is always one
 * tap away, and changing topic never moves the page: the panel is at least as tall as the screen,
 * so the scroll position holds whichever topic is shorter.
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
  const many = report === undefined || report.scope.kind === "all";
  return (
    <div className="flex flex-col gap-3" data-overview="board">
      <KpiRow report={report} returns={returns} model={model} against={against} onOpenReturn={onOpenReturn} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-xl:[&>*:last-child]:col-span-2" />
      <div role="tablist" aria-label="Topic" className="sticky top-0 z-10 -mx-page flex gap-1 overflow-x-auto border-b bg-card px-page [scrollbar-width:none] max-md:-mx-3 max-md:px-3" data-topic-tabs>
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
      <div role="tabpanel" aria-label={TOPICS.find((item) => item.id === topic)?.label} className="flex min-h-[calc(100dvh-11rem)] flex-col gap-3" data-topic={topic}>
        {topic === "delivery" ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <DoneTrend report={report} className="lg:col-span-2" />
            <MixWidget report={report} />
            <FeaturesWidget report={report} onOpenTicket={onOpenTicket} limit={8} className="lg:col-span-2" />
            <RecordWidget report={report} />
            <BurstsWidget report={report} className="lg:col-span-3" />
          </div>
        ) : topic === "capacity" ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <HoursTrend report={report} className={many ? "lg:col-span-2" : "lg:col-span-3"} />
            {many ? <WorkspacesWidget report={report} /> : null}
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
    </div>
  );
}
