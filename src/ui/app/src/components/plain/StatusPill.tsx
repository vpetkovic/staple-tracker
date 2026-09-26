/**
 * The status pill and the confidence pill. Never colour alone: every pill carries a word and an
 * icon of its own shape, so the state reads in greyscale, to a colour-blind reader and to a
 * screen reader (the word is the text; the icon is decorative).
 *
 * Status tones are the reserved `--plain-*` tokens (theme-tokens.css, each fg ≥ 4.5:1 on its bg in
 * both modes). Confidence is not a status and wears no status hue: a neutral outline, dashed when
 * it is a rough guess.
 */
import { CircleCheck, CircleDashed, CircleDot, CircleHelp, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { STATUS_WORDS, type PlainStatus } from "@/lib/plain-language";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<PlainStatus, { icon: LucideIcon; tone: string }> = {
  on_track: { icon: CircleCheck, tone: "ok" },
  tight: { icon: TriangleAlert, tone: "tight" },
  at_risk: { icon: OctagonAlert, tone: "risk" },
  unknown: { icon: CircleHelp, tone: "unknown" },
};

export function StatusPill({ status, label }: { status: PlainStatus; label?: string }) {
  const { icon: Icon, tone } = STATUS_STYLE[status];
  return (
    <span
      data-status={status}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none font-medium"
      style={{ color: `var(--plain-${tone}-fg)`, backgroundColor: `var(--plain-${tone}-bg)`, borderColor: `var(--plain-${tone}-border)` }}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
      {label ?? STATUS_WORDS[status]}
    </span>
  );
}

const CONFIDENCE_ICON: Record<"high" | "medium" | "low", LucideIcon> = { high: CircleCheck, medium: CircleDot, low: CircleDashed };

/** "Quite sure" / "Fairly sure" / "Rough guess": neutral, dashed when low. */
export function ConfidencePill({ level, word }: { level: "high" | "medium" | "low"; word: string }) {
  const Icon = CONFIDENCE_ICON[level];
  return (
    <span
      data-confidence={level}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none font-medium text-foreground",
        level === "low" && "border-dashed border-[var(--viz-track-edge)]",
      )}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
      {word}
    </span>
  );
}
