import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** The same strip for a drawer's tabs and the Plan lenses, including horizontal reveal. */
export function DetailTabStrip({ sheet, label, items, active, marker }: {
  sheet: boolean;
  label: string;
  items: readonly { id: string; label: string }[];
  active?: string;
  marker?: "data-plan-lens";
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const next = { start: strip.scrollLeft > 1, end: strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1 };
      setEdges(current => current.start === next.start && current.end === next.end ? current : next);
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(strip);
    return () => { strip.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [items.length]);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const trigger = strip?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!strip || !trigger || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({ left: Math.max(0, trigger.offsetLeft - (strip.clientWidth - trigger.offsetWidth) / 2), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [active]);
  return <div className="staple-detail-tabfade min-w-0" data-fade-start={edges.start ? "" : undefined} data-fade-end={edges.end ? "" : undefined}>
    <TabsList ref={stripRef} aria-label={label} variant={sheet ? "default" : "line"} className={cn("staple-detail-tabstrip w-full justify-start", sheet && "staple-detail-segments")}>
      {items.map(item => <TabsTrigger key={item.id} value={item.id} className="focus-ring-inset flex-none" {...(marker ? { [marker]: item.id } : {})}>{item.label}</TabsTrigger>)}
    </TabsList>
  </div>;
}
