/**
 * LAYOUT A, "Brief": the Overview as one page read top to bottom, in the order of the argument.
 * The answer first (one sentence and five figures), then the evidence for it (time, what got
 * built), then the detail a curious reader wants (speed, reliability, rhythm, mix, paper trail).
 * Dense two-column rows on a desk, one column on a phone; nothing is behind a tab.
 */
import { useSession } from "@/lib/session";
import {
  BurstsWidget,
  DoneTrend,
  EstimatesWidget,
  FeaturesWidget,
  Headline,
  HoursTrend,
  KpiRow,
  MethodNotes,
  MixWidget,
  ModelsWidget,
  OutcomesWidget,
  ParallelWidget,
  RecordWidget,
  RhythmWidget,
  SectionLabel,
  SpeedByKindWidget,
  SpeedWidget,
  WorkspacesWidget,
  type OverviewProps,
} from "./overview-parts";

export function OverviewBrief({ report, returns, model, against, onOpenReturn, onOpenTicket }: OverviewProps) {
  const session = useSession();
  const many = report === undefined || report.scope.kind === "all";
  const bursts = report?.delivery.bursts.length ?? 0;
  return (
    <div className="flex flex-col gap-4" data-overview="brief">
      <Headline report={report} />
      <KpiRow report={report} returns={returns} model={model} against={against} onOpenReturn={onOpenReturn} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-xl:[&>*:last-child]:col-span-2" />

      <div className="grid gap-3 lg:grid-cols-2">
        <HoursTrend report={report} />
        <DoneTrend report={report} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <FeaturesWidget report={report} onOpenTicket={onOpenTicket} className={many ? "lg:col-span-2" : "lg:col-span-3"} />
        {many ? (
          <div className="flex min-w-0 flex-col gap-3">
            <WorkspacesWidget report={report} />
            <MixWidget report={report} className="flex-1" />
          </div>
        ) : null}
      </div>
      {bursts > 1 ? <BurstsWidget report={report} /> : null}

      <SectionLabel hint="Speed, reliability and rhythm, mostly for you.">Under the hood</SectionLabel>
      <div className="grid gap-3 lg:grid-cols-3">
        <SpeedWidget report={report} className="lg:col-span-2" />
        <SpeedByKindWidget report={report} />
        <RhythmWidget report={report} className="lg:col-span-2" />
        <OutcomesWidget report={report} />
        <ParallelWidget report={report} height={150} className="lg:col-span-2" />
        <ModelsWidget report={report} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <EstimatesWidget report={report} onOpenEstimates={report?.scope.kind === "workspace" ? () => session.setView("calibration") : undefined} />
        <RecordWidget report={report} />
      </div>
      {many ? null : <MixWidget report={report} />}
      <MethodNotes report={report} />
    </div>
  );
}
